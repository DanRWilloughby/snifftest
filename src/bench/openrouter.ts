/**
 * The whole panel except the control, through one key and one latency path.
 *
 * Routing every model through OpenRouter is a deliberate trade. It costs a
 * little accuracy on absolute latency — there is a proxy hop in every number —
 * and it buys the thing the comparison actually needs: one key to reproduce the
 * bench, and the same hop in every row, so the differences between rows are
 * differences between models. The Anthropic direct row exists to measure that
 * hop, which is why it is called the overhead control.
 *
 * Structured output is requested only for models whose own catalogue entry says
 * they accept `response_format`. Asking for it elsewhere is how a run turns a
 * capable model into a row of parse failures that say more about the request
 * than the model.
 */

import {
  type AdapterOptions,
  type ModelAdapter,
  type ModelCall,
  type ModelReply,
  asRecord,
  countOf,
  priceOf,
  requestJson,
} from "./adapter.ts";
import type { CatalogEntry } from "./panel.ts";

export const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

/** The only name a key is read from. */
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";

/** Where the panel's prices come from when the run does not use a dated file. */
export const OPENROUTER_PRICE_SOURCE = "the OpenRouter models endpoint, read on the run date";

/** Long enough for a deep model on a paragraph, short enough to fail a run in a day. */
const MAX_TOKENS = 900;

export function readOpenRouterCatalog(payload: unknown): CatalogEntry[] {
  const data = asRecord(payload)?.["data"];
  if (!Array.isArray(data)) return [];

  const out: CatalogEntry[] = [];
  for (const value of data) {
    const model = asRecord(value);
    const id = model?.["id"];
    if (typeof id !== "string") continue;

    const pricing = asRecord(model?.["pricing"]);
    const input = priceOf(pricing?.["prompt"]);
    const output = priceOf(pricing?.["completion"]);
    const supported = model?.["supported_parameters"];

    out.push({
      id,
      // Both or neither: half a price cannot cost a call.
      ...(input === undefined || output === undefined
        ? {}
        : { inputUsdPerToken: input, outputUsdPerToken: output }),
      jsonMode: Array.isArray(supported) && supported.includes("response_format"),
    });
  }
  return out;
}

export function createOpenRouterAdapter(options: AdapterOptions): ModelAdapter {
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
  });

  return {
    provider: "openrouter",

    async listModels(): Promise<readonly CatalogEntry[]> {
      const { parsed } = await requestJson(options, () => ({
        url: OPENROUTER_MODELS_ENDPOINT,
        init: { method: "GET", headers: headers() },
      }));
      return readOpenRouterCatalog(parsed);
    },

    async call(request: ModelCall): Promise<ModelReply> {
      const body = JSON.stringify({
        model: request.slug,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
      });

      const { parsed, latencyMs, attempts } = await requestJson(options, () => ({
        url: OPENROUTER_CHAT_ENDPOINT,
        init: { method: "POST", headers: headers(), body },
      }));

      const root = asRecord(parsed);
      const usage = asRecord(root?.["usage"]);

      return {
        servedModel: typeof root?.["model"] === "string" ? (root["model"] as string) : request.slug,
        text: textOf(root),
        inputTokens: countOf(usage?.["prompt_tokens"]),
        outputTokens: countOf(usage?.["completion_tokens"]),
        latencyMs,
        attempts,
      };
    },
  };
}

function textOf(root: Record<string, unknown> | null): string {
  const choices = root?.["choices"];
  if (!Array.isArray(choices)) return "";

  const message = asRecord(asRecord(choices[0])?.["message"]);
  const content = message?.["content"];
  if (typeof content === "string") return content;

  // Some routed models answer with the parts array the Chat Completions spec allows.
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const text = asRecord(part)?.["text"];
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}
