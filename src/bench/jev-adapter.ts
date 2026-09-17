/**
 * Jev as a panel row, so its latency is measured with the same ruler.
 *
 * Arm C used to reach the bench table by being joined from a separate `eval`
 * run: one pass, in order, on another day, possibly another hour. Its latency
 * sat in the same column as rows that had been interleaved and repeated, with
 * nothing but the word "eval arm" to say the two numbers were not comparable.
 * Failed calls were in one median and out of the other. Two rulers in one
 * column is the kind of thing a reader is entitled to call rigged.
 *
 * So this adapter puts Jev in the rotation. It is called in the same
 * round-robin as every other row, repeated the same number of times, and a
 * failure is counted the same way. The accuracy numbers still come from `eval`,
 * where arm C is scored against arms A and B; what this row adds is a latency
 * and a cost measured beside the panel rather than beside itself.
 *
 * ## Two things this row does differently, both of them declared
 *
 * Jev is asked its own way, one request carrying every rule as a separate
 * question, which is the shape arm C uses and the shape the service documents.
 * A panel row is asked in one chat call for one JSON object. The request count
 * is the same, one per paragraph; the shapes are not, and the tables say so.
 *
 * Jev returns a probability and no boolean, so the flag this row reports is its
 * probability against the shipped threshold. That is a derived decision, not
 * one the service made, and it is the only row in the table where the two
 * recall columns are the same number by construction.
 */

import {
  type JevClient,
  MODEL as JEV_MODEL,
  type JevResult,
  isNoJudgment,
  questionsFromRules,
} from "../jev.ts";
import type { JudgmentRule } from "../types.ts";
import type { ModelAdapter, ModelCall, ModelReply } from "./adapter.ts";
import type { CatalogEntry } from "./panel.ts";

export interface JevAdapterOptions {
  readonly client: JevClient;
  /** The judgment rules, asked as the same questions arm C asks. */
  readonly rules: readonly JudgmentRule[];
  /** The operating point this row's boolean is derived at. */
  readonly threshold: number;
}

/**
 * The one model this provider lists, and no price with it.
 *
 * The price is deliberately absent. Every other row's price comes from the
 * provider's own list or from a dated file under `bench/prices/`, and no dated
 * published price has been recorded for this endpoint. A constant compiled into
 * this repo is not a source, so the row prints its cost as unknown until a
 * dated file sits beside the others.
 */
export function jevCatalog(): readonly CatalogEntry[] {
  return [{ id: JEV_MODEL, jsonMode: false }];
}

export function createJevAdapter(options: JevAdapterOptions): ModelAdapter {
  const questions = questionsFromRules(options.rules);
  const ids = options.rules.map((rule) => rule.id);

  return {
    provider: "jev",
    listModels: async () => jevCatalog(),
    call: async (request: ModelCall): Promise<ModelReply> => {
      const result = await options.client.ask({ state: paragraphOf(request.user), questions });
      return {
        servedModel: result.model,
        text: JSON.stringify(readingsOf(result, ids, options.threshold)),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        reasoningTokens: 0,
        finishReason: null,
        truncated: false,
        latencyMs: result.latencyMs,
        attempts: result.attempts,
      };
    },
  };
}

/**
 * The paragraph out of the user turn the bench prompt wrapped it in.
 *
 * This adapter is handed the same `ModelCall` every other adapter is handed, so
 * that nothing upstream has to know which row is which. The wrapper is one
 * known line, and stripping it here is cheaper than a second call shape that
 * every caller would then have to branch on.
 */
export function paragraphOf(user: string): string {
  const prefix = "PARAGRAPH:\n";
  return user.startsWith(prefix) ? user.slice(prefix.length) : user;
}

/**
 * Jev's nouls in the shape the panel's own reply parser reads.
 *
 * A reading that is not a finite number in 0 to 1 is left out, and so is one
 * inside the no-judgment band, because a band answer decided nothing. Both come
 * back as unanswered cells, which is what they are, rather than as a confident
 * "no".
 */
function readingsOf(
  result: JevResult,
  ids: readonly string[],
  threshold: number,
): Record<string, { flag: boolean; p: number }> {
  const readings: Record<string, { flag: boolean; p: number }> = {};
  for (const id of ids) {
    const p = result.nouls[id];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) continue;
    if (isNoJudgment(p)) continue;
    readings[id] = { flag: p >= threshold, p };
  }
  return readings;
}
