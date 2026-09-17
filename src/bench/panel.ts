/**
 * Who is in the panel, and which model that actually is today.
 *
 * A bench that hardcodes `anthropic/claude-sonnet-5` is a bench whose numbers
 * quietly stop meaning what they say the day a provider renames a slug or
 * retires one. So the panel file carries a pattern and a tier, never a promise
 * about what exists, and every entry is matched against the provider's own
 * model list on the day of the run. What that match found — the exact slug, the
 * prices the provider published for it, whether it takes a JSON mode — is
 * written into the raw output beside the answers.
 *
 * A model the provider does not list is not substituted with a near neighbour.
 * It becomes a row that says "not available on <date>", which is a true thing
 * to print and is the only honest option: the alternative is a table where one
 * row silently measures a different model than its label claims.
 *
 * `prefer` exists because a pattern loose enough to survive a version bump can
 * match two slugs at once (a model and its thinking variant). A preference is
 * still checked against the live list; it chooses between things that exist, it
 * never asserts that one does.
 */

import { type YamlValue, parseYaml } from "../yaml.ts";

/** The providers this bench has an adapter for. Anything else is refused. */
export const PROVIDERS = ["openrouter", "anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export class PanelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelError";
  }
}

export interface PanelEntry {
  /** The id used in tables, file names and the joined report. */
  readonly id: string;
  readonly label: string;
  /** A word for the price bracket: fast, mid, deep, control. Free text. */
  readonly tier: string;
  readonly provider: Provider;
  /** A regular expression matched against the provider's model ids. */
  readonly match: string;
  /** Exact ids to take first when they exist, in order. */
  readonly prefer?: readonly string[];
  readonly note?: string;
}

export interface Panel {
  readonly version: 1;
  /** Provider to price-table path, relative to the panel file. */
  readonly prices: Readonly<Record<string, string>>;
  readonly models: readonly PanelEntry[];
}

/** One model as the provider lists it today. */
export interface CatalogEntry {
  readonly id: string;
  /** Absent when the provider published no usable price. Never defaulted to zero. */
  readonly inputUsdPerToken?: number;
  readonly outputUsdPerToken?: number;
  /** Whether the provider says this model accepts a structured-output request. */
  readonly jsonMode: boolean;
}

export interface ResolvedPrice {
  readonly inputUsdPerToken: number;
  readonly outputUsdPerToken: number;
  /** Where the number came from, printed under every table that uses it. */
  readonly source: string;
}

export interface ResolvedModel {
  readonly entry: PanelEntry;
  readonly available: boolean;
  readonly slug: string | null;
  /** Every id the pattern matched, so a reader can see what was chosen over what. */
  readonly candidates: readonly string[];
  readonly jsonMode: boolean;
  readonly prices: ResolvedPrice | null;
  /** Why this row is not a measurement, when it is not one. */
  readonly note?: string;
}

export interface ResolveOptions {
  readonly runDate: string;
  /** Used when the provider's own list carries no prices (Anthropic direct). */
  readonly priceLookup?: (model: string) => ResolvedPrice | undefined;
  /** What to call the price source when it came from the provider's list. */
  readonly catalogPriceSource?: string;
}

// --- the file -------------------------------------------------------------

export function parsePanel(source: string, file: string): Panel {
  const doc = parseYaml(source, file);
  if (!isMapping(doc)) throw new PanelError(`${file}: a panel file is a mapping, with a models list.`);

  if (doc["version"] !== 1) {
    throw new PanelError(`${file}: version must be 1, and this file says ${show(doc["version"])}.`);
  }

  const models = doc["models"];
  if (!Array.isArray(models) || models.length === 0) {
    throw new PanelError(`${file}: models must be a non-empty list.`);
  }

  const seen = new Set<string>();
  const entries = models.map((value, index) => {
    const entry = readEntry(value, `${file}: models[${index}]`);
    if (seen.has(entry.id)) {
      throw new PanelError(`${file}: two models share the id "${entry.id}"; ids name table rows.`);
    }
    seen.add(entry.id);
    return entry;
  });

  return { version: 1, prices: readPrices(doc["prices"], file), models: entries };
}

function readEntry(value: YamlValue, where: string): PanelEntry {
  if (!isMapping(value)) throw new PanelError(`${where}: each model is a mapping.`);

  const id = requiredString(value["id"], `${where}.id`);
  const provider = requiredString(value["provider"], `${where}.provider`);
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new PanelError(
      `${where}.provider is "${provider}", and this bench has adapters for ${PROVIDERS.join(" and ")} only.`,
    );
  }

  const match = requiredString(value["match"], `${where}.match`);
  try {
    new RegExp(match);
  } catch (error) {
    throw new PanelError(`${where}.match is not a regular expression: ${reason(error)}`);
  }

  const prefer = value["prefer"];
  const preferred =
    prefer === undefined || prefer === null
      ? undefined
      : Array.isArray(prefer)
        ? prefer.map((slug, index) => requiredString(slug, `${where}.prefer[${index}]`))
        : (() => {
            throw new PanelError(`${where}.prefer is a list of exact model ids.`);
          })();

  const label = value["label"];
  const tier = value["tier"];
  const note = value["note"];

  return {
    id,
    label: typeof label === "string" ? label : id,
    tier: typeof tier === "string" ? tier : "unlabelled",
    provider: provider as Provider,
    match,
    ...(preferred === undefined ? {} : { prefer: preferred }),
    ...(typeof note === "string" ? { note } : {}),
  };
}

function readPrices(value: YamlValue | undefined, file: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isMapping(value)) throw new PanelError(`${file}: prices is a mapping of provider to file path.`);

  const out: Record<string, string> = {};
  for (const [provider, path] of Object.entries(value)) {
    out[provider] = requiredString(path, `${file}: prices.${provider}`);
  }
  return out;
}

// --- resolution -----------------------------------------------------------

/**
 * Match one panel entry against the provider's list.
 *
 * Sorted, so two runs over the same catalogue choose the same slug; every
 * candidate is carried, so the choice is inspectable rather than implied.
 */
export function resolveEntry(
  entry: PanelEntry,
  catalog: readonly CatalogEntry[],
  options: ResolveOptions,
): ResolvedModel {
  const pattern = new RegExp(entry.match);
  const matches = catalog.filter((model) => pattern.test(model.id)).sort(byId);
  const candidates = matches.map((model) => model.id);

  const preferred = (entry.prefer ?? []).map((slug) => matches.find((model) => model.id === slug));
  const chosen = preferred.find((model) => model !== undefined) ?? matches[0];

  if (chosen === undefined) {
    return {
      entry,
      available: false,
      slug: null,
      candidates,
      jsonMode: false,
      prices: null,
      note: `not available on ${options.runDate}`,
    };
  }

  return {
    entry,
    available: true,
    slug: chosen.id,
    candidates,
    jsonMode: chosen.jsonMode,
    prices: priceOf(chosen, options),
  };
}

export function resolvePanel(
  panel: Panel,
  catalogs: Partial<Record<Provider, readonly CatalogEntry[]>>,
  options: (entry: PanelEntry) => ResolveOptions,
): ResolvedModel[] {
  return panel.models.map((entry) => {
    const catalog = catalogs[entry.provider];
    if (catalog === undefined) {
      return {
        entry,
        available: false,
        slug: null,
        candidates: [],
        jsonMode: false,
        prices: null,
        note: `the ${entry.provider} model list was not read, so this row was not run`,
      };
    }
    return resolveEntry(entry, catalog, options(entry));
  });
}

function priceOf(model: CatalogEntry, options: ResolveOptions): ResolvedPrice | null {
  if (model.inputUsdPerToken !== undefined && model.outputUsdPerToken !== undefined) {
    return {
      inputUsdPerToken: model.inputUsdPerToken,
      outputUsdPerToken: model.outputUsdPerToken,
      source: options.catalogPriceSource ?? "the provider's own model list",
    };
  }
  return options.priceLookup?.(model.id) ?? null;
}

// --- pieces ---------------------------------------------------------------

function byId(a: CatalogEntry, b: CatalogEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isMapping(value: YamlValue | undefined): value is Record<string, YamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: YamlValue | undefined, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PanelError(`${where} is required and must be a non-empty string.`);
  }
  return value;
}

function show(value: YamlValue | undefined): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
