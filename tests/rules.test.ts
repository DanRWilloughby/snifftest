import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runRegexArm } from "../src/engine.ts";
import { PATTERN_TEXT_CAP, RulesetError, checkRegexRule, parseRuleset } from "../src/rules.ts";
import type { BuiltinRule, Chunk, JudgmentRule, PatternRule } from "../src/types.ts";

const fixturesDir = join(import.meta.dir, "fixtures", "rules");

function builtinRule(builtin: string, extra: Partial<Omit<BuiltinRule, "source">> = {}): BuiltinRule {
  return {
    id: "test_rule",
    kind: "regex",
    message: "Something smells.",
    source: "builtin",
    builtin,
    ...extra,
  };
}

function patternRule(pattern: string, flags?: string): PatternRule {
  return {
    id: "test_rule",
    kind: "regex",
    message: "Something smells.",
    source: "pattern",
    pattern,
    ...(flags === undefined ? {} : { flags }),
  };
}

function ruleset(body: string): ReturnType<typeof parseRuleset> {
  return parseRuleset(`version: 1\nrules:\n${body}`, "rules/test.yaml");
}

function chunk(text: string, kind: Chunk["kind"] = "prose"): Chunk {
  return { file: "draft.md", line: 1, text, kind };
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
    const builtin = colon as BuiltinRule;
    expect(builtin.source).toBe("builtin");
    expect(builtin.builtin).toBe("colon_count");
    expect(builtin.min).toBe(3);
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
    expect(() =>
      ruleset(
        '  - id: flagged_builtin\n    kind: regex\n    message: "m"\n    builtin: dash_present\n    flags: "i"\n',
      ),
    ).toThrow(/rule "flagged_builtin".*flags belong to a pattern/);
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
    const rule = patternRule("very\\s+\\w+", "i");
    const matches = checkRegexRule(rule, "It was very good and Very fast.");
    expect(matches.map((m) => m.index)).toEqual([7, 21]);
  });

  test("dash_present catches a prose dash but not a hyphen", () => {
    const rule = builtinRule("dash_present");
    expect(checkRegexRule(rule, "the refusal \u2014 and I did not plan for it")).toHaveLength(1);
    expect(checkRegexRule(rule, "the window \u2013 as we planned it")).toHaveLength(1);
    expect(checkRegexRule(rule, "a prompt-to-app tool, twenty-four hours")).toHaveLength(0);
  });

  test("dash_present leaves a number range alone, because a range is not a dash for effect", () => {
    const rule = builtinRule("dash_present");
    expect(checkRegexRule(rule, "pages 10\u201320 and the years 2019\u20132024")).toHaveLength(0);
    // The em dash is never a range, so it is still a flag between numerals.
    expect(checkRegexRule(rule, "pages 10\u201420")).toHaveLength(1);
  });

  test("colon_count fires at its minimum and not below, under either spelling", () => {
    const strict = builtinRule("colon_count", { min: 3 });
    expect(checkRegexRule(strict, "one: two: three: four")).toHaveLength(1);
    expect(checkRegexRule(strict, "one: two: three")).toHaveLength(0);

    const alias = builtinRule("colon_heavy");
    expect(checkRegexRule(alias, "one: two: three: four")).toHaveLength(1);
  });

  test("sentence_rhythm fires when sentence lengths are too uniform", () => {
    const rule = builtinRule("sentence_rhythm");
    const uniform = new Array(6)
      .fill("The team shipped the feature on the Tuesday of that particular week.")
      .join(" ");
    const varied =
      "We shipped. The team spent the better part of a week reading the code before anyone touched a line of it, and that turned out to be the whole trick. Then we merged. Done.";

    expect(checkRegexRule(rule, uniform)).toHaveLength(1);
    expect(checkRegexRule(rule, varied)).toHaveLength(0);
  });

  test("sentence_rhythm stays quiet on a short status paragraph", () => {
    const rule = builtinRule("sentence_rhythm");
    const status =
      "We shipped the fix on Tuesday morning. The build went green at noon. " +
      "The release went out at four. Nobody noticed a thing.";

    expect(checkRegexRule(rule, status)).toHaveLength(0);
    expect(checkRegexRule(builtinRule("sentence_rhythm", { min_words: 10 }), status)).toHaveLength(1);
  });

  test("sentence_rhythm stays quiet when there are too few sentences to judge", () => {
    const rule = builtinRule("sentence_rhythm");
    expect(checkRegexRule(rule, "One short line. Another short line.")).toHaveLength(0);
  });

  test("banned_words is empty by default and matches whole words when given some", () => {
    expect(checkRegexRule(builtinRule("banned_words"), "synergy abounds")).toHaveLength(0);

    const rule = builtinRule("banned_words", { words: ["synergy", "circle back"] });
    expect(checkRegexRule(rule, "Synergy means we circle back.")).toHaveLength(2);
    expect(checkRegexRule(rule, "The synergyless approach.")).toHaveLength(0);
  });

  test("slop_vocab carries a default list that a rule can replace", () => {
    const rule = builtinRule("slop_vocab");
    expect(checkRegexRule(rule, "We delve into the rich tapestry of the landscape.")).toHaveLength(
      3,
    );
    expect(checkRegexRule(rule, "We read the draft and cut two lines.")).toHaveLength(0);

    const narrowed = builtinRule("slop_vocab", { words: ["tapestry"] });
    expect(checkRegexRule(narrowed, "We delve into the rich tapestry.")).toHaveLength(1);
  });

  test("slop_vocab matches the inflections its own description promises", () => {
    const rule = builtinRule("slop_vocab");
    const inflected = [
      "He delves into it.",
      "It runs seamlessly.",
      "She is navigating the release.",
      "They keep showcasing the same three slides.",
      "Unlocking the next stage took a week.",
      "The realms overlapped.",
      "A pivotal week.",
    ];
    for (const line of inflected) {
      expect(checkRegexRule(rule, line)).toHaveLength(1);
    }

    // The promise is the stem plus ordinary suffixes, not every derivation
    // English can build. "intricacies" is a different word and is not caught.
    expect(checkRegexRule(rule, "The intricacies were the point.")).toHaveLength(0);
  });

  test("slop_vocab leaves a listed word alone where it is doing its literal job", () => {
    const rule = builtinRule("slop_vocab");
    expect(checkRegexRule(rule, "Her sister is a landscape architect in Leeds.")).toHaveLength(0);
    expect(checkRegexRule(rule, "Navigate to the folder and open it.")).toHaveLength(0);
    expect(checkRegexRule(rule, "Unlock the door before the delivery arrives.")).toHaveLength(0);

    // The exception is the phrase, not the word: the word alone still counts.
    expect(checkRegexRule(rule, "The landscape of the market shifted.")).toHaveLength(1);
  });

  test("a rule may replace the exception list with its own", () => {
    const rule = builtinRule("slop_vocab", { words: ["delve"], except: [] });
    expect(checkRegexRule(rule, "Her sister is a landscape architect.")).toHaveLength(0);

    const strict = builtinRule("slop_vocab", { words: ["landscape"], except: [] });
    expect(checkRegexRule(strict, "Her sister is a landscape architect.")).toHaveLength(1);
  });

  test("a word that merely contains a listed stem is not a match", () => {
    const rule = builtinRule("slop_vocab", { words: ["realm"] });
    expect(checkRegexRule(rule, "The overwhelming majority agreed.")).toHaveLength(0);
  });
});

describe("a hostile pattern is refused when the ruleset is read", () => {
  // A ruleset supplies regular expressions that run on your machine, and a
  // repository you cloned supplies both the pattern and the paragraph that
  // detonates it. `^(a+)+$` against forty characters took half a second here;
  // fifty never returned. Nothing in JavaScript can interrupt a regex once it
  // starts, so the only place to stop this is before it runs.
  function reading(pattern: string): () => unknown {
    return () =>
      ruleset(`  - id: hostile\n    kind: regex\n    pattern: "${pattern}"\n    message: "m"\n`);
  }

  test("the report's own pattern never gets as far as a paragraph", () => {
    expect(reading("^(a+)+$")).toThrow(RulesetError);
    expect(reading("^(a+)+$")).toThrow(/nests quantifiers/);
  });

  test("the shapes that backtrack exponentially are refused together", () => {
    for (const pattern of ["(a+)+", "(a*)*", "(a?)*", "(?:x|y+)+", "((b+))+", "(\\d{2,4})+"]) {
      expect(reading(pattern)).toThrow(RulesetError);
    }
  });

  test("ordinary patterns are not caught by it", () => {
    for (const pattern of [
      "\\bhowever\\b",
      "(?:foo|bar)+",
      "(\\d{4})?",
      "(\\d{4})+",
      "[a-z]+\\s*,\\s*[a-z]+",
      "^\\s*> ",
      "colou?r",
    ]) {
      expect(reading(pattern)).not.toThrow();
    }
  });

  test("the ruleset that ships passes its own check", () => {
    const source = readFileSync(join(import.meta.dir, "..", "rules", "default.yaml"), "utf8");
    expect(() => parseRuleset(source, "rules/default.yaml")).not.toThrow();
  });

  test("a pattern reads a bounded amount of one paragraph", () => {
    // The second layer, for the shapes a static check cannot name. It is a
    // bound on the cost, and it is reported rather than silent.
    const rule = patternRule("x$");
    const long = `${"a".repeat(PATTERN_TEXT_CAP + 10)}x`;

    expect(checkRegexRule(rule, long)).toHaveLength(0);
    expect(checkRegexRule(rule, "ax")).toHaveLength(1);
  });

  test("a capped paragraph says so, once, and still reports its flags", () => {
    const parsed = ruleset('  - id: needle\n    kind: regex\n    pattern: "needle"\n    message: "m"\n');
    const notes: string[] = [];
    const long = `needle ${"a".repeat(PATTERN_TEXT_CAP + 10)}`;

    const flags = runRegexArm([chunk(long)], parsed, (line) => notes.push(line));

    expect(flags).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(String(PATTERN_TEXT_CAP));
    expect(notes[0]).toContain("needle");
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
