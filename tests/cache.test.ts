import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CACHE_DIR_ENV, MAX_AGE_DAYS, cacheDirectory, cacheKey, openCache } from "../src/cache.ts";

const temporary: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-cache-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Every file under a directory, read as text. */
function everything(root: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return out;
}

const QUESTIONS = { restating_closer: { what: "The closer only restates." } };

describe("where the cache lives", () => {
  test("a named directory wins, then XDG, then the home directory", () => {
    const named = sandbox();
    expect(cacheDirectory({ env: { [CACHE_DIR_ENV]: named }, homedir: "/home/nobody" })).toBe(named);
    expect(cacheDirectory({ env: { XDG_CACHE_HOME: "/x" }, homedir: "/home/nobody" })).toBe(
      join("/x", "snifftest"),
    );
    expect(cacheDirectory({ env: {}, homedir: "/home/nobody" })).toBe(
      join("/home/nobody", ".cache", "snifftest"),
    );
  });

  test("the word off means no cache at all, rather than a cache somewhere odd", () => {
    expect(openCache({ env: { [CACHE_DIR_ENV]: "off" } })).toBeUndefined();
    expect(openCache({ env: { [CACHE_DIR_ENV]: " OFF " } })).toBeUndefined();
  });
});

describe("what the cache holds", () => {
  test("the paragraph is never written down, only its numbers", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const paragraph = "A sentence about a rhubarb concern nobody else would write.";

    cache?.set(cacheKey(paragraph, QUESTIONS, "jev-latest"), {
      model: "jev-1.13.0",
      nouls: { restating_closer: 0.91 },
    });

    const files = everything(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("0.91");
    expect(files[0]).toContain("jev-1.13.0");
    expect(files[0]).not.toContain("rhubarb");
    expect(files[0]).not.toContain(paragraph);
  });

  test("the key changes with the paragraph, the questions and the model", () => {
    const base = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    expect(cacheKey("A paragraph!", QUESTIONS, "jev-latest")).not.toBe(base);
    expect(cacheKey("A paragraph.", { other: { what: "Something else." } }, "jev-latest")).not.toBe(
      base,
    );
    expect(cacheKey("A paragraph.", QUESTIONS, "jev-2")).not.toBe(base);
    // The same three things give the same key, which is the whole point.
    expect(cacheKey("A paragraph.", QUESTIONS, "jev-latest")).toBe(base);
  });

  test("an answer goes back in the same shape it came out", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");

    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91, other: 0 } });

    expect(cache?.get(key)).toEqual({
      model: "jev-1.13.0",
      nouls: { restating_closer: 0.91, other: 0 },
    });
    expect(cache?.hits).toBe(1);
  });
});

describe("what the cache refuses to hand back", () => {
  test("an answer older than the window is asked for again", () => {
    const dir = sandbox();
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    const day = 86_400_000;
    const written = openCache({ env: { [CACHE_DIR_ENV]: dir }, now: 0 });
    written?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } });

    const justInside = openCache({ env: { [CACHE_DIR_ENV]: dir }, now: MAX_AGE_DAYS * day });
    expect(justInside?.get(key)).toBeDefined();

    const tooOld = openCache({ env: { [CACHE_DIR_ENV]: dir }, now: MAX_AGE_DAYS * day + 1 });
    expect(tooOld?.get(key)).toBeUndefined();
  });

  test("a file somebody half wrote is a miss, not a crash", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } });

    const path = join(dir, "answers", key.slice(0, 2), `${key.slice(2)}.json`);
    writeFileSync(path, '{"v":1,"at":', "utf8");

    expect(cache?.get(key)).toBeUndefined();
  });

  test("a stored number that is not a probability makes the whole entry a miss", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } });

    const path = join(dir, "answers", key.slice(0, 2), `${key.slice(2)}.json`);
    const held = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({ ...held, nouls: { restating_closer: 0.91, other: 7 } }),
      "utf8",
    );

    expect(cache?.get(key)).toBeUndefined();
  });

  test("a key never written is simply a miss", () => {
    const cache = openCache({ env: { [CACHE_DIR_ENV]: sandbox() } });
    expect(cache?.get(cacheKey("Never asked.", QUESTIONS, "jev-latest"))).toBeUndefined();
    expect(cache?.hits).toBe(0);
  });

  test("a directory that cannot be written is a run that pays again, not a run that stops", () => {
    // A path under a file, which no directory can be made beneath.
    const dir = sandbox();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");

    const cache = openCache({ env: { [CACHE_DIR_ENV]: join(blocker, "cache") } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");

    expect(() => cache?.set(key, { model: "jev-1.13.0", nouls: {} })).not.toThrow();
    expect(cache?.get(key)).toBeUndefined();
  });
});
