# Releasing

A release is one tag. The tag is what publishes, and everything else here is
what has to be true before you push it.

The version lives in more than one file. `package.json` is the one the release
workflow checks against the tag, and the rest are pins that tell a stranger
which version to fetch. A bump that misses one of them ships a plugin that
installs a version of the tool the plugin was not tested against, so a test
holds them together and fails the release rather than letting that through.

## Before the repository is public, once

**Own the name on npm first.** `snifftest` is the name five separate pins point
at: the Action's `version` input, both `.pre-commit-hooks.yaml` entries, the
hook, and the skill's script. Every one of them is a copy-pasteable install
instruction, and the README tells a reader to install the hook before anything
has been published.

While the name is unclaimed, anyone who reads the public repository can publish
`snifftest` at the pinned version themselves. Every hook, Action and skill
installation then fetches and runs their code, with `TYPESAFE_API_KEY` in scope
wherever the judgment pass is on. The window opens the moment the repository is
public and closes the moment the name is owned, so the order is the whole
control.

Check with `npm view snifftest version`. A 404 means the name is free and this
repository must not be public yet. Publish `0.1.0` through the checklist below,
or reserve the name with a placeholder release, before making it public.

## The checklist

1. **Bump `package.json` first.** The workflow compares the tag with
   `package.json` and refuses a release when they disagree, so this is the
   number the others follow.
2. **Bump every other pin to the same version.** They are listed below. The
   test in `tests/hygiene.test.ts` fails if one of them is left behind.
3. **Write the changelog section.** `CHANGELOG.md` needs a heading that names
   the version, for example `## [0.2.0] - 2026-10-01`, with the link definition
   at the foot of the file. The release notes are cut from that section, and a
   tag with no section fails the release instead of shipping empty notes.
4. **Run the full gate.** `bun run check` is what the workflow runs:
   `tsc --noEmit` then the whole test suite.
5. **Commit, then tag.** `git tag v0.2.0 && git push origin main --tags`. Only a
   tag matching `v[0-9]+.[0-9]+.[0-9]+` triggers the release workflow.
6. **Approve the `release` environment.** The npm token lives on that protected
   environment rather than on the repository, so no other workflow can reach it
   and a tag on its own never publishes unattended. A reviewer has to say yes.
7. **Check the provenance.** The workflow runs
   `npm publish --provenance --access public` with an OIDC token, so the
   published tarball carries an attestation that anyone can check: it says this
   tarball was built by this workflow from this commit, rather than uploaded by
   whoever happened to hold a token. The npm page shows it once the publish
   lands.
8. **The GitHub Release** is cut from the same notes, and picks up
   `assets/snifftest.gif` when that file exists.

## Every file that carries the version

Find them with `git grep -n "0\.1\.0"`, and keep this list in step with what
that prints.

| File | What the number is |
|---|---|
| `package.json` | The published package version. The workflow checks the tag against it. |
| `.claude-plugin/plugin.json` | The Claude Code plugin's own version. |
| `.claude-plugin/marketplace.json` | Twice: the marketplace metadata and the listed plugin. |
| `.pre-commit-hooks.yaml` | Twice: `additional_dependencies` on both hook ids. |
| `action.yml` | The `version` input's default, which is what the action fetches. |
| `hooks/pre-commit` | `SNIFFTEST_VERSION` default, and the install `curl` in the header. |
| `skills/snifftest/scripts/run.sh` | `SNIFFTEST_VERSION` default. |
| `CHANGELOG.md` | The section heading and its link definition. |
| `docs/claude-code.md`, `docs/husky.md` | The versions quoted in the install instructions. |

## Installing from a git revision needs Bun

`package.json` runs `"prepare": "bun run build"`. `dist/` is not in git, so a
git checkout has no executable until something builds one, and `prepare` is
what builds it. That is deliberate: without it, installing this package from a
git URL, which is what the pre-commit framework does with `language: node`,
leaves the `snifftest` bin pointing at nothing.

The cost is that installing from a raw git URL needs Bun on the machine:

```sh
npm install github:DanRWilloughby/snifftest   # needs bun on PATH
```

Installing the published package from npm does not. The tarball carries a built
`dist/`, so `npm install snifftest`, `npx snifftest` and `bunx snifftest` all
work with no Bun and no build step. Use the published package unless you are
deliberately testing an unreleased revision.
