/**
 * The seed bank: faults written for the eval rather than for the ruleset.
 *
 * A rule's own `splice` list exists so that a ruleset is self-contained and a
 * stranger's `eval` works on the first run. It is a short list, and a short
 * list used three times per rule measures one sentence three times: the live
 * run that prompted this file scored one `first_x_that` sentence at 0.53, 0.63
 * and 0.70 depending on which paragraph it landed in, which is a stability
 * finding that looked like two misses.
 *
 * So the bank holds ten faults per judgment rule and a handful of hard
 * negatives: sentences that sit near the rule and must not be flagged. The
 * faults carry the words a host paragraph would have to contain for the splice
 * to belong there, because a modern product sentence dropped into Franklin
 * measures whether the model can spot the sentence that does not belong.
 *
 * Nothing here is loaded automatically from outside the package. The path is
 * either the one that ships or one the caller named.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { packagedPath } from "../config.ts";
import { asRecord } from "../types.ts";

export class BankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankError";
  }
}

export interface BankFault {
  readonly text: string;
  /** Words a host paragraph must contain for this fault to belong in it. Empty fits anywhere. */
  readonly hosts: readonly string[];
}

export interface BankNegative {
  readonly text: string;
  /** Why this one is near the rule and still not a defect. Printed in the report. */
  readonly why: string;
}

export interface BankEntry {
  readonly faults: readonly BankFault[];
  readonly hard_negatives: readonly BankNegative[];
}

export interface SeedBank {
  readonly version: number;
  readonly rules: Readonly<Record<string, BankEntry>>;
}

/**
 * The bank that ships beside the packaged ruleset.
 *
 * Derived from the ruleset's own path rather than from this file's, because
 * this module sits one directory deeper in the source than it does in the
 * bundle, and a relative URL would be right in one layout and wrong in the
 * other.
 */
export function packagedBankPath(): string {
  return packagedPath("examples", "seeds", "bank.json");
}

export function readBank(path: string, cwd: string): SeedBank {
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(full, "utf8"));
  } catch (error) {
    throw new BankError(
      `${path} could not be read as a seed bank (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseBank(parsed, path);
}

export function parseBank(parsed: unknown, where: string): SeedBank {
  const root = asRecord(parsed);
  const version = root?.["version"];
  const rules = asRecord(root?.["rules"]);
  if (typeof version !== "number" || rules === null) {
    throw new BankError(`${where}: a seed bank needs a version and a rules object`);
  }

  const out: Record<string, BankEntry> = {};
  for (const [id, value] of Object.entries(rules)) {
    const entry = asRecord(value);
    const faults = entry?.["faults"];
    const negatives = entry?.["hard_negatives"] ?? [];
    if (!Array.isArray(faults) || faults.length === 0) {
      throw new BankError(`${where}: rule "${id}" has no faults`);
    }
    out[id] = {
      faults: faults.map((row, index) => readFault(row, `${where}: ${id} fault ${index + 1}`)),
      hard_negatives: Array.isArray(negatives)
        ? negatives.map((row, index) => readNegative(row, `${where}: ${id} hard negative ${index + 1}`))
        : [],
    };
  }

  return { version, rules: out };
}

/**
 * The faults that belong in this host, in the bank's own order.
 *
 * A fault with no host words fits anywhere, so it is always offered, after the
 * ones that name something the paragraph is already about. Nothing is dropped:
 * a host that matches nothing still gets the whole list, because a corpus with
 * a rule missing from it is worse than a splice that reads as an outsider.
 */
export function faultsFor(entry: BankEntry, host: string): readonly string[] {
  const text = host.toLowerCase();
  const fits = (fault: BankFault): boolean =>
    fault.hosts.length > 0 && fault.hosts.some((word) => text.includes(word.toLowerCase()));

  const matched = entry.faults.filter(fits).map((fault) => fault.text);
  const general = entry.faults.filter((fault) => fault.hosts.length === 0).map((fault) => fault.text);
  const rest = entry.faults
    .filter((fault) => !fits(fault) && fault.hosts.length > 0)
    .map((fault) => fault.text);
  return [...matched, ...general, ...rest];
}

function readFault(row: unknown, where: string): BankFault {
  const record = asRecord(row);
  const text = record?.["text"];
  const hosts = record?.["hosts"] ?? [];
  if (typeof text !== "string" || text.trim() === "") {
    throw new BankError(`${where}: needs a text`);
  }
  if (!Array.isArray(hosts) || hosts.some((word) => typeof word !== "string")) {
    throw new BankError(`${where}: hosts must be a list of words`);
  }
  return { text: text.trim(), hosts: hosts.map(String) };
}

function readNegative(row: unknown, where: string): BankNegative {
  const record = asRecord(row);
  const text = record?.["text"];
  const why = record?.["why"];
  if (typeof text !== "string" || text.trim() === "") throw new BankError(`${where}: needs a text`);
  if (typeof why !== "string" || why.trim() === "") {
    throw new BankError(`${where}: needs a why, because an unexplained near miss is a guess`);
  }
  return { text: text.trim(), why: why.trim() };
}
