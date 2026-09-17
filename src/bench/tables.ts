/**
 * The comparison, written down so it can be argued with.
 *
 * Two files come out of a bench run: JSON for the video props and anything else
 * that reads numbers again, Markdown for the README appendix and for a person.
 * Both are rendered from one object, so the table in the README and the file a
 * script parses cannot drift.
 *
 * Three rules hold in every cell.
 *
 * A model with no published price prints `unknown`, never `$0.00`. A zero in a
 * cost column is a claim that the call was free, and an unpriced model cannot
 * support it.
 *
 * A model the provider did not list on the run date prints its row with the
 * reason and no numbers. Substituting the nearest available model would make
 * one row silently measure something other than its label.
 *
 * Failures and retries are printed beside the table, not in a footnote. A bench
 * whose failures are invisible is a bench whose clean rows cannot be trusted.
 *
 * And the rows were not sent identical requests, so the tables say what each
 * row was sent. A reasoning model's internal tokens come out of the same
 * completion budget as its answer, so the deep rows carry budgets of their own;
 * printing those budgets is the difference between a declared handicap and a
 * hidden one.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ArmScore } from "../eval/score.ts";
import type { ReasoningSetting } from "./panel.ts";
import type { BenchModelResult, BenchOutcome } from "./run.ts";

/** One arm carried over from `snifftest eval`, so both halves share a corpus. */
export interface JoinedArm {
  readonly arm: string;
  readonly label: string;
  readonly recall: number | null;
  readonly fpPerCleanCell: number | null;
  readonly medianMs: number;
  readonly usdPer100Documents: number | null;
  /** What the eval run was served by, when that arm made a call at all. */
  readonly servedModel?: string | null;
}

export interface BenchReportOptions {
  readonly runDate: string;
  readonly threshold: number;
  readonly repeats: number;
  readonly panelFile: string;
  /** One line per price source, printed under the tables that use them. */
  readonly priceSources: readonly string[];
  readonly corpus: {
    readonly clean: number;
    readonly seeded: number;
    readonly seed: number;
    readonly perRule: number;
  };
  readonly joined?: readonly JoinedArm[];
  /** Where the eval numbers were joined from, when they were. */
  readonly evalSource?: string;
}

export interface BenchModelRow {
  readonly id: string;
  readonly label: string;
  readonly tier: string;
  readonly provider: string;
  readonly available: boolean;
  readonly slug: string | null;
  readonly served_model: string | null;
  readonly json_mode: boolean;
  readonly note: string | null;
  /** What this row's requests carried, so a reader can see the rows differ. */
  readonly request: { readonly max_tokens: number; readonly reasoning: ReasoningSetting | null };
  readonly prices: {
    readonly input_usd_per_token: number;
    readonly output_usd_per_token: number;
    readonly source: string;
  } | null;
  readonly calls: number;
  readonly failures: number;
  readonly retries: number;
  readonly parse_failures: number;
  readonly truncated: number;
  readonly unanswered_cells: number;
  readonly latency: { readonly median_ms: number; readonly p95_ms: number; readonly samples: number };
  readonly cost: {
    readonly total_usd: number | null;
    readonly usd_per_document: number | null;
    readonly usd_per_100_documents: number | null;
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
  readonly accuracy: ArmScore | null;
  readonly failure_detail: readonly { doc: string; repeat: number; reason: string }[];
}

export interface BenchReport {
  readonly tool: "snifftest bench";
  readonly run_date: string;
  readonly threshold: number;
  readonly thresholds: readonly number[];
  readonly repeats: number;
  readonly panel_file: string;
  readonly price_sources: readonly string[];
  readonly eval_source: string | null;
  readonly corpus: {
    readonly clean: number;
    readonly seeded: number;
    readonly seed: number;
    readonly per_rule: number;
  };
  readonly classes: readonly string[];
  readonly question_ids: readonly string[];
  /** The one prompt every model was sent, so the table can be checked against it. */
  readonly system_prompt: string;
  readonly models: readonly BenchModelRow[];
  readonly joined: readonly JoinedArm[];
  readonly totals: {
    readonly calls: number;
    readonly failures: number;
    readonly retries: number;
    /** Only the priced rows; the unpriced ones are named beside it. */
    readonly usd_total_priced_rows: number;
    readonly unpriced_models: readonly string[];
  };
}

export function buildBenchReport(outcome: BenchOutcome, options: BenchReportOptions): BenchReport {
  const models = outcome.models.map(toRow);

  return {
    tool: "snifftest bench",
    run_date: options.runDate,
    threshold: options.threshold,
    thresholds: outcome.thresholds,
    repeats: options.repeats,
    panel_file: options.panelFile,
    price_sources: options.priceSources,
    eval_source: options.evalSource ?? null,
    corpus: {
      clean: options.corpus.clean,
      seeded: options.corpus.seeded,
      seed: options.corpus.seed,
      per_rule: options.corpus.perRule,
    },
    classes: outcome.classes,
    question_ids: outcome.questionIds,
    system_prompt: outcome.systemPrompt,
    models,
    joined: options.joined ?? [],
    totals: {
      calls: models.reduce((sum, model) => sum + model.calls, 0),
      failures: models.reduce((sum, model) => sum + model.failures, 0),
      retries: models.reduce((sum, model) => sum + model.retries, 0),
      usd_total_priced_rows: models.reduce((sum, model) => sum + (model.cost.total_usd ?? 0), 0),
      unpriced_models: models
        .filter((model) => model.available && model.prices === null)
        .map((model) => model.id),
    },
  };
}

function toRow(model: BenchModelResult): BenchModelRow {
  return {
    id: model.id,
    label: model.label,
    tier: model.tier,
    provider: model.provider,
    available: model.available,
    slug: model.slug,
    served_model: model.servedModel,
    json_mode: model.jsonMode,
    note: model.note ?? null,
    request: { max_tokens: model.request.maxTokens, reasoning: model.request.reasoning },
    prices:
      model.prices === null
        ? null
        : {
            input_usd_per_token: model.prices.inputUsdPerToken,
            output_usd_per_token: model.prices.outputUsdPerToken,
            source: model.prices.source,
          },
    calls: model.calls,
    failures: model.failures,
    retries: model.retries,
    parse_failures: model.parseFailures,
    truncated: model.truncated,
    unanswered_cells: model.unansweredCells,
    latency: {
      median_ms: model.latency.medianMs,
      p95_ms: model.latency.p95Ms,
      samples: model.latency.samples,
    },
    cost: {
      total_usd: model.cost.totalUsd,
      usd_per_document: model.cost.usdPerDocument,
      usd_per_100_documents: model.cost.usdPer100Documents,
      input_tokens: model.cost.inputTokens,
      output_tokens: model.cost.outputTokens,
    },
    accuracy: model.score,
    failure_detail: model.failureDetail.map((failure) => ({ ...failure })),
  };
}

// --- Markdown -------------------------------------------------------------

export function renderBenchMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  const at = String(report.threshold);

  lines.push(`# snifftest bench, ${report.run_date}`);
  lines.push("");
  lines.push(
    `${report.corpus.seeded} seeded paragraphs and ${report.corpus.clean} clean ones, seed ` +
      `${report.corpus.seed}, ${report.corpus.per_rule} per rule. Every model was sent the same ` +
      `rule wording and the same paragraph, one call per paragraph, temperature 0. The rows ` +
      `differ in one respect, the completion budget and reasoning each was given, and that is ` +
      `printed in full under "The run". ` +
      `Accuracy is from the first repeat; latency is the median and p95 over ${report.repeats} ` +
      `repeat${report.repeats === 1 ? "" : "s"}; cost is from returned token usage.`,
  );
  lines.push("");

  // --- headline
  lines.push("## Headline");
  lines.push("");
  // The served model rides in the headline rather than only in the run table
  // below: a row of numbers read on its own has to say which model produced it.
  lines.push(
    `| Model | Tier | Model served | Recall @${at} | FP per clean cell | Median ms | $ per 100 documents |`,
  );
  lines.push("|---|---|---|---|---|---|---|");

  for (const arm of report.joined) {
    lines.push(
      `| ${arm.label} | eval arm | ${arm.servedModel ?? "-"} | ${num(arm.recall)} | ` +
        `${num(arm.fpPerCleanCell)} | ${Math.round(arm.medianMs)} | ${money(arm.usdPer100Documents)} |`,
    );
  }

  for (const model of report.models) {
    if (!model.available) {
      lines.push(
        `| ${model.label} | ${model.tier} | - | ${model.note ?? "not available"} | - | - | - |`,
      );
      continue;
    }
    const overall = model.accuracy?.overall[at];
    lines.push(
      `| ${model.label} | ${model.tier} | ${model.served_model ?? model.slug ?? "-"} | ` +
        `${num(overall?.recall)} | ${num(overall?.fp_rate_per_clean_cell)} | ` +
        `${Math.round(model.latency.median_ms)} | ${money(model.cost.usd_per_100_documents)} |`,
    );
  }
  lines.push("");

  lines.push(
    "`unknown` in a cost column means the provider published no price for that model on the run " +
      "date. It is not zero, and it is not an estimate.",
  );
  lines.push("");

  // --- one table per rule
  lines.push("## Per rule");
  lines.push("");
  for (const rule of report.classes) {
    lines.push(`### ${rule}`);
    lines.push("");
    lines.push(`| Model | n seeded | Recall @${at} | FP rate on clean | Unanswered |`);
    lines.push("|---|---|---|---|---|");
    for (const model of report.models) {
      if (!model.available) {
        lines.push(`| ${model.label} | - | ${model.note ?? "not available"} | - | - |`);
        continue;
      }
      const row = model.accuracy?.per_rule[rule];
      const cell = row?.at[at];
      lines.push(
        `| ${model.label} | ${row?.n_positive ?? 0} | ${num(cell?.recall)} | ${num(cell?.fp_rate_clean)} | ` +
          `${model.unanswered_cells} |`,
      );
    }
    lines.push("");
  }

  // --- what the run cost and what went wrong
  lines.push("## The run");
  lines.push("");
  lines.push(
    `${report.totals.calls} calls, ${report.totals.failures} failed, ${report.totals.retries} retried. ` +
      `Priced rows cost ${money(report.totals.usd_total_priced_rows)} in total` +
      (report.totals.unpriced_models.length === 0
        ? "."
        : `; ${report.totals.unpriced_models.join(", ")} had no published price and are not in that figure.`),
  );
  lines.push("");

  lines.push(
    "| Model | Slug served | JSON mode | Calls | Failed | Parse failures | Truncated | p95 ms |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const model of report.models) {
    lines.push(
      `| ${model.label} | ${model.served_model ?? model.slug ?? (model.note ?? "-")} | ` +
        `${model.json_mode ? "yes" : "no"} | ${model.calls} | ${model.failures} | ` +
        `${model.parse_failures} | ${model.truncated} | ${Math.round(model.latency.p95_ms)} |`,
    );
  }
  lines.push("");
  lines.push(
    "A truncated reply stopped at its completion budget before it was a whole JSON object. It " +
      "counts as unanswered exactly as a malformed reply does, and it is listed apart from one " +
      "because it says something about the budget rather than about the model.",
  );
  lines.push("");

  lines.push(...requestSettings(report));

  const failures = report.models.flatMap((model) =>
    model.failure_detail.map((failure) => `- \`${model.id}\` ${failure.doc} repeat ${failure.repeat}: ${failure.reason}`),
  );
  if (failures.length > 0) {
    lines.push("Failures, in full:");
    lines.push("");
    lines.push(...failures);
    lines.push("");
  }

  // --- provenance
  lines.push("## Where these numbers come from");
  lines.push("");
  lines.push(`- Panel: \`${report.panel_file}\`; each model resolved against its provider's own model list on ${report.run_date}.`);
  for (const source of report.price_sources) lines.push(`- Prices: ${source}`);
  if (report.eval_source !== null) lines.push(`- Eval arms joined from \`${report.eval_source}\`.`);
  lines.push(
    "- The seeds are synthetic splices and mechanical edits, so every recall figure here is an " +
      "upper bound on what the same rules would catch in defects that occurred naturally.",
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * What each row was sent, printed rather than left for a reader to assume.
 *
 * The rows were not sent identical requests, and a comparison that let a reader
 * believe otherwise would be the dishonest one. A reasoning model spends its
 * internal tokens out of the same completion budget as its answer, so a deep
 * row on a budget sized for a fast row runs out mid-thought and reads as a
 * failure that is really the run's doing.
 */
function requestSettings(report: BenchReport): string[] {
  const lines = ["What each row was sent:", ""];
  lines.push("| Model | Completion budget | Reasoning |");
  lines.push("|---|---|---|");
  for (const model of report.models) {
    lines.push(
      `| ${model.label} | ${model.request.max_tokens} tokens | ${reasoningWords(model.request.reasoning)} |`,
    );
  }
  lines.push("");
  return lines;
}

function reasoningWords(setting: ReasoningSetting | null): string {
  if (setting === null) return "not requested";
  const parts: string[] = [];
  if (setting.effort !== undefined) parts.push(`effort ${setting.effort}`);
  if (setting.maxTokens !== undefined) parts.push(`up to ${setting.maxTokens} tokens`);
  if (setting.exclude === true) parts.push("kept out of the reply");
  return parts.length === 0 ? "requested, with the provider's defaults" : parts.join(", ");
}

// --- writing --------------------------------------------------------------

export interface WrittenBench {
  readonly json: string;
  readonly markdown: string;
  readonly raw: readonly string[];
}

export function writeBenchReport(
  report: BenchReport,
  outcome: BenchOutcome,
  outDir: string,
): WrittenBench {
  const json = join(outDir, "bench-scores.json");
  const markdown = join(outDir, "bench-tables.md");

  write(json, `${JSON.stringify(report, null, 1)}\n`);
  write(markdown, renderBenchMarkdown(report));

  const raw: string[] = [];
  for (const run of outcome.raw) {
    const path = join(outDir, "raw", `bench-${run.model_id}-r${run.repeat}.json`);
    write(path, `${JSON.stringify(run, null, 1)}\n`);
    raw.push(path);
  }

  return { json, markdown, raw };
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

// --- formatting -----------------------------------------------------------

function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "n/a" : value.toFixed(3);
}

/** `unknown` where there is no price. Never a zero standing in for one. */
function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}
