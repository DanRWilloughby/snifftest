/**
 * Nothing private ends up in a public repository.
 *
 * This repository is going to be public, and it was built beside work that is
 * not. The scan below reads every tracked file and looks for a list of strings
 * that must never appear here: internal product names, house rules, customer
 * names, internal hostnames.
 *
 * The list is not in this repository, and it never will be. A committed denylist
 * of internal names is itself a published list of internal names, which is the
 * exact thing it exists to prevent. It is supplied at run time:
 *
 *     SNIFFTEST_LEAK_DENYLIST=/path/to/list bun test tests/leakage.test.ts
 *
 * One term per line, blank lines and `#` comments ignored. Without the variable
 * the scan is reported as SKIPPED and says so out loud. It is never reported as
 * a pass, because "we did not look" and "we looked and it was clean" are not the
 * same sentence and only one of them is worth trusting.
 *
 * A hit prints the file, the line, and the denylist entry's position in the
 * list. It never prints the term and never the surrounding text. Naming it in a
 * test log would leak it into CI output, a terminal scrollback and whatever
 * reads them, and the person running the scan is holding the list anyway.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const denylistPath = process.env.SNIFFTEST_LEAK_DENYLIST;

/** One forbidden string and where it sat in the list, so a hit can be named without being quoted. */
export interface DenylistEntry {
  /** 1-based position in the supplied file, blanks and comments not counted. */
  index: number;
  pattern: RegExp;
}

/** A term found somewhere it should not be. The term itself is deliberately absent. */
export interface LeakHit {
  file: string;
  line: number;
  entry: number;
}

function escapeForRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse a newline-separated denylist.
 *
 * Matching is case-insensitive and stops at a word boundary on either side, so
 * `art` does not fire on "start" or "cartoon". The boundary is spelled as a
 * pair of lookarounds rather than `\b`, because a term is allowed to begin or
 * end with punctuation (a hostname, a hyphenated name) and `\b` is defined
 * against word characters, so it would put the boundary in the wrong place.
 */
export function parseDenylist(source: string): DenylistEntry[] {
  const entries: DenylistEntry[] = [];
  for (const raw of source.split("\n")) {
    const term = raw.trim();
    if (term === "" || term.startsWith("#")) continue;
    entries.push({
      index: entries.length + 1,
      pattern: new RegExp(`(?<![A-Za-z0-9])${escapeForRegex(term)}(?![A-Za-z0-9])`, "i"),
    });
  }
  return entries;
}

/** Read every file, line by line, and report where a denylisted term appears. */
export function scanFiles(
  root: string,
  files: string[],
  denylist: DenylistEntry[],
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const file of files) {
    let contents: string;
    try {
      contents = read(join(root, file));
    } catch {
      // Unreadable as text means binary, and a binary file is not prose. The
      // secret scanner in CI covers what this one cannot read.
      continue;
    }
    if (contents.includes(String.fromCharCode(0))) continue;
    contents.split("\n").forEach((text, index) => {
      for (const entry of denylist) {
        if (entry.pattern.test(text)) {
          hits.push({ file, line: index + 1, entry: entry.index });
        }
      }
    });
  }
  return hits;
}

/** A hit, said out loud without saying the thing. */
export function describeHit(hit: LeakHit): string {
  return `${hit.file}:${hit.line} matches denylist entry ${hit.entry}`;
}

async function trackedFiles(): Promise<string[]> {
  const listing = await Bun.$`git ls-files`.cwd(repoRoot).text();
  return listing.split("\n").filter((path) => path !== "");
}

describe("the scan itself", () => {
  // The behaviour of the scanner is tested against a denylist invented here, so
  // these tests run everywhere and depend on nothing private.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "snifftest-leak-"));
  mkdirSync(join(fixtureRoot, "docs"), { recursive: true });
  writeFileSync(join(fixtureRoot, "denylist.txt"), ["# a comment", "", "Marmalade", "acme-internal.example", "  Blue Whale  "].join("\n"));
  writeFileSync(join(fixtureRoot, "clean.md"), "A perfectly ordinary paragraph.\nIt mentions marmalades and whales.\n");
  writeFileSync(join(fixtureRoot, "docs", "dirty.md"), "Nothing here.\nThe Marmalade release notes.\nAlso acme-internal.example is ours.\n");
  writeFileSync(join(fixtureRoot, "case.md"), "we shipped MARMALADE last week\n");

  const denylist = parseDenylist(readFileSync(join(fixtureRoot, "denylist.txt"), "utf8"));

  test("comments, blanks and stray whitespace are not terms", () => {
    expect(denylist.map((entry) => entry.index)).toEqual([1, 2, 3]);
  });

  test("a clean file yields nothing", () => {
    expect(scanFiles(fixtureRoot, ["clean.md"], denylist)).toEqual([]);
  });

  test("a term inside a longer word is not a hit", () => {
    // "marmalades" and "whales" are in clean.md on purpose.
    const hits = scanFiles(fixtureRoot, ["clean.md"], denylist);
    expect(hits).toEqual([]);
  });

  test("matching ignores case", () => {
    expect(scanFiles(fixtureRoot, ["case.md"], denylist)).toEqual([{ file: "case.md", line: 1, entry: 1 }]);
  });

  test("a hit names the file and the line", () => {
    const hits = scanFiles(fixtureRoot, ["docs/dirty.md"], denylist);
    expect(hits).toEqual([
      { file: "docs/dirty.md", line: 2, entry: 1 },
      { file: "docs/dirty.md", line: 3, entry: 2 },
    ]);
  });

  test("a hit never carries the term or the sentence around it", () => {
    const [hit] = scanFiles(fixtureRoot, ["docs/dirty.md"], denylist);
    const said = describeHit(hit as LeakHit);
    expect(said).toBe("docs/dirty.md:2 matches denylist entry 1");
    expect(said.toLowerCase()).not.toContain("marmalade");
    expect(said).not.toContain("release notes");
  });

  test("a term with punctuation in it still matches on its own boundaries", () => {
    const hits = scanFiles(fixtureRoot, ["docs/dirty.md"], denylist).filter((hit) => hit.entry === 2);
    expect(hits).toHaveLength(1);
  });

  test("an unreadable file is skipped rather than failing the scan", () => {
    const hits = scanFiles(fixtureRoot, ["does-not-exist.md"], denylist);
    expect(hits).toEqual([]);
  });

  test("a term appearing twice on one line is reported once for that line", () => {
    writeFileSync(join(fixtureRoot, "twice.md"), "Marmalade and Marmalade.\n");
    expect(scanFiles(fixtureRoot, ["twice.md"], denylist)).toEqual([{ file: "twice.md", line: 1, entry: 1 }]);
  });

  test("the fixture tree is disposable", () => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

if (denylistPath === undefined) {
  console.warn(
    "\n  leakage: SKIPPED, no denylist.\n" +
      "  Every tracked file was left unread. Set SNIFFTEST_LEAK_DENYLIST to a file\n" +
      "  of forbidden strings, one per line, and run this again before the repository\n" +
      "  goes public. A skip is not a pass.\n",
  );
}

describe("the repository against the real denylist", () => {
  test.skipIf(denylistPath === undefined)("no tracked file carries a forbidden string", async () => {
    const source = readFileSync(denylistPath as string, "utf8");
    const denylist = parseDenylist(source);
    expect(denylist.length).toBeGreaterThan(0);

    const hits = scanFiles(repoRoot, await trackedFiles(), denylist);
    expect(hits.map(describeHit)).toEqual([]);
  });
});
