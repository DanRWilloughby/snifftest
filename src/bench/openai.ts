/**
 * An OpenAI row called on OpenAI's own API, with OpenAI's own key.
 *
 * The panel routes most of its rows through OpenRouter so that one key
 * reproduces the whole bench, and that hop sits in every latency number. This
 * adapter is the other way of asking: someone who holds an `OPENAI_API_KEY` and
 * no OpenRouter account can still measure an OpenAI model, and the number they
 * get back is the provider's latency rather than a proxy's.
 *
 * The models endpoint publishes ids and nothing else: no prices, and no list of
 * the parameters each model takes. So a row here is priced from a dated file
 * (`src/bench/prices.ts`) the way the Anthropic direct row is, and a served
 * model the file has no row for is metered with no cost at all rather than a
 * zero that would read as "free".
 *
 * Three things about the request are the provider's rules rather than ours, and
 * each one is a run that failed before it was written down: the completion
 * budget rides in `max_completion_tokens`, the reasoning models reject
 * `temperature`, and the reasoning setting is a single `reasoning_effort`
 * string rather than the object OpenRouter takes. The panel refuses the two
 * settings this request has no field for, rather than printing a footnote about
 * a budget the wire never carried.
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
import { billedOutput, chatText, firstChoice } from "./chat-completions.ts";
import type { CatalogEntry } from "./panel.ts";

export const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
export const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";

/** The only name a key is read from. */
export const OPENAI_KEY_ENV = "OPENAI_API_KEY";

export function readOpenAICatalog(payload: unknown): CatalogEntry[] {
  const data = asRecord(payload)?.["data"];
  if (!Array.isArray(data)) return [];

  const out: CatalogEntry[] = [];
  for (const value of data) {
    const id = asRecord(value)?.["id"];
    if (typeof id !== "string") continue;
    // The models endpoint publishes no prices and no parameter list, so an
    // entry here carries the one thing it can: that the model exists. The JSON
    // mode is asserted rather than read because every current chat model on
    // this API accepts `response_format`, and an entry that said otherwise
    // would turn a capable model into a row of parse failures.
    out.push({ id, jsonMode: true });
  }
  return out;
}

export function createOpenAIAdapter(options: AdapterOptions): ModelAdapter {
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    authorization: `Bearer ${options.apiKey}`,
  });

  return {
    provider: "openai",

    async listModels(): Promise<readonly CatalogEntry[]> {
      const { parsed } = await requestJson(options, () => ({
        url: OPENAI_MODELS_ENDPOINT,
        init: { method: "GET", headers: headers() },
      }));
      return readOpenAICatalog(parsed);
    },

    async call(request: ModelCall): Promise<ModelReply> {
      const effort = request.reasoning?.effort;
      const body = JSON.stringify({
        model: request.slug,
        // Not `max_tokens`: this API deprecated that name and the reasoning
        // models reject a request carrying it outright.
        max_completion_tokens: request.maxTokens,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        ...(request.jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
        // No `temperature` at all. Every other row in the panel is sent 0, and
        // the gpt-5 family refuses any value but its default, so a temperature
        // here would fail the row rather than pin it. The footnote under the
        // tables is what says this row was not held to the same zero.
      });

      const { parsed, latencyMs, attempts } = await requestJson(options, () => ({
        url: OPENAI_CHAT_ENDPOINT,
        init: { method: "POST", headers: headers(), body },
      }));

      const root = asRecord(parsed);
      const usage = asRecord(root?.["usage"]);
      const details = asRecord(usage?.["completion_tokens_details"]);
      const served = root?.["model"];
      const finishReason = firstChoice(root)?.["finish_reason"];

      return {
        servedModel: typeof served === "string" ? served : request.slug,
        text: chatText(root),
        inputTokens: countOf(usage?.["prompt_tokens"]),
        outputTokens: billedOutput(usage, details),
        reasoningTokens: countOf(details?.["reasoning_tokens"]),
        finishReason: typeof finishReason === "string" ? finishReason : null,
        // `length` is the one stop word that means the reply ran out of
        // completion budget rather than finished.
        truncated: finishReason === "length",
        latencyMs,
        attempts,
      };
    },
  };
}
