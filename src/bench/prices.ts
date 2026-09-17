/**
 * Prices that came from somewhere, on a day.
 *
 * Most of the panel is priced by the provider itself: OpenRouter publishes a
 * per-token price beside every model and the run records it. One row cannot be
 * priced that way — the Anthropic direct control, because the Messages API does
 * not publish prices — so it is priced from a file that carries its source and
 * the date it was checked, and every table that uses it cites both.
 *
 * The file is dated rather than inline because a constant in a source file is a
 * number with no provenance and no expiry: it keeps printing dollars long after
 * the price it came from changed, and nothing in the output says how old it is.
 *
 * A model that matches no row has no price. Not zero. A zero in a cost column
 * is the claim "this was free", which is the one claim an unpriced model cannot
 * support — Houston's `estimateCostUsd` makes the same choice for the same
 * reason (`src/producer/llm.ts`).
 */

import { type YamlValue, parseYaml } from "../yaml.ts";
import type { ResolvedPrice } from "./panel.ts";

export class PriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceError";
  }
}

export interface PriceRow {
  /** Matched as a substring of the served model id, so a dated id lands on its family. */
  readonly match: string;
  readonly inputUsdPerToken: number;
  readonly outputUsdPerToken: number;
}

export interface PriceTable {
  readonly file: string;
  readonly source: string;
  readonly verified_on: string;
  readonly rows: readonly PriceRow[];
}

/**
 * A million, divided by rather than multiplied by its reciprocal: `15 * 1e-6`
 * is 0.000014999999999999999 in binary floating point and `15 / 1e6` is not.
 */
const A_MILLION = 1e6;

export function parsePriceTable(source: string, file: string): PriceTable {
  const doc = parseYaml(source, file);
  if (!isMapping(doc)) throw new PriceError(`${file}: a price table is a mapping.`);

  const provenance = requiredString(doc["source"], `${file}: source`);
  const verified = requiredString(doc["verified_on"], `${file}: verified_on`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(verified)) {
    throw new PriceError(`${file}: verified_on is a date as YYYY-MM-DD, not "${verified}".`);
  }

  const currency = doc["currency"];
  if (currency !== "usd_per_million_tokens") {
    throw new PriceError(
      `${file}: currency must be usd_per_million_tokens, so the numbers in the file read like the published ones.`,
    );
  }

  const models = doc["models"];
  if (!Array.isArray(models) || models.length === 0) {
    throw new PriceError(`${file}: models must be a non-empty list.`);
  }

  const rows = models.map((value, index) => {
    const where = `${file}: models[${index}]`;
    if (!isMapping(value)) throw new PriceError(`${where} is a mapping.`);
    return {
      match: requiredString(value["match"], `${where}.match`),
      inputUsdPerToken: requiredNumber(value["input"], `${where}.input`) / A_MILLION,
      outputUsdPerToken: requiredNumber(value["output"], `${where}.output`) / A_MILLION,
    };
  });

  return { file, source: provenance, verified_on: verified, rows };
}

export function loadPriceTable(file: string, read: (path: string) => string): PriceTable {
  return parsePriceTable(read(file), file);
}

/** The first row whose family the model id contains, or nothing at all. */
export function priceFor(table: PriceTable, model: string): ResolvedPrice | undefined {
  for (const row of table.rows) {
    if (model.includes(row.match)) {
      return {
        inputUsdPerToken: row.inputUsdPerToken,
        outputUsdPerToken: row.outputUsdPerToken,
        source: `${table.file} (${table.source}), checked ${table.verified_on}`,
      };
    }
  }
  return undefined;
}

/** What a table calls itself under a report's numbers. */
export function priceCitation(table: PriceTable): string {
  return `${table.file}: ${table.source}, checked ${table.verified_on}`;
}

function isMapping(value: YamlValue | undefined): value is Record<string, YamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: YamlValue | undefined, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PriceError(`${where} is required: a price with no provenance is not a price.`);
  }
  return value;
}

function requiredNumber(value: YamlValue | undefined, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PriceError(`${where} must be a number of dollars per million tokens.`);
  }
  return value;
}
