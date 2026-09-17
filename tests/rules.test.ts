import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runRegexArm } from "../src/engine.ts";
import { RulesetError, checkRegexRule, parseRuleset } from "../src/rules.ts";
import type { Chunk, JudgmentRule, RegexRule } from "../src/types.ts";

const fixturesDir = join(import.meta.dir, "fixtures", "rules");

function regexRule(extra: Partial<RegexRule>): RegexRule {
  return { id: "test_rule", kind: "regex", message: "Something smells.", ...extra };
}

function ruleset(body: string): ReturnType<typeof parseRuleset> {
  return parseRuleset(`version: 1\nrules:\n${body}`, "rules/test.yaml");
}

function chunk(text: string): Chunk {
  return { file: "draft.md", line: 1, text };
}

describe("parseRuleset", () => {
  test("reads the contract rule shape into typed regex and judgment rules", () => {
    const source = readFileSync(join(fixturesDir, "subset.yaml"), "utf8");
    const parsed = parseRuleset(source, "rules/subset.yaml");

    expect(parsed.version).toBe(1);
    expect(parsed.threshold).toBe(0.7);
    expect(parsed.rules).toHaveLength(2);

    const [colon, cost] = parsed.rules;
    expect(colon?.kind).toBe("regex");
    expect((colon as RegexRule).builtin).toBe("colon_count");
    expect((colon as RegexRule).min).toBe(3);
    expect(colon?.seed).toEqual({ transform: "add_colons", count: 3 });

    const judgment = cost as JudgmentRule;
    expect(judgment.kind).toBe("judgment");
    expect(judgment.what).toContain("The paragraph states what something cost");
    expect(judgment.not_for).toContain("A cost quoted together with the price");
    expect(judgment.examples).toHaveLength(2);
    expect(judgment.criteria.true).toContain("A production cost appears");
    expect(judgment.criteria.false).toContain("Every cost figure");
  });

  test("rejects a judgment rule whose instruction object is incomplete", () => {
    expect(() =>
      ruleset('  - id: bare\n    kind: judgment\n    message: "m"\n'),
    ).toThrow(RulesetError);

    expect(() =>
      ruleset(
        '  - id: no_false\n    kind: judgment\n    message: "m"\n    what: "A thing."\n    criteria:\n      true: "yes"\n',
      ),
    ).toThrow(/rule "no_false".*criteria\.false/);

    expect(() =>
      ruleset(
        '  - id: bad_examples\n    kind: judgment\n    message: "m"\n    what: "A thing."\n    examples: "not a list"\n    criteria:\n      true: "y"\n      false: "n"\n',
      ),
    ).toThrow(/rule "bad_examples".*examples/);
  });

  test("rejects a regex rule that names no check, two checks, or an unknown one", () => {
    expect(() => ruleset('  - id: empty\n    kind: regex\n    message: "m"\n')).toThrow(
      /rule "empty"/,
    );
    expect(() =>
      ruleset(
        '  - id: both\n    kind: regex\n    message: "m"\n    builtin: dash_present\n    pattern: "x"\n',
      ),
    ).toThrow(/rule "both"/);
    expect(() =>
      ruleset('  - id: unknown\n    kind: regex\n    message: "m"\n    builtin: nose_wrinkle\n'),
    ).toThrow(/rule "unknown".*unknown built-in/);
    expect(() =>
      ruleset('  - id: broken\n    kind: regex\n    message: "m"\n    pattern: "([a"\n'),
    ).toThrow(/rule "broken"/);
  });

  test("rejects a duplicate rule id, a missing message and an unknown kind", () => {
    expect(() =>
      ruleset(
        '  - id: a\n    kind: regex\n    message: "m"\n    builtin: dash_present\n  - id: a\n    kind: regex\n    message: "m"\n    builtin: dash_present\n',
      ),
    ).toThrow(/duplicate rule id "a"/);
    expect(() => ruleset("  - id: a\n    kind: regex\n    builtin: dash_present\n")).toThrow(
      /rule "a".*message/,
    );
    expect(() => ruleset('  - id: a\n    kind: vibes\n    message: "m"\n')).toThrow(/kind/);
    expect(() => parseRuleset("version: 2\nrules: []\n", "rules/test.yaml")).toThrow(/version/);
  });
});

describe("regex checks", () => {
  test("a rule with its own pattern reports one match per occurrence", () => {
    const rule = regexRule({ pattern: "very\\s+\\w+", flags: "i" });
    const matches = checkRegexRule(rule, "It was very good and Very fast.");
    expect(matches.map((m) => m.index)).toEqual([7, 21]);
  });

  test("dash_present catches em and en dashes but not a hyphen", () => {
    const rule = regexRule({ builtin: "dash_present" });
    expect(checkRegexRule(rule, "the window July 21–25")).toHaveLength(1);
    expect(checkRegexRule(rule, "the refusal — and I did not plan for it")).toHaveLength(1);
    expect(checkRegexRule(rule, "a prompt-to-app tool, twenty-four hours")).toHaveLength(0);
  });

  test("colon_count fires at its minimum and not below, under either spelling", () => {
    const strict = regexRule({ builtin: "colon_count", min: 3 });
    expect(checkRegexRule(strict, "one: two: three: four")).toHaveLength(1);
    expect(checkRegexRule(strict, "one: two: three")).toHaveLength(0);

    const alias = regexRule({ builtin: "colon_heavy" });
    expect(checkRegexRule(alias, "one: two: three: four")).toHaveLength(1);
  });

  test("sentence_rhythm fires when sentence lengths are too uniform", () => {
    const rule = regexRule({ builtin: "sentence_rhythm" });
    const uniform =
      "The team shipped the feature today. The team wrote the tests first. The team read the code twice. The team merged the branch later.";
    const varied =
      "We shipped. The team spent the better part of a week reading the code before anyone touched a line of it, and that turned out to be the whole trick. Then we merged. Done.";

    expect(checkRegexRule(rule, uniform)).toHaveLength(1);
    expect(checkRegexRule(rule, varied)).toHaveLength(0);
  });

  test("sentence_rhythm stays quiet when there are too few sentences to judge", () => {
    const rule = regexRule({ builtin: "sentence_rhythm" });
    expect(checkRegexRule(rule, "One short line. Another short line.")).toHaveLength(0);
  });

  test("banned_words is empty by default and matches whole words when given some", () => {
    expect(checkRegexRule(regexRule({ builtin: "banned_words" }), "synergy abounds")).toHaveLength(
      0,
    );

    const rule = regexRule({ builtin: "banned_words", words: ["synergy", "circle back"] });
    expect(checkRegexRule(rule, "Synergy means we circle back.")).toHaveLength(2);
    expect(checkRegexRule(rule, "The synergyless approach.")).toHaveLength(0);
  });

  test("slop_vocab carries a default list that a rule can replace", () => {
    const rule = regexRule({ builtin: "slop_vocab" });
    expect(checkRegexRule(rule, "We delve into the rich tapestry of the landscape.")).toHaveLength(
      3,
    );
    expect(checkRegexRule(rule, "We read the draft and cut two lines.")).toHaveLength(0);

    const narrowed = regexRule({ builtin: "slop_vocab", words: ["tapestry"] });
    expect(checkRegexRule(narrowed, "We delve into the rich tapestry.")).toHaveLength(1);
  });
});

describe("judgment rules and the regex arm", () => {
  test("a judgment rule never produces a flag from the regex arm", () => {
    const parsed = ruleset(
      '  - id: naked_cost_figure\n    kind: judgment\n    message: "A cost with no price next to it."\n    what: "A cost with no price."\n    criteria:\n      true: "y"\n      false: "n"\n',
    );

    const flags = runRegexArm([chunk("It cost us about four dollars of compute to make this.")], parsed);
    expect(flags).toEqual([]);
  });
});
