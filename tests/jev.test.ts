import { describe, expect, test } from "bun:test";

import {
  ENDPOINT,
  INPUT_TOKEN_PRICE_USD,
  JevHttpError,
  JevMissingKeyError,
  JevRequestError,
  JevStateRefusedError,
  MODEL,
  NO_JUDGMENT_HIGH,
  NO_JUDGMENT_LOW,
  STATE_GUARD_CHARS,
  createJevClient,
  estimatedCostUsd,
  isNoJudgment,
  questionsFromRules,
  retryAfterMs,
} from "../src/jev.ts";
import { HIDDEN } from "../src/scrub.ts";
import type { JudgmentRule } from "../src/types.ts";

// Shaped like a credential, and deliberately not one.
const fakeKey = "ts_live_0123456789abcdefghijklmnopqrstuvwxyz";

const questions = {
  restating_closer: {
    type: "noul" as const,
    instructions: { what: "The last sentence only restates the paragraph." },
    criteria: { true: "It restates.", false: "It does not." },
  },
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch that answers from a script of responses and records what it was asked. */
function stubFetch(script: ReadonlyArray<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let at = 0;

  const doFetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = script[at];
    at++;
    if (next === undefined) throw new Error(`unscripted call ${at} to ${url}`);
    return await next();
  };

  return { doFetch, calls };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const answered = {
  model: "jev-1.13.0",
  answers: { restating_closer: { type: "noul", noul: 0.87 } },
  usage: { input_tokens: 412, output_tokens: 0 },
};

/** No real waiting in tests; the backoff is recorded instead of slept. */
function recordingSleep() {
  const waited: number[] = [];
  return { waited, sleep: async (ms: number): Promise<void> => void waited.push(ms) };
}

/** Ordinary prose of an exact length; a long run of one letter would read as a blob. */
function prose(chars: number): string {
  return "a draft sentence that goes on. ".repeat(Math.ceil(chars / 31)).slice(0, chars);
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function headerOf(call: Call, name: string): string {
  const headers = call.init.headers as Record<string, string>;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1] ?? "";
}

describe("createJevClient request shape", () => {
  test("posts the exact body and the bearer header to the endpoint", async () => {
    const stub = stubFetch([() => ok(answered)]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    await client.ask({ state: "A paragraph.", questions });

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toBe(ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(bodyOf(call)).toEqual({ model: MODEL, state: "A paragraph.", questions });
    expect(headerOf(call, "authorization")).toBe(`Bearer ${fakeKey}`);
    expect(headerOf(call, "content-type")).toBe("application/json");
  });

  test("sends nothing but the model, the state and the questions", async () => {
    const stub = stubFetch([() => ok(answered)]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    await client.ask({ state: "A paragraph.", questions });

    expect(Object.keys(bodyOf(stub.calls[0]!)).sort()).toEqual(["model", "questions", "state"]);
  });

  test("reads the key from the environment when none is passed", async () => {
    const stub = stubFetch([() => ok(answered)]);
    const previous = process.env["TYPESAFE_API_KEY"];
    process.env["TYPESAFE_API_KEY"] = fakeKey;

    try {
      const client = createJevClient({ fetch: stub.doFetch });
      await client.ask({ state: "A paragraph.", questions });
      expect(headerOf(stub.calls[0]!, "authorization")).toBe(`Bearer ${fakeKey}`);
    } finally {
      if (previous === undefined) delete process.env["TYPESAFE_API_KEY"];
      else process.env["TYPESAFE_API_KEY"] = previous;
    }
  });

  test("a missing key is a typed error and no call is made", async () => {
    const stub = stubFetch([]);
    const previous = process.env["TYPESAFE_API_KEY"];
    delete process.env["TYPESAFE_API_KEY"];

    try {
      const client = createJevClient({ fetch: stub.doFetch });
      const thrown = await client.ask({ state: "A paragraph.", questions }).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(JevMissingKeyError);
      expect((thrown as Error).message).toContain("TYPESAFE_API_KEY");
      expect(stub.calls).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env["TYPESAFE_API_KEY"] = previous;
    }
  });
});

describe("createJevClient response parsing", () => {
  test("returns the served model, the nouls, the tokens and the estimated cost", async () => {
    const stub = stubFetch([() => ok(answered)]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    const result = await client.ask({ state: "A paragraph.", questions });

    expect(result.model).toBe("jev-1.13.0");
    expect(result.nouls).toEqual({ restating_closer: 0.87 });
    expect(result.inputTokens).toBe(412);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCostUsd).toBeCloseTo(412 * INPUT_TOKEN_PRICE_USD, 12);
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("keeps a noul of zero and drops an answer that carries no number", async () => {
    const stub = stubFetch([
      () =>
        ok({
          model: "jev-1.13.0",
          answers: {
            a: { type: "noul", noul: 0 },
            b: { type: "noul" },
            c: { type: "noul", noul: "0.9" },
          },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
    ]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    const result = await client.ask({ state: "A paragraph.", questions });
    expect(result.nouls).toEqual({ a: 0 });
  });

  test("a noul outside 0 to 1 is no answer at all", async () => {
    const stub = stubFetch([
      () =>
        ok({
          model: "jev-1.13.0",
          answers: {
            a: { type: "noul", noul: 7 },
            b: { type: "noul", noul: -0.2 },
            c: { type: "noul", noul: 1 },
          },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
    ]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    const result = await client.ask({ state: "A paragraph.", questions });
    expect(result.nouls).toEqual({ c: 1 });
  });

  test("a response with no answers object is a torn response, not a silent empty result", async () => {
    const stub = stubFetch([() => ok({ model: "jev-1.13.0" })]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch, attempts: 1 });

    const thrown = await client.ask({ state: "A paragraph.", questions }).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(JevRequestError);
    expect((thrown as Error).message).toContain("answers");
  });

  test("missing usage counts as zero tokens and zero cost, never a guess", async () => {
    const stub = stubFetch([
      () => ok({ model: "jev-1.13.0", answers: { a: { type: "noul", noul: 0.5 } } }),
    ]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    const result = await client.ask({ state: "A paragraph.", questions });
    expect(result.inputTokens).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
  });
});

describe("createJevClient retries", () => {
  test("429 then 200 succeeds after one backoff", async () => {
    const stub = stubFetch([
      () => new Response("slow down", { status: 429 }),
      () => ok(answered),
    ]);
    const clock = recordingSleep();
    const client = createJevClient({
      apiKey: fakeKey,
      fetch: stub.doFetch,
      sleep: clock.sleep,
    });

    const result = await client.ask({ state: "A paragraph.", questions });

    expect(result.nouls["restating_closer"]).toBe(0.87);
    expect(stub.calls).toHaveLength(2);
    expect(clock.waited).toEqual([1000]);
    expect(result.attempts).toBe(2);
  });

  test("retries a 503 and gives up after the attempt budget", async () => {
    const stub = stubFetch([
      () => new Response("down", { status: 503 }),
      () => new Response("down", { status: 503 }),
      () => new Response("down", { status: 503 }),
    ]);
    const clock = recordingSleep();
    const client = createJevClient({
      apiKey: fakeKey,
      fetch: stub.doFetch,
      sleep: clock.sleep,
      attempts: 3,
    });

    const thrown = await client.ask({ state: "A paragraph.", questions }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(JevHttpError);
    expect((thrown as JevHttpError).status).toBe(503);
    expect(stub.calls).toHaveLength(3);
    expect(clock.waited).toEqual([1000, 2000]);
  });

  test("a Retry-After in seconds is waited instead of the ladder's guess", async () => {
    const stub = stubFetch([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      () => ok(answered),
    ]);
    const clock = recordingSleep();
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch, sleep: clock.sleep });

    const result = await client.ask({ state: "A paragraph.", questions });

    // Two seconds because the service said two, not one because the ladder
    // starts there.
    expect(clock.waited).toEqual([2000]);
    expect(result.attempts).toBe(2);
  });

  test("a Retry-After longer than the cap is capped, and a nonsense one is ignored", async () => {
    const hour = stubFetch([
      () => new Response("later", { status: 503, headers: { "retry-after": "3600" } }),
      () => ok(answered),
    ]);
    const capped = recordingSleep();
    await createJevClient({ apiKey: fakeKey, fetch: hour.doFetch, sleep: capped.sleep }).ask({
      state: "A paragraph.",
      questions,
    });
    expect(capped.waited).toEqual([8000]);

    const nonsense = stubFetch([
      () => new Response("later", { status: 503, headers: { "retry-after": "whenever" } }),
      () => ok(answered),
    ]);
    const ladder = recordingSleep();
    await createJevClient({ apiKey: fakeKey, fetch: nonsense.doFetch, sleep: ladder.sleep }).ask({
      state: "A paragraph.",
      questions,
    });
    expect(ladder.waited).toEqual([1000]);
  });

  test("a Retry-After given as a date is read as the wait it describes", () => {
    const now = Date.parse("2026-09-17T10:00:00Z");
    expect(retryAfterMs("Thu, 17 Sep 2026 10:00:03 GMT", now)).toBe(3000);
    // A date already past is a wait of nothing, not a negative one.
    expect(retryAfterMs("Thu, 17 Sep 2026 09:59:00 GMT", now)).toBe(0);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs("   ", now)).toBeUndefined();
  });

  test("a network failure is retried and the last one is reported", async () => {
    const stub = stubFetch([
      () => {
        throw new TypeError("connection reset");
      },
      () => ok(answered),
    ]);
    const clock = recordingSleep();
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch, sleep: clock.sleep });

    const result = await client.ask({ state: "A paragraph.", questions });
    expect(result.attempts).toBe(2);
  });
});

describe("createJevClient errors never carry the key", () => {
  test("401 throws once, with no retry, and the echoed key is hidden", async () => {
    const stub = stubFetch([
      (): Response =>
        new Response(JSON.stringify({ error: "bad credentials", sent: `Bearer ${fakeKey}` }), {
          status: 401,
        }),
    ]);
    const clock = recordingSleep();
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch, sleep: clock.sleep });

    const thrown = await client.ask({ state: "A paragraph.", questions }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(JevHttpError);
    expect(stub.calls).toHaveLength(1);
    expect(clock.waited).toEqual([]);
    const message = (thrown as Error).message;
    expect(message).toContain("401");
    expect(message).toContain(HIDDEN);
    expect(message).not.toContain(fakeKey);
  });

  test("no sixteen-character prefix of the key survives in a 401 message", async () => {
    const stub = stubFetch([
      (): Response => new Response(`rejected ${fakeKey.slice(0, 20)}`, { status: 401 }),
    ]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    const thrown = await client.ask({ state: "A paragraph.", questions }).catch((e: unknown) => e);
    const message = (thrown as Error).message;

    for (let end = fakeKey.length; end >= 16; end--) {
      expect(message).not.toContain(fakeKey.slice(0, end));
    }
  });

  test("the failure body is capped so a long echo cannot fill a log", async () => {
    const stub = stubFetch([
      (): Response => new Response("x".repeat(4000), { status: 400 }),
    ]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    const thrown = await client.ask({ state: "A paragraph.", questions }).catch((e: unknown) => e);
    expect((thrown as Error).message.length).toBeLessThan(300);
  });

  test("a network error message is scrubbed too", async () => {
    const stub = stubFetch([
      () => {
        throw new Error(`socket closed while sending ${fakeKey}`);
      },
    ]);
    const client = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch, attempts: 1 });

    const thrown = await client.ask({ state: "A paragraph.", questions }).catch((e: unknown) => e);
    expect((thrown as Error).message).not.toContain(fakeKey);
    expect((thrown as Error).message).toContain(HIDDEN);
  });
});

describe("createJevClient timeout", () => {
  test("aborts at the deadline and reports it", async () => {
    let aborted = false;

    const doFetch = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    const client = createJevClient({
      apiKey: fakeKey,
      fetch: doFetch,
      timeoutMs: 20,
      attempts: 1,
    });

    const thrown = await client.ask({ state: "A paragraph.", questions }).catch((e: unknown) => e);

    expect(aborted).toBe(true);
    expect(thrown).toBeInstanceOf(JevRequestError);
    expect((thrown as Error).message).toContain("20");
    expect((thrown as Error).message).toContain("timed out");
  });
});

describe("the state guard is local and never asks the service", () => {
  const client = (): ReturnType<typeof createJevClient> =>
    createJevClient({
      apiKey: fakeKey,
      fetch: () => {
        throw new Error("the guard let a request through");
      },
    });

  async function refusal(state: unknown): Promise<JevStateRefusedError> {
    const thrown = await client()
      .ask({ state, questions })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(JevStateRefusedError);
    return thrown as JevStateRefusedError;
  }

  test("refuses state that is not text, naming the reason", async () => {
    const error = await refusal({ image: "a picture" });
    expect(error.message).toContain("text");
    expect(error.message).toContain("0.5");
  });

  test("refuses an empty state", async () => {
    await refusal("   \n  ");
  });

  test("refuses a state longer than the guard, naming both numbers", async () => {
    const error = await refusal(prose(STATE_GUARD_CHARS + 1));
    expect(error.message).toContain(String(STATE_GUARD_CHARS));
    expect(error.message).toContain(String(STATE_GUARD_CHARS + 1));
  });

  test("accepts a state exactly at the guard", async () => {
    const stub = stubFetch([() => ok(answered)]);
    const sized = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    await sized.ask({ state: prose(STATE_GUARD_CHARS), questions });
    expect(stub.calls).toHaveLength(1);
  });

  test("refuses a data URI, because an image comes back as a coin flip", async () => {
    const error = await refusal("Look: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== and more");
    expect(error.message).toContain("0.5");
  });

  test("refuses a base64 block over 256 characters", async () => {
    await refusal(`An attachment follows. ${"QUJDRA".repeat(50)} and the draft continues.`);
  });

  test("lets ordinary prose with a long word through", async () => {
    const stub = stubFetch([() => ok(answered)]);
    const sized = createJevClient({ apiKey: fakeKey, fetch: stub.doFetch });

    await sized.ask({
      state: "Antidisestablishmentarianism is a long word, and a draft may say it twice.",
      questions,
    });
    expect(stub.calls).toHaveLength(1);
  });
});

describe("the no-judgment band", () => {
  test("the middle of the range is no judgment and the ends of it are", () => {
    expect(isNoJudgment(0.5)).toBe(true);
    expect(isNoJudgment(NO_JUDGMENT_LOW)).toBe(true);
    expect(isNoJudgment(NO_JUDGMENT_HIGH)).toBe(true);
    expect(isNoJudgment(0.39)).toBe(false);
    expect(isNoJudgment(0.61)).toBe(false);
    expect(isNoJudgment(0)).toBe(false);
    expect(isNoJudgment(1)).toBe(false);
  });
});

describe("questionsFromRules", () => {
  const rule: JudgmentRule = {
    id: "naked_cost_figure",
    kind: "judgment",
    what: "A cost to produce with no customer price beside it.",
    not_for: "A cost quoted with the price and a comparison.",
    examples: ["This report cost us a dollar in API calls."],
    criteria: { true: "A cost stands alone.", false: "Every cost carries its price." },
    message: "A cost with no price next to it.",
  };

  test("maps a judgment rule onto one noul question, keyed by rule id", () => {
    expect(questionsFromRules([rule])).toEqual({
      naked_cost_figure: {
        type: "noul",
        instructions: {
          what: rule.what,
          not_for: rule.not_for,
          examples: rule.examples,
        },
        criteria: { true: "A cost stands alone.", false: "Every cost carries its price." },
      },
    });
  });

  test("leaves out the optional parts a rule does not carry", () => {
    const bare: JudgmentRule = {
      id: "tricolon",
      kind: "judgment",
      what: "A decorative rule of three.",
      criteria: { true: "Three in a row.", false: "Not three." },
      message: "Three beats in a row.",
    };

    const built = questionsFromRules([bare])["tricolon"]!;
    expect(Object.keys(built.instructions)).toEqual(["what"]);
  });

  test("criteria stay a dictionary, because a list is refused with a 422", () => {
    const built = questionsFromRules([rule])["naked_cost_figure"]!;
    expect(Array.isArray(built.criteria)).toBe(false);
    expect(typeof built.criteria).toBe("object");
  });
});

describe("estimatedCostUsd", () => {
  test("prices input tokens only, because output is free", () => {
    expect(estimatedCostUsd(1_000_000)).toBeCloseTo(0.042, 12);
    expect(estimatedCostUsd(0)).toBe(0);
  });
});
