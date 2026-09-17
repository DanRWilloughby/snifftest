/**
 * What the published tarball is allowed to carry.
 *
 * `package.json`'s `files` decides what npm packs. This decides whether that
 * decision was made on purpose. The two are checked against each other here, in
 * one place, because the last time `files` was widened the gate that existed to
 * ask the question was simply left red, and a red gate asks nobody anything.
 *
 * Run it on `npm pack --dry-run --json` output:
 *
 *   npm pack --dry-run --json > pack.json
 *   node .github/scripts/tarball-allowlist.mjs pack.json
 *
 * A path that matches nothing below fails the build with its own name in the
 * message. Adding one means adding it here with a reason, which is the whole
 * point of the file.
 */

import { readFileSync } from "node:fs";

/**
 * Every path the tarball may hold, each with the reason it is there.
 *
 * An entry ending in `/` is a directory prefix; anything else is an exact path.
 */
const ALLOWED = [
  { path: "package.json", why: "npm packs it whatever anybody says." },
  { path: "README.md", why: "The npm page." },
  { path: "LICENSE", why: "The licence." },
  { path: "SECURITY.md", why: "How to report something, for a reader who installed rather than cloned." },
  { path: "dist/", why: "The built bin, which is what `bin` points at." },
  { path: "rules/", why: "The default ruleset, read at run time when nobody names one." },
  { path: "bench/panel.yaml", why: "The panel `bench` falls back to outside a clone." },
  { path: "bench/panel-direct.yaml", why: "The same panel called on each provider's own API." },
  { path: "bench/prices/", why: "The dated prices `bench` costs a run with." },
  { path: "examples/CORPUS.md", why: "What the shipped corpus is and how it was written." },
  { path: "examples/corpus/", why: "The corpus `bench` seeds from outside a clone." },
  { path: "examples/seeds/", why: "The seed bank `eval` plants faults from." },
  { path: "examples/replays/", why: "What `serve --replay` reads, with no key and no network." },
];

/**
 * Things that must never ship, named rather than merely absent.
 *
 * The allowlist above already refuses everything it does not name. These are
 * repeated so the refusal is legible: a future entry that widened a prefix far
 * enough to swallow one of them fails here with a sentence instead of silently.
 */
const REFUSED = [
  { path: "tests/", why: "A test suite is not a runtime." },
  { path: "src/", why: "The tarball ships the build, not the sources." },
  { path: ".github/", why: "Workflows are this repository's business." },
  { path: "bench/results/", why: "A recorded run is a document, not a dependency." },
  { path: "docs/", why: "Drafts and notes belong in the repository." },
  {
    path: "examples/adversarial/",
    why: "Three files of prompt-injection payloads, which nobody wants installed into their node_modules where a scanner or an agent will meet them. `eval --twins` is a command for a clone.",
  },
  {
    path: "examples/structure/",
    why: "A corpus for exercising the checker against Markdown shapes, which is a clone's job and not an install's.",
  },
  { path: "implementation-notes.md", why: "Working notes, never committed and never shipped." },
];

const matches = (path, entry) =>
  entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path;

const packPath = process.argv[2];
if (packPath === undefined) {
  console.error("usage: tarball-allowlist.mjs <npm pack --dry-run --json output>");
  process.exit(2);
}

const [report] = JSON.parse(readFileSync(packPath, "utf8"));
const files = report.files.map((file) => file.path).sort();
console.log(files.join("\n"));

const refused = files.filter((path) => REFUSED.some((entry) => matches(path, entry)));
const strays = files.filter((path) => !ALLOWED.some((entry) => matches(path, entry)));

let failed = false;
for (const path of refused) {
  const entry = REFUSED.find((candidate) => matches(path, candidate));
  console.error(`${path} must never ship: ${entry.why}`);
  failed = true;
}
for (const path of strays) {
  if (refused.includes(path)) continue;
  console.error(
    `${path} is in the tarball and not in the allowlist. Add it to .github/scripts/tarball-allowlist.mjs with the reason it belongs, or take it out of package.json "files".`,
  );
  failed = true;
}

if (failed) process.exit(1);
console.log(`${files.length} files, every one of them named in the allowlist.`);
