import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  chunkDocument,
  classifyChunk,
  flagsFrom,
  isProseLike,
  mergeFlags,
  runJudgmentArm,
  runRegexArm,
} from "../src/engine.ts";
import type { JevClient, JevRequest, JevResult } from "../src/jev.ts";
import { parseRuleset } from "../src/rules.ts";
import type { Flag } from "../src/types.ts";

const here = import.meta.dir;

function text(name: string): string {
  return readFileSync(join(here, "fixtures", "texts", name), "utf8");
}

const mixedRules = parseRuleset(
  readFileSync(join(here, "fixtures", "rules", "mixed.yaml"), "utf8"),
  "rules/mixed.yaml",
);

const pair = parseRuleset(
  readFileSync(join(here, "fixtures", "rules", "pair.yaml"), "utf8"),
  "rules/pair.yaml",
);

/** The shipped ruleset, so the shapes are checked against what people get. */
const defaults = parseRuleset(
  readFileSync(join(here, "..", "rules", "default.yaml"), "utf8"),
  "rules/default.yaml",
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
    expect(chunks[0]).toEqual({ file: "d.md", line: 1, text: "one", kind: "prose" });
    expect(chunks[1]).toEqual({ file: "d.md", line: 5, text: "two", kind: "prose" });
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

describe("what a block is", () => {
  const structure = text("structure.md");
  const chunks = chunkDocument(structure, "structure.md");

  test("every Markdown shape is named for what it is", () => {
    expect(chunks.map((c) => c.kind)).toEqual([
      "front_matter",
      "heading",
      "html_comment",
      "table",
      "list",
      "block_quote",
      "prose",
      "prose",
      "prose",
      "prose",
      "link_definition",
    ]);
  });

  test("only writing is worth a paid question", () => {
    expect(chunks.filter(isProseLike).map((c) => c.kind)).toEqual([
      "list",
      "block_quote",
      "prose",
      "prose",
      "prose",
      "prose",
    ]);
  });

  test("a list too short to hold a sentence is not asked about", () => {
    const [short] = chunkDocument("- one\n- two\n- three\n", "d.md");
    expect(short?.kind).toBe("list");
    expect(short === undefined ? true : isProseLike(short)).toBe(false);
  });

  test("three dashes in the middle of a file are a break, not front matter", () => {
    expect(classifyChunk("---\nname: x\n---", 40)).toBe("prose");
    expect(classifyChunk("---\nname: x\n---", 1)).toBe("front_matter");
  });

  test("the default ruleset stays quiet on every one of those shapes", () => {
    expect(runRegexArm(chunks, defaults)).toEqual([]);
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
    const chunks = chunkDocument("A \u2014 dash and another \u2014 dash on one line.\n", "d.md");
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
          usageReported: true,
          latencyMs: 7,
          attempts: 2,
        };
      },
    };
  }

  test("asks once per chunk, carrying only the judgment rules", async () => {
    const seen: JevRequest[] = [];
    const chunks = chunkDocument(text("flagged.md"), "flagged.md");

    const prose = chunks.filter(isProseLike);
    const result = await runJudgmentArm(chunks, mixed, client({ restating_closer: 0.11 }, seen));

    expect(prose.length).toBeLessThan(chunks.length);
    expect(seen).toHaveLength(prose.length);
    expect(Object.keys(seen[0]?.questions ?? {})).toEqual(["restating_closer"]);
    expect(result.usage.requests).toBe(prose.length);
    expect(result.usage.inputTokens).toBe(50 * prose.length);
    expect(result.usage.retries).toBe(prose.length);
    expect(result.tally.structure).toBe(chunks.length - prose.length);
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
        noJudgment: false,
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
      { file: "d.md", line: 1, rule: "a", probability: 0.7, message: "m", noJudgment: false },
      { file: "d.md", line: 2, rule: "b", probability: 0.69, message: "m", noJudgment: false },
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

// --- fenced code is not prose ---------------------------------------------

describe("fenced code blocks", () => {
  const FENCED = [
    "A paragraph of prose before the snippet.",
    "",
    "```yaml",
    "one: two",
    "three: four",
    "five: six",
    "```",
    "",
    "A paragraph of prose after it, on line nine.",
    "",
  ].join("\n");

  test("the fence, its info string and its contents are in no chunk", () => {
    const chunks = chunkDocument(FENCED, "d.md");

    expect(chunks.map((c) => c.text)).toEqual([
      "A paragraph of prose before the snippet.",
      "A paragraph of prose after it, on line nine.",
    ]);
  });

  test("prose after a fence keeps the line it is actually on", () => {
    const chunks = chunkDocument(FENCED, "d.md");
    expect(chunks.map((c) => c.line)).toEqual([1, 9]);
  });

  test("a snippet's colons do not trip a countable rule", () => {
    expect(runRegexArm(chunkDocument(FENCED, "d.md"), pair)).toEqual([]);
  });

  test("the same colons in prose still trip it", () => {
    const prose = "one: two, three: four, five: six, and that is three colons in prose.\n";
    expect(runRegexArm(chunkDocument(prose, "d.md"), pair).map((f) => f.rule)).toEqual([
      "colon_heavy",
    ]);
  });

  test("a snippet is never sent to the judgment arm", async () => {
    const seen: JevRequest[] = [];
    const chunks = chunkDocument(FENCED, "d.md");
    await runJudgmentArm(chunks, mixedRules, {
      async ask(request: JevRequest): Promise<JevResult> {
        seen.push(request);
        return {
          model: "jev-test",
          nouls: {},
          inputTokens: 1,
          outputTokens: 0,
          estimatedCostUsd: 0,
          usageReported: true,
          latencyMs: 1,
          attempts: 1,
        };
      },
    });

    expect(seen).toHaveLength(2);
    for (const request of seen) expect(String(request.state)).not.toContain("one: two");
  });

  test("a tilde fence, a longer closing fence and an indented fence all close properly", () => {
    const document = [
      "Prose one.",
      "~~~",
      "a: b: c: d",
      "~~~~",
      "Prose two.",
      "",
      "  ```sh",
      "  echo a: b: c:",
      "  ```",
      "",
      "Prose three, on line eleven.",
    ].join("\n");

    const chunks = chunkDocument(document, "d.md");
    expect(chunks.map((c) => c.text)).toEqual(["Prose one.", "Prose two.", "Prose three, on line eleven."]);
    expect(chunks.map((c) => c.line)).toEqual([1, 5, 11]);
    expect(runRegexArm(chunks, pair)).toEqual([]);
  });

  test("a backtick fence is not closed by a tilde one, and an unclosed fence runs to the end", () => {
    const document = ["Prose one.", "", "```", "a: b: c:", "~~~", "still code: here:", ""].join("\n");
    const chunks = chunkDocument(document, "d.md");

    expect(chunks.map((c) => c.text)).toEqual(["Prose one."]);
    expect(runRegexArm(chunks, pair)).toEqual([]);
  });

  test("a fence between two paragraphs with no blank line still splits them cleanly", () => {
    const document = ["Prose one.", "```", "x: y: z:", "```", "Prose two."].join("\n");
    const chunks = chunkDocument(document, "d.md");

    expect(chunks).toEqual([
      { file: "d.md", line: 1, text: "Prose one.", kind: "prose" },
      { file: "d.md", line: 5, text: "Prose two.", kind: "prose" },
    ]);
  });
});

// --- a fence is still a fence inside its container -------------------------

describe("fences inside a list item", () => {
  const LIST = [
    "A paragraph before the list.",
    "",
    "- The first item, which explains the snippet below.",
    "",
    "    ```yaml",
    "    one: two",
    "    three: four",
    "    five: six",
    "    ```",
    "",
    "- The second item, on line eleven.",
    "",
  ].join("\n");

  test("the snippet reaches neither arm", () => {
    const chunks = chunkDocument(LIST, "d.md");

    expect(chunks.map((c) => c.text)).toEqual([
      "A paragraph before the list.",
      "- The first item, which explains the snippet below.",
      "- The second item, on line eleven.",
    ]);
    expect(runRegexArm(chunks, pair)).toEqual([]);
  });

  test("the list prose keeps the line it is written on", () => {
    expect(chunkDocument(LIST, "d.md").map((c) => c.line)).toEqual([1, 3, 11]);
  });

  test("an ordered marker sets the content column the same way", () => {
    const document = [
      "1. The first step.",
      "",
      "    ```sh",
      "    echo a: b: c:",
      "    ```",
      "",
      "2. The second step, on line seven.",
    ].join("\n");

    const chunks = chunkDocument(document, "d.md");
    expect(chunks.map((c) => c.text)).toEqual(["1. The first step.", "2. The second step, on line seven."]);
    expect(chunks.map((c) => c.line)).toEqual([1, 7]);
  });

  test("the closing fence has to be at the item's own depth", () => {
    // The closing row is written at the left margin, outside the item, so the
    // block stays open and everything after it is code, which is what a reader
    // sees too.
    const document = [
      "- An item.",
      "",
      "    ```",
      "    a: b: c:",
      "```",
      "",
      "Prose that is still inside the block.",
    ].join("\n");

    expect(chunkDocument(document, "d.md").map((c) => c.text)).toEqual(["- An item."]);
  });

  test("four spaces with no list marker above them are still prose", () => {
    // The documented scope-out. An indented run with no fence is as often a
    // quotation as it is code, and this rule must not start eating it.
    const document = [
      "A paragraph.",
      "",
      "    one: two: three: four",
      "",
      "Another paragraph.",
    ].join("\n");

    const chunks = chunkDocument(document, "d.md");
    expect(chunks.map((c) => c.text)).toEqual([
      "A paragraph.",
      "    one: two: three: four",
      "Another paragraph.",
    ]);
    expect(runRegexArm(chunks, pair).map((f) => f.rule)).toEqual(["colon_heavy"]);
  });

  test("a fence at four spaces with no list above it is not a fence either", () => {
    const document = ["A paragraph.", "", "    ```", "    a: b: c:", "    ```", ""].join("\n");
    // Nothing opened a list, so this is an indented block, and the scope-out
    // says an indented block stays prose: three lines with no blank between
    // them, which is one paragraph.
    expect(chunkDocument(document, "d.md").map((c) => c.text)).toEqual([
      "A paragraph.",
      "    ```\n    a: b: c:\n    ```",
    ]);
  });

  test("a list that has closed no longer lends its indent to a fence", () => {
    const document = [
      "- An item.",
      "",
      "A paragraph at the margin, which closes the list.",
      "",
      "    ```",
      "    a: b: c:",
      "    ```",
      "",
    ].join("\n");

    const chunks = chunkDocument(document, "d.md");
    expect(chunks.map((c) => c.text)).toEqual([
      "- An item.",
      "A paragraph at the margin, which closes the list.",
      "    ```\n    a: b: c:\n    ```",
    ]);
  });
});

describe("fences inside a block quote", () => {
  const QUOTED = [
    "> A quoted paragraph before the snippet.",
    "",
    "> ```yaml",
    "> one: two",
    "> three: four",
    "> five: six",
    "> ```",
    "",
    "> Quoted prose after the fence closes, on line nine.",
    "",
  ].join("\n");

  test("the snippet reaches neither arm and the quoted prose survives", () => {
    const chunks = chunkDocument(QUOTED, "d.md");

    expect(chunks.map((c) => c.text)).toEqual([
      "> A quoted paragraph before the snippet.",
      "> Quoted prose after the fence closes, on line nine.",
    ]);
    expect(chunks.map((c) => c.line)).toEqual([1, 9]);
    expect(runRegexArm(chunks, pair)).toEqual([]);
  });

  test("a nested quote holds its own fence", () => {
    const document = [
      "> > A doubly quoted line.",
      "",
      "> > ```",
      "> > a: b: c:",
      "> > ```",
      "",
      "> > The last quoted line, on line seven.",
    ].join("\n");

    const chunks = chunkDocument(document, "d.md");
    expect(chunks.map((c) => c.text)).toEqual([
      "> > A doubly quoted line.",
      "> > The last quoted line, on line seven.",
    ]);
    expect(chunks.map((c) => c.line)).toEqual([1, 7]);
  });

  test("a row of backticks outside the quote does not close the block inside it", () => {
    const document = [
      "> A quoted line.",
      "",
      "> ```",
      "> a: b: c:",
      "```",
      "> still inside: the: block:",
      "",
    ].join("\n");

    expect(chunkDocument(document, "d.md").map((c) => c.text)).toEqual(["> A quoted line."]);
  });

  test("a quoted fence does not swallow the prose that follows the quote", () => {
    const document = [
      "> ```",
      "> a: b: c:",
      "> ```",
      "",
      "Ordinary prose after the quote, with three: colons: in: it.",
    ].join("\n");

    const chunks = chunkDocument(document, "d.md");
    expect(chunks.map((c) => c.text)).toEqual([
      "Ordinary prose after the quote, with three: colons: in: it.",
    ]);
    expect(runRegexArm(chunks, pair).map((f) => f.rule)).toEqual(["colon_heavy"]);
  });

  test("a fence inside a list inside a quote is recognised too", () => {
    const document = [
      "> - An item in a quoted list.",
      ">     ```",
      ">     a: b: c:",
      ">     ```",
      "",
      "> The last quoted line, on line six.",
    ].join("\n");

    // Both containers at once: the quote marker comes off, and what is left is
    // four spaces under a list marker, which the ordinary rule would refuse.
    const chunks = chunkDocument(document, "d.md");
    expect(chunks.map((c) => c.text)).toEqual([
      "> - An item in a quoted list.",
      "> The last quoted line, on line six.",
    ]);
    expect(chunks.map((c) => c.line)).toEqual([1, 6]);
  });
});

describe("inline code spans", () => {
  test("the countable rules ignore what is inside them", () => {
    const document = "Set `a: b: c:` in the file, and that is the only colon-ish thing here.\n";
    expect(runRegexArm(chunkDocument(document, "d.md"), pair)).toEqual([]);
  });

  test("an em dash inside a span is code, not prose", () => {
    expect(runRegexArm(chunkDocument("Run `printf a \u2014 b` and stop.\n", "d.md"), pair)).toEqual([]);
    expect(runRegexArm(chunkDocument("Run printf a \u2014 b and stop.\n", "d.md"), pair)).toHaveLength(1);
  });

  test("a span does not shift the line a later flag is reported on", () => {
    const document = "Prose with `a: b:` in it.\nA second line \u2014 with a dash.\n";
    const flags = runRegexArm(chunkDocument(document, "d.md"), pair);

    expect(flags).toHaveLength(1);
    expect(flags[0]?.line).toBe(2);
  });

  test("the judgment arm still sees the span, contents and all", async () => {
    const seen: JevRequest[] = [];
    const chunks = chunkDocument("Prose with `a: b:` in it.\n", "d.md");
    await runJudgmentArm(chunks, mixedRules, {
      async ask(request: JevRequest): Promise<JevResult> {
        seen.push(request);
        return {
          model: "jev-test",
          nouls: {},
          inputTokens: 1,
          outputTokens: 0,
          estimatedCostUsd: 0,
          usageReported: true,
          latencyMs: 1,
          attempts: 1,
        };
      },
    });

    expect(String(seen[0]?.state)).toBe("Prose with `a: b:` in it.");
  });

  test("an unmatched backtick is ordinary prose", () => {
    const document = "A stray ` backtick: and then: two more: colons.\n";
    expect(runRegexArm(chunkDocument(document, "d.md"), pair).map((f) => f.rule)).toEqual([
      "colon_heavy",
    ]);
  });
});
