/**
 * What every panel provider has to be able to do, and the one place the
 * network manners live.
 *
 * Two adapters, one contract: list the models you have, and answer one
 * question about one paragraph. Everything else lives here, once, so a third
 * adapter cannot be added with worse manners than the first two. That is the
 * timeout, the retry ladder, how a failure body is quoted, and the fact that no
 * error string may carry a key.
 *
 * The retry ladder is the gateway's (`src/jev.ts`), which is the T1 spike's:
 * four attempts, doubling backoff, on 429 and the 5xx family only. A 401 is not
 * retried, because a rejected key is rejected four times just as fast.
 *
 * Every error message is built from a status and a capped body and then passed
 * through `scrubSecrets` with every key the run holds, not only this adapter's
 * own. A bench run has an OpenRouter key and an Anthropic key in the same
 * process, and a service that echoes a request back can echo either.
 */

import { scrubSecrets } from "../scrub.ts";
import type { FetchLike } from "../jev.ts";
import type { CatalogEntry, Provider, ReasoningSetting } from "./panel.ts";

export type { FetchLike };

/** One paragraph, one model, one answer. */
export interface ModelCall {
  readonly slug: string;
  readonly system: string;
  readonly user: string;
  /** Whether to ask for structured output; set from the model's catalogue entry. */
  readonly jsonMode: boolean;
  /** The completion budget for this row, from its panel entry. */
  readonly maxTokens: number;
  /** Absent when the row asks for no reasoning at all. */
  readonly reasoning?: ReasoningSetting;
}

export interface ModelReply {
  /** What the provider says it actually served, which may be a dated id. */
  readonly servedModel: string;
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * The internal reasoning the provider billed for, when it reports any.
   *
   * Reported separately from `outputTokens` because it is the number that
   * explains a deep row's cost and a deep row's truncations, and because a
   * reader comparing two rows deserves to see which one was thinking.
   */
  readonly reasoningTokens: number;
  /** The provider's own word for why it stopped, or nothing when it said none. */
  readonly finishReason: string | null;
  /** The reply ran out of completion budget. A different failure from a torn one. */
  readonly truncated: boolean;
  readonly latencyMs: number;
  readonly attempts: number;
}

export interface ModelAdapter {
  readonly provider: Provider;
  /** The provider's own list, used to resolve the panel on the run date. */
  listModels(): Promise<readonly CatalogEntry[]>;
  call(request: ModelCall): Promise<ModelReply>;
}

export interface AdapterOptions {
  /** Read from the environment by the caller; never from a file this tool reads. */
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Total tries, not extra ones. */
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Every key in play this run, so an echoed one is removed whoever it belongs to. */
  readonly secrets?: readonly string[];
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1000;
const MAX_BODY_CHARS = 200;

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class AdapterHttpError extends AdapterError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class AdapterRequestError extends AdapterError {}

export interface Attempted {
  readonly parsed: unknown;
  readonly latencyMs: number;
  readonly attempts: number;
}

/**
 * One request, retried by the ladder, with every error scrubbed on the way out.
 *
 * `latencyMs` is measured end to end across the attempts that were needed, the
 * same way the gateway measures it, so a retried call is honestly slower rather
 * than quietly reported as its last attempt.
 */
export async function requestJson(
  options: AdapterOptions,
  build: () => { url: string; init: RequestInit },
): Promise<Attempted> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const secrets = [options.apiKey, ...(options.secrets ?? [])];

  const started = Date.now();
  let last: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { url, init } = build();
      const parsed = await once(doFetch, url, init, timeoutMs);
      return { parsed, latencyMs: Date.now() - started, attempts: attempt };
    } catch (error) {
      last = error;
      if (!isRetryable(error) || attempt === attempts) break;
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }

  throw scrubbed(last, secrets);
}

async function once(
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(url, { ...init, signal: controller.signal });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AdapterHttpError(
        response.status,
        `${url} returned ${response.status}${
          detail.trim() === "" ? "" : `: ${detail.trim().slice(0, MAX_BODY_CHARS)}`
        }`,
      );
    }

    // SAFETY: `json()` is typed `any`; widening to `unknown` forces every reader
    // below to check the wire rather than trust it.
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (controller.signal.aborted) {
      throw new AdapterRequestError(`${url} timed out after ${timeoutMs} ms`);
    }
    throw new AdapterRequestError(`${url} failed: ${messageOf(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof AdapterHttpError) return error.status === 429 || error.status >= 500;
  return true;
}

function scrubbed(error: unknown, secrets: readonly string[]): Error {
  const message = scrubSecrets(messageOf(error), secrets);
  if (error instanceof AdapterHttpError) return new AdapterHttpError(error.status, message);
  return new AdapterRequestError(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- reading the wire -----------------------------------------------------

export { asRecord } from "../types.ts";

export function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A price the provider published as a string, or nothing. Never a zero stand-in. */
export function priceOf(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}
