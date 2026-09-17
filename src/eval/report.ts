/**
 * Writing the numbers down, twice.
 *
 * JSON for anything that has to read them again, Markdown for a person. Both
 * come from the same object, so the table in a README and the file a script
 * parses cannot drift apart.
 *
 * Two rules hold everywhere in here. A number that was not measured is printed
 * as `n/a`, never as zero, because a zero is a claim. And the run's own
 * awkward parts — rules that could not be seeded, paragraphs that were dropped,
 * requests that failed — are printed in the same document as the headline
 * table rather than in a footnote nobody regenerates.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { EvalOutcome, RawRun } from "./run.ts";
import type { ArmScore } from "./score.ts";
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
   * answers — not the one that was asked for. A table of numbers whose model is
   * only in a raw file beside it is a table nobody can date to a model.
   */
  readonly served_model: string | null;
  readonly classes: readonly string[];
  readonly arms: Record<string, ArmScore>;
  readonly seeding: readonly SeededDocument[];
  readonly failures: readonly { readonly doc: string; readonly reason: string }[];
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

  // --- headline
  lines.push("## Headline");
  lines.push("");
  lines.push(
    `| Arm | Recall @${at} | FP per clean cell | FP per negative cell | Clean paragraphs flagged | Median ms | $ per 100 documents |`,
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const arm of arms) {
    const overall = arm.overall[at];
    lines.push(
      `| ${arm.label} | ${num(overall?.recall)} | ${num(overall?.fp_rate_per_clean_cell)} | ` +
        `${num(overall?.fp_rate_per_negative_cell)} | ${num(overall?.fp_clean_documents_with_any_flag)} | ` +
        `${round(arm.summary.median_latency_ms, 0)} | ${money(arm.summary.usd_per_100_documents)} |`,
    );
  }
  lines.push("");

  // --- per arm
  for (const arm of arms) {
    lines.push(`## Arm ${arm.label}`);
    lines.push("");
    lines.push(
      `${arm.summary.documents} documents, ${arm.summary.requests} requests, ` +
        `${arm.summary.retries} retried, ${arm.summary.unanswered} rules unanswered. ` +
        `Median ${round(arm.summary.median_latency_ms, 0)} ms, p95 ${round(arm.summary.p95_latency_ms, 0)} ms, ` +
        `${money(arm.summary.usd_total)} in total and ${money(arm.summary.usd_per_document)} per document.`,
    );
    lines.push("");

    lines.push(
      `| Rule | n | ${report.thresholds.map((t) => `R@${t}`).join(" | ")} | ${report.thresholds
        .map((t) => `FP@${t}`)
        .join(" | ")} |`,
    );
    lines.push("|---".repeat(2 + report.thresholds.length * 2) + "|");
    for (const rule of report.classes) {
      const row = arm.per_rule[rule];
      if (row === undefined) continue;
      const recalls = report.thresholds.map((t) => num(row.at[String(t)]?.recall));
      const fps = report.thresholds.map((t) => num(row.at[String(t)]?.fp_rate_clean));
      lines.push(`| ${rule} | ${row.n_positive} | ${recalls.join(" | ")} | ${fps.join(" | ")} |`);
    }
    lines.push("");

    lines.push(`| Threshold | Recall | FP per clean cell | Off-rule flags | Clean paragraphs flagged |`);
    lines.push("|---|---|---|---|---|");
    for (const threshold of report.thresholds) {
      const overall = arm.overall[String(threshold)];
      lines.push(
        `| ${threshold} | ${num(overall?.recall)} | ${num(overall?.fp_rate_per_clean_cell)} | ` +
          `${overall?.off_rule_flags ?? 0} | ${num(overall?.fp_clean_documents_with_any_flag)} |`,
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

/** A measured ratio, or `n/a`. Never a zero standing in for "not measured". */
function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(3);
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
