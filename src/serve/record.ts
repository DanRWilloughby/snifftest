/**
 * Recording a replay, so the demo plays back a run that really happened.
 *
 * `examples/replays/example.json` was written by hand. Its numbers are made up,
 * the page says so, and that is fine for trying the page without a key. It is
 * not fine for a video: a launch capture showing probabilities nobody measured
 * is a claim, and this repository's whole argument is that a claim needs a run
 * behind it.
 *
 * So this walks a draft the way somebody typing it would. At every sentence
 * boundary the draft is a little longer, and that longer draft is what the page
 * would send on its next pause. Each of those prefixes is chunked by the same
 * chunker the page's scorer uses and asked about with the same questions, live,
 * and what comes back is written down in the gateway's own field names.
 *
 * Two things make the playback faithful rather than approximate.
 *
 * The recorder never invents an entry. A paragraph the page asks about that the
 * recording does not hold falls through to the default, and the default carries
 * no readings and no cost, because nothing was measured for it. A replay that
 * filled that gap with a plausible number would be the hand-written file again.
 *
 * And a failed answer stops the whole thing. A recording with one hole in it
 * plays back as a paragraph the nose ignores, which on a capture reads as a
 * clean paragraph rather than as a request that failed. There is no partial
 * recording: it is written whole or not at all.
 *
 * Nothing here is called by a test with a real client. The writer takes a
 * `JevClient`, and the tests hand it one that answers from a table.
 */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { chunkDocument, isProseLike } from "../engine.ts";
import { STATE_GUARD_CHARS, type JevClient, questionsFromRules } from "../jev.ts";
import { type Ruleset, isJudgmentRule } from "../types.ts";
import type { MatchedAnswer, ReplayFile } from "./replay.ts";

export class RecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordError";
  }
}

/** One draft to walk, named so a failure can say which file it was in. */
export interface RecordDraft {
  readonly name: string;
  readonly text: string;
}

export interface RecordOptions {
  readonly ruleset: Ruleset;
  readonly client: JevClient;
  readonly drafts: readonly RecordDraft[];
  /** The bench run these numbers belong beside, `YYYY-MM-DD`. */
  readonly runDate: string;
  readonly note?: string;
}

export interface Recording {
  readonly file: ReplayFile;
  /** Distinct paragraph states asked about, which is what the run cost. */
  readonly asked: number;
  /** Prefixes walked across every draft. */
  readonly prefixes: number;
}

/**
 * Every prefix of the draft that ends on a sentence boundary, plus the whole of
 * it.
 *
 * This is where a page that scores on a pause would score: a writer finishes a
 * sentence, stops, and the round goes out. Scoring mid-word would record a
 * judgment about half a sentence, which is a question the page can ask but not
 * one worth putting in a recording of a draft being written.
 */
export function sentencePrefixes(text: string): string[] {
  const normalised = text.replace(/\r\n?/g, "\n");
  const out: string[] = [];
  const terminator = /[.!?]+(?=\s|$)/g;

  for (;;) {
    const found = terminator.exec(normalised);
    if (found === null) break;
    const end = found.index + found[0].length;
    terminator.lastIndex = end;
    const prefix = normalised.slice(0, end);
    if (prefix.trim() !== "") out.push(prefix);
  }

  const whole = normalised.trimEnd();
  if (whole !== "" && out[out.length - 1] !== whole) out.push(whole);
  return out;
}

export async function recordReplay(options: RecordOptions): Promise<Recording> {
  const judgmentRules = options.ruleset.rules.filter(isJudgmentRule);
  if (judgmentRules.length === 0) {
    throw new RecordError(
      "this ruleset has no judgment rules, so there would be nothing in the recording that the countable rules do not already do for free.",
    );
  }
  if (options.drafts.length === 0) {
    throw new RecordError("name at least one draft to record.");
  }

  // The page's scorer asks about every judgment rule for every paragraph, so
  // the recorder asks the same question. A narrower one would record answers
  // to a question the page never puts.
  const questions = questionsFromRules(judgmentRules);
  const answers = new Map<string, MatchedAnswer>();
  let prefixes = 0;

  for (const draft of options.drafts) {
    for (const prefix of sentencePrefixes(draft.text)) {
      prefixes += 1;
      const chunks = chunkDocument(prefix, draft.name, { maxChars: STATE_GUARD_CHARS });
      for (const chunk of chunks) {
        // The scorer skips nothing, but the judgment arm asks about prose only,
        // and a heading is not worth a request here either.
        if (!isProseLike(chunk)) continue;
        if (answers.has(chunk.text)) continue;

        let answer;
        try {
          answer = await options.client.ask({ state: chunk.text, questions });
        } catch (error) {
          throw new RecordError(
            `${draft.name}: a paragraph could not be answered, so nothing was written (${
              error instanceof Error ? error.message : String(error)
            }).`,
          );
        }

        const nouls: Record<string, number> = {};
        for (const rule of judgmentRules) {
          const probability = answer.nouls[rule.id];
          if (probability === undefined || !Number.isFinite(probability)) continue;
          if (probability < 0 || probability > 1) continue;
          nouls[rule.id] = probability;
        }
        if (Object.keys(nouls).length === 0) {
          throw new RecordError(
            `${draft.name}: a reply carried no usable reading for any rule, so nothing was written. Run it again when the service is answering.`,
          );
        }

        answers.set(chunk.text, {
          match: chunk.text,
          nouls,
          inputTokens: answer.inputTokens,
          latencyMs: answer.latencyMs,
          estimatedCostUsd: answer.estimatedCostUsd,
        });
      }
    }
  }

  if (answers.size === 0) {
    throw new RecordError("those drafts hold no prose paragraph to record.");
  }

  // A paragraph matches every recorded state it grew out of, and the playback
  // takes the last one that matches. Shortest first therefore means the longest
  // match, which is the state closest to what is on the page, wins.
  const responses = [...answers.values()].sort((a, b) => a.match.length - b.match.length);

  return {
    asked: answers.size,
    prefixes,
    file: {
      version: 1,
      runDate: options.runDate,
      measured: true,
      ...(options.note === undefined ? {} : { note: options.note }),
      // Nothing was measured for a paragraph outside the recording, so nothing
      // is claimed for one: no readings, no tokens, no time and no cost.
      default: { nouls: {}, inputTokens: 0, latencyMs: 0, estimatedCostUsd: 0 },
      responses,
    },
  };
}

/**
 * The newest committed run under `bench/results/`.
 *
 * Committed, not merely present: an eval writes into `bench/results/<today>` by
 * default, so the newest directory on disk is often a run from five minutes ago
 * that nobody has looked at. A replay that named that date would be pointing at
 * numbers no reader can open.
 */
export function newestCommittedRunDate(repoRoot: string): string | null {
  const dates = new Set<string>();

  const listed = spawnSync("git", ["ls-files", "bench/results"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (listed.status === 0 && typeof listed.stdout === "string") {
    for (const line of listed.stdout.split("\n")) {
      const found = /^bench\/results\/(\d{4}-\d{2}-\d{2})\//.exec(line.trim());
      if (found?.[1] !== undefined) dates.add(found[1]);
    }
  }

  if (dates.size === 0 && listed.status !== 0) {
    // No git, or not a checkout. Say which directories exist rather than
    // guessing which of them a reader could open.
    throw new RecordError(
      `git could not list bench/results in ${repoRoot}, so there is no way to tell a committed run from one written a minute ago. Name the date with --run-date.`,
    );
  }

  const sorted = [...dates].sort();
  return sorted[sorted.length - 1] ?? null;
}

/** Every date-named directory under a results root, newest last. Used in messages. */
export function runDatesOnDisk(resultsRoot: string): string[] {
  try {
    return readdirSync(resultsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
