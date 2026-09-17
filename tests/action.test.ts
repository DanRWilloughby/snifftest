/**
 * The GitHub Action, read as a document rather than run.
 *
 * An Action cannot be unit tested by running it, so the test treats `action.yml`
 * as the contract it is: a parsed document whose inputs, defaults and guard
 * expressions are asserted one by one. The properties checked here are the ones
 * that would be expensive to discover in production: a draft posted into a
 * public pull request, a fork's pull request reaching an API, a floating
 * version, or the Action helping itself to a secret it was never given.
 *
 * `Bun.YAML.parse` is used deliberately rather than the package's own subset
 * reader: the file has to be understood by GitHub's parser, not by ours, so the
 * test should fail if it only parses under our narrower rules.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const actionPath = join(repoRoot, "action.yml");
const actionSource = readFileSync(actionPath, "utf8");
const preCommitSource = readFileSync(join(repoRoot, ".pre-commit-hooks.yaml"), "utf8");

/** A parsed YAML document, walked by hand; the shape is the thing under test. */
// biome-ignore lint/suspicious/noExplicitAny: the document's shape is what is asserted.
const action = Bun.YAML.parse(actionSource) as any;
const preCommitHooks = Bun.YAML.parse(preCommitSource) as unknown;

/** Every shell body in the composite, joined, for the string-level assertions. */
const stepScripts: string = (action.runs?.steps ?? [])
  .map((step: { run?: string }) => step.run ?? "")
  .join("\n");

function stepById(id: string): { run?: string; if?: string; env?: Record<string, string> } {
  const step = (action.runs?.steps ?? []).find((candidate: { id?: string }) => candidate.id === id);
  if (step === undefined) throw new Error(`action.yml has no step with id "${id}"`);
  return step;
}

/** Every file under a directory, recursively; an absent directory yields none. */
function filesUnder(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("action.yml, as a document", () => {
  test("parses under a real YAML parser and is a composite action", () => {
    expect(action).toBeTruthy();
    expect(action.runs.using).toBe("composite");
    expect(typeof action.name).toBe("string");
    expect(typeof action.description).toBe("string");
  });

  test("declares every input it uses, and uses every input it declares", () => {
    const declared = new Set(Object.keys(action.inputs ?? {}));
    const referenced = new Set(
      [...actionSource.matchAll(/inputs\.([a-z0-9-]+)/g)].map((match) => match[1] as string),
    );

    for (const name of referenced) expect([...declared]).toContain(name);
    for (const name of declared) expect([...referenced]).toContain(name);
  });

  test("is safe by default: send off, comment off, no key", () => {
    expect(action.inputs.send.default).toBe("false");
    expect(action.inputs.comment.default).toBe("false");
    expect(action.inputs["api-key"].default).toBe("");
    expect(action.inputs["github-token"].default).toBe("");
  });

  test("pins its own version of the tool and refuses a floating one", () => {
    expect(action.inputs.version.default).toMatch(/^\d+\.\d+\.\d+$/);
    // Not "never says the word": the guard has to name what it rejects. The
    // point is that no *invocation* can float, so the only mention is a refusal.
    expect(stepScripts).toContain('"$SNIFFTEST_VERSION" in');
    expect(stepScripts).toMatch(/latest\s*\|/);
    expect(stepScripts).toContain('snifftest@${SNIFFTEST_VERSION}');
    expect(actionSource).not.toContain("snifftest@latest");
  });

  test("reads no secret but the one it is handed", () => {
    // A composite action has no `secrets` context. Any mention of one would be
    // either a mistake or an instruction to the caller in the wrong file.
    expect(actionSource).not.toContain("secrets.");
    const keyEnvNames = [...actionSource.matchAll(/^\s{8}([A-Z_]+):/gm)].map((m) => m[1] as string);
    expect(keyEnvNames.filter((name) => name.endsWith("_API_KEY"))).toEqual(["TYPESAFE_API_KEY"]);
  });

  test("the key is in no step's environment when the guard turned sending off", () => {
    // A key present while nothing may be sent is a key with nothing to do and
    // somewhere to leak from, and the step it sat in is the one that runs the
    // checker over a fork's own files.
    const placement = stepById("run").env?.TYPESAFE_API_KEY ?? "";
    expect(placement).toContain("steps.guard.outputs.send == 'true'");
    expect(placement).toContain("inputs.api-key");
    expect(placement).toContain("|| ''");

    // The same expression, evaluated the way GitHub evaluates it.
    const rendered = (send: string): string => {
      const match = /^\$\{\{\s*steps\.guard\.outputs\.send == '(\w+)' && inputs\.api-key \|\| '' \}\}$/.exec(
        placement,
      );
      expect(match).not.toBeNull();
      return send === (match?.[1] as string) ? "the-key" : "";
    };
    expect(rendered("true")).toBe("the-key");
    expect(rendered("false")).toBe("");
  });

  test("never fetches the checker while standing in the checkout", () => {
    // `npx snifftest@<version>` run inside a repository runs that repository's
    // own node_modules/snifftest and never reaches a registry. On a fork's pull
    // request that is the fork's code, on this runner, with this environment.
    const run = stepById("run").run ?? "";
    // The command itself, not the comment above it that names what it avoids.
    const fetch = /^[ \t]*npx --yes/m.exec(run);
    expect(fetch).not.toBeNull();
    const fetchAt = fetch?.index ?? -1;

    const before = run.slice(0, fetchAt);
    expect(before).toContain('cd "$fetch"');
    expect(before).toContain('fetch="${RUNNER_TEMP:-/tmp}/snifftest-fetch"');
    // Whatever else the step does, it never walks back into the workspace.
    expect(run).not.toMatch(/cd\s+"?\$GITHUB_WORKSPACE/);
  });

  test("names the workspace as the tree being checked, rather than standing in it", () => {
    expect(stepById("run").run).toContain('args+=(--root "$GITHUB_WORKSPACE")');
  });

  test("never names the event that would run it with the base repository's secrets", () => {
    const suspects = [actionPath, ...filesUnder(join(repoRoot, ".github"))].filter((path) =>
      statSync(path).isFile(),
    );
    for (const path of suspects) {
      expect(readFileSync(path, "utf8")).not.toContain("pull_request_target");
    }
  });

  test("refuses any event whose name ends in _target at run time", () => {
    // Spelled as a suffix match so the literal event name stays out of the repo
    // while the guard is still real.
    expect(stepById("guard").run).toContain("*_target)");
    expect(stepById("guard").run).toContain("exit 1");
  });

  test("forces the free rules on a pull request from a fork", () => {
    const guard = stepById("guard");
    expect(guard.env?.SNIFFTEST_IS_FORK).toBe("${{ github.event.pull_request.head.repo.fork }}");
    expect(guard.run).toContain('"${SNIFFTEST_IS_FORK:-}" = "true"');
    expect(guard.run).toContain("send=false");
  });

  test("fails loudly when send is on and no key was passed", () => {
    const guard = stepById("guard") as { run: string; env?: Record<string, string> };
    const clause = guard.run.slice(guard.run.indexOf('if [ "$send" = "true" ]'));
    expect(clause).toContain('"$SNIFFTEST_HAS_KEY" != "true"');
    expect(clause).toContain("::error::");
    expect(clause).toContain("exit 1");
    // The guard learns whether a key exists, never what it is.
    expect(guard.env?.SNIFFTEST_HAS_KEY).toBe("${{ inputs.api-key != '' }}");
    expect(JSON.stringify(guard.env)).not.toContain("inputs.api-key }}");
  });

  test("runs the free rules unless the guard said to send", () => {
    const run = stepById("run").run ?? "";
    expect(run).toContain('[ "$SNIFFTEST_SEND" = "1" ] || args+=(--dry-run)');
    expect(stepById("run").env?.SNIFFTEST_SEND).toContain("steps.guard.outputs.send");
  });

  test("writes nothing to the pull request unless asked", () => {
    const comment = stepById("comment");
    expect(comment.if).toContain("inputs.comment == 'true'");
    expect(comment.if).toContain("github.event_name == 'pull_request'");
    expect(comment.if).toContain("inputs.github-token != ''");
  });

  test("the comment carries flags, never a line of the draft", () => {
    const comment = stepById("comment").run ?? "";
    // The report is the CLI's own `file:line rule probability message` output;
    // `message` comes from the ruleset, so no sentence of the draft travels.
    expect(comment).toContain("$SNIFFTEST_REPORT");
    expect(comment).not.toMatch(/\bcat\b[^\n]*\$SNIFFTEST_PATHS/);
  });

  test("ends on the exit code the check produced", () => {
    expect(stepById("verdict").run).toContain('exit "$SNIFFTEST_STATUS"');
    expect(action.outputs["exit-code"].value).toContain("steps.run.outputs.exit-code");
  });
});

describe(".pre-commit-hooks.yaml", () => {
  test("parses and offers a free hook and an opt-in one", () => {
    expect(Array.isArray(preCommitHooks)).toBe(true);
    const hooks = preCommitHooks as { id: string; entry: string; stages?: string[] }[];
    const ids = hooks.map((hook) => hook.id);
    expect(ids).toEqual(["snifftest", "snifftest-send"]);
  });

  test("the default hook sends nothing", () => {
    const hooks = preCommitHooks as { id: string; entry: string; types_or?: string[] }[];
    const free = hooks.find((hook) => hook.id === "snifftest");
    expect(free?.entry).toContain("--dry-run");
    expect(free?.types_or).toEqual(["markdown", "plain-text"]);
  });

  test("every entry ends the options, so a filename starting with a dash is a path", () => {
    const hooks = preCommitHooks as { id: string; entry: string }[];
    for (const hook of hooks) expect(hook.entry.trimEnd().endsWith(" --")).toBe(true);
  });

  test("both hooks pin the version they install", () => {
    const hooks = preCommitHooks as { id: string; additional_dependencies?: string[] }[];
    for (const hook of hooks) {
      expect(hook.additional_dependencies).toHaveLength(1);
      expect(hook.additional_dependencies?.[0]).toMatch(/^snifftest@\d+\.\d+\.\d+$/);
    }
  });

  test("the sending hook has to be asked for by name", () => {
    const hooks = preCommitHooks as { id: string; entry: string; stages?: string[] }[];
    const sending = hooks.find((hook) => hook.id === "snifftest-send");
    expect(sending?.entry).not.toContain("--dry-run");
    expect(sending?.stages).toEqual(["manual"]);
  });
});
