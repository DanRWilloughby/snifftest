import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { YamlError, parseYaml } from "../src/yaml.ts";

const fixturesDir = join(import.meta.dir, "fixtures", "rules");

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), "utf8");
}

function parseFixture(name: string): unknown {
  return parseYaml(fixture(name), `rules/${name}`);
}

function expectYamlError(fn: () => unknown): YamlError {
  try {
    fn();
  } catch (error) {
    if (error instanceof YamlError) return error;
    throw error;
  }
  throw new Error("expected a YamlError, but parsing succeeded");
}

describe("parseYaml: the supported subset", () => {
  test("reads maps, lists, scalars, block scalars and one-line flow", () => {
    const doc = parseFixture("subset.yaml") as Record<string, unknown>;

    expect(doc.version).toBe(1);
    expect(doc.threshold).toBe(0.7);
    expect(doc.enabled).toBe(true);
    expect(doc.notes).toBeNull();

    const rules = doc.rules as Record<string, unknown>[];
    expect(rules).toHaveLength(2);

    const colon = rules[0] as Record<string, unknown>;
    expect(colon.id).toBe("colon_heavy");
    expect(colon.kind).toBe("regex");
    expect(colon.builtin).toBe("colon_count");
    expect(colon.min).toBe(3);
    expect(colon.message).toBe("Three colons in one paragraph. Pick one.");
    expect(colon.seed).toEqual({ transform: "add_colons", count: 3 });

    const cost = rules[1] as Record<string, unknown>;
    expect(cost.kind).toBe("judgment");
    expect(cost.what).toBe(
      "The paragraph states what something cost to make or run\nwithout naming the price a customer pays.\n",
    );
    expect(cost.not_for).toBe("A cost quoted together with the price and a comparison.\n");
    expect(cost.examples).toEqual([
      "This report cost us $1.30 in API calls.",
      "It ran us about four dollars of compute.",
    ]);
    expect(cost.criteria).toEqual({
      true: "A production cost appears with no customer price beside it.",
      false: "Every cost figure is accompanied by the price.",
    });
    expect(cost.seed).toEqual({
      splice: ["It cost us about four dollars of compute to make this."],
    });
  });

  test("keeps mapping keys as strings, so `true:` and `false:` survive", () => {
    const doc = parseYaml("criteria:\n  true: yes it does\n  false: no it does not\n") as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(doc.criteria!)).toEqual(["true", "false"]);
  });

  test("quoted scalars stay strings and are never coerced to numbers or booleans", () => {
    const doc = parseYaml('a: "1"\nb: \'true\'\nc: 1\nd: true\ne: -2.5\n') as Record<string, unknown>;
    expect(doc.a).toBe("1");
    expect(doc.b).toBe("true");
    expect(doc.c).toBe(1);
    expect(doc.d).toBe(true);
    expect(doc.e).toBe(-2.5);
  });

  test("strips comments outside quoted scalars and keeps # inside them", () => {
    const doc = parseYaml('a: one # trailing comment\n# whole line\nb: "hash # kept"\n') as Record<
      string,
      unknown
    >;
    expect(doc.a).toBe("one");
    expect(doc.b).toBe("hash # kept");
  });

  test("keeps a literal block scalar's line breaks and honours the strip chomper", () => {
    const doc = parseYaml("a: |\n  one\n  two\nb: |-\n  kept\n") as Record<string, unknown>;
    expect(doc.a).toBe("one\ntwo\n");
    expect(doc.b).toBe("kept");
  });

  test("reads a sequence of scalars and an empty document", () => {
    expect(parseYaml("- one\n- 2\n- true\n")).toEqual(["one", 2, true]);
    expect(parseYaml("# nothing but a comment\n")).toBeNull();
  });
});

describe("parseYaml: out of subset, loudly and with a line number", () => {
  test("rejects an anchor and names the line", () => {
    const error = expectYamlError(() => parseFixture("anchor.yaml"));
    expect(error.line).toBe(2);
    expect(error.message).toBe("rules/anchor.yaml:2: anchors are not supported");
  });

  test("rejects a flow mapping that spans a line break and names the line", () => {
    const error = expectYamlError(() => parseFixture("multiline-flow.yaml"));
    expect(error.line).toBe(4);
    expect(error.message).toBe(
      "rules/multiline-flow.yaml:4: flow mappings must be written on one line",
    );
  });

  test("rejects a tab in the indentation and names the line", () => {
    const error = expectYamlError(() => parseFixture("tab-indent.yaml"));
    expect(error.line).toBe(3);
    expect(error.message).toBe(
      "rules/tab-indent.yaml:3: tabs are not allowed in indentation, use spaces",
    );
  });

  test("rejects an alias, a tag, a merge key and a second document", () => {
    expect(expectYamlError(() => parseYaml("a: *base\n")).message).toContain(
      "aliases are not supported",
    );
    expect(expectYamlError(() => parseYaml("a: !!str 7\n")).message).toContain(
      "tags are not supported",
    );
    expect(expectYamlError(() => parseYaml("a:\n  <<: b\n")).message).toContain(
      "merge keys are not supported",
    );
    expect(expectYamlError(() => parseYaml("a: 1\n---\nb: 2\n")).message).toContain(
      "multiple documents are not supported",
    );
  });

  test("rejects a duplicate key, a complex key and an unclosed flow sequence", () => {
    const duplicate = expectYamlError(() => parseYaml("a: 1\nb: 2\na: 3\n"));
    expect(duplicate.line).toBe(3);
    expect(duplicate.message).toContain('duplicate key "a"');

    expect(expectYamlError(() => parseYaml("? a\n: b\n")).message).toContain(
      "complex mapping keys are not supported",
    );
    expect(expectYamlError(() => parseYaml("a: [1, 2\n")).message).toContain(
      "flow sequences must be written on one line",
    );
  });

  test("refuses the key that would set the document's prototype", () => {
    // `result[key] = value` on a plain object invokes the prototype setter for
    // this one key, so the value arrives as configuration that no own-key walk
    // can see and no unknown-key warning mentions. Refused by name, the way a
    // merge key is, rather than arriving silently.
    const error = expectYamlError(() => parseYaml("__proto__:\n  rules: injected\nversion: 1\n"));
    expect(error.line).toBe(1);
    expect(error.message).toContain("__proto__");

    // The same key inside a flow mapping, which is a separate reader.
    expect(expectYamlError(() => parseYaml("a: {__proto__: 1}\n")).message).toContain("__proto__");
  });

  test("a document that parses keeps an ordinary prototype", () => {
    const doc = parseYaml("version: 1\nrules: []\n") as object;
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
  });

  test("refuses flow collections nested deeper than a person would write", () => {
    // Fifty thousand open brackets on one line used to recurse until the stack
    // gave out, which reaches the caller as "could not finish" rather than as a
    // named line of a named file. A ruleset in a repository somebody else wrote
    // should not be able to choose which of those two a run gets.
    const deep = `a: ${"[".repeat(50_000)}`;
    const error = expectYamlError(() => parseYaml(deep));
    expect(error.line).toBe(1);
    expect(error.message).toContain("nested");
  });

  test("a flow collection nested as deep as the limit still parses", () => {
    const nested = parseYaml(`a: ${"[".repeat(16)}${"]".repeat(16)}`) as { a: unknown };
    expect(Array.isArray(nested.a)).toBe(true);
  });

  test("rejects inconsistent indentation under a mapping", () => {
    const error = expectYamlError(() => parseYaml("a:\n  b: 1\n   c: 2\n"));
    expect(error.line).toBe(3);
    expect(error.message).toContain("unexpected indentation");
  });
});
