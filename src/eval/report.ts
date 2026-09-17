/**
 * Writing the numbers down, twice.
 *
 * JSON for anything that has to read them again, Markdown for a person. Both
 * come from the same object, so the table in a README and the file a script
 * parses cannot drift apart.
 *
 * Four rules hold everywhere in here.
 *
 * A number that was not measured is printed as `n/a`, never as zero, because a
 * zero is a claim.
 *
 * No rate is printed without the k and the n it came from, and no rate is
 * printed to more than two decimal places, because three decimals on three
 * trials is a precision nobody measured. Under ten trials, only k of n is
 * printed and the rate is left out entirely.
 *
 * Recall is split into countable rules and judgment rules and never pooled as
 * the headline, because the seeder guarantees the countable half. Where a
 * pooled figure appears it says pooled in the column.
 *
 * And the run's own awkward parts are printed in the same document as the
 * headline table rather than in a footnote nobody regenerates: rules that
 * could not be seeded, paragraphs that were dropped, requests that failed.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PRICE_BASIS } from "../jev.ts";
import type { EvalOutcome, JudgmentRun, RawRun } from "./run.ts";
import type { ArmScore, ClassScore, Interval } from "./score.ts";
import type { SeededDocument } from "./seed.ts";

export interface ReportOptions {
  /** The date the run happened, `YYYY-MM-DD`. Written into every file. */
  readonly runDate: string;
  readonly threshold: number;
  readonly rulesetSources?: readonly string[];
  readonly corpusPaths?: readonly string[];
}

export interface EvalReport {
  readonly tool: "snifftest eval";
  readonly run_date: string;
  readonly threshold: number;
  readonly seed: number;
  readonly per_rule: number;
  /** 1 is the ruleset's own splice lists; 2 is the seed bank. */
  readonly seed_version: number;
  /**
   * Near misses planted in clean paragraphs, and every rule that flagged one.
   *
   * A near miss is planted next to one rule but it is a whole paragraph, and
   * any rule in the file may fire on it. An entry reads `arm label: rule`, so
   * a paragraph flagged by a rule it was not planted for is visible instead of
   * being filtered out of its own table.
   */
  readonly hard_negatives: readonly {
    readonly id: string;
    readonly rule: string;
    readonly why: string;
    readonly flagged_by: readonly string[];
  }[];
  readonly thresholds: readonly number[];
  readonly ruleset_sources: readonly string[];
  readonly corpus_paths: readonly string[];
  readonly corpus: {
    readonly candidates: number;
    readonly clean: number;
    readonly seeded: number;
    readonly dropped: number;
    readonly dropped_detail: readonly { id: string; file: string; reason: string }[];
    readonly skipped: readonly { rule: string; reason: string }[];
  };
  /**
   * The model string the service actually served, as it came back on the
   * answers, which is not always the one that was asked for. A table of numbers
   * whose model is only in a raw file beside it is a table nobody can date to a
   * model.
   */
  readonly served_model: string | null;
  readonly classes: readonly string[];
  readonly arms: Record<string, ArmScore>;
  readonly seeding: readonly SeededDocument[];
  readonly failures: readonly { readonly doc: string; readonly reason: string }[];
  /**
   * Where the dollar figures come from: measured usage, an unsourced price.
   * Printed beside the cost column so a reader can weigh it.
   */
  readonly cost_basis: typeof PRICE_BASIS;
  /** What the judgment arm did, when there was one. Absent on a dry run. */
  readonly judgment?: JudgmentRun;
}

export function buildReport(outcome: EvalOutcome, options: ReportOptions): EvalReport {
  const seeding = outcome.seeding;

  return {
    tool: "snifftest eval",
    run_date: options.runDate,
    threshold: options.threshold,
    seed: seeding.seedValue,
    per_rule: seeding.perRule,
    seed_version: seeding.seedVersion,
    hard_negatives: seeding.negatives.map((row) => ({
      id: row.id,
      rule: row.rule,
      why: row.why,
      flagged_by: Object.values(outcome.scores).flatMap((arm) =>
        arm.false_positives_at_0_7
          .filter((flag) => flag.doc === row.id)
          .map((flag) => `${arm.label}: ${flag.rule}`),
      ),
    })),
    thresholds: outcome.thresholds,
    ruleset_sources: options.rulesetSources ?? [],
    corpus_paths: options.corpusPaths ?? [],
    corpus: {
      candidates: seeding.clean.length + seeding.dropped.length,
      clean: seeding.clean.length,
      seeded: seeding.seeded.length,
      dropped: seeding.dropped.length,
      dropped_detail: seeding.dropped.map((doc) => ({
        id: doc.id,
        file: `${doc.file}:${doc.line}`,
        reason: doc.reason,
      })),
      skipped: seeding.skipped.map((row) => ({ rule: row.rule, reason: row.reason })),
    },
    served_model: outcome.raw?.served_model ?? null,
    ...(outcome.judgment === undefined ? {} : { judgment: outcome.judgment }),
    classes: outcome.classes,
    arms: outcome.scores,
    seeding: seeding.seeded,
    failures: outcome.failures,
    cost_basis: PRICE_BASIS,
  };
}

// --- Markdown -------------------------------------------------------------

export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  const arms = Object.values(report.arms);
  const at = String(report.threshold);

  lines.push(`# snifftest eval, ${report.run_date}`);
  lines.push("");
  lines.push(
    `${report.corpus.seeded} seeded paragraphs, ${report.corpus.clean} clean ones and ` +
      `${report.hard_negatives.length} near misses, which are counted as clean. ` +
      `${report.per_rule} seeds per rule, seed value ${report.seed}, seed version ${report.seed_version}. ` +
      `Served by ${report.served_model ?? "no model, since no arm made a call"}. ` +
      `Flags count at ${at}.`,
  );
  lines.push("");
  lines.push(
    "Every seeded paragraph is positive for its own rule and negative for every other one, " +
      "so a flag on any other rule is a false positive and never a catch. Recall is measured " +
      "on the seeded paragraphs for that rule, and the false-positive rate on the clean ones.",
  );
  lines.push("");

  // --- headline, split by the class of rule
  lines.push("## Headline");
  lines.push("");
  lines.push(
    "| Arm | Countable rules caught | Judgment rules caught | Judgment recall | " +
      "Clean paragraphs flagged | False alarms per paragraph | Median ms |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const arm of arms) {
    const overall = arm.overall[at];
    const countable = overall?.countable;
    const judgment = overall?.judgment;
    lines.push(
      `| ${arm.label} | ${classCell(countable)} | ${classCell(judgment)} | ` +
        `${rateWithInterval(judgment?.recall, judgment?.hits, judgment?.positives, judgment?.interval)} | ` +
        `${overall === undefined ? "n/a" : `${overall.fp_clean_paragraphs} of ${overall.clean_paragraphs}`} | ` +
        `${rateWithInterval(
          overall === undefined ? null : ratioOf(overall.fp_clean_paragraphs, overall.clean_paragraphs),
          overall?.fp_clean_paragraphs,
          overall?.clean_paragraphs,
          overall?.fp_paragraph_interval,
        )} | ` +
        `${round(arm.summary.median_latency_ms, 0)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Countable rules are the regular expressions. A seeded countable fault is one the pattern " +
      "itself defines, and the seeder throws away any it does not catch, so that column is a " +
      "count and not a measurement of skill. Judgment rules are the ones a model answers, and " +
      "only that column carries a recall figure. The false-alarm rate is per clean paragraph, " +
      `which is the unit a reader meets${postOdds(arms, at)}.`,
  );
  lines.push("");
  const tuning = tuningDisclosure(report);
  if (tuning !== null) {
    lines.push(tuning);
    lines.push("");
  }
  const judgment = judgmentNote(report.judgment);
  if (judgment !== null) {
    lines.push(judgment);
    lines.push("");
  }
  lines.push("Pooled and per-cell figures, which are the flattering ones, are below.");
  lines.push("");
  lines.push("| Arm | Pooled recall | FP per fireable clean cell | FP per clean cell | FP per negative cell |");
  lines.push("|---|---|---|---|---|");
  for (const arm of arms) {
    const overall = arm.overall[at];
    lines.push(
      `| ${arm.label} | ${rateWithInterval(overall?.recall, overall?.hits, overall?.positives, null)} | ` +
        `${cellRate(overall?.fp_rate_per_fireable_clean_cell, overall?.fp_cells, overall?.fireable_clean_cells)} | ` +
        `${cellRate(overall?.fp_rate_per_clean_cell, overall?.fp_cells, overall?.clean_cells)} | ` +
        `${num(overall?.fp_rate_per_negative_cell)} |`,
    );
  }
  lines.push("");
  lines.push(
    "A fireable clean cell is one belonging to a rule that could have fired on a clean " +
      "paragraph at all. Rules the arm never answered, and rules whose clean paragraphs were " +
      "pre-filtered for them, are out of that denominator; they are still in the plain " +
      "per-clean-cell column beside it, which is why the two differ.",
  );
  lines.push("");

  // --- per arm
  for (const arm of arms) {
    lines.push(`## Arm ${arm.label}`);
    lines.push("");
    lines.push(
      `${arm.summary.documents} paragraphs, ${arm.summary.requests} requests, ` +
        `${arm.summary.retries} retried, ${arm.summary.unanswered} rules unanswered. ` +
        `Median ${round(arm.summary.median_latency_ms, 0)} ms, p95 ${round(arm.summary.p95_latency_ms, 0)} ms, ` +
        `${money(arm.summary.usd_total)} in total, ${money(arm.summary.usd_per_paragraph)} per paragraph ` +
        `and ${money(arm.summary.usd_per_100_paragraphs)} per 100 paragraphs sent.`,
    );
    if (arm.summary.paragraphs_without_usage > 0) {
      lines.push("");
      lines.push(
        `${arm.summary.paragraphs_without_usage} of those requests came back with no usage, so ` +
          "every dollar figure for this arm is unmeasured rather than zero.",
      );
    }
    lines.push("");

    lines.push(
      `| Rule | Seeds | ${report.thresholds.map((t) => `Caught @${t}`).join(" | ")} | ${report.thresholds
        .map((t) => `False alarms @${t}`)
        .join(" | ")} |`,
    );
    lines.push("|---".repeat(2 + report.thresholds.length * 2) + "|");
    for (const rule of report.classes) {
      const row = arm.per_rule[rule];
      if (row === undefined) continue;
      const recalls = report.thresholds.map((t) => {
        const at7 = row.at[String(t)];
        return rateWithInterval(at7?.recall, at7?.hits, row.n_positive, at7?.interval);
      });
      const fps = report.thresholds.map((t) => {
        const at7 = row.at[String(t)];
        return rateWithInterval(at7?.fp_rate_clean, at7?.fps, row.n_clean, null);
      });
      lines.push(`| ${rule} | ${row.n_positive} | ${recalls.join(" | ")} | ${fps.join(" | ")} |`);
    }
    lines.push("");
    lines.push(
      `Every cell is k of n. A rate is printed beside it only where n is ${RATE_FLOOR} or more, ` +
        `because a rate over ${report.per_rule} seeds is one of ${report.per_rule + 1} possible ` +
        "numbers and reads as a measurement it is not.",
    );
    lines.push("");

    lines.push(
      "| Threshold | Judgment rules caught | Pooled recall | FP per fireable clean cell | " +
        "Off-rule flags | Clean paragraphs flagged |",
    );
    lines.push("|---|---|---|---|---|---|");
    for (const threshold of report.thresholds) {
      const overall = arm.overall[String(threshold)];
      lines.push(
        `| ${threshold} | ${classCell(overall?.judgment)} | ` +
          `${rateWithInterval(overall?.recall, overall?.hits, overall?.positives, null)} | ` +
          `${cellRate(
            overall?.fp_rate_per_fireable_clean_cell,
            overall?.fp_cells,
            overall?.fireable_clean_cells,
          )} | ` +
          `${overall?.off_rule_flags ?? 0} | ` +
          `${overall === undefined ? "n/a" : `${overall.fp_clean_paragraphs} of ${overall.clean_paragraphs}`} |`,
      );
    }
    lines.push("");

    if (arm.network) {
      lines.push("### Calibration");
      lines.push("");
      lines.push("| Bucket | Cells | Defective | Fraction |");
      lines.push("|---|---|---|---|");
      for (const [bucket, row] of Object.entries(arm.calibration)) {
        lines.push(`| ${bucket} | ${row.n} | ${row.defective} | ${num(row.fraction_defective)} |`);
      }
      lines.push("");
      lines.push(
        `${arm.calibration_unanswered} cells are not in those buckets because the arm gave no ` +
          "opinion on them. They count as misses in recall, and a probability of zero would have " +
          "read as an answer.",
      );
      lines.push("");

      lines.push(`### Misses at 0.7 (${arm.misses_at_0_7.length})`);
      lines.push("");
      for (const row of arm.misses_at_0_7) {
        lines.push(`- \`${row.doc}\` ${row.rule} at ${round(row.probability, 3)}: ${excerpt(row.text)}`);
      }
      if (arm.misses_at_0_7.length === 0) lines.push("- none");
      lines.push("");

      lines.push(`### False positives at 0.7 (${arm.false_positives_at_0_7.length})`);
      lines.push("");
      for (const row of arm.false_positives_at_0_7) {
        lines.push(`- \`${row.doc}\` ${row.rule} at ${round(row.probability, 3)}: ${excerpt(row.text)}`);
      }
      if (arm.false_positives_at_0_7.length === 0) lines.push("- none");
      lines.push("");
    }
  }

  // --- the corpus, including what it could not do
  lines.push("## The seeded corpus");
  lines.push("");
  lines.push("| Paragraph | Rule | Transform | Base |");
  lines.push("|---|---|---|---|");
  for (const doc of report.seeding) {
    lines.push(`| ${doc.id} | ${doc.rule} | ${doc.transform} | ${doc.base_id} (${doc.base_file}) |`);
  }
  lines.push("");

  if (report.corpus.dropped > 0) {
    lines.push(`${report.corpus.dropped} candidate paragraphs were not clean enough to seed:`);
    lines.push("");
    for (const row of report.corpus.dropped_detail) {
      lines.push(`- \`${row.id}\` ${row.file}: ${row.reason}`);
    }
    lines.push("");
  }

  if (report.hard_negatives.length > 0) {
    lines.push("## Hard negatives");
    lines.push("");
    lines.push(
      "Each of these is a clean paragraph with a sentence planted in it that sits close to one " +
        "rule and is not a defect. A flag on one is a false positive, and it is the false " +
        "positive worth knowing about, because it is the one a careful writer would meet.",
    );
    lines.push("");
    lines.push("| Paragraph | Near | Why it is not a defect | Flagged by |");
    lines.push("|---|---|---|---|");
    for (const row of report.hard_negatives) {
      lines.push(
        `| ${row.id} | ${row.rule} | ${row.why} | ${row.flagged_by.length === 0 ? "nobody" : row.flagged_by.join(", ")} |`,
      );
    }
    lines.push("");
  }

  if (report.corpus.skipped.length > 0) {
    lines.push("Rules that could not be fully seeded:");
    lines.push("");
    for (const row of report.corpus.skipped) lines.push(`- \`${row.rule}\`: ${row.reason}`);
    lines.push("");
  }

  lines.push(`Requests that failed: ${report.failures.length}.`);
  for (const failure of report.failures) lines.push(`- \`${failure.doc}\`: ${failure.reason}`);
  lines.push("");
  lines.push(
    "The seeds are synthetic splices and mechanical edits, so these recall figures are an " +
      "upper bound on what the same rules would catch in defects that occurred naturally.",
  );
  lines.push("");
  lines.push("## What a paragraph is, and what a dollar figure rests on");
  lines.push("");
  lines.push(
    "The unit everywhere above is a paragraph: one blank-line block of a Markdown file, and " +
      `one request carrying all ${report.classes.length} questions about it. A cost per 100 ` +
      "paragraphs is a cost per 100 requests, so the bill for a document is that rate times " +
      "the paragraphs it holds, and it grows with the number of rules in the ruleset as well.",
  );
  lines.push("");
  lines.push(
    `Token counts are ${report.cost_basis.usage}. The price used is ` +
      `${perMillion(report.cost_basis.usd_per_input_token)} per million input tokens and ` +
      `${perMillion(report.cost_basis.usd_per_output_token)} per million output tokens, from ` +
      `${report.cost_basis.source ?? "no published source that anyone has recorded"}` +
      `${report.cost_basis.verified_on === null ? " and carrying no date" : `, checked on ${report.cost_basis.verified_on}`}. ` +
      "Read the dollar columns as arithmetic on measured usage at a price nobody here has verified.",
  );
  lines.push("");

  return lines.join("\n");
}

// --- writing --------------------------------------------------------------

export interface WrittenReport {
  readonly json: string;
  readonly markdown: string;
  readonly cleanInputs: string;
  readonly seededInputs: string;
  /**
   * The near misses, in full.
   *
   * They are the hardest clean paragraphs in the corpus and the ones a bench
   * arm most needs to see, and without a file of their own the only copy lives
   * inside a scores file as a reason string.
   */
  readonly negativeInputs: string;
  readonly raw?: string;
}

/**
 * What the results directory gets on first creation.
 *
 * `inputs/clean.json` holds every paragraph of the corpus verbatim, and the
 * default destination is inside the user's own repository. An unpublished draft
 * should not be one `git add .` away from being committed, or one glob away
 * from being uploaded as a CI artifact, because the tool chose a convenient
 * place to write. A file the user wrote themselves is never overwritten.
 */
const RESULTS_GITIGNORE = `# Written by snifftest. These files carry your prose in full.
# Delete this file if you mean to commit them.
*
`;

export function writeReport(
  report: EvalReport,
  outcome: EvalOutcome,
  outDir: string,
): WrittenReport {
  const ignore = join(outDir, ".gitignore");
  if (!existsSync(ignore)) write(ignore, RESULTS_GITIGNORE);

  const json = join(outDir, "scores.json");
  const markdown = join(outDir, "tables.md");
  const cleanInputs = join(outDir, "inputs", "clean.json");
  const seededInputs = join(outDir, "inputs", "seeded.json");
  const negativeInputs = join(outDir, "inputs", "negatives.json");

  write(json, `${JSON.stringify(report, null, 1)}\n`);
  write(markdown, renderMarkdown(report));
  write(
    cleanInputs,
    `${JSON.stringify(
      {
        run_date: report.run_date,
        seed: report.seed,
        paragraphs: outcome.seeding.clean,
        dropped: outcome.seeding.dropped,
      },
      null,
      1,
    )}\n`,
  );
  write(
    seededInputs,
    `${JSON.stringify(
      {
        run_date: report.run_date,
        seed: report.seed,
        per_rule: report.per_rule,
        skipped: outcome.seeding.skipped,
        paragraphs: outcome.seeding.seeded,
      },
      null,
      1,
    )}\n`,
  );

  write(
    negativeInputs,
    `${JSON.stringify(
      {
        run_date: report.run_date,
        seed: report.seed,
        paragraphs: outcome.seeding.negatives,
      },
      null,
      1,
    )}\n`,
  );

  const raw = outcome.raw;
  if (raw === undefined) return { json, markdown, cleanInputs, seededInputs, negativeInputs };

  const rawPath = join(outDir, "raw", "eval-jev.json");
  write(rawPath, `${JSON.stringify(withDate(raw, report.run_date), null, 1)}\n`);
  return { json, markdown, cleanInputs, seededInputs, negativeInputs, raw: rawPath };
}

function withDate(raw: RawRun, runDate: string): RawRun & { run_date: string } {
  return { run_date: runDate, ...raw };
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

// --- formatting -----------------------------------------------------------

/** Below this many trials a rate is not printed at all, only k of n. */
const RATE_FLOOR = 10;

/**
 * How long a post the false-alarm sentence talks about.
 *
 * The sentence used to print a fixed rate and a fixed one-in-three whatever
 * the run measured, which is the kind of hard-coded number this file exists to
 * refuse. It is computed from the arm with the highest rate instead, and left
 * out when no arm flagged a clean paragraph at all.
 */
const POST_PARAGRAPHS = 8;

function postOdds(arms: readonly ArmScore[], at: string): string {
  let worst: { label: string; rate: number } | null = null;
  for (const arm of arms) {
    const overall = arm.overall[at];
    if (overall === undefined || overall.clean_paragraphs === 0) continue;
    const rate = ratioOf(overall.fp_clean_paragraphs, overall.clean_paragraphs);
    if (rate === null || rate <= 0) continue;
    if (worst === null || rate > worst.rate) worst = { label: arm.label, rate };
  }
  if (worst === null) return ", and no arm flagged a clean paragraph in this run";
  const any = 1 - (1 - worst.rate) ** POST_PARAGRAPHS;
  return (
    `. Arm ${worst.label}'s rate of ${worst.rate.toFixed(2)} is about a ` +
    `${(any * 100).toFixed(0)} in 100 chance of at least one false flag somewhere in a ` +
    `${POST_PARAGRAPHS} paragraph post`
  );
}

/**
 * Rules whose wording was revised after seeing this seed set miss faults.
 *
 * A number measured on the seeds that prompted the rewrite is not the number a
 * stranger's prose would give, and a reader of the table has to be told so in
 * the table rather than in a notes file they may never open. Adding a rule here
 * is part of rewording it.
 */
const TUNED_RULES: readonly { readonly rule: string; readonly when: string }[] = [
  { rule: "self_undercutting", when: "2026-09-17" },
  { rule: "first_x_that", when: "2026-09-17" },
];

function tuningDisclosure(report: EvalReport): string | null {
  const measured = TUNED_RULES.filter((entry) => report.classes.includes(entry.rule));
  if (measured.length === 0) return null;
  const names = measured.map((entry) => `${entry.rule} (${entry.when})`).join(", ");
  return (
    `Tuning disclosure. ${measured.length} of the rules in this table were reworded after a ` +
    `run on these same seeds showed them missing faults, and then measured again on these ` +
    `same seeds: ${names}. Their figures are the best case, not a reading of unseen prose. ` +
    "The rest of the ruleset has not been tuned against this corpus."
  );
}

/** One sentence on what the judgment arm actually managed, or nothing. */
function judgmentNote(run: JudgmentRun | undefined): string | null {
  if (run === undefined) return null;
  const parts: string[] = [
    `The judgment arm sent ${run.sent} of ${run.sent + run.notSent} prose paragraphs and got ` +
      `${run.answered} usable answers back`,
  ];
  if (run.structure > 0) {
    parts.push(
      `${run.structure} blocks were structure rather than prose and were never sent, which is ` +
        "what an ordinary check does with them",
    );
  }
  if (run.stopped !== null) {
    parts.push(
      `it stopped early and left ${run.notSent} paragraphs unasked: ${run.stopped}`,
    );
  }
  return `${parts.join("; ")}.`;
}

/** A measured ratio, or `n/a`. Never a zero standing in for "not measured". */
function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(2);
}

function ratioOf(k: number, n: number): number | null {
  return n === 0 ? null : k / n;
}

/** One class of rule: k of n, said as a count, because that is what it is. */
function classCell(score: ClassScore | undefined): string {
  if (score === undefined || score.positives === 0) return "n/a";
  const how = score.by_construction ? " (by construction)" : "";
  return `${score.hits} of ${score.positives}${how}`;
}

/**
 * k of n first, then the rate, then the interval, and never a rate on its own.
 *
 * Under ten trials the rate is left out: one of four possible values printed to
 * two decimals is a number that looks measured and is not.
 */
function rateWithInterval(
  rate: number | null | undefined,
  k: number | undefined,
  n: number | undefined,
  interval: Interval | null | undefined,
): string {
  if (k === undefined || n === undefined || n === 0) return "n/a";
  const counted = `${k} of ${n}`;
  if (n < RATE_FLOOR) return counted;
  if (rate === null || rate === undefined) return counted;
  const range = interval == null ? "" : ` (${interval.low.toFixed(2)} to ${interval.high.toFixed(2)})`;
  return `${counted}, ${rate.toFixed(2)}${range}`;
}

/** A per-cell rate, which always prints its denominator because that is the argument. */
function cellRate(rate: number | null | undefined, k: number | undefined, n: number | undefined): string {
  if (k === undefined || n === undefined || n === 0) return "n/a";
  if (n < RATE_FLOOR || rate === null || rate === undefined) return `${k} of ${n}`;
  return `${k} of ${n}, ${rate.toFixed(2)}`;
}

function perMillion(usdPerToken: number): string {
  return `$${(usdPerToken * 1_000_000).toFixed(3)}`;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

function round(value: number, places: number): string {
  return Number.isFinite(value) ? value.toFixed(places) : "n/a";
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 140 ? flat : `${flat.slice(0, 137)}...`;
}
