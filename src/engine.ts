/**
 * Chunking and the countable arm.
 *
 * A document is split into paragraphs, because that is the unit a judgment
 * question is asked about and the unit a flag is reported against. The regex
 * arm runs first and runs locally, so `--dry-run` is a strict subset of a full
 * run and a network failure can never lose a countable flag.
 *
 * ## Code is not prose
 *
 * A fenced code block is dropped at the chunking step, so it reaches neither
 * arm: the countable rules never see it and it is never sent anywhere. A YAML
 * snippet in a README has colons the way a sentence has commas, and linting it
 * as prose was enough on its own to make a docs directory unusable.
 *
 * An inline span is different. `--dry-run` inside a sentence is part of that
 * sentence, and a judgment question about the sentence needs it, so the span
 * stays in the chunk and only the countable rules blank it out.
 *
 * Indented code blocks — four spaces, no fence — are deliberately out of scope:
 * in ordinary prose that indent is as often a quotation or a wrapped list item,
 * and dropping those would lose real sentences to catch snippets that a fence
 * already covers.
 */

import { type JevClient, questionsFromRules } from "./jev.ts";
import { checkRegexRule } from "./rules.ts";
import { type Chunk, type Flag, type Ruleset, isJudgmentRule, isRegexRule } from "./types.ts";

export interface ChunkOptions {
  /** Cap on a chunk's length; an over-long paragraph is split on sentence boundaries. */
  readonly maxChars?: number;
}

/** Split a document into paragraph chunks, each carrying the line it starts on. */
export function chunkDocument(text: string, file: string, options: ChunkOptions = {}): Chunk[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const paragraphs: Chunk[] = [];

  let buffer: string[] = [];
  let startLine = 1;
  let fence: Fence | null = null;

  const flush = (): void => {
    if (buffer.length === 0) return;
    paragraphs.push({ file, line: startLine, text: buffer.join("\n") });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Every line of a fenced block is skipped rather than blanked, and the line
    // a paragraph starts on comes from the index either way, so prose after a
    // snippet is still reported on the line it is written on.
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = opensFence(line);
    if (opened !== null) {
      flush();
      fence = opened;
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }
    if (buffer.length === 0) startLine = i + 1;
    buffer.push(line);
  }
  // An unclosed fence runs to the end of the file, which is what a reader sees
  // too: everything after it is rendered as code.
  flush();

  const maxChars = options.maxChars;
  if (maxChars === undefined || maxChars <= 0) return paragraphs;
  return paragraphs.flatMap((paragraph) => splitLong(paragraph, maxChars));
}

/** Run every countable rule over every chunk. No network, ever. */
export function runRegexArm(chunks: readonly Chunk[], ruleset: Ruleset): Flag[] {
  const flags: Flag[] = [];

  for (const chunk of chunks) {
    // Spans are blanked character for character, newlines included, so every
    // offset a rule reports still points at the line it came from.
    const prose = maskInlineCode(chunk.text);

    for (const rule of ruleset.rules) {
      if (!isRegexRule(rule)) continue;
      for (const match of checkRegexRule(rule, prose)) {
        flags.push({
          file: chunk.file,
          line: chunk.line + countNewlines(prose.slice(0, match.index)),
          rule: rule.id,
          kind: "regex",
          probability: 1,
          message: rule.message,
        });
      }
    }
  }

  return mergeFlags(flags);
}

// --- the judgment arm -----------------------------------------------------

/**
 * One rule's answer about one chunk, at whatever probability came back.
 *
 * Every reading is kept, including the low ones, because the threshold is the
 * caller's decision and `eval` needs the whole distribution to calibrate. A
 * reading becomes a flag only by passing through `flagsFrom`.
 */
export interface JudgmentReading {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly probability: number;
  readonly message: string;
}

/** What the run cost, so a caller can print it instead of guessing. */
export interface JudgmentUsage {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly latencyMs: number;
  /** Tries beyond the first, summed. Reported, never hidden. */
  readonly retries: number;
}

export interface JudgmentArmResult {
  readonly readings: readonly JudgmentReading[];
  readonly usage: JudgmentUsage;
}

const NO_USAGE: JudgmentUsage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  latencyMs: 0,
  retries: 0,
};

/**
 * Ask the judgment rules about every chunk, one request each.
 *
 * All the rules ride in one request per chunk: the questions run in parallel on
 * the service and cannot see each other, so asking twelve costs about what
 * asking one costs. Chunks go one at a time, because the service publishes no
 * rate limit and a linter that opens forty connections to find out is a linter
 * that gets someone's key throttled.
 *
 * A ruleset with no judgment rules makes no request at all, which is what keeps
 * an ordinary regex-only run free and offline.
 */
export async function runJudgmentArm(
  chunks: readonly Chunk[],
  ruleset: Ruleset,
  client: JevClient,
): Promise<JudgmentArmResult> {
  const rules = ruleset.rules.filter(isJudgmentRule);
  if (rules.length === 0 || chunks.length === 0) {
    return { readings: [], usage: NO_USAGE };
  }

  const questions = questionsFromRules(rules);
  const messages = new Map(rules.map((rule) => [rule.id, rule.message]));
  const readings: JudgmentReading[] = [];
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  let latencyMs = 0;
  let retries = 0;

  for (const chunk of chunks) {
    const answer = await client.ask({ state: chunk.text, questions });

    requests += 1;
    inputTokens += answer.inputTokens;
    outputTokens += answer.outputTokens;
    estimatedCostUsd += answer.estimatedCostUsd;
    latencyMs += answer.latencyMs;
    retries += Math.max(0, answer.attempts - 1);

    for (const rule of rules) {
      const probability = answer.nouls[rule.id];
      // A rule the service did not answer is left out rather than scored zero:
      // "not answered" and "answered low" are different facts.
      if (probability === undefined) continue;
      readings.push({
        file: chunk.file,
        line: chunk.line,
        rule: rule.id,
        probability,
        message: messages.get(rule.id) ?? rule.message,
      });
    }
  }

  return {
    readings,
    usage: { requests, inputTokens, outputTokens, estimatedCostUsd, latencyMs, retries },
  };
}

/** The readings that clear the threshold, as flags. */
export function flagsFrom(readings: readonly JudgmentReading[], threshold: number): Flag[] {
  return readings
    .filter((reading) => reading.probability >= threshold)
    .map((reading) => ({
      file: reading.file,
      line: reading.line,
      rule: reading.rule,
      kind: "judgment" as const,
      probability: reading.probability,
      message: reading.message,
    }));
}

/** Collect flags from several arms into one reading order, without repeats. */
export function mergeFlags(...groups: readonly (readonly Flag[])[]): Flag[] {
  const byKey = new Map<string, Flag>();

  for (const group of groups) {
    for (const flag of group) {
      // JSON rather than a separator character: the separator that could not
      // appear in a path was a NUL byte, and one NUL byte makes git call this
      // whole file binary, which takes it out of every diff a person reviews.
      const key = JSON.stringify([flag.file, flag.line, flag.rule]);
      if (!byKey.has(key)) byKey.set(key, flag);
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
  );
}

// --- code, which is not prose ---------------------------------------------

/** An open fence: which character drew it, and how long it was. */
interface Fence {
  readonly char: string;
  readonly length: number;
}

/** Three or more backticks or tildes, indented no more than three spaces. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function opensFence(line: string): Fence | null {
  const match = FENCE_LINE.exec(line);
  if (match === null) return null;

  const marker = match[1] ?? "";
  const info = match[2] ?? "";
  // CommonMark's rule, and a useful one here: a backtick fence's info string
  // cannot itself hold a backtick, so a line of prose that happens to carry
  // three backticks and a closing one is a span, not the start of a block.
  if (marker.startsWith("`") && info.includes("`")) return null;

  return { char: marker[0] ?? "`", length: marker.length };
}

/** A closing fence: the same character, at least as long, and nothing after it. */
function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (match === null) return false;

  const marker = match[1] ?? "";
  return marker.startsWith(fence.char) && marker.length >= fence.length;
}

/**
 * Inline code spans blanked to spaces, the same length as what they replace.
 *
 * Length is the whole point: the countable rules read this string, and a flag's
 * line comes from the offset the match was found at, so a mask that changed any
 * offset would move a flag onto the wrong line. Newlines survive for the same
 * reason. A run of backticks with no partner is ordinary punctuation and is
 * left alone.
 */
function maskInlineCode(text: string): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i];
      i += 1;
      continue;
    }

    let run = 0;
    while (text[i + run] === "`") run += 1;
    const close = closingRun(text, i + run, run);
    if (close === -1) {
      out += text.slice(i, i + run);
      i += run;
      continue;
    }

    out += blank(text.slice(i, close + run));
    i = close + run;
  }

  return out;
}

/** Where a run of exactly `length` backticks starts, at or after `from`. */
function closingRun(text: string, from: number, length: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "`") continue;
    let run = 0;
    while (text[i + run] === "`") run += 1;
    if (run === length) return i;
    i += run - 1;
  }
  return -1;
}

function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

// --- helpers --------------------------------------------------------------

function countNewlines(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === "\n") count++;
  return count;
}

function splitLong(chunk: Chunk, maxChars: number): Chunk[] {
  if (chunk.text.length <= maxChars) return [chunk];

  const out: Chunk[] = [];
  let groupStart = 0;
  let groupEnd = 0;

  for (const [start, end] of sentenceBounds(chunk.text)) {
    if (groupEnd > groupStart && chunk.text.slice(groupStart, end).trimEnd().length > maxChars) {
      out.push(...hardSplit(chunk, groupStart, groupEnd, maxChars));
      groupStart = start;
    }
    groupEnd = end;
  }
  if (groupEnd > groupStart) out.push(...hardSplit(chunk, groupStart, groupEnd, maxChars));

  return out.length === 0 ? [chunk] : out;
}

/** A single sentence longer than the cap still has to fit; cut it on the cap. */
function hardSplit(chunk: Chunk, start: number, end: number, maxChars: number): Chunk[] {
  const pieces: Chunk[] = [];
  let at = start;
  while (at < end) {
    const stop = Math.min(at + maxChars, end);
    const piece = subChunk(chunk, at, stop);
    if (piece !== null) pieces.push(piece);
    at = stop;
  }
  return pieces;
}

function subChunk(chunk: Chunk, start: number, end: number): Chunk | null {
  const text = chunk.text.slice(start, end).trimEnd();
  if (text === "") return null;
  return {
    file: chunk.file,
    line: chunk.line + countNewlines(chunk.text.slice(0, start)),
    text,
  };
}

/** Half-open ranges covering the text, each ending after a sentence's trailing space. */
function sentenceBounds(text: string): [number, number][] {
  const bounds: [number, number][] = [];
  const terminator = /[.!?]+(?=\s|$)/g;
  let start = 0;

  for (;;) {
    const found = terminator.exec(text);
    if (found === null) break;
    let end = found.index + found[0].length;
    while (end < text.length && /\s/.test(text[end] ?? "")) end++;
    bounds.push([start, end]);
    start = end;
    terminator.lastIndex = end;
  }
  if (start < text.length) bounds.push([start, text.length]);

  return bounds;
}
