# Contributing

Thanks for looking. This is a small tool with a narrow job: read a draft, say
which house rules it trips, and be honest about how sure it is.

## Ground rules

- **Zero runtime dependencies.** The published package installs nothing. If a
  change needs a library at runtime, it needs a conversation first. Dev
  dependencies are fine, pinned to an exact version.
- **The countable rules never touch the network.** Anything that sends text
  belongs behind the send opt-in, and the first screen of the README has to keep
  telling the truth about what leaves the machine.
- **No secrets, ever.** Keys are read from the environment. `.env` files are
  ignored by git and a secret scan runs on every pull request.
- **Conventional commits**, squashed on merge.

## Getting set up

```sh
bun install
bun run check      # typecheck, then the tests
```

Run the checker straight from source while you work:

```sh
bun src/cli.ts check --dry-run README.md
```

`--dry-run` runs the countable rules only. Drop it and the judgment rules run,
which sends the text of those files to TypeSafe and needs `TYPESAFE_API_KEY` in
your environment. The first time that would happen the CLI asks.

## Tests

Write the test first. `bun test` runs everything; `bun test tests/rules.test.ts`
runs one file. Tests use `bun:test` and no test framework beyond it.

A few tests behave differently depending on the environment, and they say so
rather than passing quietly:

- `tests/leakage.test.ts` scans every tracked file for a private list of strings
  that must never appear in this repository. The list itself is not in the
  repository, for the obvious reason. Without `SNIFFTEST_LEAK_DENYLIST` pointing
  at a file, the scan is reported as **skipped**, never as passed.

## Proposing a rule

Open a **Rule proposal** issue. A rule needs four things before it can ship.

1. A one-line description of the thing it catches, in a writer's language.
2. Whether a computer can decide it exactly, which makes it a regex rule, or
   whether it needs reading, which makes it a judgment rule. If a regular
   expression can do it, it must.
3. Two examples that should trip it and two that should not. The near-misses are
   the valuable ones.
4. For a judgment rule, a seed recipe. That is how to plant one clean instance
   of the fault in otherwise clean text, so `snifftest eval` can measure it.

The shipped ruleset stays generic. Rules specific to one company, product or
house style belong in that house's own `.snifftest.yaml`, not here.

## Pull requests

- Keep the diff to one thing.
- `bun run check` green before you push. CI runs the same commands plus a secret
  scan, a dependency review and the checker on this repository's own prose.
- If you change what leaves the machine, change `SECURITY.md` in the same pull
  request.
- If you change behaviour a user would notice, add a line to `CHANGELOG.md`
  under **Unreleased**.

## Reporting a security problem

Do not open a public issue. `SECURITY.md` has the reporting path.
