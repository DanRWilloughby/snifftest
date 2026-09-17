/**
 * The repository read as a document.
 *
 * None of this can be unit tested by running it: a workflow only really runs on
 * GitHub, and by the time a release workflow is wrong it has already published
 * something. So the files are parsed and asserted instead, and the properties
 * asserted are the ones that would be expensive to discover afterwards: an
 * action pinned to a tag somebody can move, a job holding a token it does not
 * need, a secret reachable from a pull request, a tarball carrying the test
 * fixtures, or a publish with no provenance behind it.
 *
 * `Bun.YAML.parse` is used deliberately rather than the package's own subset
 * reader: these files have to be understood by GitHub's parser, not by ours.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

// biome-ignore lint/suspicious/noExplicitAny: the document's shape is what is asserted.
function parseYaml(relativePath: string): any {
  return Bun.YAML.parse(read(relativePath));
}

const workflowDir = join(repoRoot, ".github", "workflows");
const workflowNames = readdirSync(workflowDir).filter((name) => name.endsWith(".yml"));

describe("the files a stranger expects to find", () => {
  const expected = [
    "LICENSE",
    "README.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "CHANGELOG.md",
    ".gitignore",
    ".github/CODEOWNERS",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/ISSUE_TEMPLATE/rule-proposal.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
  ];

  for (const path of expected) {
    test(path, () => {
      expect(existsSync(join(repoRoot, path))).toBe(true);
    });
  }

  test("the licence is MIT, held by the author, dated this year's work", () => {
    const license = read("LICENSE");
    expect(license).toStartWith("MIT License");
    expect(license).toContain("Copyright (c) 2026 Dan Willoughby");
    expect(read("package.json")).toContain('"license": "MIT"');
  });

  test("both issue templates parse and carry the fields that make a report useful", () => {
    const bug = parseYaml(".github/ISSUE_TEMPLATE/bug.yml");
    expect(bug.name).toBe("Bug report");
    const bugIds: string[] = bug.body.map((field: { id?: string }) => field.id).filter(Boolean);
    expect(bugIds).toContain("repro");
    expect(bugIds).toContain("version");

    const rule = parseYaml(".github/ISSUE_TEMPLATE/rule-proposal.yml");
    const ruleIds: string[] = rule.body.map((field: { id?: string }) => field.id).filter(Boolean);
    // A rule is only arguable without examples both ways and a seed recipe.
    expect(ruleIds).toContain("should-trip");
    expect(ruleIds).toContain("should-not");
    expect(ruleIds).toContain("seed");
  });

  test("the changelog carries the heading the release workflow slices on", () => {
    expect(read("CHANGELOG.md")).toMatch(/^## \[0\.1\.0\]/m);
  });
});

describe("what the published tarball may contain", () => {
  const pkg = JSON.parse(read("package.json")) as {
    files: string[];
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  test("the allowlist is exactly what the commands need and nothing else", () => {
    // The corpus, the fault bank, the panel and the price files are here
    // because `eval`, `bench` and `serve --replay` read them at run time.
    // Without them those commands work from a clone of this repo and from
    // nowhere else, which is not what they are described as. `bench/results/`
    // is deliberately not named: a run's own output is not part of the tool.
    // Nor are `examples/adversarial/`, three files of injection payloads that
    // nobody wants in their node_modules, or `examples/structure/`, which is a
    // clone's exercise. The reason for each entry lives beside it in the gate.
    expect(pkg.files).toEqual([
      "dist",
      "rules",
      "bench/panel.yaml",
      "bench/prices",
      "examples/CORPUS.md",
      "examples/corpus",
      "examples/seeds",
      "examples/replays",
      "README.md",
      "SECURITY.md",
      "LICENSE",
    ]);
  });

  test("the gate names every path the manifest ships, and both workflows run it", () => {
    // The manifest decides what npm packs; the gate decides whether that was
    // meant. They were allowed to disagree once, and the build stayed red
    // rather than the question getting answered.
    const gate = read(".github/scripts/tarball-allowlist.mjs");
    for (const entry of pkg.files) {
      // A directory in the manifest is a prefix in the gate.
      const named = gate.includes(`"${entry}/"`) || gate.includes(`"${entry}"`);
      expect(`${entry}: ${String(named)}`).toBe(`${entry}: true`);
    }

    for (const name of ["ci.yml", "release.yml"]) {
      expect(read(`.github/workflows/${name}`)).toContain(
        "node .github/scripts/tarball-allowlist.mjs pack.json",
      );
    }
  });

  test("no runtime dependency, which is the promise on the first screen", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  test("dev dependencies are pinned to an exact version, never a range", () => {
    for (const [name, range] of Object.entries(pkg.devDependencies)) {
      expect(`${name}@${range}`).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });

  test("a git revision builds its own bin rather than installing a dangling one", () => {
    // `dist/` is not in git. Without this, installing this package from a git
    // revision, which is what the pre-commit framework does with
    // `language: node`, leaves the `snifftest` bin pointing at nothing.
    expect(pkg.scripts.prepare).toBe("bun run build");
  });
});

describe("the release notes keep the name-ownership step", () => {
  // The one step in this repository that cannot be enforced by a test, because
  // what it is about happens on somebody else's registry. It can at least be
  // kept from being quietly edited out: the pins are public install
  // instructions, and an unclaimed name means a stranger decides what they
  // install.
  const releasing = read("docs/releasing.md");

  test("owning the name comes before the release checklist, with the reason", () => {
    const ownership = releasing.indexOf("Own the name on npm first");
    const checklist = releasing.indexOf("## The checklist");

    expect(ownership).toBeGreaterThan(-1);
    expect(ownership).toBeLessThan(checklist);
    expect(releasing).toContain("npm view snifftest version");
    expect(releasing.slice(ownership, checklist)).toContain("public");
  });
});

describe("the version is pinned in one place at a time", () => {
  /**
   * Every file that names the version a stranger would fetch.
   *
   * `package.json` is deliberately not here. It is `0.0.0` until the release
   * commit bumps it, and the release workflow is what checks it against the
   * tag. These are the pins that tell somebody else which version to install,
   * and a bump that misses one of them ships a plugin pointing at a version of
   * the tool it was never tested against. The checklist is `docs/releasing.md`.
   */
  const pinned: { file: string; pattern: RegExp; expected: number }[] = [
    { file: ".claude-plugin/plugin.json", pattern: /"version":\s*"([^"]+)"/g, expected: 1 },
    { file: ".claude-plugin/marketplace.json", pattern: /"version":\s*"([^"]+)"/g, expected: 2 },
    { file: ".pre-commit-hooks.yaml", pattern: /snifftest@([0-9][^"\]]*)/g, expected: 2 },
    { file: "action.yml", pattern: /default:\s*"([0-9]+\.[0-9]+\.[0-9]+)"/g, expected: 1 },
    { file: "hooks/pre-commit", pattern: /SNIFFTEST_VERSION:-([0-9][^}]*)/g, expected: 1 },
    { file: "skills/snifftest/scripts/run.sh", pattern: /SNIFFTEST_VERSION:-([0-9][^}]*)/g, expected: 1 },
  ];

  /** Every version string the files above carry, with where it came from. */
  const found: { where: string; version: string }[] = [];
  for (const { file, pattern, expected } of pinned) {
    const versions = [...read(file).matchAll(pattern)].map((match) => match[1] ?? "");
    test(`${file} carries ${expected} pin${expected === 1 ? "" : "s"}`, () => {
      // A pin that moved out of reach of the pattern is a pin this suite would
      // otherwise stop watching without saying so.
      expect(versions).toHaveLength(expected);
    });
    for (const version of versions) found.push({ where: file, version });
  }

  test("they all agree with one another", () => {
    const disagreeing = found.filter((pin) => pin.version !== found[0]?.version);
    expect(disagreeing).toEqual([]);
  });

  test("the changelog has a section and a link for that same version", () => {
    const version = found[0]?.version ?? "";
    const changelog = read("CHANGELOG.md");
    // The release workflow cuts its notes from this heading and fails without
    // it, which is a slow way to find out.
    expect(changelog).toContain(`## [${version}]`);
    expect(changelog).toContain(`[${version}]: https://github.com/DanRWilloughby/snifftest/releases/tag/v${version}`);
  });

  test("the install docs quote the same version", () => {
    const version = found[0]?.version ?? "";
    for (const file of ["docs/claude-code.md", "docs/husky.md"]) {
      const quoted = read(file)
        .split("\n")
        // A third-party action is pinned to its own commit with its own version
        // in the comment beside it. That number has nothing to do with this one.
        .filter((line) => !/uses:\s+actions\//.test(line))
        .flatMap((line) => [...line.matchAll(/v?([0-9]+\.[0-9]+\.[0-9]+)/g)].map((m) => m[1]));
      expect([file, [...new Set(quoted)]]).toEqual([file, [version]]);
    }
  });

  test("there is a checklist saying which files these are", () => {
    const releasing = read("docs/releasing.md");
    for (const { file } of pinned) expect(releasing).toContain(file);
    expect(releasing).toContain("CHANGELOG.md");
    // Installing from a git URL needs Bun, because `prepare` is what builds
    // `dist/`. A reader who hits that deserves to have been told.
    expect(releasing).toContain("prepare");
    expect(read("CONTRIBUTING.md")).toContain("prepare");
  });
});

describe("the package says where it lives", () => {
  const pkg = JSON.parse(read("package.json")) as {
    homepage?: string;
    repository?: { type?: string; url?: string };
    bugs?: { url?: string };
  };

  test("npm can show the repository, the homepage and where to file a bug", () => {
    // Without these the npm page has no link back, and provenance has nothing
    // human-readable beside it.
    expect(pkg.repository?.url).toBe("git+https://github.com/DanRWilloughby/snifftest.git");
    expect(pkg.homepage).toContain("github.com/DanRWilloughby/snifftest");
    expect(pkg.bugs?.url).toBe("https://github.com/DanRWilloughby/snifftest/issues");
  });
});

describe("every action is pinned to a commit", () => {
  /** Every `uses:` line under .github, with the file and line it came from. */
  const usesLines: { file: string; line: number; text: string }[] = [];
  for (const name of workflowNames) {
    read(`.github/workflows/${name}`)
      .split("\n")
      .forEach((text, index) => {
        if (/^\s*-?\s*uses:/.test(text)) {
          usesLines.push({ file: name, line: index + 1, text: text.trim() });
        }
      });
  }

  test("there is at least one, or this suite is asserting nothing", () => {
    expect(usesLines.length).toBeGreaterThan(0);
  });

  for (const { file, line, text } of usesLines) {
    test(`${file}:${line}`, () => {
      // A tag can be moved to point at anything. A commit cannot, so the pin is
      // the commit and the tag rides along as a comment for whoever reads it
      // next, and for Dependabot, which rewrites both together.
      expect(text).toMatch(/^-?\s*uses:\s+\S+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+$/);
    });
  }
});

describe("no workflow runs in the base repository's context", () => {
  for (const name of workflowNames) {
    test(name, () => {
      const source = read(`.github/workflows/${name}`);
      // Spelled as a suffix match so the literal event name stays out of this
      // repository and nobody copies it out of here into a workflow of theirs.
      const triggers = Object.keys((parseYaml(`.github/workflows/${name}`) as { on: object }).on);
      expect(triggers.filter((event) => event.endsWith("_target"))).toEqual([]);
      expect(source).not.toMatch(/pull_request_target/);
    });
  }

  test("nor does the composite action", () => {
    const names = readdirSync(join(repoRoot, ".github"), { recursive: true, encoding: "utf8" });
    expect(names.filter((n) => n.includes("_target"))).toEqual([]);
  });
});

describe("least privilege", () => {
  for (const name of workflowNames) {
    const workflow = parseYaml(`.github/workflows/${name}`);

    test(`${name} starts from nothing`, () => {
      // Without a top-level `permissions`, a job that declares none inherits
      // whatever the repository default is, which is not a decision this file
      // gets to leave to a settings page.
      expect(workflow.permissions).toEqual({});
    });

    test(`${name} declares permissions on every job`, () => {
      for (const [jobName, job] of Object.entries(workflow.jobs) as [string, { permissions?: object }][]) {
        expect(`${jobName}: ${JSON.stringify(job.permissions)}`).not.toContain("undefined");
        expect(Object.keys(job.permissions ?? {}).length).toBeGreaterThan(0);
      }
    });
  }

  test("nothing in CI can write anything", () => {
    const ci = parseYaml(".github/workflows/ci.yml");
    for (const [jobName, job] of Object.entries(ci.jobs) as [string, { permissions: Record<string, string> }][]) {
      expect(`${jobName}: ${JSON.stringify(job.permissions)}`).toBe(`${jobName}: {"contents":"read"}`);
    }
  });

  test("only the release job may write, and only what a release needs", () => {
    const release = parseYaml(".github/workflows/release.yml");
    expect(release.jobs.publish.permissions).toEqual({
      contents: "write",
      "id-token": "write",
    });
  });
});

describe("CI never needs a key", () => {
  const ci = read(".github/workflows/ci.yml");

  test("no secret is read", () => {
    // Everything CI runs is a countable rule. The moment a key appears here,
    // a fork's pull request becomes a way to spend it.
    expect(ci).not.toContain("secrets.");
    expect(ci).not.toContain("TYPESAFE_API_KEY");
  });

  test("the checker runs with the network off", () => {
    expect(ci).toMatch(/bin\.ts check --dry-run/);
  });

  test("CI runs the packed tarball through the link a package manager writes", () => {
    // A bin that ends without running prints nothing and exits 0, which is this
    // tool's word for "nothing tripped", so a dead release reads as a clean
    // draft everywhere. Building it is not evidence that it runs.
    for (const workflow of [ci, read(".github/workflows/release.yml")]) {
      expect(workflow).toContain("npm pack");
      expect(workflow).toContain("node_modules/.bin/snifftest");
      expect(workflow).toContain('"$bin" --version');
    }
  });

  test("the secret scan reads the history, not just the tip", () => {
    const scan = parseYaml(".github/workflows/ci.yml").jobs["secret-scan"];
    const checkout = scan.steps.find((step: { uses?: string }) => step.uses?.includes("actions/checkout"));
    expect(checkout.with["fetch-depth"]).toBe(0);
    // Redacted, or a finding publishes the very thing it caught into a log that
    // anyone can read.
    expect(ci).toContain("--redact");
  });

  test("the scanner itself is pinned and checksummed", () => {
    expect(ci).toMatch(/GITLEAKS_VERSION: "\d+\.\d+\.\d+"/);
    expect(ci).toMatch(/GITLEAKS_SHA256: "[0-9a-f]{64}"/);
    expect(ci).toContain("sha256sum --check --strict");
  });
});

describe("the release publishes something anyone can verify", () => {
  const release = read(".github/workflows/release.yml");
  const parsed = parseYaml(".github/workflows/release.yml");

  test("only a version tag publishes", () => {
    expect(Object.keys(parsed.on)).toEqual(["push"]);
    expect(parsed.on.push.tags).toBeArray();
    expect(parsed.on.push.branches).toBeUndefined();
  });

  test("an environment stands between the tag and the token", () => {
    // The npm token lives on this environment rather than on the repository, so
    // no other workflow can reach it, and a required reviewer on the
    // environment means a tag alone never publishes unattended.
    expect(parsed.jobs.publish.environment.name).toBe("release");
  });

  test("the tarball is signed to this workflow and this commit", () => {
    expect(release).toContain("npm publish --provenance --access public");
    expect(parsed.jobs.publish.permissions["id-token"]).toBe("write");
  });

  test("a tag that disagrees with package.json does not ship", () => {
    expect(release).toContain("does not match package.json version");
  });

  test("the release notes come from the changelog, and an empty slice fails", () => {
    expect(release).toContain("release-notes.md");
    expect(release).toContain("has no section for");
  });
});

describe("dependabot watches the two things there are to watch", () => {
  const dependabot = parseYaml(".github/dependabot.yml");

  test("version 2", () => {
    expect(dependabot.version).toBe(2);
  });

  test("the dev dependencies and the pinned actions", () => {
    const ecosystems = dependabot.updates.map((u: { "package-ecosystem": string }) => u["package-ecosystem"]);
    expect(ecosystems.sort()).toEqual(["github-actions", "npm"]);
  });
});

describe("what git refuses to carry", () => {
  const gitignore = read(".gitignore");

  test("every shape of env file", () => {
    const lines = gitignore.split("\n").map((line) => line.trim());
    expect(lines).toContain(".env");
    expect(lines).toContain(".env.*");
  });

  test("the build output, the dependencies and the renders", () => {
    for (const entry of ["dist", "node_modules", "renders/"]) {
      expect(gitignore).toContain(entry);
    }
  });

  test("no env file is tracked", async () => {
    const tracked = (await Bun.$`git ls-files`.cwd(repoRoot).text()).split("\n");
    expect(tracked.filter((path) => /(^|\/)\.env($|\.)/.test(path))).toEqual([]);
  });
});

/**
 * The linter passes its own dash rule.
 *
 * A prose linter whose first countable rule is "no long dashes" cannot ship a
 * source tree full of them. Running the tool on its own comments is the only
 * check nobody has to remember to run.
 *
 * Where the character is the point, code writes it as an escape (\u2014 and
 * \u2013), so the behaviour is unchanged and the file still holds neither
 * character. What is left is the handful of fixture documents that exist to be
 * flagged, and those are named below with a reason each. The `examples/`
 * corpus needs no entry: it passes on its own today, and an example that has to
 * carry a dash belongs in this list beside the others.
 */
describe("the tool passes the dash rule it enforces", () => {
  // An en dash or an em dash, as escapes, so this file is not its own exception.
  const LONG_DASH = /[\u2013\u2014]/;

  const allowed: readonly { readonly file: string; readonly why: string }[] = [
    {
      file: "tests/fixtures/eval/corpus/already-flagged.md",
      why: "A base paragraph that already trips a rule, so the seeder must refuse it.",
    },
    {
      file: "tests/fixtures/texts/closer.md",
      why: "A draft written to be flagged: a dash and a restating closer in one file.",
    },
    {
      file: "tests/fixtures/texts/flagged.md",
      why: "The smallest draft that trips the dash rule, used wherever a flag is expected.",
    },
    {
      file: "tests/fixtures/texts/structure.md",
      why: "Every Markdown shape a countable rule must stay quiet on, ranges included.",
    },
  ];

  /**
   * A committed eval run holds the faults it planted.
   *
   * The seeder's whole job is to put a long dash into a clean paragraph, so the
   * seeded inputs and the scores that name the edit carry the character by
   * construction. Naming the directory rather than each file keeps the next run
   * from having to edit this list.
   */
  const allowedDirectories: readonly { readonly directory: string; readonly why: string }[] = [
    {
      directory: "bench/results/",
      why: "A recorded run's seeded inputs carry the faults the seeder planted.",
    },
  ];

  test("the allowlist names only files that are still there", () => {
    for (const { file } of allowed) {
      expect(existsSync(join(repoRoot, file))).toBe(true);
    }
  });

  test("no other tracked file carries one", async () => {
    const exempt = new Set(allowed.map((entry) => entry.file));
    const tracked = (await Bun.$`git ls-files`.cwd(repoRoot).text())
      .split("\n")
      .filter((path) => path !== "" && !exempt.has(path))
      .filter((path) => !allowedDirectories.some((entry) => path.startsWith(entry.directory)));

    const offenders: string[] = [];
    for (const path of tracked) {
      const full = join(repoRoot, path);
      if (!existsSync(full)) continue;
      const text = readFileSync(full, "utf8");
      if (!LONG_DASH.test(text)) continue;
      const line = text.split("\n").findIndex((one) => LONG_DASH.test(one)) + 1;
      offenders.push(`${path}:${line}`);
    }

    expect(offenders).toEqual([]);
  });
});
