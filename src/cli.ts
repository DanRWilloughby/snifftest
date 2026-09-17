/**
 * The command people type.
 *
 * Everything the CLI needs from the outside world arrives as `CliDeps` and it
 * returns an exit code instead of calling `process.exit`. So the whole surface
 * is testable without a subprocess and without a network stub that has to be
 * trusted not to fire: argument parsing, the consent gate, the order the two
 * arms run in, every exit code.
 *
 * Two orderings here are load-bearing.
 *
 * The countable arm always runs first and always prints, even when the judgment
 * arm fails, because a network problem must never cost someone a flag they
 * could have had for free. `--dry-run` is therefore a strict subset of a full
 * run rather than a different code path: the same chunking, the same rules, the
 * same line numbers, minus the requests.
 *
 * Nothing is sent before the answer to the consent question is yes. The key is
 * checked before the question is asked, so a run that cannot work does not talk
 * someone into agreeing to a request it was never going to make.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  ANTHROPIC_KEY_ENV,
  ANTHROPIC_MESSAGES_ENDPOINT,
  createAnthropicAdapter,
} from "./bench/anthropic.ts";
import type { ModelAdapter } from "./bench/adapter.ts";
import {
  OPENROUTER_CHAT_ENDPOINT,
  OPENROUTER_KEY_ENV,
  OPENROUTER_PRICE_SOURCE,
  createOpenRouterAdapter,
  readOpenRouterCatalog,
} from "./bench/openrouter.ts";
import {
  type CatalogEntry,
  PanelError,
  type Provider,
  type ResolvedModel,
  isProvider,
  parsePanel,
  resolvePanel,
} from "./bench/panel.ts";
import { PriceError, type PriceTable, parsePriceTable, priceCitation, priceFor } from "./bench/prices.ts";
import { readAnthropicCatalog } from "./bench/anthropic.ts";
import { createJevAdapter, jevCatalog } from "./bench/jev-adapter.ts";
import { type BenchDocument, runBench } from "./bench/run.ts";
import { type JoinedArm, buildBenchReport, writeBenchReport } from "./bench/tables.ts";
import {
  ConfigError,
  type ResolvedRuleset,
  packagedPath,
  resolveRuleset,
  selectRules,
} from "./config.ts";
import { CACHE_DIR_ENV, openCache } from "./cache.ts";
import { type Destination, type Env, TYPESAFE_DESTINATION, requestConsent } from "./consent.ts";
import {
  type JudgmentArmResult,
  type JudgmentReading,
  type JudgmentStop,
  type JudgmentTally,
  type JudgmentUsage,
  type SkippedChunk,
  chunkDocument,
  flagsFrom,
  mergeFlags,
  NOT_SENT_REASON,
  runJudgmentArm,
  runRegexArm,
} from "./engine.ts";
import { type WrittenReport, buildReport, writeReport } from "./eval/report.ts";
import { BankError, type SeedBank, packagedBankPath, readBank } from "./eval/bank.ts";
import { type RunEvalOptions, runEval } from "./eval/run.ts";
import { TwinError, compareTwins, readManifest } from "./eval/twins.ts";
import { DEFAULT_PER_RULE, DEFAULT_SEED, SeedError, type BaseDocument, seedCorpus } from "./eval/seed.ts";
import {
  type FetchLike,
  type JevClient,
  type JevClientOptions,
  KEY_ENV,
  STATE_GUARD_CHARS,
  createJevClient,
} from "./jev.ts";
import { RulesetError } from "./rules.ts";
import { serve } from "./serve/command.ts";
import { type Flag, type Ruleset, asRecord, isJudgmentRule } from "./types.ts";
import { YamlError } from "./yaml.ts";

/** What each exit code means. Documented in `--help` and tested one by one. */
export const EXIT = {
  /** Nothing tripped a rule. */
  ok: 0,
  /** At least one flag at or above the threshold. */
  flags: 1,
  /** The tool could not do its job. */
  failure: 2,
  /** The judgment rules need an answer before anything is sent. */
  consent: 3,
} as const;

/**
 * The exit-code contract, written once and printed by `--help`.
 *
 * It lives here rather than in prose in four files because every surface that
 * reads an exit code reads this one: the Action writes a job summary from it,
 * the hook decides whether to block a commit by it, and a person reads it at
 * the end of `--help`. The rule that matters most is the last one: a judgment
 * arm that was asked for and answered nothing is a tool failure and never a
 * quiet fall back to the countable rules, because exit 0 is this tool's word
 * for "nothing tripped" and a silent degrade would spend it on "nothing ran".
 */
export const EXIT_RULES: readonly string[] = [
  "  0  nothing tripped a rule",
  "  1  at least one flag at or above the threshold",
  "  2  the tool could not do its job: arguments, rules, files, a failed request,",
  "     or a judgment arm that was asked for and answered none of its questions",
  "  3  the judgment rules need a yes before anything is sent, and did not get one",
  "",
  "  A judgment arm that answered some of its questions is a partial run: the exit",
  "  code comes from the flags that exist, and what went unanswered is printed.",
];

/** Used when neither the command line nor the ruleset names one (T1 report). */
export const DEFAULT_THRESHOLD = 0.7;

/** Extensions a directory walk picks up. A file named outright is always read. */
const DRAFT_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown", ".txt"]);

/**
 * Every command the tool will have. `eval`, `bench` and `serve` are named here
 * before they exist so that typing one gets "not built yet" rather than
 * "unknown command", which is a different and more confusing thing to be told.
 */
const COMMANDS = ["check", "rules", "eval", "bench", "serve"] as const;
type Command = (typeof COMMANDS)[number];

export interface CliDeps {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly cwd: string;
  readonly homedir: string;
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
  readonly isTty: boolean;
  readonly prompt?: (question: string) => Promise<string>;
  /** Injected in tests so no test can reach the network by accident. */
  readonly createClient?: (options: JevClientOptions) => JevClient;
  /** The same, for the bench adapters, which do not go through the gateway. */
  readonly fetchLike?: FetchLike;
  readonly defaultRulesPath?: string;
}

class UsageError extends Error {}

interface Options {
  readonly command: Command;
  readonly paths: readonly string[];
  readonly rulesPath?: string;
  readonly threshold?: number;
  readonly format: "text" | "json";
  readonly dryRun: boolean;
  readonly assumeYes: boolean;
  /** `eval` only: the seed value, the seeds per rule, and where results land. */
  readonly seed?: number;
  readonly perRule?: number;
  readonly outDir?: string;
  /** `--twins <dir>`: measure what an injected sentence moves, instead of seeding. */
  readonly twins?: string;
  /** `--no-cache`: ask for every paragraph again, even one answered yesterday. */
  readonly noCache?: boolean;
  /** `--seed-version 1` reproduces a corpus made before the seed bank existed. */
  readonly seedVersion?: 1 | 2;
  /** `--seed-bank <path>`: faults to draw from. Absent means the packaged bank. */
  readonly bankPath?: string;
  /** `bench` only. */
  readonly panelPath?: string;
  readonly repeats?: number;
  /** A recorded models-endpoint payload, so a dry run needs no network at all. */
  readonly modelsPath?: string;
  /** An `eval` results directory: its corpus is reused and its arms are joined. */
  readonly evalDir?: string;
  /** Tags: run only these, and never run these. */
  readonly only?: readonly string[];
  readonly skip?: readonly string[];
  /** The tree this run is about, when the process is not standing in it. */
  readonly root?: string;
}

// --- the entry point ------------------------------------------------------

export async function runCli(deps: CliDeps): Promise<number> {
  const argv = [...deps.argv];

  if (argv.includes("--help") || argv.includes("-h")) {
    for (const line of helpLines()) deps.write(line);
    return EXIT.ok;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    deps.write(version());
    return EXIT.ok;
  }
  if (argv[0] === "serve") return serve(deps);

  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return fail(deps, error);
  }

  try {
    const scoped = rooted(deps, options);
    if (options.command === "check") return await check(scoped, options);
    if (options.command === "rules") return rules(scoped, options);
    if (options.command === "eval") return await evaluate(scoped, options);
    if (options.command === "bench") return await bench(scoped, options);
    throw new UsageError(
      `"snifftest ${options.command}" is planned but not built yet. Today there is check, rules, eval and bench.`,
    );
  } catch (error) {
    return fail(deps, error);
  }
}

/**
 * `--root <dir>`: the tree this run is about, when the process is standing
 * somewhere else on purpose.
 *
 * The shells that fetch this tool have to run the fetch from a directory
 * outside the checkout they are checking. A package manager asked for
 * `snifftest@<version>` while standing in a repository runs that repository's
 * own `node_modules/snifftest` instead of going to a registry, which on a
 * fork's pull request is somebody else's code on your runner, with your
 * environment. Moving the working directory out is the fix; this flag is how
 * the run still knows which tree it is checking, so ruleset discovery, relative
 * paths and the paths printed in the flags all read as they always did.
 *
 * It replaces the working directory for everything the command does, and for
 * nothing else: where the consent answer is kept is a property of the person,
 * not of the tree, and it is not touched here.
 */
function rooted(deps: CliDeps, options: Options): CliDeps {
  if (options.root === undefined) return deps;

  const root = isAbsolute(options.root) ? options.root : resolve(deps.cwd, options.root);
  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new UsageError(`no directory at ${options.root}`);
  }
  if (!stats.isDirectory()) {
    throw new UsageError(`--root takes a directory, and ${options.root} is not one.`);
  }

  return { ...deps, cwd: root };
}

// --- check ----------------------------------------------------------------

async function check(deps: CliDeps, options: Options): Promise<number> {
  const resolved = resolveRuleset({
    cwd: deps.cwd,
    ...(options.rulesPath === undefined ? {} : { rulesPath: options.rulesPath }),
    ...(deps.defaultRulesPath === undefined ? {} : { defaultRulesPath: deps.defaultRulesPath }),
  });
  const selected = selectRules(resolved.ruleset, {
    ...(options.only === undefined ? {} : { only: options.only }),
    ...(options.skip === undefined ? {} : { skip: options.skip }),
  });
  const ruleset = selected.ruleset;
  warnAbout(deps, resolved);
  // One line per reason rather than per rule: five rules sitting out one tag is
  // one fact about the run, and five lines of it drowns the flags underneath.
  const byReason = new Map<string, string[]>();
  for (const row of selected.dropped) {
    byReason.set(row.reason, [...(byReason.get(row.reason) ?? []), row.rule]);
  }
  for (const [reason, names] of byReason) {
    deps.writeError(`${names.join(", ")} sat this run out: ${reason}.`);
  }
  const threshold = options.threshold ?? ruleset.threshold ?? DEFAULT_THRESHOLD;

  const files = collectFiles(deps, options.paths);
  const chunks = readDrafts(deps, files).flatMap((draft) =>
    // The cap is applied on every run, dry or not, so a chunk boundary (and so
    // a reported line number) never depends on whether the network was used.
    chunkDocument(draft.text, draft.shown, { maxChars: STATE_GUARD_CHARS }),
  );

  const countable = runRegexArm(chunks, ruleset, deps.writeError);
  const judgmentRules = ruleset.rules.filter(isJudgmentRule);

  if (options.dryRun || judgmentRules.length === 0 || chunks.length === 0) {
    const why = options.dryRun
      ? "--dry-run was asked for"
      : judgmentRules.length === 0
        ? "the ruleset carries no judgment rules"
        : "those paths hold no paragraphs";
    const verdict = `The countable rules produced this verdict on their own, because ${why}.`;
    report(deps, options, threshold, countable, verdict, notRun(why));
    deps.writeError(verdict);
    return exitFor(countable);
  }

  const key = deps.env[KEY_ENV];
  if (key === undefined || key.trim() === "") {
    const verdict =
      `The countable rules ran and the judgment rules did not, so this is not a full verdict.`;
    report(deps, options, threshold, countable, verdict, notRun(`${KEY_ENV} is not set`));
    deps.writeError(
      `${KEY_ENV} is not set, so the judgment rules cannot run. Export it, or use --dry-run for the countable rules only.`,
    );
    return EXIT.failure;
  }

  const consent = await requestConsent({
    env: deps.env,
    homedir: deps.homedir,
    assumeYes: options.assumeYes,
    isTty: deps.isTty,
    ruleIds: judgmentRules.map((rule) => rule.id),
    fileCount: files.length,
    say: deps.writeError,
    ...(deps.prompt === undefined ? {} : { prompt: deps.prompt }),
  });

  if (!consent.granted) {
    const verdict = "The countable rules ran; the judgment rules were not sent anything.";
    report(deps, options, threshold, countable, verdict, notRun("consent was not given"));
    return EXIT.consent;
  }

  const client = (deps.createClient ?? createJevClient)({ apiKey: key });
  const cache =
    options.noCache === true
      ? undefined
      : openCache({ env: deps.env, ...(deps.homedir === undefined ? {} : { homedir: deps.homedir }) });
  let judged: JudgmentArmResult;
  try {
    judged = await runJudgmentArm(chunks, ruleset, client, ...(cache === undefined ? [] : [{ cache }]));
  } catch (error) {
    const verdict = "The countable rules ran and the judgment arm failed, so this is not a full verdict.";
    report(deps, options, threshold, countable, verdict, notRun(messageOf(error)));
    deps.writeError(`the judgment rules could not run: ${messageOf(error)}`);
    return EXIT.failure;
  }

  const flags = mergeFlags(countable, flagsFrom(judged.readings, threshold));
  const summary = judgmentSummary(judged);
  const verdict = verdictLine(judged.tally);

  report(deps, options, threshold, flags, verdict, summary);
  deps.writeError(verdict);
  for (const line of degradationLines(judged)) deps.writeError(line);
  deps.writeError(usageLine(judged.usage));

  // Asked, and heard nothing usable. Exit 0 is this tool's word for "nothing
  // tripped a rule", and a run that got no judgment at all has not earned it.
  if (judged.tally.asked > 0 && judged.tally.answered === 0) return EXIT.failure;
  return exitFor(flags);
}

function exitFor(flags: readonly Flag[]): number {
  return flags.length > 0 ? EXIT.flags : EXIT.ok;
}

// --- what the judgment arm did, in one shape both formats read ------------

type JudgmentState = "not run" | "answered" | "degraded" | "answered nothing";

/**
 * The judgment arm's own account of itself, printed in text and in JSON.
 *
 * It is one record rather than a few loose numbers because the question a
 * reader asks is a single one: how much of this verdict is judgment and how
 * much of it is the countable rules alone. The answer is unreadable unless the
 * counts, the skipped paragraphs and the state sit together.
 */
interface JudgmentSummary {
  readonly state: JudgmentState;
  readonly reason?: string;
  readonly asked: number;
  readonly answered: number;
  readonly no_judgment: number;
  readonly unanswered: number;
  readonly skipped: readonly SkippedChunk[];
  /** Present when the arm gave up before it ran out of paragraphs. */
  readonly stopped?: JudgmentStop;
  /**
   * Every reading, including the ones below the threshold and the ones in the
   * no-judgment band. A caller comparing two drafts needs the numbers that did
   * not become flags, and printing only the flags hid them.
   */
  readonly readings: readonly JudgmentReading[];
}

function notRun(reason: string): JudgmentSummary {
  return {
    state: "not run",
    reason,
    asked: 0,
    answered: 0,
    no_judgment: 0,
    unanswered: 0,
    skipped: [],
    readings: [],
  };
}

function judgmentSummary(judged: JudgmentArmResult): JudgmentSummary {
  const tally = judged.tally;
  const state: JudgmentState =
    tally.answered === 0
      ? "answered nothing"
      : tally.noJudgment + tally.unanswered > 0
        ? "degraded"
        : "answered";

  return {
    state,
    asked: tally.asked,
    answered: tally.answered,
    no_judgment: tally.noJudgment,
    unanswered: tally.unanswered,
    skipped: judged.skipped,
    ...(judged.stopped === undefined ? {} : { stopped: judged.stopped }),
    readings: judged.readings,
  };
}

/** One sentence naming which arm the exit code rests on. */
function verdictLine(tally: JudgmentTally): string {
  const cells = `${tally.answered} of ${tally.asked} judgment questions answered`;
  const middle = tally.noJudgment === 0 ? "" : `, ${tally.noJudgment} answered inside the no-judgment band`;
  const missing = tally.unanswered === 0 ? "" : `, ${tally.unanswered} unanswered`;

  if (tally.answered === 0) {
    return `The judgment arm answered none of its ${tally.asked} questions${middle}${missing}, so there is no judgment in this verdict.`;
  }
  if (tally.noJudgment + tally.unanswered > 0) {
    return `The countable rules and a partial judgment arm produced this verdict: ${cells}${middle}${missing}.`;
  }
  return `The countable rules and the judgment rules both produced this verdict: ${cells}.`;
}

/** The paragraphs that went unjudged, each with its file and line. */
/**
 * The unjudged paragraphs, in as few lines as the facts allow.
 *
 * A run over four thousand paragraphs that meets a dead service has four
 * thousand unjudged paragraphs, and four thousand identical lines about it is
 * not a report, it is the flags buried. So identical reasons are counted and
 * printed once, with the first paragraph named so there is somewhere to look,
 * and the JSON keeps every row for anything that wants to read them all.
 */
function degradationLines(judged: JudgmentArmResult): string[] {
  const byReason = new Map<string, { first: SkippedChunk; count: number }>();
  for (const row of judged.skipped) {
    // The paragraphs that were never sent are the stop's own line, below, which
    // already carries their count and the failure that caused it.
    if (judged.stopped !== undefined && row.reason === NOT_SENT_REASON) continue;
    const held = byReason.get(row.reason);
    if (held === undefined) byReason.set(row.reason, { first: row, count: 1 });
    else held.count += 1;
  }

  const lines = [...byReason].map(([reason, group]) =>
    group.count === 1
      ? `skipped ${group.first.file}:${group.first.line}, ${reason}`
      : `skipped ${group.count} paragraphs, ${reason} (first at ${group.first.file}:${group.first.line})`,
  );

  const stopped = judged.stopped;
  if (stopped !== undefined) {
    lines.push(
      `the judgment arm stopped asking after ${stopped.after} failures in a row (${stopped.reason}), ` +
        `so ${stopped.notSent} more paragraphs were never sent. The answers received before that are in this verdict.`,
    );
  }
  return lines;
}

function report(
  deps: CliDeps,
  options: Options,
  threshold: number,
  flags: readonly Flag[],
  verdict: string,
  judgment: JudgmentSummary,
): void {
  if (options.format === "json") {
    deps.write(
      JSON.stringify({ tool: "snifftest check", threshold, verdict, judgment, flags }, null, 2),
    );
    return;
  }
  for (const flag of flags) {
    deps.write(
      `${flag.file}:${flag.line} ${flag.rule} ${flag.probability.toFixed(2)} ${flag.message}`,
    );
  }
}

function usageLine(usage: JudgmentUsage): string {
  const requests = usage.requests === 1 ? "1 request" : `${usage.requests} requests`;
  const retries = usage.retries === 0 ? "" : `, ${usage.retries} retried`;
  // Said in the same line as the bill, because the difference between sixty
  // requests and six hundred is usually the cache and not the draft.
  const cached =
    usage.cached === 0
      ? ""
      : `, ${usage.cached} ${usage.cached === 1 ? "paragraph" : "paragraphs"} answered from the cache and not paid for again`;
  return `${requests}, ${usage.inputTokens} input tokens, $${usage.estimatedCostUsd.toFixed(6)}, ${usage.latencyMs} ms${retries}${cached}.`;
}

// --- eval -----------------------------------------------------------------

/**
 * Measure the checker on the caller's own clean writing.
 *
 * The order is the same promise `check` makes: the corpus is seeded and the two
 * offline arms run before anything could leave the machine, so a refused
 * consent still leaves a complete seeded corpus and two arms of numbers on
 * disk. `--dry-run` is that path taken deliberately.
 */
async function evaluate(deps: CliDeps, options: Options): Promise<number> {
  const resolved = resolveRuleset({
    cwd: deps.cwd,
    ...(options.rulesPath === undefined ? {} : { rulesPath: options.rulesPath }),
    ...(deps.defaultRulesPath === undefined ? {} : { defaultRulesPath: deps.defaultRulesPath }),
  });
  const ruleset = resolved.ruleset;
  warnAbout(deps, resolved);
  const threshold = options.threshold ?? ruleset.threshold ?? DEFAULT_THRESHOLD;

  // `--twins` measures what one injected sentence moves, rather than seeding a
  // corpus, so it takes over the whole command before any corpus is read.
  if (options.twins !== undefined) return await evaluateTwins(deps, options, ruleset, options.twins);

  // A stranger who installed the package has no corpus of this project's own on
  // disk, and the seeded corpus is what makes the numbers reproducible. So a
  // run with no paths uses the one that ships, and says that it did.
  const shipped = options.paths.length === 0 ? packagedCorpus() : undefined;
  if (shipped !== undefined) {
    deps.writeError(`no paths given, so the corpus that ships with this install was used: ${shipped}`);
  }
  const files = collectFiles(deps, shipped === undefined ? options.paths : [shipped]);
  const candidates: BaseDocument[] = [];
  for (const draft of readDrafts(deps, files)) {
    for (const chunk of chunkDocument(draft.text, draft.shown, { maxChars: STATE_GUARD_CHARS })) {
      candidates.push({
        id: `C${String(candidates.length).padStart(2, "0")}`,
        file: chunk.file,
        line: chunk.line,
        text: chunk.text,
      });
    }
  }
  if (candidates.length === 0) throw new UsageError("those paths hold no paragraphs to seed.");

  const judgmentRules = ruleset.rules.filter(isJudgmentRule);
  const wantsNetwork = !options.dryRun && judgmentRules.length > 0;
  const runDate = today();
  const asked = options.outDir ?? join("bench", "results", runDate);
  const outDir = isAbsolute(asked) ? asked : resolve(deps.cwd, asked);

  let client: JevClient | undefined;
  if (wantsNetwork) {
    const key = deps.env[KEY_ENV];
    if (key === undefined || key.trim() === "") {
      deps.writeError(
        `${KEY_ENV} is not set, so arm C cannot run. Export it, or use --dry-run for arms A and B.`,
      );
      return EXIT.failure;
    }

    const consent = await requestConsent({
      env: deps.env,
      homedir: deps.homedir,
      assumeYes: options.assumeYes,
      isTty: deps.isTty,
      ruleIds: judgmentRules.map((rule) => rule.id),
      fileCount: files.length,
      say: deps.writeError,
      ...(deps.prompt === undefined ? {} : { prompt: deps.prompt }),
    });
    if (!consent.granted) return EXIT.consent;

    client = (deps.createClient ?? createJevClient)({ apiKey: key });
  }

  const bank = loadSeedBank(deps, options);

  const runOptions: RunEvalOptions = {
    ruleset,
    candidates,
    threshold,
    ...(options.seedVersion === undefined ? {} : { seedVersion: options.seedVersion }),
    ...(bank === undefined ? {} : { bank }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.perRule === undefined ? {} : { perRule: options.perRule }),
    ...(client === undefined ? {} : { client }),
  };

  let outcome;
  try {
    outcome = await runEval(runOptions);
  } catch (error) {
    if (error instanceof SeedError) {
      deps.writeError(`the corpus could not be seeded: ${messageOf(error)}`);
      return EXIT.failure;
    }
    throw error;
  }

  const report = buildReport(outcome, {
    runDate,
    threshold,
    rulesetSources: resolved.sources.map((file) => display(file, deps.cwd)),
    corpusPaths: files.map((file) => display(file, deps.cwd)),
  });
  const written = writeReport(report, outcome, outDir);

  if (options.format === "json") {
    deps.write(JSON.stringify(report, null, 2));
  } else {
    for (const line of evalSummary(report, written, deps.cwd)) deps.write(line);
  }

  for (const failure of outcome.failures) {
    deps.writeError(`request failed on ${failure.doc}: ${failure.reason}`);
  }

  // A run that asked for a judgment arm and got nothing usable back has
  // measured nothing. Its tables would print a recall of zero for every
  // judgment rule, which reads as a rule that never fires rather than a
  // service that never answered, so the exit code says so instead.
  const judgment = outcome.judgment;
  if (judgment !== undefined && judgment.answered === 0) {
    deps.writeError(
      `the judgment arm sent ${judgment.sent} paragraphs and got no usable answer to any of ` +
        `them${judgment.stopped === null ? "" : ` (${judgment.stopped})`}, so nothing about the ` +
        "judgment rules was measured. The tables hold the countable arms only.",
    );
    return EXIT.failure;
  }
  return EXIT.ok;
}

/**
 * The bank of faults, or the ruleset's own lists.
 *
 * `eval` and a bare `bench` both seed a corpus and must seed it the same way,
 * or a bench row and an eval row describe two different corpora under one
 * table. A named bank that will not read is the caller's mistake; a missing
 * packaged one is a fact about the installation, and the run says which faults
 * it used instead.
 */
function loadSeedBank(deps: CliDeps, options: Options): SeedBank | undefined {
  if ((options.seedVersion ?? 2) !== 2) return undefined;
  const path = options.bankPath ?? packagedBankPath();
  try {
    return readBank(path, deps.cwd);
  } catch (error) {
    if (!(error instanceof BankError)) throw error;
    if (options.bankPath !== undefined) throw new UsageError(messageOf(error));
    deps.writeError(
      "no seed bank ships with this install, so the faults come from the ruleset's own lists.",
    );
    return undefined;
  }
}

/**
 * The injection bar, measured rather than asserted.
 *
 * `examples/CORPUS.md` claims a number: an added sentence written to the
 * checker must not move any probability by more than the bar. This is the
 * command that checks it. Every reading is printed, including the ones well
 * under the bar, because a bar with only its failures shown is a bar nobody
 * can audit.
 */
async function evaluateTwins(
  deps: CliDeps,
  options: Options,
  ruleset: Ruleset,
  directory: string,
): Promise<number> {
  const judgmentRules = ruleset.rules.filter(isJudgmentRule);
  if (judgmentRules.length === 0) {
    deps.writeError("this ruleset has no judgment rules, so there is nothing an injection could move.");
    return EXIT.failure;
  }

  let manifest;
  try {
    manifest = readManifest(directory, deps.cwd);
  } catch (error) {
    if (error instanceof TwinError) {
      deps.writeError(messageOf(error));
      return EXIT.failure;
    }
    throw error;
  }

  const key = deps.env[KEY_ENV];
  if (key === undefined || key.trim() === "") {
    deps.writeError(`${KEY_ENV} is not set, so no paragraph can be asked about.`);
    return EXIT.failure;
  }

  const consent = await requestConsent({
    env: deps.env,
    homedir: deps.homedir,
    assumeYes: options.assumeYes,
    isTty: deps.isTty,
    ruleIds: judgmentRules.map((rule) => rule.id),
    fileCount: manifest.pairs.length * 2,
    say: deps.writeError,
    ...(deps.prompt === undefined ? {} : { prompt: deps.prompt }),
  });
  if (!consent.granted) return EXIT.consent;

  const run = await compareTwins({
    pairs: manifest.pairs,
    root: manifest.root,
    rules: judgmentRules,
    client: (deps.createClient ?? createJevClient)({ apiKey: key }),
  });

  if (options.format === "json") {
    deps.write(JSON.stringify({ tool: "snifftest eval --twins", ...run }, null, 2));
  } else {
    deps.write(`The bar is ${run.bar}: no probability may move further than that.`);
    deps.write("");
    for (const row of run.readings) {
      const moved = row.delta === null ? "unanswered" : row.delta.toFixed(3);
      const note = row.injected ? "  (the paragraph the sentence was added to)" : row.over_bar ? "  OVER THE BAR" : "";
      deps.write(
        `${row.pair} paragraph ${row.paragraph} ${row.rule.padEnd(20)} ` +
          `${format(row.original)} to ${format(row.adversarial)}, moved ${moved}${note}`,
      );
    }
    deps.write("");
    deps.write(
      run.findings.length === 0
        ? `Nothing moved further than ${run.bar} outside the paragraph each sentence was added to.`
        : `${run.findings.length} readings moved further than ${run.bar}.`,
    );
    if (run.unanswered > 0) deps.write(`${run.unanswered} readings came back unanswered.`);
  }

  for (const row of run.unusable) deps.writeError(`${row.pair} could not be compared: ${row.reason}`);
  if (run.unusable.length > 0) return EXIT.failure;
  return run.findings.length > 0 ? EXIT.flags : EXIT.ok;
}

/** A probability, or the word for not having one. */
function format(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function evalSummary(
  report: ReturnType<typeof buildReport>,
  written: WrittenReport,
  cwd: string,
): string[] {
  const at = String(report.threshold);
  const lines = [
    `seeded ${report.corpus.seeded} paragraphs from ${report.corpus.clean} clean ones ` +
      `(${report.corpus.dropped} dropped), ${report.per_rule} per rule, seed ${report.seed}`,
    "",
  ];

  for (const arm of Object.values(report.arms)) {
    const overall = arm.overall[at];
    const judgment = overall?.judgment;
    const cost =
      arm.summary.usd_per_100_paragraphs === null
        ? "cost unmeasured"
        : `$${arm.summary.usd_per_100_paragraphs.toFixed(4)} per 100 paragraphs`;
    lines.push(
      `arm ${arm.arm} ${arm.label.replace(/^[ABC] /, "").padEnd(34)} ` +
        `judgment ${judgment === undefined || judgment.positives === 0 ? "n/a" : `${judgment.hits} of ${judgment.positives}`}  ` +
        `countable ${countedOf(overall?.countable)}  ` +
        `false alarms ${overall === undefined ? "n/a" : `${overall.fp_clean_paragraphs} of ${overall.clean_paragraphs} paragraphs`}  ` +
        `median ${arm.summary.median_latency_ms.toFixed(0)} ms  ${cost}`,
    );
  }

  for (const row of report.corpus.skipped) lines.push(`skipped ${row.rule}: ${row.reason}`);
  // Both files are named, because one of them is the report and the other is
  // every paragraph of the corpus in full. A user should learn where their
  // prose was written from the run that wrote it, not from a later look around.
  lines.push("", `wrote ${display(written.markdown, cwd)}`);
  lines.push(
    `wrote ${display(dirname(written.cleanInputs), cwd)}, which holds the paragraphs in full; ` +
      "the directory carries a .gitignore so they are not committed by accident",
  );
  return lines;
}

/** A rate to two places, or n/a. Used by the bench summary, which prints rates. */
function fixed(value: number | null | undefined): string {
  return value === null || value === undefined ? " n/a" : value.toFixed(2);
}

/** k of n, or n/a. A summary line never prints a rate without its counts. */
function countedOf(score: { hits: number; positives: number } | undefined): string {
  return score === undefined || score.positives === 0 ? "n/a" : `${score.hits} of ${score.positives}`;
}

// --- bench ----------------------------------------------------------------

/** How many times each document is asked of each model, for the latency spread. */
export const DEFAULT_REPEATS = 3;

const DESTINATIONS: Readonly<Record<Provider, Destination>> = {
  openrouter: {
    name: "OpenRouter",
    endpoint: OPENROUTER_CHAT_ENDPOINT,
    keyEnv: OPENROUTER_KEY_ENV,
  },
  anthropic: {
    name: "Anthropic",
    endpoint: ANTHROPIC_MESSAGES_ENDPOINT,
    keyEnv: ANTHROPIC_KEY_ENV,
  },
  // The judgment arm's own service, in the panel rotation rather than joined in
  // from another run, so that one latency column is one measurement.
  jev: TYPESAFE_DESTINATION,
};

/**
 * Ask the panel the same questions the judgment rules ask.
 *
 * The order is the same promise the rest of the tool makes: the panel is
 * resolved and printed before anything is sent, and `--dry-run` stops there.
 * Nothing is substituted for a model the provider does not list, and no row is
 * dropped in silence: a provider with no key in the environment becomes a row
 * that says so.
 */
async function bench(deps: CliDeps, options: Options): Promise<number> {
  const resolvedRules = resolveRuleset({
    cwd: deps.cwd,
    ...(options.rulesPath === undefined ? {} : { rulesPath: options.rulesPath }),
    ...(deps.defaultRulesPath === undefined ? {} : { defaultRulesPath: deps.defaultRulesPath }),
  });
  const ruleset = resolvedRules.ruleset;
  warnAbout(deps, resolvedRules);
  const threshold = options.threshold ?? ruleset.threshold ?? DEFAULT_THRESHOLD;
  const runDate = today();

  const panelFile = panelPath(deps, options);
  const panel = parsePanel(readDraft(panelFile), display(panelFile, deps.cwd));

  const priceTables = new Map<Provider, PriceTable>();
  for (const [provider, relative] of Object.entries(panel.prices)) {
    // The panel parser has already refused any other name, so this only ever
    // skips a key that could not have been looked up again anyway.
    if (!isProvider(provider)) continue;
    const file = at(relative, dirname(panelFile));
    priceTables.set(provider, parsePriceTable(readDraft(file), display(file, deps.cwd)));
  }

  const keys: Record<Provider, string> = {
    openrouter: (deps.env[OPENROUTER_KEY_ENV] ?? "").trim(),
    anthropic: (deps.env[ANTHROPIC_KEY_ENV] ?? "").trim(),
    jev: (deps.env[KEY_ENV] ?? "").trim(),
  };
  const secrets = [keys.openrouter, keys.anthropic, (deps.env[KEY_ENV] ?? "").trim()].filter(
    (key) => key !== "",
  );

  const wanted = new Set(panel.models.map((model) => model.provider));
  const adapters: Partial<Record<Provider, ModelAdapter>> = {};
  for (const provider of wanted) {
    if (keys[provider] === "") continue;
    const adapterOptions = {
      apiKey: keys[provider],
      secrets,
      ...(deps.fetchLike === undefined ? {} : { fetch: deps.fetchLike }),
    };
    adapters[provider] =
      provider === "openrouter"
        ? createOpenRouterAdapter(adapterOptions)
        : provider === "anthropic"
          ? createAnthropicAdapter(adapterOptions)
          : createJevAdapter({
              client: (deps.createClient ?? createJevClient)({
                apiKey: keys.jev,
                ...(deps.fetchLike === undefined ? {} : { fetch: deps.fetchLike }),
              }),
              rules: ruleset.rules.filter(isJudgmentRule),
              threshold,
            });
  }

  /** The panel against whatever catalogues are known by the time it is called. */
  const resolvedPanel = (): ResolvedModel[] =>
    resolvePanel(panel, catalogs, (model) => ({
      runDate,
      catalogPriceSource: model.provider === "openrouter" ? OPENROUTER_PRICE_SOURCE : undefined,
      priceLookup: (served: string) => {
        const table = priceTables.get(model.provider);
        return table === undefined ? undefined : priceFor(table, served);
      },
    }));

  // The catalogues.
  //
  // Reading a provider's model list is an ordinary authenticated request: it
  // carries the key, it tells that company a run is happening, and it is not
  // a model call, which is the only part of it the old ordering noticed. So it
  // sits behind the same two gates everything else does. A dry run does not
  // make it at all, and a real run asks first.
  //
  // A recorded payload is read from disk either way, which is how a dry run
  // still resolves the panel with no network in it.
  const catalogs: Partial<Record<Provider, readonly CatalogEntry[]>> = {};
  const catalogNotes: string[] = [];
  const recorded = options.modelsPath !== undefined;

  if (options.modelsPath !== undefined) {
    const file = at(options.modelsPath, deps.cwd);
    const payload = asRecord(JSON.parse(readDraft(file))) ?? {};
    const openrouter = payload["data"] !== undefined ? payload : payload["openrouter"];
    if (openrouter !== undefined) catalogs.openrouter = readOpenRouterCatalog(openrouter);
    if (payload["anthropic"] !== undefined) {
      catalogs.anthropic = readAnthropicCatalog(payload["anthropic"]);
    }
    // The judgment service publishes no model list, so there is nothing to
    // record and nothing to read: its one model is a constant, and no network
    // call is made to learn it.
    if (adapters.jev !== undefined) catalogs.jev = jevCatalog();
    catalogNotes.push(`model lists read from ${display(file, deps.cwd)}, not from the providers`);
  }

  if (options.dryRun) {
    if (!recorded) {
      catalogNotes.push(
        "--dry-run makes no request of any kind, so no model list was read and no row was checked " +
          "against a provider. Record one with --models <file> to resolve the panel offline.",
      );
    }
    for (const line of panelLines(resolvedPanel(), catalogNotes)) deps.write(line);
    deps.write("");
    deps.write("--dry-run: the panel above is as far as this goes and no model was called.");
    return EXIT.ok;
  }

  // --- the corpus, which must be the eval's own
  //
  // Before the question rather than after it: a run that cannot work should not
  // talk anyone into agreeing to requests it was never going to make.
  const corpus = benchCorpus(deps, options, ruleset);
  if (corpus.documents.length === 0) {
    throw new UsageError("that corpus holds no paragraphs to judge.");
  }

  const reachable = [...wanted].filter((provider) => adapters[provider] !== undefined);
  for (const provider of wanted) {
    if (adapters[provider] === undefined) {
      catalogNotes.push(`${DESTINATIONS[provider].keyEnv} is not set, so ${provider} rows cannot run`);
    }
  }
  if (!recorded && reachable.length === 0) {
    deps.writeError("no model in the panel could be run, so nothing was sent.");
    return EXIT.failure;
  }

  // Every provider the panel names and a key exists for, because every one of
  // them is about to be sent a request, starting with the model list.
  const destinations = reachable.map((provider) => DESTINATIONS[provider]);
  const consent = await requestConsent({
    env: deps.env,
    homedir: deps.homedir,
    assumeYes: options.assumeYes,
    isTty: deps.isTty,
    ruleIds: ruleset.rules.filter(isJudgmentRule).map((rule) => rule.id),
    fileCount: corpus.documents.length,
    destinations,
    say: deps.writeError,
    ...(deps.prompt === undefined ? {} : { prompt: deps.prompt }),
  });
  if (!consent.granted) return EXIT.consent;

  if (!recorded) {
    for (const provider of reachable) {
      // SAFETY: `reachable` is exactly the providers an adapter was built for.
      const adapter = adapters[provider] as ModelAdapter;
      try {
        catalogs[provider] = await adapter.listModels();
      } catch (error) {
        catalogNotes.push(`the ${provider} model list could not be read: ${messageOf(error)}`);
      }
    }
  }

  const resolved = resolvedPanel();
  for (const line of panelLines(resolved, catalogNotes)) deps.write(line);

  const runnable = resolved.filter((model) => model.available);
  if (runnable.length === 0) {
    deps.writeError("no model in the panel could be run, so nothing was sent.");
    return EXIT.failure;
  }

  const outcome = await runBench({
    ruleset,
    documents: corpus.documents,
    resolved,
    adapters,
    repeats: options.repeats ?? DEFAULT_REPEATS,
    threshold,
    runDate,
    onProgress: (note) => deps.writeError(note),
  });

  const priceSources = [
    ...(catalogs.openrouter === undefined ? [] : [OPENROUTER_PRICE_SOURCE]),
    ...[...priceTables.values()].map((table) => priceCitation(table)),
  ];

  const report = buildBenchReport(outcome, {
    runDate,
    threshold,
    repeats: options.repeats ?? DEFAULT_REPEATS,
    panelFile: display(panelFile, deps.cwd),
    priceSources,
    corpus: corpus.counts,
    ...(corpus.joined === undefined ? {} : { joined: corpus.joined }),
    ...(corpus.evalSource === undefined ? {} : { evalSource: corpus.evalSource }),
  });

  const outDir = at(options.outDir ?? corpus.defaultOutDir ?? join("bench", "results", runDate), deps.cwd);
  const written = writeBenchReport(report, outcome, outDir);

  if (options.format === "json") {
    deps.write(JSON.stringify(report, null, 2));
  } else {
    deps.write("");
    for (const model of report.models) {
      deps.write(
        `${model.id.padEnd(16)} ${
          model.available
            ? `${(model.served_model ?? model.slug ?? "").padEnd(34)} ` +
              `recall ${fixed(model.accuracy?.overall[String(threshold)]?.recall)}  ` +
              `median ${Math.round(model.latency.median_ms)} ms  ` +
              `${model.cost.usd_per_100_paragraphs === null ? "cost unknown" : `$${model.cost.usd_per_100_paragraphs.toFixed(4)} per 100 paragraphs`}`
            : (model.note ?? "not available")
        }`,
      );
    }
    deps.write("");
    deps.write(`wrote ${display(written.markdown, deps.cwd)}`);
  }

  return EXIT.ok;
}

/**
 * The panel file: the one named, the one in this directory, or the one shipped.
 *
 * `bench` used to look only in the working directory, so the command worked
 * from a clone of this repo and nowhere else. The panel is configuration rather
 * than data, so falling back to the copy inside the package is honest, and the
 * run says which file it read.
 */
function panelPath(deps: CliDeps, options: Options): string {
  if (options.panelPath !== undefined) return at(options.panelPath, deps.cwd);
  const here = at(join("bench", "panel.yaml"), deps.cwd);
  if (existsSync(here)) return here;
  const shipped = packagedPath("bench", "panel.yaml");
  if (existsSync(shipped)) return shipped;
  throw new UsageError(
    `no panel file: there is no ${display(here, deps.cwd)} and none shipped with this install. Name one with --panel <file>.`,
  );
}

/** The seeded corpus that ships in the package, for a run outside a clone. */
function packagedCorpus(): string | undefined {
  const corpus = packagedPath("examples", "corpus");
  return existsSync(corpus) ? corpus : undefined;
}

interface BenchCorpus {
  readonly documents: readonly BenchDocument[];
  readonly counts: { clean: number; seeded: number; seed: number; perRule: number };
  readonly joined?: readonly JoinedArm[];
  readonly evalSource?: string;
  readonly defaultOutDir?: string;
}

/**
 * The corpus arm D judges.
 *
 * Reusing the eval's own written corpus is the point: the headline table joins
 * arm C's numbers to arm D's, and two runs over two corpora would produce a
 * table whose rows cannot be compared. Seeding from paths is the standalone
 * form, for someone benching their own rules on their own writing.
 */
function benchCorpus(deps: CliDeps, options: Options, ruleset: Ruleset): BenchCorpus {
  if (options.evalDir !== undefined) {
    if (options.paths.length > 0) {
      throw new UsageError("give bench either --eval <dir> or some paths, not both.");
    }
    return fromEvalDirectory(deps, options, ruleset);
  }

  if (options.paths.length === 0) {
    const shipped = packagedCorpus();
    throw new UsageError(
      "snifftest bench needs a corpus: either --eval <dir> (an eval results directory, whose " +
        "arms are joined into the table) or one or more files to seed" +
        (shipped === undefined
          ? "."
          : `. The corpus this project benches with ships with the install, at ${shipped}.`),
    );
  }

  const files = collectFiles(deps, options.paths);
  const candidates: BaseDocument[] = [];
  for (const draft of readDrafts(deps, files)) {
    for (const chunk of chunkDocument(draft.text, draft.shown, { maxChars: STATE_GUARD_CHARS })) {
      candidates.push({
        id: `C${String(candidates.length).padStart(2, "0")}`,
        file: chunk.file,
        line: chunk.line,
        text: chunk.text,
      });
    }
  }

  const bank = loadSeedBank(deps, options);
  const seeded = seedCorpus(candidates, ruleset, {
    ...(options.seedVersion === undefined ? {} : { seedVersion: options.seedVersion }),
    ...(bank === undefined ? {} : { bank }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.perRule === undefined ? {} : { perRule: options.perRule }),
  });

  return {
    documents: [
      ...seeded.clean.map((doc) => ({ id: doc.id, kind: "clean" as const, text: doc.text })),
      // The near misses are clean paragraphs, and the hardest ones in the
      // corpus. A bench that left them out would measure every arm on the easy
      // half of the false-alarm question.
      ...seeded.negatives.map((doc) => ({ id: doc.id, kind: "clean" as const, text: doc.text })),
      ...seeded.seeded.map((doc) => ({
        id: doc.id,
        kind: "seeded" as const,
        truth: doc.rule,
        text: doc.text,
      })),
    ],
    counts: {
      clean: seeded.clean.length + seeded.negatives.length,
      seeded: seeded.seeded.length,
      seed: seeded.seedValue,
      perRule: seeded.perRule,
    },
  };
}

function fromEvalDirectory(deps: CliDeps, options: Options, ruleset: Ruleset): BenchCorpus {
  const dir = at(options.evalDir ?? "", deps.cwd);
  const clean = readJson(join(dir, "inputs", "clean.json"));
  const seeded = readJson(join(dir, "inputs", "seeded.json"));
  const scores = readJson(join(dir, "scores.json"));
  // Older results directories have no negatives file. They are still joinable;
  // the bench simply sees the corpus that run saw.
  const negativesPath = join(dir, "inputs", "negatives.json");
  const negatives = existsSync(negativesPath) ? readJson(negativesPath) : {};

  const classes = scores["classes"];
  const ours = ruleset.rules.map((rule) => rule.id);
  if (!Array.isArray(classes) || classes.join("|") !== ours.join("|")) {
    throw new UsageError(
      `${display(dir, deps.cwd)} was run against a different ruleset, so its arms cannot be joined ` +
        "to this one. Re-run eval with the same rules, or drop --eval.",
    );
  }

  const documents: BenchDocument[] = [
    ...paragraphsOf(clean).map((doc) => ({ id: doc.id, kind: "clean" as const, text: doc.text })),
    ...paragraphsOf(negatives).map((doc) => ({ id: doc.id, kind: "clean" as const, text: doc.text })),
    ...paragraphsOf(seeded).map((doc) => ({
      id: doc.id,
      kind: "seeded" as const,
      ...(doc.rule === undefined ? {} : { truth: doc.rule }),
      text: doc.text,
    })),
  ];

  return {
    documents,
    counts: {
      clean: documents.filter((doc) => doc.kind === "clean").length,
      seeded: documents.filter((doc) => doc.kind === "seeded").length,
      seed: numberOf(scores["seed"]),
      perRule: numberOf(scores["per_rule"]),
    },
    joined: joinedArms(scores),
    evalSource: display(join(dir, "scores.json"), deps.cwd),
    defaultOutDir: dir,
  };
}

function joinedArms(scores: Record<string, unknown>): JoinedArm[] {
  const arms = asRecord(scores["arms"]);
  if (arms === null) return [];
  const at = String(numberOf(scores["threshold"]));

  // Only the arms that made a call carry a model; the others say so with a dash
  // rather than borrowing the run's model string for a row it did not produce.
  const servedName = scores["served_model"];
  const served = typeof servedName === "string" ? servedName : null;

  const out: JoinedArm[] = [];
  for (const [id, value] of Object.entries(arms)) {
    const arm = asRecord(value);
    if (arm === null) continue;
    const overall = asRecord(asRecord(arm["overall"])?.[at]);
    const summary = asRecord(arm["summary"]);
    out.push({
      arm: id,
      label: typeof arm["label"] === "string" ? arm["label"] : id,
      recall: ratioOf(overall?.["recall"]),
      judgmentRecall: ratioOf(asRecord(overall?.["judgment"])?.["recall"]),
      fpPerCleanCell: ratioOf(overall?.["fp_rate_per_clean_cell"]),
      fpCleanParagraphs: ratioOf(overall?.["fp_clean_paragraphs"]),
      cleanParagraphs: ratioOf(overall?.["clean_paragraphs"]),
      medianMs: numberOf(summary?.["median_latency_ms"]),
      // The eval used to write this per 100 documents, which was always per 100
      // paragraphs. An older results directory is still read under its old key.
      usdPer100Paragraphs: ratioOf(
        summary?.["usd_per_100_paragraphs"] ?? summary?.["usd_per_100_documents"],
      ),
      servedModel: arm["network"] === true ? served : null,
    });
  }
  return out;
}

function panelLines(resolved: readonly ResolvedModel[], notes: readonly string[]): string[] {
  const lines = ["panel", ""];

  for (const model of resolved) {
    const price =
      model.prices === null
        ? "price unknown"
        : `$${(model.prices.inputUsdPerToken * 1e6).toFixed(2)} in / $${(
            model.prices.outputUsdPerToken * 1e6
          ).toFixed(2)} out per million tokens`;
    lines.push(
      `  ${model.entry.id.padEnd(16)} ${model.entry.tier.padEnd(8)} ` +
        (model.available ? `${(model.slug ?? "").padEnd(34)} ${price}` : (model.note ?? "not available")),
    );
    if (model.candidates.length > 1) {
      lines.push(`  ${"".padEnd(16)} also matched: ${model.candidates.filter((id) => id !== model.slug).join(", ")}`);
    }
  }

  if (notes.length > 0) {
    lines.push("");
    for (const note of notes) lines.push(`  note: ${note}`);
  }
  return lines;
}

function paragraphsOf(doc: Record<string, unknown>): { id: string; text: string; rule?: string }[] {
  const paragraphs = doc["paragraphs"];
  if (!Array.isArray(paragraphs)) return [];

  const out: { id: string; text: string; rule?: string }[] = [];
  for (const value of paragraphs) {
    const record = asRecord(value);
    if (record === null) continue;
    const id = record["id"];
    const text = record["text"];
    if (typeof id !== "string" || typeof text !== "string") continue;
    out.push({ id, text, ...(typeof record["rule"] === "string" ? { rule: record["rule"] } : {}) });
  }
  return out;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = asRecord(JSON.parse(readFileSync(file, "utf8")));
    if (parsed === null) throw new Error("it is not a JSON object");
    return parsed;
  } catch (error) {
    throw new UsageError(`${file} could not be read (${messageOf(error)})`);
  }
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ratioOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** An absolute path, from something a person typed. */
function at(path: string, from: string): string {
  return isAbsolute(path) ? path : resolve(from, path);
}

/** The run date, in the one format the results directory is named with. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- rules ----------------------------------------------------------------

function rules(deps: CliDeps, options: Options): number {
  const resolved = resolveRuleset({
    cwd: deps.cwd,
    ...(options.rulesPath === undefined ? {} : { rulesPath: options.rulesPath }),
    ...(deps.defaultRulesPath === undefined ? {} : { defaultRulesPath: deps.defaultRulesPath }),
  });
  warnAbout(deps, resolved);

  if (options.format === "json") {
    deps.write(
      JSON.stringify(
        { sources: resolved.sources.map((file) => display(file, deps.cwd)), ruleset: resolved.ruleset },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }

  for (const file of resolved.sources) deps.write(display(file, deps.cwd));
  deps.write("");
  deps.write(`threshold ${(resolved.ruleset.threshold ?? DEFAULT_THRESHOLD).toFixed(2)}`);
  const off = resolved.ruleset.off_by_default ?? [];
  if (off.length > 0) deps.write(`off by default, unless --only names one: ${off.join(", ")}`);
  for (const rule of resolved.ruleset.rules) {
    const how = rule.kind === "regex" ? (rule.source === "builtin" ? rule.builtin : "pattern") : "jev";
    const tags = rule.tags ?? [];
    const sitsOut = tags.some((tag) => off.includes(tag)) ? "  (off by default)" : "";
    const shown = tags.length === 0 ? "" : `  [${tags.join(", ")}]`;
    deps.write(`  ${rule.id.padEnd(22)} ${rule.kind.padEnd(9)} ${how}${shown}${sitsOut}`);
  }
  return EXIT.ok;
}

// --- arguments ------------------------------------------------------------

function parseArgs(argv: readonly string[]): Options {
  const first = argv[0];
  if (first === undefined) throw new UsageError("say what to do: snifftest check <paths...>");
  if (!isCommand(first)) throw new UsageError(`unknown command "${first}". Try snifftest --help.`);

  const paths: string[] = [];
  let rulesPath: string | undefined;
  let threshold: number | undefined;
  let format: "text" | "json" = "text";
  let dryRun = false;
  let assumeYes = false;
  let endOfOptions = false;
  let seed: number | undefined;
  let perRule: number | undefined;
  let twins: string | undefined;
  let noCache = false;
  let seedVersion: 1 | 2 | undefined;
  let bankPath: string | undefined;
  let outDir: string | undefined;
  let panelPath: string | undefined;
  let modelsPath: string | undefined;
  let evalDir: string | undefined;
  let repeats: number | undefined;
  let only: string[] | undefined;
  let skip: string[] | undefined;
  let root: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const argument = argv[i] ?? "";

    if (endOfOptions || !argument.startsWith("-")) {
      paths.push(argument);
      continue;
    }

    switch (argument) {
      case "--":
        endOfOptions = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--no-cache":
        noCache = true;
        break;
      case "--yes":
      case "-y":
        assumeYes = true;
        break;
      case "--rules":
        rulesPath = valueFor(argv, ++i, "--rules");
        break;
      case "--format":
        format = formatValue(valueFor(argv, ++i, "--format"));
        break;
      case "--threshold":
        threshold = thresholdValue(valueFor(argv, ++i, "--threshold"));
        break;
      case "--seed":
        seed = wholeNumber(valueFor(argv, ++i, "--seed"), "--seed", 0);
        break;
      case "--seed-version": {
        const asked = wholeNumber(valueFor(argv, ++i, "--seed-version"), "--seed-version", 1);
        if (asked !== 1 && asked !== 2) {
          throw new UsageError("--seed-version is 1 (the ruleset's own faults) or 2 (the seed bank).");
        }
        seedVersion = asked;
        break;
      }
      case "--seed-bank":
        bankPath = valueFor(argv, ++i, "--seed-bank");
        break;
      case "--twins":
        twins = valueFor(argv, ++i, "--twins");
        break;
      case "--per-rule":
        perRule = wholeNumber(valueFor(argv, ++i, "--per-rule"), "--per-rule", 1);
        break;
      case "--out":
        outDir = valueFor(argv, ++i, "--out");
        break;
      case "--panel":
        panelPath = valueFor(argv, ++i, "--panel");
        break;
      case "--models":
        modelsPath = valueFor(argv, ++i, "--models");
        break;
      case "--eval":
        evalDir = valueFor(argv, ++i, "--eval");
        break;
      case "--repeats":
        repeats = wholeNumber(valueFor(argv, ++i, "--repeats"), "--repeats", 1);
        break;
      case "--only":
        only = tagList(valueFor(argv, ++i, "--only"), "--only");
        break;
      case "--skip":
        skip = tagList(valueFor(argv, ++i, "--skip"), "--skip");
        break;
      case "--root":
        root = valueFor(argv, ++i, "--root");
        break;
      default:
        throw new UsageError(`unknown option "${argument}". Try snifftest --help.`);
    }
  }

  // `eval` with no paths falls back to the seeded corpus that ships with the
  // package, so the command works from an install and not only from a clone.
  // `check` has no such fallback: there is no draft of someone else's to check.
  if (first === "check" && paths.length === 0) {
    throw new UsageError(`snifftest ${first} needs at least one file or directory.`);
  }

  return {
    command: first,
    paths,
    ...(rulesPath === undefined ? {} : { rulesPath }),
    ...(threshold === undefined ? {} : { threshold }),
    format,
    dryRun,
    assumeYes,
    ...(seed === undefined ? {} : { seed }),
    ...(perRule === undefined ? {} : { perRule }),
    ...(twins === undefined ? {} : { twins }),
    ...(noCache ? { noCache } : {}),
    ...(seedVersion === undefined ? {} : { seedVersion }),
    ...(bankPath === undefined ? {} : { bankPath }),
    ...(outDir === undefined ? {} : { outDir }),
    ...(panelPath === undefined ? {} : { panelPath }),
    ...(modelsPath === undefined ? {} : { modelsPath }),
    ...(evalDir === undefined ? {} : { evalDir }),
    ...(repeats === undefined ? {} : { repeats }),
    ...(only === undefined ? {} : { only }),
    ...(skip === undefined ? {} : { skip }),
    ...(root === undefined ? {} : { root }),
  };
}

function isCommand(value: string): value is Command {
  // SAFETY: widening a readonly tuple of string literals to `readonly string[]`
  // is a supertype, which `includes` needs to accept an arbitrary string.
  return (COMMANDS as readonly string[]).includes(value);
}

function valueFor(argv: readonly string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${name} needs a value.`);
  }
  return value;
}

/** A comma-separated tag list, as a person types it. */
function tagList(value: string, name: string): string[] {
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  if (tags.length === 0) throw new UsageError(`${name} needs at least one tag.`);
  return tags;
}

function formatValue(value: string): "text" | "json" {
  if (value === "text" || value === "json") return value;
  throw new UsageError(`--format takes text or json, not "${value}".`);
}

function wholeNumber(value: string, name: string, least: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < least) {
    throw new UsageError(`${name} takes a whole number of at least ${least}, not "${value}".`);
  }
  return parsed;
}

function thresholdValue(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new UsageError(`--threshold takes a number between 0 and 1, not "${value}".`);
  }
  return parsed;
}

// --- files ----------------------------------------------------------------

/**
 * The files to read, and the links that are refused instead.
 *
 * A symbolic link is a path to somewhere else, and reading one reads what it
 * points at. That is fine in your own directory and a hole in a repository
 * somebody else wrote: `docs/notes.md` can be a link to any file the person
 * running the check can read, and with the judgment pass on its contents go
 * into the request body. `readdirSync` reports a link as not-a-directory, so
 * one named `.md` used to fall straight through the extension test.
 *
 * The rule is therefore the short one: a link is never read. Not contained,
 * not resolved, not followed once. Containment would need a root, and an
 * explicitly named file has no root to be contained by; it would also have to
 * be explained, while "a link is never read" can be checked by a reader in one
 * sentence. The way to check what a link points at is to name what it points
 * at, which costs the one person who wanted that nothing.
 *
 * Each skipped link is named once, on stderr, and the run carries on. A link is
 * not a finding about anybody's prose.
 */
function collectFiles(deps: CliDeps, paths: readonly string[]): string[] {
  const found = new Set<string>();
  const skipped = new Set<string>();

  const skip = (path: string): void => {
    if (skipped.has(path)) return;
    skipped.add(path);
    deps.writeError(`${display(path, deps.cwd)} skipped, a symbolic link.`);
  };

  for (const given of paths) {
    const path = isAbsolute(given) ? given : resolve(deps.cwd, given);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      throw new UsageError(`no file or directory at ${given}`);
    }

    if (stats.isSymbolicLink()) {
      skip(path);
      continue;
    }
    if (stats.isDirectory()) {
      for (const file of walk(path, skip)) found.add(file);
    } else {
      found.add(path);
    }
  }

  if (found.size === 0) throw new UsageError("none of those paths hold a draft to check.");
  return [...found].sort();
}

function walk(directory: string, skip: (path: string) => void): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // A dot directory or a dependency tree is somebody else's prose.
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      // Only worth a line when it looks like something that would have been
      // read; a link to a directory or a binary was never a draft anyway.
      if (DRAFT_EXTENSIONS.has(extname(entry.name).toLowerCase())) skip(path);
      continue;
    }
    if (entry.isDirectory()) out.push(...walk(path, skip));
    else if (DRAFT_EXTENSIONS.has(extname(entry.name).toLowerCase())) out.push(path);
  }

  return out;
}

function readDraft(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`${file} could not be read (${messageOf(error)})`);
  }
}

/** One input file the tool could read as prose. */
interface Draft {
  readonly shown: string;
  readonly text: string;
}

/**
 * The drafts among the files given, and a line on stderr for each one that is
 * not prose at all.
 *
 * A directory of drafts collects a PDF or a screenshot sooner or later. Reading
 * one as UTF-8 does not fail, because the invalid bytes become replacement
 * characters, so the tool used to check a paragraph of mojibake, find nothing,
 * and exit 0 with no output, which reads exactly like a clean draft. Saying
 * which file was skipped is the difference between "nothing to flag" and
 * "nothing was read".
 * The exit code is unchanged: a binary file is not a finding.
 */
function readDrafts(deps: CliDeps, files: readonly string[]): Draft[] {
  const drafts: Draft[] = [];

  for (const file of files) {
    const shown = display(file, deps.cwd);
    const text = readTextOrNull(file);
    if (text === null) {
      deps.writeError(`${shown} skipped, not text.`);
      continue;
    }
    drafts.push({ shown, text });
  }

  return drafts;
}

function readTextOrNull(file: string): string | null {
  const bytes = readBytes(file);
  // A NUL byte is the same signal git uses, and it costs one pass.
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readBytes(file: string) {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new UsageError(`${file} could not be read (${messageOf(error)})`);
  }
}

/** Ruleset warnings go to stderr: they are about the config, not about a draft. */
function warnAbout(deps: CliDeps, resolved: ResolvedRuleset): void {
  for (const warning of resolved.warnings) deps.writeError(warning);
}

/** A path the reader can paste back, which means relative when it is below cwd. */
function display(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") ? path : rel;
}

// --- failures and help ----------------------------------------------------

function fail(deps: CliDeps, error: unknown): number {
  const known =
    error instanceof UsageError ||
    error instanceof ConfigError ||
    error instanceof RulesetError ||
    error instanceof PanelError ||
    error instanceof PriceError ||
    error instanceof YamlError;

  deps.writeError(known ? messageOf(error) : `snifftest could not finish: ${messageOf(error)}`);
  return EXIT.failure;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function version(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    const declared = asRecord(JSON.parse(raw))?.["version"];
    if (typeof declared === "string") return declared;
  } catch {
    // A missing package.json is not worth failing a --version over.
  }
  return "unknown";
}

function helpLines(): string[] {
  return [
    "snifftest: does the draft pass the sniff test?",
    "",
    "Usage",
    "  snifftest check <paths...>   check files or directories against the ruleset",
    "  snifftest rules              print the ruleset that would be used, and where it came from",
    "  snifftest eval <paths...>    plant one known fault per rule in your own clean text,",
    "                               run it three ways, and report what each way caught",
    "  snifftest bench              ask a panel of ordinary models the same questions, over the",
    "                               same corpus, and put cost, speed and accuracy side by side",
    "  snifftest serve              open a local page you type into, with the nose reacting;",
    "                               --replay <file> plays a recording back and sends nothing,",
    "                               --record <out.json> <drafts...> walks a draft live and",
    "                               writes the recording a replay is played from",
    "",
    "Options",
    "  --rules <path>      use this ruleset instead of .snifftest.yaml or the built-in one",
    "  --root <dir>        the tree being checked, when it is not the directory you are in;",
    "                      relative paths and the ruleset are found there, not here",
    "  --threshold <0-1>   the probability at or above which a judgment counts as a flag",
    "  --format text|json  how to print the flags (default text)",
    "  --only <tags>       ask about only the judgment rules carrying one of these tags;",
    "                      the countable rules cost nothing and keep running, and a tag",
    "                      no rule carries is an error rather than an empty run",
    "  --skip <tags>       never run a rule carrying one of these tags, countable or not",
    "  --dry-run           make no network request of any kind, whatever the command;",
    "                      for check that means the countable rules and nothing else",
    "  --no-cache          ask about every paragraph again, instead of reusing an answer",
    "                      already paid for in the last fortnight",
    "  --yes, -y           answer the send question for this run and remember the answer",
    "  --help, --version",
    "",
    "Options for eval",
    `  --seed <n>          the value every choice is derived from (default ${DEFAULT_SEED})`,
    `  --per-rule <n>      seeded paragraphs per rule (default ${DEFAULT_PER_RULE})`,
    "  --twins <dir>       compare each adversarial file with its clean original instead",
    "  --seed-bank <path>  the faults to seed from (default: the bank in the package)",
    "  --seed-version <n>  1 seeds from the ruleset's own faults, 2 from the bank (default 2)",
    "  --out <dir>         where the report is written (default bench/results/<today>)",
    "",
    "Options for bench",
    "  --panel <file>      the panel file (default bench/panel.yaml)",
    "  --eval <dir>        an eval results directory: its corpus is reused and its arms joined",
    `  --repeats <n>       how many times each document is asked of each model (default ${DEFAULT_REPEATS})`,
    "  --models <file>     a recorded models-endpoint payload, so a dry run needs no network",
    "  --dry-run           print the panel and go no further. With --models it resolves",
    "                      offline; without one, no model list is read either",
    "",
    "Environment",
    `  ${KEY_ENV}    the key the judgment rules are sent with`,
    `  ${OPENROUTER_KEY_ENV}  the key the bench panel is routed with`,
    `  ${ANTHROPIC_KEY_ENV}   the key the bench's direct overhead control uses`,
    `  ${CACHE_DIR_ENV}  where answers already paid for are kept, so a rerun after an`,
    "                      outage asks only about the paragraphs that went unanswered.",
    "                      A reply that answered nothing is never kept, so a rerun after",
    "                      a bad minute asks again. Defaults to the user's cache",
    "                      directory; a relative name is a place in the home directory;",
    "                      set it to off for none",
    "  SNIFFTEST_SEND=…    answer the send question in CI, without remembering it. It names",
    "                      the destinations it answers for, comma separated; 1 is the",
    "                      shorthand for TypeSafe, which is where check sends and nowhere else",
    "",
    "Exit codes",
    ...EXIT_RULES,
  ];
}

// --- the process ----------------------------------------------------------

export function processDeps(argv: readonly string[]): CliDeps {
  return {
    argv,
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    write: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => process.stderr.write(`${line}\n`),
    isTty: process.stdin.isTTY === true,
    prompt: async (question) => {
      // The question goes to stderr so that a piped `--format json` stays JSON.
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Run the tool against this process, and leave the exit code behind.
 *
 * This file is a library and never runs itself. `src/bin.ts` is the only entry
 * point, in development and in the published package alike, and it calls this
 * without asking any question first.
 *
 * The question it used to ask was whether `import.meta.url` matched `argv[1]`.
 * A package manager installs `node_modules/.bin/snifftest` as a symbolic link,
 * Node resolves that link for one of those and not for the other, and the
 * answer through the link was therefore no: the program ended having done
 * nothing, and exit 0 with no output is this tool's word for "nothing tripped".
 * Every install path goes through that link, so the failure arrived everywhere
 * as a clean bill of health. A file that is either a library or the program,
 * decided by which file it is rather than at run time, cannot fail that way.
 */
export async function main(): Promise<void> {
  process.exitCode = await runCli(processDeps(process.argv.slice(2)));
}

