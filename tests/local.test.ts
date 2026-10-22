import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CACHE_DIR_ENV } from "../src/cache.ts";
import { EXIT, runCli } from "../src/cli.ts";
import {
  type JevClient,
  type JevRequest,
  type JevResult,
  JevHttpError,
  JevRequestError,
  isTransientFailure,
  questionsFromRules,
} from "../src/jev.ts";
import { chatEndpoint, createLocalClient, isLoopback } from "../src/local.ts";
import type { JudgmentRule } from "../src/types.ts";

const repoRoot = resolve(import.meta.dir, "..");
const MIXED = "tests/fixtures/rules/mixed.yaml";
const CLOSER = "tests/fixtures/texts/closer.md";
const LOCAL = "http://localhost:11434/v1";

const temporary: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-local-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const RULE: JudgmentRule = {
  id: "restating_closer",
  kind: "judgment",
  what: "The closing sentence only restates what the paragraph already said.",
  not_for: "A closing sentence that draws a conclusion.",
  examples: ["In short, everything above is what we said."],
  criteria: { true: "It adds nothing.", false: "It adds something." },
  message: "A closer that only restates. Cut it.",
};

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly redirect: RequestInit["redirect"];
}

/** A Chat Completions server that answers every request with `content`. */
function server(content: string, sent: Sent[], status = 200) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, redirect: init.redirect });
    if (status !== 200) return new Response('{"error":"model not found, try pulling it first"}', { status });
    return Response.json({
      model: "qwen3.8:27b",
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 410, completion_tokens: 22 },
    });
  };
}

const FLAGGED = '{"restating_closer": {"flag": true, "p": 0.93}}';

function ask(client: JevClient): Promise<JevResult> {
  const request: JevRequest = {
    state: "We changed it. In short, we changed it.",
    questions: questionsFromRules([RULE]),
  };
  return client.ask(request);
}

describe("the local client", () => {
  test("asks the bench's question and reads the probability as the answer", async () => {
    const sent: Sent[] = [];
    const client = createLocalClient({ url: `${LOCAL}/`, model: "qwen3.8:27b", fetch: server(FLAGGED, sent) });

    const result = await ask(client);

    expect(sent[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(sent[0]?.body["model"]).toBe("qwen3.8:27b");
    expect(sent[0]?.body["temperature"]).toBe(0);
    // A server asked nothing about consent must not be able to forward the paragraph.
    expect(sent[0]?.redirect).toBe("error");
    const messages = sent[0]?.body["messages"] as { role: string; content: string }[];
    expect(messages[0]?.content).toContain("[restating_closer] The closing sentence only restates");
    expect(messages[0]?.content).toContain("does not count: A closing sentence that draws a conclusion.");
    expect(messages[1]?.content).toBe("PARAGRAPH:\nWe changed it. In short, we changed it.");
    expect(result.nouls).toEqual({ restating_closer: 0.93 });
    expect(result.model).toBe("qwen3.8:27b");
    expect(result.inputTokens).toBe(410);
    expect(result.estimatedCostUsd).toBe(0);
    expect(client.model).toBe("qwen3.8:27b");
  });

  test("a thinking block in front of the answer is not the answer", async () => {
    const client = createLocalClient({
      url: LOCAL,
      model: "qwen3.8:27b",
      fetch: server(`<think>\nThe last sentence repeats.\n</think>\n${FLAGGED}`, []),
    });

    expect((await ask(client)).nouls).toEqual({ restating_closer: 0.93 });
  });

  test("a reply that is not the asked-for JSON is a failure, never a clean paragraph", async () => {
    const client = createLocalClient({ url: LOCAL, model: "tiny", fetch: server("Looks fine to me!", []) });

    const failure = await ask(client).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JevRequestError);
    expect(String(failure)).toContain("tiny did not answer in the shape asked for");
  });

  test("a reply under names of the model's own says so, instead of a silent unanswered", async () => {
    // What qwen3:1.7b sent back from a live Ollama, 2026-10-22.
    const reply = '{"rule_1": {"flag": false, "p": 0}, "rule_2": {"flag": false, "p": 0}}';
    const client = createLocalClient({ url: LOCAL, model: "qwen3:1.7b", fetch: server(reply, []) });

    const failure = await ask(client).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JevRequestError);
    expect(String(failure)).toContain(
      "qwen3:1.7b answered none of the rules it was asked about, and used names it was not given (rule_1, rule_2)",
    );
  });

  test("a model the server does not have stops the arm at once, with the server's reason", async () => {
    const client = createLocalClient({ url: LOCAL, model: "missing", fetch: server("", [], 404) });

    const failure = await ask(client).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JevHttpError);
    expect(String(failure)).toContain("model not found, try pulling it first");
    expect(isTransientFailure(failure)).toBe(false);
  });

  test("a server that is not running says so", async () => {
    const client = createLocalClient({
      url: LOCAL,
      model: "qwen3.8:27b",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const failure = await ask(client).catch((error: unknown) => error);

    expect(String(failure)).toContain(`could not reach the model server at ${chatEndpoint(LOCAL)} (is it running?)`);
  });
});

describe("what counts as this machine", () => {
  test.each([
    ["http://localhost:11434/v1", true],
    ["http://127.0.0.1:1234/v1", true],
    ["http://[::1]:8080/v1", true],
    ["http://192.168.1.20:11434/v1", false],
    ["https://models.example.com/v1", false],
    ["http://localhost.example.com/v1", false],
    ["not a url", false],
  ])("%s is loopback: %p", (url, expected) => {
    expect(isLoopback(url)).toBe(expected);
  });
});

/** A Jev client that must never be reached: the local judge replaces it. */
function forbiddenJev(): JevClient {
  return {
    async ask(): Promise<JevResult> {
      throw new Error("Jev was asked when a local judge was named");
    },
  };
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function check(
  argv: readonly string[],
  fetchLike: (url: string, init: RequestInit) => Promise<Response>,
  env: Record<string, string> = {},
  home: string = sandbox(),
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv: ["check", "--rules", MIXED, ...argv, CLOSER],
    env: { HOME: home, [CACHE_DIR_ENV]: "off", ...env },
    cwd: repoRoot,
    homedir: home,
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    isTty: false,
    createClient: () => forbiddenJev(),
    fetchLike,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("check with a judge of your own", () => {
  test("on this machine: no key, no send question, and the flag comes from the local model", async () => {
    const sent: Sent[] = [];
    const result = await check(["--judge-url", LOCAL, "--judge-model", "qwen3.8:27b"], server(FLAGGED, sent));

    expect(result.code).toBe(EXIT.flags);
    expect(sent.length).toBe(1);
    expect(result.out).toContain("restating_closer 0.93 A closer that only restates. Cut it.");
    expect(result.err).not.toContain("Sniff Test is about to use the judgment rules");
    expect(result.err).toContain("the judgment rules are answered by qwen3.8:27b at http://localhost:11434/v1");
    expect(result.err).toContain("qwen3.8:27b: 1 request, 410 input tokens, nothing billed");
  });

  test("the environment names the judge as well as the flags do", async () => {
    const sent: Sent[] = [];
    const result = await check([], server(FLAGGED, sent), {
      SNIFFTEST_JUDGE_URL: LOCAL,
      SNIFFTEST_JUDGE_MODEL: "qwen3.8:27b",
    });

    expect(result.code).toBe(EXIT.flags);
    expect(sent.length).toBe(1);
  });

  test("--quiet keeps the accuracy notice and the usage line out", async () => {
    const result = await check(
      ["--quiet", "--judge-url", LOCAL, "--judge-model", "qwen3.8:27b"],
      server(FLAGGED, []),
    );

    expect(result.err).not.toContain("is answered by");
    expect(result.err).not.toContain("nothing billed");
  });

  test("another machine is a destination, asked about by its host, and nothing is sent without a yes", async () => {
    const sent: Sent[] = [];
    const result = await check(
      ["--judge-url", "http://192.168.1.20:11434/v1", "--judge-model", "qwen3.8:27b"],
      server(FLAGGED, sent),
      { SNIFFTEST_SEND: "1" },
    );

    expect(result.code).toBe(EXIT.consent);
    expect(sent).toEqual([]);
    expect(result.err).toContain(
      "Where it goes: http://192.168.1.20:11434/v1/chat/completions (model server at 192.168.1.20:11434).",
    );
    expect(result.err).toContain("SNIFFTEST_SEND=model server at 192.168.1.20:11434");
  });

  test("another machine runs once it has its yes", async () => {
    const sent: Sent[] = [];
    const result = await check(
      ["--yes", "--judge-url", "http://192.168.1.20:11434/v1", "--judge-model", "qwen3.8:27b"],
      server(FLAGGED, sent),
    );

    expect(result.code).toBe(EXIT.flags);
    expect(sent.length).toBe(1);
  });

  test("half a setting is an error, not a quiet fall back to Jev", async () => {
    const noModel = await check(["--judge-url", LOCAL], server(FLAGGED, []));
    const noUrl = await check(["--judge-model", "qwen3.8:27b"], server(FLAGGED, []));
    const badUrl = await check(["--judge-url", "localhost:11434", "--judge-model", "x"], server(FLAGGED, []));

    expect(noModel.code).toBe(EXIT.failure);
    expect(noModel.err).toContain("a judge server was named without a model");
    expect(noUrl.code).toBe(EXIT.failure);
    expect(noUrl.err).toContain("a judge model was named without a server");
    expect(badUrl.code).toBe(EXIT.failure);
  });

  test("--dry-run still sends nothing at all", async () => {
    const sent: Sent[] = [];
    await check(["--dry-run", "--judge-url", LOCAL, "--judge-model", "qwen3.8:27b"], server(FLAGGED, sent));

    expect(sent).toEqual([]);
  });

  test("a local model's answers are cached under its own name, never Jev's", async () => {
    const home = sandbox();
    const env = { [CACHE_DIR_ENV]: join(home, "cache") };
    const out: string[] = [];
    const jevAsked: JevRequest[] = [];
    // Jev answers first and its answer is cached.
    await runCli({
      argv: ["check", "--yes", "--rules", MIXED, CLOSER],
      env: { HOME: home, TYPESAFE_API_KEY: "test-key-not-a-real-credential", ...env },
      cwd: repoRoot,
      homedir: home,
      write: (line) => out.push(line),
      writeError: () => undefined,
      isTty: false,
      createClient: () => ({
        async ask(request: JevRequest): Promise<JevResult> {
          jevAsked.push(request);
          return {
            model: "jev-1.13.0",
            nouls: { restating_closer: 0.05 },
            inputTokens: 100,
            outputTokens: 0,
            estimatedCostUsd: 0,
            usageReported: true,
            latencyMs: 1,
            attempts: 1,
          };
        },
      }),
    });
    expect(jevAsked.length).toBe(1);

    const first: Sent[] = [];
    const local = await check(["--judge-url", LOCAL, "--judge-model", "qwen3.8:27b"], server(FLAGGED, first), env, home);
    const again: Sent[] = [];
    await check(["--judge-url", LOCAL, "--judge-model", "qwen3.8:27b"], server(FLAGGED, again), env, home);

    expect(first.length).toBe(1);
    expect(local.out).toContain("restating_closer 0.93");
    expect(again).toEqual([]);
  });
});
