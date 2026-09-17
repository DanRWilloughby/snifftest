/**
 * Asking before anything leaves the machine.
 *
 * A linter that reads your drafts and quietly posts them somewhere is a thing
 * nobody asked for. So the first time a run would make a network call, the tool
 * says what it is about to send, where, and stops until someone answers. There
 * is no default-to-send: a run with no terminal to ask in does not send.
 *
 * The answer is kept under the user's config directory, never in the working
 * directory, because a consent file committed to a repo would answer for every
 * person who ever clones it.
 *
 * `--yes` is a person typing an answer, so it is remembered. `SNIFFTEST_SEND=1`
 * is a CI setting, so it answers for that run and is not written down: a build
 * agent's home directory is thrown away anyway, and writing files nobody asked
 * for is how a tool earns a reputation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ENDPOINT, KEY_ENV } from "./jev.ts";

/** The one environment variable that answers, and the one value it answers with. */
export const SEND_ENV = "SNIFFTEST_SEND";
const SEND_VALUE = "1";

const CONSENT_VERSION = 1;

export type Env = Readonly<Record<string, string | undefined>>;

export interface ConsentOutcome {
  readonly granted: boolean;
  /** Whether the person was shown the disclosure on this run. */
  readonly asked: boolean;
  /** Whether the answer was written down for next time. */
  readonly stored: boolean;
}

export interface DisclosureFacts {
  readonly ruleIds: readonly string[];
  readonly fileCount: number;
}

export interface ConsentRequest extends DisclosureFacts {
  readonly env: Env;
  readonly homedir: string;
  readonly assumeYes: boolean;
  readonly isTty: boolean;
  readonly say: (line: string) => void;
  readonly prompt?: (question: string) => Promise<string>;
}

/** Where the answer lives. XDG if the user set it, the usual place otherwise. */
export function consentPath(env: Env, homedir: string): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base =
    xdg !== undefined && xdg.trim() !== "" ? xdg : join(homedir, ".config");
  return join(base, "snifftest", "consent.json");
}

/** What leaves the machine, in the words of someone who has to decide. */
export function disclosure(facts: DisclosureFacts): string[] {
  const rules = facts.ruleIds.join(", ");
  const drafts = facts.fileCount === 1 ? "1 file" : `${facts.fileCount} files`;

  return [
    "Sniff Test is about to use the judgment rules, which run on a model.",
    "",
    `  What leaves this machine: one paragraph of your text at a time, from ${drafts},`,
    `    together with the wording of these rules: ${rules}.`,
    `  Where it goes: ${ENDPOINT} (TypeSafe), over HTTPS, with your ${KEY_ENV}.`,
    "  What comes back: one probability per rule per paragraph.",
    "  What is never sent: file names, file paths, anything outside the text you pointed at.",
    "  There is no telemetry, no analytics, and nothing is stored by this tool.",
    "",
    "  Countable rules never leave the machine. Run with --dry-run to use only those.",
  ];
}

export async function requestConsent(request: ConsentRequest): Promise<ConsentOutcome> {
  if (request.env[SEND_ENV] === SEND_VALUE) {
    return { granted: true, asked: false, stored: false };
  }

  const path = consentPath(request.env, request.homedir);

  if (request.assumeYes) {
    return { granted: true, asked: false, stored: remember(path) };
  }
  if (alreadyGranted(path)) {
    return { granted: true, asked: false, stored: false };
  }

  for (const line of disclosure(request)) request.say(line);

  if (!request.isTty || request.prompt === undefined) {
    request.say("");
    request.say(
      `No answer is possible here, so nothing was sent. Answer with --yes, or set ${SEND_ENV}=${SEND_VALUE} in CI.`,
    );
    return { granted: false, asked: true, stored: false };
  }

  const answer = (await request.prompt("Send paragraphs to TypeSafe? [y/N] ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    request.say("Nothing was sent.");
    return { granted: false, asked: true, stored: false };
  }

  return { granted: true, asked: true, stored: remember(path) };
}

function alreadyGranted(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { granted?: unknown };
    return parsed.granted === true;
  } catch {
    // An unreadable answer is not an answer. Asking again is the safe failure.
    return false;
  }
}

/** Best effort: a home directory we cannot write to is not a reason to fail a run. */
function remember(path: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({ version: CONSENT_VERSION, granted: true, at: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}
