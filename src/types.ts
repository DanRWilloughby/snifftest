/**
 * The shapes the whole tool agrees on.
 *
 * Field names match the YAML a ruleset is written in, one for one, so a rule
 * file and a `Rule` value read the same way and nothing has to be translated
 * between them.
 */

export type RuleKind = "regex" | "judgment";

/** How `eval` manufactures a defect for a rule (the seeding recipe). */
export interface TransformSeed {
  readonly transform: string;
  readonly count?: number;
}

/** Where a spliced sentence lands in the paragraph it is planted in. */
export type SeedPosition = "any" | "start" | "end";

export const SEED_POSITIONS: readonly SeedPosition[] = ["any", "start", "end"];

export interface SpliceSeed {
  readonly splice: readonly string[];
  /** Absent means `any`; a rule about openers or closers needs the other two. */
  readonly position?: SeedPosition;
}

export type Seed = TransformSeed | SpliceSeed;

interface RuleCommon {
  /** Stable identifier; it is the contract a flag is reported under. */
  readonly id: string;
  /** One line in the plain-and-a-little-funny register, printed with the flag. */
  readonly message: string;
  readonly seed?: Seed;
}

/** Knobs a countable rule may carry. Which ones apply depends on the check. */
interface RegexTuning {
  /** `colon_count`: the number of colons that trips the rule. */
  readonly min?: number;
  /** `sentence_rhythm`: the coefficient of variation below which lengths are too uniform. */
  readonly floor?: number;
  /** `sentence_rhythm`: how many sentences a paragraph needs before rhythm is judged. */
  readonly min_sentences?: number;
  /** `banned_words` and `slop_vocab`: the word list to match. */
  readonly words?: readonly string[];
}

/**
 * A countable rule written against a named built-in check.
 *
 * `source` exists so the two shapes are a discriminated union rather than two
 * optional fields: "exactly one of builtin or pattern" is a validation rule the
 * reader has to remember, and a type that cannot express the other three
 * combinations is one the type checker remembers instead.
 */
export interface BuiltinRule extends RuleCommon, RegexTuning {
  readonly kind: "regex";
  readonly source: "builtin";
  readonly builtin: string;
}

/** A countable rule written as a regular expression of the ruleset author's own. */
export interface PatternRule extends RuleCommon, RegexTuning {
  readonly kind: "regex";
  readonly source: "pattern";
  readonly pattern: string;
  readonly flags?: string;
}

/** A countable rule. It runs locally and never touches the network. */
export type RegexRule = BuiltinRule | PatternRule;

/** A rule that needs reading. It is answered by a model, never by a regex. */
export interface JudgmentRule extends RuleCommon {
  readonly kind: "judgment";
  readonly what: string;
  readonly not_for?: string;
  readonly examples?: readonly string[];
  readonly criteria: {
    readonly true: string;
    readonly false: string;
  };
}

export type Rule = RegexRule | JudgmentRule;

export interface Ruleset {
  readonly version: 1;
  /** Probability at or above which a flag counts. Absent means the caller decides. */
  readonly threshold?: number;
  readonly rules: readonly Rule[];
}

/** A paragraph of a document, carrying where it started so flags can be placed. */
export interface Chunk {
  readonly file: string;
  /** 1-based line of the chunk's first line within its file. */
  readonly line: number;
  readonly text: string;
}

/** Where inside a chunk's text a check fired. */
export interface Match {
  /** 0-based character offset into the chunk's text. */
  readonly index: number;
}

export interface Flag {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly kind: RuleKind;
  /** 1 for a countable rule; the returned probability for a judgment rule. */
  readonly probability: number;
  readonly message: string;
}

export function isRegexRule(rule: Rule): rule is RegexRule {
  return rule.kind === "regex";
}

export function isJudgmentRule(rule: Rule): rule is JudgmentRule {
  return rule.kind === "judgment";
}
