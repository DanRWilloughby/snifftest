import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consentPath, disclosure, requestConsent } from "../src/consent.ts";

const temporary: string[] = [];

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-consent-"));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface AskOptions {
  readonly home: string;
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly assumeYes?: boolean;
  readonly isTty?: boolean;
  readonly answer?: string;
}

const said: string[] = [];

async function ask(options: AskOptions) {
  said.length = 0;
  return requestConsent({
    env: { HOME: options.home, ...options.env },
    homedir: options.home,
    assumeYes: options.assumeYes ?? false,
    isTty: options.isTty ?? false,
    ruleIds: ["restating_closer"],
    fileCount: 1,
    say: (line) => said.push(line),
    ...(options.answer === undefined ? {} : { prompt: async () => options.answer as string }),
  });
}

describe("consentPath", () => {
  test("uses XDG_CONFIG_HOME when it is set and the home config directory otherwise", () => {
    expect(consentPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/someone")).toBe(
      join("/xdg", "snifftest", "consent.json"),
    );
    expect(consentPath({}, "/home/someone")).toBe(
      join("/home/someone", ".config", "snifftest", "consent.json"),
    );
    expect(consentPath({ XDG_CONFIG_HOME: "   " }, "/home/someone")).toBe(
      join("/home/someone", ".config", "snifftest", "consent.json"),
    );
  });
});

describe("disclosure", () => {
  test("names the endpoint, what leaves the machine, and the way out", () => {
    const text = disclosure({ ruleIds: ["restating_closer", "tricolon"], fileCount: 3 }).join("\n");

    expect(text).toContain("api.typesafe.ai");
    expect(text).toContain("restating_closer");
    expect(text).toContain("--dry-run");
    expect(text.toLowerCase()).toContain("paragraph");
  });
});

describe("requestConsent", () => {
  test("a stored yes answers for later runs without asking again", async () => {
    const home = sandbox();
    const cwd = sandbox();

    const first = await ask({ home, cwd, isTty: true, answer: "y" });
    expect(first.granted).toBe(true);
    expect(first.stored).toBe(true);
    expect(existsSync(consentPath({ HOME: home }, home))).toBe(true);

    const second = await ask({ home, cwd });
    expect(second.granted).toBe(true);
    expect(second.asked).toBe(false);
    expect(said).toEqual([]);
  });

  test("consent is written under the config directory and never in the working directory", async () => {
    const home = sandbox();
    const cwd = sandbox();

    await ask({ home, cwd, assumeYes: true });

    expect(existsSync(consentPath({ HOME: home }, home))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("SNIFFTEST_SEND=1 answers for CI and stores nothing", async () => {
    const home = sandbox();
    const cwd = sandbox();

    const outcome = await ask({ home, cwd, env: { SNIFFTEST_SEND: "1" } });

    expect(outcome.granted).toBe(true);
    expect(outcome.stored).toBe(false);
    expect(existsSync(consentPath({ HOME: home }, home))).toBe(false);
  });

  test("a value other than 1 in SNIFFTEST_SEND is not an answer", async () => {
    const home = sandbox();
    const cwd = sandbox();

    const outcome = await ask({ home, cwd, env: { SNIFFTEST_SEND: "true" } });

    expect(outcome.granted).toBe(false);
  });

  test("no consent and no terminal prints the disclosure and refuses to send", async () => {
    const home = sandbox();
    const cwd = sandbox();

    const outcome = await ask({ home, cwd, isTty: false });

    expect(outcome.granted).toBe(false);
    expect(outcome.asked).toBe(true);
    expect(said.join("\n")).toContain("api.typesafe.ai");
    expect(existsSync(consentPath({ HOME: home }, home))).toBe(false);
  });

  test("a no at the prompt is a no, and is not remembered", async () => {
    const home = sandbox();
    const cwd = sandbox();

    const outcome = await ask({ home, cwd, isTty: true, answer: "n" });

    expect(outcome.granted).toBe(false);
    expect(existsSync(consentPath({ HOME: home }, home))).toBe(false);
  });

  test("an empty answer is a no, because the default cannot be to send", async () => {
    const home = sandbox();
    const cwd = sandbox();

    expect((await ask({ home, cwd, isTty: true, answer: "" })).granted).toBe(false);
  });
});
