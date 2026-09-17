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
  file, line, rule, probability, message. `--format json` for machines.
- A YAML ruleset. Countable rules run as regular expressions and never touch the
  network; judgment rules are read by TypeSafe's Jev model.
- `--dry-run` runs the countable rules only and sends nothing. The first time a
  judgment rule would send text, the CLI says what leaves the machine and asks.
- `snifftest eval` plants one known fault per rule in your own clean text and
  reports what each arm caught, what it cost and how long it took.
- A git pre-commit hook, a manifest for the pre-commit framework, and a
  composite GitHub Action. All three run the countable rules only unless you opt
  in, and a pull request from a fork never sends anything.

[0.1.0]: https://github.com/DanRWilloughby/snifftest/releases/tag/v0.1.0
