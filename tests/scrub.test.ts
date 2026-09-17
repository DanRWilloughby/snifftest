import { describe, expect, test } from "bun:test";

import { HIDDEN, scrubSecrets } from "../src/scrub.ts";

// A shape that looks like a key and is not one. Nothing here is a real value.
const fakeKey = "ts_live_0123456789abcdefghijklmnopqrstuvwxyz";

describe("scrubSecrets", () => {
  test("removes a whole secret wherever it appears", () => {
    const text = `denied for ${fakeKey} and again ${fakeKey}`;
    const out = scrubSecrets(text, [fakeKey]);

    expect(out).toBe(`denied for ${HIDDEN} and again ${HIDDEN}`);
    expect(out).not.toContain(fakeKey);
  });

  test("removes a truncated secret, because half a credential is still a credential", () => {
    const half = fakeKey.slice(0, 24);
    const out = scrubSecrets(`HTTP 401: {"sent":"${half}"}`, [fakeKey]);

    expect(out).toContain(HIDDEN);
    expect(out).not.toContain(half);
  });

  test("leaves a fragment shorter than the sixteen-character floor alone", () => {
    const out = scrubSecrets("the word testament appears", ["testament_and_more_here"]);
    expect(out).toBe("the word testament appears");
  });

  test("ignores a secret too short to be one, so ordinary prose survives", () => {
    expect(scrubSecrets("a test of the test", ["test"])).toBe("a test of the test");
  });

  test("replaces at the longest surviving length, leaving no tail behind", () => {
    const out = scrubSecrets(`prefix ${fakeKey} suffix`, [fakeKey]);
    expect(out).toBe(`prefix ${HIDDEN} suffix`);
    expect(out.split(HIDDEN)).toHaveLength(2);
  });

  test("removes a whole copy and a truncated copy in the same message", () => {
    // The shape a failure body actually arrives in: the service quotes the
    // request once in full and once cut off by its own logging cap. Stopping at
    // the first length that matched used to leave the shorter copy behind.
    const half = fakeKey.slice(0, 24);
    const out = scrubSecrets(`sent: ${fakeKey} ... also seen: ${half}"}`, [fakeKey]);

    expect(out).not.toContain(half);
    expect(out).toBe(`sent: ${HIDDEN} ... also seen: ${HIDDEN}"}`);
  });

  test("removes three copies at three different truncations", () => {
    const text = [fakeKey, fakeKey.slice(0, 30), fakeKey.slice(0, 18)].join(" | ");
    const out = scrubSecrets(text, [fakeKey]);

    expect(out).toBe([HIDDEN, HIDDEN, HIDDEN].join(" | "));
  });

  test("removes the tail of a secret, which is the shape a service logs", () => {
    // Some services record the last characters of a credential rather than the
    // first. A scrubber that only knew about prefixes handed that straight
    // through, and the tail of a key is as much a key as the head of one.
    const tail = fakeKey.slice(-20);
    const out = scrubSecrets(`rejected the key ending ${tail}`, [fakeKey]);

    expect(out).not.toContain(tail);
    expect(out).toBe(`rejected the key ending ${HIDDEN}`);
  });

  test("removes a head copy and a tail copy in the same message", () => {
    const head = fakeKey.slice(0, 22);
    const tail = fakeKey.slice(-22);
    const out = scrubSecrets(`sent ${head} ... ends ${tail}`, [fakeKey]);

    expect(out).not.toContain(head);
    expect(out).not.toContain(tail);
  });

  test("leaves a tail shorter than the floor alone, so prose survives", () => {
    // Below the floor a fragment is short enough to be an ordinary word, and
    // blanking real words makes a failure message useless without making
    // anybody safer.
    const short = fakeKey.slice(-6);
    expect(scrubSecrets(`ends ${short}`, [fakeKey])).toBe(`ends ${short}`);
  });

  test("returns the text unchanged when no secret is present", () => {
    expect(scrubSecrets("nothing to see", [fakeKey])).toBe("nothing to see");
  });

  test("handles several secrets in one pass", () => {
    const other = "sk-fake-9876543210zyxwvutsrqponm";
    const out = scrubSecrets(`${fakeKey} then ${other}`, [fakeKey, other]);
    expect(out).toBe(`${HIDDEN} then ${HIDDEN}`);
  });
});
