/**
 * Answers already paid for, kept on disk so an interrupted run does not buy
 * them twice.
 *
 * A check over a few thousand paragraphs is minutes of requests. When the
 * service goes down eight minutes in, the run that follows the outage should
 * pay for the paragraphs that were never answered and nothing else. That is the
 * whole job here.
 *
 * ## What is stored, and what is not
 *
 * One small file per answered paragraph, named by a hash and holding the rule
 * ids, their probabilities, the model that served them and the day. The
 * paragraph is never written down: it is a hash in the file name and nothing
 * else. A hash is not the text, though it does let somebody who already has a
 * guess confirm it, which is worth saying plainly rather than calling the thing
 * anonymous.
 *
 * The files live under the user's cache directory, never inside the directory
 * being checked, so a cache can never be committed by somebody who did not know
 * it was there.
 *
 * ## What makes two runs the same question
 *
 * The key covers the paragraph, the exact wording of every question asked about
 * it, and the model the questions were sent to. Change a rule's wording and the
 * old answers are simply never found again, which is the honest behaviour: they
 * were answers to a different question.
 *
 * Entries older than `MAX_AGE_DAYS` are ignored. A judgment is a model's opinion
 * on a day, and a month-old opinion reported as today's is a number nobody
 * measured.
 *
 * ## Failure is never fatal
 *
 * Every read and every write is wrapped. An unwritable cache directory, a file
 * half-written by a run that was killed, a disk with nothing left on it: all of
 * them mean the answer is asked for again, which is exactly what would have
 * happened without a cache at all.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";

import { asRecord } from "./types.ts";

/** Bumped when the stored shape changes, so old files are simply not found. */
const VERSION = 1;

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

export interface AnswerCache {
  get(key: string): CachedAnswer | undefined;
  set(key: string, value: CachedAnswer): void;
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

export interface OpenCacheOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir?: string;
  readonly now?: number;
}

/** Where the answers go, given the environment. */
export function cacheDirectory(options: OpenCacheOptions): string {
  const named = options.env[CACHE_DIR_ENV];
  if (named !== undefined && named.trim() !== "") return named;
  const xdg = options.env["XDG_CACHE_HOME"];
  if (xdg !== undefined && xdg.trim() !== "") return join(xdg, "snifftest");
  return join(options.homedir ?? osHomedir(), ".cache", "snifftest");
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
  return {
    get hits(): number {
      return hits;
    },

    get(key: string): CachedAnswer | undefined {
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

      hits += 1;
      return { model, nouls: usable };
    },

    set(key: string, value: CachedAnswer): void {
      const path = pathFor(answers, key);
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          JSON.stringify({ v: VERSION, at: now, model: value.model, nouls: value.nouls }),
          "utf8",
        );
      } catch {
        // A cache that cannot be written is a run that pays again, which is the
        // behaviour of no cache at all, and not worth stopping a check over.
      }
    },
  };
}

/** Two characters of the hash as a directory, so no directory holds every file. */
function pathFor(answers: string, key: string): string {
  return join(answers, key.slice(0, 2), `${key.slice(2)}.json`);
}
