/**
 * Replay: the page, with recorded answers instead of a request.
 *
 * A replay file is the judgment arm's half of a session, written down. It holds
 * what the gateway answered for a paragraph and what that answer cost, in the
 * gateway's own field names, so a recorded answer and a live one are the same
 * shape and travel through the same scorer. The countable rules are not
 * recorded because they do not need to be: they run here, for real, for free.
 *
 *   {
 *     "version": 1,
 *     "runDate": "2026-09-17",        the bench run the numbers came from, or null
 *     "measured": true,               false means the numbers are examples; the page says so
 *     "note": "...",
 *     "default":   { "nouls": {}, "inputTokens": 96, "latencyMs": 380, "estimatedCostUsd": 0.000004 },
 *     "responses": [ { "match": "a phrase in the paragraph", "nouls": { "rule_id": 0.93 }, ... } ]
 *   }
 *
 * A paragraph gets the LAST response whose `match` it contains, so a flag
 * arrives as the sentence that trips it is finished; no match is the default.
 *
 * This client has no `fetch` in it. Replay mode does not call out because there
 * is nothing here that could.
 *
 * Only files inside the package's `examples/replays/` are served. The path is
 * resolved through symlinks before it is compared, so neither `..` nor a link
 * gets a file from anywhere else read and parsed.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { packagedRulesPath } from "../config.ts";
import type { JevClient, JevRequest, JevResult } from "../jev.ts";

/** A replay is a few kilobytes. Anything near this is not a replay (placeholder). */
const MAX_REPLAY_BYTES = 1024 * 1024;

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

export interface RecordedAnswer {
  readonly nouls: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly latencyMs: number;
  readonly estimatedCostUsd: number;
}

export interface MatchedAnswer extends RecordedAnswer {
  readonly match: string;
}

export interface ReplayFile {
  readonly version: 1;
  readonly runDate: string | null;
  readonly measured: boolean;
  readonly note?: string;
  readonly default: RecordedAnswer;
  readonly responses: readonly MatchedAnswer[];
}

export interface LoadedReplay {
  readonly file: ReplayFile;
  /** The resolved path that was read. */
  readonly path: string;
  /** The file's own name, which is all the page and the response header ever see. */
  readonly name: string;
}

export interface LoadReplayOptions {
  /** What a relative path is relative to when it is not a bare name. */
  readonly cwd: string;
  /** Injected in tests; otherwise the package's own `examples/replays/`. */
  readonly replaysDir?: string;
}

/**
 * The one directory a replay may come from. `rules/` sits at the package root
 * both in the repo and in a bundle, so the root is found the way the default
 * ruleset is.
 */
export function replaysDir(): string {
  return join(dirname(dirname(packagedRulesPath())), "examples", "replays");
}

export function loadReplay(path: string, options: LoadReplayOptions): LoadedReplay {
  const allowed = options.replaysDir ?? replaysDir();
  const shown = `examples/replays/`;

  let root: string;
  try {
    root = realpathSync(allowed);
  } catch {
    throw new ReplayError(
      `replay mode reads from ${shown} inside a checkout of the repository, and this install has none.`,
    );
  }

  // A bare name means "the one in the replays directory", wherever you are standing.
  const candidate = isAbsolute(path)
    ? path
    : path.includes("/") || path.includes(sep)
      ? resolve(options.cwd, path)
      : join(root, path);

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new ReplayError(`no replay file at ${path}. Replays live in ${shown}.`);
  }

  const inside = relative(root, real);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new ReplayError(`${path} is outside ${shown}, and replay mode serves nothing from anywhere else.`);
  }
  if (!real.endsWith(".json")) {
    throw new ReplayError(`${path} is not a .json file.`);
  }

  const stats = statSync(real);
  if (!stats.isFile() || stats.size > MAX_REPLAY_BYTES) {
    throw new ReplayError(`${path} is not a replay file (${stats.size} bytes).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(real, "utf8"));
  } catch (error) {
    throw new ReplayError(`${basename(real)} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }

  return { file: validate(parsed, basename(real)), path: real, name: basename(real) };
}

export function createReplayClient(replay: ReplayFile): JevClient {
  return {
    async ask(request: JevRequest): Promise<JevResult> {
      const state = typeof request.state === "string" ? request.state : "";
      let chosen: RecordedAnswer = replay.default;
      for (const response of replay.responses) {
        if (state.includes(response.match)) chosen = response;
      }

      // Only the rules that were asked about are answered, as the service does.
      const nouls: Record<string, number> = {};
      for (const id of Object.keys(request.questions)) {
        const recorded = chosen.nouls[id];
        if (recorded !== undefined) nouls[id] = recorded;
      }

      return {
        model: "replay",
        nouls,
        inputTokens: chosen.inputTokens,
        outputTokens: 0,
        estimatedCostUsd: chosen.estimatedCostUsd,
        latencyMs: chosen.latencyMs,
        attempts: 1,
      };
    },
  };
}

// --- reading the file -------------------------------------------------------

type Fail = (what: string) => never;

function validate(value: unknown, name: string): ReplayFile {
  const fail: Fail = (what) => {
    throw new ReplayError(`${name} is not a replay file: ${what}.`);
  };

  if (!isRecord(value)) return fail("the top level must be an object");
  if (value["version"] !== 1) return fail("version must be 1");

  const runDate = runDateOf(value["runDate"], fail);
  const measured = value["measured"];
  if (typeof measured !== "boolean") return fail("measured must be true or false");
  if (measured && runDate === null) return fail("measured numbers need the runDate they were measured on");

  const note = value["note"];
  if (note !== undefined && typeof note !== "string") return fail("note must be text");

  const responses = value["responses"];
  if (!Array.isArray(responses)) return fail("responses must be a list");

  return {
    version: 1,
    runDate,
    measured,
    ...(note === undefined ? {} : { note }),
    default: answer(value["default"], "default", fail),
    responses: responses.map((entry: unknown, index) => matched(entry, `responses[${index}]`, fail)),
  };
}

function runDateOf(value: unknown, fail: Fail): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fail("runDate must be YYYY-MM-DD or null");
  }
  return value;
}

function matched(value: unknown, where: string, fail: Fail): MatchedAnswer {
  const match = isRecord(value) ? value["match"] : undefined;
  if (typeof match !== "string" || match === "") return fail(`${where}.match must be a non-empty string`);
  return { match, ...answer(value, where, fail) };
}

function answer(value: unknown, where: string, fail: Fail): RecordedAnswer {
  if (!isRecord(value)) return fail(`${where} must be an object`);

  const nouls = value["nouls"];
  if (!isRecord(nouls)) return fail(`${where}.nouls must be an object of rule id to probability`);
  const readings: Record<string, number> = {};
  for (const [rule, probability] of Object.entries(nouls)) {
    if (typeof probability !== "number" || !(probability >= 0 && probability <= 1)) {
      return fail(`${where}.nouls.${rule} must be a number from 0 to 1`);
    }
    readings[rule] = probability;
  }

  const amount = (field: string): number => {
    const raw = value[field];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return fail(`${where}.${field} must be a number, 0 or more`);
    }
    return raw;
  };

  return {
    nouls: readings,
    inputTokens: amount("inputTokens"),
    latencyMs: amount("latencyMs"),
    estimatedCostUsd: amount("estimatedCostUsd"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
