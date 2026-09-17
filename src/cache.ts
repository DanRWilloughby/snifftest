/**
 * Answers already paid for, kept on disk so an interrupted run does not buy
 * them twice.
 *
 * A check over a few thousand paragraphs is minutes of requests. When the
 * service goes down eight minutes in, the run that follows the outage should
 * pay for the paragraphs that were never answered and nothing else. That is the
 * whole job here.
 *
 * ## Only an answer is worth keeping
 *
 * The service can return HTTP 200 and say nothing useful: an empty object, a
 * reply that leaves a question out, or a set of numbers that all sit in the
 * no-judgment band because it could not read the state. Those are the shapes
 * this tool exists to name, and keeping one would turn a bad minute into a
 * verdict that stands for a fortnight at no cost and with nothing in the output
 * to say it was a replay. So a reply is stored only when every rule that was
 * asked about came back with a probability, and at least one of those
 * probabilities is an opinion rather than the middle of the band.
 *
 * ## What is stored, and what is not
 *
 * One small file per answered paragraph, named by a hash and holding the rule
 * ids, their probabilities, the wording those probabilities answered, the model
 * that served them and the day. The paragraph is never written down: it is a
 * hash in the file name and nothing else. A hash is not the text, though it does
 * let somebody who already has a guess confirm it, which is worth saying plainly
 * rather than calling the thing anonymous. Files are written 0600 inside 0700
 * directories, so the guess cannot be confirmed by another user on the machine.
 *
 * The files live under the user's cache directory, never inside the directory
 * being checked, so a cache can never be committed by somebody who did not know
 * it was there. A relative `SNIFFTEST_CACHE_DIR` is resolved against the user's
 * home directory for the same reason: a relative path would otherwise land
 * wherever the tool happened to be run, which is usually the repository.
 *
 * ## What makes two runs the same question
 *
 * The key covers the paragraph, the exact wording of every question asked about
 * it, and the model the questions were sent to. The entry then repeats the
 * wording as a hash and the rule ids as keys, and a read checks both against
 * what is being asked now. The key alone would be enough, and the check is here
 * anyway: an answer that is handed back for a question nobody asked is the one
 * failure this file must not have, and two cheap comparisons are a smaller
 * price than trusting one hash to be the only thing that was ever right.
 *
 * Entries older than `MAX_AGE_DAYS` are ignored, and the expired ones are
 * deleted the first time a run writes. A judgment is a model's opinion on a day,
 * and a month-old opinion reported as today's is a number nobody measured.
 *
 * ## The model is the alias, until a run learns better
 *
 * The key carries `jev-latest`, because that is what was asked for. What served
 * it is recorded in the entry. Once a run has had a live answer it tells the
 * cache which version served it, and from then on an entry from a different
 * version is a miss: when the alias rolls, yesterday's model does not get to
 * answer for today's. Before the first live answer of a run there is nothing to
 * compare against, so a run served entirely from the cache cannot know whether
 * the alias has moved under it. That limit is the price of not spending a
 * request to find out, and it is why the entries expire at all.
 *
 * ## Failure is never fatal
 *
 * Every read and every write is wrapped. An unwritable cache directory, a file
 * half-written by a run that was killed, a disk with nothing left on it: all of
 * them mean the answer is asked for again, which is exactly what would have
 * happened without a cache at all.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { isNoJudgment } from "./jev.ts";
import { asRecord } from "./types.ts";

/** Bumped when the stored shape changes, so old files are simply not found. */
const VERSION = 2;

/** How old an answer may be before it is asked for again. */
export const MAX_AGE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** Set to a directory to put the cache somewhere else, or to `off` for none. */
export const CACHE_DIR_ENV = "SNIFFTEST_CACHE_DIR";

/** The separator inside a key, which cannot occur in any of the parts. */
const UNIT = String.fromCharCode(0);

export interface CachedAnswer {
  readonly model: string;
  readonly nouls: Readonly<Record<string, number>>;
}

/** What is being asked now, which a stored answer has to match to be usable. */
export interface AnswerExpectation {
  /** Every rule id asked about this paragraph on this run. */
  readonly rules: readonly string[];
  /** A hash of the exact wording those rules were asked in. */
  readonly wording: string;
}

export interface AnswerCache {
  get(key: string, expect: AnswerExpectation): CachedAnswer | undefined;
  set(key: string, value: CachedAnswer, expect: AnswerExpectation): void;
  /** What actually served a live answer this run, so stale versions become misses. */
  noteServed(model: string): void;
  /** Answers served from disk this run, for the line that says what was paid for. */
  readonly hits: number;
}

/**
 * The one string that says which question this was.
 *
 * The questions are serialised in the order the caller asks them, because that
 * is the order they are sent in, and two different orders are two different
 * requests as far as anything downstream is concerned.
 */
export function cacheKey(
  text: string,
  questions: Readonly<Record<string, unknown>>,
  model: string,
): string {
  const hash = createHash("sha256");
  hash.update(`v${String(VERSION)}${UNIT}`);
  hash.update(`${model}${UNIT}`);
  hash.update(`${JSON.stringify(questions)}${UNIT}`);
  hash.update(text);
  return hash.digest("hex");
}

/**
 * The wording of a question set, as one string.
 *
 * A rule id is a name somebody chose; the wording is what the model was
 * actually asked. Two rulesets can carry the same id with different words, and
 * an answer to one is not an answer to the other.
 */
export function wordingHash(questions: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(JSON.stringify(questions)).digest("hex");
}

export interface OpenCacheOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir?: string;
  readonly now?: number;
}

/**
 * Where the answers go, given the environment.
 *
 * A relative name is taken as a place in the user's home directory, never as a
 * place in the working directory, which during a check is the repository being
 * checked.
 */
export function cacheDirectory(options: OpenCacheOptions): string {
  const home = options.homedir ?? osHomedir();
  const named = options.env[CACHE_DIR_ENV];
  if (named !== undefined && named.trim() !== "") {
    if (named.trim().toLowerCase() === "off") return named;
    return isAbsolute(named) ? named : join(home, named);
  }
  const xdg = options.env["XDG_CACHE_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") {
    return isAbsolute(xdg) ? join(xdg, "snifftest") : join(home, xdg, "snifftest");
  }
  return join(home, ".cache", "snifftest");
}

/**
 * A cache over a directory, or nothing at all.
 *
 * Returns undefined when the environment asked for no cache, so the calling
 * code has one thing to check rather than a cache object that quietly does
 * nothing.
 */
export function openCache(options: OpenCacheOptions): AnswerCache | undefined {
  const root = cacheDirectory(options);
  if (root.trim().toLowerCase() === "off") return undefined;
  const now = options.now ?? Date.now();
  const answers = join(root, "answers");

  let hits = 0;
  let served: string | undefined;
  let pruned = false;

  return {
    get hits(): number {
      return hits;
    },

    noteServed(model: string): void {
      if (model.trim() !== "") served = model;
    },

    get(key: string, expect: AnswerExpectation): CachedAnswer | undefined {
      let raw: string;
      try {
        raw = readFileSync(pathFor(answers, key), "utf8");
      } catch {
        return undefined;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return undefined;
      }

      const record = asRecord(parsed);
      if (record === null) return undefined;
      if (record["v"] !== VERSION) return undefined;

      const at = record["at"];
      if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
      if (now - at > MAX_AGE_DAYS * MS_PER_DAY) return undefined;

      const model = record["model"];
      if (typeof model !== "string") return undefined;
      // Once this run knows what the alias serves today, an answer from another
      // version is a different model's opinion and is asked for again.
      if (served !== undefined && model !== served) return undefined;

      // The wording the stored numbers answered. A ruleset that reworded a rule
      // without renaming it gets a miss rather than last week's answer.
      if (record["wording"] !== expect.wording) return undefined;

      const nouls = asRecord(record["nouls"]);
      if (nouls === null) return undefined;
      const usable: Record<string, number> = {};
      for (const [rule, value] of Object.entries(nouls)) {
        // A stored number that is not a probability is a corrupt file, not a
        // reading, so the whole entry is dropped rather than half of it used.
        if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
        if (value < 0 || value > 1) return undefined;
        usable[rule] = value;
      }

      // A stored answer that does not cover everything being asked now would be
      // reported as "asked and unanswered" without a request ever being made.
      if (!covers(usable, expect.rules)) return undefined;
      if (!anyOpinion(usable, expect.rules)) return undefined;

      hits += 1;
      return { model, nouls: usable };
    },

    set(key: string, value: CachedAnswer, expect: AnswerExpectation): void {
      // A non-answer is not written down. See the head of this file: an empty
      // reply, a missing question or a set of numbers that are all inside the
      // band would otherwise be served back as a judgment for a fortnight.
      if (!covers(value.nouls, expect.rules)) return;
      if (!anyOpinion(value.nouls, expect.rules)) return;

      const path = pathFor(answers, key);
      const directory = dirname(path);
      // A sibling temporary file and a rename, so a run killed mid-write leaves
      // nothing torn, and so a symlink planted at the entry's path is replaced
      // rather than followed to whatever it points at.
      const temporary = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!pruned) {
          pruned = true;
          pruneExpired(answers, now);
        }
        writeFileSync(
          temporary,
          JSON.stringify({
            v: VERSION,
            at: now,
            model: value.model,
            wording: expect.wording,
            nouls: value.nouls,
          }),
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        renameSync(temporary, path);
      } catch {
        // A cache that cannot be written is a run that pays again, which is the
        // behaviour of no cache at all, and not worth stopping a check over.
        try {
          rmSync(temporary, { force: true });
        } catch {
          // Nothing left to do about it, and nothing worth saying.
        }
      }
    },
  };
}

/** Whether every rule asked about came back with a usable probability. */
function covers(nouls: Readonly<Record<string, number>>, rules: readonly string[]): boolean {
  if (rules.length === 0) return false;
  return rules.every((rule) => {
    const value = nouls[rule];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  });
}

/** Whether at least one of the answers asked for is an opinion rather than the band. */
function anyOpinion(nouls: Readonly<Record<string, number>>, rules: readonly string[]): boolean {
  return rules.some((rule) => {
    const value = nouls[rule];
    return typeof value === "number" && !isNoJudgment(value);
  });
}

/**
 * Delete entries past the window, once per run.
 *
 * Without this a cache is append-only for the life of the machine: a hook over
 * a docs repository writes one file per changed paragraph and nothing ever
 * takes one away. Failure is ignored file by file, because a cache that cannot
 * be tidied is still a cache.
 */
function pruneExpired(answers: string, now: number): void {
  let shards: string[];
  try {
    shards = readdirSync(answers);
  } catch {
    return;
  }
  for (const shard of shards) {
    const at = join(answers, shard);
    let names: string[];
    try {
      if (!statSync(at).isDirectory()) continue;
      names = readdirSync(at);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(at, name);
      try {
        if (now - statSync(path).mtimeMs > MAX_AGE_DAYS * MS_PER_DAY) rmSync(path, { force: true });
      } catch {
        // One file that will not stat or unlink is not worth a word.
      }
    }
  }
}

/** Two characters of the hash as a directory, so no directory holds every file. */
function pathFor(answers: string, key: string): string {
  return join(answers, key.slice(0, 2), `${key.slice(2)}.json`);
}
