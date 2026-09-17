/**
 * Running the same corpus three ways.
 *
 * Arm A is no tool at all, the zero baseline: it flags nothing, costs nothing,
 * and exists so that every other row has something to be better than. Nothing
 * is invented for a human baseline, because nobody measured one.
 *
 * Arm B is the countable rules only. No network, and the same code path the
 * product's `--dry-run` uses, so the arm measures what a user would actually
 * get offline rather than a special eval-only checker.
 *
 * Arm C is the countable rules plus the judgment model, which is the shipped
 * product. Its cost and latency come back from the gateway per request and are
 * recorded per document; nothing here estimates either.
 *
 * Arms A and B run first and always. If no client is supplied the run stops
 * after them, which is what `--dry-run` is: a seeded corpus and two arms, with
 * nothing sent.
 */

import { classifyChunk, runRegexArm } from "../engine.ts";
import { questionsFromRules, type JevClient } from "../jev.ts";
import { type Chunk, type Ruleset, isJudgmentRule, isRegexRule } from "../types.ts";
import {
  type BaseDocument,
  type SeedCorpusResult,
  type SeedOptions,
  seedCorpus,
} from "./seed.ts";
import {
  type ArmObservation,
  type ArmScore,
  type Cell,
  type JudgedDocument,
  type ScoreFacts,
  scoreAll,
  thresholdsWith,
} from "./score.ts";

/** One document as it is judged: a paragraph with its ground truth attached. */
export interface EvalDocument {
  readonly id: string;
  readonly kind: "clean" | "seeded";
  readonly truth?: string;
  readonly text: string;
  readonly source: string;
}

/** The recorded shape, deliberately the spike's, so the two can be diffed. */
export interface RawRecord {
  readonly id: string;
  readonly kind: "clean" | "seeded";
  readonly truth: string | null;
  readonly model: string;
  readonly nouls: Record<string, number>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly latency_s: number;
  readonly attempts: number;
  readonly estimated_cost_usd: number;
  readonly error: string | null;
}

export interface RawRun {
  readonly model: string;
  readonly endpoint_model_requested: string;
  readonly question_ids: readonly string[];
  readonly usd_per_input_token: number;
  readonly records: readonly RawRecord[];
}

export interface RunEvalOptions extends SeedOptions {
  readonly ruleset: Ruleset;
  readonly candidates: readonly BaseDocument[];
  /** Absent means no network: arms A and B only. */
  readonly client?: JevClient;
  readonly threshold?: number;
  /** Injected in tests so a measured millisecond is not a flaky one. */
  readonly now?: () => number;
}

export interface EvalOutcome {
  readonly seeding: SeedCorpusResult;
  readonly documents: readonly EvalDocument[];
  readonly classes: readonly string[];
  readonly thresholds: readonly number[];
  readonly observations: readonly ArmObservation[];
  readonly scores: Record<string, ArmScore>;
  readonly raw?: RawRun;
  /** Failures, counted and carried, never swallowed. */
  readonly failures: readonly { readonly doc: string; readonly reason: string }[];
}

const MODEL_REQUESTED = "jev-latest";
const USD_PER_INPUT_TOKEN = 0.042e-6;

export async function runEval(options: RunEvalOptions): Promise<EvalOutcome> {
  const ruleset = options.ruleset;
  const classes = ruleset.rules.map((rule) => rule.id);
  const thresholds = thresholdsWith(options.threshold ?? ruleset.threshold ?? 0.7);
  const now = options.now ?? (() => Date.now());

  const seeding = seedCorpus(options.candidates, ruleset, {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.perRule === undefined ? {} : { perRule: options.perRule }),
    ...(options.seedVersion === undefined ? {} : { seedVersion: options.seedVersion }),
    ...(options.bank === undefined ? {} : { bank: options.bank }),
  });

  const documents: EvalDocument[] = [
    ...seeding.clean.map((doc) => ({
      id: doc.id,
      kind: "clean" as const,
      text: doc.text,
      source: `${doc.file}:${doc.line}`,
    })),
    // A hard negative is a clean paragraph with a near miss in it. It is
    // positive for nothing, so any flag on it is a false positive, which is
    // exactly the question it was written to ask.
    ...seeding.negatives.map((doc) => ({
      id: doc.id,
      kind: "clean" as const,
      text: doc.text,
      source: `${doc.base_file} near miss for ${doc.rule}`,
    })),
    ...seeding.seeded.map((doc) => ({
      id: doc.id,
      kind: "seeded" as const,
      truth: doc.rule,
      text: doc.text,
      source: `${doc.base_file} seeded from ${doc.base_id}`,
    })),
  ];

  const facts = factsFor(ruleset);
  const observations: ArmObservation[] = [armA(documents, classes), armB(documents, ruleset, now)];
  const failures: { doc: string; reason: string }[] = [];
  let raw: RawRun | undefined;

  if (options.client !== undefined) {
    const judged = await armC(documents, ruleset, options.client, now);
    observations.push(judged.observation);
    raw = judged.raw;
    failures.push(...judged.failures);
  }

  return {
    seeding,
    documents,
    classes,
    thresholds,
    observations,
    scores: scoreAll(observations, classes, thresholds, facts),
    ...(raw === undefined ? {} : { raw }),
    failures,
  };
}

/**
 * What the seeder guaranteed, so the scorer does not read it as skill.
 *
 * Two facts come out of `seedCorpus`. A clean base that the countable arm
 * flagged is dropped, so no countable rule can fire on the clean set at all.
 * And a countable seed the rule does not catch is refused, so every countable
 * positive is one the pattern already matched. Both are honest ways to build a
 * corpus and dishonest numbers if they are not said out loud.
 */
export function factsFor(ruleset: Ruleset): ScoreFacts {
  const countable = ruleset.rules.filter(isRegexRule);
  const inert: Record<string, string> = {};
  for (const rule of countable) {
    inert[rule.id] = "clean paragraphs were pre-filtered to pass this rule";
  }
  for (const rule of countable) {
    if (rule.source === "builtin" && (rule.words ?? []).length === 0 && rule.builtin === "banned_words") {
      inert[rule.id] = "its word list is empty, so it cannot fire on anything";
    }
  }
  return {
    countable: countable.map((rule) => rule.id),
    judgment: ruleset.rules.filter(isJudgmentRule).map((rule) => rule.id),
    guaranteed: countable.map((rule) => rule.id),
    inertOnClean: inert,
  };
}

// --- arm A ----------------------------------------------------------------

function armA(documents: readonly EvalDocument[], classes: readonly string[]): ArmObservation {
  return {
    arm: "A",
    label: "A (no tool)",
    network: false,
    documents: documents.map((doc) => zeroDocument(doc)),
    cells: documents.flatMap((doc) =>
      classes.map((rule) => ({ doc: doc.id, rule, probability: 0, answered: true })),
    ),
  };
}

// --- arm B ----------------------------------------------------------------

function armB(
  documents: readonly EvalDocument[],
  ruleset: Ruleset,
  now: () => number,
): ArmObservation {
  const countable = ruleset.rules.filter(isRegexRule).map((rule) => rule.id);
  const judgment = ruleset.rules.filter(isJudgmentRule).map((rule) => rule.id);
  const cells: Cell[] = [];
  const judged: JudgedDocument[] = [];

  for (const doc of documents) {
    const started = now();
    const flags = runRegexArm([chunkOf(doc)], ruleset);
    const elapsed = now() - started;
    const hit = new Set(flags.map((flag) => flag.rule));

    for (const rule of countable) {
      cells.push({ doc: doc.id, rule, probability: hit.has(rule) ? 1 : 0, answered: true });
    }
    // A judgment rule is a rule this arm has no opinion about. It is recorded
    // as unanswered, which the scorer counts as a miss rather than a zero the
    // arm claimed, and it is what makes arm B's judgment recall honestly nil.
    for (const rule of judgment) {
      cells.push({ doc: doc.id, rule, probability: 0, answered: false });
    }

    judged.push({ ...zeroDocument(doc), latencyMs: elapsed });
  }

  return { arm: "B", label: "B (countable rules only)", network: false, documents: judged, cells };
}

// --- arm C ----------------------------------------------------------------

interface ArmCResult {
  readonly observation: ArmObservation;
  readonly raw: RawRun;
  readonly failures: readonly { readonly doc: string; readonly reason: string }[];
}

async function armC(
  documents: readonly EvalDocument[],
  ruleset: Ruleset,
  client: JevClient,
  now: () => number,
): Promise<ArmCResult> {
  const countable = ruleset.rules.filter(isRegexRule);
  const judgment = ruleset.rules.filter(isJudgmentRule);
  const questions = questionsFromRules(judgment);

  const cells: Cell[] = [];
  const judged: JudgedDocument[] = [];
  const records: RawRecord[] = [];
  const failures: { doc: string; reason: string }[] = [];
  let servedModel = MODEL_REQUESTED;

  for (const doc of documents) {
    const started = now();
    const flags = runRegexArm([chunkOf(doc)], ruleset);
    const hit = new Set(flags.map((flag) => flag.rule));
    for (const rule of countable) {
      cells.push({ doc: doc.id, rule: rule.id, probability: hit.has(rule.id) ? 1 : 0, answered: true });
    }

    let nouls: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let latencyMs = 0;
    let attempts = 0;
    let usageReported = true;
    let error: string | null = null;

    if (judgment.length > 0) {
      try {
        const answer = await client.ask({ state: doc.text, questions });
        nouls = { ...answer.nouls };
        inputTokens = answer.inputTokens;
        outputTokens = answer.outputTokens;
        costUsd = answer.estimatedCostUsd;
        latencyMs = answer.latencyMs;
        attempts = answer.attempts;
        usageReported = answer.usageReported;
        servedModel = answer.model;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        latencyMs = now() - started;
        attempts = 1;
        failures.push({ doc: doc.id, reason: error });
      }
    }

    let unanswered = 0;
    for (const rule of judgment) {
      const probability = nouls[rule.id];
      if (probability === undefined) {
        unanswered += 1;
        cells.push({ doc: doc.id, rule: rule.id, probability: 0, answered: false });
        continue;
      }
      cells.push({ doc: doc.id, rule: rule.id, probability, answered: true });
    }

    judged.push({
      id: doc.id,
      kind: doc.kind,
      ...(doc.truth === undefined ? {} : { truth: doc.truth }),
      text: doc.text,
      latencyMs,
      inputTokens,
      outputTokens,
      costUsd,
      requests: judgment.length > 0 ? 1 : 0,
      retries: Math.max(0, attempts - 1),
      unanswered,
      usageReported,
    });

    records.push({
      id: doc.id,
      kind: doc.kind,
      truth: doc.truth ?? null,
      model: servedModel,
      nouls,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      latency_s: Math.round(latencyMs) / 1000,
      attempts,
      estimated_cost_usd: costUsd,
      error,
    });
  }

  return {
    observation: {
      arm: "C",
      label: "C (countable rules plus judgment)",
      network: true,
      documents: judged,
      cells,
    },
    raw: {
      model: servedModel,
      endpoint_model_requested: MODEL_REQUESTED,
      question_ids: judgment.map((rule) => rule.id),
      usd_per_input_token: USD_PER_INPUT_TOKEN,
      records,
    },
    failures,
  };
}

// --- shared ---------------------------------------------------------------

function chunkOf(doc: EvalDocument): Chunk {
  // A document here is one standalone block, so it is classified as one: a
  // corpus of headings and tables measures what `check` would do to them only
  // if the arms see the same kinds `check` sees.
  return { file: doc.id, line: 1, text: doc.text, kind: classifyChunk(doc.text, 1) };
}

function zeroDocument(doc: EvalDocument): JudgedDocument {
  return {
    id: doc.id,
    kind: doc.kind,
    ...(doc.truth === undefined ? {} : { truth: doc.truth }),
    text: doc.text,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    requests: 0,
    retries: 0,
    unanswered: 0,
    // An arm that makes no request has nothing to report usage for, and its
    // zero cost is a measurement rather than a missing one.
    usageReported: true,
  };
}
