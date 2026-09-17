import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type AnswerExpectation,
  CACHE_DIR_ENV,
  MAX_AGE_DAYS,
  cacheDirectory,
  cacheKey,
  openCache,
  wordingHash,
} from "../src/cache.ts";

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
const EXPECT: AnswerExpectation = {
  rules: ["restating_closer"],
  wording: wordingHash(QUESTIONS),
};

function entryPath(dir: string, key: string): string {
  return join(dir, "answers", key.slice(0, 2), `${key.slice(2)}.json`);
}

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

  test("a relative name is a place in the home directory, never in the repository", () => {
    // The working directory during a check is the tree being checked, so a
    // relative name resolved against it would drop the cache into somebody's
    // repository, which is the one place this file may never be.
    expect(cacheDirectory({ env: { [CACHE_DIR_ENV]: "cache" }, homedir: "/home/nobody" })).toBe(
      join("/home/nobody", "cache"),
    );
    expect(
      cacheDirectory({ env: { XDG_CACHE_HOME: ".cache-here" }, homedir: "/home/nobody" }),
    ).toBe(join("/home/nobody", ".cache-here", "snifftest"));
  });

  test("a relative name does not write into the working directory", () => {
    const home = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: "somewhere" }, homedir: home });
    cache?.set(cacheKey("A paragraph.", QUESTIONS, "jev-latest"), {
      model: "jev-1.13.0",
      nouls: { restating_closer: 0.91 },
    }, EXPECT);

    expect(everything(join(home, "somewhere"))).toHaveLength(1);
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
    }, EXPECT);

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

    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91, other: 0 } }, EXPECT);

    expect(cache?.get(key, EXPECT)).toEqual({
      model: "jev-1.13.0",
      nouls: { restating_closer: 0.91, other: 0 },
    });
    expect(cache?.hits).toBe(1);
  });

  test("the file is readable by its owner and nobody else", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    const path = entryPath(dir, key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  test("a symlink at the entry's path is replaced, not written through", () => {
    const dir = sandbox();
    const elsewhere = join(sandbox(), "precious.txt");
    writeFileSync(elsewhere, "not the cache's to touch", "utf8");

    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    const path = entryPath(dir, key);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(elsewhere, path);

    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    expect(readFileSync(elsewhere, "utf8")).toBe("not the cache's to touch");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("0.91");
  });

  test("no temporary file is left behind", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    const shard = dirname(entryPath(dir, key));
    expect(readdirSync(shard).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  test("the first write of a run takes away what has expired", () => {
    const dir = sandbox();
    const day = 86_400_000;
    const stale = cacheKey("An old paragraph.", QUESTIONS, "jev-latest");
    const written = openCache({ env: { [CACHE_DIR_ENV]: dir }, now: 0 });
    written?.set(stale, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    const stalePath = entryPath(dir, stale);
    const longAgo = new Date(0);
    utimesSync(stalePath, longAgo, longAgo);

    const later = openCache({
      env: { [CACHE_DIR_ENV]: dir },
      now: (MAX_AGE_DAYS + 1) * day,
    });
    later?.set(cacheKey("A new paragraph.", QUESTIONS, "jev-latest"), {
      model: "jev-1.13.0",
      nouls: { restating_closer: 0.91 },
    }, EXPECT);

    expect(everything(dir)).toHaveLength(1);
  });
});

describe("a non-answer is never written down", () => {
  const cases: ReadonlyArray<readonly [string, Record<string, number>]> = [
    ["an empty reply", {}],
    ["a reply that leaves a question out", { other: 0.9 }],
    ["a reply whose every answer sits in the no-judgment band", { restating_closer: 0.5 }],
  ];

  for (const [name, nouls] of cases) {
    test(`${name} leaves no file at all`, () => {
      const dir = sandbox();
      const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
      const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");

      cache?.set(key, { model: "jev-1.13.0", nouls }, EXPECT);

      expect(everything(dir)).toHaveLength(0);
      expect(cache?.get(key, EXPECT)).toBeUndefined();
    });
  }

  test("one opinion beside one undecided answer is still worth keeping", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    const both: AnswerExpectation = {
      rules: ["restating_closer", "stacked_hedging"],
      wording: wordingHash(QUESTIONS),
    };

    cache?.set(key, { model: "jev-1", nouls: { restating_closer: 0.5, stacked_hedging: 0.9 } }, both);

    expect(cache?.get(key, both)?.nouls).toEqual({ restating_closer: 0.5, stacked_hedging: 0.9 });
  });
});

describe("what the cache refuses to hand back", () => {
  test("an answer older than the window is asked for again", () => {
    const dir = sandbox();
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    const day = 86_400_000;
    const written = openCache({ env: { [CACHE_DIR_ENV]: dir }, now: 0 });
    written?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    const justInside = openCache({ env: { [CACHE_DIR_ENV]: dir }, now: MAX_AGE_DAYS * day });
    expect(justInside?.get(key, EXPECT)).toBeDefined();

    const tooOld = openCache({ env: { [CACHE_DIR_ENV]: dir }, now: MAX_AGE_DAYS * day + 1 });
    expect(tooOld?.get(key, EXPECT)).toBeUndefined();
  });

  test("an entry that does not cover every rule asked now is a miss", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    const more: AnswerExpectation = {
      rules: ["restating_closer", "rhetorical_opener"],
      wording: EXPECT.wording,
    };
    expect(cache?.get(key, more)).toBeUndefined();
    expect(cache?.get(key, EXPECT)).toBeDefined();
  });

  test("an entry that answered other words is a miss, whatever the rule is called", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    const reworded: AnswerExpectation = {
      rules: ["restating_closer"],
      wording: wordingHash({ restating_closer: { what: "The closer restates the opening." } }),
    };
    expect(cache?.get(key, reworded)).toBeUndefined();
  });

  test("once a run knows what served it, another version's answers are asked for again", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    // Nothing live has answered yet, so there is nothing to compare against.
    expect(cache?.get(key, EXPECT)).toBeDefined();

    cache?.noteServed("jev-1.14.0");
    expect(cache?.get(key, EXPECT)).toBeUndefined();

    cache?.noteServed("jev-1.13.0");
    expect(cache?.get(key, EXPECT)).toBeDefined();
  });

  test("a file somebody half wrote is a miss, not a crash", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    writeFileSync(entryPath(dir, key), '{"v":2,"at":', "utf8");

    expect(cache?.get(key, EXPECT)).toBeUndefined();
  });

  test("a stored number that is not a probability makes the whole entry a miss", () => {
    const dir = sandbox();
    const cache = openCache({ env: { [CACHE_DIR_ENV]: dir } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");
    cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.91 } }, EXPECT);

    const path = entryPath(dir, key);
    const held = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(
      path,
      JSON.stringify({ ...held, nouls: { restating_closer: 0.91, other: 7 } }),
      "utf8",
    );

    expect(cache?.get(key, EXPECT)).toBeUndefined();
  });

  test("a key never written is simply a miss", () => {
    const cache = openCache({ env: { [CACHE_DIR_ENV]: sandbox() } });
    expect(cache?.get(cacheKey("Never asked.", QUESTIONS, "jev-latest"), EXPECT)).toBeUndefined();
    expect(cache?.hits).toBe(0);
  });

  test("a directory that cannot be written is a run that pays again, not a run that stops", () => {
    // A path under a file, which no directory can be made beneath.
    const dir = sandbox();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");

    const cache = openCache({ env: { [CACHE_DIR_ENV]: join(blocker, "cache") } });
    const key = cacheKey("A paragraph.", QUESTIONS, "jev-latest");

    expect(() =>
      cache?.set(key, { model: "jev-1.13.0", nouls: { restating_closer: 0.9 } }, EXPECT),
    ).not.toThrow();
    expect(cache?.get(key, EXPECT)).toBeUndefined();
  });
});
