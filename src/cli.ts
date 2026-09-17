/**
 * The command people type.
 *
 * Everything the CLI needs from the outside world arrives as `CliDeps` and it
 * returns an exit code instead of calling `process.exit`, so the whole surface
 * — argument parsing, the consent gate, the order the two arms run in, every
 * exit code — is testable without a subprocess and without a network stub that
 * has to be trusted not to fire.
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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { ConfigError, resolveRuleset } from "./config.ts";
import { type Env, requestConsent } from "./consent.ts";
import {
  type JudgmentUsage,
  chunkDocument,
  flagsFrom,
  mergeFlags,
  runJudgmentArm,
  runRegexArm,
} from "./engine.ts";
import { buildReport, writeReport } from "./eval/report.ts";
import { type RunEvalOptions, runEval } from "./eval/run.ts";
import { DEFAULT_PER_RULE, DEFAULT_SEED, SeedError, type BaseDocument } from "./eval/seed.ts";
import {
  type JevClient,
  type JevClientOptions,
  KEY_ENV,
  STATE_GUARD_CHARS,
  createJevClient,
} from "./jev.ts";
import { RulesetError } from "./rules.ts";
import { type Flag, isJudgmentRule } from "./types.ts";
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

  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return fail(deps, error);
  }

  try {
    if (options.command === "check") return await check(deps, options);
    if (options.command === "rules") return rules(deps, options);
    if (options.command === "eval") return await evaluate(deps, options);
    throw new UsageError(
      `"snifftest ${options.command}" is planned but not built yet. Today there is check, rules and eval.`,
    );
  } catch (error) {
    return fail(deps, error);
  }
}

// --- check ----------------------------------------------------------------

async function check(deps: CliDeps, options: Options): Promise<number> {
  const resolved = resolveRuleset({
    cwd: deps.cwd,
    ...(options.rulesPath === undefined ? {} : { rulesPath: options.rulesPath }),
    ...(deps.defaultRulesPath === undefined ? {} : { defaultRulesPath: deps.defaultRulesPath }),
  });
  const ruleset = resolved.ruleset;
  const threshold = options.threshold ?? ruleset.threshold ?? DEFAULT_THRESHOLD;

  const files = collectFiles(options.paths, deps.cwd);
  const chunks = files.flatMap((file) =>
    // The cap is applied on every run, dry or not, so a chunk boundary — and so
    // a reported line number — never depends on whether the network was used.
    chunkDocument(readDraft(file), display(file, deps.cwd), { maxChars: STATE_GUARD_CHARS }),
  );

  const countable = runRegexArm(chunks, ruleset);
  const judgmentRules = ruleset.rules.filter(isJudgmentRule);

  if (options.dryRun || judgmentRules.length === 0 || chunks.length === 0) {
    report(deps, options, countable);
    return exitFor(countable);
  }

  const key = deps.env[KEY_ENV];
  if (key === undefined || key.trim() === "") {
    report(deps, options, countable);
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
    report(deps, options, countable);
    return EXIT.consent;
  }

  const client = (deps.createClient ?? createJevClient)({ apiKey: key });
  let usage: JudgmentUsage;
  let flags: Flag[];
  try {
    const judged = await runJudgmentArm(chunks, ruleset, client);
    usage = judged.usage;
    flags = mergeFlags(countable, flagsFrom(judged.readings, threshold));
  } catch (error) {
    report(deps, options, countable);
    deps.writeError(`the judgment rules could not run: ${messageOf(error)}`);
    return EXIT.failure;
  }

  report(deps, options, flags);
  deps.writeError(usageLine(usage));
  return exitFor(flags);
}

function exitFor(flags: readonly Flag[]): number {
  return flags.length > 0 ? EXIT.flags : EXIT.ok;
}

function report(deps: CliDeps, options: Options, flags: readonly Flag[]): void {
  if (options.format === "json") {
    deps.write(JSON.stringify(flags, null, 2));
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
  return `${requests}, ${usage.inputTokens} input tokens, $${usage.estimatedCostUsd.toFixed(6)}, ${usage.latencyMs} ms${retries}.`;
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
  const threshold = options.threshold ?? ruleset.threshold ?? DEFAULT_THRESHOLD;

  const files = collectFiles(options.paths, deps.cwd);
  const candidates: BaseDocument[] = [];
  for (const file of files) {
    const shown = display(file, deps.cwd);
    for (const chunk of chunkDocument(readDraft(file), shown, { maxChars: STATE_GUARD_CHARS })) {
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
  const outDir = isAbsolute(options.outDir ?? "")
    ? (options.outDir as string)
    : resolve(deps.cwd, options.outDir ?? join("bench", "results", runDate));

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

  const runOptions: RunEvalOptions = {
    ruleset,
    candidates,
    threshold,
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
    for (const line of evalSummary(report, written.markdown, deps.cwd)) deps.write(line);
  }

  for (const failure of outcome.failures) {
    deps.writeError(`request failed on ${failure.doc}: ${failure.reason}`);
  }
  return EXIT.ok;
}

function evalSummary(
  report: ReturnType<typeof buildReport>,
  markdownPath: string,
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
    lines.push(
      `arm ${arm.arm} ${arm.label.replace(/^[ABC] /, "").padEnd(34)} ` +
        `recall ${fixed(overall?.recall)}  fp/cell ${fixed(overall?.fp_rate_per_clean_cell)}  ` +
        `median ${arm.summary.median_latency_ms.toFixed(0)} ms  ` +
        `$${arm.summary.usd_per_100_documents.toFixed(4)} per 100 documents`,
    );
  }

  for (const row of report.corpus.skipped) lines.push(`skipped ${row.rule}: ${row.reason}`);
  lines.push("", `wrote ${display(markdownPath, cwd)}`);
  return lines;
}

function fixed(value: number | null | undefined): string {
  return value === null || value === undefined ? "  n/a" : value.toFixed(3);
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
  for (const rule of resolved.ruleset.rules) {
    const how = rule.kind === "regex" ? (rule.source === "builtin" ? rule.builtin : "pattern") : "jev";
    deps.write(`  ${rule.id.padEnd(22)} ${rule.kind.padEnd(9)} ${how}`);
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
  let outDir: string | undefined;

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
      case "--per-rule":
        perRule = wholeNumber(valueFor(argv, ++i, "--per-rule"), "--per-rule", 1);
        break;
      case "--out":
        outDir = valueFor(argv, ++i, "--out");
        break;
      default:
        throw new UsageError(`unknown option "${argument}". Try snifftest --help.`);
    }
  }

  if ((first === "check" || first === "eval") && paths.length === 0) {
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
    ...(outDir === undefined ? {} : { outDir }),
  };
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function valueFor(argv: readonly string[], index: number, name: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${name} needs a value.`);
  }
  return value;
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

function collectFiles(paths: readonly string[], cwd: string): string[] {
  const found = new Set<string>();

  for (const given of paths) {
    const path = isAbsolute(given) ? given : resolve(cwd, given);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      throw new UsageError(`no file or directory at ${given}`);
    }

    if (stats.isDirectory()) {
      for (const file of walk(path)) found.add(file);
    } else {
      found.add(path);
    }
  }

  if (found.size === 0) throw new UsageError("none of those paths hold a draft to check.");
  return [...found].sort();
}

function walk(directory: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // A dot directory or a dependency tree is somebody else's prose.
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
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
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // A missing package.json is not worth failing a --version over.
  }
  return "unknown";
}

function helpLines(): string[] {
  return [
    "snifftest — does the draft pass the sniff test?",
    "",
    "Usage",
    "  snifftest check <paths...>   check files or directories against the ruleset",
    "  snifftest rules              print the ruleset that would be used, and where it came from",
    "  snifftest eval <paths...>    plant one known fault per rule in your own clean text,",
    "                               run it three ways, and report what each way caught",
    "",
    "Options",
    "  --rules <path>      use this ruleset instead of .snifftest.yaml or the built-in one",
    "  --threshold <0-1>   the probability at or above which a judgment counts as a flag",
    "  --format text|json  how to print the flags (default text)",
    "  --dry-run           run the countable rules only; nothing leaves the machine",
    "  --yes, -y           answer the send question for this run and remember the answer",
    "  --help, --version",
    "",
    "Options for eval",
    `  --seed <n>          the value every choice is derived from (default ${DEFAULT_SEED})`,
    `  --per-rule <n>      seeded paragraphs per rule (default ${DEFAULT_PER_RULE})`,
    "  --out <dir>         where the report is written (default bench/results/<today>)",
    "",
    "Environment",
    `  ${KEY_ENV}    the key the judgment rules are sent with`,
    "  SNIFFTEST_SEND=1    answer the send question in CI, without remembering it",
    "",
    "Exit codes",
    "  0  nothing tripped a rule",
    "  1  at least one flag at or above the threshold",
    "  2  the tool could not do its job: arguments, rules, files, or a failed request",
    "  3  the judgment rules need a yes before anything is sent, and did not get one",
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

async function main(): Promise<void> {
  process.exitCode = await runCli(processDeps(process.argv.slice(2)));
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === new URL(`file://${resolve(entry)}`).href;
  } catch {
    return false;
  }
};

if (invokedDirectly()) await main();
