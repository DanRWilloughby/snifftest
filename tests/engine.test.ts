import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { chunkDocument, flagsFrom, mergeFlags, runJudgmentArm, runRegexArm } from "../src/engine.ts";
import type { JevClient, JevRequest, JevResult } from "../src/jev.ts";
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

describe("runJudgmentArm", () => {
  const mixed = parseRuleset(
    readFileSync(join(here, "fixtures", "rules", "mixed.yaml"), "utf8"),
    "rules/mixed.yaml",
  );

  function client(nouls: Readonly<Record<string, number>>, seen: JevRequest[]): JevClient {
    return {
      async ask(request: JevRequest): Promise<JevResult> {
        seen.push(request);
        return {
          model: "jev-test",
          nouls,
          inputTokens: 50,
          outputTokens: 0,
          estimatedCostUsd: 50 * 0.042e-6,
          latencyMs: 7,
          attempts: 2,
        };
      },
    };
  }

  test("asks once per chunk, carrying only the judgment rules", async () => {
    const seen: JevRequest[] = [];
    const chunks = chunkDocument(text("flagged.md"), "flagged.md");

    const result = await runJudgmentArm(chunks, mixed, client({ restating_closer: 0.4 }, seen));

    expect(seen).toHaveLength(chunks.length);
    expect(Object.keys(seen[0]?.questions ?? {})).toEqual(["restating_closer"]);
    expect(result.usage.requests).toBe(chunks.length);
    expect(result.usage.inputTokens).toBe(50 * chunks.length);
    expect(result.usage.retries).toBe(chunks.length);
  });

  test("returns every reading, so a caller can calibrate below the threshold", async () => {
    const seen: JevRequest[] = [];
    const chunks = chunkDocument("A paragraph that says a thing.\n", "d.md");

    const result = await runJudgmentArm(chunks, mixed, client({ restating_closer: 0.11 }, seen));

    expect(result.readings).toEqual([
      {
        file: "d.md",
        line: 1,
        rule: "restating_closer",
        probability: 0.11,
        message: "A closer that only restates. Cut it.",
      },
    ]);
    expect(flagsFrom(result.readings, 0.7)).toEqual([]);
  });

  test("a ruleset with no judgment rules makes no request at all", async () => {
    const seen: JevRequest[] = [];
    const result = await runJudgmentArm(
      chunkDocument(text("flagged.md"), "flagged.md"),
      pair,
      client({}, seen),
    );

    expect(seen).toEqual([]);
    expect(result.readings).toEqual([]);
    expect(result.usage.requests).toBe(0);
  });

  test("flagsFrom keeps a reading at the threshold and drops the one below it", () => {
    const readings = [
      { file: "d.md", line: 1, rule: "a", probability: 0.7, message: "m" },
      { file: "d.md", line: 2, rule: "b", probability: 0.69, message: "m" },
    ];

    expect(flagsFrom(readings, 0.7)).toEqual([
      { file: "d.md", line: 1, rule: "a", kind: "judgment", probability: 0.7, message: "m" },
    ]);
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

// --- review fold-in: the merge key stays reviewable text ------------------

describe("the flag dedup key is plain text", () => {
  test("merging leaves no NUL byte anywhere in the sources", () => {
    // A NUL byte inside a template literal makes git call the whole file
    // binary, and a file git calls binary is a file nobody can review.
    const root = join(here, "..");
    const scan = (directory: string): string[] => {
      const found: string[] = [];
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...scan(path));
        else if (/\.(ts|tsx|js|mjs|json|yaml|yml|md)$/.test(entry.name)) found.push(path);
      }
      return found;
    };

    const guilty = [...scan(join(root, "src")), ...scan(join(root, "tests"))].filter((path) =>
      readFileSync(path).includes(0),
    );
    expect(guilty).toEqual([]);
  });

  test("the same file, line and rule is still one flag, and near neighbours stay apart", () => {
    const one = {
      file: "a b.md",
      line: 1,
      rule: "c",
      kind: "regex" as const,
      probability: 1,
      message: "m",
    };
    const twin = { ...one, message: "another wording of the same flag" };
    const neighbour = { ...one, file: "a", rule: "b.md 1 c" };

    const merged = mergeFlags([one, neighbour], [twin]);
    expect(merged).toHaveLength(2);
    expect(merged.map((flag) => flag.file)).toEqual(["a", "a b.md"]);
  });
});
