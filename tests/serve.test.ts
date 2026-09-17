import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { CliDeps } from "../src/cli.ts";
import { runCli } from "../src/cli.ts";
import { resolveRuleset } from "../src/config.ts";
import { chunkDocument, runRegexArm } from "../src/engine.ts";
import type { JevClient, JevRequest, JevResult } from "../src/jev.ts";
import { type ServeHandle, serve } from "../src/serve/command.ts";
import { type PageConfig, renderPage } from "../src/serve/page.ts";
import { ReplayError, createReplayClient, loadReplay, replaysDir } from "../src/serve/replay.ts";
import { createScorer, reactionFor } from "../src/serve/score.ts";
import { DEFAULT_PORT, LOOPBACK, MAX_BODY_BYTES, ServeError, startServer } from "../src/serve/server.ts";

const repoRoot = resolve(import.meta.dir, "..");
const MIXED = join(repoRoot, "tests/fixtures/rules/mixed.yaml");
const FIXTURE_REPLAYS = join(repoRoot, "tests/fixtures/serve/replays");
const FAKE_KEY = "tsk_test_0123456789abcdefghijklmnopqrstuv";

const temporary: string[] = [];
const running: ServeHandle[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-serve-"));
  temporary.push(dir);
  return dir;
}

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// --- helpers --------------------------------------------------------------

interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** node:http rather than fetch, so a test can lie about Host and Origin. */
function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Reply> {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: LOOPBACK,
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: { host: `${LOOPBACK}:${port}`, ...(options.headers ?? {}) },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (part: Buffer) => parts.push(part));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** POST /score with a chunked body and no content-length; resolves to the status code. */
function sendChunked(port: number, body: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, LOOPBACK, () => {
      socket.write(
        `POST /score HTTP/1.1\r\nHost: ${LOOPBACK}:${port}\r\nOrigin: http://${LOOPBACK}:${port}\r\n` +
          "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
      );
      const payload = Buffer.from(body, "utf8");
      const piece = 64 * 1024;
      for (let at = 0; at < payload.length; at += piece) {
        const part = payload.subarray(at, at + piece);
        socket.write(`${part.length.toString(16)}\r\n`);
        socket.write(part);
        socket.write("\r\n");
      }
      socket.write("0\r\n\r\n");
    });
    let reply = "";
    socket.on("data", (part: Buffer) => (reply += part.toString("utf8")));
    socket.on("error", reject);
    socket.on("close", () => resolvePromise(Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0)));
  });
}

function scorePost(port: number, draft: string, headers: Record<string, string> = {}): Promise<Reply> {
  return send(port, {
    method: "POST",
    path: "/score",
    headers: {
      "content-type": "application/json",
      origin: `http://${LOOPBACK}:${port}`,
      ...headers,
    },
    body: JSON.stringify({ draft }),
  });
}

function stubClient(answer: (state: string) => Record<string, number>, seen: JevRequest[]): JevClient {
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

function forbiddenClient(): JevClient {
  return {
    async ask(): Promise<JevResult> {
      throw new Error("the network was used when it should not have been");
    },
  };
}

const mixed = () => resolveRuleset({ cwd: repoRoot, rulesPath: MIXED }).ruleset;

const PAGE: PageConfig = {
  mode: "replay",
  judged: true,
  debounceMs: 500,
  threshold: 0.7,
  holdForRecordedLatency: true,
  modeLine: "Replay. Test fixture.",
  meterLabel: "replayed",
};

async function replayServer(): Promise<ServeHandle> {
  const replay = loadReplay("ok.json", { cwd: FIXTURE_REPLAYS, replaysDir: FIXTURE_REPLAYS });
  const handle = await startServer({
    port: 0,
    scorer: createScorer({ ruleset: mixed(), threshold: 0.7, client: createReplayClient(replay.file) }),
    page: PAGE,
    replayName: replay.name,
    secrets: [FAKE_KEY],
  });
  running.push(handle);
  return handle;
}

interface ServeRun {
  readonly handle: ServeHandle;
  readonly done: Promise<number>;
  readonly err: string[];
  readonly stop: () => void;
}

/** Runs the real `serve` command on port 0 and hands back the live server. */
async function runServe(argv: string[], overrides: Partial<CliDeps> = {}): Promise<ServeRun> {
  const err: string[] = [];
  const controller = new AbortController();
  const deps: CliDeps = {
    argv: ["serve", "--port", "0", ...argv],
    env: {},
    cwd: sandbox(),
    homedir: sandbox(),
    write: () => {},
    writeError: (line) => err.push(line),
    isTty: false,
    ...overrides,
  };

  let done: Promise<number> = Promise.resolve(-1);
  const handle = await new Promise<ServeHandle>((resolvePromise, reject) => {
    done = serve(deps, { signal: controller.signal, onListening: resolvePromise });
    done.then((code) => reject(new Error(`serve exited ${code} before listening: ${err.join(" | ")}`)), reject);
  });
  return { handle, done, err, stop: () => controller.abort() };
}

// --- the bind -------------------------------------------------------------

describe("serve: where it listens", () => {
  test("binds 127.0.0.1 and nothing else", async () => {
    const handle = await replayServer();
    expect(handle.address).toBe("127.0.0.1");
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`);
  });

  test.each(["0.0.0.0", "::", "::1", "localhost", "192.168.1.20", "example.com"])(
    "refuses to bind %s even when asked",
    async (host) => {
      const attempt = startServer({
        port: 0,
        host,
        scorer: createScorer({ ruleset: mixed(), threshold: 0.7 }),
        page: PAGE,
        secrets: [],
      });
      await expect(attempt).rejects.toBeInstanceOf(ServeError);
    },
  );

  test("the command refuses --host 0.0.0.0 with exit 2 and never listens", async () => {
    const err: string[] = [];
    const code = await runCli({
      argv: ["serve", "--host", "0.0.0.0", "--port", "0"],
      env: {},
      cwd: sandbox(),
      homedir: sandbox(),
      write: () => {},
      writeError: (line) => err.push(line),
      isTty: false,
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("127.0.0.1");
  });

  test("the default port is the plan's placeholder", () => {
    expect(DEFAULT_PORT).toBe(4747);
  });
});

// --- the walls on every request ---------------------------------------------

describe("serve: the walls", () => {
  test("a Host header that is not the loopback address is refused (DNS rebinding)", async () => {
    const { port } = await replayServer();
    for (const host of ["evil.example", `evil.example:${port}`, `localhost:${port}`, `127.0.0.1:${port + 1}`]) {
      const reply = await send(port, { headers: { host } });
      expect(reply.status).toBe(421);
      expect(reply.body).not.toContain("<html");
    }
    const post = await scorePost(port, "A draft.", { host: "evil.example" });
    expect(post.status).toBe(421);
  });

  test("the page carries a strict CSP with a fresh nonce and no unsafe-inline", async () => {
    const { port } = await replayServer();
    const first = await send(port, {});
    const second = await send(port, {});
    const csp = String(first.headers["content-security-policy"]);

    expect(first.status).toBe(200);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https?:|\*/);

    const nonce = /script-src 'nonce-([A-Za-z0-9+/=_-]{16,})'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(first.body).toContain(`<script nonce="${nonce}">`);
    expect(first.body).toContain(`<style nonce="${nonce}">`);
    expect(String(second.headers["content-security-policy"])).not.toContain(String(nonce));
  });

  test("every inline script and style carries the nonce, and no element has a style attribute", async () => {
    const { port } = await replayServer();
    const { body } = await send(port, {});
    const scripts = body.match(/<script\b[^>]*>/g) ?? [];
    const styles = body.match(/<style\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    expect(styles.length).toBeGreaterThan(0);
    for (const tag of [...scripts, ...styles]) expect(tag).toMatch(/ nonce="[^"]+"/);
    expect(body).not.toMatch(/<[^>]+\sstyle=/);
    expect(body).not.toMatch(/\son[a-z]+=/);
  });

  test("no response ever carries a CORS header, and a preflight is not approved", async () => {
    const { port } = await replayServer();
    const replies = [
      await send(port, {}),
      await send(port, { path: "/favicon.svg" }),
      await send(port, { path: "/nope" }),
      await scorePost(port, "A draft."),
      await send(port, {
        method: "OPTIONS",
        path: "/score",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      }),
    ];
    for (const reply of replies) {
      for (const name of Object.keys(reply.headers)) expect(name.startsWith("access-control-")).toBe(false);
      expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      expect(reply.headers["cache-control"]).toBe("no-store");
    }
    expect(replies[4]?.status).toBe(405);
  });

  test("scoring is POST only", async () => {
    const { port } = await replayServer();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const reply = await send(port, { method, path: "/score" });
      expect(reply.status).toBe(405);
      expect(reply.headers["allow"]).toBe("POST");
    }
  });

  test("a POST from another origin, or from no origin at all, is refused", async () => {
    const { port } = await replayServer();
    const foreign = await scorePost(port, "A draft.", { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);

    const nullOrigin = await scorePost(port, "A draft.", { origin: "null" });
    expect(nullOrigin.status).toBe(403);

    const none = await send(port, {
      method: "POST",
      path: "/score",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft: "A draft." }),
    });
    expect(none.status).toBe(403);

    const crossSite = await scorePost(port, "A draft.", { "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
  });

  test("a form post is refused, because only JSON forces a preflight", async () => {
    const { port } = await replayServer();
    const reply = await scorePost(port, "A draft.", { "content-type": "text/plain" });
    expect(reply.status).toBe(415);
  });

  test("a body over the cap is 413, by declared length and by actual length", async () => {
    const { port } = await replayServer();
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const declared = await scorePost(port, big);
    expect(declared.status).toBe(413);

    // No declared length at all: written to the socket by hand, because an HTTP
    // client library works out a content-length before it sends.
    const chunked = await sendChunked(port, JSON.stringify({ draft: big }));
    expect(chunked).toBe(413);
  });

  test("a body that is not the expected JSON is 400, in plain words", async () => {
    const { port } = await replayServer();
    for (const body of ["{", "[]", JSON.stringify({ draft: 7 }), JSON.stringify({})]) {
      const reply = await send(port, {
        method: "POST",
        path: "/score",
        headers: { "content-type": "application/json", origin: `http://${LOOPBACK}:${port}` },
        body,
      });
      expect(reply.status).toBe(400);
      expect(typeof (JSON.parse(reply.body) as { error: unknown }).error).toBe("string");
    }
  });

  test("anything else is a 404, and a path is never read from disk", async () => {
    const { port } = await replayServer();
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/src/cli.ts", "/score/"]) {
      const reply = await send(port, { path });
      expect(reply.status).toBe(404);
      expect(reply.body).not.toContain("snifftest");
    }
  });

  test("a failure that quotes the key comes back with the key taken out", async () => {
    const leaky: JevClient = {
      async ask(): Promise<JevResult> {
        throw new Error(`the service rejected Bearer ${FAKE_KEY} and said so`);
      },
    };
    const handle = await startServer({
      port: 0,
      scorer: createScorer({ ruleset: mixed(), threshold: 0.7, client: leaky }),
      page: { ...PAGE, mode: "live" },
      secrets: [FAKE_KEY],
    });
    running.push(handle);

    const reply = await scorePost(handle.port, "A dash — here. In short, this is what we said.");
    const result = JSON.parse(reply.body) as { flags: { rule: string }[]; problem: string };
    // The countable flag survives the failure, as it does in `check`.
    expect(reply.status).toBe(200);
    expect(result.flags.map((flag) => flag.rule)).toEqual(["dash_present"]);
    expect(result.problem).toContain("rejected");
    expect(reply.body).not.toContain(FAKE_KEY);
    expect(reply.body).not.toContain(FAKE_KEY.slice(0, 16));
    expect(reply.body).toContain("[key hidden]");
  });
});

// --- replay mode ------------------------------------------------------------

describe("serve: replay mode", () => {
  test("declares itself twice: the response header and the meta tag", async () => {
    const { port } = await replayServer();
    const reply = await send(port, {});
    expect(reply.headers["x-snifftest-replay"]).toBe("ok.json");
    expect(reply.body).toMatch(/<meta name="snifftest-mode" content="replay"\s*\/?>/);
  });

  test("a live page declares neither", async () => {
    const handle = await startServer({
      port: 0,
      scorer: createScorer({ ruleset: mixed(), threshold: 0.7 }),
      page: { ...PAGE, mode: "live", judged: false, holdForRecordedLatency: false },
      secrets: [],
    });
    running.push(handle);
    const reply = await send(handle.port, {});
    expect(reply.headers["x-snifftest-replay"]).toBeUndefined();
    expect(reply.body).toMatch(/<meta name="snifftest-mode" content="live"\s*\/?>/);
  });

  test("answers come from the recorded file, the most specific match last, and carry ms and usd", async () => {
    const { port } = await replayServer();

    const clean = JSON.parse((await scorePost(port, "A plain sentence that ends.")).body);
    expect(clean.flags).toEqual([]);
    expect(clean.reaction).toBe("approve");
    expect(clean.ms).toBe(40);
    expect(clean.usd).toBeCloseTo(0.0000042, 10);

    const flagged = JSON.parse((await scorePost(port, "We said a thing. In short, we said it.")).body);
    expect(flagged.flags).toHaveLength(1);
    expect(flagged.flags[0]).toMatchObject({ rule: "restating_closer", kind: "judgment", probability: 0.93 });
    expect(flagged.reaction).toBe("recoil");
    expect(flagged.ms).toBe(412);
    expect(flagged.usd).toBeCloseTo(0.0000084, 10);

    const borderline = JSON.parse((await scorePost(port, "We said a thing. In short, maybe we said it.")).body);
    expect(borderline.flags[0].probability).toBe(0.74);
    expect(borderline.reaction).toBe("twitch");
  });

  test("never calls out: a fetch that throws is never reached", async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("replay mode reached the network");
    }) as unknown as typeof fetch;
    try {
      const { port } = await replayServer();
      const reply = await scorePost(port, "First — a dash. In short, we said it.");
      expect(reply.status).toBe(200);
      expect((JSON.parse(reply.body) as { flags: unknown[] }).flags.length).toBe(2);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("only files inside the replays directory are served", () => {
    const options = { cwd: FIXTURE_REPLAYS, replaysDir: FIXTURE_REPLAYS };
    expect(loadReplay("ok.json", options).name).toBe("ok.json");
    expect(loadReplay(join(FIXTURE_REPLAYS, "ok.json"), options).file.runDate).toBe("2026-01-02");

    for (const path of [
      "../outside.json",
      join(FIXTURE_REPLAYS, "..", "outside.json"),
      "../../../../package.json",
      "/etc/passwd",
      "ok.json/../../outside.json",
    ]) {
      expect(() => loadReplay(path, options)).toThrow(ReplayError);
    }
  });

  test("a symlink inside the directory that points outside it is refused", () => {
    const dir = sandbox();
    symlinkSync(join(repoRoot, "tests/fixtures/serve/outside.json"), join(dir, "sneaky.json"));
    expect(() => loadReplay("sneaky.json", { cwd: dir, replaysDir: dir })).toThrow(ReplayError);
  });

  test("a file that is not a replay is refused by name, not half-loaded", () => {
    expect(() => loadReplay("broken.json", { cwd: FIXTURE_REPLAYS, replaysDir: FIXTURE_REPLAYS })).toThrow(
      /broken\.json/,
    );
    expect(() => loadReplay("missing.json", { cwd: FIXTURE_REPLAYS, replaysDir: FIXTURE_REPLAYS })).toThrow(
      ReplayError,
    );
  });

  test("the shipped example sits in examples/replays, loads, and says its numbers are not measured", () => {
    expect(replaysDir()).toBe(join(repoRoot, "examples", "replays"));
    const example = loadReplay("example.json", { cwd: replaysDir() });
    expect(example.file.measured).toBe(false);
    expect(example.file.runDate).toBeNull();
    expect(example.file.responses.length).toBeGreaterThan(0);
  });

  test("the command serves a replay end to end and never asks for consent or a key", async () => {
    const run = await runServe(["--replay", join(repoRoot, "examples/replays/example.json")], {
      createClient: forbiddenClient,
    });
    const page = await send(run.handle.port, {});
    expect(page.headers["x-snifftest-replay"]).toBe("example.json");
    expect(page.body).toContain("Example numbers");

    const reply = await scorePost(run.handle.port, "A plain sentence that ends.");
    expect(reply.status).toBe(200);

    run.stop();
    expect(await run.done).toBe(0);
  });

  test("the command refuses a replay outside examples/replays with exit 2", async () => {
    const err: string[] = [];
    const code = await serve({
      argv: ["serve", "--port", "0", "--replay", join(repoRoot, "tests/fixtures/serve/outside.json")],
      env: {},
      cwd: repoRoot,
      homedir: sandbox(),
      write: () => {},
      writeError: (line) => err.push(line),
      isTty: false,
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("examples/replays");
  });
});

// --- live mode and the consent gate -----------------------------------------

describe("serve: live mode asks before anything leaves", () => {
  test("no recorded yes: the judgment client is never built, never asked, and the page says so", async () => {
    let built = 0;
    const run = await runServe(["--rules", MIXED], {
      env: { TYPESAFE_API_KEY: FAKE_KEY },
      createClient: () => {
        built += 1;
        return forbiddenClient();
      },
    });

    const reply = await scorePost(run.handle.port, "First — a dash. In short, we said it.");
    const result = JSON.parse(reply.body) as { judged: boolean; flags: { rule: string }[]; usd: number };
    expect(reply.status).toBe(200);
    expect(result.judged).toBe(false);
    expect(result.flags.map((flag) => flag.rule)).toEqual(["dash_present"]);
    expect(result.usd).toBe(0);
    expect(built).toBe(0);

    const page = await send(run.handle.port, {});
    expect(page.body).toContain("Nothing leaves this machine");
    expect(run.err.join("\n")).toContain("What leaves this machine");

    run.stop();
    await run.done;
  });

  test("no key: countable rules only, and nobody is asked to agree to a request that cannot happen", async () => {
    const run = await runServe(["--rules", MIXED, "--yes"], { createClient: forbiddenClient });
    const result = JSON.parse((await scorePost(run.handle.port, "In short, we said it.")).body);
    expect(result.judged).toBe(false);
    expect(run.err.join("\n")).toContain("TYPESAFE_API_KEY");
    expect(run.err.join("\n")).not.toContain("What leaves this machine");
    run.stop();
    await run.done;
  });

  test("with --yes and a key the judgment rules run, and the gateway's own usage reaches the meter", async () => {
    const seen: JevRequest[] = [];
    const run = await runServe(["--rules", MIXED, "--yes"], {
      env: { TYPESAFE_API_KEY: FAKE_KEY },
      createClient: () => stubClient((state) => ({ restating_closer: state.includes("In short") ? 0.93 : 0.04 }), seen),
    });

    const reply = await scorePost(run.handle.port, "A first paragraph.\n\nWe said it. In short, we said it.");
    const result = JSON.parse(reply.body);
    expect(result.judged).toBe(true);
    expect(seen).toHaveLength(2);
    expect(result.ms).toBe(22);
    expect(result.usd).toBeCloseTo(2 * 120 * 0.042e-6, 12);
    expect(result.flags[0]).toMatchObject({ rule: "restating_closer", line: 3, reaction: "recoil" });

    run.stop();
    await run.done;
  });

  test("the key never reaches the browser: not in the page, not in a header, not in an answer", async () => {
    const run = await runServe(["--rules", MIXED, "--yes"], {
      env: { TYPESAFE_API_KEY: FAKE_KEY },
      createClient: () => stubClient(() => ({ restating_closer: 0.9 }), []),
    });
    const replies = [
      await send(run.handle.port, {}),
      await send(run.handle.port, { path: "/favicon.svg" }),
      await scorePost(run.handle.port, "In short, we said it."),
    ];
    for (const reply of replies) {
      expect(reply.body).not.toContain(FAKE_KEY.slice(0, 12));
      expect(JSON.stringify(reply.headers)).not.toContain(FAKE_KEY.slice(0, 12));
    }
    run.stop();
    await run.done;
  });

  test("a session writes nothing: no draft, no log, no cache file, anywhere it could", async () => {
    const cwd = sandbox();
    const home = sandbox();
    const run = await runServe(["--rules", MIXED], {
      cwd,
      homedir: home,
      env: { TYPESAFE_API_KEY: FAKE_KEY, SNIFFTEST_SEND: "1" },
      createClient: () => stubClient(() => ({ restating_closer: 0.9 }), []),
    });
    for (const draft of ["One.", "One. Two — three.", "In short, we said it."]) {
      await scorePost(run.handle.port, draft);
    }
    run.stop();
    await run.done;

    expect(readdirSync(cwd)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test("the serve sources import nothing that writes", () => {
    const dir = join(repoRoot, "src/serve");
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
      const source = readFileSync(join(dir, name), "utf8");
      expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir|openSync|localStorage/);
    }
  });
});

// --- the scorer -------------------------------------------------------------

describe("serve: scoring a draft", () => {
  test("a countable flag points at the words, a paragraph rule at the paragraph", async () => {
    const scorer = createScorer({ ruleset: mixed(), threshold: 0.7 });
    const draft = "A calm opener.\n\nOne: two: three: and a dash — here.";
    const result = await scorer.score(draft);

    const dash = result.flags.find((flag) => flag.rule === "dash_present");
    const colons = result.flags.find((flag) => flag.rule === "colon_heavy");
    expect(dash?.scope).toBe("span");
    expect(draft.slice(dash?.start, dash?.end)).toBe("dash — here");
    expect(dash?.line).toBe(3);
    expect(dash?.reaction).toBe("wrinkle");

    expect(colons?.scope).toBe("paragraph");
    expect(draft.slice(colons?.start, colons?.end)).toBe("One: two: three: and a dash — here.");
    expect(result.reaction).toBe("wrinkle");
    expect(result.judged).toBe(false);
  });

  test("offsets survive Windows line endings", async () => {
    const scorer = createScorer({ ruleset: mixed(), threshold: 0.7 });
    const result = await scorer.score("Line one.\r\n\r\nA dash — there.");
    const normalised = "Line one.\n\nA dash — there.";
    const flag = result.flags[0];
    expect(normalised.slice(flag?.start, flag?.end)).toBe("dash — there");
    expect(result.text).toBe(normalised);
  });

  test("the nose's reaction follows the rule kind and the score", () => {
    expect(reactionFor("regex", 1, 0.7)).toBe("wrinkle");
    expect(reactionFor("judgment", 0.7, 0.7)).toBe("twitch");
    expect(reactionFor("judgment", 0.84, 0.7)).toBe("twitch");
    expect(reactionFor("judgment", 0.85, 0.7)).toBe("recoil");
    expect(reactionFor("judgment", 0.99, 0.7)).toBe("recoil");
  });

  test("the strongest reaction wins the round: recoil over wrinkle over twitch", async () => {
    const seen: JevRequest[] = [];
    const scorer = createScorer({
      ruleset: mixed(),
      threshold: 0.7,
      client: stubClient(() => ({ restating_closer: 0.95 }), seen),
    });
    expect((await scorer.score("A dash — and, in short, a restatement.")).reaction).toBe("recoil");
  });

  test("a paragraph that did not change is not sent again, and the meter counts only what was sent", async () => {
    const seen: JevRequest[] = [];
    const scorer = createScorer({
      ruleset: mixed(),
      threshold: 0.7,
      client: stubClient(() => ({ restating_closer: 0.2 }), seen),
    });

    const first = await scorer.score("Paragraph one.\n\nParagraph two.");
    expect(first.asked).toBe(2);
    expect(first.ms).toBe(22);

    const second = await scorer.score("Paragraph one.\n\nParagraph two, edited.");
    expect(second.asked).toBe(1);
    expect(second.skipped).toBe(1);
    expect(second.ms).toBe(11);
    expect(second.usd).toBeCloseTo(120 * 0.042e-6, 12);
    expect(seen).toHaveLength(3);
  });

  test("an empty draft asks nothing and flags nothing", async () => {
    const scorer = createScorer({ ruleset: mixed(), threshold: 0.7, client: forbiddenClient() });
    const result = await scorer.score("  \n\n ");
    expect(result.flags).toEqual([]);
    expect(result.asked).toBe(0);
  });
});

// --- the page ---------------------------------------------------------------

describe("serve: the page", () => {
  const html = renderPage(PAGE, "test-nonce-0123456789");

  test("loads nothing remote: no absolute URL in any attribute, import, or stylesheet", () => {
    // The SVG namespace is an identifier, not a request.
    const withoutNamespaces = html.replaceAll("http://www.w3.org/2000/svg", "");
    expect(withoutNamespaces).not.toMatch(/https?:\/\//);
    expect(withoutNamespaces).not.toMatch(/(?:src|href|action|poster|srcset)\s*=\s*["']?\/\//i);
    expect(html).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
    const links = html.match(/<link\b[^>]*>/g) ?? [];
    for (const link of links) expect(link).toMatch(/href="\/favicon\.svg"/);
  });

  test("carries no analytics and keeps nothing in the browser", () => {
    expect(html).not.toMatch(/gtag|googletagmanager|posthog|plausible|segment|sentry/i);
    expect(html).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon/);
  });

  test("the capture contract: #draft, the 500 ms quiet, and __captureState with its three fields", () => {
    expect(html).toMatch(/<textarea[^>]*\bid="draft"/);
    expect(html).toContain('"debounceMs":500');
    expect(html).toMatch(/window\.__captureState\s*=\s*\{\s*generation:\s*0,\s*rendered:\s*0,\s*dueAt:\s*null\s*\}/);
  });

  test("the nose is the locked rig, inlined once, decorative, with every part the manifest names", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "assets/nose/expressions.json"), "utf8")) as {
      locked: { concept: string; motion: string };
      parts: string[];
    };
    expect(manifest.locked).toEqual({ concept: "e", motion: "rig" });
    for (const part of manifest.parts) expect(html).toContain(`data-part="${part}"`);
    expect(html.match(/data-part="stage"/g)).toHaveLength(1);
    expect(html).toMatch(/<svg[^>]*class="nose"[^>]*aria-hidden="true"/);
    expect(html).not.toContain("<title>Sniff Test nose");
    for (const state of ["rest", "sniff", "approve", "wrinkle", "recoil", "twitch"]) {
      expect(html).toContain(`"${state}":{`);
    }
  });

  test("the flags are a polite live region and the draft has a name", () => {
    expect(html).toMatch(/<ol[^>]*id="flags"[^>]*aria-live="polite"/);
    expect(html).toMatch(/<label[^>]*for="draft"/);
    expect(html).toMatch(/role="status"/);
    expect(html).toContain("prefers-reduced-motion");
  });

  test("motion runs on the page clock, never on CSS, so a virtual-clock capture reproduces", () => {
    const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(css).not.toMatch(/\btransition\s*:|\banimation\s*:|@keyframes/);
    expect(html).toContain("requestAnimationFrame");
    expect(html).not.toContain("Math.random");
  });

  test("the ground is never cream, and nothing from another brand's kit is in the page", () => {
    const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    const grounds = [...css.matchAll(/--ground:\s*(#[0-9a-f]{6})/gi)].map((match) => match[1] ?? "");
    expect(grounds.length).toBe(2);
    for (const ground of grounds) {
      const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(ground.slice(at, at + 2), 16)) as [number, number, number];
      // Cream is a warm tint: red well above blue. Paper white and near black are neutral.
      expect(Math.abs(r - b)).toBeLessThanOrEqual(4);
      expect(Math.abs(r - g)).toBeLessThanOrEqual(4);
    }
    expect(html).not.toMatch(/fonts\.googleapis|@font-face/);
  });

  test("config is data, not markup: a hostile mode line cannot break out of the script", () => {
    const hostile = renderPage({ ...PAGE, modeLine: '</script><script>alert(1)</script><img src=x onerror="1">' }, "n0nce-n0nce-n0nce-n0nce");
    expect(hostile.match(/<script\b/g)).toHaveLength(1);
    expect(hostile).not.toContain("<img src=x");
  });

  test("the page's own words pass the countable rules it ships with", () => {
    const visible = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, " ")
      .replace(/<[^>]+>/g, "\n\n")
      .replace(/&[a-z]+;/g, " ");
    const ruleset = resolveRuleset({ cwd: sandbox() }).ruleset;
    const flags = runRegexArm(chunkDocument(visible, "page"), ruleset);
    expect(flags.map((flag) => `${flag.rule}: ${flag.message}`)).toEqual([]);
  });
});
