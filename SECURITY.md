# Security

What leaves your machine, when, and what to do if you find a problem.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## What leaves the machine

The countable rules are regular expressions. They run on your machine and
never open a network connection.

The judgment rules send text. For each paragraph, one request goes to
`https://api.typesafe.ai/v1/systemone` over HTTPS with your `TYPESAFE_API_KEY`
as a bearer token. The request carries that one paragraph and the wording of
every judgment rule in the ruleset in force. The reply is one probability per
rule. That endpoint is the only place `check` sends anything, and the address
cannot be changed by a ruleset, a flag or an environment variable.

What is never sent: file names, file paths, and anything outside the text you
pointed the tool at. Fenced code is dropped before either kind of rule reads
it. Headings, tables, front matter, link definitions and HTML comments are
never sent. A file that is not UTF-8 text is skipped and reported as skipped.
Text that carries a data URI or a long unbroken run of encoded characters is
refused before a request is built, because the judgment model answers HTTP 200
with meaningless probabilities on such input. A paragraph over 24,000
characters is split before it is sent.

There is no telemetry and no analytics.

`bench` is different. It sends the same paragraphs to general models through
OpenRouter and directly to Anthropic, with `OPENROUTER_API_KEY` and
`ANTHROPIC_API_KEY`. It asks for consent naming each destination, and a yes
given for TypeSafe never covers either of them.

## Consent

Nothing is sent before the answer to the send question is yes.

- The key is checked first. Without `TYPESAFE_API_KEY` the judgment rules
  cannot run, the countable verdict is printed, and the run exits 2. The
  question is never asked for a request the tool could not make.
- With a key, the first run prints what will be sent, where, with which key,
  and what comes back, then waits for `y`. Any other answer sends nothing.
- A yes is stored in `$XDG_CONFIG_HOME/snifftest/consent.json`, or
  `~/.config/snifftest/consent.json`, with mode 0600 in a 0700 directory. It is
  never stored in the directory being checked. The stored answer names the
  destinations it covers, and a new destination asks again.
- `--yes` answers without the prompt and stores the answer.
- `SNIFFTEST_SEND` answers for one run and stores nothing. Its value names the
  destinations it answers for, comma separated. `1` is shorthand for TypeSafe,
  the only place `check` sends, so a CI job that sets it for `check` has not
  answered for `bench`.
- With no terminal to ask in and no answer in the environment, the run exits 3
  and sends nothing. Exit 3 is the question, not an error to work around.
- `--dry-run` makes no network request of any kind, on every command.

The key is read from `TYPESAFE_API_KEY` and from nowhere else. There is no
config file for it and no flag. Every error message that could quote a
provider's reply is passed through a scrubber that removes the key, whole or
cut at either end, before it is printed.

## The hook and the Action

The pre-commit hook in `hooks/pre-commit` runs `check --dry-run` on the staged
Markdown and text files. It sends nothing unless `SNIFFTEST_SEND` is set and
`TYPESAFE_API_KEY` is present, both at once. It refuses a `snifftest` on `PATH`
that resolves inside the repository being committed to, and it fetches the
pinned version from a scratch directory rather than from inside the checkout,
so the repository cannot supply the checker by committing one. A tool failure
never blocks a commit unless `SNIFFTEST_STRICT=1`, but a countable flag that
was printed before the failure still does.

The two entries in `.pre-commit-hooks.yaml` behave the same way. `snifftest`
never sends. `snifftest-send` sits under the manual stage and needs both the
key and `SNIFFTEST_SEND=1`.

The GitHub Action in `action.yml`:

- Runs the countable rules only, unless `send` is `true` and a key is passed in
  as `api-key`. It reads no secret of its own.
- Forces the countable rules on a pull request from a fork, whatever the
  workflow asked for, and on any event it has no fork guard for.
- Refuses to run on any event whose name ends in `_target`.
- Refuses a floating `version`. It fetches the exact version named from the npm
  registry, from a scratch directory, on every run.
- Puts the key in the environment of the step that runs the checker only when
  sending is on, and never in the step that decides.
- Posts a pull request comment only when `comment` is `true` and a token is
  passed in as `github-token`. The comment carries the checker's output, which
  is file, line, rule, probability and the rule's message. No line of the draft
  is copied into it.

The Claude Code skill runs the countable rules by default, adds no flag that
skips the consent prompt, and never reads or prints the key.

## The answer cache

Judgment answers are cached on disk so a run interrupted by an outage does not
pay for every paragraph twice. The cache is under `SNIFFTEST_CACHE_DIR`, else
`$XDG_CACHE_HOME/snifftest`, else `~/.cache/snifftest`. Each file is named by a
SHA-256 of the paragraph, the exact wording of the questions and the model
alias, and it holds rule ids, probabilities, the served model name and a date.
The paragraph is never written to disk. Entries expire after fourteen days.
`--no-cache` skips the cache for a run and `SNIFFTEST_CACHE_DIR=off` disables
it. The cache is opened only after the key check and the consent gate, and
never on `--dry-run`.

## Known limits

- A hash is not the text, but anyone who already has a paragraph can confirm
  from the cache that it was checked. Cache files take the process umask,
  which is usually world-readable, where the consent file is 0600.
- Cache entries are keyed on the model alias `jev-latest`. For up to fourteen
  days after the service moves that alias, answers from the previous version
  can be reported as this run's.
- A cache directory that other users or other jobs can write to is a cache they
  can poison. Keep it private. A poisoned entry can change a probability and
  nothing else, because the reader drops any entry that is not a well-formed
  set of numbers between 0 and 1.
- A pattern rule is refused when it applies a quantifier to a group that
  already contains one. That refusal does not see the same problem written
  with alternation, and the cap on how much text a pattern sees is not a bound
  on how long that family can run. A `.snifftest.yaml` from a repository you
  do not trust can therefore hang a run.
- The hook and the Action fetch the checker from the npm registry at the
  pinned version. What arrives is whatever the registry serves for that name
  and version, so a tag protection rule on this repository and a commit pin on
  the Action are the readers' controls, and owning the name on the registry is
  the maintainer's.
- The scrubber removes the key's value, and prefixes and suffixes of it. It
  cannot remove a re-encoding of the value, such as base64 or a hash, and does
  not try.
- The judgment arm has no overall deadline. A service that is down can hold a
  run for about three minutes before the breaker stops asking.
- A `.snifftest.yaml` found in the working directory may extend only files
  under its own directory tree, or the shipped default. The file it starts
  from is read even when it is a symbolic link.

## Reporting a vulnerability

Open a private security advisory on the repository:

https://github.com/DanRWilloughby/snifftest/security/advisories/new

Do not open a public issue. Say what you found, how to reproduce it, and which
version. You will get a reply on the advisory.
