/**
 * One model, twice: the overhead control.
 *
 * Every other row in the panel reaches its model through OpenRouter, which adds
 * a hop to every latency number. This adapter calls one of those models
 * directly, so the pair of rows measures the hop rather than leaving it as an
 * asterisk under the table.
 *
 * The Messages API publishes no prices, so this row is the one priced from a
 * dated file (`src/bench/prices.ts`). A served model the file has no row for is
 * metered with no cost at all, which is the rule an earlier tool of ours used
 * and for its reason: an invented zero reads as "free".
 *
 * This adapter honours the row's own completion budget, and has no extended
 * thinking wired into it. A panel row that asks for reasoning on this provider
 * is refused when the file is read, rather than being sent a request without
 * the setting and printed in a footnote that says it had one.
 */

import {
  type AdapterOptions,
  type ModelAdapter,
  type ModelCall,
  type ModelReply,
  asRecord,
  countOf,
  requestJson,
} from "./adapter.ts";
import type { CatalogEntry } from "./panel.ts";

export const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_MODELS_ENDPOINT = "https://api.anthropic.com/v1/models";

/** The only name a key is read from. */
export const ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";

const API_VERSION = "2023-06-01";

export function readAnthropicCatalog(payload: unknown): CatalogEntry[] {
  const data = asRecord(payload)?.["data"];
  if (!Array.isArray(data)) return [];

  const out: CatalogEntry[] = [];
  for (const value of data) {
    const id = asRecord(value)?.["id"];
    // The Messages API has no structured-output flag and publishes no prices,
    // so an entry here carries the one thing it can: that the model exists.
    if (typeof id === "string") out.push({ id, jsonMode: false });
  }
  return out;
}

export function createAnthropicAdapter(options: AdapterOptions): ModelAdapter {
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-api-key": options.apiKey,
    "anthropic-version": API_VERSION,
  });

  return {
    provider: "anthropic",

    async listModels(): Promise<readonly CatalogEntry[]> {
      const { parsed } = await requestJson(options, () => ({
        url: ANTHROPIC_MODELS_ENDPOINT,
        init: { method: "GET", headers: headers() },
      }));
      return readAnthropicCatalog(parsed);
    },

    async call(request: ModelCall): Promise<ModelReply> {
      // No temperature. The Claude 5 models refuse the field outright (a 400
      // that reads "`temperature` is deprecated for this model"), so a row on
      // this provider is asked at the provider's default, and every row on it
      // is asked the same way. The tables say so in the request footnote.
      const body = JSON.stringify({
        model: request.slug,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      });

      const { parsed, latencyMs, attempts } = await requestJson(options, () => ({
        url: ANTHROPIC_MESSAGES_ENDPOINT,
        init: { method: "POST", headers: headers(), body },
      }));

      const root = asRecord(parsed);
      const usage = asRecord(root?.["usage"]);
      const served = root?.["model"];
      const stopReason = root?.["stop_reason"];

      return {
        servedModel: typeof served === "string" ? served : request.slug,
        text: textOf(root),
        inputTokens: countOf(usage?.["input_tokens"]),
        outputTokens: countOf(usage?.["output_tokens"]),
        // No row asks this adapter for extended thinking, and the panel refuses
        // a row that tries, so there is no reasoning here to report.
        reasoningTokens: 0,
        finishReason: typeof stopReason === "string" ? stopReason : null,
        truncated: stopReason === "max_tokens",
        latencyMs,
        attempts,
      };
    },
  };
}

function textOf(root: Record<string, unknown> | null): string {
  const content = root?.["content"];
  if (!Array.isArray(content)) return "";

  for (const block of content) {
    const record = asRecord(block);
    if (record?.["type"] === "text" && typeof record["text"] === "string") return record["text"];
  }
  return "";
}
