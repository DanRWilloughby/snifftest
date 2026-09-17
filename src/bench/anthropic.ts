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
 * metered with no cost at all, which is Houston's rule at
 * `src/producer/llm.ts` and for its reason: an invented zero reads as "free".
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
const MAX_TOKENS = 900;

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
      const body = JSON.stringify({
        model: request.slug,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        system: request.system,
        messages: [{ role: "user", content: request.user }],
      });

      const { parsed, latencyMs, attempts } = await requestJson(options, () => ({
        url: ANTHROPIC_MESSAGES_ENDPOINT,
        init: { method: "POST", headers: headers(), body },
      }));

      const root = asRecord(parsed);
      const usage = asRecord(root?.["usage"]);

      return {
        servedModel: typeof root?.["model"] === "string" ? (root["model"] as string) : request.slug,
        text: textOf(root),
        inputTokens: countOf(usage?.["input_tokens"]),
        outputTokens: countOf(usage?.["output_tokens"]),
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
