import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, PROJECT_RULES_FILE, resolveRuleset, selectRules } from "../src/config.ts";
import type { BuiltinRule } from "../src/types.ts";

const temporary: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-config-"));
  temporary.push(dir);
  return dir;
}

function write(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const DEFAULT_RULES = `version: 1
threshold: 0.7
rules:
  - id: dash_present
    kind: regex
    builtin: dash_present
    message: "An em dash. Say it in two sentences."
  - id: colon_heavy
    kind: regex
    builtin: colon_count
    min: 3
    message: "Three colons in one paragraph. Pick one."
`;

const PROJECT_RULES = `version: 1
rules:
  - id: banned_words
    kind: regex
    builtin: banned_words
    words: ["synergy"]
    message: "Say the thing instead."
`;

describe("resolveRuleset discovery order", () => {
  test("--rules wins over a project file and over the packaged default", () => {
    const dir = sandbox();
    write(dir, PROJECT_RULES_FILE, PROJECT_RULES);
    const named = write(dir, "house.yaml", PROJECT_RULES.replace("banned_words", "house_words"));
    const fallback = write(dir, "packaged.yaml", DEFAULT_RULES);

    const resolved = resolveRuleset({
      cwd: dir,
      rulesPath: "house.yaml",
      defaultRulesPath: fallback,
    });

    expect(resolved.ruleset.rules.map((rule) => rule.id)).toEqual(["house_words"]);
    expect(resolved.sources).toEqual([named]);
  });

  test("a project file in the working directory wins over the packaged default", () => {
    const dir = sandbox();
    const project = write(dir, PROJECT_RULES_FILE, PROJECT_RULES);
    const fallback = write(dir, "packaged.yaml", DEFAULT_RULES);

    const resolved = resolveRuleset({ cwd: dir, defaultRulesPath: fallback });

    expect(resolved.ruleset.rules.map((rule) => rule.id)).toEqual(["banned_words"]);
    expect(resolved.sources).toEqual([project]);
  });

  test("the packaged default is used when nothing else is there", () => {
    const dir = sandbox();
    const fallback = write(dir, "packaged.yaml", DEFAULT_RULES);

    const resolved = resolveRuleset({ cwd: dir, defaultRulesPath: fallback });

    expect(resolved.ruleset.rules.map((rule) => rule.id)).toEqual(["dash_present", "colon_heavy"]);
    expect(resolved.ruleset.threshold).toBe(0.7);
  });
});

describe("resolveRuleset extends", () => {
  test("extends: default merges rule by id, keeping base order and appending new rules", () => {
    const dir = sandbox();
    const fallback = write(dir, "packaged.yaml", DEFAULT_RULES);
    write(
      dir,
      PROJECT_RULES_FILE,
      `version: 1
extends: default
threshold: 0.9
rules:
  - id: colon_heavy
    kind: regex
    builtin: colon_count
    min: 5
    message: "Five colons. Really?"
  - id: banned_words
    kind: regex
    builtin: banned_words
    words: ["synergy"]
    message: "Say the thing instead."
`,
    );

    const resolved = resolveRuleset({ cwd: dir, defaultRulesPath: fallback });
    const ids = resolved.ruleset.rules.map((rule) => rule.id);
    const colon = resolved.ruleset.rules.find((rule) => rule.id === "colon_heavy") as BuiltinRule;

    expect(ids).toEqual(["dash_present", "colon_heavy", "banned_words"]);
    expect(colon.min).toBe(5);
    expect(colon.message).toBe("Five colons. Really?");
    expect(resolved.ruleset.threshold).toBe(0.9);
    expect(resolved.sources).toEqual([join(dir, PROJECT_RULES_FILE), fallback]);
  });

  test("a base threshold survives when the extending file names none", () => {
    const dir = sandbox();
    const fallback = write(dir, "packaged.yaml", DEFAULT_RULES);
    write(dir, PROJECT_RULES_FILE, "version: 1\nextends: default\nrules: []\n");

    expect(resolveRuleset({ cwd: dir, defaultRulesPath: fallback }).ruleset.threshold).toBe(0.7);
  });

  test("extends resolves a relative path against the file that wrote it", () => {
    const dir = sandbox();
    write(dir, "shared/base.yaml", DEFAULT_RULES);
    write(dir, "team/house.yaml", "version: 1\nextends: ../shared/base.yaml\nrules: []\n");

    const resolved = resolveRuleset({ cwd: dir, rulesPath: "team/house.yaml" });

    expect(resolved.ruleset.rules.map((rule) => rule.id)).toEqual(["dash_present", "colon_heavy"]);
  });

  test("a cycle in extends is refused by name rather than followed", () => {
    const dir = sandbox();
    write(dir, "a.yaml", "version: 1\nextends: b.yaml\nrules: []\n");
    write(dir, "b.yaml", "version: 1\nextends: a.yaml\nrules: []\n");

    expect(() => resolveRuleset({ cwd: dir, rulesPath: "a.yaml" })).toThrow(/extends.*circle|circle/i);
  });
});

describe("resolveRuleset failures", () => {
  test("a named ruleset that is not there fails with the path it looked for", () => {
    const dir = sandbox();
    expect(() => resolveRuleset({ cwd: dir, rulesPath: "nope.yaml" })).toThrow(ConfigError);
    expect(() => resolveRuleset({ cwd: dir, rulesPath: "nope.yaml" })).toThrow(/nope\.yaml/);
  });

  test("no project file and no packaged default points the reader at --rules", () => {
    const dir = sandbox();
    expect(() => resolveRuleset({ cwd: dir, defaultRulesPath: join(dir, "absent.yaml") })).toThrow(
      /--rules/,
    );
  });

  test("a ruleset outside the YAML subset keeps its line number", () => {
    const dir = sandbox();
    write(dir, "bad.yaml", "version: 1\nrules:\n\t- id: a\n");
    expect(() => resolveRuleset({ cwd: dir, rulesPath: "bad.yaml" })).toThrow(/bad\.yaml:3/);
  });
});

describe("which rules a run uses, once tags are read", () => {
  const tagged = parseTagged();

  function parseTagged(): ReturnType<typeof resolveRuleset>["ruleset"] {
    const dir = sandbox();
    write(
      dir,
      "tagged.yaml",
      [
        "version: 1",
        "off_by_default: [marketing]",
        "rules:",
        "  - id: dash_present",
        "    kind: regex",
        "    builtin: dash_present",
        '    message: "A long dash."',
        "  - id: first_x_that",
        "    kind: regex",
        "    builtin: dash_present",
        "    tags: [marketing]",
        '    message: "The first X that."',
        "",
      ].join("\n"),
    );
    return resolveRuleset({ cwd: dir, rulesPath: "tagged.yaml" }).ruleset;
  }

  function ids(ruleset: Parameters<typeof selectRules>[0], selection?: Parameters<typeof selectRules>[1]): string[] {
    return selectRules(ruleset, selection).ruleset.rules.map((rule) => rule.id);
  }

  test("a tag the ruleset sits out does not run, and says which tag kept it out", () => {
    const selected = selectRules(tagged);
    expect(selected.ruleset.rules.map((rule) => rule.id)).toEqual(["dash_present"]);
    expect(selected.dropped).toEqual([
      { rule: "first_x_that", reason: 'the tag "marketing" is off by default' },
    ]);
  });

  test("--only marketing asks for the tag by name, which is how it is switched on", () => {
    expect(ids(tagged, { only: ["marketing"] })).toEqual(["first_x_that"]);
  });

  test("--skip takes a tag out even when nothing sits out by default", () => {
    const everything = { ...tagged, off_by_default: [] };
    expect(ids(everything)).toEqual(["dash_present", "first_x_that"]);
    expect(ids(everything, { skip: ["marketing"] })).toEqual(["dash_present"]);
  });

  test("--skip wins over --only when a tag is named in both", () => {
    expect(ids(tagged, { only: ["marketing"], skip: ["marketing"] })).toEqual([]);
  });

  test("a child ruleset writing off_by_default: [] turns the tag back on", () => {
    const dir = sandbox();
    write(
      dir,
      "base.yaml",
      "version: 1\noff_by_default: [marketing]\nrules:\n  - id: a\n    kind: regex\n    builtin: dash_present\n    tags: [marketing]\n    message: \"m\"\n",
    );
    write(dir, "child.yaml", "version: 1\nextends: base.yaml\noff_by_default: []\nrules: []\n");

    const child = resolveRuleset({ cwd: dir, rulesPath: "child.yaml" }).ruleset;
    expect(selectRules(child).ruleset.rules.map((rule) => rule.id)).toEqual(["a"]);
  });
});
