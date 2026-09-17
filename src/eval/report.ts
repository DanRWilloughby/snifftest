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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PRICE_BASIS } from "../jev.ts";
import type { EvalOutcome, RawRun } from "./run.ts";
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
}

export function buildReport(outcome: EvalOutcome, options: ReportOptions): EvalReport {
  const seeding = outcome.seeding;

  return {
    tool: "snifftest eval",
    run_date: options.runDate,
    threshold: options.threshold,
    seed: seeding.seedValue,
    per_rule: seeding.perRule,
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
    served_model: outcome.raw?.model ?? null,
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
    `${report.corpus.seeded} seeded paragraphs and ${report.corpus.clean} clean ones, ` +
      `${report.per_rule} seeds per rule, seed value ${report.seed}. ` +
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
      "which is the unit a reader meets: a rate of 0.04 on an eight-paragraph post is about a " +
      "one-in-three chance of at least one false flag somewhere in it.",
  );
  lines.push("");
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
        "because a rate over three seeds is one of four possible numbers and reads as a " +
        "measurement it is not.",
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
  readonly raw?: string;
}

export function writeReport(
  report: EvalReport,
  outcome: EvalOutcome,
  outDir: string,
): WrittenReport {
  const json = join(outDir, "scores.json");
  const markdown = join(outDir, "tables.md");
  const cleanInputs = join(outDir, "inputs", "clean.json");
  const seededInputs = join(outDir, "inputs", "seeded.json");

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

  const raw = outcome.raw;
  if (raw === undefined) return { json, markdown, cleanInputs, seededInputs };

  const rawPath = join(outDir, "raw", "eval-jev.json");
  write(rawPath, `${JSON.stringify(withDate(raw, report.run_date), null, 1)}\n`);
  return { json, markdown, cleanInputs, seededInputs, raw: rawPath };
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
