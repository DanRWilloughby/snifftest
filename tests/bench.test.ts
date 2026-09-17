import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type CliDeps, EXIT, runCli } from "../src/cli.ts";
import {
  ANTHROPIC_KEY_ENV,
  ANTHROPIC_MESSAGES_ENDPOINT,
  ANTHROPIC_MODELS_ENDPOINT,
  createAnthropicAdapter,
  readAnthropicCatalog,
} from "../src/bench/anthropic.ts";
import {
  OPENROUTER_CHAT_ENDPOINT,
  OPENROUTER_KEY_ENV,
  OPENROUTER_MODELS_ENDPOINT,
  createOpenRouterAdapter,
  readOpenRouterCatalog,
} from "../src/bench/openrouter.ts";
import {
  DEFAULT_MAX_TOKENS,
  PanelError,
  type CatalogEntry,
  type PanelEntry,
  type ResolvedModel,
  parsePanel,
  resolveEntry,
} from "../src/bench/panel.ts";
import { PriceError, parsePriceTable, priceFor } from "../src/bench/prices.ts";
import { ReplyError, buildSystemPrompt, parseReply, userMessage } from "../src/bench/prompt.ts";
import {
  type BenchDocument,
  type ModelAdapter,
  type ModelCall,
  type ModelReply,
  runBench,
} from "../src/bench/run.ts";
import { buildBenchReport, renderBenchMarkdown } from "../src/bench/tables.ts";
import { createJevAdapter, jevCatalog, paragraphOf } from "../src/bench/jev-adapter.ts";
import type { JevRequest, JevResult } from "../src/jev.ts";
import { parseRuleset } from "../src/rules.ts";
import { type JudgmentRule, type Ruleset, isJudgmentRule } from "../src/types.ts";

const repoRoot = resolve(import.meta.dir, "..");
const MODELS_FIXTURE = join(repoRoot, "tests/fixtures/bench/openrouter-models.json");
const REASONING_FIXTURE = join(repoRoot, "tests/fixtures/bench/reasoning-reply.json");
const TRUNCATED_FIXTURE = join(repoRoot, "tests/fixtures/bench/reasoning-truncated.json");

const temporary: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-bench-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// --- the little world every test judges -----------------------------------

const RULES: Ruleset = parseRuleset(
  `version: 1
threshold: 0.7
rules:
  - id: colon_heavy
    kind: regex
    builtin: colon_count
    min: 3
    message: "Three colons in one paragraph. Pick one."
  - id: restating_closer
    kind: judgment
    what: The last sentence only restates what the paragraph already said.
    not_for: A closing sentence that adds a consequence.
    examples:
      - "In short, everything above is what we said."
    criteria:
      true: "The final sentence adds nothing the paragraph had not already said."
      false: "The final sentence adds something."
    message: "The last line says it again."
  - id: naked_cost_figure
    kind: judgment
    what: A cost to produce, with no customer price beside it.
    criteria:
      true: "A production cost appears with no price and no alternative."
      false: "No naked cost figure."
    message: "A cost with no price next to it."
`,
  "test.yaml",
);

const JUDGMENT: readonly JudgmentRule[] = RULES.rules.filter(isJudgmentRule);
const JUDGMENT_IDS = JUDGMENT.map((rule) => rule.id);
const CLASSES = RULES.rules.map((rule) => rule.id);

const DOCUMENTS: readonly BenchDocument[] = [
  { id: "C00", kind: "clean", text: "The counter in the hallway has been wrong since it was installed." },
  {
    id: "S00",
    kind: "seeded",
    truth: "restating_closer",
    text: "The counter reads high by four. In short, everything above is what we said.",
  },
  {
    id: "S01",
    kind: "seeded",
    truth: "naked_cost_figure",
    text: "We keep it in the drawer. It cost us about four dollars of compute to make this.",
  },
];

const PANEL_YAML = `version: 1
prices:
  anthropic: prices/anthropic-2026-09-17.yaml
models:
  - id: haiku
    label: Claude Haiku 4.5
    tier: fast
    provider: openrouter
    match: "^anthropic/claude-haiku-4[.-]5$"
  - id: sonnet
    label: Claude Sonnet 5
    tier: mid
    provider: openrouter
    match: "^anthropic/claude-sonnet-5"
    prefer:
      - anthropic/claude-sonnet-5
  - id: opus
    label: Claude Opus 5
    tier: deep
    provider: openrouter
    match: "^anthropic/claude-opus-5$"
`;

const PRICE_YAML = `version: 1
source: published list prices, transcribed; re-verify against the published price list on the run date
verified_on: 2026-09-17
currency: usd_per_million_tokens
models:
  - match: sonnet-5
    input: 3
    output: 15
  - match: haiku-4-5
    input: 1
    output: 5
`;

function catalog(): readonly CatalogEntry[] {
  return readOpenRouterCatalog(JSON.parse(readFileSync(MODELS_FIXTURE, "utf8")));
}

function entry(overrides: Partial<PanelEntry> = {}): PanelEntry {
  return {
    id: "sonnet",
    label: "Claude Sonnet 5",
    tier: "mid",
    provider: "openrouter",
    match: "^anthropic/claude-sonnet-5",
    maxTokens: DEFAULT_MAX_TOKENS,
    ...overrides,
  };
}

/** A reply in the contract shape, for whichever rule ids are asked about. */
function reply(values: Record<string, number>): string {
  const body: Record<string, { flag: boolean; p: number }> = {};
  for (const [id, p] of Object.entries(values)) body[id] = { flag: p >= 0.5, p };
  return JSON.stringify(body);
}

function okResponse(text: string, usage = { prompt_tokens: 120, completion_tokens: 30 }): Response {
  return new Response(
    JSON.stringify({
      id: "gen-1",
      model: "anthropic/claude-sonnet-5",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fixtureResponse(path: string): Response {
  return new Response(readFileSync(path, "utf8"), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// --- the panel file -------------------------------------------------------

describe("the panel file", () => {
  test("parses models, tiers, providers and the price-table paths", () => {
    const panel = parsePanel(PANEL_YAML, "panel.yaml");

    expect(panel.models.map((model) => model.id)).toEqual(["haiku", "sonnet", "opus"]);
    expect(panel.models[1]?.prefer).toEqual(["anthropic/claude-sonnet-5"]);
    expect(panel.models[2]?.tier).toBe("deep");
    expect(panel.prices["anthropic"]).toBe("prices/anthropic-2026-09-17.yaml");
  });

  test("refuses a provider it has no adapter for", () => {
    const yaml = PANEL_YAML.replace("provider: openrouter", "provider: carrier-pigeon");
    expect(() => parsePanel(yaml, "panel.yaml")).toThrow(PanelError);
  });

  test("refuses a model with no match pattern and a repeated id", () => {
    expect(() =>
      parsePanel(`version: 1\nmodels:\n  - id: a\n    provider: openrouter\n`, "panel.yaml"),
    ).toThrow(/match/);

    const twice = `version: 1
models:
  - id: a
    provider: openrouter
    match: "^x$"
  - id: a
    provider: openrouter
    match: "^y$"
`;
    expect(() => parsePanel(twice, "panel.yaml")).toThrow(/a/);
  });
});

// --- the settings that keep a reasoning row from being starved ------------

describe("a row's own completion budget and reasoning setting", () => {
  test("a row that declares neither gets the default budget and asks for no reasoning", () => {
    const panel = parsePanel(PANEL_YAML, "panel.yaml");
    expect(panel.models[0]?.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(panel.models[0]?.reasoning).toBeUndefined();
  });

  test("a deep row declares a budget and an effort, and both are read", () => {
    const panel = parsePanel(
      `${PANEL_YAML}  - id: deep\n    provider: openrouter\n    match: "^openai/gpt-5$"\n` +
        `    max_tokens: 4000\n    reasoning:\n      effort: low\n      exclude: true\n`,
      "panel.yaml",
    );
    const deep = panel.models.find((model) => model.id === "deep");
    expect(deep?.maxTokens).toBe(4000);
    expect(deep?.reasoning).toEqual({ effort: "low", exclude: true });
  });

  test("the shipped panel gives the deep OpenAI row room to think and then answer", () => {
    const panel = parsePanel(readFileSync(join(repoRoot, "bench/panel.yaml"), "utf8"), "bench/panel.yaml");
    const deep = panel.models.find((model) => model.id === "openai-deep");
    // The row the starved budget hurt most. Without this it spends the budget
    // reasoning and lands in the table as a parse failure.
    expect(deep?.maxTokens).toBeGreaterThan(DEFAULT_MAX_TOKENS);
    expect(deep?.reasoning?.effort).toBeDefined();
  });

  test("a setting the provider would not understand is refused when the file is read", () => {
    const withBadEffort = `${PANEL_YAML}  - id: x\n    provider: openrouter\n    match: "^x$"\n    reasoning:\n      effort: enormous\n`;
    expect(() => parsePanel(withBadEffort, "panel.yaml")).toThrow(/effort/);

    const both = `${PANEL_YAML}  - id: x\n    provider: openrouter\n    match: "^x$"\n    reasoning:\n      effort: low\n      max_tokens: 2000\n`;
    expect(() => parsePanel(both, "panel.yaml")).toThrow(/alternatives/);

    const fractional = `${PANEL_YAML}  - id: x\n    provider: openrouter\n    match: "^x$"\n    max_tokens: 0\n`;
    expect(() => parsePanel(fractional, "panel.yaml")).toThrow(/whole number/);
  });

  test("a reasoning setting on the direct row is refused rather than quietly dropped", () => {
    // The Anthropic adapter has no extended thinking wired into it. Accepting
    // the setting here would print a footnote the request never carried.
    const direct = `${PANEL_YAML}  - id: direct\n    provider: anthropic\n    match: "^claude-sonnet-5$"\n    reasoning:\n      effort: high\n`;
    expect(() => parsePanel(direct, "panel.yaml")).toThrow(/extended thinking/);
  });
});

// --- resolution against the live list -------------------------------------

describe("resolving a panel entry against the provider's own model list", () => {
  test("pins the exact slug, its prices and whether it takes a JSON mode", () => {
    const resolved = resolveEntry(entry(), catalog(), { runDate: "2026-09-17" });

    expect(resolved.available).toBe(true);
    expect(resolved.slug).toBe("anthropic/claude-sonnet-5");
    expect(resolved.prices?.inputUsdPerToken).toBe(3e-6);
    expect(resolved.prices?.outputUsdPerToken).toBe(15e-6);
    expect(resolved.jsonMode).toBe(true);
  });

  test("a preferred slug wins over the pattern's other matches", () => {
    const withoutPrefer = resolveEntry(
      entry({ prefer: undefined as unknown as readonly string[] }),
      catalog(),
      { runDate: "2026-09-17" },
    );
    // Two slugs match the pattern; without a preference the sorted first is taken
    // and the alternatives are recorded rather than dropped.
    expect(withoutPrefer.slug).toBe("anthropic/claude-sonnet-5");
    expect(withoutPrefer.candidates).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-5:thinking",
    ]);

    const preferred = resolveEntry(
      entry({ prefer: ["anthropic/claude-sonnet-5:thinking"] }),
      catalog(),
      { runDate: "2026-09-17" },
    );
    expect(preferred.slug).toBe("anthropic/claude-sonnet-5:thinking");
  });

  test("a model the provider does not list is not available on that date, never substituted", () => {
    const resolved = resolveEntry(entry({ id: "opus", match: "^anthropic/claude-opus-5$" }), catalog(), {
      runDate: "2026-09-17",
    });

    expect(resolved.available).toBe(false);
    expect(resolved.slug).toBeNull();
    expect(resolved.note).toBe(
      "not available on 2026-09-17: the provider lists nothing matching ^anthropic/claude-opus-5$",
    );
  });

  test("a listed model with no usable price is resolved with no price, never a zero", () => {
    const resolved = resolveEntry(entry({ id: "mystery", match: "^mystery/" }), catalog(), {
      runDate: "2026-09-17",
    });

    expect(resolved.available).toBe(true);
    expect(resolved.prices).toBeNull();
  });
});

// --- the dated price table ------------------------------------------------

describe("the dated price table", () => {
  test("carries its source and date and prices by family", () => {
    const table = parsePriceTable(PRICE_YAML, "anthropic-2026-09-17.yaml");

    expect(table.verified_on).toBe("2026-09-17");
    expect(table.source).toContain("published list prices");
    expect(priceFor(table, "claude-sonnet-5-20260101")?.inputUsdPerToken).toBe(3e-6);
    expect(priceFor(table, "claude-sonnet-5-20260101")?.outputUsdPerToken).toBe(15e-6);
  });

  test("a model that matches no row has no price at all", () => {
    const table = parsePriceTable(PRICE_YAML, "anthropic-2026-09-17.yaml");
    expect(priceFor(table, "claude-quaver-9")).toBeUndefined();
  });

  test("a table with no date or no source is refused", () => {
    expect(() => parsePriceTable(PRICE_YAML.replace(/verified_on:.*\n/, ""), "p.yaml")).toThrow(
      PriceError,
    );
    expect(() => parsePriceTable(PRICE_YAML.replace(/source:.*\n/, ""), "p.yaml")).toThrow(PriceError);
  });
});

// --- one prompt, every model ----------------------------------------------

describe("the prompt and the reply contract", () => {
  test("carries every rule's own words and asks for one JSON object", () => {
    const prompt = buildSystemPrompt(JUDGMENT);

    for (const rule of JUDGMENT) {
      expect(prompt).toContain(`[${rule.id}]`);
      expect(prompt).toContain(rule.what.trim());
      expect(prompt).toContain(rule.criteria.true.trim());
      expect(prompt).toContain(rule.criteria.false.trim());
    }
    expect(prompt).toContain('"flag"');
    expect(prompt).toContain('"p"');
    expect(userMessage("hello")).toContain("hello");
  });

  test("reads a plain object and a fenced one the same way", () => {
    const plain = parseReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.1 }), JUDGMENT_IDS);
    expect(plain.readings["restating_closer"]?.p).toBe(0.9);
    expect(plain.missing).toEqual([]);

    const fenced = parseReply(
      "```json\n" + reply({ restating_closer: 0.4, naked_cost_figure: 0.2 }) + "\n```",
      JUDGMENT_IDS,
    );
    expect(fenced.readings["naked_cost_figure"]?.p).toBe(0.2);
  });

  test("a malformed reply and a refusal are failures, never a guess", () => {
    expect(() => parseReply("I'm sorry, I can't help with that.", JUDGMENT_IDS)).toThrow(ReplyError);
    expect(() => parseReply('{"restating_closer": {"flag": true, ', JUDGMENT_IDS)).toThrow(ReplyError);
    expect(() => parseReply("[1, 2, 3]", JUDGMENT_IDS)).toThrow(ReplyError);
  });

  test("a rule answered out of contract is unanswered, not defaulted", () => {
    const out = parseReply(
      JSON.stringify({
        restating_closer: { flag: true, p: 1.4 },
        naked_cost_figure: { flag: "yes", p: 0.3 },
      }),
      JUDGMENT_IDS,
    );

    expect(out.readings).toEqual({});
    expect([...out.missing].sort()).toEqual(["naked_cost_figure", "restating_closer"]);
  });
});

// --- the OpenRouter adapter -----------------------------------------------

describe("the OpenRouter adapter", () => {
  test("sends one chat completion at temperature 0, with JSON mode where the model takes it", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async (url, init) => {
        seen.push({ url, init });
        return okResponse(reply({ restating_closer: 0.8, naked_cost_figure: 0.05 }));
      },
    });

    const call: ModelCall = {
      slug: "anthropic/claude-sonnet-5",
      system: buildSystemPrompt(JUDGMENT),
      user: userMessage(DOCUMENTS[1]?.text ?? ""),
      jsonMode: true,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
    const answer: ModelReply = await adapter.call(call);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(OPENROUTER_CHAT_ENDPOINT);
    const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("anthropic/claude-sonnet-5");
    expect(body["temperature"]).toBe(0);
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect(Array.isArray(body["messages"])).toBe(true);

    expect(answer.inputTokens).toBe(120);
    expect(answer.outputTokens).toBe(30);
    expect(answer.servedModel).toBe("anthropic/claude-sonnet-5");
    expect(answer.attempts).toBe(1);
  });

  test("leaves the JSON mode off for a model whose catalogue entry does not take one", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return okResponse(reply({ restating_closer: 0.2, naked_cost_figure: 0.2 }));
      },
    });

    await adapter.call({
      slug: "deepseek/deepseek-chat-v3",
      system: "s",
      user: "u",
      jsonMode: false,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    expect(body["response_format"]).toBeUndefined();
  });

  test("reads the catalogue, prices and JSON support from the models endpoint", async () => {
    const payload = JSON.parse(readFileSync(MODELS_FIXTURE, "utf8")) as unknown;
    let url = "";
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async (requested) => {
        url = requested;
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    });

    const listed = await adapter.listModels();
    expect(url).toBe(OPENROUTER_MODELS_ENDPOINT);
    expect(listed.find((model) => model.id === "google/gemini-2.5-flash")?.jsonMode).toBe(true);
    expect(listed.find((model) => model.id === "deepseek/deepseek-chat-v3")?.jsonMode).toBe(false);
    expect(listed.find((model) => model.id === "mystery/unpriced-model")?.inputUsdPerToken).toBeUndefined();
  });

  test("retries a 429 and a 500, gives up on a 401, and never quotes a key", async () => {
    const key = "or-live-key-abcdefghijklmnopqrstuvwxyz";
    const other = "sk-ant-second-key-abcdefghijklmnop";
    let calls = 0;

    const flaky = createOpenRouterAdapter({
      apiKey: key,
      secrets: [key, other],
      sleep: async () => {},
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response("slow down", { status: 429 });
        if (calls === 2) return new Response("upstream fell over", { status: 500 });
        return okResponse(reply({ restating_closer: 0.5, naked_cost_figure: 0.5 }));
      },
    });
    const recovered = await flaky.call({
      slug: "m",
      system: "s",
      user: "u",
      jsonMode: false,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    expect(calls).toBe(3);
    expect(recovered.attempts).toBe(3);

    let unauthorised = 0;
    const refused = createOpenRouterAdapter({
      apiKey: key,
      secrets: [key, other],
      sleep: async () => {},
      fetch: async () => {
        unauthorised += 1;
        // The shape that makes this dangerous: the service quotes what it was sent.
        return new Response(`no such key: ${key} (or ${other})`, { status: 401 });
      },
    });

    let message = "";
    try {
      await refused.call({
        slug: "m",
        system: "s",
        user: "u",
        jsonMode: false,
        maxTokens: DEFAULT_MAX_TOKENS,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(unauthorised).toBe(1);
    expect(message).toContain("401");
    expect(message).not.toContain(key);
    expect(message).not.toContain(other);
    expect(message).not.toContain(key.slice(0, 16));
    expect(message).not.toContain(other.slice(0, 16));
  });
});

describe("the OpenRouter adapter on a reasoning row", () => {
  test("sends the row's own budget and the provider's reasoning field", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return fixtureResponse(REASONING_FIXTURE);
      },
    });

    await adapter.call({
      slug: "openai/gpt-5",
      system: "s",
      user: "u",
      jsonMode: true,
      maxTokens: 4000,
      reasoning: { effort: "low", exclude: true },
    });

    expect(body["max_tokens"]).toBe(4000);
    // Snake case, because it is the provider's field and not ours.
    expect(body["reasoning"]).toEqual({ effort: "low", exclude: true });
    // The one thing that stays the same for every row, deep or fast.
    expect(body["temperature"]).toBe(0);
  });

  test("a reasoning budget rides in the same field the provider documents", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return fixtureResponse(REASONING_FIXTURE);
      },
    });

    await adapter.call({
      slug: "openai/gpt-5",
      system: "s",
      user: "u",
      jsonMode: false,
      maxTokens: 4000,
      reasoning: { maxTokens: 2048 },
    });
    expect(body["reasoning"]).toEqual({ max_tokens: 2048 });
  });

  test("a row that asks for no reasoning sends no reasoning field at all", async () => {
    let body: Record<string, unknown> = {};
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return okResponse(reply({ restating_closer: 0.3 }));
      },
    });

    await adapter.call({ slug: "m", system: "s", user: "u", jsonMode: false, maxTokens: 900 });
    expect(body["reasoning"]).toBeUndefined();
    expect(body["max_tokens"]).toBe(900);
  });

  test("the reasoning the provider billed for is reported and paid for", async () => {
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async () => fixtureResponse(REASONING_FIXTURE),
    });

    const answer = await adapter.call({
      slug: "openai/gpt-5",
      system: "s",
      user: "u",
      jsonMode: true,
      maxTokens: 4000,
      reasoning: { effort: "low" },
    });

    expect(answer.reasoningTokens).toBe(768);
    // The fixture folds the reasoning into completion_tokens, which is what
    // OpenRouter documents, so the billed output is that total and not a sum.
    expect(answer.outputTokens).toBe(812);
    expect(answer.finishReason).toBe("stop");
    expect(answer.truncated).toBe(false);
  });

  test("reasoning reported alongside the total is added to it, never dropped", async () => {
    // A provider that reports the reasoning next to completion_tokens rather
    // than inside it would otherwise have its deepest call priced as its
    // cheapest, which would make the hardest-thinking row look the cheapest.
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: "openai/gpt-5",
            choices: [{ finish_reason: "stop", message: { content: reply({ restating_closer: 0.5 }) } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 120,
              completion_tokens_details: { reasoning_tokens: 800 },
            },
          }),
          { status: 200 },
        ),
    });

    const answer = await adapter.call({
      slug: "openai/gpt-5",
      system: "s",
      user: "u",
      jsonMode: false,
      maxTokens: 4000,
    });
    expect(answer.reasoningTokens).toBe(800);
    expect(answer.outputTokens).toBe(920);
  });

  test("a reply cut off at the budget says so, and is not called malformed", async () => {
    const adapter = createOpenRouterAdapter({
      apiKey: "or-test-key-0123456789abcdef",
      fetch: async () => fixtureResponse(TRUNCATED_FIXTURE),
    });

    const answer = await adapter.call({
      slug: "openai/gpt-5",
      system: "s",
      user: "u",
      jsonMode: true,
      maxTokens: 900,
    });

    expect(answer.finishReason).toBe("length");
    expect(answer.truncated).toBe(true);
    expect(answer.reasoningTokens).toBe(884);
  });
});

// --- the Anthropic direct adapter -----------------------------------------

describe("the Anthropic direct adapter, the overhead control", () => {
  test("sends the Messages shape with the system prompt as its own field", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const adapter = createAnthropicAdapter({
      apiKey: "sk-ant-test-0123456789abcdefghij",
      fetch: async (url, init) => {
        seen.push({ url, init });
        return new Response(
          JSON.stringify({
            model: "claude-sonnet-5-20260101",
            content: [{ type: "text", text: reply({ restating_closer: 0.77, naked_cost_figure: 0.02 }) }],
            usage: { input_tokens: 200, output_tokens: 40 },
          }),
          { status: 200 },
        );
      },
    });

    const answer = await adapter.call({
      slug: "claude-sonnet-5",
      system: "s",
      user: "u",
      jsonMode: false,
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    expect(seen[0]?.url).toBe(ANTHROPIC_MESSAGES_ENDPOINT);
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBeDefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();

    const body = JSON.parse(String(seen[0]?.init.body)) as Record<string, unknown>;
    expect(body["system"]).toBe("s");
    // The Claude 5 models refuse a temperature field, so no row sends one.
    expect("temperature" in body).toBe(false);
    expect(answer.servedModel).toBe("claude-sonnet-5-20260101");
    expect(answer.inputTokens).toBe(200);
  });

  test("lists its own models so a missing one is skipped rather than assumed", async () => {
    let url = "";
    const adapter = createAnthropicAdapter({
      apiKey: "sk-ant-test-0123456789abcdefghij",
      fetch: async (requested) => {
        url = requested;
        return new Response(
          JSON.stringify({ data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] }),
          { status: 200 },
        );
      },
    });

    const listed = await adapter.listModels();
    expect(url).toBe(ANTHROPIC_MODELS_ENDPOINT);
    expect(listed).toEqual([{ id: "claude-sonnet-5", jsonMode: false }]);
    expect(readAnthropicCatalog({ data: [] })).toEqual([]);
  });

  test("the key names are the only place a key comes from", () => {
    expect(ANTHROPIC_KEY_ENV).toBe("ANTHROPIC_API_KEY");
    expect(OPENROUTER_KEY_ENV).toBe("OPENROUTER_API_KEY");
  });
});

// --- arm D ----------------------------------------------------------------

function stubAdapter(
  provider: "openrouter" | "anthropic",
  answer: (call: ModelCall, nth: number) => ModelReply | Promise<ModelReply>,
  log?: string[],
): ModelAdapter {
  let nth = 0;
  return {
    provider,
    listModels: async () => [],
    call: async (call) => {
      nth += 1;
      log?.push(`${call.slug}`);
      return await answer(call, nth);
    },
  };
}

function modelReply(text: string, latencyMs: number, over: Partial<ModelReply> = {}): ModelReply {
  return {
    servedModel: "served-model-1",
    text,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 0,
    finishReason: "stop",
    truncated: false,
    latencyMs,
    attempts: 1,
    ...over,
  };
}

const FAST: ResolvedModel = {
  entry: entry({ id: "fast", label: "Fast", tier: "fast", match: "^a$" }),
  available: true,
  slug: "model-fast",
  candidates: ["model-fast"],
  jsonMode: true,
  prices: { inputUsdPerToken: 1e-6, outputUsdPerToken: 5e-6, source: "openrouter models endpoint" },
};

const DEEP: ResolvedModel = {
  entry: entry({ id: "deep", label: "Deep", tier: "deep", match: "^b$" }),
  available: true,
  slug: "model-deep",
  candidates: ["model-deep"],
  jsonMode: false,
  prices: null,
};

const UNLISTED: ResolvedModel = {
  entry: entry({ id: "unlisted", label: "Unlisted", tier: "deep" }),
  available: false,
  slug: null,
  candidates: [],
  jsonMode: false,
  prices: null,
  note: "not available on 2026-09-17",
};

const RESOLVED_TWO: readonly ResolvedModel[] = [FAST, DEEP];

describe("arm D over the panel", () => {
  test("interleaves models per document, repeats for latency, and scores run one", async () => {
    const order: string[] = [];
    let tick = 0;
    const answers = reply({ restating_closer: 0.95, naked_cost_figure: 0.95 });

    const adapter = stubAdapter(
      "openrouter",
      () => {
        tick += 1;
        return modelReply(answers, 100 + tick);
      },
      order,
    );

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: RESOLVED_TWO,
      adapters: { openrouter: adapter },
      repeats: 3,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    // Round-robin per document: the model that goes first rotates each document.
    expect(order.slice(0, 6)).toEqual([
      "model-fast",
      "model-deep",
      "model-deep",
      "model-fast",
      "model-fast",
      "model-deep",
    ]);
    expect(order).toHaveLength(2 * 3 * 3);

    const fast = outcome.models.find((model) => model.id === "fast");
    expect(fast?.calls).toBe(9);
    expect(fast?.latency.samples).toBe(9);
    // The detailed tables come from repeat one; every repeat is scored for the
    // spread, and three identical repeats move nothing.
    expect(fast?.score?.overall["0.7"]?.recall).toBe(1);
    expect(fast?.spread.repeats).toBe(3);
    expect(fast?.spread.minRecall).toBe(1);
    expect(fast?.spread.maxRecall).toBe(1);
    expect(outcome.raw.filter((run) => run.model_id === "fast")).toHaveLength(3);
  });

  test("a torn reply is an unanswered cell and a counted failure, never a guess", async () => {
    const adapter = stubAdapter("openrouter", (_call, nth) =>
      modelReply(nth === 1 ? "sure thing, no JSON here" : reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 50),
    );

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const model = outcome.models[0];
    expect(model?.parseFailures).toBe(1);
    expect(model?.unansweredCells).toBe(JUDGMENT_IDS.length);
    expect(model?.failureDetail[0]?.doc).toBe("C00");
    // The countable rule still ran locally on that document, free and offline.
    expect(model?.score?.per_rule["colon_heavy"]).toBeDefined();
  });

  test("a reply cut off at the budget is counted apart from a torn one", async () => {
    const adapter = stubAdapter("openrouter", (_call, nth) =>
      nth === 1
        ? modelReply('{"restating_closer": {"flag": true, "p": 0.9', 50, {
            truncated: true,
            finishReason: "length",
            reasoningTokens: 884,
          })
        : modelReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 50),
    );

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const model = outcome.models[0];
    expect(model?.truncated).toBe(1);
    // The reply was cut off, not malformed, so the parse-failure count is clean.
    expect(model?.parseFailures).toBe(0);
    // Both still cost the run the same cells.
    expect(model?.failures).toBe(1);
    expect(model?.unansweredCells).toBe(JUDGMENT_IDS.length);
    expect(model?.failureDetail[0]?.reason).toContain("budget");

    const record = outcome.raw[0]?.records.find((row) => row.doc === "C00");
    expect(record?.truncated).toBe(true);
    expect(record?.finish_reason).toBe("length");
    expect(record?.usage.reasoning_tokens).toBe(884);
  });

  test("the request each row was sent travels into the raw output", async () => {
    const deep: ResolvedModel = {
      ...DEEP,
      entry: entry({
        id: "deep",
        label: "Deep",
        tier: "deep",
        match: "^b$",
        maxTokens: 4000,
        reasoning: { effort: "low" },
      }),
    };

    const seen: ModelCall[] = [];
    const adapter: ModelAdapter = {
      provider: "openrouter",
      listModels: async () => [],
      call: async (call) => {
        seen.push(call);
        return modelReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 30);
      },
    };

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST, deep],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    expect(seen.find((call) => call.slug === "model-deep")?.maxTokens).toBe(4000);
    expect(seen.find((call) => call.slug === "model-deep")?.reasoning).toEqual({ effort: "low" });
    expect(seen.find((call) => call.slug === "model-fast")?.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(seen.find((call) => call.slug === "model-fast")?.reasoning).toBeUndefined();

    expect(outcome.models.find((model) => model.id === "deep")?.request).toEqual({
      maxTokens: 4000,
      reasoning: { effort: "low" },
    });
    expect(outcome.raw.find((run) => run.model_id === "deep")?.request).toEqual({
      max_tokens: 4000,
      reasoning: { effort: "low" },
    });
    expect(outcome.raw.find((run) => run.model_id === "fast")?.request).toEqual({
      max_tokens: DEFAULT_MAX_TOKENS,
      reasoning: null,
    });
  });

  test("cost comes from returned usage, and stays unknown when the price is", async () => {
    const adapter = stubAdapter("openrouter", () =>
      modelReply(reply({ restating_closer: 0.8, naked_cost_figure: 0.8 }), 40),
    );

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: RESOLVED_TWO,
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const priced = outcome.models.find((model) => model.id === "fast");
    // Three documents at 100 input and 20 output tokens each.
    expect(priced?.cost.totalUsd).toBeCloseTo(3 * (100 * 1e-6 + 20 * 5e-6), 12);
    expect(priced?.cost.usdPer100Paragraphs).toBeCloseTo(100 * (100 * 1e-6 + 20 * 5e-6), 12);

    const unpriced = outcome.models.find((model) => model.id === "deep");
    expect(unpriced?.cost.totalUsd).toBeNull();
    expect(unpriced?.cost.inputTokens).toBe(300);
  });

  test("a model the provider did not list is carried as a row and never called", async () => {
    let calls = 0;
    const adapter = stubAdapter("openrouter", () => {
      calls += 1;
      return modelReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 10);
    });

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [UNLISTED],
      adapters: { openrouter: adapter },
      repeats: 2,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    expect(calls).toBe(0);
    expect(outcome.models[0]?.available).toBe(false);
    expect(outcome.models[0]?.score).toBeNull();
  });
});

// --- the tables -----------------------------------------------------------

describe("the comparison tables", () => {
  async function outcomeForTables() {
    const adapter = stubAdapter("openrouter", () =>
      modelReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 60),
    );
    return await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [...RESOLVED_TWO, UNLISTED],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });
  }

  test("the headline table has a row per panel model with the columns the README needs", async () => {
    const report = buildBenchReport(await outcomeForTables(), {
      runDate: "2026-09-17",
      threshold: 0.7,
      repeats: 1,
      panelFile: "bench/panel.yaml",
      priceSources: ["openrouter models endpoint, 2026-09-17"],
      corpus: { clean: 1, seeded: 2, seed: 1, perRule: 1 },
    });
    const markdown = renderBenchMarkdown(report);

    expect(markdown).toContain(
      "| Model | Tier | Model served | Judgment recall, own flag | Pooled recall, own flag | " +
        "Spread over repeats | Judgment recall, p >= 0.7 | Median ms | $ per 100 paragraphs |",
    );
    expect(markdown).toContain("| Fast | fast |");
    // Unknown price prints as unknown. A zero would read as "this model is free".
    expect(markdown).toContain("unknown");
    expect(markdown).not.toContain("$0.00 |");
    expect(markdown).toContain("not available on 2026-09-17");
    expect(markdown).toContain("bench/panel.yaml");
    // One table per rule, keyed by the rule id.
    for (const id of CLASSES) expect(markdown).toContain(`### ${id}`);
  });

  test("the tables print what each row was sent, so no reader assumes they matched", async () => {
    const deep: ResolvedModel = {
      ...DEEP,
      entry: entry({
        id: "deep",
        label: "Deep",
        tier: "deep",
        match: "^b$",
        maxTokens: 4000,
        reasoning: { effort: "low" },
      }),
    };
    const adapter = stubAdapter("openrouter", () =>
      modelReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 60),
    );
    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST, deep],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const report = buildBenchReport(outcome, {
      runDate: "2026-09-17",
      threshold: 0.7,
      repeats: 1,
      panelFile: "bench/panel.yaml",
      priceSources: [],
      corpus: { clean: 1, seeded: 2, seed: 1, perRule: 1 },
    });
    const markdown = renderBenchMarkdown(report);

    expect(markdown).toContain("| Model | Completion budget | Reasoning |");
    expect(markdown).toContain(
      `| Fast | ${DEFAULT_MAX_TOKENS} tokens | the provider's default, whatever that is for this model |`,
    );
    expect(markdown).toContain("| Deep | 4000 tokens | effort low |");
    // The run table separates a budget failure from a bad answer.
    expect(markdown).toContain("| Truncated |");
    expect(report.models[1]?.request).toEqual({ max_tokens: 4000, reasoning: { effort: "low" } });
  });

  test("joins the eval arms so the headline table comes from one corpus and one run", async () => {
    const report = buildBenchReport(await outcomeForTables(), {
      runDate: "2026-09-17",
      threshold: 0.7,
      repeats: 1,
      panelFile: "bench/panel.yaml",
      priceSources: [],
      corpus: { clean: 1, seeded: 2, seed: 1, perRule: 1 },
      joined: [
        {
          arm: "C",
          label: "C (countable rules plus judgment)",
          recall: 0.905,
          fpPerCleanCell: 0.003,
          medianMs: 170,
          usdPer100Paragraphs: 0.0117,
        },
      ],
    });

    const markdown = renderBenchMarkdown(report);
    expect(markdown).toContain("C (countable rules plus judgment)");
    expect(markdown).toContain("0.905");
    expect(report.joined).toHaveLength(1);
  });
});

// --- the command ----------------------------------------------------------

describe("snifftest bench", () => {
  function deps(
    argv: readonly string[],
    cwd: string,
    fetchLike: (url: string, init?: RequestInit) => Promise<Response>,
  ): { out: string[]; err: string[]; deps: CliDeps } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        argv,
        env: {},
        cwd,
        homedir: cwd,
        write: (line: string) => out.push(line),
        writeError: (line: string) => err.push(line),
        isTty: false,
        fetchLike,
      },
    };
  }

  /** A fetch that fails the test rather than answering it. */
  function forbiddenFetch(): (url: string, init?: RequestInit) => Promise<Response> {
    return async (url: string): Promise<Response> => {
      throw new Error(`the network was used before it was allowed: ${url}`);
    };
  }

  function panelIn(dir: string): string {
    const panel = join(dir, "bench", "panel.yaml");
    mkdirSync(dirname(panel), { recursive: true });
    writeFileSync(panel, PANEL_YAML, "utf8");
    mkdirSync(join(dir, "bench", "prices"), { recursive: true });
    writeFileSync(join(dir, "bench", "prices", "anthropic-2026-09-17.yaml"), PRICE_YAML, "utf8");
    return panel;
  }

  test("--dry-run with a recorded model list prints the panel and makes no request at all", async () => {
    const dir = sandbox();
    panelIn(dir);
    let calls = 0;
    const fetchLike = async (): Promise<Response> => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };

    const { out, deps: cli } = deps(
      ["bench", "--dry-run", "--panel", "bench/panel.yaml", "--models", MODELS_FIXTURE],
      dir,
      fetchLike,
    );
    const code = await runCli(cli);

    expect(calls).toBe(0);
    expect(code).toBe(EXIT.ok);
    const printed = out.join("\n");
    expect(printed).toContain("anthropic/claude-haiku-4.5");
    expect(printed).toContain("anthropic/claude-sonnet-5");
    // Opus is absent from the recorded list, so it is reported, never substituted.
    expect(printed).toContain("not available");
  });

  test("--dry-run reads no model list, so a key is offered to nobody", async () => {
    // The model lists are an authenticated request to each provider, with the
    // user's key, which discloses the run to both before the tool has asked
    // anything. `--dry-run` says nothing leaves the machine, and it has to be
    // true for every command that takes it.
    const dir = sandbox();
    panelIn(dir);

    const { out, deps: cli } = deps(
      ["bench", "--dry-run", "--panel", "bench/panel.yaml"],
      dir,
      forbiddenFetch(),
    );
    const code = await runCli({
      ...cli,
      env: { OPENROUTER_API_KEY: "test-key-not-a-real-credential", ANTHROPIC_API_KEY: "also-not-real" },
    });

    expect(code).toBe(EXIT.ok);
    const printed = out.join("\n");
    expect(printed).toContain("no model list was read");
    expect(printed).toContain("no model was called");
  });

  test("asks before reading a model list, because that is a request with your key in it", async () => {
    const dir = sandbox();
    panelIn(dir);
    writeFileSync(join(dir, "corpus.md"), "A paragraph of ordinary prose that seeds well enough.\n");

    const { deps: cli } = deps(["bench", "--panel", "bench/panel.yaml", "corpus.md"], dir, forbiddenFetch());
    const code = await runCli({
      ...cli,
      env: { OPENROUTER_API_KEY: "test-key-not-a-real-credential", ANTHROPIC_API_KEY: "also-not-real" },
    });

    // No terminal to ask in, so the answer is no, and nothing was asked of
    // anybody's server on the way to finding that out.
    expect(code).toBe(EXIT.consent);
  });

  test("a bench given paths seeds from the same bank the eval uses", async () => {
    const dir = sandbox();
    panelIn(dir);

    const rules = join(dir, "rules.yaml");
    writeFileSync(
      rules,
      `version: 1\nthreshold: 0.7\nrules:\n` +
        `  - id: restating_closer\n    kind: judgment\n` +
        `    what: The last sentence only restates what the paragraph already said.\n` +
        `    criteria:\n      true: "The final sentence adds nothing new."\n` +
        `      false: "The final sentence adds something."\n` +
        `    message: "The last line says it again."\n` +
        `    seed: { splice: ["In short, everything above is what we said."], position: end }\n`,
      "utf8",
    );

    const corpus = join(dir, "corpus", "drawer.md");
    mkdirSync(dirname(corpus), { recursive: true });
    writeFileSync(
      corpus,
      "The first draft went out on a Tuesday, which is the day the office is quietest. " +
        "Nobody read it. A week later it came back with three comments, two about the title.\n\n" +
        "The counter in the hallway has been wrong since the day it was installed, and nobody " +
        "minds. It reads high by four. Visitors who notice are told the story.\n",
      "utf8",
    );

    const models = JSON.parse(readFileSync(MODELS_FIXTURE, "utf8")) as unknown;
    const fetchLike = async (url: string): Promise<Response> => {
      if (url.includes("/models")) return new Response(JSON.stringify(models), { status: 200 });
      return okResponse(reply({ restating_closer: 0.88 }));
    };

    const run = deps(
      ["bench", "--rules", "rules.yaml", "--panel", "bench/panel.yaml", "--out", "results", "corpus"],
      dir,
      fetchLike,
    );
    const code = await runCli({
      ...run.deps,
      env: { OPENROUTER_API_KEY: "or-key-0123456789abcdefghij", SNIFFTEST_SEND: "OpenRouter" },
    });

    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(
      readFileSync(join(dir, "results", "bench-scores.json"), "utf8"),
    ) as { corpus: { clean: number; seeded: number } };

    // Two paragraphs in the file. The bank plants its near misses beside them,
    // and they are clean documents, so the clean count is above two. Without
    // the bank a bare bench measured an easier corpus than the eval did.
    expect(report.corpus.clean).toBeGreaterThan(2);
  });

  test("reuses an eval run's own corpus, joins its arms, and writes raw per model per repeat", async () => {
    const dir = sandbox();
    panelIn(dir);

    const rules = join(dir, "rules.yaml");
    writeFileSync(
      rules,
      `version: 1\nthreshold: 0.7\nrules:\n` +
        `  - id: colon_heavy\n    kind: regex\n    builtin: colon_count\n    min: 3\n` +
        `    message: "Three colons. Pick one."\n    seed: { transform: add_colons, count: 3 }\n` +
        `  - id: restating_closer\n    kind: judgment\n` +
        `    what: The last sentence only restates what the paragraph already said.\n` +
        `    criteria:\n      true: "The final sentence adds nothing new."\n` +
        `      false: "The final sentence adds something."\n` +
        `    message: "The last line says it again."\n` +
        `    seed: { splice: ["In short, everything above is what we said."], position: end }\n`,
      "utf8",
    );

    const corpus = join(dir, "corpus", "drawer.md");
    mkdirSync(dirname(corpus), { recursive: true });
    writeFileSync(
      corpus,
      "The first draft went out on a Tuesday, which is the day the office is quietest. " +
        "Nobody read it. A week later it came back with three comments, two about the title.\n\n" +
        "The counter in the hallway has been wrong since the day it was installed, and nobody " +
        "minds. It reads high by four. Visitors who notice are told the story.\n",
      "utf8",
    );

    const results = join(dir, "results");
    const evalRun = deps(
      ["eval", "corpus", "--rules", "rules.yaml", "--dry-run", "--out", "results", "--per-rule", "1"],
      dir,
      async () => new Response("{}"),
    );
    expect(await runCli(evalRun.deps)).toBe(EXIT.ok);

    const models = JSON.parse(readFileSync(MODELS_FIXTURE, "utf8")) as unknown;
    let chats = 0;
    const fetchLike = async (url: string): Promise<Response> => {
      if (url.includes("/models")) return new Response(JSON.stringify(models), { status: 200 });
      chats += 1;
      return okResponse(reply({ restating_closer: 0.88 }));
    };

    const benchRun = deps(
      [
        "bench",
        "--rules",
        "rules.yaml",
        "--panel",
        "bench/panel.yaml",
        "--eval",
        "results",
        "--repeats",
        "2",
      ],
      dir,
      fetchLike,
    );
    const withKeys: CliDeps = {
      ...benchRun.deps,
      // The environment answer names the destination it answers for. `1` is the
      // shorthand for the one `check` uses and never covers a bench provider.
      env: { OPENROUTER_API_KEY: "or-key-0123456789abcdefghij", SNIFFTEST_SEND: "OpenRouter" },
    };

    expect(await runCli(withKeys)).toBe(EXIT.ok);
    expect(chats).toBeGreaterThan(0);

    const report = JSON.parse(readFileSync(join(results, "bench-scores.json"), "utf8")) as {
      joined: { arm: string }[];
      models: { id: string; available: boolean }[];
      corpus: { clean: number; seeded: number };
      system_prompt: string;
    };

    // The eval's own arms come across, so the headline table is one corpus.
    expect(report.joined.map((arm) => arm.arm).sort()).toEqual(["A", "B"]);
    expect(report.corpus.seeded).toBeGreaterThan(0);

    // The near misses are the hardest clean paragraphs the eval planted, and
    // the bench sees them as clean documents rather than not at all.
    const negatives = JSON.parse(
      readFileSync(join(results, "inputs", "negatives.json"), "utf8"),
    ) as { paragraphs: { id: string; text: string }[] };
    const cleanFile = JSON.parse(readFileSync(join(results, "inputs", "clean.json"), "utf8")) as {
      paragraphs: { id: string }[];
    };
    expect(negatives.paragraphs.length).toBeGreaterThan(0);
    expect(report.corpus.clean).toBe(cleanFile.paragraphs.length + negatives.paragraphs.length);
    expect(report.system_prompt).toContain("[restating_closer]");

    const tables = readFileSync(join(results, "bench-tables.md"), "utf8");
    expect(tables).toContain("B (countable rules only)");
    expect(tables).toContain("### restating_closer");

    // One raw file per model per repeat, and no key anywhere inside it.
    const raw = readFileSync(join(results, "raw", "bench-haiku-r2.json"), "utf8");
    expect(raw).toContain('"repeat": 2');
    expect(raw).not.toContain("or-key-0123456789abcdefghij");
    // Opus is not in the recorded catalogue, so it is a row and not a stand-in.
    expect(report.models.find((model) => model.id === "opus")?.available).toBe(false);
  });

  test("asks before anything is sent, and names every company it would go to", async () => {
    const dir = sandbox();
    panelIn(dir);
    mkdirSync(join(dir, "corpus"), { recursive: true });
    writeFileSync(
      join(dir, "corpus", "a.md"),
      "The counter in the hallway has been wrong since the day it was installed, and nobody minds.\n",
      "utf8",
    );

    const models = JSON.parse(readFileSync(MODELS_FIXTURE, "utf8")) as unknown;
    let chats = 0;
    const { err, deps: cli } = deps(
      ["bench", "--panel", "bench/panel.yaml", "corpus"],
      dir,
      async (url) => {
        if (url.includes("/models")) return new Response(JSON.stringify(models), { status: 200 });
        chats += 1;
        return okResponse(reply({}));
      },
    );

    const code = await runCli({
      ...cli,
      env: { OPENROUTER_API_KEY: "or-key-0123456789abcdefghij" },
    });

    expect(code).toBe(EXIT.consent);
    expect(chats).toBe(0);
    expect(err.join("\n")).toContain(OPENROUTER_CHAT_ENDPOINT);
    expect(err.join("\n")).toContain("OpenRouter");
  });

  test("a run with no corpus and no eval directory says which two forms exist", async () => {
    const dir = sandbox();
    panelIn(dir);
    const { err, deps: cli } = deps(["bench", "--panel", "bench/panel.yaml"], dir, async () =>
      new Response("{}"),
    );

    const code = await runCli(cli);
    expect(code).toBe(EXIT.failure);
    expect(err.join("\n")).toContain("--eval");
  });
});

// --- review fold-in: the model string travels with every arm --------------

describe("the headline table names the model each row was served by", () => {
  test("a panel row carries the served model, an eval arm carries its own", async () => {
    const adapter = stubAdapter("openrouter", () =>
      modelReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 60),
    );
    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [...RESOLVED_TWO, UNLISTED],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const report = buildBenchReport(outcome, {
      runDate: "2026-09-17",
      threshold: 0.7,
      repeats: 1,
      panelFile: "bench/panel.yaml",
      priceSources: [],
      corpus: { clean: 1, seeded: 2, seed: 1, perRule: 1 },
      evalSource: "results/2026-09-17/scores.json",
      joined: [
        {
          arm: "C",
          label: "C (countable rules plus judgment)",
          recall: 0.905,
          fpPerCleanCell: 0.003,
          medianMs: 170,
          usdPer100Paragraphs: 0.0117,
          servedModel: "jev-1.2",
        },
      ],
    });
    const markdown = renderBenchMarkdown(report);
    const headline = markdown.split("\n").slice(0, 40);
    const rowFor = (label: string): string => headline.find((line) => line.startsWith(`| ${label} `)) ?? "";

    expect(headline).toContain(
      "| Model | Tier | Model served | Judgment recall, own flag | Pooled recall, own flag | " +
        "Spread over repeats | Judgment recall, p >= 0.7 | Median ms | $ per 100 paragraphs |",
    );
    expect(rowFor("C (countable rules plus judgment)")).toContain("jev-1.2");
    expect(rowFor("Fast")).toContain(report.models[0]?.served_model ?? "no served model recorded");
    expect(report.models[0]?.served_model).toBeTruthy();
  });
});

// --- what arm D is actually scored on --------------------------------------

/** A reply whose boolean and whose probability disagree, which is the whole point. */
function split(values: Record<string, { flag: boolean; p: number }>): string {
  return JSON.stringify(values);
}

describe("the decision arm D is scored on", () => {
  test("the model's own flag is the verdict, and its probability is a second column", async () => {
    // Both seeded paragraphs are caught by the boolean the model was asked for,
    // and missed by the probability it wrote, which sits under this tool's line.
    const adapter = stubAdapter("openrouter", () =>
      modelReply(
        split({
          restating_closer: { flag: true, p: 0.6 },
          naked_cost_figure: { flag: true, p: 0.6 },
        }),
        40,
      ),
    );

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const fast = outcome.models.find((model) => model.id === "fast");
    expect(fast?.score?.overall["0.7"]?.recall).toBe(1);
    expect(fast?.scoreVerbalised?.overall["0.7"]?.recall).toBe(0);
  });

  test("every repeat is scored, and the spread says how far the row moved", async () => {
    // The first repeat catches both; the second catches one; the third none.
    const answers = [
      split({ restating_closer: { flag: true, p: 0.9 }, naked_cost_figure: { flag: true, p: 0.9 } }),
      split({ restating_closer: { flag: true, p: 0.9 }, naked_cost_figure: { flag: false, p: 0.1 } }),
      split({ restating_closer: { flag: false, p: 0.1 }, naked_cost_figure: { flag: false, p: 0.1 } }),
    ];
    let document = 0;
    const adapter = stubAdapter("openrouter", () => {
      const repeat = Math.floor(document / DOCUMENTS.length);
      document += 1;
      return modelReply(answers[repeat] ?? answers[0] ?? "{}", 30);
    });

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST],
      adapters: { openrouter: adapter },
      repeats: 3,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const fast = outcome.models.find((model) => model.id === "fast");
    expect(fast?.spread.repeats).toBe(3);
    expect(fast?.spread.perRepeat.map((row) => row.recall)).toEqual([1, 0.5, 0]);
    expect(fast?.spread.minRecall).toBe(0);
    expect(fast?.spread.maxRecall).toBe(1);
    expect(fast?.spread.meanRecall).toBeCloseTo(0.5, 10);

    const markdown = renderBenchMarkdown(
      buildBenchReport(outcome, {
        runDate: "2026-09-17",
        threshold: 0.7,
        repeats: 3,
        panelFile: "bench/panel.yaml",
        priceSources: [],
        corpus: { clean: 1, seeded: 2, seed: 1, perRule: 1 },
      }),
    );
    expect(markdown).toContain("0.000 to 1.000 over 3");
  });

  test("an unanswered cell is counted against its own rule, not against every rule", async () => {
    const adapter = stubAdapter("openrouter", () =>
      // One rule answered, one left out entirely.
      modelReply(split({ restating_closer: { flag: true, p: 0.9 } }), 30),
    );

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const fast = outcome.models.find((model) => model.id === "fast");
    expect(fast?.unansweredByRule["naked_cost_figure"]).toBe(DOCUMENTS.length);
    expect(fast?.unansweredByRule["restating_closer"] ?? 0).toBe(0);

    const markdown = renderBenchMarkdown(
      buildBenchReport(outcome, {
        runDate: "2026-09-17",
        threshold: 0.7,
        repeats: 1,
        panelFile: "bench/panel.yaml",
        priceSources: [],
        corpus: { clean: 1, seeded: 2, seed: 1, perRule: 1 },
      }),
    );
    const section = (rule: string): string =>
      markdown.split(`### ${rule}`)[1]?.split("###")[0] ?? "";
    // The stub says yes to this rule on every paragraph, so it catches the one
    // seeded for it and false-alarms on the clean one. Nothing is unanswered.
    expect(section("restating_closer")).toContain("| Fast | 1 | 1.000 | 1.000 | 0 |");
    expect(section("naked_cost_figure")).toContain(`| Fast | 1 | 0.000 | 0.000 | ${DOCUMENTS.length} |`);
  });

  test("every false-alarm denominator the scorer computed is printed with its k of n", async () => {
    const adapter = stubAdapter("openrouter", () =>
      modelReply(
        split({
          restating_closer: { flag: true, p: 0.9 },
          naked_cost_figure: { flag: true, p: 0.9 },
        }),
        30,
      ),
    );

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const markdown = renderBenchMarkdown(
      buildBenchReport(outcome, {
        runDate: "2026-09-17",
        threshold: 0.7,
        repeats: 1,
        panelFile: "bench/panel.yaml",
        priceSources: [],
        corpus: { clean: 1, seeded: 2, seed: 1, perRule: 1 },
      }),
    );

    expect(markdown).toContain("## False alarms, every way they were counted");
    expect(markdown).toContain(
      "| Model | Clean paragraphs flagged | Per clean cell | Per fireable clean cell | " +
        "Per negative cell | Off-rule flags |",
    );
    // The one clean paragraph was flagged by both judgment rules: one paragraph
    // of one, two cells of the clean ones.
    expect(markdown).toContain("| Fast | 1 of 1 ");
  });
});

describe("what each row was told to do about reasoning", () => {
  test("a row that declared no setting is printed as the provider's default, never as not reasoning", async () => {
    const adapter = stubAdapter("openrouter", () =>
      modelReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 30),
    );
    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST],
      adapters: { openrouter: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });
    const markdown = renderBenchMarkdown(
      buildBenchReport(outcome, {
        runDate: "2026-09-17",
        threshold: 0.7,
        repeats: 1,
        panelFile: "bench/panel.yaml",
        priceSources: [],
        corpus: { clean: 1, seeded: 2, seed: 1, perRule: 1 },
      }),
    );

    expect(markdown).not.toContain("not requested");
    expect(markdown).toContain("the provider's default, whatever that is for this model");
  });
});

describe("a preferred slug the provider has stopped listing", () => {
  const retired = (): readonly CatalogEntry[] => [
    { id: "openai/gpt-5.1-codex-mini", jsonMode: true },
    { id: "openai/gpt-5.2-mini", jsonMode: true },
  ];
  const fast = (over: Partial<PanelEntry> = {}): PanelEntry =>
    entry({
      id: "openai-fast",
      label: "OpenAI, fast tier",
      match: "^openai/gpt-5[^/]*mini$",
      prefer: ["openai/gpt-5-mini"],
      ...over,
    });

  test("is a row that says so, never the pattern's first other match", () => {
    const resolved = resolveEntry(fast(), retired(), { runDate: "2026-09-17" });

    expect(resolved.available).toBe(false);
    expect(resolved.slug).toBeNull();
    expect(resolved.note).toContain("not available on 2026-09-17");
    expect(resolved.note).toContain("openai/gpt-5-mini");
    expect(resolved.note).toContain("openai/gpt-5.1-codex-mini");
    // Every id the pattern matched is still recorded, so the choice not taken
    // is inspectable rather than invisible.
    expect(resolved.candidates).toHaveLength(2);
  });

  test("falls to an alternate only when the panel file named one, and says which", () => {
    const resolved = resolveEntry(fast({ alternates: ["openai/gpt-5.2-mini"] }), retired(), {
      runDate: "2026-09-17",
    });

    expect(resolved.available).toBe(true);
    expect(resolved.slug).toBe("openai/gpt-5.2-mini");
    expect(resolved.note).toContain("alternate openai/gpt-5.2-mini");
  });

  test("a row with no preference at all says which of its matches it took", () => {
    const resolved = resolveEntry(fast({ prefer: undefined }), retired(), {
      runDate: "2026-09-17",
    });

    expect(resolved.available).toBe(true);
    expect(resolved.slug).toBe("openai/gpt-5.1-codex-mini");
    expect(resolved.note).toContain("no preference is set");
  });
});

// --- Jev in the rotation ---------------------------------------------------

function jevResult(nouls: Record<string, number>, over: Partial<JevResult> = {}): JevResult {
  return {
    model: "jev-2026-09-01",
    nouls,
    inputTokens: 2800,
    outputTokens: 0,
    estimatedCostUsd: 0,
    usageReported: true,
    latencyMs: 210,
    attempts: 1,
    ...over,
  };
}

describe("Jev as a panel row", () => {
  const rules = RULES.rules.filter(isJudgmentRule);

  test("asks the judgment service its own way and answers in the panel's reply shape", async () => {
    const seen: JevRequest[] = [];
    const adapter = createJevAdapter({
      client: {
        ask: async (request) => {
          seen.push(request);
          return jevResult({ restating_closer: 0.91, naked_cost_figure: 0.2 });
        },
      },
      rules,
      threshold: 0.7,
    });

    const listed = await adapter.listModels();
    expect(listed).toHaveLength(1);
    // No price: no dated published source has been recorded for this endpoint,
    // so the row's cost prints as unknown rather than from a constant.
    expect(listed[0]?.inputUsdPerToken).toBeUndefined();

    const answer = await adapter.call({
      slug: "jev-latest",
      system: "ignored, the service takes its own question shape",
      user: userMessage("The counter reads high by four."),
      jsonMode: false,
      maxTokens: 900,
    });

    expect(seen[0]?.state).toBe("The counter reads high by four.");
    expect(Object.keys(seen[0]?.questions ?? {})).toEqual(rules.map((rule) => rule.id));
    expect(answer.servedModel).toBe("jev-2026-09-01");
    expect(answer.latencyMs).toBe(210);
    expect(JSON.parse(answer.text)).toEqual({
      restating_closer: { flag: true, p: 0.91 },
      naked_cost_figure: { flag: false, p: 0.2 },
    });
  });

  test("a reading inside the no-judgment band is unanswered, never a confident no", async () => {
    const adapter = createJevAdapter({
      client: { ask: async () => jevResult({ restating_closer: 0.5, naked_cost_figure: 0.85 }) },
      rules,
      threshold: 0.7,
    });

    const answer = await adapter.call({
      slug: "jev-latest",
      system: "",
      user: userMessage("Anything at all."),
      jsonMode: false,
      maxTokens: 900,
    });

    expect(JSON.parse(answer.text)).toEqual({ naked_cost_figure: { flag: true, p: 0.85 } });
  });

  test("runs in the same rotation and the same repeats as the panel rows", async () => {
    const order: string[] = [];
    const jev: ResolvedModel = {
      entry: entry({ id: "jev", label: "Jev", tier: "judgment", provider: "jev", match: "^jev-" }),
      available: true,
      slug: "jev-latest",
      candidates: ["jev-latest"],
      jsonMode: false,
      prices: null,
    };
    const jevAdapter = createJevAdapter({
      client: {
        ask: async () => {
          order.push("jev");
          return jevResult({ restating_closer: 0.9, naked_cost_figure: 0.9 });
        },
      },
      rules,
      threshold: 0.7,
    });
    const panelAdapter = stubAdapter("openrouter", () => {
      order.push("fast");
      return modelReply(reply({ restating_closer: 0.9, naked_cost_figure: 0.9 }), 60);
    });

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [FAST, jev],
      adapters: { openrouter: panelAdapter, jev: jevAdapter },
      repeats: 2,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    // The same round-robin every other row is in, not a separate pass.
    expect(order.slice(0, 4)).toEqual(["fast", "jev", "jev", "fast"]);
    const row = outcome.models.find((model) => model.id === "jev");
    expect(row?.calls).toBe(DOCUMENTS.length * 2);
    expect(row?.latency.samples).toBe(DOCUMENTS.length * 2);
    expect(row?.latency.medianMs).toBe(210);
    // No published price, so no cost figure at all rather than a zero.
    expect(row?.cost.usdPer100Paragraphs).toBeNull();
  });

  test("a refused call is a counted failure on the same ruler as every other row", async () => {
    const jev: ResolvedModel = {
      entry: entry({ id: "jev", label: "Jev", tier: "judgment", provider: "jev", match: "^jev-" }),
      available: true,
      slug: "jev-latest",
      candidates: ["jev-latest"],
      jsonMode: false,
      prices: null,
    };
    const adapter = createJevAdapter({
      client: {
        ask: async () => {
          throw new Error("the service refused this state");
        },
      },
      rules,
      threshold: 0.7,
    });

    const outcome = await runBench({
      ruleset: RULES,
      classes: CLASSES,
      documents: DOCUMENTS,
      resolved: [jev],
      adapters: { jev: adapter },
      repeats: 1,
      threshold: 0.7,
      runDate: "2026-09-17",
    });

    const row = outcome.models.find((model) => model.id === "jev");
    expect(row?.failures).toBe(DOCUMENTS.length);
    // A failed call is out of the latency median here exactly as it is for the
    // panel rows, rather than in one median and out of the other.
    expect(row?.latency.samples).toBe(0);
  });

  test("the paragraph is taken back out of the turn the bench prompt wrapped it in", () => {
    expect(paragraphOf(userMessage("One line."))).toBe("One line.");
    expect(paragraphOf("no wrapper at all")).toBe("no wrapper at all");
    expect(jevCatalog()[0]?.jsonMode).toBe(false);
  });
});
