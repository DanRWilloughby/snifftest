/**
 * Which `snifftest` the shells actually run.
 *
 * Both fetch paths, the pre-commit hook and the Claude Code skill, decide at run
 * time what to execute. That decision is the sharp edge of the whole
 * distribution, because the directory they make it in is a repository somebody
 * else wrote.
 *
 * Two mechanisms are pinned here, and they are pinned by consequence rather
 * than by implementation:
 *
 *   A package manager asked for `snifftest@<version>` while standing inside a
 *   checkout runs that checkout's own `node_modules/snifftest` and never
 *   reaches a registry. Measured, offline, with the registry pointed at a dead
 *   port: cwd inside the checkout ran the committed binary; cwd outside it
 *   refused to connect and ran nothing.
 *
 *   A checkout's `node_modules/.bin` on PATH is reached by `command -v`, which
 *   is exactly what a package script or a hook manager puts there.
 *
 * So every test below plants a hostile `snifftest` in a scratch repository, by
 * both routes at once, and asserts the marker file it would write is never
 * written. `npx` and `bunx` are replaced on PATH by recorders, so no test can
 * reach the network, and what they record is the working directory the fetch
 * was made from.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const hookSource = join(repoRoot, "hooks", "pre-commit");
const runScript = join(repoRoot, "skills", "snifftest", "scripts", "run.sh");

const RULESET = `version: 1
rules:
  - id: dash_present
    kind: regex
    builtin: dash_present
    message: "An em dash. Say it in two sentences."
`;

const temporary: string[] = [];

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cwd: string, command: string[], env: Record<string, string>): Ran {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function script(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A working tree that ships its own hostile `snifftest`, by both routes. */
interface Hostile {
  readonly dir: string;
  readonly marker: string;
  readonly record: string;
  readonly stubs: string;
  /** PATH with the recorders first and the checkout's own bin directory on it. */
  readonly path: string;
  readonly env: Record<string, string>;
}

function hostileTree(): Hostile {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-runner-"));
  temporary.push(dir);

  const marker = join(dir, "marker.txt");
  const record = join(dir, "record.txt");
  const stubs = join(dir, "stubs");
  const tree = join(dir, "tree");

  mkdirSync(stubs, { recursive: true });
  mkdirSync(join(tree, "node_modules", "snifftest", "bin"), { recursive: true });
  mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true });

  // What a hostile repository commits. Running it is the failure this file is
  // about, so it announces itself in a file rather than on a stream nobody
  // asserts on.
  const hijack = `#!/bin/sh
printf 'HIJACKED %s\\n' "$*" >> "$SNIFFTEST_TEST_MARKER"
exit 0
`;
  writeFileSync(
    join(tree, "node_modules", "snifftest", "package.json"),
    `${JSON.stringify({ name: "snifftest", version: "0.1.0", bin: { snifftest: "bin/run.sh" } }, null, 2)}\n`,
  );
  script(join(tree, "node_modules", "snifftest", "bin", "run.sh"), hijack);
  script(join(tree, "node_modules", ".bin", "snifftest"), hijack);

  // The fetchers, replaced by recorders. A test that reaches the network is a
  // test that can fail for somebody else's reasons, and this one would be
  // asserting on npm's behaviour rather than on ours.
  const recorder = `#!/bin/sh
{
  printf 'runner=%s\\n' "$(basename "$0")"
  printf 'cwd=%s\\n' "$(pwd -P)"
  printf 'args=%s\\n' "$*"
} >> "$SNIFFTEST_TEST_RECORD"
exit 0
`;
  script(join(stubs, "npx"), recorder);
  script(join(stubs, "bunx"), recorder);

  writeFileSync(join(tree, ".snifftest.yaml"), RULESET);
  writeFileSync(join(tree, "notes.md"), "A paragraph that trips nothing at all.\n");

  const path = `${stubs}:${join(tree, "node_modules", ".bin")}:${process.env["PATH"] ?? ""}`;
  return {
    // The physical path, because the scripts compare physical paths and a
    // temporary directory on macOS is reached through a symlinked prefix.
    dir: realpathSync(tree),
    marker,
    record,
    stubs,
    path,
    env: {
      PATH: path,
      SNIFFTEST_TEST_MARKER: marker,
      SNIFFTEST_TEST_RECORD: record,
    },
  };
}

function recorded(hostile: Hostile): string {
  return existsSync(hostile.record) ? readFileSync(hostile.record, "utf8") : "";
}

/** Every working directory a fetcher was invoked from. */
function fetchDirectories(hostile: Hostile): string[] {
  return [...recorded(hostile).matchAll(/^cwd=(.*)$/gm)].map((match) => match[1] as string);
}

/** Every directory an upward walk for a local install ended in. */
function stoppedAt(hostile: Hostile): string[] {
  return [...recorded(hostile).matchAll(/^stopped=(.*)$/gm)].map((match) => match[1] as string);
}

function hijacked(hostile: Hostile): boolean {
  return existsSync(hostile.marker);
}

describe("the skill's run.sh", () => {
  test("never runs a snifftest the checked-out repository supplied", () => {
    const hostile = hostileTree();

    const result = run(hostile.dir, ["sh", runScript, "--", "notes.md"], hostile.env);

    expect(hijacked(hostile)).toBe(false);
    expect(result.stdout).not.toContain("HIJACKED");
  });

  test("fetches from a directory outside the tree it is checking", () => {
    const hostile = hostileTree();

    run(hostile.dir, ["sh", runScript, "--", "notes.md"], hostile.env);

    const directories = fetchDirectories(hostile);
    expect(directories.length).toBeGreaterThan(0);
    for (const directory of directories) {
      expect(directory.startsWith(hostile.dir)).toBe(false);
    }
  });

  test("tells the checker which tree it is standing outside of", () => {
    const hostile = hostileTree();

    run(hostile.dir, ["sh", runScript, "--", "notes.md"], hostile.env);

    expect(recorded(hostile)).toContain(`--root ${hostile.dir}`);
  });

  test("still uses a snifftest installed outside the tree", () => {
    const hostile = hostileTree();
    script(
      join(hostile.stubs, "snifftest"),
      `#!/bin/sh
printf 'INSTALLED %s\\n' "$*" >> "$SNIFFTEST_TEST_RECORD"
exit 0
`,
    );

    run(hostile.dir, ["sh", runScript, "--", "notes.md"], hostile.env);

    expect(recorded(hostile)).toContain("INSTALLED");
    expect(hijacked(hostile)).toBe(false);
  });
});

describe("the pre-commit hook", () => {
  function repo(hostile: Hostile): void {
    const git = (args: string[]): Ran => run(hostile.dir, ["git", ...args], hostile.env);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "hook@example.test"]);
    git(["config", "user.name", "Hook Test"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "core.hooksPath", ".git/hooks"]);

    mkdirSync(join(hostile.dir, ".git", "hooks"), { recursive: true });
    const installed = join(hostile.dir, ".git", "hooks", "pre-commit");
    cpSync(hookSource, installed);
    chmodSync(installed, 0o755);

    writeFileSync(join(hostile.dir, ".gitignore"), "node_modules\n");
    git(["add", ".snifftest.yaml", "notes.md", ".gitignore"]);
  }

  test("never runs a snifftest the repository being committed to supplied", () => {
    const hostile = hostileTree();
    repo(hostile);

    const commit = run(hostile.dir, ["git", "commit", "-q", "-m", "first"], hostile.env);

    expect(hijacked(hostile)).toBe(false);
    expect(commit.stdout).not.toContain("HIJACKED");
  });

  test("fetches from a directory outside the repository", () => {
    const hostile = hostileTree();
    repo(hostile);

    run(hostile.dir, ["git", "commit", "-q", "-m", "first"], hostile.env);

    const directories = fetchDirectories(hostile);
    expect(directories.length).toBeGreaterThan(0);
    for (const directory of directories) {
      expect(directory.startsWith(hostile.dir)).toBe(false);
    }
  });
});

/**
 * The walk *upward* from the scratch directory.
 *
 * npm resolves a local install by walking up the directory tree from the
 * working directory, not by looking in it. Standing in a scratch directory is
 * therefore only half the fix: a `node_modules/snifftest` at the matching
 * version anywhere *above* that directory is still what runs. On Linux
 * `mktemp -d` sits under a world-writable `/tmp`, where any local user can
 * plant one; on a self-hosted runner `RUNNER_TEMP` survives between jobs, so
 * one fork's pull request can plant it and the next job hands it the key.
 *
 * The fix is an empty `node_modules` inside the scratch directory, which ends
 * the walk somewhere the script owns. What is asserted below is that property
 * and not npm's implementation of it: the fetcher on PATH performs the same
 * upward walk npm documents, and says which of the two it found. A test that
 * ran the real npm would need a registry, a cache and a network.
 */
describe("a snifftest planted above the scratch directory", () => {
  /** A fetcher that resolves the way npm documents: upward, first match wins. */
  const walkingRecorder = `#!/bin/sh
{
  printf 'runner=%s\\n' "$(basename "$0")"
  printf 'cwd=%s\\n' "$(pwd -P)"
  printf 'args=%s\\n' "$*"
} >> "$SNIFFTEST_TEST_RECORD"

at=$(pwd -P)
while :; do
  if [ -d "$at/node_modules" ]; then
    if [ -x "$at/node_modules/snifftest/bin/run.sh" ]; then
      exec "$at/node_modules/snifftest/bin/run.sh" "$@"
    fi
    # A node_modules without this package in it still ends the walk, which is
    # what npm does and the whole reason the empty directory works.
    printf 'stopped=%s\\n' "$at" >> "$SNIFFTEST_TEST_RECORD"
    break
  fi
  [ "$at" != "/" ] || break
  at=$(dirname "$at")
done
printf 'reached=registry\\n' >> "$SNIFFTEST_TEST_RECORD"
exit 0
`;

  /** A temporary directory with a hostile package planted at its top. */
  function plantedTemp(hostile: Hostile): string {
    const home = mkdtempSync(join(tmpdir(), "snifftest-plant-"));
    temporary.push(home);
    const planted = join(home, "node_modules", "snifftest", "bin");
    mkdirSync(planted, { recursive: true });
    writeFileSync(
      join(home, "node_modules", "snifftest", "package.json"),
      `${JSON.stringify({ name: "snifftest", version: "0.1.0" }, null, 2)}\n`,
    );
    script(
      join(planted, "run.sh"),
      `#!/bin/sh\nprintf 'HIJACKED %s\\n' "$*" >> "$SNIFFTEST_TEST_MARKER"\nexit 0\n`,
    );
    script(join(hostile.stubs, "npx"), walkingRecorder);
    script(join(hostile.stubs, "bunx"), walkingRecorder);
    return realpathSync(home);
  }

  test("the skill's run.sh stops the walk inside its own scratch directory", () => {
    const hostile = hostileTree();
    const home = plantedTemp(hostile);

    const result = run(hostile.dir, ["sh", runScript, "--", "notes.md"], {
      ...hostile.env,
      TMPDIR: home,
    });

    expect(hijacked(hostile)).toBe(false);
    expect(result.stdout).not.toContain("HIJACKED");
    expect(recorded(hostile)).toContain("reached=registry");
    // The walk ended where the fetch was made, not at the plant above it.
    expect(stoppedAt(hostile)).toEqual(fetchDirectories(hostile));
    for (const at of stoppedAt(hostile)) expect(at.startsWith(home)).toBe(false);
  });

  test("the pre-commit hook stops the walk inside its own scratch directory", () => {
    const hostile = hostileTree();
    const git = (args: string[]): Ran => run(hostile.dir, ["git", ...args], hostile.env);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "hook@example.test"]);
    git(["config", "user.name", "Hook Test"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "core.hooksPath", ".git/hooks"]);
    mkdirSync(join(hostile.dir, ".git", "hooks"), { recursive: true });
    const installed = join(hostile.dir, ".git", "hooks", "pre-commit");
    cpSync(hookSource, installed);
    chmodSync(installed, 0o755);
    writeFileSync(join(hostile.dir, ".gitignore"), "node_modules\n");
    git(["add", ".snifftest.yaml", "notes.md", ".gitignore"]);

    const home = plantedTemp(hostile);
    const commit = run(hostile.dir, ["git", "commit", "-q", "-m", "first"], {
      ...hostile.env,
      TMPDIR: home,
    });

    expect(hijacked(hostile)).toBe(false);
    expect(commit.stdout).not.toContain("HIJACKED");
    expect(recorded(hostile)).toContain("reached=registry");
    expect(stoppedAt(hostile)).toEqual(fetchDirectories(hostile));
    for (const at of stoppedAt(hostile)) expect(at.startsWith(home)).toBe(false);
  });

  test("nothing a fetched package declares is allowed to run", () => {
    const hostile = hostileTree();
    // With no bunx anywhere, the npx branch is the one that runs.
    rmSync(join(hostile.stubs, "bunx"), { force: true });

    run(hostile.dir, ["sh", runScript, "--", "notes.md"], {
      ...hostile.env,
      PATH: `${hostile.stubs}:/usr/bin:/bin`,
    });

    expect(recorded(hostile)).toContain("--ignore-scripts");
  });
});
