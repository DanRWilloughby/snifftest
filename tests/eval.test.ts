import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { EXIT, runCli } from "../src/cli.ts";
import { type BaseDocument, SeedError, applyKeyedEdit, seedCorpus } from "../src/eval/seed.ts";
import { buildReport, renderMarkdown } from "../src/eval/report.ts";
import { runEval } from "../src/eval/run.ts";
import { type ArmObservation, THRESHOLDS, scoreArm } from "../src/eval/score.ts";
import type { JevClient, JevRequest, JevResult } from "../src/jev.ts";
import { parseRuleset } from "../src/rules.ts";
import { checkRegexRule } from "../src/rules.ts";
import { type Ruleset, isRegexRule } from "../src/types.ts";

const repoRoot = resolve(import.meta.dir, "..");
const CORPUS = "tests/fixtures/eval/corpus";

const temporary: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-eval-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// --- the bases the seeder works on ---------------------------------------

const DRAWER =
  "The first draft went out on a Tuesday, which is the day the office is quietest. " +
  "Nobody read it. A week later the same draft came back with three comments, two of " +
  "them about the title. That is the whole history of the document, as far as anyone " +
  "can tell from the record. We keep it in the drawer with the others.";

const COUNTER =
  "The counter in the hallway has been wrong since the day it was installed, and " +
  "nobody minds. It reads high by four. Visitors who notice are told the story, which " +
  "takes about a minute and is the best part of the tour. The number itself has never " +
  "been used for anything.";

function base(id: string, text: string): BaseDocument {
  return { id, file: `${id}.md`, line: 1, text };
}

const BASES: readonly BaseDocument[] = [base("C00", DRAWER), base("C01", COUNTER)];

function ruleset(body: string): Ruleset {
  return parseRuleset(`version: 1\nthreshold: 0.7\nrules:\n${body}`, "test.yaml");
}

/** Does the named countable rule fire on this text? */
function fires(set: Ruleset, id: string, text: string): boolean {
  const rule = set.rules.find((candidate) => candidate.id === id);
  if (rule === undefined || !isRegexRule(rule)) throw new Error(`no countable rule "${id}"`);
  return checkRegexRule(rule, text).length > 0;
}

const DASH_RULE = `
  - id: dash_present
    kind: regex
    builtin: dash_present
    message: "A long dash."
    seed: { transform: insert_em_dash, count: 1 }`;

const COLON_RULE = `
  - id: colon_heavy
    kind: regex
    builtin: colon_count
    min: 3
    message: "Three colons."
    seed: { transform: add_colons, count: 3 }`;

const RHYTHM_RULE = `
  - id: sentence_rhythm
    kind: regex
    builtin: sentence_rhythm
    floor: 0.25
    min_sentences: 4
    message: "Every sentence the same length."
    seed: { transform: equalize_sentences }`;

const SLOP_RULE = `
  - id: slop_vocab
    kind: regex
    builtin: slop_vocab
    words: [tapestry, delve]
    message: "A word only a model reaches for."
    seed: { transform: insert_slop_word, count: 1 }`;

function judgmentRule(id: string, position: string): string {
  return `
  - id: ${id}
    kind: judgment
    what: "A ${id} defect."
    not_for: "Anything else."
    examples: ["An example of ${id}."]
    criteria:
      true: "It is there."
      false: "It is not."
    message: "${id} found."
    seed:
      splice: ["A spliced sentence for ${id}."]
      position: ${position}`;
}

// --- seeding --------------------------------------------------------------

describe("seeding, one defect per rule", () => {
  test("insert_em_dash plants a dash the countable arm then catches", () => {
    const set = ruleset(DASH_RULE);
    const result = seedCorpus(BASES, set, { perRule: 1 });

    expect(result.seeded).toHaveLength(1);
    const seeded = result.seeded[0];
    expect(seeded?.rule).toBe("dash_present");
    expect(seeded?.transform).toBe("insert_em_dash");
    expect(fires(set, "dash_present", seeded?.text ?? "")).toBe(true);
    expect(fires(set, "dash_present", DRAWER)).toBe(false);
  });

  test("add_colons plants enough colons to clear the rule's own minimum", () => {
    const set = ruleset(COLON_RULE);
    const seeded = seedCorpus(BASES, set, { perRule: 1 }).seeded[0];

    const colons = [...(seeded?.text ?? "")].filter((ch) => ch === ":").length;
    expect(colons).toBeGreaterThanOrEqual(3);
    expect(fires(set, "colon_heavy", seeded?.text ?? "")).toBe(true);
  });

  test("equalize_sentences flattens the rhythm and records a rewrite", () => {
    const set = ruleset(RHYTHM_RULE);
    const seeded = seedCorpus(BASES, set, { perRule: 1 }).seeded[0];

    expect(seeded?.edit.kind).toBe("rewrite");
    expect(fires(set, "sentence_rhythm", seeded?.text ?? "")).toBe(true);
    expect(fires(set, "sentence_rhythm", DRAWER)).toBe(false);
  });

  test("insert_slop_word plants a word from the rule's own list", () => {
    const set = ruleset(SLOP_RULE);
    const seeded = seedCorpus(BASES, set, { perRule: 1 }).seeded[0];

    expect(fires(set, "slop_vocab", seeded?.text ?? "")).toBe(true);
    expect(/tapestry|delve/i.test(seeded?.text ?? "")).toBe(true);
  });

  test("insert_banned_word fires only when the list has words in it", () => {
    const empty = ruleset(`
  - id: banned_words
    kind: regex
    builtin: banned_words
    words: []
    message: "A banned word."
    seed: { transform: insert_banned_word, count: 1 }`);
    const filled = ruleset(`
  - id: banned_words
    kind: regex
    builtin: banned_words
    words: [synergy]
    message: "A banned word."
    seed: { transform: insert_banned_word, count: 1 }`);

    const skipped = seedCorpus(BASES, empty, { perRule: 1 });
    expect(skipped.seeded).toHaveLength(0);
    expect(skipped.skipped[0]?.rule).toBe("banned_words");
    expect(skipped.skipped[0]?.reason).toContain("no words");

    const planted = seedCorpus(BASES, filled, { perRule: 1 }).seeded[0];
    expect(planted?.text).toContain("synergy");
  });

  test("a splice lands first, last, or inside, per the seed's position", () => {
    const set = ruleset(
      [judgmentRule("opener", "start"), judgmentRule("closer", "end"), judgmentRule("middle", "any")].join(
        "",
      ),
    );
    const result = seedCorpus(BASES, set, { perRule: 1, seed: 3 });
    const byRule = new Map(result.seeded.map((doc) => [doc.rule, doc]));

    expect(byRule.get("opener")?.text.startsWith("A spliced sentence for opener.")).toBe(true);
    expect(byRule.get("closer")?.text.trimEnd().endsWith("A spliced sentence for closer.")).toBe(true);

    const middle = byRule.get("middle")?.text ?? "";
    expect(middle).toContain("A spliced sentence for middle.");
    expect(middle.startsWith("A spliced sentence for middle.")).toBe(false);
    expect(middle.trimEnd().endsWith("A spliced sentence for middle.")).toBe(false);
  });

  test("every seeded paragraph records the rule and the transform that made it", () => {
    const set = ruleset([DASH_RULE, COLON_RULE, judgmentRule("closer", "end")].join(""));
    const result = seedCorpus(BASES, set, { perRule: 1 });

    for (const doc of result.seeded) {
      expect(doc.rule).not.toBe("");
      expect(doc.transform).not.toBe("");
      expect(doc.base_id).not.toBe("");
      expect(doc.edit).toBeDefined();
    }
    expect(result.seeded.map((doc) => doc.transform).sort()).toEqual([
      "add_colons",
      "insert_em_dash",
      "splice",
    ]);
  });

  test("the same seed value reproduces the corpus exactly", () => {
    const set = ruleset([DASH_RULE, judgmentRule("closer", "any")].join(""));
    const first = seedCorpus(BASES, set, { perRule: 1, seed: 11 });
    const again = seedCorpus(BASES, set, { perRule: 1, seed: 11 });

    expect(again).toEqual(first);
    expect(first.seedValue).toBe(11);
  });

  test("a different seed value draws a different set of bases", () => {
    // Two bases would make this a coin flip; a pool large enough to shuffle is
    // what actually shows the seed value steering the draw.
    const set = ruleset(judgmentRule("closer", "any"));
    const pool = Array.from({ length: 8 }, (_, index) =>
      base(`C${String(index).padStart(2, "0")}`, index % 2 === 0 ? DRAWER : COUNTER),
    );
    const one = seedCorpus(pool, set, { perRule: 3, seed: 1 });
    const two = seedCorpus(pool, set, { perRule: 3, seed: 2 });

    expect(one.seeded).toHaveLength(3);
    expect(one.seeded.map((doc) => doc.base_id)).not.toEqual(two.seeded.map((doc) => doc.base_id));
  });

  test("a base that already trips a countable rule is dropped, with its reason", () => {
    const set = ruleset([DASH_RULE, judgmentRule("closer", "end")].join(""));
    const dirty = base("C99", "Not clean at all \u2014 there is a dash right there in it.");
    const result = seedCorpus([...BASES, dirty], set, { perRule: 1 });

    expect(result.clean.map((doc) => doc.id)).toEqual(["C00", "C01"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.id).toBe("C99");
    expect(result.dropped[0]?.reason).toContain("dash_present");
  });

  test("no seeded paragraph trips a second countable rule", () => {
    const set = ruleset([DASH_RULE, COLON_RULE, SLOP_RULE, RHYTHM_RULE].join(""));
    const result = seedCorpus(BASES, set, { perRule: 1 });

    expect(result.seeded.length).toBeGreaterThan(0);
    for (const doc of result.seeded) {
      for (const rule of set.rules) {
        if (!isRegexRule(rule) || rule.id === doc.rule) continue;
        expect(fires(set, rule.id, doc.text), `${doc.id} also trips ${rule.id}`).toBe(false);
      }
    }
  });

  test("a rule asked for more seeds than there are clean bases says so", () => {
    const set = ruleset(DASH_RULE);
    const result = seedCorpus(BASES, set, { perRule: 5 });

    expect(result.seeded).toHaveLength(2);
    expect(result.skipped[0]?.reason).toContain("2 of 5");
  });

  test("a keyed edit whose find string is ambiguous aborts and names the rule", () => {
    expect(() => applyKeyedEdit("one and one", "one", "two", 'rule "twice"')).toThrow(SeedError);
    expect(() => applyKeyedEdit("one and one", "one", "two", 'rule "twice"')).toThrow(/twice/);
    expect(() => applyKeyedEdit("one", "missing", "two", 'rule "gone"')).toThrow(/matched 0/);
    expect(applyKeyedEdit("one and two", "two", "three", "rule")).toBe("one and three");
  });
});

// --- scoring --------------------------------------------------------------

/** A hand-built confusion set: two clean paragraphs, two seeded, two rules. */
function handBuilt(): ArmObservation {
  const cell = (doc: string, rule: string, probability: number) => ({
    doc,
    rule,
    probability,
    answered: true,
  });

  return {
    arm: "C",
    label: "regex plus judgment",
    network: true,
    documents: [
      { id: "C1", kind: "clean", text: "clean one", latencyMs: 100, inputTokens: 10, outputTokens: 0, costUsd: 0.001, requests: 1, retries: 0, unanswered: 0 },
      { id: "C2", kind: "clean", text: "clean two", latencyMs: 300, inputTokens: 10, outputTokens: 0, costUsd: 0.001, requests: 1, retries: 0, unanswered: 0 },
      { id: "S1", kind: "seeded", truth: "r1", text: "seeded one", latencyMs: 200, inputTokens: 10, outputTokens: 0, costUsd: 0.001, requests: 1, retries: 0, unanswered: 0 },
      { id: "S2", kind: "seeded", truth: "r2", text: "seeded two", latencyMs: 400, inputTokens: 10, outputTokens: 0, costUsd: 0.001, requests: 1, retries: 1, unanswered: 0 },
    ],
    cells: [
      cell("C1", "r1", 0.1),
      cell("C1", "r2", 0.8),
      cell("C2", "r1", 0.05),
      cell("C2", "r2", 0.05),
      cell("S1", "r1", 0.95),
      cell("S1", "r2", 0.6),
      cell("S2", "r1", 0.2),
      cell("S2", "r2", 0.72),
    ],
  };
}

describe("scoring, against a hand-computed table", () => {
  const score = scoreArm(handBuilt(), ["r1", "r2"]);

  test("the thresholds swept are the spike's three", () => {
    expect([...THRESHOLDS]).toEqual([0.5, 0.7, 0.9]);
  });

  test("per rule recall and false positives per clean cell", () => {
    expect(score.per_rule["r1"]).toMatchObject({
      n_positive: 1,
      n_clean: 2,
      at: {
        "0.5": { recall: 1, hits: 1, fp_rate_clean: 0, fps: 0 },
        "0.9": { recall: 1, hits: 1, fp_rate_clean: 0, fps: 0 },
      },
    });
    expect(score.per_rule["r2"]).toMatchObject({
      n_positive: 1,
      n_clean: 2,
      at: {
        "0.5": { recall: 1, hits: 1, fp_rate_clean: 0.5, fps: 1 },
        "0.7": { recall: 1, hits: 1, fp_rate_clean: 0.5, fps: 1 },
        "0.9": { recall: 0, hits: 0, fp_rate_clean: 0, fps: 0 },
      },
    });
  });

  test("overall recall, false positives and off-rule flags at each threshold", () => {
    expect(score.overall["0.5"]).toMatchObject({
      recall: 1,
      fp_rate_per_clean_cell: 0.25,
      fp_clean_documents_with_any_flag: 0.5,
      off_rule_flags_on_seeded_cells: 0.5,
      fp_rate_per_negative_cell: 0.3333,
    });
    expect(score.overall["0.7"]).toMatchObject({
      recall: 1,
      fp_rate_per_clean_cell: 0.25,
      off_rule_flags_on_seeded_cells: 0,
    });
    expect(score.overall["0.9"]).toMatchObject({
      recall: 0.5,
      fp_rate_per_clean_cell: 0,
    });
  });

  test("an off-rule hit on a seeded paragraph is a false positive, never a catch", () => {
    // S1 is seeded for r1 and reads 0.60 on r2. At 0.5 that is one off-rule
    // flag and r1's recall is unchanged by it.
    expect(score.overall["0.5"]?.off_rule_flags).toBe(1);
    expect(score.per_rule["r2"]?.at["0.5"]?.hits).toBe(1);
    expect(score.false_positives_at_0_7.map((row) => `${row.doc}:${row.rule}`)).toEqual(["C1:r2"]);
    expect(score.misses_at_0_7).toHaveLength(0);
  });

  test("calibration buckets every cell by the probability that came back", () => {
    expect(score.calibration["0.9-1.0"]).toEqual({ n: 1, defective: 1, fraction_defective: 1 });
    expect(score.calibration["0.7-0.8"]).toEqual({ n: 1, defective: 1, fraction_defective: 1 });
    expect(score.calibration["0.0-0.1"]).toEqual({ n: 2, defective: 0, fraction_defective: 0 });
    const cells = Object.values(score.calibration).reduce((sum, bucket) => sum + bucket.n, 0);
    expect(cells).toBe(8);
  });

  test("latency and cost come from the recorded run, and per-100 is a projection of it", () => {
    expect(score.summary.median_latency_ms).toBe(250);
    expect(score.summary.usd_total).toBeCloseTo(0.004, 10);
    expect(score.summary.usd_per_document).toBeCloseTo(0.001, 10);
    expect(score.summary.usd_per_100_documents).toBeCloseTo(0.1, 10);
    expect(score.summary.retries).toBe(1);
    expect(score.summary.requests).toBe(4);
  });
});

describe("scoring the arms that make no call", () => {
  test("arm A is all zeros and arm B answers only 1 or 0", async () => {
    const set = ruleset([DASH_RULE, judgmentRule("closer", "end")].join(""));
    const outcome = await runEval({ ruleset: set, candidates: BASES, perRule: 1 });

    const armA = outcome.observations.find((arm) => arm.arm === "A");
    const armB = outcome.observations.find((arm) => arm.arm === "B");

    expect(armA?.cells.every((c) => c.probability === 0)).toBe(true);
    expect(new Set(armB?.cells.map((c) => c.probability))).toEqual(new Set([0, 1]));
    expect(outcome.scores["A"]?.overall["0.7"]?.recall).toBe(0);
    expect(outcome.scores["A"]?.summary.usd_total).toBe(0);
    expect(outcome.scores["B"]?.summary.usd_total).toBe(0);
    expect(outcome.scores["B"]?.per_rule["dash_present"]?.at["0.7"]?.recall).toBe(1);
    expect(outcome.scores["B"]?.per_rule["closer"]?.at["0.7"]?.recall).toBe(0);
  });
});

// --- the run --------------------------------------------------------------

/** Answers from a recorded file, keyed by the opening of the paragraph. */
function recordedClient(seen: JevRequest[]): JevClient {
  const recorded = JSON.parse(
    readFileSync(join(repoRoot, "tests/fixtures/eval/responses.json"), "utf8"),
  ) as { readonly answers: Record<string, Record<string, number>>; readonly fallback: Record<string, number> };

  return {
    async ask(request: JevRequest): Promise<JevResult> {
      seen.push(request);
      const state = String(request.state);
      const key = Object.keys(recorded.answers).find((prefix) => state.includes(prefix));
      return {
        model: "jev-1.13.0",
        nouls: (key === undefined ? recorded.fallback : recorded.answers[key]) ?? {},
        inputTokens: 140,
        outputTokens: 0,
        estimatedCostUsd: 140 * 0.042e-6,
        latencyMs: 417,
        attempts: 1,
      };
    },
  };
}

describe("the three arms over one seeded corpus", () => {
  test("arm C judges every paragraph once and keeps the recorded usage", async () => {
    const seen: JevRequest[] = [];
    const set = ruleset([DASH_RULE, judgmentRule("closer", "end")].join(""));
    const outcome = await runEval({
      ruleset: set,
      candidates: BASES,
      perRule: 1,
      client: recordedClient(seen),
    });

    // Two clean bases plus one seeded paragraph per rule.
    expect(outcome.seeding.seeded).toHaveLength(2);
    expect(seen).toHaveLength(4);
    expect(outcome.scores["C"]?.summary.requests).toBe(4);
    expect(outcome.scores["C"]?.summary.input_tokens).toBe(560);
    expect(outcome.scores["C"]?.summary.usd_total).toBeCloseTo(560 * 0.042e-6, 12);
    expect(outcome.scores["C"]?.summary.median_latency_ms).toBe(417);

    // The judgment rule is caught by arm C and missed by arm B.
    expect(outcome.scores["C"]?.per_rule["closer"]?.at["0.7"]?.recall).toBe(1);
    expect(outcome.scores["B"]?.per_rule["closer"]?.at["0.7"]?.recall).toBe(0);
  });

  test("the raw record carries the model, the usage and the nouls for every paragraph", async () => {
    const set = ruleset(judgmentRule("closer", "end"));
    const outcome = await runEval({
      ruleset: set,
      candidates: BASES,
      perRule: 1,
      client: recordedClient([]),
    });

    const raw = outcome.raw;
    if (raw === undefined) throw new Error("arm C ran, so the raw record must be there");

    expect(raw.model).toBe("jev-1.13.0");
    expect(raw.records).toHaveLength(3);
    expect(raw.records[0]).toMatchObject({ kind: "clean" });
    expect(raw.records.at(-1)).toMatchObject({ kind: "seeded", truth: "closer" });
    for (const record of raw.records) {
      expect(record.usage.input_tokens).toBe(140);
      expect(typeof record.nouls["closer"]).toBe("number");
    }
  });

  test("with no client the run makes no call and reports arms A and B only", async () => {
    const set = ruleset([DASH_RULE, judgmentRule("closer", "end")].join(""));
    const outcome = await runEval({ ruleset: set, candidates: BASES, perRule: 1 });

    expect(outcome.observations.map((arm) => arm.arm)).toEqual(["A", "B"]);
    expect(outcome.raw).toBeUndefined();
    expect(outcome.seeding.seeded).toHaveLength(2);
  });
});

// --- the report -----------------------------------------------------------

describe("the report", () => {
  test("Markdown carries a headline row per arm and a row per rule per arm", async () => {
    const seen: JevRequest[] = [];
    const set = ruleset([DASH_RULE, judgmentRule("closer", "end")].join(""));
    const outcome = await runEval({
      ruleset: set,
      candidates: BASES,
      perRule: 1,
      client: recordedClient(seen),
    });

    const report = buildReport(outcome, { runDate: "2026-09-17", threshold: 0.7 });
    const markdown = renderMarkdown(report);

    for (const arm of ["A (no tool)", "B (countable rules only)", "C (countable rules plus judgment)"]) {
      expect(markdown).toContain(arm);
    }
    for (const rule of ["dash_present", "closer"]) {
      expect(markdown).toContain(rule);
    }
    expect(markdown).toContain("2026-09-17");
    expect(markdown).not.toContain("undefined");
    expect(markdown).not.toContain("NaN");
    expect(JSON.parse(JSON.stringify(report)).arms["C"].summary.requests).toBe(4);
  });
});

// --- the command ----------------------------------------------------------

interface RunOptions {
  readonly argv: readonly string[];
  readonly client?: JevClient;
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
}

async function cli(options: RunOptions): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const home = sandbox();

  const code = await runCli({
    argv: options.argv,
    env: { HOME: home, TYPESAFE_API_KEY: "test-key-not-a-real-credential", ...options.env },
    cwd: options.cwd ?? repoRoot,
    homedir: home,
    write: (line) => out.push(line),
    writeError: (line) => err.push(line),
    isTty: false,
    createClient: () =>
      options.client ?? {
        async ask(): Promise<JevResult> {
          throw new Error("the network was used when it should not have been");
        },
      },
  });

  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("snifftest eval", () => {
  test("--dry-run seeds the corpus, runs arms A and B, and calls nothing", async () => {
    const out = sandbox();
    const result = await cli({
      argv: ["eval", "--dry-run", "--rules", "tests/fixtures/eval/rules.yaml", "--out", out, CORPUS],
    });

    expect(result.code).toBe(EXIT.ok);
    const written = readdirSync(out);
    expect(written).toContain("scores.json");
    expect(written).toContain("tables.md");

    const scores = JSON.parse(readFileSync(join(out, "scores.json"), "utf8")) as {
      arms: Record<string, unknown>;
      corpus: { seeded: number; clean: number; dropped: number };
    };
    expect(Object.keys(scores.arms).sort()).toEqual(["A", "B"]);
    expect(scores.corpus.dropped).toBe(1);
    expect(scores.corpus.clean).toBe(4);
    expect(existsSync(join(out, "raw", "eval-jev.json"))).toBe(false);
  });

  test("without consent it seeds nothing away and sends nothing", async () => {
    const out = sandbox();
    const seen: JevRequest[] = [];
    const result = await cli({
      argv: ["eval", "--rules", "tests/fixtures/eval/rules.yaml", "--out", out, CORPUS],
      client: recordedClient(seen),
    });

    expect(result.code).toBe(EXIT.consent);
    expect(seen).toEqual([]);
    expect(result.err).toContain("api.typesafe.ai");
  });

  test("with --yes it runs all three arms and writes the raw responses beside the inputs", async () => {
    const out = sandbox();
    const seen: JevRequest[] = [];
    const result = await cli({
      argv: ["eval", "--yes", "--rules", "tests/fixtures/eval/rules.yaml", "--out", out, CORPUS],
      client: recordedClient(seen),
    });

    expect(result.code).toBe(EXIT.ok);
    expect(seen.length).toBeGreaterThan(0);
    expect(readdirSync(join(out, "raw"))).toContain("eval-jev.json");
    expect(readdirSync(join(out, "inputs")).sort()).toEqual(["clean.json", "seeded.json"]);

    const scores = JSON.parse(readFileSync(join(out, "scores.json"), "utf8")) as {
      arms: Record<string, unknown>;
    };
    expect(Object.keys(scores.arms).sort()).toEqual(["A", "B", "C"]);
    expect(result.out).toContain("arm C");
  });

  test("the results directory ignores itself, and the run says where the prose went", async () => {
    // `inputs/clean.json` carries every paragraph of the corpus verbatim, and
    // the default destination is inside the user's own repository. An
    // unpublished draft should not be one `git add .` away from a commit, and
    // the run should not have to be read carefully to learn that it was written.
    const out = sandbox();
    const result = await cli({
      argv: ["eval", "--dry-run", "--rules", "tests/fixtures/eval/rules.yaml", "--out", out, CORPUS],
    });

    expect(readFileSync(join(out, ".gitignore"), "utf8")).toContain("*");
    expect(result.out).toContain("inputs");

    const clean = readFileSync(join(out, "inputs/clean.json"), "utf8");
    expect(clean.length).toBeGreaterThan(0);
  });

  test("a .gitignore already in the results directory is left as the user wrote it", async () => {
    const out = sandbox();
    writeFileSync(join(out, ".gitignore"), "# mine\n", "utf8");
    await cli({
      argv: ["eval", "--dry-run", "--rules", "tests/fixtures/eval/rules.yaml", "--out", out, CORPUS],
    });

    expect(readFileSync(join(out, ".gitignore"), "utf8")).toBe("# mine\n");
  });

  test("the seeded inputs name the rule and the transform behind every paragraph", async () => {
    const out = sandbox();
    await cli({
      argv: ["eval", "--dry-run", "--rules", "tests/fixtures/eval/rules.yaml", "--out", out, CORPUS],
    });

    const seeded = JSON.parse(readFileSync(join(out, "inputs/seeded.json"), "utf8")) as {
      seed: number;
      paragraphs: { id: string; rule: string; transform: string; base_id: string }[];
    };
    expect(seeded.paragraphs.length).toBeGreaterThan(0);
    for (const paragraph of seeded.paragraphs) {
      expect(paragraph.rule).toBeTruthy();
      expect(paragraph.transform).toBeTruthy();
      expect(paragraph.base_id).toBeTruthy();
    }
  });
});

// --- review fold-ins ------------------------------------------------------

describe("calibration counts only the cells the arm answered", () => {
  /** The same hand-built set, with one cell the arm gave no opinion on. */
  function withUnanswered(): ArmObservation {
    const base = handBuilt();
    return {
      ...base,
      cells: base.cells.map((cell) =>
        cell.doc === "C2" && cell.rule === "r1" ? { ...cell, probability: 0, answered: false } : cell,
      ),
    };
  }

  const score = scoreArm(withUnanswered(), ["r1", "r2"]);

  test("an unanswered cell is not a 0.0-0.1 reading", () => {
    // Answered zeros: C2/r2 at 0.05. The unanswered C2/r1 must not join it.
    expect(score.calibration["0.0-0.1"]).toEqual({ n: 1, defective: 0, fraction_defective: 0 });
    const counted = Object.values(score.calibration).reduce((sum, bucket) => sum + bucket.n, 0);
    expect(counted).toBe(7);
  });

  test("the unanswered cells are reported as their own count", () => {
    expect(score.calibration_unanswered).toBe(1);
  });

  test("recall and false positives are unchanged by the exclusion", () => {
    const answered = scoreArm(handBuilt(), ["r1", "r2"]);
    expect(score.overall["0.7"]).toEqual(answered.overall["0.7"]);
    expect(score.per_rule["r1"]).toEqual(answered.per_rule["r1"]);
  });
});

describe("the report names the model that served the run", () => {
  test("the markdown summary line carries it beside the seed and the date", async () => {
    const seen: JevRequest[] = [];
    const set = ruleset([DASH_RULE, judgmentRule("closer", "end")].join(""));
    const outcome = await runEval({
      ruleset: set,
      candidates: BASES,
      perRule: 1,
      client: recordedClient(seen),
    });

    const report = buildReport(outcome, { runDate: "2026-09-17", threshold: 0.7 });
    expect(report.served_model).toBe(outcome.raw?.model ?? "");
    expect(report.served_model).toBeTruthy();

    const markdown = renderMarkdown(report);
    const summary = markdown.split("\n").find((line) => line.includes("seed value")) ?? "";
    expect(summary).toContain(String(report.served_model));
  });

  test("a run with no network arm says so rather than inventing a model", async () => {
    const set = ruleset(DASH_RULE);
    const outcome = await runEval({ ruleset: set, candidates: BASES, perRule: 1 });
    const report = buildReport(outcome, { runDate: "2026-09-17", threshold: 0.7 });

    expect(report.served_model).toBeNull();
    expect(renderMarkdown(report)).not.toContain("undefined");
    expect(renderMarkdown(report)).toContain("no model");
  });
});
