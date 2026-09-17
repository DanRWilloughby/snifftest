/**
 * `snifftest serve`: the page where you type and the nose reacts.
 *
 * Two modes, and the difference is whether anything can leave the machine.
 *
 * Live scores with the real rules. The countable ones always run. The judgment
 * ones run only when there is a key AND a yes, and the yes is asked for here,
 * in the terminal, through the same gate `check` uses, before the server
 * starts. It is never asked for in the browser: a consent button on a local
 * page is a button some other page could try to press. Without a key or without
 * a yes the page still works, on the countable rules, and says that is what it
 * is doing.
 *
 * Replay scores with recorded answers from `examples/replays/`. It needs no key,
 * asks no consent, and cannot call out, because the client it is given has no
 * network in it. It is what the launch video is captured from, so the numbers
 * on screen are the ones a real run measured.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { packagedRulesPath, resolveRuleset } from "../config.ts";
import type { CliDeps } from "../cli.ts";
import { requestConsent } from "../consent.ts";
import { ENDPOINT, type JevClient, KEY_ENV, createJevClient } from "../jev.ts";
import { isJudgmentRule } from "../types.ts";
import type { PageConfig } from "./page.ts";
import { type LoadedReplay, createReplayClient, loadReplay } from "./replay.ts";
import { RecordError, newestCommittedRunDate, recordReplay, runDatesOnDisk } from "./record.ts";
import { createScorer } from "./score.ts";
import { DEFAULT_PORT, LOOPBACK, type ServeHandle, startServer } from "./server.ts";

export type { ServeHandle } from "./server.ts";

/** The pause after the last keystroke before a draft is scored (plan placeholder). */
export const DEBOUNCE_MS = 500;

/** Used when neither the command line nor the ruleset names one. Mirrors `check`. */
const DEFAULT_THRESHOLD = 0.7;

/** `EXIT.ok` and `EXIT.failure` in `../cli.ts`, which this file cannot import without a cycle. */
const OK = 0;
const FAILURE = 2;

class ServeUsageError extends Error {}

export interface ServeHooks {
  /** Ends the command the way Ctrl-C does. */
  readonly signal?: AbortSignal;
  readonly onListening?: (handle: ServeHandle) => void;
}

interface ServeArgs {
  readonly port: number;
  readonly host?: string;
  readonly replay?: string;
  readonly rulesPath?: string;
  readonly threshold?: number;
  readonly assumeYes: boolean;
  /** Where a recording is written. Set, the page never starts. */
  readonly record?: string;
  /** The date the recording says its numbers belong to, when it is not looked up. */
  readonly runDate?: string;
  /** Drafts to walk, for `--record`. */
  readonly drafts: readonly string[];
}

export async function serve(deps: CliDeps, hooks: ServeHooks = {}): Promise<number> {
  let handle: ServeHandle;
  try {
    const args = parseServeArgs(deps.argv.slice(1));
    if (args.record !== undefined) return await record(deps, args);
    const replay = args.replay === undefined ? undefined : loadReplay(args.replay, { cwd: deps.cwd });

    // A replay is a recording of the shipped rules, so it is played against
    // them, whatever project file happens to be lying in the working directory.
    const rulesPath = args.rulesPath ?? (replay === undefined ? undefined : packagedRulesPath());
    const { ruleset } = resolveRuleset({
      cwd: deps.cwd,
      ...(rulesPath === undefined ? {} : { rulesPath }),
      ...(deps.defaultRulesPath === undefined ? {} : { defaultRulesPath: deps.defaultRulesPath }),
    });
    const threshold = args.threshold ?? ruleset.threshold ?? DEFAULT_THRESHOLD;

    const key = deps.env[KEY_ENV]?.trim() ?? "";
    const judgmentRuleIds = ruleset.rules.filter(isJudgmentRule).map((rule) => rule.id);
    const live = replay === undefined ? await liveClient(deps, args, judgmentRuleIds, key) : undefined;
    const client = replay === undefined ? live?.client : createReplayClient(replay.file);

    handle = await startServer({
      port: args.port,
      ...(args.host === undefined ? {} : { host: args.host }),
      scorer: createScorer({ ruleset, threshold, ...(client === undefined ? {} : { client }) }),
      page: pageConfig(replay, client !== undefined, threshold, live?.why),
      ...(replay === undefined ? {} : { replayName: replay.name }),
      secrets: key === "" ? [] : [key],
    });
  } catch (error) {
    deps.writeError(error instanceof Error ? error.message : String(error));
    return FAILURE;
  }

  deps.write(`Sniff Test is at ${handle.url}  (Ctrl-C to stop)`);
  hooks.onListening?.(handle);

  await stopSignal(hooks.signal);
  await handle.close();
  return OK;
}

// --- recording a replay ---------------------------------------------------------

/**
 * `serve --record <out.json> <draft.md>...`, which walks the drafts live and
 * writes what came back. The page is never started: this is the run that makes
 * a replay, not a replay of one.
 */
async function record(deps: CliDeps, args: ServeArgs): Promise<number> {
  if (args.drafts.length === 0) {
    deps.writeError("--record needs at least one draft to walk: snifftest serve --record out.json draft.md");
    return FAILURE;
  }
  if (args.replay !== undefined) {
    deps.writeError("--record makes a recording and --replay plays one back, so they cannot be asked for together.");
    return FAILURE;
  }

  const rulesPath = args.rulesPath ?? packagedRulesPath();
  const { ruleset } = resolveRuleset({
    cwd: deps.cwd,
    rulesPath,
    ...(deps.defaultRulesPath === undefined ? {} : { defaultRulesPath: deps.defaultRulesPath }),
  });

  const runDate = args.runDate ?? runDateFor(deps);
  if (runDate === null) {
    const onDisk = runDatesOnDisk(join(deps.cwd, "bench", "results"));
    deps.writeError(
      "no committed run under bench/results, so there is no dated run for these numbers to belong to." +
        (onDisk.length === 0
          ? " Run the bench, commit its results, then record."
          : ` Uncommitted runs are there (${onDisk.join(", ")}); commit one, or name a date with --run-date.`),
    );
    return FAILURE;
  }

  const drafts = [];
  for (const path of args.drafts) {
    const full = isAbsolute(path) ? path : resolve(deps.cwd, path);
    try {
      drafts.push({ name: path, text: readFileSync(full, "utf8") });
    } catch (error) {
      deps.writeError(`${path} could not be read (${error instanceof Error ? error.message : String(error)}).`);
      return FAILURE;
    }
  }

  const key = deps.env[KEY_ENV]?.trim() ?? "";
  const judgmentRuleIds = ruleset.rules.filter(isJudgmentRule).map((rule) => rule.id);
  const live = await liveClient(deps, args, judgmentRuleIds, key);
  if (live.client === undefined) {
    deps.writeError("a recording is the judgment rules' answers, so it cannot be made without them.");
    return FAILURE;
  }

  let recorded;
  try {
    recorded = await recordReplay({
      ruleset,
      client: live.client,
      drafts,
      runDate,
      note: `Recorded by snifftest serve --record over ${drafts.map((draft) => draft.name).join(", ")}.`,
    });
  } catch (error) {
    if (error instanceof RecordError) {
      deps.writeError(error.message);
      return FAILURE;
    }
    throw error;
  }

  const out = isAbsolute(args.record ?? "") ? (args.record ?? "") : resolve(deps.cwd, args.record ?? "");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(recorded.file, null, 1)}\n`, "utf8");

  deps.write(
    `recorded ${recorded.asked} paragraph states over ${recorded.prefixes} sentence boundaries, ` +
      `against the run of ${runDate}`,
  );
  deps.write(`wrote ${args.record ?? out}`);
  return OK;
}

/** The dated run a recording's numbers belong beside, or null when there is none. */
function runDateFor(deps: CliDeps): string | null {
  try {
    return newestCommittedRunDate(deps.cwd);
  } catch (error) {
    if (error instanceof RecordError) return null;
    throw error;
  }
}

// --- live mode: the key, then the question ------------------------------------

interface LiveClient {
  readonly client?: JevClient;
  /** Why the judgment rules are off, in words for the page. */
  readonly why?: string;
}

async function liveClient(
  deps: CliDeps,
  args: ServeArgs,
  judgmentRuleIds: readonly string[],
  key: string,
): Promise<LiveClient> {
  if (judgmentRuleIds.length === 0) return { why: "This ruleset has countable rules only." };

  // The key is checked before the question is asked, so nobody is talked into
  // agreeing to a request that was never going to be made.
  if (key === "") {
    deps.writeError(`${KEY_ENV} is not set, so the page will use the countable rules only. Nothing will leave this machine.`);
    return { why: `Set ${KEY_ENV} and restart to add the judgment rules.` };
  }

  deps.writeError("snifftest serve scores what you type into the local page, a paragraph at a time.");
  const consent = await requestConsent({
    env: deps.env,
    homedir: deps.homedir,
    assumeYes: args.assumeYes,
    isTty: deps.isTty,
    ruleIds: judgmentRuleIds,
    fileCount: 1,
    say: deps.writeError,
    ...(deps.prompt === undefined ? {} : { prompt: deps.prompt }),
  });

  if (!consent.granted) {
    deps.writeError("The page will use the countable rules only.");
    return { why: "Restart with --yes to add the judgment rules." };
  }

  return { client: (deps.createClient ?? createJevClient)({ apiKey: key }) };
}

// --- what the page is told ----------------------------------------------------

function pageConfig(
  replay: LoadedReplay | undefined,
  judged: boolean,
  threshold: number,
  why: string | undefined,
): PageConfig {
  const base = { debounceMs: DEBOUNCE_MS, threshold, judged };

  if (replay !== undefined) {
    const measured = replay.file.measured && replay.file.runDate !== null;
    return {
      ...base,
      mode: "replay",
      holdForRecordedLatency: true,
      meterLabel: measured ? `replayed from the ${replay.file.runDate} bench run` : "example numbers, not measured",
      modeLine: measured
        ? `Replay. The answers and the numbers were recorded on the bench run of ${replay.file.runDate}. Nothing leaves this machine.`
        : "Replay. Example numbers, made up so the page can be tried without a key. Nothing leaves this machine.",
    };
  }

  return {
    ...base,
    mode: "live",
    holdForRecordedLatency: false,
    meterLabel: judged ? "measured, this round" : "countable rules only, nothing sent",
    modeLine: judged
      ? `Live. Each paragraph you change goes to ${new URL(ENDPOINT).host} for the judgment rules. You said yes to that in the terminal.`
      : `Countable rules only. Nothing leaves this machine. ${why ?? ""}`.trim(),
  };
}

// --- arguments ------------------------------------------------------------------

function parseServeArgs(argv: readonly string[]): ServeArgs {
  let port = DEFAULT_PORT;
  let host: string | undefined;
  let replay: string | undefined;
  let rulesPath: string | undefined;
  let threshold: number | undefined;
  let assumeYes = false;
  let recordTo: string | undefined;
  let runDate: string | undefined;
  const drafts: string[] = [];

  const valueFor = (index: number, name: string): string => {
    const value = argv[index];
    if (value === undefined || value.startsWith("-")) throw new ServeUsageError(`${name} needs a value.`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i] ?? "";
    switch (argument) {
      case "--port": {
        const value = valueFor(++i, "--port");
        port = Number(value);
        // 0 asks the system for a free port, which is what a test wants.
        if (!Number.isInteger(port) || port < 0 || port > 65_535 || (port > 0 && port < 1024)) {
          throw new ServeUsageError(`--port takes a whole number from 1024 to 65535, not "${value}".`);
        }
        break;
      }
      case "--host":
        host = valueFor(++i, "--host");
        if (host !== LOOPBACK) {
          throw new ServeUsageError(
            `snifftest serve listens on ${LOOPBACK} only, not ${host}. Drafts and the key behind this page are not for the network.`,
          );
        }
        break;
      case "--replay":
        replay = valueFor(++i, "--replay");
        break;
      case "--rules":
        rulesPath = valueFor(++i, "--rules");
        break;
      case "--threshold": {
        const value = valueFor(++i, "--threshold");
        threshold = Number(value);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          throw new ServeUsageError(`--threshold takes a number between 0 and 1, not "${value}".`);
        }
        break;
      }
      case "--record":
        recordTo = valueFor(++i, "--record");
        break;
      case "--run-date": {
        const value = valueFor(++i, "--run-date");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          throw new ServeUsageError(`--run-date takes a date as YYYY-MM-DD, not "${value}".`);
        }
        runDate = value;
        break;
      }
      case "--yes":
      case "-y":
        assumeYes = true;
        break;
      default:
        if (!argument.startsWith("-")) {
          drafts.push(argument);
          break;
        }
        throw new ServeUsageError(
          `snifftest serve does not take "${argument}". It takes --port, --replay, --record, --run-date, --rules, --threshold and --yes.`,
        );
    }
  }

  if (drafts.length > 0 && recordTo === undefined) {
    throw new ServeUsageError(
      `snifftest serve takes no file to open; it opens a page you type into. To walk a draft and write a recording, use --record <out.json> ${drafts[0] ?? "<draft.md>"}.`,
    );
  }

  return {
    port,
    assumeYes,
    drafts,
    ...(host === undefined ? {} : { host }),
    ...(replay === undefined ? {} : { replay }),
    ...(rulesPath === undefined ? {} : { rulesPath }),
    ...(threshold === undefined ? {} : { threshold }),
    ...(recordTo === undefined ? {} : { record: recordTo }),
    ...(runDate === undefined ? {} : { runDate }),
  };
}

// --- staying up -----------------------------------------------------------------

function stopSignal(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted === true) {
      resolvePromise();
      return;
    }
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolvePromise();
    };
    signal?.addEventListener("abort", stop, { once: true });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
