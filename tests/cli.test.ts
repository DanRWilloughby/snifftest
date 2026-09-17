import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EXIT, runCli } from "../src/cli.ts";
import { consentPath } from "../src/consent.ts";
import { type JevClient, type JevClientOptions, type JevRequest, type JevResult, createJevClient } from "../src/jev.ts";
import type { Flag } from "../src/types.ts";

/** The shape `check --format json` prints, as a reader of the output sees it. */
interface CheckJson {
  readonly tool: string;
  readonly threshold: number;
  readonly verdict: string;
  readonly judgment: {
    readonly state: string;
    readonly asked: number;
    readonly answered: number;
    readonly no_judgment: number;
    readonly unanswered: number;
    readonly skipped: readonly { readonly file: string; readonly line: number; readonly reason: string }[];
    readonly readings: readonly { readonly rule: string; readonly probability: number }[];
  };
  readonly flags: readonly Flag[];
}

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
  /** Builds the real gateway over a stubbed fetch, so the local guard is exercised. */
  readonly makeClient?: (options: JevClientOptions) => JevClient;
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
    createClient: (clientOptions) =>
      options.makeClient === undefined
        ? (options.client ?? forbiddenClient())
        : options.makeClient(clientOptions),
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
    // One paragraph, one request. The heading above it is structure, not writing.
    expect(seen).toHaveLength(1);
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
    expect(seen).toHaveLength(1);
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
    expect(seen[0]?.state).toContain("In short, everything above is what we said.");
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
  test("--format json carries the flags, the threshold and what the judgment arm did", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--format", "json", "--rules", MIXED, `${TEXTS}/flagged.md`],
    });

    const parsed = JSON.parse(result.out) as CheckJson;
    expect(parsed.tool).toBe("snifftest check");
    expect(parsed.threshold).toBe(0.7);
    expect(parsed.judgment.state).toBe("not run");
    expect(parsed.verdict).toContain("--dry-run");
    expect(parsed.flags.map((flag) => flag.rule)).toEqual(["dash_present", "colon_heavy"]);
    expect(parsed.flags[0]).toEqual({
      file: "tests/fixtures/texts/flagged.md",
      line: 6,
      rule: "dash_present",
      kind: "regex",
      probability: 1,
      message: "An em dash. Say it in two sentences.",
    });
  });

  test("a clean draft in json is an empty flag list, not an empty string", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--format", "json", "--rules", MIXED, `${TEXTS}/clean.md`],
    });

    expect((JSON.parse(result.out) as CheckJson).flags).toEqual([]);
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

describe("what the judgment arm says about itself", () => {
  /** An answers object with nothing usable in it, which is an HTTP 200 saying nothing. */
  const silent = always({});

  test("an arm that answers nothing is a tool failure, never a clean run", async () => {
    const seen: JevRequest[] = [];
    const result = await run({
      argv: ["check", "--yes", "--rules", MIXED, `${TEXTS}/clean.md`],
      client: stubClient(silent, seen),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(result.code).toBe(EXIT.failure);
    expect(result.err).toContain("answered none");
    expect(result.err).toContain("unanswered");
  });

  test("a flat middle answer is no judgment, and is counted as such", async () => {
    const seen: JevRequest[] = [];
    const result = await run({
      argv: ["check", "--yes", "--format", "json", "--rules", MIXED, `${TEXTS}/clean.md`],
      client: stubClient(always({ restating_closer: 0.5 }), seen),
    });

    const parsed = JSON.parse(result.out) as CheckJson;
    expect(parsed.judgment.state).toBe("answered nothing");
    expect(parsed.judgment.no_judgment).toBe(seen.length);
    expect(parsed.judgment.answered).toBe(0);
    expect(parsed.judgment.asked).toBe(seen.length);
    expect(parsed.verdict).toContain("no-judgment band");
    expect(result.code).toBe(EXIT.failure);
  });

  test("a reading inside the band is never a flag, however low the threshold is set", async () => {
    const seen: JevRequest[] = [];
    const result = await run({
      argv: ["check", "--yes", "--threshold", "0.4", "--rules", MIXED, `${TEXTS}/clean.md`],
      client: stubClient(always({ restating_closer: 0.45 }), seen),
    });

    expect(result.out).not.toContain("restating_closer");
    expect(result.code).toBe(EXIT.failure);
  });

  test("an answer outside 0 to 1 is unanswered, not a catch", async () => {
    const seen: JevRequest[] = [];
    const result = await run({
      argv: ["check", "--yes", "--format", "json", "--rules", MIXED, `${TEXTS}/clean.md`],
      client: stubClient(always({ restating_closer: 7 }), seen),
    });

    const parsed = JSON.parse(result.out) as CheckJson;
    expect(parsed.flags).toEqual([]);
    expect(parsed.judgment.unanswered).toBe(parsed.judgment.asked);
    expect(result.code).toBe(EXIT.failure);
  });

  test("json carries every reading, including the ones below the threshold", async () => {
    const seen: JevRequest[] = [];
    const result = await run({
      argv: ["check", "--yes", "--format", "json", "--rules", MIXED, `${TEXTS}/clean.md`],
      client: stubClient(always({ restating_closer: 0.12 }), seen),
    });

    const parsed = JSON.parse(result.out) as CheckJson;
    expect(parsed.flags).toEqual([]);
    expect(parsed.judgment.readings.map((r) => r.probability)).toEqual(
      new Array(parsed.judgment.asked).fill(0.12),
    );
    expect(parsed.judgment.state).toBe("answered");
    expect(result.code).toBe(EXIT.ok);
  });

  test("a paragraph the guard refuses is skipped by name, and the run finishes", async () => {
    const dir = sandbox();
    const draft = join(dir, "draft.md");
    writeFileSync(
      draft,
      "The first paragraph is ordinary prose and says a thing plainly.\n" +
        "\n" +
        "Here is an avatar: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg\n",
      "utf8",
    );

    const asked: string[] = [];
    const result = await run({
      argv: ["check", "--yes", "--format", "json", "--rules", resolve(repoRoot, MIXED), draft],
      cwd: dir,
      makeClient: (clientOptions) =>
        createJevClient({
          ...clientOptions,
          fetch: async (_url, init) => {
            asked.push(String(init.body));
            return new Response(
              JSON.stringify({
                model: "jev-test",
                answers: { restating_closer: { type: "noul", noul: 0.91 } },
                usage: { input_tokens: 40, output_tokens: 0 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }),
    });

    const parsed = JSON.parse(result.out) as CheckJson;
    expect(asked).toHaveLength(1);
    expect(parsed.judgment.skipped).toHaveLength(1);
    expect(parsed.judgment.skipped[0]?.file).toBe("draft.md");
    expect(parsed.judgment.skipped[0]?.line).toBe(3);
    expect(parsed.judgment.answered).toBe(1);
    expect(parsed.judgment.unanswered).toBe(1);
    expect(parsed.flags.map((flag) => flag.rule)).toEqual(["restating_closer"]);
    expect(result.err).toContain("skipped draft.md:3");
    expect(result.code).toBe(EXIT.flags);
  });

  test("a mid-run service failure keeps what was paid for and names what was not sent", async () => {
    const dir = sandbox();
    const draft = join(dir, "draft.md");
    writeFileSync(
      draft,
      "The first paragraph is ordinary prose and says a thing plainly.\n" +
        "\n" +
        "The second paragraph is also ordinary and also says a thing.\n" +
        "\n" +
        "The third paragraph closes the draft without any flourish.\n",
      "utf8",
    );

    let call = 0;
    const result = await run({
      argv: ["check", "--yes", "--format", "json", "--rules", resolve(repoRoot, MIXED), draft],
      cwd: dir,
      makeClient: (clientOptions) =>
        createJevClient({
          ...clientOptions,
          attempts: 1,
          fetch: async () => {
            call += 1;
            if (call > 1) return new Response("no", { status: 401 });
            return new Response(
              JSON.stringify({
                model: "jev-test",
                answers: { restating_closer: { type: "noul", noul: 0.95 } },
                usage: { input_tokens: 40, output_tokens: 0 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        }),
    });

    const parsed = JSON.parse(result.out) as CheckJson;
    expect(call).toBe(2);
    expect(parsed.judgment.answered).toBe(1);
    expect(parsed.judgment.skipped).toHaveLength(2);
    expect(parsed.judgment.skipped[1]?.reason).toContain("stopped");
    expect(parsed.flags.map((flag) => flag.rule)).toEqual(["restating_closer"]);
    expect(result.code).toBe(EXIT.flags);
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

// --- review fold-ins ------------------------------------------------------

describe("inputs that are not text", () => {
  const PLAIN = "A short paragraph that trips nothing at all, and ends where it ends.\n";

  test("a binary file is skipped by name and changes nothing else about the run", async () => {
    const dir = sandbox();
    const binary = join(dir, "logo.txt");
    const plain = join(dir, "plain.md");
    writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x00, 0x1a, 0x0a, 0x00]));
    writeFileSync(plain, PLAIN);

    const both = await run({ argv: ["check", "--dry-run", "--rules", MIXED, binary, plain] });
    const alone = await run({ argv: ["check", "--dry-run", "--rules", MIXED, plain] });

    expect(both.err).toContain("skipped, not text");
    expect(both.err).toContain("logo.txt");
    expect(both.code).toBe(alone.code);
    expect(both.out).toBe(alone.out);
  });

  test("a file that is not valid UTF-8 is skipped the same way", async () => {
    const dir = sandbox();
    const latin = join(dir, "latin1.md");
    writeFileSync(latin, Buffer.from([0x41, 0x20, 0xff, 0xfe, 0x20, 0x42]));
    writeFileSync(join(dir, "plain.md"), PLAIN);

    const result = await run({ argv: ["check", "--dry-run", "--rules", MIXED, dir] });

    expect(result.code).toBe(EXIT.ok);
    expect(result.err).toContain("latin1.md");
    expect(result.err).toContain("skipped, not text");
  });
});

describe("a mistyped key in a project ruleset", () => {
  const RULESET = `version: 1
endpoint: https://api.example.invalid/v1
rules:
  - id: dash_present
    kind: regex
    builtin: dash_present
    message: "An em dash. Say it in two sentences."
`;

  test("is named as a warning rather than silently ignored", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, ".snifftest.yaml"), RULESET);

    const result = await run({ argv: ["rules"], cwd: dir });

    expect(result.code).toBe(EXIT.ok);
    expect(result.err).toContain("endpoint");
    expect(result.err).toContain(".snifftest.yaml");
    expect(result.out).toContain("dash_present");
  });

  test("the warning does not reach a run that uses the file for real", async () => {
    const dir = sandbox();
    writeFileSync(join(dir, ".snifftest.yaml"), RULESET);
    writeFileSync(join(dir, "plain.md"), "A paragraph with nothing in it to flag.\n");

    const result = await run({ argv: ["check", "--dry-run", "plain.md"], cwd: dir });

    expect(result.code).toBe(EXIT.ok);
    expect(result.err).toContain("endpoint");
    expect(result.out).toBe("");
  });
});

describe("choosing rules by tag", () => {
  const TAGGED = "tests/fixtures/rules/tagged.yaml";

  test("a tagged rule sits out an ordinary run and stderr says which tag kept it out", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--rules", TAGGED, `${TEXTS}/flagged.md`],
    });

    expect(result.out).toContain("dash_present");
    expect(result.out).not.toContain("colon_heavy");
    expect(result.err).toContain('colon_heavy sat this run out: the tag "marketing" is off by default.');
  });

  test("--only names the tag, which runs those rules and nothing else", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--rules", TAGGED, "--only", "marketing", `${TEXTS}/flagged.md`],
    });

    expect(result.out).toContain("colon_heavy");
    expect(result.out).not.toContain("dash_present");
  });

  test("--skip takes a rule out of a run that would otherwise include it", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--rules", MIXED, "--skip", "house", `${TEXTS}/flagged.md`],
    });

    expect(result.out).toContain("colon_heavy");
    expect(result.out).not.toContain("dash_present");
  });

  test("an empty tag list is a usage error rather than a silent no-op", async () => {
    const result = await run({
      argv: ["check", "--dry-run", "--rules", TAGGED, "--only", " ,", `${TEXTS}/flagged.md`],
    });

    expect(result.code).toBe(EXIT.failure);
    expect(result.err).toContain("--only needs at least one tag.");
  });

  test("rules prints each rule's tags and says which sit out by default", async () => {
    const result = await run({ argv: ["rules", "--rules", TAGGED] });

    expect(result.out).toContain("off by default, unless --only names one: marketing");
    expect(result.out).toContain("[marketing]");
    expect(result.out).toContain("(off by default)");
  });
});
