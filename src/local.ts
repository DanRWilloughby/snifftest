/**
 * The judgment rules, answered by a model you run yourself.
 *
 * Jev stays the default. This is the other door, for a person who cannot or
 * will not send a draft anywhere: point it at a server on your own machine that
 * speaks OpenAI's Chat Completions API (Ollama, LM Studio, llama.cpp's server
 * and vLLM all do) and the paragraphs never leave it.
 *
 * It asks the question the bench asks every panel model (`src/bench/prompt.ts`)
 * and reads the reply the same way, so a local model is held to the contract
 * the bench measured: one JSON object, a flag and a probability per rule, and
 * nothing repaired. A reply that is not that is a failed paragraph, never a
 * clean one.
 *
 * ## Size matters more than anything else here
 *
 * The open-weights run in issue #6 (same 166 paragraphs as the 2026-09-17 bench)
 * found laptop-sized models of 8 to 20B either missed about half the faults or
 * flagged about half the clean paragraphs. A 27B model was the first that held
 * up, at about 60 times Jev's time per paragraph. So the timeout below is long,
 * the README names the floor, and the CLI says once per run that these numbers
 * are the model's and not anything this tool has measured.
 *
 * ## What a no-judgment reading means here
 *
 * The band in `src/jev.ts` (0.4 to 0.6) was measured on Jev. A local model is
 * held to it anyway, because the alternative is letting a model's shrug count
 * as a flag, but nobody has measured where a given local model shrugs.
 */

import { buildSystemPrompt, parseReply, userMessage } from "./bench/prompt.ts";
import { chatText } from "./bench/chat-completions.ts";
import {
  type FetchLike,
  type JevClient,
  type JevRequest,
  type JevResult,
  JevHttpError,
  JevRequestError,
  JevStateRefusedError,
} from "./jev.ts";
import { asRecord } from "./types.ts";

/** Where the server lives, when `--judge-url` does not say. */
export const JUDGE_URL_ENV = "SNIFFTEST_JUDGE_URL";

/** Which model it should load, when `--judge-model` does not say. */
export const JUDGE_MODEL_ENV = "SNIFFTEST_JUDGE_MODEL";

/**
 * Three minutes for one paragraph.
 *
 * A 27B model on a laptop reads a long system prompt before it writes a word,
 * and a thinking model writes a good deal before it answers. Jev's ten seconds
 * would fail every paragraph on the hardware this exists for.
 */
export const LOCAL_TIMEOUT_MS = 180_000;

/**
 * The whole arm's budget per paragraph, a little over one timeout, so a slow
 * paragraph is allowed to finish and a server that has stopped answering
 * altogether still ends the run. `src/engine.ts` says why there is a budget.
 */
export const LOCAL_PER_PARAGRAPH_BUDGET_MS = 200_000;

/** Enough of a failure body to say why, short enough to sit in a log line. */
const MAX_BODY_CHARS = 200;

/**
 * A thinking model served without a separate reasoning field puts its working
 * in front of the answer. That block is the model's, not the reply, and the
 * JSON after it is what was asked for.
 */
const THINKING = /^\s*<think>[\s\S]*?<\/think>\s*/;

export interface LocalJudge {
  /** The server's base URL, up to and including `/v1`. */
  readonly url: string;
  readonly model: string;
}

export interface LocalClientOptions extends LocalJudge {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/** The address the requests go to, from the base URL a person types. */
export function chatEndpoint(url: string): string {
  return `${url.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Whether a URL names this machine.
 *
 * Only the loopback names count. A server on the local network is somebody's
 * other computer, and a paragraph sent there has left this one, so it gets the
 * same consent question as any other destination.
 */
export function isLoopback(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

export function createLocalClient(options: LocalClientOptions): JevClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? LOCAL_TIMEOUT_MS;
  const endpoint = chatEndpoint(options.url);

  return {
    model: options.model,
    async ask(request: JevRequest): Promise<JevResult> {
      if (typeof request.state !== "string" || request.state.trim() === "") {
        throw new JevStateRefusedError("state must be non-empty text.");
      }

      const rules = Object.entries(request.questions).map(([id, question]) => {
        const instructions = question.instructions;
        const notFor = instructions["not_for"];
        const examples = instructions["examples"];
        return {
          id,
          what: String(instructions["what"] ?? ""),
          ...(typeof notFor === "string" ? { not_for: notFor } : {}),
          ...(Array.isArray(examples) ? { examples: examples.map(String) } : {}),
          criteria: question.criteria,
        };
      });

      const body = JSON.stringify({
        model: options.model,
        temperature: 0,
        messages: [
          { role: "system", content: buildSystemPrompt(rules) },
          { role: "user", content: userMessage(request.state) },
        ],
      });

      const started = Date.now();
      const root = asRecord(await post(doFetch, endpoint, body, timeoutMs));
      const text = chatText(root).replace(THINKING, "");

      let parsed;
      try {
        parsed = parseReply(text, Object.keys(request.questions));
      } catch (error) {
        throw new JevRequestError(
          `${options.model} did not answer in the shape asked for: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Small models answer under names of their own ("rule_1") as often as
      // under the ids they were given. Counted silently that is a column of
      // "unanswered" with no reason beside it, so a reply that answered none of
      // the rules it was asked about is a failed paragraph that says why.
      const readings = parsed.readings;
      if (Object.keys(readings).length === 0) {
        const named = parsed.extra.length === 0 ? "" : `, and used names it was not given (${parsed.extra.slice(0, 3).join(", ")})`;
        throw new JevRequestError(`${options.model} answered none of the rules it was asked about${named}`);
      }

      const nouls: Record<string, number> = {};
      for (const [id, reading] of Object.entries(readings)) nouls[id] = reading.p;

      const usage = asRecord(root?.["usage"]);
      const served = root?.["model"];
      return {
        model: typeof served === "string" && served !== "" ? served : options.model,
        nouls,
        inputTokens: countOf(usage?.["prompt_tokens"]),
        outputTokens: countOf(usage?.["completion_tokens"]),
        // Nobody is billed. Electricity is real, and it is not this tool's to price.
        estimatedCostUsd: 0,
        usageReported: usage !== null,
        latencyMs: Date.now() - started,
        attempts: 1,
      };
    },
  };
}

async function post(
  doFetch: FetchLike,
  endpoint: string,
  body: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // A localhost server is asked nothing about consent, so it must not be
      // able to pass the paragraph on: a 307 keeps the body and could point
      // anywhere. A redirect is a failure here, never a hop.
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      // A 404 is usually a model that was never pulled, and the server says so
      // in the body, which is the line a person needs to read.
      const detail = await response.text().catch(() => "");
      throw new JevHttpError(
        response.status,
        `the model server returned ${response.status}${
          detail.trim() === "" ? "" : `: ${detail.trim().slice(0, MAX_BODY_CHARS)}`
        }`,
      );
    }

    // SAFETY: `json()` is typed `any`; widening it to `unknown` makes every
    // field below get checked rather than trusted.
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof JevHttpError) throw error;
    if (controller.signal.aborted) {
      throw new JevRequestError(`the model server did not answer within ${timeoutMs / 1000} seconds`);
    }
    throw new JevRequestError(
      `could not reach the model server at ${endpoint} (is it running?): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
