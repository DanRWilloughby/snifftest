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
