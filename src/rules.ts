/**
 * Rule types, ruleset validation, and the built-in countable checks.
 *
 * Countable rules live here and run with no network. Judgment rules are
 * validated here and answered elsewhere; nothing in this file calls out.
 */

import {
  type BuiltinRule,
  type Match,
  type RegexRule,
  type Rule,
  type Ruleset,
  type Seed,
  type SeedPosition,
  SEED_POSITIONS,
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

const DEFAULT_COLON_MIN = 3;
const DEFAULT_RHYTHM_FLOOR = 0.25;
const DEFAULT_MIN_SENTENCES = 4;

type BuiltinCheck = (text: string, rule: BuiltinRule) => Match[];

const BUILTINS: Readonly<Record<string, BuiltinCheck>> = {
  dash_present: dashPresent,
  colon_count: colonCount,
  // The plan writes this check as `colon_count` in the ruleset shape and as
  // `colon_heavy` in prose. Both spellings resolve to the same check.
  colon_heavy: colonCount,
  sentence_rhythm: sentenceRhythm,
  slop_vocab: (text, rule) => wordList(text, rule.words ?? DEFAULT_SLOP_WORDS),
  banned_words: (text, rule) => wordList(text, rule.words ?? []),
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
  const common = {
    id,
    message,
    ...(seed === undefined ? {} : { seed }),
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
    ...(entry.words === undefined || entry.words === null
      ? {}
      : { words: stringList(entry.words, "words", where) }),
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
 * So the check happens before anything runs, and it is deliberately blunt: a
 * quantifier that can match more than one length, applied to a group that
 * already contains one. That is the shape of every exponential blowup anyone
 * writes by accident. `{4}` matches exactly one length, so `(\d{4})?` and
 * `(\d{4})+` are ordinary patterns and pass.
 *
 * What it does not catch is ambiguity through alternation, `(a|a)+`, which
 * needs a real analyser to see. The cap below is the second layer under that,
 * and it is a bound on the cost rather than a proof there is none.
 */
function refuseNestedQuantifiers(pattern: string, where: string): void {
  interface Frame {
    ambiguous: boolean;
  }
  const frames: Frame[] = [{ ambiguous: false }];
  const top = (): Frame | undefined => frames[frames.length - 1];

  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "(") {
      frames.push({ ambiguous: false });
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
      const parent = top();
      if (parent !== undefined) {
        parent.ambiguous =
          parent.ambiguous || frame.ambiguous || (quantifier !== null && quantifier.ambiguous);
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

// --- running the countable checks ----------------------------------------

/**
 * How much of one paragraph a ruleset's own pattern is run against.
 *
 * The second layer under the refusal above, for the shapes it cannot name. A
 * paragraph longer than this is checked up to here by a pattern rule, and the
 * run says so rather than quietly finding nothing; the built-in rules read the
 * whole paragraph, because this tool wrote them.
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

function dashPresent(text: string): Match[] {
  // An en dash or an em dash, written as escapes so this file holds neither
  // character literally and passes the rule it implements.
  return patternMatches(/[\u2013\u2014]/g, text);
}

function colonCount(text: string, rule: BuiltinRule): Match[] {
  const min = rule.min ?? DEFAULT_COLON_MIN;
  const first = text.indexOf(":");
  let count = 0;
  for (const ch of text) if (ch === ":") count++;
  return count >= min && first !== -1 ? [{ index: first }] : [];
}

function sentenceRhythm(text: string, rule: BuiltinRule): Match[] {
  const floor = rule.floor ?? DEFAULT_RHYTHM_FLOOR;
  const minSentences = rule.min_sentences ?? DEFAULT_MIN_SENTENCES;

  const lengths = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().split(/\s+/).filter(Boolean).length)
    .filter((length) => length > 0);

  if (lengths.length < minSentences) return [];

  const mean = lengths.reduce((sum, n) => sum + n, 0) / lengths.length;
  if (mean === 0) return [];
  const variance = lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length;
  const coefficient = Math.sqrt(variance) / mean;

  return coefficient < floor ? [{ index: 0 }] : [];
}

function wordList(text: string, words: readonly string[]): Match[] {
  if (words.length === 0) return [];
  const alternation = [...words]
    .sort((a, b) => b.length - a.length)
    .map((word) => escapeRegExp(word.trim()).replace(/\\?\s+/g, "\\s+"))
    .join("|");
  return patternMatches(new RegExp(`\\b(?:${alternation})\\b`, "gi"), text);
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

function numberField(
  value: YamlValue | undefined,
  name: "min" | "floor" | "min_sentences",
  where: string,
): Partial<Record<"min" | "floor" | "min_sentences", number>> {
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
