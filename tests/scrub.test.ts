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

  test("returns the text unchanged when no secret is present", () => {
    expect(scrubSecrets("nothing to see", [fakeKey])).toBe("nothing to see");
  });

  test("handles several secrets in one pass", () => {
    const other = "sk-fake-9876543210zyxwvutsrqponm";
    const out = scrubSecrets(`${fakeKey} then ${other}`, [fakeKey, other]);
    expect(out).toBe(`${HIDDEN} then ${HIDDEN}`);
  });
});
