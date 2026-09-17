import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chunkDocument, mergeFlags, runRegexArm } from "../src/engine.ts";
import { parseRuleset } from "../src/rules.ts";
import type { Flag } from "../src/types.ts";

const here = import.meta.dir;

function text(name: string): string {
  return readFileSync(join(here, "fixtures", "texts", name), "utf8");
}

const pair = parseRuleset(
  readFileSync(join(here, "fixtures", "rules", "pair.yaml"), "utf8"),
  "rules/pair.yaml",
);

describe("chunkDocument", () => {
  test("splits on blank lines and records the first line of each paragraph", () => {
    const chunks = chunkDocument(text("flagged.md"), "flagged.md");

    expect(chunks.map((c) => c.line)).toEqual([1, 3, 5, 8]);
    expect(chunks[0]?.text).toBe("# Draft");
    expect(chunks[2]?.text).toContain("A second paragraph runs over two lines.\nThe refusal");
    expect(chunks.every((c) => c.file === "flagged.md")).toBe(true);
  });

  test("treats a run of blank lines as one break and ignores trailing whitespace", () => {
    const chunks = chunkDocument("one\n\n\n\ntwo\n   \n", "d.md");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ file: "d.md", line: 1, text: "one" });
    expect(chunks[1]).toEqual({ file: "d.md", line: 5, text: "two" });
  });

  test("returns nothing for an empty document", () => {
    expect(chunkDocument("", "d.md")).toEqual([]);
    expect(chunkDocument("\n\n   \n", "d.md")).toEqual([]);
  });

  test("splits an over-long paragraph on sentence boundaries at the cap", () => {
    const sentence = "This sentence is exactly long enough to matter here. ";
    const chunks = chunkDocument(sentence.repeat(6).trim(), "d.md", { maxChars: 120 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 120)).toBe(true);
    expect(chunks.every((c) => c.line === 1)).toBe(true);
    expect(chunks.map((c) => c.text).join(" ")).toBe(sentence.repeat(6).trim());
  });
});

describe("runRegexArm", () => {
  test("a flag carries file, line, rule, kind, probability 1 and the rule message", () => {
    const flags = runRegexArm(chunkDocument(text("flagged.md"), "flagged.md"), pair);

    expect(flags).toEqual([
      {
        file: "flagged.md",
        line: 6,
        rule: "dash_present",
        kind: "regex",
        probability: 1,
        message: "An em dash. Say it in two sentences.",
      },
      {
        file: "flagged.md",
        line: 8,
        rule: "colon_heavy",
        kind: "regex",
        probability: 1,
        message: "Three colons in one paragraph. Pick one.",
      },
    ] satisfies Flag[]);
  });

  test("three colons trip colon_heavy and an em dash trips dash_present", () => {
    const flags = runRegexArm(chunkDocument(text("flagged.md"), "flagged.md"), pair);
    expect(flags.map((f) => f.rule)).toEqual(["dash_present", "colon_heavy"]);
  });

  test("a draft with no defects yields zero flags", () => {
    expect(runRegexArm(chunkDocument(text("clean.md"), "clean.md"), pair)).toEqual([]);
  });

  test("reports one flag per occurrence but never two on the same line for one rule", () => {
    const chunks = chunkDocument("A — dash and another — dash on one line.\n", "d.md");
    const flags = runRegexArm(chunks, pair);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.line).toBe(1);
  });
});

describe("mergeFlags", () => {
  const flag = (line: number, rule: string, file = "a.md"): Flag => ({
    file,
    line,
    rule,
    kind: "regex",
    probability: 1,
    message: "m",
  });

  test("sorts by file, then line, then rule, and drops exact duplicates", () => {
    const merged = mergeFlags(
      [flag(9, "b"), flag(1, "z", "b.md")],
      [flag(9, "a"), flag(9, "b"), flag(2, "a")],
    );

    expect(merged.map((f) => `${f.file}:${f.line}:${f.rule}`)).toEqual([
      "a.md:2:a",
      "a.md:9:a",
      "a.md:9:b",
      "b.md:1:z",
    ]);
  });
});
