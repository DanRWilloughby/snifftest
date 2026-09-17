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

import { type AnswerCache, cacheKey, wordingHash } from "./cache.ts";
import {
  type JevClient,
  JevStateRefusedError,
  MODEL,
  isNoJudgment,
  isTransientFailure,
  questionsFromRules,
} from "./jev.ts";
import { PATTERN_TEXT_CAP, appliesToChunk, checkRegexRule } from "./rules.ts";
import {
  type Chunk,
  type ChunkKind,
  type Flag,
  type JudgmentRule,
  type Ruleset,
  isJudgmentRule,
  isRegexRule,
  rulesForChunk,
} from "./types.ts";

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
    const body = buffer.join("\n");
    paragraphs.push({ file, line: startLine, text: body, kind: classifyChunk(body, startLine) });
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

/**
 * Run every countable rule over every chunk. No network, ever.
 *
 * `note` is where a run says that a ruleset's own pattern read only part of a
 * paragraph. That cap is a bound on what a hostile pattern can cost, and a cap
 * nobody is told about is a rule that quietly stopped applying.
 */
export function runRegexArm(
  chunks: readonly Chunk[],
  ruleset: Ruleset,
  note?: (line: string) => void,
): Flag[] {
  const flags: Flag[] = [];

  for (const chunk of chunks) {
    // Spans are blanked character for character, newlines included, so every
    // offset a rule reports still points at the line it came from.
    const prose = maskInlineCode(chunk.text);

    for (const rule of ruleset.rules) {
      if (!isRegexRule(rule)) continue;
      // A rule that does not apply to this kind of block is not run on it at
      // all, so a truncation note is never printed for a rule sitting out.
      if (!appliesToChunk(rule, chunk.kind)) continue;
      if (note !== undefined && rule.source === "pattern" && prose.length > PATTERN_TEXT_CAP) {
        note(
          `${chunk.file}:${chunk.line} ${rule.id} read the first ${PATTERN_TEXT_CAP} characters of ` +
            "that paragraph, which is as far as a ruleset's own pattern is run.",
        );
      }
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

// --- what a block is ------------------------------------------------------

/**
 * How many words a list block needs before it is asked a judgment question.
 *
 * A list of two-word items is a menu, and asking a model whether its final
 * sentence restates the paragraph is a question about nothing, paid for at the
 * same rate as a real one. Twelve words is about the length at which a bullet
 * stops being a label and starts being a sentence, and it is deliberately a
 * round number rather than a tuned one: nothing was measured to pick it.
 */
export const LIST_PROSE_WORDS = 12;

/** A block quote's markers, so what is inside can be looked at. */
const QUOTE_PREFIX = /^ {0,3}(> ?)+/;

/** Every non-blank line is an ATX heading. */
const HEADING_LINE = /^ {0,3}#{1,6}(\s|$)/;

/** `[label]: https://example.com "title"`, the shape a link definition takes. */
const LINK_DEFINITION_LINE = /^ {0,3}\[[^\]]+\]:\s*\S+/;

/** A table's alignment row: pipes, dashes, colons and spaces, with at least one dash. */
const TABLE_DELIMITER_LINE = /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/;

/**
 * What kind of block this is.
 *
 * The order is the order a reader resolves it in: the shapes that can only be
 * one thing first, then the containers, then prose as what is left. Front
 * matter is only front matter at the top of a file, because three dashes in the
 * middle of a document are a thematic break.
 */
export function classifyChunk(text: string, startLine: number): ChunkKind {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const first = lines[0] ?? "";
  if (lines.length === 0) return "prose";

  if (startLine === 1 && /^(---|\+\+\+)\s*$/.test(first) && lines.length > 2) {
    const closes = lines.slice(1).some((line) => /^(---|\+\+\+)\s*$/.test(line));
    if (closes) return "front_matter";
  }
  if (first.trimStart().startsWith("<!--")) return "html_comment";
  if (lines.some((line) => TABLE_DELIMITER_LINE.test(line)) && lines.some((l) => l.includes("|"))) {
    return "table";
  }
  if (lines.every((line) => LINK_DEFINITION_LINE.test(line))) return "link_definition";
  if (lines.every((line) => HEADING_LINE.test(line))) return "heading";
  if (QUOTE_PREFIX.test(first)) return "block_quote";
  if (LIST_MARKER.test(first)) return "list";
  return "prose";
}

/**
 * Whether a chunk is worth a paid judgment question.
 *
 * Prose and block quotes always are. A list is, once it is long enough to hold
 * sentences. Nothing else is: a heading, a table, front matter, a link
 * definition and an HTML comment are structure, and the judgment rules are
 * written about writing.
 */
export function isProseLike(chunk: Chunk): boolean {
  if (chunk.kind === "prose" || chunk.kind === "block_quote") return true;
  if (chunk.kind !== "list") return false;
  return wordCount(chunk.text.replace(/^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+/gm, "")) >= LIST_PROSE_WORDS;
}

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
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
  /**
   * True when the probability landed in the no-judgment band, which means the
   * service answered without deciding. Such a reading is neither a flag nor a
   * pass, so it is carried rather than dropped and never becomes a flag.
   */
  readonly noJudgment: boolean;
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
  /** Answers that came off the disk instead of the wire, and so cost nothing. */
  readonly cached: number;
}

/** A paragraph the judgment arm never got an answer about, and why. */
export interface SkippedChunk {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

/**
 * How many service failures in a row end the arm.
 *
 * One failure is not evidence of a dead service. A 503 in the middle of a long
 * run is usually one bad minute, and giving up on the first one throws away the
 * rest of a check over it. Three in a row, each of them already through the
 * gateway's own retry ladder, is a service that is not answering today, and
 * asking the next four thousand paragraphs only buys four thousand more waits.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 3;

/**
 * What a paragraph's `skipped` row says once the breaker is open. Named,
 * because the reporting side collapses these into the stop's own line rather
 * than saying the same thing twice.
 */
export const NOT_SENT_REASON = "not sent, because the judgment arm had stopped asking";

/**
 * How long the whole arm may run, as a budget per paragraph it means to send.
 *
 * The breaker catches a service that fails. It does not catch one that answers
 * every request slowly: four attempts, three backoffs and a ten second timeout
 * make a worst case of about 47 seconds for one paragraph, and a hook or a CI
 * job with a few hundred paragraphs in front of it has no ceiling at all. The
 * budget is the number of paragraphs times this, with a floor so that a single
 * slow paragraph still gets its full retry ladder.
 *
 * It is a budget, not a timeout: the check happens before each request, so a
 * request already in flight finishes. Nothing is thrown away, the answers
 * already received are returned, and what went unasked is named.
 */
export const PER_PARAGRAPH_BUDGET_MS = 20_000;

/** The smallest whole-arm budget, so one paragraph keeps its retry ladder. */
export const MINIMUM_ARM_BUDGET_MS = 60_000;

/** Said in the stop line when the budget, rather than the service, ended the arm. */
export const OUT_OF_TIME_REASON =
  "the judgment arm ran past its overall budget, so the rest were not sent";

/** Why the arm stopped asking before it ran out of paragraphs. */
export interface JudgmentStop {
  /** The failure that opened the breaker, as the service put it. */
  readonly reason: string;
  /** How many failures in a row it took. */
  readonly after: number;
  /** Paragraphs that were never sent because of it. */
  readonly notSent: number;
}

/**
 * What became of every question the arm set out to ask.
 *
 * One cell is one (paragraph, judgment rule) pair, and `asked` counts them all,
 * including the cells of a paragraph that was never sent. So the four numbers
 * always add up, and a run that quietly stopped asking cannot look like a run
 * that asked and heard nothing worth flagging.
 */
export interface JudgmentTally {
  readonly asked: number;
  /** Blocks that were never asked about because they are structure, not writing. */
  readonly structure: number;
  /** Came back as a usable probability that sits outside the no-judgment band. */
  readonly answered: number;
  /** Came back inside the no-judgment band, which is an answer that decides nothing. */
  readonly noJudgment: number;
  /** No usable answer: missing, not a number, outside 0 to 1, or never sent. */
  readonly unanswered: number;
}

export interface JudgmentArmResult {
  readonly readings: readonly JudgmentReading[];
  readonly usage: JudgmentUsage;
  readonly tally: JudgmentTally;
  readonly skipped: readonly SkippedChunk[];
  /** Absent unless the arm gave up early, which is a fact about the run. */
  readonly stopped?: JudgmentStop;
}

const NO_USAGE: JudgmentUsage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  latencyMs: 0,
  retries: 0,
  cached: 0,
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
 *
 * ## Structure is not writing, and is not paid for
 *
 * Only prose-like blocks are asked about. Over this repo's own docs that is
 * about half the blocks, and the other half were headings, tables, front matter
 * and link definitions, each costing a full ten-question request to be told
 * nothing. The blocks that were passed over are counted, so a short bill is
 * explained rather than mysterious.
 *
 * ## One bad paragraph costs one paragraph
 *
 * The local text guard refuses a paragraph carrying a key, a data URI or a
 * base64 blob, and one such paragraph in a docs folder used to end the arm for
 * the whole folder and throw away the answers already paid for. A refusal is
 * now that paragraph's own: it is recorded with its file and line, and the run
 * carries on.
 *
 * A failure from the service is different in kind, and it is counted rather
 * than acted on at once. The paragraph that failed is marked unanswered and the
 * next one is asked, because a 503 in minute eight of a long run is usually one
 * bad minute and not a dead service. `CONSECUTIVE_FAILURE_LIMIT` failures in a
 * row, with no answer between them, is the other case, and then the arm stops
 * asking. Either way the answers already received are kept and returned: a run
 * that paid for four thousand judgments and then met a 503 reports four
 * thousand judgments and a line about the 503, never nothing at all.
 *
 * Every paragraph that went unjudged is named with its file, its line and the
 * reason, and the tally counts its questions under `unanswered`, so the four
 * numbers still add up over a run that ended early.
 *
 * ## The same paragraph is not paid for twice
 *
 * With a cache in hand, a paragraph is looked up before it is sent, and the
 * lookup happens whether or not the arm has stopped asking: an answer on disk
 * costs nothing and owes nothing to the state of the service. So the run after
 * an outage pays for the paragraphs that were never answered and no others.
 * What is stored, and what is deliberately not, is in `cache.ts`.
 */
export interface JudgmentArmOptions {
  /** Answers already paid for. Left out, nothing is read or written. */
  readonly cache?: AnswerCache;
  /** The clock, so a test can run the budget out without waiting for it. */
  readonly now?: () => number;
}

export async function runJudgmentArm(
  chunks: readonly Chunk[],
  ruleset: Ruleset,
  client: JevClient,
  options: JudgmentArmOptions = {},
): Promise<JudgmentArmResult> {
  const cache = options.cache;
  const rules = ruleset.rules.filter(isJudgmentRule);
  const prose = chunks.filter(isProseLike);
  const structure = chunks.length - prose.length;
  if (rules.length === 0 || prose.length === 0) {
    return {
      readings: [],
      usage: NO_USAGE,
      tally: { asked: 0, structure, answered: 0, noJudgment: 0, unanswered: 0 },
      skipped: [],
    };
  }

  const messages = new Map(rules.map((rule) => [rule.id, rule.message]));
  // One question set per shape of chunk, built once. A whole block asks about
  // every rule; a piece of a cut block leaves out the rules about a sentence it
  // does not hold, which is both the honest question and the cheaper one.
  const questionSets = new Map<string, ReturnType<typeof questionsFromRules>>();
  const askedAbout = (chunk: Chunk): readonly JudgmentRule[] => rulesForChunk(rules, chunk);
  const questionsFor = (applicable: readonly JudgmentRule[]): ReturnType<typeof questionsFromRules> => {
    const key = applicable.map((rule) => rule.id).join("\u0000");
    const held = questionSets.get(key);
    if (held !== undefined) return held;
    const built = questionsFromRules(applicable);
    questionSets.set(key, built);
    return built;
  };
  const readings: JudgmentReading[] = [];
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;
  let latencyMs = 0;
  let retries = 0;
  let cached = 0;

  const now = options.now ?? Date.now;
  const deadline =
    now() + Math.max(MINIMUM_ARM_BUDGET_MS, prose.length * PER_PARAGRAPH_BUDGET_MS);

  const skipped: SkippedChunk[] = [];
  let answered = 0;
  let noJudgment = 0;
  let halted = false;
  let consecutive = 0;
  let stopped: JudgmentStop | undefined;
  let notSent = 0;
  // Counted as the loop goes, because a piece of a cut block is not asked about
  // every rule, so the old paragraphs-times-rules product would overstate it.
  let asked = 0;

  for (const chunk of prose) {
    const applicable = askedAbout(chunk);
    if (applicable.length === 0) continue;
    // Counted whether or not the paragraph is sent, so that a run which stopped
    // early cannot look like a shorter run that asked everything it meant to.
    asked += applicable.length;

    // The cache is read before the breaker is consulted, because an answer
    // already on disk costs nothing and a stopped arm is about the service, not
    // about this paragraph. A rerun after an outage therefore pays only for the
    // paragraphs that were never answered.
    const questions = questionsFor(applicable);
    // The cache is told what is being asked, not only which key it is filed
    // under, so an entry that leaves a rule out or answers different words is a
    // miss rather than a question reported as asked and unanswered.
    const expect =
      cache === undefined
        ? undefined
        : { rules: applicable.map((rule) => rule.id), wording: wordingHash(questions) };
    const key = cache === undefined ? undefined : cacheKey(chunk.text, questions, MODEL);
    const held =
      cache === undefined || key === undefined || expect === undefined
        ? undefined
        : cache.get(key, expect);

    let nouls: Readonly<Record<string, number>>;
    if (held !== undefined) {
      cached += 1;
      nouls = held.nouls;
    } else {
      // The budget is consulted here, beside the breaker, and for the same
      // reason: an answer already on disk costs no time either.
      if (!halted && now() >= deadline) {
        halted = true;
        stopped = { reason: OUT_OF_TIME_REASON, after: 0, notSent: 0 };
      }
      if (halted) {
        notSent += 1;
        skipped.push({
          file: chunk.file,
          line: chunk.line,
          reason: stopped?.reason === OUT_OF_TIME_REASON ? OUT_OF_TIME_REASON : NOT_SENT_REASON,
        });
        continue;
      }

      let answer;
      try {
        answer = await client.ask({ state: chunk.text, questions });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({ file: chunk.file, line: chunk.line, reason });
        // A local refusal is about this paragraph and says nothing about the
        // service, so it never counts towards the breaker.
        if (error instanceof JevStateRefusedError) continue;
        // A bad key or a malformed request is not a bad minute. The next
        // paragraph would be told the same thing in the same words, so there is
        // nothing to wait out and the arm stops on the first one.
        if (!isTransientFailure(error)) {
          halted = true;
          stopped = { reason, after: 1, notSent: 0 };
          continue;
        }
        consecutive += 1;
        if (consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
          halted = true;
          stopped = { reason, after: consecutive, notSent: 0 };
        }
        continue;
      }

      consecutive = 0;
      requests += 1;
      inputTokens += answer.inputTokens;
      outputTokens += answer.outputTokens;
      estimatedCostUsd += answer.estimatedCostUsd;
      latencyMs += answer.latencyMs;
      retries += Math.max(0, answer.attempts - 1);
      nouls = answer.nouls;
      if (cache !== undefined && key !== undefined && expect !== undefined) {
        // What served this answer, so an entry from a version the alias no
        // longer points at is a miss for the rest of the run.
        cache.noteServed(answer.model);
        cache.set(key, { model: answer.model, nouls: answer.nouls }, expect);
      }
    }

    for (const rule of applicable) {
      const probability = nouls[rule.id];
      // A rule the service did not answer is left out rather than scored zero:
      // "not answered" and "answered low" are different facts. The range is
      // checked here as well as in the gateway, because the arm takes any
      // `JevClient` and a probability of 7 counted as a catch would be a
      // measurement nobody made.
      if (probability === undefined || !Number.isFinite(probability)) continue;
      if (probability < 0 || probability > 1) continue;
      const undecided = isNoJudgment(probability);
      if (undecided) noJudgment += 1;
      else answered += 1;
      readings.push({
        file: chunk.file,
        line: chunk.line,
        rule: rule.id,
        probability,
        message: messages.get(rule.id) ?? rule.message,
        noJudgment: undecided,
      });
    }
  }

  return {
    readings,
    usage: { requests, inputTokens, outputTokens, estimatedCostUsd, latencyMs, retries, cached },
    tally: { asked, structure, answered, noJudgment, unanswered: asked - answered - noJudgment },
    skipped,
    ...(stopped === undefined ? {} : { stopped: { ...stopped, notSent } }),
  };
}

/**
 * The readings that clear the threshold, as flags.
 *
 * A reading inside the no-judgment band never becomes a flag, whatever the
 * threshold is set to. The band means the service did not decide, and a number
 * that means nothing must not be allowed to mean "flag" because someone lowered
 * the bar to 0.5.
 */
export function flagsFrom(readings: readonly JudgmentReading[], threshold: number): Flag[] {
  return readings
    .filter((reading) => !reading.noJudgment && reading.probability >= threshold)
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

/**
 * Cut an over-long block into sendable pieces, each knowing where it sits.
 *
 * A piece of a paragraph is not a paragraph. Its first sentence is the block's
 * opening only if it is the first piece, and its last sentence is the block's
 * ending only if it is the last. Numbering the pieces here is what lets the
 * judgment arm leave a rule about openings out of every piece but one, instead
 * of asking each piece about an opening it does not have.
 */
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

  if (out.length === 0) return [chunk];
  if (out.length === 1) return out;
  return out.map((piece, index) => ({ ...piece, part: { index: index + 1, of: out.length } }));
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
    // A piece of an over-long block is the same kind of thing the block was.
    kind: chunk.kind,
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
