/**
 * Scoring one draft for the page.
 *
 * This is `check` with two differences. A flag carries where in the draft it
 * sits, because the page draws a pencil line under it. And a paragraph that did
 * not change since the last round is not sent again, because a page that scores
 * as you type would otherwise re-ask every paragraph on every pause.
 *
 * The same code runs live and in replay. Replay is nothing more than a
 * different `JevClient` handed in, so the recorded numbers travel through the
 * threshold, the spans and the reactions exactly as measured ones do.
 *
 * Nothing here holds the draft. The cache is keyed by a digest of a paragraph,
 * never the paragraph, and it dies with the process.
 */

import { createHash } from "node:crypto";

import { chunkDocument } from "../engine.ts";
import { type JevClient, STATE_GUARD_CHARS, questionsFromRules } from "../jev.ts";
import { checkRegexRule } from "../rules.ts";
import {
  type Chunk,
  type JudgmentRule,
  type RegexRule,
  type RuleKind,
  type Ruleset,
  isJudgmentRule,
  isRegexRule,
} from "../types.ts";

/** What the nose does about a round, strongest last. */
export type Reaction = "approve" | "twitch" | "wrinkle" | "recoil";

const STRENGTH: Readonly<Record<Reaction, number>> = { approve: 0, twitch: 1, wrinkle: 2, recoil: 3 };

/** How many paragraph readings are remembered before the oldest is dropped (placeholder). */
const CACHE_LIMIT = 512;

/** Built-in checks that are about the paragraph as a whole, not a word in it. */
const PARAGRAPH_BUILTINS: ReadonlySet<string> = new Set(["colon_count", "sentence_rhythm"]);

export interface PageFlag {
  readonly rule: string;
  readonly kind: RuleKind;
  readonly probability: number;
  readonly message: string;
  /** 1-based line in the draft. */
  readonly line: number;
  /** Half-open character range in `ScoreResult.text`. */
  readonly start: number;
  readonly end: number;
  /** `span` is underlined; `paragraph` is bracketed in the margin. */
  readonly scope: "span" | "paragraph";
  readonly reaction: Reaction;
}

export interface ScoreResult {
  /** The draft as it was scored: line endings normalised, so offsets are exact. */
  readonly text: string;
  readonly flags: readonly PageFlag[];
  /** The strongest reaction of the round; `approve` when nothing tripped. */
  readonly reaction: Reaction;
  /** Gateway latency summed over what was asked this round; 0 when nothing was. */
  readonly ms: number;
  readonly usd: number;
  /** Whether the judgment rules were in play at all. */
  readonly judged: boolean;
  /** Paragraphs sent this round, and paragraphs left alone because they had not changed. */
  readonly asked: number;
  readonly skipped: number;
  /**
   * Set when the judgment rules could not run. The countable flags are still
   * here: a network problem never costs someone a flag they could have had for
   * free. The caller scrubs this before showing it to anyone.
   */
  readonly problem?: string;
}

export interface Scorer {
  score(draft: string): Promise<ScoreResult>;
  /**
   * Forget every remembered paragraph. The server calls this each time the page
   * is loaded, so what a page says it sent is about that page and nothing before it.
   */
  forget(): void;
}

export interface ScorerOptions {
  readonly ruleset: Ruleset;
  readonly threshold: number;
  /** Absent means countable rules only: nothing is asked of anyone. */
  readonly client?: JevClient;
}

/**
 * A countable flag is a wrinkle. A judgment is a twitch while it is near the
 * threshold and a recoil from halfway between the threshold and certainty.
 */
export function reactionFor(kind: RuleKind, probability: number, threshold: number): Reaction {
  if (kind === "regex") return "wrinkle";
  const recoilAt = threshold + (1 - threshold) / 2;
  // A hair of tolerance so 0.85 at a 0.7 threshold is not lost to 0.8499999.
  return probability + 1e-9 >= recoilAt ? "recoil" : "twitch";
}

export function createScorer(options: ScorerOptions): Scorer {
  const { ruleset, threshold, client } = options;
  const regexRules = ruleset.rules.filter(isRegexRule);
  const judgmentRules = ruleset.rules.filter(isJudgmentRule);
  const judged = client !== undefined && judgmentRules.length > 0;
  const questions = judged ? questionsFromRules(judgmentRules) : undefined;
  const remembered = new Map<string, Readonly<Record<string, number>>>();

  return {
    forget(): void {
      remembered.clear();
    },

    async score(draft: string): Promise<ScoreResult> {
      const text = draft.replace(/\r\n?/g, "\n");
      const placed = place(chunkDocument(text, "draft", { maxChars: STATE_GUARD_CHARS }), text);
      const flags: PageFlag[] = [];

      for (const { chunk, offset } of placed) {
        for (const rule of regexRules) flags.push(...countable(rule, chunk, offset, threshold));
      }

      let ms = 0;
      let usd = 0;
      let asked = 0;
      let skipped = 0;
      let problem: string | undefined;

      if (judged && client !== undefined && questions !== undefined) {
        for (const { chunk, offset } of placed) {
          const key = createHash("sha256").update(chunk.text).digest("hex");
          let nouls = remembered.get(key);

          if (nouls === undefined) {
            try {
              const answer = await client.ask({ state: chunk.text, questions });
              nouls = answer.nouls;
              ms += answer.latencyMs;
              usd += answer.estimatedCostUsd;
              asked += 1;
              remember(remembered, key, nouls);
            } catch (error) {
              // One failure ends the round's asking: the next paragraph would
              // most likely fail the same way, and slowly.
              problem = error instanceof Error ? error.message : String(error);
              break;
            }
          } else {
            skipped += 1;
          }

          flags.push(...judgments(judgmentRules, nouls, chunk, offset, threshold));
        }
      }

      flags.sort((a, b) => a.start - b.start || a.end - b.end || a.rule.localeCompare(b.rule));
      const reaction = flags.reduce<Reaction>(
        (strongest, flag) => (STRENGTH[flag.reaction] > STRENGTH[strongest] ? flag.reaction : strongest),
        "approve",
      );

      return {
        text,
        flags,
        reaction,
        ms,
        usd,
        judged,
        asked,
        skipped,
        ...(problem === undefined ? {} : { problem }),
      };
    },
  };
}

// --- the two arms -----------------------------------------------------------

function countable(rule: RegexRule, chunk: Chunk, offset: number, threshold: number): PageFlag[] {
  const wholeParagraph = rule.source === "builtin" && PARAGRAPH_BUILTINS.has(rule.builtin);
  const seen = new Set<string>();
  const out: PageFlag[] = [];

  for (const match of checkRegexRule(rule, chunk.text)) {
    const [from, to] = wholeParagraph ? [0, chunk.text.length] : wordsAround(chunk.text, match.index);
    const key = `${from}:${to}`;
    // Two dashes in one phrase are one pencil line, not two on top of each other.
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      rule: rule.id,
      kind: "regex",
      probability: 1,
      message: rule.message,
      line: chunk.line + newlinesIn(chunk.text.slice(0, match.index)),
      start: offset + from,
      end: offset + to,
      scope: wholeParagraph ? "paragraph" : "span",
      reaction: reactionFor("regex", 1, threshold),
    });
  }
  return out;
}

function judgments(
  rules: readonly JudgmentRule[],
  nouls: Readonly<Record<string, number>>,
  chunk: Chunk,
  offset: number,
  threshold: number,
): PageFlag[] {
  const out: PageFlag[] = [];
  for (const rule of rules) {
    const probability = nouls[rule.id];
    // Not answered and answered low are different facts; neither is a flag.
    if (probability === undefined || probability < threshold) continue;
    out.push({
      rule: rule.id,
      kind: "judgment",
      probability,
      message: rule.message,
      line: chunk.line,
      start: offset,
      end: offset + chunk.text.length,
      scope: "paragraph",
      reaction: reactionFor("judgment", probability, threshold),
    });
  }
  return out;
}

// --- where things are -------------------------------------------------------

interface Placed {
  readonly chunk: Chunk;
  /** Character offset of the chunk's first character in the normalised draft. */
  readonly offset: number;
}

/**
 * A chunk knows its line but not its offset. Search forward from the start of
 * that line: a paragraph starts there, and a piece of an over-long paragraph
 * starts at or after it.
 */
function place(chunks: readonly Chunk[], text: string): Placed[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);

  let cursor = 0;
  return chunks.map((chunk) => {
    const from = Math.max(cursor, lineStarts[chunk.line - 1] ?? 0);
    const found = text.indexOf(chunk.text, from);
    const offset = found === -1 ? from : found;
    cursor = offset + chunk.text.length;
    return { chunk, offset };
  });
}

const WORD = /[\p{L}\p{N}'’-]/u;

/**
 * The words a reader would point at. A check reports where it fired, not how
 * much it matched, so a word is underlined to its end, and a mark that is not a
 * word (a dash) takes the word on either side, since a line under one character
 * is a line nobody sees.
 */
function wordsAround(text: string, index: number): [number, number] {
  let from = index;
  let to = index;

  if (WORD.test(text[index] ?? "")) {
    while (to < text.length && WORD.test(text[to] ?? "")) to++;
    return [from, to];
  }

  to = index + 1;
  while (from > 0 && /[^\S\n]/.test(text[from - 1] ?? "")) from--;
  while (from > 0 && WORD.test(text[from - 1] ?? "")) from--;
  while (to < text.length && /[^\S\n]/.test(text[to] ?? "")) to++;
  while (to < text.length && WORD.test(text[to] ?? "")) to++;
  return [from, to];
}

function newlinesIn(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === "\n") count++;
  return count;
}

function remember(
  cache: Map<string, Readonly<Record<string, number>>>,
  key: string,
  nouls: Readonly<Record<string, number>>,
): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, nouls);
}
