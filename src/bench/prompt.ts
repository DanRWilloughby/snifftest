/**
 * One prompt, every model, no exceptions.
 *
 * The comparison is only worth printing if every model was asked the same
 * thing, so the prompt is built once from the ruleset and handed unchanged to
 * every adapter, and the whole text is written into the run's raw output. A
 * reader who doubts the table can read exactly what each model was sent.
 *
 * The rule's own words go in verbatim (`what`, `not_for`, the examples, both
 * criteria) because that is what Jev is given, and a bench that paraphrases the
 * rules for the panel is measuring the paraphrase.
 *
 * ## Why the reply carries a probability as well as a yes or no
 *
 * Jev answers with a probability, so a panel that answered only yes or no could
 * be compared at one operating point and never calibrated. Asking for both
 * costs nothing and makes the threshold sweep and the calibration table mean
 * the same thing for every row.
 *
 * ## Why a torn reply is never repaired
 *
 * Nothing here guesses. A reply that is not one JSON object is a failure for
 * that document, counted and listed; a rule answered out of contract (a
 * probability above one, a `flag` that is a word) is an unanswered cell. The
 * alternative, reading a refusal as "no defects", would score a model that
 * declined to answer as a model that answered perfectly on clean text.
 */

import { type JudgmentRule, asRecord } from "../types.ts";

export class ReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyError";
  }
}

export interface Reading {
  readonly flag: boolean;
  /** 0 to 1. This is what is scored, so a panel row is comparable with a noul. */
  readonly p: number;
}

export interface ParsedReply {
  readonly readings: Readonly<Record<string, Reading>>;
  /** Rules that were asked about and came back missing or out of contract. */
  readonly missing: readonly string[];
  /** Keys the model invented. Recorded, never scored. */
  readonly extra: readonly string[];
}

const HEADER = [
  "You are a writing checker for a company's published prose.",
  "Judge the PARAGRAPH below against each rule. Answer only from the paragraph itself.",
  "",
  "RULES",
];

const FOOTER = [
  "",
  "Return ONLY a JSON object mapping every rule id above to an object with two fields:",
  '  "flag": true or false, whether the paragraph trips the rule',
  '  "p": a number from 0 to 1, your probability that the rule is tripped',
  "No prose, no explanation, no code fence.",
];

/** The system prompt, built from the ruleset's own wording. */
export function buildSystemPrompt(rules: readonly JudgmentRule[]): string {
  const lines = [...HEADER];

  for (const rule of rules) {
    lines.push("", `[${rule.id}] ${rule.what.trim()}`);
    if (rule.not_for !== undefined && rule.not_for.trim() !== "") {
      lines.push(`  does not count: ${rule.not_for.trim()}`);
    }
    if (rule.examples !== undefined && rule.examples.length > 0) {
      lines.push(`  examples of yes: ${rule.examples.join(" | ")}`);
    }
    lines.push(`  yes means: ${rule.criteria.true.trim()}`);
    lines.push(`  no means: ${rule.criteria.false.trim()}`);
  }

  lines.push(...FOOTER);
  return lines.join("\n");
}

/** The user turn. One paragraph, labelled, and nothing else. */
export function userMessage(text: string): string {
  return `PARAGRAPH:\n${text}`;
}

const FENCE = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```$/;

export function parseReply(text: string, ruleIds: readonly string[]): ParsedReply {
  const trimmed = text.trim();
  const fenced = FENCE.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new ReplyError(`the reply is not JSON: ${excerpt(body)} (${reason(error)})`);
  }

  const record = asRecord(parsed);
  if (record === null) {
    throw new ReplyError(`the reply is JSON but not an object of rule ids: ${excerpt(body)}`);
  }

  const readings: Record<string, Reading> = {};
  const missing: string[] = [];

  for (const id of ruleIds) {
    const reading = readOne(record[id]);
    if (reading === undefined) missing.push(id);
    else readings[id] = reading;
  }

  const asked = new Set(ruleIds);
  return { readings, missing, extra: Object.keys(record).filter((key) => !asked.has(key)) };
}

function readOne(value: unknown): Reading | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;

  const flag = record["flag"];
  const p = record["p"];

  if (typeof flag !== "boolean") return undefined;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return undefined;

  return { flag, p };
}

/**
 * The first 120 characters of a reply, on one line, for a failure message.
 *
 * A long dash in the reply prints as its escaped codepoint. The excerpt lands
 * in the scores file and the tables, which are documents this repository holds
 * to the rule the tool enforces; the raw record beside them keeps the reply as
 * it came. A reader still sees exactly which character the model wrote.
 */
function excerpt(body: string): string {
  const flat = body
    .replace(/\s+/g, " ")
    .replace(/[\u2013\u2014]/g, (dash) => `\\u${dash.codePointAt(0)!.toString(16)}`)
    .trim();
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}...`;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
