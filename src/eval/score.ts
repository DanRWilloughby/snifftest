/**
 * Turning an arm's answers into numbers, by the spike's definitions.
 *
 * This is a port of `score.py` from the T1 writing-checks spike, generalised
 * from that spike's seventeen fixed classes to whatever rule ids a ruleset
 * carries. The definitions are kept identical on purpose: the numbers this
 * produces have to be readable against the ones already published, and a
 * benchmark whose definitions drift between runs measures nothing.
 *
 * ## Ground truth
 *
 * A clean paragraph is negative for every rule. A seeded paragraph is positive
 * for its own rule and negative for every other one. That is the whole of it,
 * and it is what makes an off-rule hit on a seeded paragraph a false positive
 * rather than a catch: recall only ever counts the cell a paragraph was seeded
 * for.
 *
 * ## Two false-positive rates, both reported
 *
 * `fp_rate_per_clean_cell` is the spike's figure and is comparable with the
 * published table: false flags on clean paragraphs, over clean cells.
 * `fp_rate_per_negative_cell` also counts off-rule flags on seeded paragraphs,
 * which is the stricter reading. Neither replaces the other and both are in the
 * output, because picking the flattering one is how a bench stops being one.
 *
 * ## Nothing is invented
 *
 * Latency and cost come from what the run recorded. An arm that makes no call
 * has a cost of exactly zero, which is a measurement rather than an estimate. A
 * rule the service did not answer is counted as unanswered and as a miss, never
 * quietly scored as a zero the model did not give.
 */

/**
 * `D` is the panel bench (`src/bench/run.ts`): one arm id per panel model would
 * make the type say something it cannot check, and the model is named by the
 * observation's label instead.
 */
export type ArmId = "A" | "B" | "C" | "D";

/** The spike's sweep. A ruleset's own threshold is added to it when it differs. */
export const THRESHOLDS: readonly number[] = [0.5, 0.7, 0.9];

/** One document as an arm saw it, with what that document cost to judge. */
export interface JudgedDocument {
  readonly id: string;
  readonly kind: "clean" | "seeded";
  /** The rule a seeded document is positive for. */
  readonly truth?: string;
  readonly text: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly requests: number;
  readonly retries: number;
  /** Rules this arm asked about and got no number for. */
  readonly unanswered: number;
}

/** One (document, rule) cell: the probability an arm gave it. */
export interface Cell {
  readonly doc: string;
  readonly rule: string;
  readonly probability: number;
  /** False when the arm gave no opinion; such a cell is a miss, not a zero. */
  readonly answered: boolean;
}

export interface ArmObservation {
  readonly arm: ArmId;
  readonly label: string;
  /** Whether this arm made any network call at all. */
  readonly network: boolean;
  readonly documents: readonly JudgedDocument[];
  readonly cells: readonly Cell[];
}

export interface RuleScoreAtThreshold {
  readonly recall: number | null;
  readonly hits: number;
  readonly fp_rate_clean: number | null;
  readonly fps: number;
}

export interface RuleScore {
  readonly n_positive: number;
  readonly n_clean: number;
  /** Keyed by the threshold as it is written, so `at["0.7"]` is the spike's row. */
  readonly at: Record<string, RuleScoreAtThreshold>;
}

export interface OverallAtThreshold {
  readonly recall: number | null;
  readonly hits: number;
  readonly positives: number;
  readonly fp_rate_per_clean_cell: number | null;
  readonly fp_cells: number;
  readonly clean_cells: number;
  readonly fp_clean_documents_with_any_flag: number | null;
  readonly off_rule_flags: number;
  readonly off_rule_flags_on_seeded_cells: number | null;
  readonly fp_rate_per_negative_cell: number | null;
}

export interface CalibrationBucket {
  readonly n: number;
  readonly defective: number;
  readonly fraction_defective: number | null;
}

export interface ArmSummary {
  readonly documents: number;
  readonly clean: number;
  readonly seeded: number;
  readonly requests: number;
  readonly retries: number;
  readonly unanswered: number;
  readonly median_latency_ms: number;
  readonly p95_latency_ms: number;
  readonly ms_per_document: number;
  readonly ms_per_100_documents: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly usd_total: number;
  readonly usd_per_document: number;
  readonly usd_per_100_documents: number;
}

export interface GalleryRow {
  readonly doc: string;
  readonly rule: string;
  readonly probability: number;
  readonly text: string;
}

export interface ArmScore {
  readonly arm: ArmId;
  readonly label: string;
  readonly network: boolean;
  readonly summary: ArmSummary;
  readonly overall: Record<string, OverallAtThreshold>;
  readonly per_rule: Record<string, RuleScore>;
  readonly calibration: Record<string, CalibrationBucket>;
  readonly misses_at_0_7: readonly GalleryRow[];
  readonly false_positives_at_0_7: readonly GalleryRow[];
}

/** The gallery threshold, the spike's operating point. */
export const GALLERY_THRESHOLD = 0.7;

export function scoreArm(
  observation: ArmObservation,
  classes: readonly string[],
  thresholds: readonly number[] = THRESHOLDS,
): ArmScore {
  const clean = observation.documents.filter((doc) => doc.kind === "clean");
  const seeded = observation.documents.filter((doc) => doc.kind === "seeded");
  const cells = new Map<string, Cell>();
  for (const cell of observation.cells) cells.set(key(cell.doc, cell.rule), cell);

  const read = (doc: string, rule: string): number => cells.get(key(doc, rule))?.probability ?? 0;

  // --- per rule
  const perRule: Record<string, RuleScore> = {};
  for (const rule of classes) {
    const positives = seeded.filter((doc) => doc.truth === rule);
    const at: Record<string, RuleScoreAtThreshold> = {};
    for (const threshold of thresholds) {
      const hits = positives.filter((doc) => read(doc.id, rule) >= threshold).length;
      const fps = clean.filter((doc) => read(doc.id, rule) >= threshold).length;
      at[label(threshold)] = {
        recall: ratio(hits, positives.length),
        hits,
        fp_rate_clean: ratio(fps, clean.length),
        fps,
      };
    }
    perRule[rule] = { n_positive: positives.length, n_clean: clean.length, at };
  }

  // --- overall
  const overall: Record<string, OverallAtThreshold> = {};
  for (const threshold of thresholds) {
    const hits = seeded.filter((doc) => read(doc.id, doc.truth ?? "") >= threshold).length;
    const fpCells = clean.reduce(
      (sum, doc) => sum + classes.filter((rule) => read(doc.id, rule) >= threshold).length,
      0,
    );
    const fpDocs = clean.filter((doc) =>
      classes.some((rule) => read(doc.id, rule) >= threshold),
    ).length;
    const offRule = seeded.reduce(
      (sum, doc) =>
        sum +
        classes.filter((rule) => rule !== doc.truth && read(doc.id, rule) >= threshold).length,
      0,
    );

    const cleanCells = clean.length * classes.length;
    const seededOffCells = seeded.length * Math.max(0, classes.length - 1);

    overall[label(threshold)] = {
      recall: ratio(hits, seeded.length),
      hits,
      positives: seeded.length,
      fp_rate_per_clean_cell: ratio(fpCells, cleanCells),
      fp_cells: fpCells,
      clean_cells: cleanCells,
      fp_clean_documents_with_any_flag: ratio(fpDocs, clean.length),
      off_rule_flags: offRule,
      off_rule_flags_on_seeded_cells: ratio(offRule, seededOffCells),
      fp_rate_per_negative_cell: ratio(fpCells + offRule, cleanCells + seededOffCells),
    };
  }

  // --- calibration over every cell
  const calibration: Record<string, CalibrationBucket> = {};
  const counts = new Map<string, { n: number; defective: number }>();
  for (let i = 0; i < 10; i++) counts.set(bucketName(i), { n: 0, defective: 0 });
  for (const doc of observation.documents) {
    for (const rule of classes) {
      const value = read(doc.id, rule);
      const bucket = counts.get(bucketName(Math.min(Math.floor(value * 10), 9)));
      if (bucket === undefined) continue;
      bucket.n += 1;
      if (doc.kind === "seeded" && doc.truth === rule) bucket.defective += 1;
    }
  }
  for (const [name, bucket] of counts) {
    calibration[name] = {
      n: bucket.n,
      defective: bucket.defective,
      fraction_defective: ratio(bucket.defective, bucket.n),
    };
  }

  // --- galleries at the operating point
  const misses: GalleryRow[] = seeded
    .filter((doc) => read(doc.id, doc.truth ?? "") < GALLERY_THRESHOLD)
    .map((doc) => ({
      doc: doc.id,
      rule: doc.truth ?? "",
      probability: read(doc.id, doc.truth ?? ""),
      text: doc.text,
    }))
    .sort((a, b) => a.probability - b.probability);

  const falsePositives: GalleryRow[] = clean
    .flatMap((doc) =>
      classes
        .filter((rule) => read(doc.id, rule) >= GALLERY_THRESHOLD)
        .map((rule) => ({ doc: doc.id, rule, probability: read(doc.id, rule), text: doc.text })),
    )
    .sort((a, b) => b.probability - a.probability);

  return {
    arm: observation.arm,
    label: observation.label,
    network: observation.network,
    summary: summarise(observation.documents),
    overall,
    per_rule: perRule,
    calibration,
    misses_at_0_7: misses,
    false_positives_at_0_7: falsePositives,
  };
}

/** Score every arm of one run against one set of rule ids. */
export function scoreAll(
  observations: readonly ArmObservation[],
  classes: readonly string[],
  thresholds: readonly number[] = THRESHOLDS,
): Record<string, ArmScore> {
  const out: Record<string, ArmScore> = {};
  for (const observation of observations) {
    out[observation.arm] = scoreArm(observation, classes, thresholds);
  }
  return out;
}

/** The sweep, with the shipped threshold folded in when it is not already there. */
export function thresholdsWith(threshold: number): number[] {
  const all = [...THRESHOLDS];
  if (!all.includes(threshold)) all.push(threshold);
  return all.sort((a, b) => a - b);
}

// --- pieces ---------------------------------------------------------------

function summarise(documents: readonly JudgedDocument[]): ArmSummary {
  const latencies = documents.map((doc) => doc.latencyMs).sort((a, b) => a - b);
  const total = (pick: (doc: JudgedDocument) => number): number =>
    documents.reduce((sum, doc) => sum + pick(doc), 0);

  const count = Math.max(1, documents.length);
  const usd = total((doc) => doc.costUsd);
  const ms = total((doc) => doc.latencyMs);

  return {
    documents: documents.length,
    clean: documents.filter((doc) => doc.kind === "clean").length,
    seeded: documents.filter((doc) => doc.kind === "seeded").length,
    requests: total((doc) => doc.requests),
    retries: total((doc) => doc.retries),
    unanswered: total((doc) => doc.unanswered),
    median_latency_ms: median(latencies),
    p95_latency_ms: p95(latencies),
    ms_per_document: ms / count,
    ms_per_100_documents: (ms / count) * 100,
    input_tokens: total((doc) => doc.inputTokens),
    output_tokens: total((doc) => doc.outputTokens),
    usd_total: usd,
    usd_per_document: usd / count,
    usd_per_100_documents: (usd / count) * 100,
  };
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** The spike's index, kept exactly so the two reports can be read side by side. */
function p95(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.floor(0.95 * sorted.length) - 1)] ?? 0;
}

/** `pct` from score.py: four decimal places, and null rather than a divide by zero. */
function ratio(n: number, d: number): number | null {
  return d === 0 ? null : Math.round((n / d) * 10000) / 10000;
}

function label(threshold: number): string {
  return String(threshold);
}

function bucketName(index: number): string {
  return `${(index / 10).toFixed(1)}-${((index + 1) / 10).toFixed(1)}`;
}

function key(doc: string, rule: string): string {
  return `${doc} ${rule}`;
}
