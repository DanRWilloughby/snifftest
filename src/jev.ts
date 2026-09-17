/**
 * The one place this tool talks to a network.
 *
 * It sends a paragraph and a set of judgment questions to TypeSafe's System One
 * endpoint and gets a probability back for each question. No SDK: the request is
 * one POST with a JSON body, and `fetch` covers it in a hundred lines. A package
 * that promises zero runtime dependencies cannot spend that promise on a single
 * call, and a dependency tree is the supply-chain surface an installed linter
 * least wants.
 *
 * Three things here are not obvious and all three are deliberate.
 *
 * ## The state guard is local, and it has to be
 *
 * Jev answers HTTP 200 to image state (base64, a data URI, an image block) and
 * returns probabilities near 0.5 for every question (measured 2026-09-16).
 * That is the worst failure shape there is: a clean success carrying numbers
 * that mean nothing. Nothing downstream can tell those apart from real answers,
 * so anything that is not plain text is refused here, before the request is
 * built, and the service is never asked to do the refusing.
 *
 * ## An error may quote the request
 *
 * A service that rejects a request often echoes what it was sent, which is how
 * a credential ends up in a log. Every error string this module throws is built
 * from a status and a capped body and then passed through `scrubSecrets` with
 * the key in hand, so a key that comes back, whole or cut in half, leaves as
 * `[key hidden]`.
 *
 * ## The retry ladder is the spike's
 *
 * Four attempts, doubling backoff, on the statuses that a second try can plausibly
 * fix (429 and the 5xx family). A 4xx that is not 429 is a request problem: a
 * bad key retried four times is four times the wait and the same answer. The
 * ladder is carried over from the measurement harness this was spiked with,
 * which is where the numbers came from.
 *
 * When the service says how long to wait, its number is used instead of the
 * doubling one, capped, because a `Retry-After` of two seconds is a fact and the
 * ladder's four is a guess. The cap is there because the header is a number
 * somebody else controls, and a run must not be parked for an hour by it. A
 * header that says longer than the cap is treated as a failure worth reporting
 * rather than a wait worth taking: the ladder tries once more at the cap and
 * then gives the paragraph up, which is the caller's business to report.
 */

import { scrubSecrets } from "./scrub.ts";
import { type JudgmentRule, asRecord } from "./types.ts";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** The alias, not a pinned version; the served model comes back in the response. */
export const MODEL = "jev-latest";

/** The only name a key is ever read from. Never a fallback, never a repo file. */
export const KEY_ENV = "TYPESAFE_API_KEY";

/**
 * Characters of state per request.
 *
 * Placeholder, derived from the roughly 32K-token budget the state and the
 * questions share. It exists so an over-long chunk fails here, with a number in
 * the message, rather than somewhere inside the service with a shape we cannot
 * read.
 */
export const STATE_GUARD_CHARS = 24_000;

/**
 * The band in which a probability is not an opinion.
 *
 * Jev answers about 0.5 on state it cannot read, and the local guard above only
 * catches the shapes we can recognise before sending. Anything else it cannot
 * read comes back as a flat middle number, which is the one failure mode that
 * looks exactly like a clean draft. So the middle is named: a reading from
 * `NO_JUDGMENT_LOW` to `NO_JUDGMENT_HIGH` inclusive is reported as no judgment,
 * counted, and never allowed to become a flag or to stand in for a pass.
 *
 * The width is the spike's (measured 2026-09-16), and it is deliberately wider
 * than the flat answers observed, because a band that only just covers what has
 * been seen is a band that stops working the first time the service changes.
 */
export const NO_JUDGMENT_LOW = 0.4;
export const NO_JUDGMENT_HIGH = 0.6;

/** Whether a probability sits inside the no-judgment band. */
export function isNoJudgment(probability: number): boolean {
  return probability >= NO_JUDGMENT_LOW && probability <= NO_JUDGMENT_HIGH;
}

/** US dollars per input token. Output tokens are free on this endpoint. */
export const INPUT_TOKEN_PRICE_USD = 0.042e-6;

/**
 * Where every cost figure in this repo comes from.
 *
 * Token counts are whatever the service reported for the request, never an
 * estimate from the text. The price is the constant above, and `source` is
 * null because no dated published price has been recorded for this endpoint.
 * A report prints this beside its cost column so a reader can see that the
 * usage is measured and the price is not sourced, rather than reading a
 * dollar figure as a fact.
 */
export const PRICE_BASIS = {
  usage: "provider-reported" as const,
  usd_per_input_token: INPUT_TOKEN_PRICE_USD,
  usd_per_output_token: 0,
  source: null,
  verified_on: null,
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1000;

/**
 * The longest wait a `Retry-After` header can buy. Past this the service is
 * asking for more time than a check of somebody's prose is worth holding for.
 */
const MAX_RETRY_AFTER_MS = 8000;

/** Enough of a failure body to say why, short enough to sit in a log line. */
const MAX_BODY_CHARS = 200;

/** A second try can fix these and nothing else. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 529]);

/** A run this long with no space is an encoded blob, not a sentence. */
const MAX_BASE64_RUN = 256;

const DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;
const BASE64_RUN = new RegExp(`[A-Za-z0-9+/]{${MAX_BASE64_RUN + 1},}={0,2}`);

/** Why non-text state cannot simply be sent and left to the service to refuse. */
const IMAGE_REASON =
  "Jev answers HTTP 200 on image or non-text state with probabilities near 0.5, so this is refused here rather than sent";

// --- the wire shapes ------------------------------------------------------

export interface NoulQuestion {
  readonly type: "noul";
  /** A string or an object; structured instructions are accepted and score better. */
  readonly instructions: Readonly<Record<string, unknown>>;
  /** A dictionary, always. A list comes back as HTTP 422. */
  readonly criteria: { readonly true: string; readonly false: string };
}

export interface JevRequest {
  /**
   * Text, and the type says `unknown` on purpose: the guard below is the real
   * contract, and a `string` here would just be cast away at a call site that
   * parses JSON.
   */
  readonly state: unknown;
  readonly questions: Readonly<Record<string, NoulQuestion>>;
}

export interface JevResult {
  /** The served model, which is a pinned version even though we asked for the alias. */
  readonly model: string;
  /** Question id to probability, 0 to 1. */
  readonly nouls: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  /**
   * Whether the service reported usage at all.
   *
   * A reply with no usage object gives zero tokens and a cost of zero, and a
   * zero here is a claim about a request that was certainly paid for. The flag
   * lets a report print the cost as unmeasured instead of as free.
   */
  readonly usageReported: boolean;
  readonly latencyMs: number;
  /** How many tries it took, so a caller can report retries instead of hiding them. */
  readonly attempts: number;
}

export interface JevClient {
  ask(request: JevRequest): Promise<JevResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JevClientOptions {
  /** Defaults to the environment, read at call time. */
  readonly apiKey?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  /** Total tries, not extra ones. */
  readonly attempts?: number;
  readonly stateGuardChars?: number;
  /** Injected so tests do not actually wait out a backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

// --- errors ---------------------------------------------------------------

export class JevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No key. The CLI turns this into the dry-run hint rather than a stack trace. */
export class JevMissingKeyError extends JevError {
  constructor() {
    super(
      `${KEY_ENV} is not set. Export it, or run with --dry-run to check the countable rules only.`,
    );
  }
}

/** The state never left the machine. */
export class JevStateRefusedError extends JevError {}

/** The service answered, and said no. */
export class JevHttpError extends JevError {
  constructor(
    readonly status: number,
    message: string,
    /** What `Retry-After` asked for, in ms, when the service sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** The service did not answer, or answered with something unreadable. */
export class JevRequestError extends JevError {}

// --- the gateway ----------------------------------------------------------

export function estimatedCostUsd(inputTokens: number): number {
  return inputTokens * INPUT_TOKEN_PRICE_USD;
}

/** One judgment rule, in the shape the endpoint reads. */
export function questionsFromRules(
  rules: readonly JudgmentRule[],
): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};

  for (const rule of rules) {
    const instructions: Record<string, unknown> = { what: rule.what };
    if (rule.not_for !== undefined) instructions["not_for"] = rule.not_for;
    if (rule.examples !== undefined && rule.examples.length > 0) {
      instructions["examples"] = rule.examples;
    }

    questions[rule.id] = {
      type: "noul",
      instructions,
      criteria: { true: rule.criteria.true, false: rule.criteria.false },
    };
  }

  return questions;
}

export function createJevClient(options: JevClientOptions = {}): JevClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const guard = options.stateGuardChars ?? STATE_GUARD_CHARS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async ask(request: JevRequest): Promise<JevResult> {
      const state = guardState(request.state, guard);
      const key = options.apiKey ?? process.env[KEY_ENV] ?? "";
      if (key === "") throw new JevMissingKeyError();

      const body = JSON.stringify({ model: MODEL, state, questions: request.questions });
      const started = Date.now();
      let last: unknown;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const parsed = await post(doFetch, key, body, timeoutMs);
          return {
            ...readAnswer(parsed),
            latencyMs: Date.now() - started,
            attempts: attempt,
          };
        } catch (error) {
          last = error;
          if (!isRetryable(error) || attempt === attempts) break;
          const wait = waitFor(error, attempt);
          if (wait === null) {
            if (error instanceof JevHttpError) last = askedTooLong(error);
            break;
          }
          await sleep(wait);
        }
      }

      throw scrubbed(last, key);
    },
  };
}

// --- the pieces -----------------------------------------------------------

/**
 * Text only, bounded, and nothing that looks encoded.
 *
 * Runs before the key is read and before a body is built, so a refusal here
 * cannot have sent anything.
 */
function guardState(state: unknown, guard: number): string {
  if (typeof state !== "string") {
    throw new JevStateRefusedError(
      `state must be text, and this state is ${state === null ? "null" : typeof state}. ${IMAGE_REASON}.`,
    );
  }
  if (state.trim() === "") {
    throw new JevStateRefusedError("state is empty, so there is nothing to judge.");
  }
  if (state.length > guard) {
    throw new JevStateRefusedError(
      `state is ${state.length} characters and the guard is ${guard}. Split the document into smaller chunks.`,
    );
  }
  if (DATA_URI.test(state)) {
    throw new JevStateRefusedError(`state carries a data URI. ${IMAGE_REASON}.`);
  }
  if (BASE64_RUN.test(state)) {
    throw new JevStateRefusedError(
      `state carries an unbroken run of more than ${MAX_BASE64_RUN} encoded characters. ${IMAGE_REASON}.`,
    );
  }
  return state;
}

async function post(
  doFetch: FetchLike,
  key: string,
  body: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const asked = retryAfterMs(response.headers.get("retry-after"));
      throw new JevHttpError(
        response.status,
        `jev returned ${response.status}${
          detail.trim() === "" ? "" : `: ${detail.trim().slice(0, MAX_BODY_CHARS)}`
        }`,
        asked,
      );
    }

    // SAFETY: `json()` is typed `any`; widening it to `unknown` is what forces
    // `readAnswer` to check every field instead of trusting the wire.
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof JevError) throw error;
    if (controller.signal.aborted) {
      throw new JevRequestError(`jev request timed out after ${timeoutMs} ms`);
    }
    throw new JevRequestError(`jev request failed: ${messageOf(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

type Answer = Omit<JevResult, "latencyMs" | "attempts">;

function readAnswer(parsed: unknown): Answer {
  const root = asRecord(parsed);
  const answers = asRecord(root?.["answers"]);
  if (answers === null) {
    throw new JevRequestError("jev response carried no answers object");
  }

  const nouls: Record<string, number> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const noul = asRecord(answer)?.["noul"];
    // A missing noul, a noul that is not a number, and a number outside 0 to 1
    // are all dropped rather than defaulted: the caller can tell "not answered"
    // from "answered low" only if we never invent a number, and a probability
    // of 7 is not a probability. The panel's reader holds its models to the
    // same range (`src/bench/prompt.ts`), and two arms scored against each
    // other have to be held to one contract.
    if (typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1) {
      nouls[id] = noul;
    }
  }

  const usage = asRecord(root?.["usage"]);
  const inputTokens = countOf(usage?.["input_tokens"]);
  const served = root?.["model"];

  return {
    model: typeof served === "string" ? served : MODEL,
    nouls,
    inputTokens,
    outputTokens: countOf(usage?.["output_tokens"]),
    estimatedCostUsd: estimatedCostUsd(inputTokens),
    usageReported: usage !== null,
  };
}

/**
 * How long to wait before the next attempt, or `null` for do not wait at all.
 *
 * What the service asked for if it asked, and the doubling ladder if it did
 * not. Two shapes of header are not waits. Past the cap the service is asking
 * for more time than a check of somebody's prose is worth holding for, and the
 * answer is to report the failure rather than to take the cap three times over
 * and report it anyway a minute later. A header of zero is a service saying
 * "at once", which is a request to hammer it, so it gets the ladder's first
 * step instead.
 */
function waitFor(error: unknown, attempt: number): number | null {
  const ladder = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  if (!(error instanceof JevHttpError)) return ladder;
  const asked = error.retryAfterMs;
  if (asked === undefined) return ladder;
  if (asked > MAX_RETRY_AFTER_MS) return null;
  return Math.max(asked, BACKOFF_BASE_MS);
}

/** The same failure, saying why nobody waited for it. */
function askedTooLong(error: JevHttpError): JevHttpError {
  const asked = Math.round((error.retryAfterMs ?? 0) / 1000);
  const cap = MAX_RETRY_AFTER_MS / 1000;
  return new JevHttpError(
    error.status,
    `${error.message} (it asked for ${asked} seconds before the next try, past the ${cap} second ` +
      "cap, so this is reported rather than waited out)",
    error.retryAfterMs,
  );
}

/**
 * `Retry-After`, which is either a number of seconds or an HTTP date, and is
 * written by somebody else, so every shape that is not a time in the future
 * comes back undefined rather than as a wait of zero or NaN.
 */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  if (text === "") return undefined;

  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }

  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  const wait = at - now;
  return wait > 0 ? wait : 0;
}

/**
 * Whether a failure is the kind that a later request might not meet.
 *
 * A 429 or a 5xx or a dropped socket is about this minute. A 401, a 403 or a
 * 422 is about the request, and the next paragraph will be told the same thing
 * in the same words. Callers running a long loop need that difference: one is
 * worth carrying on through, the other is worth stopping on at once.
 */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof JevStateRefusedError || error instanceof JevMissingKeyError) return false;
  if (error instanceof JevHttpError) return RETRYABLE_STATUSES.has(error.status);
  // A torn response, a timeout, a dropped socket: all worth one more try.
  return true;
}

function isRetryable(error: unknown): boolean {
  return isTransientFailure(error);
}

/** The last error, with any trace of the key taken out of its message. */
function scrubbed(error: unknown, key: string): Error {
  const message = scrubSecrets(messageOf(error), [key]);

  if (error instanceof JevHttpError) {
    return new JevHttpError(error.status, message, error.retryAfterMs);
  }
  if (error instanceof JevError) {
    const rebuilt = new JevRequestError(message);
    rebuilt.name = error.name;
    return rebuilt;
  }
  return new JevRequestError(message);
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
