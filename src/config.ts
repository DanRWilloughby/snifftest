/**
 * Finding the rules.
 *
 * Three places a ruleset can come from, in order: the one named on the command
 * line, a `.snifftest.yaml` in the working directory, and the one that ships
 * inside the package. The order is the whole feature. A team keeps its house
 * rules in the repo, a person overrides them for one run, and someone who has
 * never seen the tool gets something useful on the first command.
 *
 * `extends:` merges rule by id rather than by position, so a project file that
 * wants five colons instead of three writes the one rule it disagrees with and
 * inherits the rest. Merging by position would silently reorder a ruleset the
 * moment the base grew a rule.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateRuleset } from "./rules.ts";
import type { Rule, Ruleset } from "./types.ts";
import { type YamlValue, parseYaml } from "./yaml.ts";

/** The file a project keeps its own rules in. */
export const PROJECT_RULES_FILE = ".snifftest.yaml";

/** The same file under the other spelling, because both are written in the wild. */
export const PROJECT_RULES_ALT = ".snifftest.yml";

/** What `extends:` writes to mean the ruleset that ships with the package. */
export const DEFAULT_TOKEN = "default";

/** How deep an extends chain may go before it is a mistake rather than a design. */
const MAX_EXTENDS_DEPTH = 8;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ResolveRulesetOptions {
  readonly cwd: string;
  /** `--rules <path>`, relative to the working directory unless absolute. */
  readonly rulesPath?: string;
  /** Injected in tests; otherwise the `rules/default.yaml` inside the package. */
  readonly defaultRulesPath?: string;
}

export interface ResolvedRuleset {
  readonly ruleset: Ruleset;
  /** Every file that contributed, the nearest one first. */
  readonly sources: readonly string[];
  /**
   * Things the file said that this tool does not read. A mistyped key is
   * indistinguishable from a key we ignore on purpose, so it is named rather
   * than dropped. It is only a warning, because a strict refusal would break
   * every ruleset written against a later version of the tool.
   */
  readonly warnings: readonly string[];
}

/** Every top-level key a ruleset file may set. */
const KNOWN_KEYS: readonly string[] = [
  "version",
  "threshold",
  "off_by_default",
  "rules",
  "extends",
];

/**
 * The ruleset that ships in the package.
 *
 * One directory up from this file either way: `src/config.ts` in the repo and
 * `dist/snifftest.js` in the published package both sit beside `rules/`.
 */
export function packagedRulesPath(): string {
  return fileURLToPath(new URL("../rules/default.yaml", import.meta.url));
}

/**
 * A file that ships inside the package, named from the package root.
 *
 * `rules/default.yaml` is the anchor because it is the one packaged file whose
 * location is already load-bearing, and it sits one directory below the root in
 * both layouts: `src/config.ts` beside `rules/` in the repo, and
 * `dist/snifftest.js` beside `rules/` in the published tarball.
 */
export function packagedPath(...parts: readonly string[]): string {
  return join(dirname(packagedRulesPath()), "..", ...parts);
}

export function resolveRuleset(options: ResolveRulesetOptions): ResolvedRuleset {
  const defaultPath = options.defaultRulesPath ?? packagedRulesPath();
  const start = startingFile(options, defaultPath);
  const sources: string[] = [];
  const warnings: string[] = [];
  const ruleset = load(start, defaultPath, sources, warnings, 0);
  return { ruleset, sources, warnings };
}

/** Which tags a run wants, and which it does not. */
export interface TagSelection {
  /** Run only the rules carrying one of these tags. */
  readonly only?: readonly string[];
  /** Never run a rule carrying one of these tags. */
  readonly skip?: readonly string[];
}

export interface SelectedRules {
  readonly ruleset: Ruleset;
  /** Rule ids that sat this run out, with the tag that kept them out. */
  readonly dropped: readonly { readonly rule: string; readonly reason: string }[];
}

/**
 * The rules a run actually uses, after its tags are read.
 *
 * `--only` names what a run wants and nothing else, which is also how a tag
 * that is off by default is switched on: naming it is asking for it. Without
 * `--only`, everything runs except the tags the ruleset sits out and the tags
 * `--skip` names. A ruleset that wants all of its own rules back writes
 * `off_by_default: []` in a file that extends this one.
 */
export function selectRules(ruleset: Ruleset, selection: TagSelection = {}): SelectedRules {
  const only = selection.only ?? [];
  const skip = selection.skip ?? [];
  const off = only.length > 0 ? [] : (ruleset.off_by_default ?? []);
  const dropped: { rule: string; reason: string }[] = [];

  const rules = ruleset.rules.filter((rule) => {
    const tags = rule.tags ?? [];
    const skipped = tags.find((tag) => skip.includes(tag));
    if (skipped !== undefined) {
      dropped.push({ rule: rule.id, reason: `--skip ${skipped}` });
      return false;
    }
    if (only.length > 0 && !tags.some((tag) => only.includes(tag))) {
      dropped.push({ rule: rule.id, reason: `--only ${only.join(",")}` });
      return false;
    }
    const sittingOut = tags.find((tag) => off.includes(tag));
    if (sittingOut !== undefined) {
      dropped.push({ rule: rule.id, reason: `the tag "${sittingOut}" is off by default` });
      return false;
    }
    return true;
  });

  return { ruleset: { ...ruleset, rules }, dropped };
}

function startingFile(options: ResolveRulesetOptions, defaultPath: string): string {
  if (options.rulesPath !== undefined) {
    const named = absolute(options.rulesPath, options.cwd);
    if (!existsSync(named)) {
      throw new ConfigError(`no ruleset at ${options.rulesPath}`);
    }
    return named;
  }

  for (const name of [PROJECT_RULES_FILE, PROJECT_RULES_ALT]) {
    const candidate = join(options.cwd, name);
    if (existsSync(candidate)) return candidate;
  }

  if (!existsSync(defaultPath)) {
    throw new ConfigError(
      `no ${PROJECT_RULES_FILE} in this directory and no ruleset shipped at ${defaultPath}. Name one with --rules <path>.`,
    );
  }
  return defaultPath;
}

function load(
  file: string,
  defaultPath: string,
  sources: string[],
  warnings: string[],
  depth: number,
): Ruleset {
  if (depth > MAX_EXTENDS_DEPTH) {
    throw new ConfigError(`${file}: extends is nested more than ${MAX_EXTENDS_DEPTH} deep`);
  }
  if (sources.includes(file)) {
    throw new ConfigError(`${file}: extends goes in a circle`);
  }
  sources.push(file);

  const doc = parseYaml(read(file), file);
  const own = validateRuleset(doc, file);
  for (const key of unknownKeys(doc)) {
    warnings.push(`${file}: unknown key "${key}", which this version of snifftest does not read.`);
  }
  const inherited = extendsTarget(doc, file, defaultPath);
  if (inherited === undefined) return own;

  return merge(load(inherited, defaultPath, sources, warnings, depth + 1), own);
}

function unknownKeys(doc: YamlValue): string[] {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return [];
  return Object.keys(doc).filter((key) => !KNOWN_KEYS.includes(key));
}

function extendsTarget(doc: YamlValue, file: string, defaultPath: string): string | undefined {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const value = doc["extends"];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${file}: extends must be a path or "${DEFAULT_TOKEN}"`);
  }

  if (value.trim() === DEFAULT_TOKEN) {
    if (!existsSync(defaultPath)) {
      throw new ConfigError(`${file}: extends "${DEFAULT_TOKEN}" but no ruleset ships at ${defaultPath}`);
    }
    return defaultPath;
  }

  const target = absolute(value.trim(), dirname(file));
  if (!existsSync(target)) {
    throw new ConfigError(`${file}: extends ${value.trim()}, which is not there`);
  }
  return target;
}

/** Child rules replace base rules of the same id in place; new ones go last. */
function merge(base: Ruleset, child: Ruleset): Ruleset {
  const overrides = new Map<string, Rule>(child.rules.map((rule) => [rule.id, rule]));
  const rules: Rule[] = base.rules.map((rule) => overrides.get(rule.id) ?? rule);
  const taken = new Set(base.rules.map((rule) => rule.id));
  for (const rule of child.rules) if (!taken.has(rule.id)) rules.push(rule);

  const threshold = child.threshold ?? base.threshold;
  // A child that writes `off_by_default: []` turns every tag back on, which is
  // how a marketing page asks for the rules an ordinary document sits out.
  const offByDefault = child.off_by_default ?? base.off_by_default;
  return {
    version: 1,
    ...(threshold === undefined ? {} : { threshold }),
    ...(offByDefault === undefined ? {} : { off_by_default: offByDefault }),
    rules,
  };
}

function absolute(path: string, from: string): string {
  return isAbsolute(path) ? path : resolve(from, path);
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(`${file} could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
}
