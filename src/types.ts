/**
 * The shapes the whole tool agrees on.
 *
 * Field names match the YAML a ruleset is written in, one for one, so a rule
 * file and a `Rule` value read the same way and nothing has to be translated
 * between them.
 */

export type RuleKind = "regex" | "judgment";

/**
 * What a chunk of a document is, as a reader would say it.
 *
 * A paragraph is the unit this tool checks, and for most of a Markdown file
 * that unit is not a paragraph at all. Half the blocks in this repo's own docs
 * are headings, table rows, front matter or link definitions, and a rule about
 * prose has no business firing on any of them. So every chunk carries what it
 * is, countable rules say which kinds they apply to, and the judgment arm pays
 * for questions about prose only.
 */
export type ChunkKind =
  | "front_matter"
  | "heading"
  | "table"
  | "link_definition"
  | "html_comment"
  | "list"
  | "block_quote"
  | "prose";

export const CHUNK_KINDS: readonly ChunkKind[] = [
  "front_matter",
  "heading",
  "table",
  "link_definition",
  "html_comment",
  "list",
  "block_quote",
  "prose",
];

export function isChunkKind(value: unknown): value is ChunkKind {
  // SAFETY: `includes` on a `readonly ChunkKind[]` will not take an arbitrary
  // string, so the list is widened to its own supertype to ask the question.
  return typeof value === "string" && (CHUNK_KINDS as readonly string[]).includes(value);
}

/** How `eval` manufactures a defect for a rule (the seeding recipe). */
export interface TransformSeed {
  readonly transform: string;
  readonly count?: number;
}

/** Where a spliced sentence lands in the paragraph it is planted in. */
export type SeedPosition = "any" | "start" | "end";

export const SEED_POSITIONS: readonly SeedPosition[] = ["any", "start", "end"];

export function isSeedPosition(value: unknown): value is SeedPosition {
  // SAFETY: `includes` on a `readonly SeedPosition[]` will not take an arbitrary
  // string, so the list is widened to its own supertype to ask the question.
  return typeof value === "string" && (SEED_POSITIONS as readonly string[]).includes(value);
}

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
  /**
   * What kind of rule this is, so a reader can tell a rule about writing from a
   * rule about a marketing page. A ruleset's `off_by_default` names the tags
   * that do not run unless they are asked for.
   */
  readonly tags?: readonly string[];
}

/** Knobs a countable rule may carry. Which ones apply depends on the check. */
interface RegexTuning {
  /**
   * The chunk kinds this rule applies to. Absent means the check's own default,
   * which for every built-in is the kinds a person would call writing.
   */
  readonly chunks?: readonly ChunkKind[];
  /** `sentence_rhythm`: how many words a paragraph needs before rhythm is judged. */
  readonly min_words?: number;
  /** `colon_count`: the number of colons that trips the rule. */
  readonly min?: number;
  /** `sentence_rhythm`: the coefficient of variation below which lengths are too uniform. */
  readonly floor?: number;
  /** `sentence_rhythm`: how many sentences a paragraph needs before rhythm is judged. */
  readonly min_sentences?: number;
  /** `banned_words` and `slop_vocab`: the word list to match. */
  readonly words?: readonly string[];
  /**
   * `banned_words` and `slop_vocab`: literal phrases in which a listed word is
   * doing its honest job, and is not a flag.
   */
  readonly except?: readonly string[];
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
  /**
   * Tags whose rules sit out an ordinary run.
   *
   * A rule that encodes a convention of one kind of writing is not wrong; it is
   * out of place everywhere else. Naming those tags here is how a ruleset can
   * carry both without a paragraph of documentation being told that its honest
   * scope note is a defect.
   */
  readonly off_by_default?: readonly string[];
  readonly rules: readonly Rule[];
}

/** A paragraph of a document, carrying where it started so flags can be placed. */
export interface Chunk {
  readonly file: string;
  /** 1-based line of the chunk's first line within its file. */
  readonly line: number;
  readonly text: string;
  /** What this block is. Prose is the only kind every rule applies to. */
  readonly kind: ChunkKind;
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

/**
 * A parsed JSON value narrowed to an object, or `null` when it is anything else.
 *
 * Anything that reads JSON off a wire or off disk needs the same three checks
 * before it can look up a key, so they live here once. That keeps the one cast
 * that expresses them in one place, where it can be read and argued with.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // SAFETY: the checks above rule out every JSON value that is not a plain
  // object, and a plain object whose keys are not known is exactly a
  // `Record<string, unknown>`. There is no narrowing form that expresses this.
  return value as Record<string, unknown>;
}

export function isRegexRule(rule: Rule): rule is RegexRule {
  return rule.kind === "regex";
}

export function isJudgmentRule(rule: Rule): rule is JudgmentRule {
  return rule.kind === "judgment";
}
