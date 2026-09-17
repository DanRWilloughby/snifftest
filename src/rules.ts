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
  CHUNK_KINDS,
  SEED_POSITIONS,
  isChunkKind,
  isSeedPosition,
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
): { what: string; not_for?: string; examples?: readonly string[]; criteria: { true: string; false: string } } {
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

  return {
    what,
    ...(typeof notFor === "string" ? { not_for: notFor } : {}),
    ...(examples === undefined ? {} : { examples }),
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

// --- running the countable checks ----------------------------------------

/** Run one countable rule over one chunk of text. Never touches the network. */
export function checkRegexRule(rule: RegexRule, text: string): Match[] {
  if (rule.source === "pattern") {
    return patternMatches(new RegExp(rule.pattern, withGlobal(rule.flags ?? "")), text);
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

/** Where in the text a listed literal sense sits, so a match inside one is spared. */
function exceptionSpans(text: string, except: readonly string[]): [number, number][] {
  const spans: [number, number][] = [];
  for (const phrase of except) {
    const needle = phrase.trim();
    if (needle === "") continue;
    const scanner = new RegExp(escapeRegExp(needle).replace(/\\?\s+/g, "\\s+"), "gi");
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
