import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseRuleset } from "../src/rules.ts";
import { type JudgmentRule, type Rule, isJudgmentRule } from "../src/types.ts";

const RULESET_PATH = "rules/default.yaml";

function loadDefault(): ReturnType<typeof parseRuleset> {
  const source = readFileSync(join(import.meta.dir, "..", RULESET_PATH), "utf8");
  return parseRuleset(source, RULESET_PATH);
}

function spliceSeeds(rule: Rule): readonly string[] {
  const seed = rule.seed;
  return seed !== undefined && "splice" in seed ? seed.splice : [];
}

function normalise(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The closed-class words a sentence is built from.
 *
 * Two sentences that keep these in the same order and swap everything else are
 * the same sentence with new nouns in the slots. Measuring recall on one of
 * those measures whether the model recognises a shape it was handed in the
 * instruction, which is not what the number is reported as.
 */
const FUNCTION_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "did", "do", "does",
  "for", "from", "had", "has", "have", "he", "her", "his", "i", "if", "in", "is", "it", "its",
  "me", "might", "my", "never", "no", "not", "of", "on", "or", "our", "out", "she", "so",
  "some", "than", "that", "the", "their", "them", "then", "there", "they", "this", "to", "up",
  "was", "we", "were", "what", "when", "which", "who", "will", "with", "would", "you", "your",
]);

function tokens(text: string): string[] {
  return normalise(text)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "");
}

/** The function-word skeleton, with every slot emptied. */
function frame(text: string): string[] {
  return tokens(text).filter((word) => FUNCTION_WORDS.has(word));
}

/** The words that carry the subject, which are the ones a slot swap replaces. */
function content(text: string): string[] {
  return tokens(text).filter((word) => !FUNCTION_WORDS.has(word));
}

/** Shared share of the two vocabularies: shared words over the union of both. */
function overlap(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The first run of four function words the two sentences build on alike. */
function sharedFrameRun(left: string, right: string): string {
  const runs = (words: readonly string[]): Set<string> => {
    const found = new Set<string>();
    for (let i = 0; i + 4 <= words.length; i += 1) found.add(words.slice(i, i + 4).join(" "));
    return found;
  };
  const other = runs(frame(right));
  for (const run of runs(frame(left))) if (other.has(run)) return run;
  return "";
}

/** Runs of four words that carry at least one word from outside the closed class. */
function phrases(text: string): Set<string> {
  const words = tokens(text);
  const found = new Set<string>();
  for (let i = 0; i + 4 <= words.length; i += 1) {
    const run = words.slice(i, i + 4);
    if (run.some((word) => !FUNCTION_WORDS.has(word))) found.add(run.join(" "));
  }
  return found;
}

/** Everything a judgment rule sends to the model, as one string per part. */
function instructionParts(rule: JudgmentRule): { label: string; text: string }[] {
  return [
    { label: "what", text: rule.what },
    { label: "not_for", text: rule.not_for ?? "" },
    { label: "criteria.true", text: rule.criteria.true },
    { label: "criteria.false", text: rule.criteria.false },
    ...(rule.examples ?? []).map((text, index) => ({ label: `example ${index + 1}`, text })),
  ];
}

describe("rules/default.yaml", () => {
  const ruleset = loadDefault();
  const judgment = ruleset.rules.filter(isJudgmentRule);

  test("parses with the strict reader and carries fifteen rules", () => {
    expect(ruleset.version).toBe(1);
    expect(ruleset.rules).toHaveLength(15);
    expect(ruleset.rules.filter((rule) => rule.kind === "regex")).toHaveLength(5);
    expect(judgment).toHaveLength(10);
  });

  test("every rule id is unique", () => {
    const ids = ruleset.rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every rule carries a seed recipe for eval", () => {
    for (const rule of ruleset.rules) {
      expect(rule.seed, `rule "${rule.id}" has no seed`).toBeDefined();
    }
  });

  test("every judgment rule has what, not_for, examples and message", () => {
    for (const rule of judgment) {
      const where = `rule "${rule.id}"`;
      expect(rule.what.trim(), `${where} what`).not.toBe("");
      expect((rule.not_for ?? "").trim(), `${where} not_for`).not.toBe("");
      expect(rule.examples ?? [], `${where} examples`).not.toHaveLength(0);
      expect(rule.message.trim(), `${where} message`).not.toBe("");
      expect(rule.criteria.true.trim(), `${where} criteria.true`).not.toBe("");
      expect(rule.criteria.false.trim(), `${where} criteria.false`).not.toBe("");
    }
  });

  test("every judgment rule seeds by splicing at least one sentence", () => {
    for (const rule of judgment) {
      expect(spliceSeeds(rule), `rule "${rule.id}" splice`).not.toHaveLength(0);
    }
  });

  test("no splice seed equals or sits inside any example, across the whole ruleset", () => {
    // The examples travel to the model inside the instruction object, so a
    // seed that copies one would score the model on text it was just shown.
    const examples: { rule: string; text: string }[] = judgment.flatMap((rule: JudgmentRule) =>
      (rule.examples ?? []).map((text) => ({ rule: rule.id, text: normalise(text) })),
    );
    expect(examples).not.toHaveLength(0);

    for (const rule of ruleset.rules) {
      for (const seed of spliceSeeds(rule)) {
        const needle = normalise(seed);
        expect(needle).not.toBe("");
        for (const example of examples) {
          const message = `seed of "${rule.id}" overlaps an example of "${example.rule}": ${seed}`;
          expect(example.text === needle, message).toBe(false);
          expect(example.text.includes(needle), message).toBe(false);
          expect(needle.includes(example.text), message).toBe(false);
        }
      }
    }
  });

  test("no splice seed is an example with the slots refilled", () => {
    // A copy with new nouns in it passes the equality check above and is still
    // the example. Two sentences built on the same run of function words, or
    // sharing most of their vocabulary, are near enough to be one sentence.
    for (const rule of ruleset.rules) {
      for (const seed of spliceSeeds(rule)) {
        const seedFrame = frame(seed);
        for (const example of judgment.flatMap((owner: JudgmentRule) =>
          (owner.examples ?? []).map((text) => ({ rule: owner.id, text })),
        )) {
          const where = `seed of "${rule.id}" is a near-copy of an example of "${example.rule}": ${seed}`;
          const sameFrame =
            seedFrame.length >= 4 && seedFrame.join(" ") === frame(example.text).join(" ");
          expect(sameFrame, `${where} (same function-word frame)`).toBe(false);
          expect(sharedFrameRun(seed, example.text), `${where} (same four-word frame run)`).toBe("");
          expect(
            overlap(content(seed), content(example.text)),
            `${where} (shared vocabulary)`,
          ).toBeLessThan(0.5);
        }
      }
    }
  });

  test("no splice seed reuses a phrase from the instruction the model is shown", () => {
    // `what`, `not_for` and `criteria` travel with every request. A seed that
    // repeats four words of them is scoring the model on its own prompt.
    const instruction = judgment.flatMap((rule: JudgmentRule) =>
      instructionParts(rule).map((part) => ({ rule: rule.id, label: part.label, phrases: phrases(part.text) })),
    );

    for (const rule of ruleset.rules) {
      for (const seed of spliceSeeds(rule)) {
        for (const run of phrases(seed)) {
          for (const part of instruction) {
            const where = `seed of "${rule.id}" repeats "${run}" from the ${part.label} of "${part.rule}"`;
            expect(part.phrases.has(run), where).toBe(false);
          }
        }
      }
    }
  });
});

// --- seed.position --------------------------------------------------------

function spliceRule(seedBody: string): ReturnType<typeof parseRuleset> {
  return parseRuleset(
    `version: 1
rules:
  - id: closer
    kind: judgment
    what: "A restating closer."
    not_for: "A closing line that adds something."
    examples: ["In conclusion, that is the whole of it."]
    criteria:
      true: "The last line only restates."
      false: "The last line adds."
    message: "Restating closer."
    seed:
${seedBody}`,
    "position.yaml",
  );
}

function positionOf(ruleset: ReturnType<typeof parseRuleset>): string | undefined {
  const seed = ruleset.rules[0]?.seed;
  return seed !== undefined && "splice" in seed ? seed.position : undefined;
}

describe("seed.position", () => {
  test("is carried through the reader when it is given", () => {
    for (const position of ["any", "start", "end"]) {
      const parsed = spliceRule(`      splice: ["A spliced line."]\n      position: ${position}`);
      expect(positionOf(parsed)).toBe(position);
    }
  });

  test("is optional, and absent means the field is absent rather than guessed", () => {
    const parsed = spliceRule(`      splice: ["A spliced line."]`);
    expect(positionOf(parsed)).toBeUndefined();
  });

  test("is refused when it is not one of the three, naming the rule", () => {
    expect(() =>
      spliceRule(`      splice: ["A spliced line."]\n      position: middle`),
    ).toThrow(/position must be one of any, start, end/);
  });
});
