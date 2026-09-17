import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EXIT, runCli } from "../src/cli.ts";
import { consentPath } from "../src/consent.ts";
import type { JevClient, JevRequest, JevResult } from "../src/jev.ts";
import type { Flag } from "../src/types.ts";

const repoRoot = resolve(import.meta.dir, "..");
const MIXED = "tests/fixtures/rules/mixed.yaml";
const TEXTS = "tests/fixtures/texts";

const temporary: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-cli-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A gateway that answers per paragraph, and records what it was asked. */
function stubClient(
  answer: (state: string) => Readonly<Record<string, number>>,
  seen: JevRequest[],
): JevClient {
  return {
    async ask(request: JevRequest): Promise<JevResult> {
      seen.push(request);
      return {
        model: "jev-test",
        nouls: answer(String(request.state)),
        inputTokens: 120,
        outputTokens: 0,
        estimatedCostUsd: 120 * 0.042e-6,
        latencyMs: 11,
        attempts: 1,
      };
    },
  };
}

/** The same answer whatever the paragraph says. */
function always(nouls: Readonly<Record<string, number>>) {
  return () => nouls;
}

/** High only on the paragraph that actually restates itself. */
const restating = (state: string) => ({
  restating_closer: state.includes("In short") ? 0.93 : 0.04,
});

/** A gateway that must never be reached. */
function forbiddenClient(): JevClient {
  return {
    async ask(): Promise<JevResult> {
      throw new Error("the network was used when it should not have been");
    },
  };
}

interface RunOptions {
  readonly argv: readonly string[];
  readonly client?: JevClient;
  readonly env?: Record<string, string | undefined>;
  readonly home?: string;
  readonly cwd?: string;
  readonly isTty?: boolean;
  readonly answer?: string;
}

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(options: RunOptions): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const home = options.home ?? sandbox();

  const code = await runCli({
    argv: options.argv,
    env: { HOME: home, TYPESAFE_API_KEY: "test-key-not-a-real-credential", ...options.env },
    cwd: options.cwd ?? repoRoot,
    homedir: home,
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    isTty: options.isTty ?? false,
    ...(options.answer === undefined ? {} : { prompt: async () => options.answer as string }),
    createClient: () => options.client ?? forbiddenClient(),
  });

  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("check, dry run", () => {
  test("prints the countable flags, calls nothing, and exits 1", async () => {
    const seen: JevRequest[] = [];
    const result = await run({
      argv: ["check", "--dry-run", "--rules", MIXED, `${TEXTS}/flagged.md`],
      client: stubClient(always({ restating_closer: 0.99 }), seen),
    });

    expect(seen).toEqual([]);
    expect(result.code).toBe(EXIT.flags);
    expect(result.out.split("\n")).toEqual([
      "tests/fixtures/texts/flagged.md:6 dash_present 1.00 An em dash. Say it in two sentences.",
      "tests/fixtures/texts/flagged.md:8 colon_heavy 1.00 Three colons in one paragraph. Pick one.",
    ]);
  });

  test("a clean draft prints nothing and exits 0", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--rules", MIXED, `${TEXTS}/clean.md`],
    });

    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toBe("");
  });

  test("a directory is walked for drafts", async () => {
    const result = await run({ argv: ["check", "--dry-run", "--rules", MIXED, TEXTS] });

    expect(result.out).toContain("tests/fixtures/texts/closer.md");
    expect(result.out).toContain("tests/fixtures/texts/flagged.md");
  });
});

describe("consent", () => {
  test("no stored answer and no terminal prints the disclosure, sends nothing, and exits 3", async () => {
    const seen: JevRequest[] = [];
    const result = await run({
      argv: ["check", "--rules", MIXED, `${TEXTS}/closer.md`],
      client: stubClient(restating, seen),
    });

    expect(result.code).toBe(EXIT.consent);
    expect(seen).toEqual([]);
    expect(result.err).toContain("api.typesafe.ai");
  });

  test("--yes answers, and the answer is remembered outside the working directory", async () => {
    const seen: JevRequest[] = [];
    const home = sandbox();
    const result = await run({
      argv: ["check", "--yes", "--rules", MIXED, `${TEXTS}/closer.md`],
      client: stubClient(restating, seen),
      home,
    });

    expect(result.code).toBe(EXIT.flags);
    // A heading and a paragraph: one request each, never one for the file.
    expect(seen).toHaveLength(2);
    expect(existsSync(consentPath({ HOME: home }, home))).toBe(true);
    expect(existsSync(join(repoRoot, "consent.json"))).toBe(false);
  });

  test("SNIFFTEST_SEND=1 answers for CI", async () => {
    const seen: JevRequest[] = [];
    const home = sandbox();
    const result = await run({
      argv: ["check", "--rules", MIXED, `${TEXTS}/closer.md`],
      client: stubClient(restating, seen),
      env: { SNIFFTEST_SEND: "1" },
      home,
    });

    expect(result.code).toBe(EXIT.flags);
    expect(seen).toHaveLength(2);
    expect(existsSync(consentPath({ HOME: home }, home))).toBe(false);
  });

  test("a ruleset with no judgment rules never asks and never sends", async () => {
    const result = await run({
      argv: ["check", "--rules", "tests/fixtures/rules/pair.yaml", `${TEXTS}/flagged.md`],
    });

    expect(result.code).toBe(EXIT.flags);
    expect(result.err).not.toContain("api.typesafe.ai");
  });
});

describe("the judgment arm", () => {
  test("merges with the countable arm in reading order", async () => {
    const seen: JevRequest[] = [];
    const result = await run({
      argv: ["check", "--yes", "--rules", MIXED, `${TEXTS}/closer.md`],
      client: stubClient(restating, seen),
    });

    expect(result.out.split("\n")).toEqual([
      "tests/fixtures/texts/closer.md:3 dash_present 1.00 An em dash. Say it in two sentences.",
      "tests/fixtures/texts/closer.md:3 restating_closer 0.93 A closer that only restates. Cut it.",
    ]);
    expect(seen[1]?.state).toContain("In short, everything above is what we said.");
    expect(Object.keys(seen[0]?.questions ?? {})).toEqual(["restating_closer"]);
  });

  test("--threshold changes which readings are flags and the exit code with them", async () => {
    const seen: JevRequest[] = [];
    const base = ["check", "--yes", "--rules", MIXED, `${TEXTS}/clean.md`];

    const loose = await run({
      argv: [...base, "--threshold", "0.5"],
      client: stubClient(always({ restating_closer: 0.75 }), seen),
    });
    const strict = await run({
      argv: [...base, "--threshold", "0.8"],
      client: stubClient(always({ restating_closer: 0.75 }), seen),
    });

    expect(loose.code).toBe(EXIT.flags);
    expect(loose.out).toContain("restating_closer 0.75");
    expect(strict.code).toBe(EXIT.ok);
    expect(strict.out).toBe("");
  });

  test("a gateway failure keeps the countable flags and exits 2", async () => {
    const result = await run({
      argv: ["check", "--yes", "--rules", MIXED, `${TEXTS}/flagged.md`],
      client: {
        async ask(): Promise<JevResult> {
          throw new Error("jev returned 503");
        },
      },
    });

    expect(result.code).toBe(EXIT.failure);
    expect(result.out).toContain("dash_present");
    expect(result.err).toContain("503");
  });

  test("a missing key stops before consent and points at --dry-run", async () => {
    const home = sandbox();
    const result = await run({
      argv: ["check", "--rules", MIXED, `${TEXTS}/closer.md`],
      env: { TYPESAFE_API_KEY: undefined },
      home,
    });

    expect(result.code).toBe(EXIT.failure);
    expect(result.err).toContain("TYPESAFE_API_KEY");
    expect(result.err).toContain("--dry-run");
    expect(existsSync(consentPath({ HOME: home }, home))).toBe(false);
  });
});

describe("output formats", () => {
  test("--format json emits one array and nothing else", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--format", "json", "--rules", MIXED, `${TEXTS}/flagged.md`],
    });

    const parsed = JSON.parse(result.out) as Flag[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((flag) => flag.rule)).toEqual(["dash_present", "colon_heavy"]);
    expect(parsed[0]).toEqual({
      file: "tests/fixtures/texts/flagged.md",
      line: 6,
      rule: "dash_present",
      kind: "regex",
      probability: 1,
      message: "An em dash. Say it in two sentences.",
    });
  });

  test("a clean draft in json is an empty array, not an empty string", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--format", "json", "--rules", MIXED, `${TEXTS}/clean.md`],
    });

    expect(JSON.parse(result.out)).toEqual([]);
    expect(result.code).toBe(EXIT.ok);
  });

  test("rules prints the resolved ruleset and where it came from", async () => {
    const result = await run({ argv: ["rules", "--rules", MIXED] });

    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("dash_present");
    expect(result.out).toContain("restating_closer");
    expect(result.out).toContain(MIXED);
  });
});

describe("arguments and exit codes", () => {
  test("an unknown option, an unknown command and no paths are tool failures", async () => {
    expect((await run({ argv: ["check", "--sniff-harder", TEXTS] })).code).toBe(EXIT.failure);
    expect((await run({ argv: ["smell", TEXTS] })).code).toBe(EXIT.failure);
    expect((await run({ argv: ["check", "--dry-run"] })).code).toBe(EXIT.failure);
    expect((await run({ argv: [] })).code).toBe(EXIT.failure);
  });

  test("a path that is not there is a tool failure that names it", async () => {
    const result = await run({ argv: ["check", "--dry-run", "--rules", MIXED, "nope.md"] });

    expect(result.code).toBe(EXIT.failure);
    expect(result.err).toContain("nope.md");
  });

  test("a threshold outside 0 to 1 is refused", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--threshold", "7", "--rules", MIXED, TEXTS],
    });

    expect(result.code).toBe(EXIT.failure);
    expect(result.err).toContain("threshold");
  });

  test("help and version exit 0 and help names every exit code", async () => {
    const help = await run({ argv: ["--help"] });
    const version = await run({ argv: ["--version"] });

    expect(help.code).toBe(EXIT.ok);
    expect(version.code).toBe(EXIT.ok);
    for (const code of ["0", "1", "2", "3"]) expect(help.out).toContain(`  ${code}  `);
  });
});
