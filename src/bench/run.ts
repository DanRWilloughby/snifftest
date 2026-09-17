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
 * ## Repeats measure both time and agreement
 *
 * Latency is the noisy number, so it is measured over every repeat and reported
 * as a median and a p95. Accuracy was once taken from the first repeat alone,
 * on the argument that temperature zero makes it stable. That argument does not
 * hold: a reasoning model does not honour temperature zero, and a router may
 * send two identical requests to two upstream hosts. Every repeat is therefore
 * scored, the first one carries the detailed tables, and the spread across
 * repeats is printed beside the headline. The readings were already paid for.
 * Cost is averaged over every call that returned usage.
 *
 * ## The decision is the boolean the model was asked for
 *
 * Each model is asked for a `flag` and a `p`. The flag is its own decision and
 * is what the tables score. The verbalised probability is scored beside it, at
 * the same threshold the judgment arm uses, and printed as a second column. A
 * general model is not calibrated, so scoring only its `p` at another model's
 * operating point would measure the wrong thing and flatter the wrong row.
 *
 * ## Nothing is invented
 *
 * A model the provider did not list is never called and never scored: it is a
 * row that says so. A torn reply is a counted failure and a set of unanswered
 * cells. A model with no published price has no cost, not a zero.
 *
 * ## The rows were not sent identical requests
 *
 * They cannot be. A reasoning model spends its internal tokens out of the same
 * completion budget as its answer, so one budget for every row hands the deep
 * rows a smaller answer and cuts some of them off before the JSON. Each row
 * therefore carries the budget and the reasoning setting its panel entry
 * declares, both of them recorded here and printed under the tables. A reply
 * that stopped at the budget is counted as truncated rather than as a torn
 * reply, because the first is the run's doing and the second is the model's.
 */

import { classifyChunk, runRegexArm } from "../engine.ts";
import type { ArmObservation, ArmScore, Cell, JudgedDocument } from "../eval/score.ts";
import { scoreArm, thresholdsWith } from "../eval/score.ts";
import { type Chunk, type Ruleset, isJudgmentRule, isRegexRule } from "../types.ts";
import type { ModelAdapter, ModelCall, ModelReply } from "./adapter.ts";
import type { Provider, ReasoningSetting, ResolvedModel } from "./panel.ts";
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
  /** A paragraph, which is one call: the corpus unit, never a whole file. */
  readonly usdPerParagraph: number | null;
  readonly usdPer100Paragraphs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** What a row was actually sent, so the tables can say the rows differ and why. */
export interface RequestSettings {
  readonly maxTokens: number;
  readonly reasoning: ReasoningSetting | null;
}

/** One repeat's headline numbers, so agreement across repeats can be printed. */
export interface BenchRepeatScore {
  readonly repeat: number;
  readonly recall: number | null;
  readonly fpCleanParagraphs: number;
  readonly cleanParagraphs: number;
}

/**
 * How much a row moved between repeats.
 *
 * A single run of a model is one sample of it. Printing that sample as the
 * model's recall, with no sense of how far the next run would sit from it, is
 * the part of a bench a skeptic is right to distrust.
 */
export interface BenchSpread {
  readonly repeats: number;
  readonly meanRecall: number | null;
  readonly minRecall: number | null;
  readonly maxRecall: number | null;
  readonly perRepeat: readonly BenchRepeatScore[];
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
  /** The budget and reasoning setting this row's requests carried. */
  readonly request: RequestSettings;
  readonly calls: number;
  readonly retries: number;
  readonly failures: number;
  /** Replies that were not one JSON object of rule ids. */
  readonly parseFailures: number;
  /**
   * Replies that stopped at the completion budget before they were whole.
   *
   * Counted apart from a parse failure because the two say different things: a
   * malformed reply is the model answering badly, and a truncated one is the
   * run not giving it room to answer at all. Both leave the cells unanswered.
   */
  readonly truncated: number;
  /** Judgment cells across every repeat that came back with no usable number. */
  readonly unansweredCells: number;
  /**
   * The same count, split by rule.
   *
   * The per-rule tables need this: printing the row's total under every rule's
   * "Unanswered" column says a rule was unanswered when another one was.
   */
  readonly unansweredByRule: Readonly<Record<string, number>>;
  readonly latency: BenchLatency;
  readonly cost: BenchCost;
  /**
   * The first repeat, scored on the model's own `flag`, by the eval scorer.
   *
   * This is the row's decision: the boolean it was asked for, not a threshold
   * applied to a number it was not asked to calibrate.
   */
  readonly score: ArmScore | null;
  /** The same repeat scored on the verbalised `p` at the shipped threshold. */
  readonly scoreVerbalised: ArmScore | null;
  /** Every repeat, scored the same way, so the headline can carry a spread. */
  readonly spread: BenchSpread;
  readonly failureDetail: readonly BenchFailure[];
}

export interface RawBenchRecord {
  readonly doc: string;
  readonly kind: "clean" | "seeded";
  readonly truth: string | null;
  readonly reply: string | null;
  readonly readings: Record<string, { flag: boolean; p: number }>;
  readonly unanswered: readonly string[];
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly reasoning_tokens: number;
  };
  /** The provider's own word for why it stopped, verbatim. */
  readonly finish_reason: string | null;
  readonly truncated: boolean;
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
  /** Exactly what this row's requests asked for, beside the answers they got. */
  readonly request: { readonly max_tokens: number; readonly reasoning: ReasoningSetting | null };
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

        const record = await askOne(state, state.adapter, model, doc, {
          system: systemPrompt,
          questionIds,
          repeat,
        });
        perRepeat.get(model.entry.id)?.push(record);
        options.onProgress?.(
          `${model.entry.id} ${doc.id} repeat ${repeat}${record.error === null ? "" : ` (${record.error})`}`,
        );

        collectObservation(state, model, doc, record, countable, judgment, regexHits, repeat);
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
        request: {
          max_tokens: model.entry.maxTokens,
          reasoning: model.entry.reasoning ?? null,
        },
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
      threshold: options.threshold,
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

/** One repeat's cells, kept apart so every repeat can be scored on its own. */
interface RepeatObservation {
  /** Scored on the model's own boolean. This is the row's decision. */
  readonly flagCells: Cell[];
  /** The same cells scored on the verbalised probability, for the second column. */
  readonly verbalisedCells: Cell[];
  readonly judged: JudgedDocument[];
}

interface ModelState {
  readonly adapter?: ModelAdapter;
  readonly note?: string;
  servedModel: string | null;
  calls: number;
  retries: number;
  failures: number;
  parseFailures: number;
  truncated: number;
  unansweredCells: number;
  unansweredByRule: Map<string, number>;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
  usageCalls: number;
  observations: Map<number, RepeatObservation>;
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
    truncated: 0,
    unansweredCells: 0,
    unansweredByRule: new Map(),
    latencies: [],
    inputTokens: 0,
    outputTokens: 0,
    usageCalls: 0,
    observations: new Map(),
    failureDetail: [],
  };
}

/** Count an unanswered cell against the rule it belonged to, not only the row. */
function markUnanswered(state: ModelState, ruleIds: readonly string[]): void {
  state.unansweredCells += ruleIds.length;
  for (const id of ruleIds) state.unansweredByRule.set(id, (state.unansweredByRule.get(id) ?? 0) + 1);
}

function observationFor(state: ModelState, repeat: number): RepeatObservation {
  const existing = state.observations.get(repeat);
  if (existing !== undefined) return existing;
  const fresh: RepeatObservation = { flagCells: [], verbalisedCells: [], judged: [] };
  state.observations.set(repeat, fresh);
  return fresh;
}

interface AskContext {
  readonly system: string;
  readonly questionIds: readonly string[];
  readonly repeat: number;
}

async function askOne(
  state: ModelState,
  adapter: ModelAdapter,
  model: ResolvedModel,
  doc: BenchDocument,
  context: AskContext,
): Promise<RawBenchRecord> {
  const settings = settingsOf(model);
  const call: ModelCall = {
    slug: model.slug ?? model.entry.id,
    system: context.system,
    user: userMessage(doc.text),
    jsonMode: model.jsonMode,
    maxTokens: settings.maxTokens,
    ...(settings.reasoning === null ? {} : { reasoning: settings.reasoning }),
  };

  const readings: Record<string, { flag: boolean; p: number }> = {};
  const blank = {
    doc: doc.id,
    kind: doc.kind,
    truth: doc.truth ?? null,
    readings,
    unanswered: context.questionIds,
  };

  let answer: ModelReply;
  try {
    answer = await adapter.call(call);
  } catch (error) {
    state.calls += 1;
    state.failures += 1;
    const reason = messageOf(error);
    state.failureDetail.push({ doc: doc.id, repeat: context.repeat, reason });
    markUnanswered(state, context.questionIds);
    return {
      ...blank,
      reply: null,
      usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
      finish_reason: null,
      truncated: false,
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

  const usage = {
    input_tokens: answer.inputTokens,
    output_tokens: answer.outputTokens,
    reasoning_tokens: answer.reasoningTokens,
  };

  try {
    const parsed = parseReply(answer.text, context.questionIds);
    markUnanswered(state, parsed.missing);
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
      finish_reason: answer.finishReason,
      truncated: answer.truncated,
      latency_ms: answer.latencyMs,
      attempts: answer.attempts,
      error: null,
    };
  } catch (error) {
    // A reply that stopped at the budget is counted apart from a torn one. Both
    // leave the cells unanswered, and only one of them is about the model.
    const reason = answer.truncated
      ? `the reply stopped at the ${call.maxTokens}-token budget before it was a whole JSON object`
      : error instanceof ReplyError
        ? error.message
        : messageOf(error);
    if (answer.truncated) state.truncated += 1;
    else state.parseFailures += 1;
    state.failures += 1;
    markUnanswered(state, context.questionIds);
    state.failureDetail.push({ doc: doc.id, repeat: context.repeat, reason });
    return {
      ...blank,
      reply: answer.text,
      usage,
      finish_reason: answer.finishReason,
      truncated: answer.truncated,
      latency_ms: answer.latencyMs,
      attempts: answer.attempts,
      error: reason,
    };
  }
}

/** What a row's requests carry, from its panel entry. */
function settingsOf(model: ResolvedModel): RequestSettings {
  return {
    maxTokens: model.entry.maxTokens,
    reasoning: model.entry.reasoning ?? null,
  };
}

/**
 * Build one repeat's observation, in both readings of the same reply.
 *
 * The flag cells carry the model's own boolean as a 1 or a 0, so every
 * threshold in the sweep reads the same decision: a boolean does not move when
 * the operating point does, and pretending otherwise would put a fake curve
 * through one point. The verbalised cells carry the probability the model
 * wrote, which the sweep does move over.
 */
function collectObservation(
  state: ModelState,
  model: ResolvedModel,
  doc: BenchDocument,
  record: RawBenchRecord,
  countable: readonly { readonly id: string }[],
  judgment: readonly { readonly id: string }[],
  regexHits: ReadonlyMap<string, ReadonlySet<string>>,
  repeat: number,
): void {
  const hit = regexHits.get(doc.id) ?? new Set<string>();
  const into = observationFor(state, repeat);

  for (const rule of countable) {
    const cell: Cell = {
      doc: doc.id,
      rule: rule.id,
      probability: hit.has(rule.id) ? 1 : 0,
      answered: true,
    };
    into.flagCells.push(cell);
    into.verbalisedCells.push(cell);
  }

  let unanswered = 0;
  for (const rule of judgment) {
    const reading = record.readings[rule.id];
    if (reading === undefined) {
      unanswered += 1;
      const missing: Cell = { doc: doc.id, rule: rule.id, probability: 0, answered: false };
      into.flagCells.push(missing);
      into.verbalisedCells.push(missing);
      continue;
    }
    into.flagCells.push({
      doc: doc.id,
      rule: rule.id,
      probability: reading.flag ? 1 : 0,
      answered: true,
    });
    into.verbalisedCells.push({ doc: doc.id, rule: rule.id, probability: reading.p, answered: true });
  }

  into.judged.push({
    id: doc.id,
    kind: doc.kind,
    ...(doc.truth === undefined ? {} : { truth: doc.truth }),
    text: doc.text,
    latencyMs: record.latency_ms,
    inputTokens: record.usage.input_tokens,
    outputTokens: record.usage.output_tokens,
    usageReported: true,
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
  /** The shipped operating point, the one the headline and the spread read. */
  readonly threshold: number;
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
    request: settingsOf(model),
    calls: 0,
    retries: 0,
    failures: 0,
    parseFailures: 0,
    truncated: 0,
    unansweredCells: 0,
    unansweredByRule: {},
    latency: { medianMs: 0, p95Ms: 0, samples: 0 },
    cost: {
      totalUsd: model.prices === null ? null : 0,
      usdPerParagraph: model.prices === null ? null : 0,
      usdPer100Paragraphs: model.prices === null ? null : 0,
      inputTokens: 0,
      outputTokens: 0,
    },
    score: null,
    scoreVerbalised: null,
    spread: { repeats: 0, meanRecall: null, minRecall: null, maxRecall: null, perRepeat: [] },
    failureDetail: [],
  };

  if (state === undefined || state.calls === 0) {
    return state?.note === undefined ? empty : { ...empty, note: state.note };
  }

  const sorted = [...state.latencies].sort((a, b) => a - b);
  const repeats = [...state.observations.keys()].sort((a, b) => a - b);
  const first = repeats[0];
  const firstObservation = first === undefined ? undefined : state.observations.get(first);
  const at = String(context.threshold);

  const perRepeat: BenchRepeatScore[] = [];
  for (const repeat of repeats) {
    const held = state.observations.get(repeat);
    if (held === undefined || held.judged.length === 0) continue;
    const scored = scoreArm(
      armOf(model, held.judged, held.flagCells),
      context.classes,
      context.thresholds,
    ).overall[at];
    perRepeat.push({
      repeat,
      recall: scored?.recall ?? null,
      fpCleanParagraphs: scored?.fp_clean_paragraphs ?? 0,
      cleanParagraphs: scored?.clean_paragraphs ?? 0,
    });
  }
  const recalls = perRepeat
    .map((row) => row.recall)
    .filter((value): value is number => value !== null);

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
    truncated: state.truncated,
    unansweredCells: state.unansweredCells,
    unansweredByRule: Object.fromEntries(state.unansweredByRule),
    latency: { medianMs: median(sorted), p95Ms: p95(sorted), samples: sorted.length },
    cost: {
      totalUsd:
        model.prices === null
          ? null
          : state.inputTokens * model.prices.inputUsdPerToken +
            state.outputTokens * model.prices.outputUsdPerToken,
      usdPerParagraph: usdPerCall,
      usdPer100Paragraphs: usdPerCall === null ? null : usdPerCall * 100,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
    },
    score:
      firstObservation === undefined || firstObservation.judged.length === 0
        ? null
        : scoreArm(
            armOf(model, firstObservation.judged, firstObservation.flagCells),
            context.classes,
            context.thresholds,
          ),
    scoreVerbalised:
      firstObservation === undefined || firstObservation.judged.length === 0
        ? null
        : scoreArm(
            armOf(model, firstObservation.judged, firstObservation.verbalisedCells),
            context.classes,
            context.thresholds,
          ),
    spread: {
      repeats: perRepeat.length,
      meanRecall: recalls.length === 0 ? null : recalls.reduce((a, b) => a + b, 0) / recalls.length,
      minRecall: recalls.length === 0 ? null : Math.min(...recalls),
      maxRecall: recalls.length === 0 ? null : Math.max(...recalls),
      perRepeat,
    },
    failureDetail: state.failureDetail,
  };
}

/** One repeat's cells in the shape the eval's own scorer reads. */
function armOf(
  model: ResolvedModel,
  documents: readonly JudgedDocument[],
  cells: readonly Cell[],
): ArmObservation {
  return { arm: "D", label: model.entry.label, network: true, documents, cells };
}

// --- pieces ---------------------------------------------------------------

/** The panel, starting at a different model for each document. */
function rotate(models: readonly ResolvedModel[], by: number): readonly ResolvedModel[] {
  if (models.length === 0) return models;
  const at = ((by % models.length) + models.length) % models.length;
  return [...models.slice(at), ...models.slice(0, at)];
}

function chunkOf(doc: BenchDocument): Chunk {
  return { file: doc.id, line: 1, text: doc.text, kind: classifyChunk(doc.text, 1) };
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
