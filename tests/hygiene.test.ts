/**
 * The repository read as a document.
 *
 * None of this can be unit tested by running it: a workflow only really runs on
 * GitHub, and by the time a release workflow is wrong it has already published
 * something. So the files are parsed and asserted instead, and the properties
 * asserted are the ones that would be expensive to discover afterwards — an
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

  test("the allowlist is exactly the four things a user needs", () => {
    expect(pkg.files).toEqual(["dist", "rules", "README.md", "LICENSE"]);
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
    // revision — which is what the pre-commit framework does with
    // `language: node` — leaves the `snifftest` bin pointing at nothing.
    expect(pkg.scripts.prepare).toBe("bun run build");
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
      // next — and for Dependabot, which rewrites both together.
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
    expect(ci).toMatch(/cli\.ts check --dry-run/);
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
