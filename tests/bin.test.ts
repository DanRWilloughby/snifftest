/**
 * The published executable, run the way a package manager installs it.
 *
 * `npm` and `bunx` put `node_modules/.bin/snifftest` on disk as a symbolic link
 * to the file named by `bin` in `package.json`, and every documented way of
 * running this tool goes through that link: `npx snifftest`, a global install,
 * the GitHub Action, the pre-commit framework entry. Node resolves the link for
 * `import.meta.url` and leaves it unresolved in `argv[1]`, so an entry check
 * that compares those two strings is false through the link and the program
 * ends without running. Exit 0 with no output is the contract's word for
 * "nothing tripped", so a dead executable reads as clean prose on every surface
 * the tool has.
 *
 * The test therefore builds the bundle the package ships, lays it out the way a
 * package manager would, and runs it through the link with `node`, which is the
 * interpreter the shebang names. Nothing here asserts how the entry point is
 * written. What is pinned is that the executable, reached the way it is
 * installed, prints a version and exits 1 on prose that trips a rule.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

const temporary: string[] = [];

afterEach(() => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The package as installed: the bundle, the rules beside it, and a `.bin` link.
 *
 * The bundle is built here rather than taken from `dist/`, so the test says
 * something about the source in the working tree and passes on a clean checkout
 * where nothing has been built yet.
 */
async function installed(): Promise<{ bin: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "snifftest-bin-"));
  temporary.push(dir);

  const packageDir = join(dir, "node_modules", "snifftest");
  const binDir = join(dir, "node_modules", ".bin");
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Both the source the package builds from and the path it installs as are
  // read out of package.json, so moving either one moves this test with it
  // rather than leaving it testing a file nothing ships.
  const entry = JSON.parse(await Bun.file(join(repoRoot, "package.json")).text()) as {
    bin: Record<string, string>;
    scripts: Record<string, string>;
  };
  const source = /bun build (\S+)/.exec(entry.scripts["build"] ?? "")?.[1];
  if (source === undefined) throw new Error("the build script names no entry point");

  const built = await Bun.build({
    entrypoints: [join(repoRoot, source)],
    target: "node",
    format: "esm",
    banner: "#!/usr/bin/env node",
  });
  expect(built.success).toBe(true);
  const output = built.outputs[0];
  if (output === undefined) throw new Error("the bundle produced no output");

  const installedAs = entry.bin["snifftest"];
  if (installedAs === undefined) throw new Error("package.json installs no snifftest binary");
  const binaryPath = join(packageDir, installedAs);
  mkdirSync(join(binaryPath, ".."), { recursive: true });
  writeFileSync(binaryPath, await output.text(), "utf8");
  chmodSync(binaryPath, 0o755);

  // The package's own files, because the tool reads its version out of its
  // package.json and its default ruleset out of the directory beside the bundle.
  cpSync(join(repoRoot, "package.json"), join(packageDir, "package.json"));
  cpSync(join(repoRoot, "rules"), join(packageDir, "rules"), { recursive: true });

  // What a package manager writes: a relative link, from `.bin` to the file.
  const link = join(binDir, "snifftest");
  symlinkSync(`../snifftest/${installedAs}`, link);

  return { bin: link, dir };
}

function run(bin: string, args: readonly string[], cwd: string) {
  const result = Bun.spawnSync({
    cmd: ["node", bin, ...args],
    cwd,
    env: { ...process.env, SNIFFTEST_SEND: "", TYPESAFE_API_KEY: "" },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

describe("the executable, reached through the link a package manager writes", () => {
  test("--version prints the version rather than nothing", async () => {
    const { bin, dir } = await installed();
    const result = run(bin, ["--version"], dir);

    expect(result.code).toBe(0);
    expect(result.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("prose that trips a countable rule exits 1 and says which rule", async () => {
    const { bin, dir } = await installed();
    // An em dash, which the packaged ruleset flags. Written by code point so
    // this file keeps to the house rule about dashes in prose.
    const dash = String.fromCharCode(0x2014);
    writeFileSync(
      join(dir, "draft.md"),
      `A sentence with a long dash ${dash} in the middle of it, and enough other words after it to be a paragraph a reader would recognise.\n`,
      "utf8",
    );

    const result = run(bin, ["check", "--dry-run", "--", "draft.md"], dir);

    expect(result.out).toContain("dash_present");
    expect(result.code).toBe(1);
  });

  test("clean prose exits 0 having said so, rather than having said nothing", async () => {
    // The other half of the claim, and the reason the defect stayed invisible:
    // on clean prose a live run prints nothing and exits 0, which is exactly
    // what a dead executable does. `--format json` is the spelling that tells
    // the two apart, because a run that happened writes a report object with
    // an empty flag list and a word about what the judgment arm did.
    const { bin, dir } = await installed();
    writeFileSync(
      join(dir, "draft.md"),
      "A plain sentence about a quiet morning. The kettle boiled and somebody opened a window onto the street below.\n",
      "utf8",
    );

    const result = run(bin, ["check", "--dry-run", "--format", "json", "--", "draft.md"], dir);

    expect(result.code).toBe(0);
    const report = JSON.parse(result.out) as {
      tool: string;
      flags: readonly unknown[];
      judgment: { state: string };
    };
    expect(report.tool).toBe("snifftest check");
    expect(report.flags).toEqual([]);
    expect(report.judgment.state).toBe("not run");
  });

  test("the run happens once, not once per entry point", async () => {
    // Two mechanisms that each start the program is one report printed twice,
    // which in a bundle is easy to arrive at and impossible to miss here.
    const { bin, dir } = await installed();
    const result = run(bin, ["--version"], dir);

    expect(result.out.trim().split("\n")).toHaveLength(1);
  });
});
