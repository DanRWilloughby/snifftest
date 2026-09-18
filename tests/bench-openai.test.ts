/**
 * The OpenAI direct provider: the request it builds, and the panel rules that
 * keep a row from declaring a setting that request has no field for.
 *
 * Nothing here touches the network. Every adapter is handed a `fetch` that
 * answers from a literal in this file, and no test reads a key from the
 * environment: the keys below are strings chosen to look like keys and are not
 * credentials.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  OPENAI_CHAT_ENDPOINT,
  OPENAI_KEY_ENV,
  OPENAI_MODELS_ENDPOINT,
  createOpenAIAdapter,
  readOpenAICatalog,
} from "../src/bench/openai.ts";
import { DEFAULT_MAX_TOKENS, PanelError, parsePanel } from "../src/bench/panel.ts";
import { parsePriceTable, priceFor } from "../src/bench/prices.ts";

const repoRoot = resolve(import.meta.dir, "..");

/** Not a credential: a shape, so a test reads like the real call. */
const KEY = "sk-openai-test-0123456789abcdefghij";

/** A reply in the contract shape the bench prompt asks for. */
function answer(): string {
  return JSON.stringify({ restating_closer: { flag: true, p: 0.81 } });
}

function chatResponse(
  over: Record<string, unknown> = {},
  usage: Record<string, unknown> = { prompt_tokens: 140, completion_tokens: 36 },
): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      model: "gpt-5.6-sol-2026-09-01",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: answer() } }],
      usage,
      ...over,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// --- the request ----------------------------------------------------------

describe("the OpenAI direct adapter", () => {
  test("sends the chat shape with the budget in the field this API takes", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const adapter = createOpenAIAdapter({
      apiKey: KEY,
      fetch: async (url, init) => {
        seen.push({ url, init });
        return chatResponse();
      },
    });

    const reply = await adapter.call({
      slug: "gpt-5.6-sol",
      system: "s",
      user: "u",
      jsonMode: true,
      maxTokens: 4000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(OPENAI_CHAT_ENDPOINT);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(headers["x-api-key"]).toBeUndefined();

    const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("gpt-5.6-sol");
    // The reasoning models reject `max_tokens` outright, so the budget rides in
    // the name this API kept.
    expect(body["max_completion_tokens"]).toBe(4000);
    expect(body["max_tokens"]).toBeUndefined();
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(body["messages"]).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);

    expect(reply.servedModel).toBe("gpt-5.6-sol-2026-09-01");
  });

  test("sends no temperature at all, because the gpt-5 family refuses any but its own", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createOpenAIAdapter({
      apiKey: KEY,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return chatResponse();
      },
    });

    await adapter.call({
      slug: "gpt-5.6-sol",
      system: "s",
      user: "u",
      jsonMode: false,
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    // Every other row is pinned at zero. Sending a zero here would fail the row
    // rather than pin it, which is why the footnote has to say so instead.
    expect("temperature" in body).toBe(false);
    expect(body["response_format"]).toBeUndefined();
  });

  test("names an effort only when the row declared one", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createOpenAIAdapter({
      apiKey: KEY,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return chatResponse();
      },
    });

    const call = { slug: "gpt-5.6-sol", system: "s", user: "u", jsonMode: true, maxTokens: 4000 };

    await adapter.call({ ...call, reasoning: { effort: "low" } });
    // A bare string, not the object OpenRouter takes.
    expect(body["reasoning_effort"]).toBe("low");

    await adapter.call(call);
    expect(body["reasoning_effort"]).toBeUndefined();
  });
});

// --- what comes back ------------------------------------------------------

describe("the OpenAI direct adapter reading its reply", () => {
  test("counts the tokens the provider billed, reasoning included", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: KEY,
      fetch: async () =>
        chatResponse(
          {},
          {
            prompt_tokens: 2900,
            completion_tokens: 812,
            completion_tokens_details: { reasoning_tokens: 768 },
          },
        ),
    });

    const reply = await adapter.call({
      slug: "gpt-5.6-sol",
      system: "s",
      user: "u",
      jsonMode: true,
      maxTokens: 4000,
      reasoning: { effort: "low" },
    });

    expect(reply.inputTokens).toBe(2900);
    // The reasoning is inside the completion total here, which is what this API
    // documents, so the billed output is that total and not a sum.
    expect(reply.outputTokens).toBe(812);
    expect(reply.reasoningTokens).toBe(768);
    expect(reply.finishReason).toBe("stop");
    expect(reply.truncated).toBe(false);
    expect(reply.attempts).toBe(1);
  });

  test("reasoning reported alongside the total is added to it, never dropped", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: KEY,
      fetch: async () =>
        chatResponse(
          {},
          {
            prompt_tokens: 100,
            completion_tokens: 120,
            completion_tokens_details: { reasoning_tokens: 800 },
          },
        ),
    });

    const reply = await adapter.call({
      slug: "gpt-5.6-sol",
      system: "s",
      user: "u",
      jsonMode: false,
      maxTokens: 4000,
    });
    expect(reply.outputTokens).toBe(920);
  });

  test("a reply cut off at the budget says so, and is not called malformed", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: KEY,
      fetch: async () =>
        chatResponse(
          { choices: [{ finish_reason: "length", message: { role: "assistant", content: '{"rest' } }] },
          {
            prompt_tokens: 2900,
            completion_tokens: 900,
            completion_tokens_details: { reasoning_tokens: 884 },
          },
        ),
    });

    const reply = await adapter.call({
      slug: "gpt-5.6-sol",
      system: "s",
      user: "u",
      jsonMode: true,
      maxTokens: 900,
    });

    expect(reply.finishReason).toBe("length");
    expect(reply.truncated).toBe(true);
    expect(reply.reasoningTokens).toBe(884);
  });

  test("reads the parts array the Chat Completions spec allows", async () => {
    const adapter = createOpenAIAdapter({
      apiKey: KEY,
      fetch: async () =>
        chatResponse({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: [{ type: "text", text: "half" }, { type: "text", text: "-and-half" }] },
            },
          ],
        }),
    });

    const reply = await adapter.call({
      slug: "gpt-5.6-sol",
      system: "s",
      user: "u",
      jsonMode: false,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    expect(reply.text).toBe("half-and-half");
  });

  test("lists ids from the models endpoint, which publishes nothing else", async () => {
    let url = "";
    const adapter = createOpenAIAdapter({
      apiKey: KEY,
      fetch: async (requested) => {
        url = requested;
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-5.6-sol", object: "model" }, { object: "model" }] }),
          { status: 200 },
        );
      },
    });

    const listed = await adapter.listModels();
    expect(url).toBe(OPENAI_MODELS_ENDPOINT);
    // No prices and no parameter list come back, so an entry carries the id and
    // the JSON mode every current chat model on this API accepts.
    expect(listed).toEqual([{ id: "gpt-5.6-sol", jsonMode: true }]);
    expect(readOpenAICatalog({ data: [] })).toEqual([]);
    expect(readOpenAICatalog({})).toEqual([]);
  });

  test("the key name is the only place a key comes from", () => {
    expect(OPENAI_KEY_ENV).toBe("OPENAI_API_KEY");
  });
});

// --- the panel rules ------------------------------------------------------

const OPENAI_PANEL = `version: 1
models:
  - id: sol
    label: gpt-5.6-sol
    tier: mid
    provider: openai
    match: "^gpt-5\\\\.6-sol$"
    max_tokens: 4000
`;

describe("an openai row in a panel file", () => {
  test("is a provider this bench has an adapter for, and may declare an effort", () => {
    const panel = parsePanel(`${OPENAI_PANEL}    reasoning:\n      effort: low\n`, "panel.yaml");
    const sol = panel.models[0];

    expect(sol?.provider).toBe("openai");
    expect(sol?.maxTokens).toBe(4000);
    expect(sol?.reasoning).toEqual({ effort: "low" });
  });

  test("a reasoning budget is refused, because the request has no such field", () => {
    expect(() =>
      parsePanel(`${OPENAI_PANEL}    reasoning:\n      max_tokens: 2048\n`, "panel.yaml"),
    ).toThrow(/no such field/);
  });

  test("an exclude flag is refused for the same reason", () => {
    expect(() =>
      parsePanel(`${OPENAI_PANEL}    reasoning:\n      exclude: true\n`, "panel.yaml"),
    ).toThrow(/no such field/);
  });

  test("an effort the provider would not understand is still refused", () => {
    expect(() =>
      parsePanel(`${OPENAI_PANEL}    reasoning:\n      effort: enormous\n`, "panel.yaml"),
    ).toThrow(/effort/);
  });

  test("the adapters that send reasoning at all are named in the refusal", () => {
    const direct = OPENAI_PANEL.replace("provider: openai", "provider: anthropic");
    let message = "";
    try {
      parsePanel(`${direct}    reasoning:\n      effort: low\n`, "panel.yaml");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("openrouter and openai");
    expect(message).toContain("extended thinking");
  });

  test("a provider with no adapter is refused whatever else the row says", () => {
    expect(() => parsePanel(OPENAI_PANEL.replace("provider: openai", "provider: openai-ish"), "p.yaml")).toThrow(
      PanelError,
    );
  });
});

// --- the shipped direct panel ---------------------------------------------

describe("the direct panel that ships with the tool", () => {
  const file = join(repoRoot, "bench/panel-direct.yaml");
  const panel = parsePanel(readFileSync(file, "utf8"), "bench/panel-direct.yaml");

  test("every row is called on its own provider's API, with no routed row among them", () => {
    expect(panel.models.map((model) => model.id)).toEqual(["haiku", "sonnet", "opus", "sol", "jev"]);
    expect(panel.models.map((model) => model.provider)).toEqual([
      "anthropic",
      "anthropic",
      "anthropic",
      "openai",
      "jev",
    ]);
    expect(panel.models.some((model) => model.provider === "openrouter")).toBe(false);
  });

  test("the row that reasons is given room to think and then answer", () => {
    const sol = panel.models.find((model) => model.id === "sol");
    // Without this it spends the budget reasoning and lands in the table as a
    // parse failure, which reads as a verdict on the model rather than the run.
    expect(sol?.maxTokens).toBeGreaterThan(DEFAULT_MAX_TOKENS);
    expect(sol?.reasoning).toEqual({ effort: "low" });
    expect(sol?.prefer).toEqual(["gpt-5.6-sol"]);
  });

  test("both providers that publish no price name a dated file", () => {
    expect(panel.prices["anthropic"]).toBe("prices/anthropic-2026-09-17.yaml");
    expect(panel.prices["openai"]).toBe("prices/openai-2026-09-17.yaml");
    // The judgment service has no recorded published price, so it names none
    // and its row prints its cost as unknown rather than as a zero.
    expect(panel.prices["jev"]).toBeUndefined();
  });

  test("the price files it names parse, and carry their source and date", () => {
    for (const relative of Object.values(panel.prices)) {
      const table = parsePriceTable(readFileSync(join(repoRoot, "bench", relative), "utf8"), relative);
      expect(table.verified_on).toBe("2026-09-17");
      expect(table.source.trim()).not.toBe("");
    }
  });

  test("the published prices each row is metered at", () => {
    const openai = parsePriceTable(
      readFileSync(join(repoRoot, "bench/prices/openai-2026-09-17.yaml"), "utf8"),
      "prices/openai-2026-09-17.yaml",
    );
    expect(priceFor(openai, "gpt-5.6-sol-2026-09-01")?.inputUsdPerToken).toBe(4e-6);
    expect(priceFor(openai, "gpt-5.6-sol-2026-09-01")?.outputUsdPerToken).toBe(20e-6);
    // A served model the file has no row for has no cost at all, never a zero.
    expect(priceFor(openai, "claude-sonnet-5")).toBeUndefined();

    const anthropic = parsePriceTable(
      readFileSync(join(repoRoot, "bench/prices/anthropic-2026-09-17.yaml"), "utf8"),
      "prices/anthropic-2026-09-17.yaml",
    );
    expect(priceFor(anthropic, "claude-sonnet-5-20260101")?.inputUsdPerToken).toBe(2e-6);
    expect(priceFor(anthropic, "claude-sonnet-5-20260101")?.outputUsdPerToken).toBe(10e-6);
    expect(priceFor(anthropic, "claude-opus-5")?.outputUsdPerToken).toBe(25e-6);
  });
});
