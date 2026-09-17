/**
 * The pre-commit hook, exercised as a hook.
 *
 * Every test builds a throwaway git repository, drops the real script into
 * `.git/hooks/pre-commit`, and runs a real `git commit`. Nothing is stubbed at
 * the git layer, because the behaviour worth pinning is exactly the behaviour
 * git produces: which files the hook sees, what content it reads for them, and
 * whether the commit lands.
 *
 * Two runners are used. Some tests point `SNIFFTEST_BIN` at the package's own
 * CLI so the flag decisions are checked against the real exit codes. Others
 * point it at a recording script, which is the only way to assert what the hook
 * *asked for* — that a default run carries `--dry-run`, that nothing is run at
 * all when no prose is staged, and that a missing key downgrades a send.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const hookSource = join(repoRoot, "hooks", "pre-commit");

/** One countable rule, so a scratch repository needs no network and no key. */
const RULESET = `version: 1
threshold: 0.7
rules:
  - id: dash_present
    kind: regex
    builtin: dash_present
    message: "An em dash. Say it in two sentences."
`;

const CLEAN = "A short paragraph that trips nothing at all.\n";
const TRIPS = "A short paragraph that goes wrong — right about here.\n";

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

function run(cwd: string, command: string[], env: Record<string, string> = {}): Ran {
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

function git(cwd: string, args: string[], env: Record<string, string> = {}): Ran {
  return run(cwd, ["git", ...args], env);
}

/** A repository with the hook installed, the ruleset committed, and nothing else. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-hook-"));
  temporary.push(dir);

  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "hook@example.test"]);
  git(dir, ["config", "user.name", "Hook Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  // A global core.hooksPath would otherwise decide this test's outcome.
  git(dir, ["config", "core.hooksPath", ".git/hooks"]);

  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  const installed = join(dir, ".git", "hooks", "pre-commit");
  cpSync(hookSource, installed);
  chmodSync(installed, 0o755);

  writeFileSync(join(dir, ".snifftest.yaml"), RULESET);
  git(dir, ["add", ".snifftest.yaml"]);
  git(dir, ["commit", "-q", "--no-verify", "-m", "rules"]);

  return dir;
}

/** The package's own CLI, wrapped so the hook can call it as one executable. */
let realRunner = "";

interface RunnerOptions {
  /** The exit code to return. */
  readonly code?: number;
  /** Lines to print on stdout, standing in for the checker's report. */
  readonly stdout?: string;
  /** Lines to print on stderr, standing in for whatever went wrong. */
  readonly stderr?: string;
}

/** Writes its arguments and its working directory to a file, then exits `code`. */
function recordingRunner(
  options: RunnerOptions = {},
): { bin: string; log: string; args: () => string[]; cwd: () => string } {
  const { code = 0, stdout = "", stderr = "" } = options;
  const dir = mkdtempSync(join(tmpdir(), "snifftest-runner-"));
  temporary.push(dir);
  const log = join(dir, "log.txt");
  const bin = join(dir, "recorder");
  const say = (text: string, stream: string): string =>
    text === "" ? "" : `printf '%s\\n' ${JSON.stringify(text)}${stream}\n`;
  writeFileSync(
    bin,
    `#!/bin/sh\npwd > ${JSON.stringify(log)}\nfor a in "$@"; do echo "$a" >> ${JSON.stringify(log)}; done\n` +
      say(stdout, "") +
      say(stderr, " >&2") +
      `exit ${code}\n`,
  );
  chmodSync(bin, 0o755);

  const lines = (): string[] =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
  return { bin, log, args: () => lines().slice(1), cwd: () => lines()[0] ?? "" };
}

/** Lives for the whole file, so it must not go into the per-test cleanup list. */
let realRunnerDir = "";

afterAll(() => {
  if (realRunnerDir !== "") rmSync(realRunnerDir, { recursive: true, force: true });
});

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-cli-bin-"));
  realRunnerDir = dir;
  realRunner = join(dir, "snifftest");
  writeFileSync(
    realRunner,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(repoRoot, "src", "cli.ts"))} "$@"\n`,
  );
  chmodSync(realRunner, 0o755);
});

describe("the pre-commit hook, against the real checker", () => {
  test("lets clean prose through", () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "clean"], { SNIFFTEST_BIN: realRunner });

    expect(commit.code).toBe(0);
    expect(git(dir, ["log", "--oneline"]).stdout).toContain("clean");
  });

  test("blocks a commit whose prose trips a rule, and names the rule", () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, "post.md"), TRIPS);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "bad"], { SNIFFTEST_BIN: realRunner });

    expect(commit.code).not.toBe(0);
    expect(`${commit.stdout}${commit.stderr}`).toContain("dash_present");
    expect(`${commit.stdout}${commit.stderr}`).toContain("post.md:1");
    expect(git(dir, ["log", "--oneline"]).stdout).not.toContain("bad");
  });

  test("SNIFFTEST_SKIP=1 lets the same commit through and says that it did", () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, "post.md"), TRIPS);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "skipped"], {
      SNIFFTEST_BIN: realRunner,
      SNIFFTEST_SKIP: "1",
    });

    expect(commit.code).toBe(0);
    expect(commit.stderr).toContain("SNIFFTEST_SKIP=1");
  });

  test("reads the staged content, not the working tree", () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);
    // The bad sentence exists on disk but was never staged.
    writeFileSync(join(dir, "post.md"), TRIPS);

    const commit = git(dir, ["commit", "-m", "staged only"], { SNIFFTEST_BIN: realRunner });

    expect(commit.code).toBe(0);
  });

  test("ignores a file that is not prose", () => {
    const dir = scratchRepo();
    writeFileSync(join(dir, "data.json"), `{"note": "an em dash — inside data"}\n`);
    git(dir, ["add", "data.json"]);

    const commit = git(dir, ["commit", "-m", "data"], { SNIFFTEST_BIN: realRunner });

    expect(commit.code).toBe(0);
  });

  test("uses the staged ruleset, so a stricter rule lands with the commit that adds it", () => {
    const dir = scratchRepo();
    writeFileSync(
      join(dir, ".snifftest.yaml"),
      `${RULESET}  - id: no_shipped\n    kind: regex\n    pattern: "shipped"\n    message: "Say what shipped."\n`,
    );
    writeFileSync(join(dir, "post.md"), "It shipped on Tuesday.\n");
    git(dir, ["add", ".snifftest.yaml", "post.md"]);

    const commit = git(dir, ["commit", "-m", "stricter"], { SNIFFTEST_BIN: realRunner });

    expect(commit.code).not.toBe(0);
    expect(`${commit.stdout}${commit.stderr}`).toContain("no_shipped");
  });
});

describe("what the hook asks the checker to do", () => {
  test("runs nothing at all when no prose is staged", () => {
    const dir = scratchRepo();
    const runner = recordingRunner();
    writeFileSync(join(dir, "data.json"), "{}\n");
    git(dir, ["add", "data.json"]);

    const commit = git(dir, ["commit", "-m", "no prose"], { SNIFFTEST_BIN: runner.bin });

    expect(commit.code).toBe(0);
    expect(existsSync(runner.log)).toBe(false);
  });

  test("asks for the free rules by default, and never answers the send question", () => {
    const dir = scratchRepo();
    const runner = recordingRunner();
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    git(dir, ["commit", "-m", "default"], { SNIFFTEST_BIN: runner.bin });

    expect(runner.args()).toEqual(["check", "--dry-run", "--", "post.md"]);
    expect(runner.args()).not.toContain("--yes");
    expect(runner.args()).not.toContain("-y");
    // Run from the extraction directory, never from the repository itself.
    expect(runner.cwd().startsWith(dir)).toBe(false);
  });

  test("passes a path with a space in it as one path", () => {
    const dir = scratchRepo();
    const runner = recordingRunner();
    writeFileSync(join(dir, "a draft.md"), CLEAN);
    git(dir, ["add", "a draft.md"]);

    git(dir, ["commit", "-m", "spaced"], { SNIFFTEST_BIN: runner.bin });

    expect(runner.args()).toEqual(["check", "--dry-run", "--", "a draft.md"]);
  });

  test("SNIFFTEST_SEND=1 with no key stays dry and says why", () => {
    const dir = scratchRepo();
    const runner = recordingRunner();
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "half asked"], {
      SNIFFTEST_BIN: runner.bin,
      SNIFFTEST_SEND: "1",
      TYPESAFE_API_KEY: "",
    });

    expect(runner.args()).toContain("--dry-run");
    expect(commit.stderr).toContain("TYPESAFE_API_KEY is empty");
  });

  test("SNIFFTEST_SEND=1 with a key drops the dry run", () => {
    const dir = scratchRepo();
    const runner = recordingRunner();
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    git(dir, ["commit", "-m", "asked"], {
      SNIFFTEST_BIN: runner.bin,
      SNIFFTEST_SEND: "1",
      TYPESAFE_API_KEY: "placeholder-not-a-real-key",
    });

    expect(runner.args()).not.toContain("--dry-run");
    expect(runner.args()[0]).toBe("check");
  });

  test("passes a filename that starts with a dash as a path, not an option", () => {
    const dir = scratchRepo();
    const runner = recordingRunner();
    writeFileSync(join(dir, "-dashfile.md"), CLEAN);
    git(dir, ["add", "--", "-dashfile.md"]);

    const commit = git(dir, ["commit", "-m", "dashed"], { SNIFFTEST_BIN: runner.bin });

    expect(runner.args()).toEqual(["check", "--dry-run", "--", "-dashfile.md"]);
    expect(commit.code).toBe(0);
  });

  test("passes a threshold through when one is set", () => {
    const dir = scratchRepo();
    const runner = recordingRunner();
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    git(dir, ["commit", "-m", "threshold"], {
      SNIFFTEST_BIN: runner.bin,
      SNIFFTEST_THRESHOLD: "0.9",
    });

    expect(runner.args()).toEqual(["check", "--dry-run", "--threshold", "0.9", "--", "post.md"]);
  });
});

describe("when the checker never got as far as an opinion", () => {
  // Exit 1 is both "your draft trips a rule" and what npx, bunx and npm return
  // when they cannot resolve a package. The hook has to tell them apart from
  // the output, or a registry 404 blames the writer for a network problem.
  const FETCH_FAILED = "npm error 404 Not Found - GET https://registry.npmjs.org/snifftest";

  test("exit 1 with no flags is a failed fetch, not a bad draft", () => {
    const dir = scratchRepo();
    const runner = recordingRunner({ code: 1, stderr: FETCH_FAILED });
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "fetch failed"], { SNIFFTEST_BIN: runner.bin });

    expect(commit.code).toBe(0);
    expect(commit.stderr).toContain("did not run");
    expect(commit.stderr).not.toContain("trips the rules");
    // Whatever the runner said is passed through, so the cause is visible.
    expect(commit.stderr).toContain("404 Not Found");
    expect(git(dir, ["log", "--oneline"]).stdout).toContain("fetch failed");
  });

  test("SNIFFTEST_STRICT=1 blocks on a failed fetch too", () => {
    const dir = scratchRepo();
    const runner = recordingRunner({ code: 1, stderr: FETCH_FAILED });
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "strict fetch"], {
      SNIFFTEST_BIN: runner.bin,
      SNIFFTEST_STRICT: "1",
    });

    expect(commit.code).not.toBe(0);
  });

  test("exit 1 with a flag line still blocks the commit", () => {
    const dir = scratchRepo();
    const runner = recordingRunner({
      code: 1,
      stdout: "post.md:1 dash_present 1.00 An em dash. Say it in two sentences.",
    });
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "real flag"], { SNIFFTEST_BIN: runner.bin });

    expect(commit.code).not.toBe(0);
    expect(commit.stderr).toContain("trips the rules");
    expect(commit.stdout + commit.stderr).toContain("dash_present");
  });

  test("chatter that is not a flag line does not count as one", () => {
    const dir = scratchRepo();
    const runner = recordingRunner({
      code: 1,
      stdout: "Need to install the following packages: snifftest@0.1.0",
    });
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "chatter"], { SNIFFTEST_BIN: runner.bin });

    expect(commit.code).toBe(0);
    expect(commit.stderr).toContain("did not run");
  });
});

describe("when the checker itself is broken", () => {
  test("a tool failure warns and lets the commit through", () => {
    const dir = scratchRepo();
    const runner = recordingRunner({ code: 2 });
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "broken tool"], { SNIFFTEST_BIN: runner.bin });

    expect(commit.code).toBe(0);
    expect(commit.stderr).toContain("could not finish");
  });

  test("SNIFFTEST_STRICT=1 turns the same failure into a blocked commit", () => {
    const dir = scratchRepo();
    const runner = recordingRunner({ code: 2 });
    writeFileSync(join(dir, "post.md"), CLEAN);
    git(dir, ["add", "post.md"]);

    const commit = git(dir, ["commit", "-m", "strict"], {
      SNIFFTEST_BIN: runner.bin,
      SNIFFTEST_STRICT: "1",
    });

    expect(commit.code).not.toBe(0);
  });
});
