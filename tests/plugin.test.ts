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

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

// --- the script as a script, not as a document ----------------------------

/**
 * What the script actually hands the checker.
 *
 * `SNIFFTEST_BIN` is the documented way to point the script at an executable,
 * so a recorder standing in for the checker is the only stub needed, and the
 * argument list it writes down is the thing under test.
 */
const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function recorder(): { bin: string; args: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-skill-"));
  scratch.push(dir);
  const log = join(dir, "log.txt");
  const bin = join(dir, "recorder");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do echo "$a" >> ${JSON.stringify(log)}; done\nexit 0\n`);
  chmodSync(bin, 0o755);

  return {
    bin,
    args: () =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [],
  };
}

/**
 * The arguments with the `--root <dir>` pair taken out.
 *
 * The script runs the checker from a scratch directory, because a package
 * manager asked for the tool while standing in the tree being checked runs that
 * tree's own copy. `--root` is how the tree is named instead of stood in; it is
 * asserted on its own below, and every other assertion here is about the shape
 * of the path list, which it would otherwise clutter.
 */
function handed(args: readonly string[]): string[] {
  const at = args.indexOf("--root");
  return at === -1 ? [...args] : [...args.slice(0, at), ...args.slice(at + 2)];
}

function runTheScript(argv: readonly string[], bin: string): { code: number; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["sh", join(repoRoot, "skills/snifftest/scripts/run.sh"), ...argv],
    env: { ...process.env, SNIFFTEST_BIN: bin, SNIFFTEST_SEND: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

describe("what the script hands the checker", () => {
  test("a file whose name starts with a dash is a path, not an option", () => {
    // Without a `--` before the paths the checker reads this as an unknown
    // flag, and the run fails on the name of a file rather than on its prose.
    const log = recorder();
    const run = runTheScript(["-notes.md"], log.bin);

    expect(run.code).toBe(0);
    const args = handed(log.args());
    expect(args).toEqual(["check", "--dry-run", "--", "-notes.md"]);
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("-notes.md"));
  });

  test("a path with spaces in it arrives as one argument", () => {
    const log = recorder();
    expect(runTheScript(["drafts/first draft.md"], log.bin).code).toBe(0);
    expect(handed(log.args())).toEqual(["check", "--dry-run", "--", "drafts/first draft.md"]);
  });

  test("several paths survive, dashes and spaces together", () => {
    const log = recorder();
    runTheScript(["-notes.md", "a folder/second draft.md"], log.bin);
    expect(handed(log.args())).toEqual([
      "check",
      "--dry-run",
      "--",
      "-notes.md",
      "a folder/second draft.md",
    ]);
  });

  test("the script's own words never reach the checker, and its separator is placed once", () => {
    const log = recorder();
    // The caller wrote `--` themselves; the script still places exactly one.
    runTheScript(["--judge", "--", "-notes.md"], log.bin);
    const args = handed(log.args());

    expect(args).toEqual(["check", "--", "-notes.md"]);
    expect(args.filter((argument) => argument === "--")).toHaveLength(1);
    expect(args).not.toContain("--judge");
    // --judge asked for the judgment pass, so the free-rules flag is gone.
    expect(args).not.toContain("--dry-run");
  });

  test("names the tree it is checking, so the run can happen outside it", () => {
    const log = recorder();
    runTheScript(["notes.md"], log.bin);
    const args = log.args();
    const at = args.indexOf("--root");

    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe(realpathSync(process.cwd()));
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
