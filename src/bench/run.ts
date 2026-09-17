/**
 * Arm D: the same corpus, the same rule text, asked of ordinary models.
 *
 * Arm D is built to be comparable with arm C cell for cell. It runs the same
 * countable rules locally and for free, asks one model about the same
 * paragraph with the same rule wording in one call, and produces the same
 * `ArmObservation` the eval arms produce, so the same scorer reads all of them.
 * Nothing in `src/eval/score.ts` is specialised for this; if it were, the two
 * halves of the headline table would be measuring with different rulers.
 *
 * ## Order matters, so it is spread
 *
 * Models are called round-robin per document, with the starting model rotating
 * as the corpus advances. A run where one model always goes first would give
 * that model every cold start and every warm cache in the same places; rotating
 * puts each model in each position and leaves the remaining difference to the
 * models rather than to the order.
 *
 * ## Repeats measure time, not accuracy
 *
 * Latency is the noisy number, so it is measured over every repeat and reported
 * as a median and a p95. Accuracy is not noisy in the same way at temperature
 * zero and costs money to repeat, so it is taken from the first repeat only and
 * the report says so. Cost is averaged over every call that returned usage.
 *
 * ## Nothing is invented
 *
 * A model the provider did not list is never called and never scored: it is a
 * row that says so. A torn reply is a counted failure and a set of unanswered
 * cells. A model with no published price has no cost, not a zero.
 */

import { runRegexArm } from "../engine.ts";
import type { ArmObservation, ArmScore, Cell, JudgedDocument } from "../eval/score.ts";
import { scoreArm, thresholdsWith } from "../eval/score.ts";
import { type Chunk, type Ruleset, isJudgmentRule, isRegexRule } from "../types.ts";
import type { ModelAdapter, ModelCall, ModelReply } from "./adapter.ts";
import type { Provider, ResolvedModel } from "./panel.ts";
import { ReplyError, buildSystemPrompt, parseReply, userMessage } from "./prompt.ts";

export type { ModelAdapter, ModelCall, ModelReply };

/** A paragraph as the bench judges it, with its ground truth attached. */
export interface BenchDocument {
  readonly id: string;
  readonly kind: "clean" | "seeded";
  /** The one rule a seeded paragraph is positive for. */
  readonly truth?: string;
  readonly text: string;
}

export interface BenchFailure {
  readonly doc: string;
  readonly repeat: number;
  readonly reason: string;
}

export interface BenchLatency {
  readonly medianMs: number;
  readonly p95Ms: number;
  /** How many calls the two numbers above were computed from. */
  readonly samples: number;
}

export interface BenchCost {
  /** Null when the model has no published price. Never zero standing in for that. */
  readonly totalUsd: number | null;
  readonly usdPerDocument: number | null;
  readonly usdPer100Documents: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface BenchModelResult {
  readonly id: string;
  readonly label: string;
  readonly tier: string;
  readonly provider: Provider;
  readonly available: boolean;
  readonly slug: string | null;
  readonly servedModel: string | null;
  readonly jsonMode: boolean;
  readonly prices: ResolvedModel["prices"];
  readonly note?: string;
  readonly calls: number;
  readonly retries: number;
  readonly failures: number;
  /** Replies that were not one JSON object of rule ids. */
  readonly parseFailures: number;
  /** Judgment cells across every repeat that came back with no usable number. */
  readonly unansweredCells: number;
  readonly latency: BenchLatency;
  readonly cost: BenchCost;
  /** From the first repeat only, by the eval scorer, on the eval's definitions. */
  readonly score: ArmScore | null;
  readonly failureDetail: readonly BenchFailure[];
}

export interface RawBenchRecord {
  readonly doc: string;
  readonly kind: "clean" | "seeded";
  readonly truth: string | null;
  readonly reply: string | null;
  readonly readings: Record<string, { flag: boolean; p: number }>;
  readonly unanswered: readonly string[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly latency_ms: number;
  readonly attempts: number;
  readonly error: string | null;
}

export interface RawBenchRun {
  readonly model_id: string;
  readonly label: string;
  readonly tier: string;
  readonly provider: Provider;
  readonly slug: string | null;
  readonly served_model: string | null;
  readonly run_date: string;
  readonly repeat: number;
  readonly json_mode: boolean;
  readonly prices: ResolvedModel["prices"];
  readonly question_ids: readonly string[];
  /** The prompt every model in this run was sent, verbatim. */
  readonly system_prompt: string;
  readonly records: readonly RawBenchRecord[];
}

export interface RunBenchOptions {
  readonly ruleset: Ruleset;
  readonly documents: readonly BenchDocument[];
  readonly resolved: readonly ResolvedModel[];
  readonly adapters: Partial<Record<Provider, ModelAdapter>>;
  readonly repeats: number;
  readonly threshold: number;
  readonly runDate: string;
  /** Defaults to every rule id in the ruleset, in order. */
  readonly classes?: readonly string[];
  /** Called after each model call, so a long run can say where it is. */
  readonly onProgress?: (note: string) => void;
}

export interface BenchOutcome {
  readonly runDate: string;
  readonly repeats: number;
  readonly threshold: number;
  readonly thresholds: readonly number[];
  readonly classes: readonly string[];
  readonly questionIds: readonly string[];
  readonly systemPrompt: string;
  readonly documents: readonly BenchDocument[];
  readonly models: readonly BenchModelResult[];
  readonly raw: readonly RawBenchRun[];
}

export async function runBench(options: RunBenchOptions): Promise<BenchOutcome> {
  const ruleset = options.ruleset;
  const classes = options.classes ?? ruleset.rules.map((rule) => rule.id);
  const thresholds = thresholdsWith(options.threshold);
  const judgment = ruleset.rules.filter(isJudgmentRule);
  const countable = ruleset.rules.filter(isRegexRule);
  const questionIds = judgment.map((rule) => rule.id);
  const systemPrompt = buildSystemPrompt(judgment);
  const repeats = Math.max(1, Math.trunc(options.repeats));

  // The countable arm is the same for every model and every repeat: it is
  // local, free, and deterministic, so it is computed once and shared.
  const regexHits = new Map<string, ReadonlySet<string>>();
  for (const doc of options.documents) {
    const flags = runRegexArm([chunkOf(doc)], ruleset);
    regexHits.set(doc.id, new Set(flags.map((flag) => flag.rule)));
  }

  const states = new Map<string, ModelState>();
  for (const model of options.resolved) {
    states.set(model.entry.id, newState(model, options.adapters[model.entry.provider]));
  }

  const raw: RawBenchRun[] = [];

  for (let repeat = 1; repeat <= repeats; repeat++) {
    const perRepeat = new Map<string, RawBenchRecord[]>();
    for (const model of options.resolved) perRepeat.set(model.entry.id, []);

    for (const [index, doc] of options.documents.entries()) {
      for (const model of rotate(options.resolved, index)) {
        const state = states.get(model.entry.id);
        if (state === undefined || state.adapter === undefined) continue;

        const record = await askOne(state, model, doc, {
          system: systemPrompt,
          questionIds,
          repeat,
        });
        perRepeat.get(model.entry.id)?.push(record);
        options.onProgress?.(
          `${model.entry.id} ${doc.id} repeat ${repeat}${record.error === null ? "" : ` (${record.error})`}`,
        );

        if (repeat === 1) {
          collectObservation(state, model, doc, record, countable, judgment, regexHits);
        }
      }
    }

    for (const model of options.resolved) {
      const records = perRepeat.get(model.entry.id) ?? [];
      if (records.length === 0) continue;
      raw.push({
        model_id: model.entry.id,
        label: model.entry.label,
        tier: model.entry.tier,
        provider: model.entry.provider,
        slug: model.slug,
        served_model: states.get(model.entry.id)?.servedModel ?? null,
        run_date: options.runDate,
        repeat,
        json_mode: model.jsonMode,
        prices: model.prices,
        question_ids: questionIds,
        system_prompt: systemPrompt,
        records,
      });
    }
  }

  const models = options.resolved.map((model) =>
    summarise(model, states.get(model.entry.id), {
      classes,
      thresholds,
      documents: options.documents.length,
    }),
  );

  return {
    runDate: options.runDate,
    repeats,
    threshold: options.threshold,
    thresholds,
    classes,
    questionIds,
    systemPrompt,
    documents: options.documents,
    models,
    raw,
  };
}

// --- one model's running state -------------------------------------------

interface ModelState {
  readonly adapter?: ModelAdapter;
  readonly note?: string;
  servedModel: string | null;
  calls: number;
  retries: number;
  failures: number;
  parseFailures: number;
  unansweredCells: number;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
  usageCalls: number;
  cells: Cell[];
  judged: JudgedDocument[];
  failureDetail: BenchFailure[];
}

function newState(model: ResolvedModel, adapter: ModelAdapter | undefined): ModelState {
  const usable = model.available && adapter !== undefined;
  return {
    ...(usable ? { adapter } : {}),
    ...(model.available || model.note === undefined ? {} : { note: model.note }),
    servedModel: null,
    calls: 0,
    retries: 0,
    failures: 0,
    parseFailures: 0,
    unansweredCells: 0,
    latencies: [],
    inputTokens: 0,
    outputTokens: 0,
    usageCalls: 0,
    cells: [],
    judged: [],
    failureDetail: [],
  };
}

interface AskContext {
  readonly system: string;
  readonly questionIds: readonly string[];
  readonly repeat: number;
}

async function askOne(
  state: ModelState,
  model: ResolvedModel,
  doc: BenchDocument,
  context: AskContext,
): Promise<RawBenchRecord> {
  const call: ModelCall = {
    slug: model.slug ?? model.entry.id,
    system: context.system,
    user: userMessage(doc.text),
    jsonMode: model.jsonMode,
  };

  const blank = {
    doc: doc.id,
    kind: doc.kind,
    truth: doc.truth ?? null,
    readings: {} as Record<string, { flag: boolean; p: number }>,
    unanswered: context.questionIds,
  };

  let answer: ModelReply;
  try {
    answer = await (state.adapter as ModelAdapter).call(call);
  } catch (error) {
    state.calls += 1;
    state.failures += 1;
    const reason = messageOf(error);
    state.failureDetail.push({ doc: doc.id, repeat: context.repeat, reason });
    state.unansweredCells += context.questionIds.length;
    return {
      ...blank,
      reply: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      latency_ms: 0,
      attempts: 0,
      error: reason,
    };
  }

  state.calls += 1;
  state.retries += Math.max(0, answer.attempts - 1);
  state.latencies.push(answer.latencyMs);
  state.inputTokens += answer.inputTokens;
  state.outputTokens += answer.outputTokens;
  state.usageCalls += 1;
  state.servedModel = answer.servedModel;

  const usage = { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens };

  try {
    const parsed = parseReply(answer.text, context.questionIds);
    state.unansweredCells += parsed.missing.length;
    if (parsed.missing.length > 0) {
      state.failureDetail.push({
        doc: doc.id,
        repeat: context.repeat,
        reason: `answered nothing usable for ${parsed.missing.join(", ")}`,
      });
    }
    return {
      doc: doc.id,
      kind: doc.kind,
      truth: doc.truth ?? null,
      reply: answer.text,
      readings: { ...parsed.readings },
      unanswered: parsed.missing,
      usage,
      latency_ms: answer.latencyMs,
      attempts: answer.attempts,
      error: null,
    };
  } catch (error) {
    const reason = error instanceof ReplyError ? error.message : messageOf(error);
    state.parseFailures += 1;
    state.failures += 1;
    state.unansweredCells += context.questionIds.length;
    state.failureDetail.push({ doc: doc.id, repeat: context.repeat, reason });
    return {
      ...blank,
      reply: answer.text,
      usage,
      latency_ms: answer.latencyMs,
      attempts: answer.attempts,
      error: reason,
    };
  }
}

/** Build the first repeat's observation, the one accuracy is scored from. */
function collectObservation(
  state: ModelState,
  model: ResolvedModel,
  doc: BenchDocument,
  record: RawBenchRecord,
  countable: readonly { readonly id: string }[],
  judgment: readonly { readonly id: string }[],
  regexHits: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const hit = regexHits.get(doc.id) ?? new Set<string>();

  for (const rule of countable) {
    state.cells.push({ doc: doc.id, rule: rule.id, probability: hit.has(rule.id) ? 1 : 0, answered: true });
  }

  let unanswered = 0;
  for (const rule of judgment) {
    const reading = record.readings[rule.id];
    if (reading === undefined) {
      unanswered += 1;
      state.cells.push({ doc: doc.id, rule: rule.id, probability: 0, answered: false });
      continue;
    }
    state.cells.push({ doc: doc.id, rule: rule.id, probability: reading.p, answered: true });
  }

  state.judged.push({
    id: doc.id,
    kind: doc.kind,
    ...(doc.truth === undefined ? {} : { truth: doc.truth }),
    text: doc.text,
    latencyMs: record.latency_ms,
    inputTokens: record.usage.input_tokens,
    outputTokens: record.usage.output_tokens,
    costUsd: costOf(record.usage, model.prices),
    requests: 1,
    retries: Math.max(0, record.attempts - 1),
    unanswered,
  });
}

// --- summarising ----------------------------------------------------------

interface SummaryContext {
  readonly classes: readonly string[];
  readonly thresholds: readonly number[];
  readonly documents: number;
}

function summarise(
  model: ResolvedModel,
  state: ModelState | undefined,
  context: SummaryContext,
): BenchModelResult {
  const empty: BenchModelResult = {
    id: model.entry.id,
    label: model.entry.label,
    tier: model.entry.tier,
    provider: model.entry.provider,
    available: model.available,
    slug: model.slug,
    servedModel: null,
    jsonMode: model.jsonMode,
    prices: model.prices,
    ...(model.note === undefined ? {} : { note: model.note }),
    calls: 0,
    retries: 0,
    failures: 0,
    parseFailures: 0,
    unansweredCells: 0,
    latency: { medianMs: 0, p95Ms: 0, samples: 0 },
    cost: {
      totalUsd: model.prices === null ? null : 0,
      usdPerDocument: model.prices === null ? null : 0,
      usdPer100Documents: model.prices === null ? null : 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    score: null,
    failureDetail: [],
  };

  if (state === undefined || state.calls === 0) {
    return state?.note === undefined ? empty : { ...empty, note: state.note };
  }

  const sorted = [...state.latencies].sort((a, b) => a - b);
  const observation: ArmObservation = {
    arm: "D",
    label: model.entry.label,
    network: true,
    documents: state.judged,
    cells: state.cells,
  };

  const usdPerCall =
    model.prices === null || state.usageCalls === 0
      ? null
      : (state.inputTokens * model.prices.inputUsdPerToken +
          state.outputTokens * model.prices.outputUsdPerToken) /
        state.usageCalls;

  return {
    ...empty,
    servedModel: state.servedModel,
    calls: state.calls,
    retries: state.retries,
    failures: state.failures,
    parseFailures: state.parseFailures,
    unansweredCells: state.unansweredCells,
    latency: { medianMs: median(sorted), p95Ms: p95(sorted), samples: sorted.length },
    cost: {
      totalUsd:
        model.prices === null
          ? null
          : state.inputTokens * model.prices.inputUsdPerToken +
            state.outputTokens * model.prices.outputUsdPerToken,
      usdPerDocument: usdPerCall,
      usdPer100Documents: usdPerCall === null ? null : usdPerCall * 100,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    },
    score: state.judged.length === 0 ? null : scoreArm(observation, context.classes, context.thresholds),
    failureDetail: state.failureDetail,
  };
}

// --- pieces ---------------------------------------------------------------

/** The panel, starting at a different model for each document. */
function rotate(models: readonly ResolvedModel[], by: number): readonly ResolvedModel[] {
  if (models.length === 0) return models;
  const at = ((by % models.length) + models.length) % models.length;
  return [...models.slice(at), ...models.slice(0, at)];
}

function chunkOf(doc: BenchDocument): Chunk {
  return { file: doc.id, line: 1, text: doc.text };
}

function costOf(
  usage: { readonly input_tokens: number; readonly output_tokens: number },
  prices: ResolvedModel["prices"],
): number {
  if (prices === null) return 0;
  return usage.input_tokens * prices.inputUsdPerToken + usage.output_tokens * prices.outputUsdPerToken;
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The eval's index, kept identical so the two reports can be read together. */
function p95(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.floor(0.95 * sorted.length) - 1)] ?? 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
