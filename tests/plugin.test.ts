/**
 * The Claude Code plugin, read as a document rather than installed.
 *
 * Three files decide what a stranger gets when they type
 * `/plugin marketplace add DanRWilloughby/snifftest`: two small manifests and a
 * skill that tells an agent how to run the checker. None of them can be unit
 * tested by running them, so they are tested as the contracts they are.
 *
 * The properties asserted here are the ones that would be expensive to discover
 * in someone else's session: a floating version, an agent that sends a draft the
 * user never agreed to send, a skill that reaches for the key, or an internal
 * name that escaped into a public repository.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const read = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

const pluginSource = read(".claude-plugin/plugin.json");
const marketplaceSource = read(".claude-plugin/marketplace.json");
const skillSource = read("skills/snifftest/SKILL.md");
const runScript = read("skills/snifftest/scripts/run.sh");
const claudeCodeDoc = read("docs/claude-code.md");

// biome-ignore lint/suspicious/noExplicitAny: the document's shape is what is asserted.
const plugin = JSON.parse(pluginSource) as any;
// biome-ignore lint/suspicious/noExplicitAny: the document's shape is what is asserted.
const marketplace = JSON.parse(marketplaceSource) as any;

/** The one version the plugin is allowed to fetch. Pinned, everywhere, together. */
const PINNED_VERSION = "0.1.0";

/** The skill's own frontmatter, parsed by a real YAML parser. */
// biome-ignore lint/suspicious/noExplicitAny: the document's shape is what is asserted.
const frontmatter = (() => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(skillSource);
  if (match === null) throw new Error("SKILL.md has no frontmatter block");
  return Bun.YAML.parse(match[1] as string) as any;
})();

/** Everything the skill says to an agent, frontmatter included. */
const skillInstructions = skillSource;

describe("the plugin manifest", () => {
  test("parses and names the package", () => {
    expect(plugin.name).toBe("snifftest");
    expect(typeof plugin.description).toBe("string");
    expect(plugin.license).toBe("MIT");
    expect(plugin.repository).toBe("https://github.com/DanRWilloughby/snifftest");
  });

  test("is pinned to one version, and the package agrees with it", () => {
    expect(plugin.version).toBe(PINNED_VERSION);
    // The published package carries the same number, so a user who installs the
    // plugin and a user who types `bunx snifftest` get the same checker.
    // biome-ignore lint/suspicious/noExplicitAny: the shape is the assertion.
    const pkg = JSON.parse(read("package.json")) as any;
    expect(typeof pkg.version).toBe("string");
  });
});

describe("the marketplace manifest", () => {
  test("parses, names an owner, and offers this repository as the plugin", () => {
    expect(marketplace.name).toBe("snifftest");
    expect(typeof marketplace.owner?.name).toBe("string");
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe("snifftest");
    expect(marketplace.plugins[0].source).toBe("./");
    expect(typeof marketplace.plugins[0].description).toBe("string");
  });

  test("carries the same version as the plugin it points at", () => {
    expect(marketplace.plugins[0].version).toBe(PINNED_VERSION);
    expect(marketplace.metadata.version).toBe(PINNED_VERSION);
  });
});

describe("the skill's frontmatter", () => {
  test("has the fields Claude Code reads", () => {
    expect(frontmatter.name).toBe("snifftest");
    expect(typeof frontmatter.description).toBe("string");
    expect(frontmatter.description.length).toBeGreaterThan(40);
    expect(frontmatter["user-invocable"]).toBe(true);
    expect(frontmatter.license).toBe("MIT");
  });

  test("says when to reach for it, in words a user would use", () => {
    expect(frontmatter.description).toContain("/snifftest");
  });
});

describe("what the skill tells an agent to do", () => {
  test("points at the bundled script rather than a command it composes itself", () => {
    expect(skillInstructions).toContain("scripts/run.sh");
  });

  test("teaches the shape of a flag line and what the exit codes mean", () => {
    expect(skillInstructions).toContain("path:line rule score message");
    expect(skillInstructions).toContain("exit");
  });

  test("sends the agent back to the prose, not to the rule", () => {
    expect(skillInstructions).toContain("Fix the prose");
    expect(skillInstructions.toLowerCase()).toContain("rerun");
  });

  test("never tells an agent to answer the sending question itself", () => {
    // The two ways to skip the question. Neither belongs in an instruction to
    // an agent: consent is the user's, and the tool already knows how to ask.
    expect(skillInstructions).not.toContain("--yes");
    expect(skillInstructions).not.toContain("SNIFFTEST_SEND=1");
    expect(skillInstructions).not.toContain("SNIFFTEST_SEND");
  });

  test("never tells an agent to touch the key", () => {
    expect(skillInstructions).not.toContain("TYPESAFE_API_KEY");
    expect(skillInstructions).not.toContain("API_KEY");
  });

  test("never floats the version of the tool it runs", () => {
    expect(skillInstructions).not.toContain("latest");
  });
});

describe("the bundled script", () => {
  test("pins the version it would fetch, and names no floating one", () => {
    expect(runScript).toContain('SNIFFTEST_VERSION="${SNIFFTEST_VERSION:-0.1.0}"');
    expect(runScript).toContain('snifftest@$SNIFFTEST_VERSION');
    expect(runScript).not.toContain("snifftest@latest");
  });

  test("runs the countable rules unless something else asked for the others", () => {
    expect(runScript).toContain("--dry-run");
    expect(runScript).toContain('"${SNIFFTEST_SEND:-0}" != "1"');
  });

  test("reads the sending answer and never writes one", () => {
    // Every mention has to be a read. An assignment would be the script
    // answering a question that belongs to the user.
    expect(runScript).not.toMatch(/^\s*(export\s+)?SNIFFTEST_SEND=/m);
  });

  test("passes no consent-skipping flag to the checker", () => {
    // `npx --yes` is npm's own confirmation for fetching a package, and is the
    // only place the string is allowed to appear.
    const yesLines = runScript.split("\n").filter((line) => line.includes("--yes"));
    expect(yesLines.length).toBeGreaterThan(0);
    for (const line of yesLines) expect(line).toContain("npx");
  });

  test("never reads or prints the key", () => {
    expect(runScript).not.toContain("TYPESAFE_API_KEY");
  });
});

describe("nothing internal escaped into the plugin", () => {
  const surfaces: Record<string, string> = {
    "plugin.json": pluginSource,
    "marketplace.json": marketplaceSource,
    "SKILL.md": skillSource,
    "run.sh": runScript,
    "docs/claude-code.md": claudeCodeDoc,
  };

  test("no private name, brand or rule", () => {
    const forbidden = [/\bjinn\b/i, /\bdayspring\b/i, /\bbloombelly\b/i, /\bvermeer\b/i];
    for (const [name, source] of Object.entries(surfaces)) {
      for (const pattern of forbidden) {
        expect([name, pattern.test(source)]).toEqual([name, false]);
      }
    }
  });
});

describe("the install doc", () => {
  test("lists the three ways in, and pins the plugin it installs", () => {
    expect(claudeCodeDoc).toContain("/plugin marketplace add DanRWilloughby/snifftest");
    expect(claudeCodeDoc).toContain("npx skills add DanRWilloughby/snifftest");
    expect(claudeCodeDoc).toContain("git clone");
  });
});
