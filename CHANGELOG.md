# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes are cut from this file: the release workflow publishes the section
whose heading matches the tag, so a tag with no section here fails the release
rather than shipping an empty one.

## [0.1.0] - Unreleased

### Added

- `snifftest check` reads Markdown and plain text and prints one line per flag:
  file, line, rule, probability, message. `--format json` carries every reading
  for a machine, including the ones under the threshold.
- A YAML ruleset, `rules/default.yaml`, with fifteen rules. Five countable
  rules run as regular expressions and never touch the network. Ten judgment
  rules are answered by a hosted judgment model, one paragraph per request,
  one probability per rule. Five of the judgment rules are tagged `marketing`
  and sit out an ordinary run until `--only marketing` asks for them.
- A `.snifftest.yaml` in the project extends or replaces the shipped ruleset,
  merged rule by rule on id. Countable rules take a built-in or a pattern of
  your own; judgment rules take a description, its near misses, examples and
  two criteria.
- `--dry-run` runs the countable rules only and sends nothing. The first time
  a judgment rule would send text, the CLI prints what leaves the machine and
  where, and asks. `--yes` answers and remembers; `SNIFFTEST_SEND` answers for
  one run in CI and names the destinations it covers.
- A no-judgment band. A probability between 0.4 and 0.6 is reported as no
  judgment and never counts as a flag or a pass. A run whose judgment arm
  answered nothing exits 2 rather than 0.
- Partial results. A paragraph that fails is skipped and the run carries on;
  three transient failures in a row stop the judgment arm; a rejected key
  stops it at once. Every answer already received stays in the verdict.
- An on-disk answer cache, so a rerun after an outage does not pay for every
  paragraph again. Entries expire after fourteen days and never hold the
  paragraph's text. `--no-cache` and `SNIFFTEST_CACHE_DIR=off` turn it off.
- `snifftest rules` prints the ruleset in force and where each rule came from.
- `snifftest eval` plants one known fault per rule into your own clean text,
  from an independent seed bank, runs the corpus three ways and reports what
  each arm caught, what it flagged on clean paragraphs, what it cost and how
  long it took. `--twins` measures what a sentence addressed to the checker
  does to the readings around it.
- `snifftest bench` asks a panel of general models the same questions over the
  same corpus and puts cost, speed and accuracy side by side, with consent
  asked per destination.
- `snifftest serve` opens a local page where you type and the nose reacts,
  live or from a recorded replay that needs no key.
- A git pre-commit hook, two entries for the pre-commit framework, and a
  composite GitHub Action. All of them run the countable rules only unless you
  opt in, and a pull request from a fork never sends anything.
- A Claude Code plugin and skill, `/snifftest`, that runs the free pass by
  default and never answers the sending question on the user's behalf.
- An example corpus of ten documents, a structure set, three adversarial twins
  and a committed eval run under `bench/results/2026-09-17/`.
- The nose: one hand-drawn SVG with six expressions, and a favicon cut.

[0.1.0]: https://github.com/DanRWilloughby/snifftest/releases/tag/v0.1.0
