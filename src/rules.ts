/**
 * Rule types, ruleset validation, and the built-in countable checks.
 *
 * Countable rules live here and run with no network. Judgment rules are
 * validated here and answered elsewhere; nothing in this file calls out.
 */

import {
  type BuiltinRule,
  type ChunkKind,
  type Match,
  type RegexRule,
  type Rule,
  type Ruleset,
  type Seed,
  type SeedPosition,
  type SentenceOfInterest,
  CHUNK_KINDS,
  SEED_POSITIONS,
  SENTENCES_OF_INTEREST,
  isChunkKind,
  isSeedPosition,
  isSentenceOfInterest,
} from "./types.ts";
import { type YamlValue, parseYaml } from "./yaml.ts";

export class RulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesetError";
  }
}

/** Default word list for `slop_vocab`; a rule may replace it with its own `words`. */
export const DEFAULT_SLOP_WORDS: readonly string[] = [
  "delve",
  "tapestry",
  "landscape",
  "unlock",
  "testament",
  "navigate",
  "realm",
  "myriad",
  "intricate",
  "pivotal",
  "seamless",
  "showcase",
];

/**
 * The literal senses of the listed words, spared by default.
 *
 * Every word on the slop list has an honest use, and the rule's own comment
 * already admitted it. A landscape architect is a job, sailors navigate by the
 * stars, and a door unlocks. The list is short and is meant to be added to: a
 * ruleset writes its own `except` and this one stops applying.
 */
export const DEFAULT_SLOP_EXCEPTIONS: readonly string[] = [
  "landscape architect",
  "landscape architecture",
  "landscape gardener",
  "landscape orientation",
  "landscape mode",
  "navigate to",
  "navigate by",
  "navigate the menu",
  "navigation bar",
  "navigation pane",
  "unlock the door",
  "unlock the screen",
  "unlock your phone",
];

const DEFAULT_COLON_MIN = 3;
const DEFAULT_RHYTHM_FLOOR = 0.25;
const DEFAULT_MIN_SENTENCES = 4;

/**
 * How many words a paragraph needs before its rhythm is worth an opinion.
 *
 * Four sentences of six words each is a status note ("We shipped the fix on
 * Tuesday. The build went green at noon."), and telling its author that every
 * sentence runs to the same length is telling them their note is a note. The
 * complaint only means something once a paragraph is long enough that a reader
 * could nod off inside it.
 */
const DEFAULT_MIN_WORDS = 60;

/** Where a countable rule applies when it names no kinds of its own. */
const WRITING_KINDS: readonly ChunkKind[] = ["prose", "block_quote", "list", "heading"];

/**
 * Which blocks each built-in check applies to when its rule names none.
 *
 * Every one of these is a measured self-flag rather than a taste. Front matter,
 * a table, a link-definition block and an HTML comment are not writing, and
 * this repo's own docs tripped `colon_heavy` on all four. A list is not one
 * paragraph either: four bullets with a colon apiece are four sentences, and
 * counting them together is how a design note about a nose was told to pick one
 * colon. A block quote is someone else's text, so the dash in it is theirs.
 */
const DEFAULT_CHUNKS: Readonly<Record<string, readonly ChunkKind[]>> = {
  dash_present: ["prose", "list", "heading"],
  colon_count: ["prose", "block_quote"],
  colon_heavy: ["prose", "block_quote"],
  sentence_rhythm: ["prose", "block_quote"],
  slop_vocab: WRITING_KINDS,
  banned_words: WRITING_KINDS,
};

/** Whether a countable rule has anything to say about a block of this kind. */
export function appliesToChunk(rule: RegexRule, kind: ChunkKind): boolean {
  const declared =
    rule.chunks ?? (rule.source === "builtin" ? DEFAULT_CHUNKS[rule.builtin] : undefined);
  return (declared ?? WRITING_KINDS).includes(kind);
}

type BuiltinCheck = (text: string, rule: BuiltinRule) => Match[];

const BUILTINS: Readonly<Record<string, BuiltinCheck>> = {
  dash_present: dashPresent,
  colon_count: colonCount,
  // The plan writes this check as `colon_count` in the ruleset shape and as
  // `colon_heavy` in prose. Both spellings resolve to the same check.
  colon_heavy: colonCount,
  sentence_rhythm: sentenceRhythm,
  slop_vocab: (text, rule) =>
    wordList(text, rule.words ?? DEFAULT_SLOP_WORDS, rule.except ?? DEFAULT_SLOP_EXCEPTIONS),
  banned_words: (text, rule) => wordList(text, rule.words ?? [], rule.except ?? []),
};

export function builtinNames(): readonly string[] {
  return Object.keys(BUILTINS);
}

// --- reading and validating ----------------------------------------------

/** Read a ruleset from YAML source and validate it. */
export function parseRuleset(source: string, file: string): Ruleset {
  return validateRuleset(parseYaml(source, file), file);
}

/** Validate an already-parsed ruleset document. */
export function validateRuleset(doc: YamlValue, file: string): Ruleset {
  if (!isMapping(doc)) {
    throw new RulesetError(`${file}: a ruleset must be a mapping with version and rules`);
  }
  if (doc.version !== 1) {
    throw new RulesetError(`${file}: version must be 1`);
  }

  const threshold = doc.threshold;
  if (threshold !== undefined && threshold !== null) {
    if (typeof threshold !== "number" || threshold < 0 || threshold > 1) {
      throw new RulesetError(`${file}: threshold must be a number between 0 and 1`);
    }
  }

  const offByDefault =
    doc.off_by_default === undefined || doc.off_by_default === null
      ? undefined
      : stringList(doc.off_by_default, "off_by_default", file);

  const raw = doc.rules;
  if (!Array.isArray(raw)) {
    throw new RulesetError(`${file}: rules must be a list`);
  }

  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const rule = validateRule(entry, file);
    if (seen.has(rule.id)) throw new RulesetError(`${file}: duplicate rule id "${rule.id}"`);
    seen.add(rule.id);
    rules.push(rule);
  }

  return {
    version: 1,
    ...(typeof threshold === "number" ? { threshold } : {}),
    ...(offByDefault === undefined ? {} : { off_by_default: offByDefault }),
    rules,
  };
}

function validateRule(entry: YamlValue, file: string): Rule {
  if (!isMapping(entry)) throw new RulesetError(`${file}: every rule must be a mapping`);

  const id = entry.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new RulesetError(`${file}: every rule needs a non-empty string id`);
  }
  const where = `${file}: rule "${id}"`;

  const message = entry.message;
  if (typeof message !== "string" || message.trim() === "") {
    throw new RulesetError(`${where}: message must be a non-empty string`);
  }

  const seed = validateSeed(entry.seed, where);
  const tags =
    entry.tags === undefined || entry.tags === null
      ? undefined
      : stringList(entry.tags, "tags", where);
  const common = {
    id,
    message,
    ...(seed === undefined ? {} : { seed }),
    ...(tags === undefined ? {} : { tags }),
  };
  const kind = entry.kind;

  if (kind === "regex") return validateRegexRule(entry, where, common);

  if (kind === "judgment") {
    return {
      ...common,
      kind: "judgment",
      ...validateJudgmentBody(entry, where),
    };
  }

  throw new RulesetError(`${where}: kind must be "regex" or "judgment"`);
}

interface CommonFields {
  readonly id: string;
  readonly message: string;
  readonly seed?: Seed;
  readonly tags?: readonly string[];
}

function validateRegexRule(
  entry: Readonly<Record<string, YamlValue>>,
  where: string,
  common: CommonFields,
): RegexRule {
  const builtin = entry.builtin;
  const pattern = entry.pattern;
  const hasBuiltin = builtin !== undefined && builtin !== null;
  const hasPattern = pattern !== undefined && pattern !== null;

  if (hasBuiltin === hasPattern) {
    throw new RulesetError(`${where}: a regex rule needs exactly one of builtin or pattern`);
  }

  const flags = entry.flags;
  if (flags !== undefined && flags !== null && typeof flags !== "string") {
    throw new RulesetError(`${where}: flags must be a string`);
  }

  const tuning = {
    ...numberField(entry.min, "min", where),
    ...numberField(entry.floor, "floor", where),
    ...numberField(entry.min_sentences, "min_sentences", where),
    ...numberField(entry.min_words, "min_words", where),
    ...(entry.words === undefined || entry.words === null
      ? {}
      : { words: stringList(entry.words, "words", where) }),
    ...(entry.except === undefined || entry.except === null
      ? {}
      : { except: stringList(entry.except, "except", where) }),
    ...chunkField(entry.chunks, where),
  };

  if (hasPattern) {
    if (typeof pattern !== "string") {
      throw new RulesetError(`${where}: pattern must be a string`);
    }
    try {
      new RegExp(pattern, withGlobal(typeof flags === "string" ? flags : ""));
    } catch (error) {
      throw new RulesetError(`${where}: pattern is not a valid regular expression (${reason(error)})`);
    }
    refuseNestedQuantifiers(pattern, where);
    probePattern(pattern, typeof flags === "string" ? flags : "", where);
    return {
      ...common,
      kind: "regex",
      source: "pattern",
      pattern,
      ...(typeof flags === "string" ? { flags } : {}),
      ...tuning,
    };
  }

  if (typeof builtin !== "string" || !Object.hasOwn(BUILTINS, builtin)) {
    throw new RulesetError(`${where}: unknown built-in "${String(builtin)}"`);
  }
  if (typeof flags === "string") {
    throw new RulesetError(`${where}: flags belong to a pattern, not to the built-in "${builtin}"`);
  }

  return { ...common, kind: "regex", source: "builtin", builtin, ...tuning };
}

function validateJudgmentBody(
  entry: Readonly<Record<string, YamlValue>>,
  where: string,
): {
  what: string;
  not_for?: string;
  examples?: readonly string[];
  sentence?: SentenceOfInterest;
  criteria: { true: string; false: string };
} {
  const what = entry.what;
  if (typeof what !== "string" || what.trim() === "") {
    throw new RulesetError(`${where}: what must be a non-empty string describing the defect`);
  }

  const notFor = entry.not_for;
  if (notFor !== undefined && notFor !== null && typeof notFor !== "string") {
    throw new RulesetError(`${where}: not_for must be a string`);
  }

  const examples =
    entry.examples === undefined || entry.examples === null
      ? undefined
      : stringList(entry.examples, "examples", where);

  const criteria = entry.criteria;
  if (!isMapping(criteria)) {
    throw new RulesetError(`${where}: criteria must be a mapping with true and false`);
  }
  if (typeof criteria.true !== "string" || criteria.true.trim() === "") {
    throw new RulesetError(`${where}: criteria.true must be a non-empty string`);
  }
  if (typeof criteria.false !== "string" || criteria.false.trim() === "") {
    throw new RulesetError(`${where}: criteria.false must be a non-empty string`);
  }

  const sentence = entry.sentence;
  if (sentence !== undefined && sentence !== null && !isSentenceOfInterest(sentence)) {
    throw new RulesetError(
      `${where}: sentence is ${SENTENCES_OF_INTEREST.join(" or ")}, or is left out when the rule is not about a position`,
    );
  }

  return {
    what,
    ...(typeof notFor === "string" ? { not_for: notFor } : {}),
    ...(examples === undefined ? {} : { examples }),
    ...(isSentenceOfInterest(sentence) ? { sentence } : {}),
    criteria: { true: criteria.true, false: criteria.false },
  };
}

function validateSeed(value: YamlValue | undefined, where: string): Seed | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isMapping(value)) throw new RulesetError(`${where}: seed must be a mapping`);

  if (typeof value.transform === "string") {
    const count = value.count;
    if (count !== undefined && count !== null && typeof count !== "number") {
      throw new RulesetError(`${where}: seed.count must be a number`);
    }
    return {
      transform: value.transform,
      ...(typeof count === "number" ? { count } : {}),
    };
  }

  if (value.splice !== undefined && value.splice !== null) {
    return {
      splice: stringList(value.splice, "seed.splice", where),
      ...positionField(value.position, where),
    };
  }

  throw new RulesetError(`${where}: seed needs either a transform or a splice list`);
}

// --- refusing a pattern that cannot be interrupted ------------------------

/**
 * Refuse a pattern whose quantifiers nest, while the ruleset is being read.
 *
 * A ruleset is code in the one sense that matters here: it supplies regular
 * expressions that run in this process, and a repository somebody else wrote
 * supplies both the pattern and the paragraph that detonates it. `^(a+)+$`
 * against forty characters took half a second when this was measured; fifty
 * characters never returned. There is nothing to do about that once it starts,
 * because JavaScript cannot interrupt a running regex: no timeout fires, no
 * signal lands, the process is simply gone. A worker would only move the hang
 * somewhere it can be killed, at the cost of a thread per rule.
 *
 * So the check happens before anything runs, and it is deliberately blunt. Two
 * shapes are refused.
 *
 * A quantifier that can match more than one length, applied to a group that
 * already contains one: `(a+)+`. That is the shape of every exponential blowup
 * anyone writes by accident. `{4}` matches exactly one length, so `(\d{4})?`
 * and `(\d{4})+` are ordinary patterns and pass.
 *
 * And a quantified group whose alternatives can match the same text: `(a|a)+`,
 * `(a|ab)+`, `(x|xx)*`. Two branches that can both start on the same character,
 * or where one is a prefix of the other, give the engine the same two ways
 * through the subject that nesting does, and they cost the same. `(cat|dog)+`
 * is left alone, because its branches cannot both start on one character. A
 * branch whose first character cannot be worked out, `(\s|\s)*` or
 * `(.|x)+`, is treated as able to start on anything, so it is refused; that is
 * a false positive on a shape a prose ruleset does not write.
 *
 * Under both of those sits a measured probe: the pattern is run against short
 * strings of growing length before the ruleset is accepted, and a pattern whose
 * cost climbs out of a few milliseconds over twenty-four characters is refused
 * with what it measured. The probe is a measurement on a short string and not a
 * proof of anything about a long one, and it is written that way on purpose:
 * the two shape rules above are what carry the weight.
 */
function refuseNestedQuantifiers(pattern: string, where: string): void {
  interface Frame {
    ambiguous: boolean;
    /** Where this group's contents begin, so its branches can be read back. */
    readonly opened: number;
    /** Where each top-level alternative of this group begins. */
    readonly branches: number[];
  }
  const frames: Frame[] = [{ ambiguous: false, opened: 0, branches: [0] }];
  const top = (): Frame | undefined => frames[frames.length - 1];

  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "(") {
      // A group's contents start after its prefix: `(?:`, `(?<name>`, `(?=`.
      const opens = groupBodyStart(pattern, i);
      frames.push({ ambiguous: false, opened: opens, branches: [opens] });
      i = opens;
      continue;
    }

    if (ch === "|") {
      top()?.branches.push(i + 1);
      i++;
      continue;
    }

    if (ch === ")") {
      const frame = frames.pop();
      // Unbalanced, which `new RegExp` has already refused; nothing to add.
      if (frame === undefined || frames.length === 0) return;
      const quantifier = quantifierAt(pattern, i + 1);
      if (quantifier !== null && quantifier.ambiguous && frame.ambiguous) {
        throw new RulesetError(
          `${where}: pattern nests quantifiers. A repetition that can match more than one length, ` +
            "applied to a group that already contains one, backtracks exponentially, and nothing can " +
            "interrupt it once it starts. Make the inner repetition an exact count, or match the " +
            "two parts separately.",
        );
      }
      const branches = frame.branches.map((start, at) =>
        pattern.slice(start, at + 1 < frame.branches.length ? (frame.branches[at + 1] as number) - 1 : i),
      );
      const overlapping = branches.length > 1 && branchesOverlap(branches);
      if (quantifier !== null && quantifier.ambiguous && overlapping) {
        throw new RulesetError(
          `${where}: pattern repeats a group whose alternatives can match the same text. Two ways ` +
            "through the same characters, repeated, backtracks exponentially, and nothing can " +
            "interrupt it once it starts. Give the alternatives different first characters, or " +
            "match them separately.",
        );
      }
      const parent = top();
      if (parent !== undefined) {
        parent.ambiguous =
          parent.ambiguous ||
          frame.ambiguous ||
          overlapping ||
          (quantifier !== null && quantifier.ambiguous);
      }
      i = quantifier === null ? i + 1 : quantifier.end;
      continue;
    }

    // Any other atom: an escape pair, a character class, or one character.
    let end = i + 1;
    if (ch === "\\") end = i + 2;
    else if (ch === "[") end = classEnd(pattern, i);

    const quantifier = quantifierAt(pattern, end);
    if (quantifier !== null) {
      const frame = top();
      if (frame !== undefined && quantifier.ambiguous) frame.ambiguous = true;
      end = quantifier.end;
    }
    i = end;
  }
}

/** Where a group's contents start, past `?:`, `?<name>`, `?=`, `?!` and friends. */
function groupBodyStart(pattern: string, open: number): number {
  if (pattern[open + 1] !== "?") return open + 1;
  const rest = pattern.slice(open + 2);
  const named = /^<[^>]*>/.exec(rest);
  if (named !== null) return open + 2 + named[0].length;
  const look = /^(<=|<!|:|=|!)/.exec(rest);
  if (look !== null) return open + 2 + look[0].length;
  return open + 2;
}

/**
 * Whether two alternatives of one group can match the same text.
 *
 * Two tests, both conservative. One branch being a prefix of another means the
 * shorter one always matches where the longer one might, which is `(a|ab)` and
 * `(x|xx)`. Branches that can begin on the same character give the engine two
 * ways into the same position, which is `(a|a)` and `(ab|ac)`. Anything whose
 * first character cannot be read off the pattern counts as able to begin on
 * anything.
 */
function branchesOverlap(branches: readonly string[]): boolean {
  const firsts = branches.map(firstCharacters);
  for (let a = 0; a < branches.length; a++) {
    for (let b = a + 1; b < branches.length; b++) {
      const one = branches[a] as string;
      const other = branches[b] as string;
      if (one.startsWith(other) || other.startsWith(one)) return true;
      if (rangesMeet(firsts[a] as Ranges, firsts[b] as Ranges)) return true;
    }
  }
  return false;
}

/**
 * The characters a branch can begin on, or `null` for "anything".
 *
 * Only the shapes that can be read without an engine: a literal, an escaped
 * literal, and a simple character class. A class escape, a dot, a nested group
 * or an optional first atom all give `null`, which is read as "could be
 * anything" and therefore as overlapping.
 */
type Ranges = readonly (readonly [number, number])[] | null;

function firstCharacters(branch: string): Ranges {
  if (branch === "") return null;
  const ch = branch[0] as string;
  let end = 1;
  let ranges: Ranges;

  if (ch === "\\") {
    const next = branch[1];
    if (next === undefined) return null;
    // A class escape, a boundary or a back reference: not one known character.
    if (/[dDwWsSbBpPuxck0-9]/.test(next)) return null;
    ranges = [[next.codePointAt(0) as number, next.codePointAt(0) as number]];
    end = 2;
  } else if (ch === "[") {
    end = classEnd(branch, 0);
    ranges = classRanges(branch.slice(0, end));
  } else if (ch === "(" || ch === "." || ch === "^" || ch === "$") {
    return null;
  } else {
    ranges = [[ch.codePointAt(0) as number, ch.codePointAt(0) as number]];
  }

  // An optional or repeatable first atom means the branch can also begin on
  // whatever follows it, which is more than this reads.
  const quantifier = quantifierAt(branch, end);
  if (quantifier !== null && quantifier.ambiguous) return null;
  return ranges;
}

/** A simple character class as ranges, or `null` when it is not simple. */
function classRanges(source: string): Ranges {
  const body = source.slice(1, -1);
  if (body.startsWith("^")) return null;
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < body.length) {
    let ch = body[i] as string;
    if (ch === "\\") {
      const next = body[i + 1];
      if (next === undefined || /[dDwWsSbBpPuxck0-9]/.test(next)) return null;
      ch = next;
      i += 2;
    } else {
      i += 1;
    }
    if (body[i] === "-" && i + 1 < body.length && body[i + 1] !== "]") {
      let upper = body[i + 1] as string;
      if (upper === "\\") {
        const next = body[i + 2];
        if (next === undefined || /[dDwWsSbBpPuxck0-9]/.test(next)) return null;
        upper = next;
        i += 3;
      } else {
        i += 2;
      }
      ranges.push([ch.codePointAt(0) as number, upper.codePointAt(0) as number]);
    } else {
      ranges.push([ch.codePointAt(0) as number, ch.codePointAt(0) as number]);
    }
  }
  return ranges.length === 0 ? null : ranges;
}

/** Whether two sets of first characters share one. A null side shares with all. */
function rangesMeet(one: Ranges, other: Ranges): boolean {
  if (one === null || other === null) return true;
  return one.some(([lo, hi]) => other.some(([lo2, hi2]) => lo <= hi2 && lo2 <= hi));
}

/** Where a character class ends, so its contents are read as literals. */
function classEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === "^") i++;
  if (pattern[i] === "]") i++;
  while (i < pattern.length) {
    if (pattern[i] === "\\") i += 2;
    else if (pattern[i] === "]") return i + 1;
    else i++;
  }
  return pattern.length;
}

/** A repetition at this position, and whether it can match more than one length. */
function quantifierAt(pattern: string, start: number): { end: number; ambiguous: boolean } | null {
  const lazy = (end: number): number => (pattern[end] === "?" ? end + 1 : end);
  const ch = pattern[start];

  if (ch === "*" || ch === "+") return { end: lazy(start + 1), ambiguous: true };
  if (ch === "?") return { end: lazy(start + 1), ambiguous: true };
  if (ch !== "{") return null;

  const counted = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(start));
  if (counted === null) return null;
  const end = lazy(start + counted[0].length);
  // `{4}` is one length. `{2,}` and `{2,4}` are a range, and a range is what
  // gives the engine something to backtrack through.
  const ambiguous = counted[2] !== undefined && counted[3] !== String(counted[1]);
  return { end, ambiguous };
}

/**
 * What a pattern costs on a short string, measured before it is accepted.
 *
 * The shape rules above refuse the families anyone writes by accident. This is
 * underneath them, for a shape nobody named: the pattern is run against strings
 * of four to twenty-four characters with a tail it cannot match, so the engine
 * has to backtrack through everything it tried, and the time is taken. A
 * linear pattern does that in microseconds. A pattern that backtracks
 * exponentially crosses a few milliseconds somewhere in that range and is
 * refused with the length and the time it took.
 *
 * The lengths climb rather than jumping to the longest, because measuring the
 * cost of a pattern is the one thing that can itself hang: each step is only
 * taken when the one before it was cheap, so the worst case is one step past
 * the budget rather than a process nobody can interrupt.
 *
 * This measures a short string. It is not a proof about a long one, and it
 * cannot be: no bound on a backtracking engine is available from outside it.
 * It catches what it catches, and `PATTERN_TEXT_CAP` limits what any pattern
 * is ever run against.
 */
const PROBE_LENGTHS = [4, 8, 12, 16, 20, 24];

/** Milliseconds one probe may take before the pattern is refused. */
const PROBE_BUDGET_MS = 25;

/** Characters worth repeating: the pattern's own literals, and three staples. */
function probeAlphabet(pattern: string): string[] {
  const seen = new Set<string>();
  for (let i = 0; i < pattern.length && seen.size < 4; i++) {
    const ch = pattern[i] as string;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (/[A-Za-z0-9 ]/.test(ch)) seen.add(ch);
  }
  for (const ch of ["a", " ", "0"]) if (seen.size < 6) seen.add(ch);
  return [...seen];
}

function probePattern(pattern: string, flags: string, where: string): void {
  let regex: RegExp;
  try {
    // Without `g` or `y`, so `lastIndex` cannot carry between probes.
    regex = new RegExp(pattern, flags.replace(/[gy]/g, ""));
  } catch {
    return;
  }

  for (const ch of probeAlphabet(pattern)) {
    for (const length of PROBE_LENGTHS) {
      // A tail the pattern cannot match, so a run that started has to try
      // every way through the repeat before it gives up.
      const subject = `${ch.repeat(length)}\u0000!`;
      const started = performance.now();
      try {
        regex.test(subject);
      } catch {
        return;
      }
      const elapsed = performance.now() - started;
      if (elapsed > PROBE_BUDGET_MS) {
        throw new RulesetError(
          `${where}: pattern took ${elapsed.toFixed(0)} ms on ${String(length)} characters, which is ` +
            "the shape of a regular expression that backtracks exponentially. Nothing can interrupt " +
            "one once it starts, so it is refused here rather than run on somebody's draft. Give any " +
            "repeated group one way through the same characters.",
        );
      }
    }
  }
}

// --- running the countable checks ----------------------------------------

/**
 * How much of one paragraph a ruleset's own pattern is run against.
 *
 * The last layer, under the two shape refusals and the probe. A paragraph
 * longer than this is checked up to here by a pattern rule, and the run says so
 * rather than quietly finding nothing; the built-in rules read the whole
 * paragraph, because this tool wrote them.
 *
 * On a pattern that backtracks exponentially a cap on the length is not a cap
 * on the cost, which is why it is written down here as the last layer and not
 * as the answer. The refusals above are the answer.
 */
export const PATTERN_TEXT_CAP = 8_000;

/** Run one countable rule over one chunk of text. Never touches the network. */
export function checkRegexRule(rule: RegexRule, text: string): Match[] {
  if (rule.source === "pattern") {
    return patternMatches(
      new RegExp(rule.pattern, withGlobal(rule.flags ?? "")),
      text.slice(0, PATTERN_TEXT_CAP),
    );
  }
  const check = BUILTINS[rule.builtin];
  if (check === undefined) {
    throw new RulesetError(`rule "${rule.id}": unknown built-in "${rule.builtin}"`);
  }
  return check(text, rule);
}

/**
 * A long dash in prose, and not a number range.
 *
 * An en dash between two numerals is a range ("pages 10 to 20" written the
 * typographer's way), and the rule is about a writer reaching for a dash
 * instead of a full stop. Those are different marks doing different jobs, so
 * the range is left alone and the prose dash is not.
 *
 * A quotation of someone else's text keeps its dashes, as far as that can be
 * told: a block quote is a whole chunk and is excluded by kind. A quotation
 * running inline inside a sentence cannot be told from the writer's own words
 * without parsing quotation marks that also mean five other things, so it is
 * still flagged, and this note is the honest version of why.
 */
function dashPresent(text: string): Match[] {
  // An en dash or an em dash, written as escapes so this file holds neither
  // character literally and passes the rule it implements. The lookarounds
  // spare an en dash sitting between digits.
  return patternMatches(/(?<!\d)[\u2013](?!\d)|[\u2014]/g, text);
}

/**
 * Colons a reader would see as punctuation.
 *
 * The colon in `https://`, the one in `14:30` and the ones inside an HTML
 * comment are not the writer stacking clauses, and counting them was enough to
 * tell a paragraph with three links in it to pick one colon. They are masked
 * to spaces rather than removed, so the offset the flag reports still points at
 * the line the colon is on.
 */
function colonCount(text: string, rule: BuiltinRule): Match[] {
  const min = rule.min ?? DEFAULT_COLON_MIN;
  const prose = maskNonProse(text);
  const first = prose.indexOf(":");
  let count = 0;
  for (const ch of prose) if (ch === ":") count++;
  return count >= min && first !== -1 ? [{ index: first }] : [];
}

/** URLs, clock times and HTML comments, blanked without moving any offset. */
function maskNonProse(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, blankRun)
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, blankRun)
    .replace(/<!--[\s\S]*?-->/g, blankRun);
}

function blankRun(match: string): string {
  return match.replace(/[^\n]/g, " ");
}

function sentenceRhythm(text: string, rule: BuiltinRule): Match[] {
  const floor = rule.floor ?? DEFAULT_RHYTHM_FLOOR;
  const minSentences = rule.min_sentences ?? DEFAULT_MIN_SENTENCES;
  const minWords = rule.min_words ?? DEFAULT_MIN_WORDS;

  const lengths = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().split(/\s+/).filter(Boolean).length)
    .filter((length) => length > 0);

  if (lengths.length < minSentences) return [];
  if (lengths.reduce((sum, n) => sum + n, 0) < minWords) return [];

  const mean = lengths.reduce((sum, n) => sum + n, 0) / lengths.length;
  if (mean === 0) return [];
  const variance = lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length;
  const coefficient = Math.sqrt(variance) / mean;

  return coefficient < floor ? [{ index: 0 }] : [];
}

/**
 * A word list matched the way the rule says it is matched.
 *
 * The rule promises "any inflection that shares the stem as written", and a
 * bare word boundary delivered nothing of the sort: `delve` missed "delves" and
 * "delving", `seamless` missed "seamlessly", `navigate` missed "navigating".
 * The words a checker like this exists to catch almost never appear in their
 * dictionary form, so the rule was answering a question nobody asks.
 *
 * The endings below are the ordinary English ones, with the silent `e` and the
 * `y` handled, because those two are where most of the misses were. It is not a
 * stemmer and does not want to be: a list of endings can be read and argued
 * with in a way that a stemming algorithm cannot.
 */
const CONSONANT_ENDINGS = "s|es|ed|ing|ly|ment|ments|ion|ions";
const SILENT_E_KEPT = "s|d|ly|ment|ments";
const SILENT_E_DROPPED = "es|ed|ing|ion|ions";

function inflections(word: string): string {
  const stem = escapeRegExp(word.trim()).replace(/\\?\s+/g, "\\s+");
  if (word.endsWith("e")) {
    const dropped = escapeRegExp(word.trim().slice(0, -1)).replace(/\\?\s+/g, "\\s+");
    return `${stem}(?:${SILENT_E_KEPT})?|${dropped}(?:${SILENT_E_DROPPED})`;
  }
  if (word.endsWith("y")) {
    const dropped = escapeRegExp(word.trim().slice(0, -1)).replace(/\\?\s+/g, "\\s+");
    return `${stem}(?:${CONSONANT_ENDINGS})?|${dropped}(?:ies|ied)`;
  }
  return `${stem}(?:${CONSONANT_ENDINGS})?`;
}

function wordList(text: string, words: readonly string[], except: readonly string[]): Match[] {
  if (words.length === 0) return [];
  const alternation = [...words]
    .sort((a, b) => b.length - a.length)
    .map(inflections)
    .join("|");
  const found = patternMatches(new RegExp(`\\b(?:${alternation})\\b`, "gi"), text);
  if (except.length === 0) return found;

  const spared = exceptionSpans(text, except);
  return found.filter((match) => !spared.some(([from, to]) => match.index >= from && match.index < to));
}

/**
 * Where in the text a listed literal sense sits, so a match inside one is spared.
 *
 * Each word of the phrase is matched in its own ordinary inflections, so
 * "unlock the door" spares "unlocks the door" and "unlocking the door". The
 * words still have to be adjacent: "unlocks the back door" is not spared,
 * because a phrase that tolerated anything in the middle would spare half the
 * sentences it appeared in. That limit is in `docs/eval-notes.md`.
 */
function exceptionSpans(text: string, except: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const phrase of except) {
    const needle = phrase.trim();
    if (needle === "") continue;
    const source = needle
      .split(/\s+/)
      .map((word) => (/^[a-z]+$/i.test(word) ? `(?:${inflections(word.toLowerCase())})` : escapeRegExp(word)))
      .join("\\s+");
    const scanner = new RegExp(source, "gi");
    for (;;) {
      const hit = scanner.exec(text);
      if (hit === null) break;
      spans.push([hit.index, hit.index + hit[0].length]);
      if (hit[0] === "") scanner.lastIndex++;
    }
  }
  return spans;
}

function patternMatches(pattern: RegExp, text: string): Match[] {
  const matches: Match[] = [];
  const scanner = new RegExp(pattern.source, withGlobal(pattern.flags));
  for (;;) {
    const found = scanner.exec(text);
    if (found === null) break;
    matches.push({ index: found.index });
    if (found[0] === "") scanner.lastIndex++;
  }
  return matches;
}

// --- small helpers --------------------------------------------------------

function isMapping(value: YamlValue | undefined): value is Record<string, YamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withGlobal(flags: string): string {
  return flags.includes("g") ? flags : `${flags}g`;
}

/** `chunks:` on a countable rule: which kinds of block it has anything to say about. */
function chunkField(
  value: YamlValue | undefined,
  where: string,
): { chunks?: readonly ChunkKind[] } {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) {
    throw new RulesetError(`${where}: chunks must be a list of ${CHUNK_KINDS.join(", ")}`);
  }
  const kinds: ChunkKind[] = [];
  for (const item of value) {
    if (!isChunkKind(item)) {
      throw new RulesetError(
        `${where}: "${String(item)}" is not a chunk kind. The kinds are ${CHUNK_KINDS.join(", ")}.`,
      );
    }
    kinds.push(item);
  }
  return { chunks: kinds };
}

function numberField(
  value: YamlValue | undefined,
  name: "min" | "floor" | "min_sentences" | "min_words",
  where: string,
): Partial<Record<"min" | "floor" | "min_sentences" | "min_words", number>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "number") throw new RulesetError(`${where}: ${name} must be a number`);
  return { [name]: value };
}

/**
 * `seed.position` on a splice seed.
 *
 * It is one optional field rather than three, because "where the sentence
 * lands" is one decision, and the rules that care about it (an opener, a
 * closer) care about exactly one value of it.
 */
function positionField(
  value: YamlValue | undefined,
  where: string,
): { position?: SeedPosition } {
  if (value === undefined || value === null) return {};
  if (!isSeedPosition(value)) {
    throw new RulesetError(
      `${where}: seed.position must be one of ${SEED_POSITIONS.join(", ")}, not "${String(value)}"`,
    );
  }
  return { position: value };
}

function stringList(value: YamlValue | undefined, name: string, where: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RulesetError(`${where}: ${name} must be a list of strings`);
  }
  // SAFETY: the guard above proves every element is a string; `some` narrows the
  // elements for a human but not for the type checker.
  return value as string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
