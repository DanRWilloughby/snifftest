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
 *
 * The completion budget and the `reasoning` field come from the row's own panel
 * entry for the same reason. A reasoning model spends its internal tokens out
 * of the completion budget, so one budget for every row starves the deep rows
 * into replies that stop before the JSON object and read as failures. The
 * budget and the setting each row was sent travel back out in the raw results
 * and under the tables.
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
import type { CatalogEntry, ReasoningSetting } from "./panel.ts";

export const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";

/** The only name a key is read from. */
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";

/** Where the panel's prices come from when the run does not use a dated file. */
export const OPENROUTER_PRICE_SOURCE = "the OpenRouter models endpoint, read on the run date";

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
      const reasoning = reasoningField(request.reasoning);
      const body = JSON.stringify({
        model: request.slug,
        temperature: 0,
        max_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(reasoning === undefined ? {} : { reasoning }),
      });

      const { parsed, latencyMs, attempts } = await requestJson(options, () => ({
        url: OPENROUTER_CHAT_ENDPOINT,
        init: { method: "POST", headers: headers(), body },
      }));

      const root = asRecord(parsed);
      const usage = asRecord(root?.["usage"]);
      const details = asRecord(usage?.["completion_tokens_details"]);
      const served = root?.["model"];
      const finishReason = firstChoice(root)?.["finish_reason"];

      return {
        servedModel: typeof served === "string" ? served : request.slug,
        text: textOf(root),
        inputTokens: countOf(usage?.["prompt_tokens"]),
        outputTokens: billedOutput(usage, details),
        reasoningTokens: countOf(details?.["reasoning_tokens"]),
        finishReason: typeof finishReason === "string" ? finishReason : null,
        // OpenRouter normalises the stop word, so `length` is the one value that
        // means the reply ran out of budget rather than finished.
        truncated: finishReason === "length",
        latencyMs,
        attempts,
      };
    },
  };
}

/** The panel's setting, in the provider's own field names. */
function reasoningField(setting: ReasoningSetting | undefined): Record<string, unknown> | undefined {
  if (setting === undefined) return undefined;
  return {
    ...(setting.effort === undefined ? {} : { effort: setting.effort }),
    ...(setting.maxTokens === undefined ? {} : { max_tokens: setting.maxTokens }),
    ...(setting.exclude === undefined ? {} : { exclude: setting.exclude }),
  };
}

/**
 * What the call is billed for, which is not always what it wrote.
 *
 * OpenRouter documents `completion_tokens` as covering the reasoning tokens as
 * well as the visible answer, so the usual case is that number on its own. A
 * provider that reported the reasoning alongside rather than inside would
 * otherwise have a deep call priced as if it had only written its answer, so
 * reasoning that plainly is not inside the total is added to it. Undercounting
 * here would make the cheapest-looking row the one that thought the hardest.
 */
function billedOutput(
  usage: Record<string, unknown> | null,
  details: Record<string, unknown> | null,
): number {
  const completion = countOf(usage?.["completion_tokens"]);
  const reasoning = countOf(details?.["reasoning_tokens"]);
  return reasoning > completion ? completion + reasoning : completion;
}

function firstChoice(root: Record<string, unknown> | null): Record<string, unknown> | null {
  const choices = root?.["choices"];
  return Array.isArray(choices) ? asRecord(choices[0]) : null;
}

function textOf(root: Record<string, unknown> | null): string {
  const message = asRecord(firstChoice(root)?.["message"]);
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
