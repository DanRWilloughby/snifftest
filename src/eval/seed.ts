/**
 * Planting one known fault per rule inside somebody's own clean writing.
 *
 * `eval` measures a checker the only way a checker can honestly be measured:
 * on text where the answer is already known. Buying that knowledge means
 * manufacturing the faults, and manufacturing faults is where a benchmark
 * usually starts flattering itself. Four rules keep this one honest.
 *
 * ## Every base is mechanically clean first
 *
 * A paragraph that already trips a countable rule cannot be a base, because the
 * seeded copy would be positive for a rule it was never meant to test and the
 * scorer would count that as a false positive against every arm. Bases are
 * filtered by running the countable arm over them, and a dropped base carries
 * the rule that dropped it.
 *
 * ## Every edit is keyed, and an ambiguous key aborts
 *
 * The spike's `build_inputs.py` recorded each seed as a literal find-and-replace
 * pair and exited if the find string matched anything other than exactly once,
 * so that a corpus could never silently reshuffle when its source moved. The
 * same rule holds here: the find string is grown until it is unique, and a seed
 * that cannot be made unique fails loudly with the rule id.
 *
 * ## Every seeded paragraph is checked for a second defect
 *
 * A seed that plants two faults would make one of them an off-rule flag, which
 * the scorer counts as a false positive. After each edit the countable arm runs
 * again, and a seeded paragraph that trips a rule other than its own is thrown
 * away and another base is tried.
 *
 * ## The whole thing is a function of one seed value
 *
 * Which base a rule gets, which sentence is spliced, which comma becomes a
 * colon: all of it comes from a small deterministic generator keyed by the seed
 * value and the rule id. Same seed, same corpus, on any machine, in any order.
 */

import { checkRegexRule } from "../rules.ts";
import {
  type RegexRule,
  type Rule,
  type Ruleset,
  type SeedPosition,
  isRegexRule,
} from "../types.ts";
import { DEFAULT_SLOP_WORDS } from "../rules.ts";

/** The documented default, so a run with no `--seed` is still reproducible. */
export const DEFAULT_SEED = 1;

/** Seeded paragraphs per rule. Three is the spike's count. */
export const DEFAULT_PER_RULE = 3;

/** How far a find string is grown before an ambiguous key is a failure. */
const MAX_KEY_GROWTH = 6;

/** A frame that reads as a sentence whatever part of speech the word is. */
const WORD_FRAME = (word: string): string => `One word keeps coming up here, ${word}.`;

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

/** A candidate paragraph, before anything is known about whether it is clean. */
export interface BaseDocument {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** A find-and-replace pair, unique in the base text. */
export interface KeyedEdit {
  readonly kind: "replace";
  readonly find: string;
  readonly replace: string;
}

/** One sentence planted at a chosen boundary. */
export interface SpliceEdit {
  readonly kind: "splice";
  readonly sentence: string;
  readonly position: SeedPosition;
  /** How many of the base's sentences the spliced one comes after. */
  readonly after_sentences: number;
}

/** The whole paragraph re-flowed; the only transform that is not minimal. */
export interface RewriteEdit {
  readonly kind: "rewrite";
  readonly note: string;
}

export type SeedEdit = KeyedEdit | SpliceEdit | RewriteEdit;

export interface SeededDocument {
  readonly id: string;
  readonly base_id: string;
  readonly base_file: string;
  /** The one rule this paragraph is positive for. It is negative for all others. */
  readonly rule: string;
  /** The transform that made it: a named recipe, or `splice`. */
  readonly transform: string;
  readonly edit: SeedEdit;
  readonly words: number;
  readonly text: string;
}

export interface DroppedBase {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

export interface SkippedRule {
  readonly rule: string;
  readonly reason: string;
}

export interface SeedOptions {
  readonly seed?: number;
  readonly perRule?: number;
}

export interface SeedCorpusResult {
  readonly seedValue: number;
  readonly perRule: number;
  readonly clean: readonly BaseDocument[];
  readonly dropped: readonly DroppedBase[];
  readonly seeded: readonly SeededDocument[];
  readonly skipped: readonly SkippedRule[];
}

// --- the keyed edit -------------------------------------------------------

/**
 * Apply one literal edit, or refuse.
 *
 * The count check is the whole point: a find string that matches twice would
 * edit whichever copy came first, and a corpus that depends on which copy came
 * first is not a frozen corpus.
 */
export function applyKeyedEdit(
  text: string,
  find: string,
  replace: string,
  where: string,
): string {
  const count = occurrences(text, find);
  if (count !== 1) {
    throw new SeedError(`${where}: the seed's find string matched ${count} times, and must match once`);
  }
  return text.replace(find, replace);
}

// --- seeding a corpus -----------------------------------------------------

export function seedCorpus(
  candidates: readonly BaseDocument[],
  ruleset: Ruleset,
  options: SeedOptions = {},
): SeedCorpusResult {
  const seedValue = options.seed ?? DEFAULT_SEED;
  const perRule = Math.max(1, options.perRule ?? DEFAULT_PER_RULE);
  const countable = ruleset.rules.filter(isRegexRule);

  const clean: BaseDocument[] = [];
  const dropped: DroppedBase[] = [];
  for (const candidate of candidates) {
    const tripped = trips(countable, candidate.text);
    if (tripped.length === 0) {
      clean.push(candidate);
      continue;
    }
    dropped.push({
      id: candidate.id,
      file: candidate.file,
      line: candidate.line,
      reason: `already trips ${tripped.join(", ")}`,
    });
  }

  const seeded: SeededDocument[] = [];
  const skipped: SkippedRule[] = [];
  let ordinal = 0;

  for (const rule of ruleset.rules) {
    if (rule.seed === undefined) {
      skipped.push({ rule: rule.id, reason: "the rule carries no seed recipe" });
      continue;
    }

    const random = generator(seedValue, rule.id);
    const order = shuffled(clean, random);
    const made: SeededDocument[] = [];
    const refusals: string[] = [];

    for (const candidate of order) {
      if (made.length === perRule) break;
      let text: string;
      let edit: SeedEdit;
      try {
        const planted = plant(rule, candidate.text, random);
        text = planted.text;
        edit = planted.edit;
      } catch (error) {
        if (!(error instanceof SeedError)) throw error;
        refusals.push(error.message);
        continue;
      }

      const second = trips(countable, text).filter((id) => id !== rule.id);
      if (second.length > 0) {
        refusals.push(`the seeded copy of ${candidate.id} also tripped ${second.join(", ")}`);
        continue;
      }
      if (isRegexRule(rule) && !trips([rule], text).includes(rule.id)) {
        refusals.push(`the seeded copy of ${candidate.id} did not trip ${rule.id}`);
        continue;
      }

      ordinal += 1;
      made.push({
        id: `S${String(ordinal).padStart(2, "0")}`,
        base_id: candidate.id,
        base_file: candidate.file,
        rule: rule.id,
        transform: transformName(rule),
        edit,
        words: words(text),
        text,
      });
    }

    seeded.push(...made);
    if (made.length < perRule) {
      skipped.push({
        rule: rule.id,
        reason:
          made.length === 0
            ? `no paragraph could be seeded (${reasons(refusals)})`
            : `seeded ${made.length} of ${perRule} paragraphs (${reasons(refusals)})`,
      });
    }
  }

  return { seedValue, perRule, clean, dropped, seeded, skipped };
}

function reasons(refusals: readonly string[]): string {
  if (refusals.length === 0) return "no clean paragraph was left to try";
  return [...new Set(refusals)].join("; ");
}

function transformName(rule: Rule): string {
  const seed = rule.seed;
  if (seed === undefined) return "none";
  return "transform" in seed ? seed.transform : "splice";
}

// --- planting one defect --------------------------------------------------

interface Planted {
  readonly text: string;
  readonly edit: SeedEdit;
}

function plant(rule: Rule, text: string, random: Random): Planted {
  const seed = rule.seed;
  const where = `rule "${rule.id}"`;
  if (seed === undefined) throw new SeedError(`${where}: no seed recipe`);

  if ("splice" in seed) {
    const position = seed.position ?? "any";
    const sentence = pick(seed.splice, random);
    if (sentence === undefined || sentence.trim() === "") {
      throw new SeedError(`${where}: the splice list is empty`);
    }
    if (text.includes(sentence.trim())) {
      throw new SeedError(`${where}: the spliced sentence is already in the paragraph`);
    }
    return splice(text, sentence.trim(), position, random);
  }

  const count = Math.max(1, Math.round(seed.count ?? 1));

  switch (seed.transform) {
    case "insert_em_dash":
      return commaTransform(text, count, where, " — ");
    case "add_colons":
      return commaTransform(text, colonsNeeded(rule, text, count), where, ": ");
    case "equalize_sentences":
      return equalizeSentences(text, where);
    case "insert_slop_word":
      return plantWords(rule, text, count, where, random, DEFAULT_SLOP_WORDS);
    case "insert_banned_word":
      return plantWords(rule, text, count, where, random, []);
    default:
      throw new SeedError(`${where}: unknown seed transform "${seed.transform}"`);
  }
}

/** How many colons this paragraph still needs to clear the rule's own minimum. */
function colonsNeeded(rule: Rule, text: string, count: number): number {
  const min = isRegexRule(rule) ? (rule.min ?? 3) : 3;
  const present = occurrences(text, ":");
  return Math.max(count, min - present);
}

/**
 * Edit `count` comma sites, each as its own keyed edit.
 *
 * A comma followed by a space is the one site that exists in almost any prose
 * and can be replaced without changing a word of it. Sites are taken from the
 * end backwards so that an earlier edit cannot move a later one's key.
 */
function commaTransform(text: string, count: number, where: string, replacement: string): Planted {
  const sites = sitesOf(text, ", ");
  if (sites.length < count) {
    throw new SeedError(
      `${where}: the paragraph has ${sites.length} comma sites and the seed needs ${count}`,
    );
  }

  const chosen = sites.slice(-count);
  let out = text;
  const finds: string[] = [];
  const replaces: string[] = [];

  // Last site first: an edit never moves a site earlier in the text than itself,
  // so every offset taken from the original is still valid when its turn comes.
  for (const site of [...chosen].reverse()) {
    const key = uniqueKey(out, site, 2, where);
    // The replacement is spliced at the site's own offset inside the key rather
    // than at the key's first comma, because a grown key can swallow an earlier
    // comma and editing that one would move the defect to the wrong sentence.
    const inside = site - key.start;
    const replace = key.text.slice(0, inside) + replacement + key.text.slice(inside + 2);
    out = applyKeyedEdit(out, key.text, replace, where);
    finds.unshift(key.text);
    replaces.unshift(replace);
  }

  return {
    text: out,
    edit: { kind: "replace", find: finds.join(" | "), replace: replaces.join(" | ") },
  };
}

/**
 * Re-flow the paragraph into sentences of near-equal length.
 *
 * The only transform that rewrites rather than edits, because sentence rhythm
 * is a property of the whole paragraph and cannot be planted with one comma.
 * Word order is preserved, so the paragraph still reads as the same prose; only
 * the full stops move. The spike did the same thing by hand.
 */
function equalizeSentences(text: string, where: string): Planted {
  const all = text
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word !== "");
  if (all.length < 16) {
    throw new SeedError(`${where}: the paragraph has ${all.length} words, too few to re-flow`);
  }

  const lengths = sentenceLengths(text);
  const mean = lengths.length === 0 ? 12 : lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const target = Math.min(24, Math.max(8, Math.round(mean)));
  const sentences = Math.max(4, Math.round(all.length / target));
  const size = Math.floor(all.length / sentences);
  if (size < 3) throw new SeedError(`${where}: the paragraph is too short for four even sentences`);

  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < sentences; i++) {
    const extra = i < all.length - size * sentences ? 1 : 0;
    const take = i === sentences - 1 ? all.length - at : size + extra;
    const piece = all.slice(at, at + take).map(stripTerminator).filter((word) => word !== "");
    at += take;
    if (piece.length === 0) continue;
    out.push(`${capitalise(piece.join(" "))}.`);
  }

  return {
    text: out.join(" "),
    edit: {
      kind: "rewrite",
      note: `re-flowed into ${out.length} sentences of about ${size} words, word order unchanged`,
    },
  };
}

/** Plant `count` words from the rule's own list, each in its own sentence. */
function plantWords(
  rule: Rule,
  text: string,
  count: number,
  where: string,
  random: Random,
  fallback: readonly string[],
): Planted {
  const list = (isRegexRule(rule) ? rule.words : undefined) ?? fallback;
  if (list.length === 0) {
    throw new SeedError(`${where}: the rule has no words, so no defect of this kind can be made`);
  }

  const chosen: string[] = [];
  for (let i = 0; i < count; i++) {
    const word = list[Math.floor(random() * list.length) % list.length];
    if (word !== undefined) chosen.push(word);
  }
  if (chosen.length === 0) throw new SeedError(`${where}: no word could be chosen`);

  const sentence = chosen.map((word) => WORD_FRAME(word)).join(" ");
  return splice(text, sentence, "any", random);
}

/** Put one sentence in at a sentence boundary the position allows. */
function splice(
  text: string,
  sentence: string,
  position: SeedPosition,
  random: Random,
): Planted {
  const bounds = sentenceBounds(text);
  const last = bounds.length;
  const after =
    position === "start"
      ? 0
      : position === "end"
        ? last
        : // `any` means inside: never the first boundary, never the last, so a
          // rule about openers and a rule about closers cannot be seeded by it.
          last <= 2
          ? Math.max(0, last - 1)
          : 1 + Math.floor(random() * (last - 2));

  const at = after === 0 ? 0 : after >= last ? text.length : (bounds[after - 1] ?? text.length);
  const head = text.slice(0, at).trimEnd();
  const tail = text.slice(at).trimStart();

  const pieces = [head, sentence, tail].filter((piece) => piece !== "");
  return {
    text: pieces.join(" "),
    edit: { kind: "splice", sentence, position, after_sentences: after },
  };
}

// --- countable checks over a whole ruleset --------------------------------

function trips(rules: readonly RegexRule[], text: string): string[] {
  const ids: string[] = [];
  for (const rule of rules) {
    if (checkRegexRule(rule, text).length > 0) ids.push(rule.id);
  }
  return ids;
}

// --- text helpers ---------------------------------------------------------

function sentenceLengths(text: string): number[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => words(sentence))
    .filter((length) => length > 0);
}

/** The character offset just past each sentence, trailing space included. */
function sentenceBounds(text: string): number[] {
  const bounds: number[] = [];
  const terminator = /[.!?]+(?=\s|$)/g;

  for (;;) {
    const found = terminator.exec(text);
    if (found === null) break;
    let end = found.index + found[0].length;
    while (end < text.length && /\s/.test(text[end] ?? "")) end++;
    bounds.push(end);
    terminator.lastIndex = end;
  }
  if (bounds.length === 0 || (bounds.at(-1) ?? 0) < text.length) bounds.push(text.length);

  return bounds;
}

function sitesOf(text: string, needle: string): number[] {
  const sites: number[] = [];
  let at = text.indexOf(needle);
  while (at !== -1) {
    sites.push(at);
    at = text.indexOf(needle, at + needle.length);
  }
  return sites;
}

/**
 * Grow a window around a site until the text contains it exactly once.
 *
 * A comma and a space appear a dozen times in a paragraph; the words around
 * them do not. Growing by whole words keeps the recorded key readable, which
 * matters because the key is what a reader checks the seeded corpus against.
 */
function uniqueKey(
  text: string,
  index: number,
  length: number,
  where: string,
): { readonly text: string; readonly start: number } {
  let start = index;
  let end = index + length;

  for (let step = 0; step <= MAX_KEY_GROWTH; step++) {
    const key = text.slice(start, end);
    if (occurrences(text, key) === 1) return { text: key, start };
    const grownStart = backOneWord(text, start);
    const grownEnd = forwardOneWord(text, end);
    if (grownStart === start && grownEnd === end) break;
    start = grownStart;
    end = grownEnd;
  }

  const key = text.slice(start, end);
  if (occurrences(text, key) === 1) return { text: key, start };
  throw new SeedError(`${where}: no unique key could be grown around the seed site`);
}

function backOneWord(text: string, from: number): number {
  let at = from;
  while (at > 0 && /\s/.test(text[at - 1] ?? "")) at--;
  while (at > 0 && !/\s/.test(text[at - 1] ?? "")) at--;
  return at;
}

function forwardOneWord(text: string, from: number): number {
  let at = from;
  while (at < text.length && /\s/.test(text[at] ?? "")) at++;
  while (at < text.length && !/\s/.test(text[at] ?? "")) at++;
  return at;
}

function occurrences(text: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count++;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

function words(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

function stripTerminator(word: string): string {
  return word.replace(/[.!?]+$/, "");
}

function capitalise(text: string): string {
  const first = text[0];
  return first === undefined ? text : first.toUpperCase() + text.slice(1);
}

// --- determinism ----------------------------------------------------------

export type Random = () => number;

/**
 * One small generator per rule, keyed by the seed value and the rule id.
 *
 * Keying by rule id rather than drawing from one stream means adding a rule to
 * a ruleset does not reshuffle every other rule's bases, so two runs of a
 * growing ruleset stay comparable paragraph by paragraph.
 */
export function generator(seedValue: number, ruleId: string): Random {
  let state = hash(`${seedValue}:${ruleId}`);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffled<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

function pick<T>(items: readonly T[], random: Random): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(random() * items.length) % items.length];
}
