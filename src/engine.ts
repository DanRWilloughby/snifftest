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
 * A fence counts wherever a reader would see one, which means inside a list
 * item and behind a block quote's `> ` as well as at the left margin. Measured
 * against the bare line those two do not look like fences at all, so the
 * snippet inside them used to be linted as prose and sent as prose, which is
 * the thing the paragraph above says must never happen. The closing fence has
 * to sit at the same depth as the one that opened the block: a row of backticks
 * outside a quote does not close a block inside it.
 *
 * Indented code blocks (four spaces, no fence) are deliberately out of scope:
 * in ordinary prose that indent is as often a quotation or a wrapped list item,
 * and dropping those would lose real sentences to catch snippets that a fence
 * already covers. Four spaces under a list marker are a different thing, and
 * are only ever read as code when a fence is drawn there.
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
  let container: Container = NO_CONTAINER;

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

    // What quotes and list items the line sits inside, so a fence drawn at
    // their indent is still a fence. Never updated inside a block: a line of
    // shell script starting with a dash is not a list item.
    container = containerOf(line, container);

    const opened = opensFence(line, container);
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

/**
 * What a line sits inside: block quotes, and the column a list item's content
 * starts at.
 *
 * This is the smallest amount of Markdown structure a fence detector can get
 * away with, and it exists for one reason. A fence indented under a list item,
 * or written behind a `> `, is a real fenced block that a reader sees as code.
 * Measured against the bare line it does not look like a fence at all, so
 * before this the snippet inside it was linted as prose and sent as prose.
 */
interface Container {
  /** How many block-quote markers stand in front of the line's own content. */
  readonly quoteDepth: number;
  /** The column an open list item's content starts at, or zero outside one. */
  readonly listIndent: number;
}

const NO_CONTAINER: Container = { quoteDepth: 0, listIndent: 0 };

/** One `>`, with the space that usually follows it. Applied until it stops matching. */
const QUOTE_MARKER = /^ {0,3}> ?/;

/** A bullet or an ordered marker, and the run of spaces that sets the content column. */
const LIST_MARKER = /^( *)([-*+]|\d{1,9}[.)])( +)/;

/** Three or more backticks or tildes, indented no more than three spaces. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** An open fence: which character drew it, how long it was, and what it sits inside. */
interface Fence {
  readonly char: string;
  readonly length: number;
  readonly container: Container;
}

/**
 * The line's containers, carried forward from the line before it.
 *
 * A list item stays open across the blank lines inside it, which is how a list
 * item holds more than one paragraph, and closes at the first non-blank line
 * that starts to the left of its content column and is not a marker of its own.
 */
function containerOf(line: string, previous: Container): Container {
  const quoted = stripQuotes(line);
  // A line at a different quote depth is in a different container, so whatever
  // list was open in the old one has nothing to do with this line.
  const carried = quoted.quoteDepth === previous.quoteDepth ? previous.listIndent : 0;

  const marker = LIST_MARKER.exec(quoted.text);
  if (marker !== null) {
    const indent = (marker[1] ?? "").length + (marker[2] ?? "").length + (marker[3] ?? "").length;
    return { quoteDepth: quoted.quoteDepth, listIndent: indent };
  }

  if (quoted.text.trim() === "") return { quoteDepth: quoted.quoteDepth, listIndent: carried };

  const leading = quoted.text.length - quoted.text.trimStart().length;
  return { quoteDepth: quoted.quoteDepth, listIndent: leading >= carried ? carried : 0 };
}

interface Quoted {
  readonly text: string;
  readonly quoteDepth: number;
}

function stripQuotes(line: string): Quoted {
  let text = line;
  let quoteDepth = 0;

  for (;;) {
    const match = QUOTE_MARKER.exec(text);
    if (match === null) return { text, quoteDepth };
    text = text.slice(match[0].length);
    quoteDepth += 1;
  }
}

/**
 * The line as its container sees it: quote markers gone, list indent removed.
 *
 * Removing the list indent is what keeps the bare indented code block out of
 * scope. Four spaces with no list marker above them leave `listIndent` at zero,
 * nothing is removed, and the ordinary three-space rule refuses the line. That
 * indent is as often a quotation or a wrapped list item as it is code.
 *
 * A line that starts to the left of the container is not in it at all, and gets
 * nothing back. That is what stops a row of backticks at the margin from
 * closing a block that was opened inside a list item or behind a `> `. It
 * cannot refuse a fence that should have opened: a line outdented past an open
 * list has already closed that list by the time this is asked.
 */
function insideContainer(line: string, container: Container): string | null {
  const quoted = stripQuotes(line);
  if (quoted.quoteDepth !== container.quoteDepth) return null;

  const leading = quoted.text.length - quoted.text.trimStart().length;
  if (leading < container.listIndent) return null;
  return quoted.text.slice(container.listIndent);
}

function opensFence(line: string, container: Container): Fence | null {
  const body = insideContainer(line, container);
  if (body === null) return null;

  const match = FENCE_LINE.exec(body);
  if (match === null) return null;

  const marker = match[1] ?? "";
  const info = match[2] ?? "";
  // CommonMark's rule, and a useful one here: a backtick fence's info string
  // cannot itself hold a backtick, so a line of prose that happens to carry
  // three backticks and a closing one is a span, not the start of a block.
  if (marker.startsWith("`") && info.includes("`")) return null;

  return { char: marker[0] ?? "`", length: marker.length, container };
}

/**
 * A closing fence: the same character, at least as long, nothing after it, and
 * at the depth the opening fence was drawn at.
 *
 * The depth matters. A block quote holding a fence is closed by a fence behind
 * the same `> `, and a line of backticks written outside the quote belongs to
 * whatever is out there, not to the block inside it.
 */
function closesFence(line: string, fence: Fence): boolean {
  const body = insideContainer(line, fence.container);
  if (body === null) return false;

  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body);
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
