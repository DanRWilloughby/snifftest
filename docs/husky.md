# Running Sniff Test automatically

Three ways to have the checker run without you remembering to: a git hook before
a commit, the pre-commit framework, and a GitHub Action on a pull request.

All three behave the same way about the network. The countable rules run
locally and are free, and they are all that runs unless you opt in. The
judgment rules need a key and an explicit yes, and neither is assumed for you.

## Before a commit

One command, from the root of your repository:

```sh
curl -fsSL https://raw.githubusercontent.com/DanRWilloughby/snifftest/v0.1.0/hooks/pre-commit \
  -o .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

Read the script once before you trust it. It is about a hundred lines of shell
that will run on every commit you make, and you should no more install it
unread than any other script fetched over the network.

A git tag can be moved to point at different code, and `v0.1.0` above is a tag.
Pin the commit instead if you want the stronger guarantee, exactly as you would
for the Action below:

```sh
curl -fsSL https://raw.githubusercontent.com/DanRWilloughby/snifftest/<commit-sha>/hooks/pre-commit \
  -o .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

Take the SHA from the tag you meant to install:
`git ls-remote https://github.com/DanRWilloughby/snifftest refs/tags/v0.1.0`.

If you maintain a repository that publishes a hook this way, add a tag
protection rule for `v*` so a released tag cannot be repointed after people
have installed from it. That is a setting rather than a guarantee, which is why
the SHA form is offered above.

The hook checks the Markdown and text files you staged, as you staged them. A
file you half-staged is checked as it will be committed, so it never blocks you
over a sentence that is still only on disk.

It is quiet when nothing trips, and it does nothing at all when the commit
contains no prose. If the checker itself is broken, missing, or could not be
fetched, it says so and lets the commit through, because a failed download is
not evidence of a bad draft. `SNIFFTEST_STRICT=1` reverses that.

Skip it once:

```sh
SNIFFTEST_SKIP=1 git commit -m "…"
```

`git commit --no-verify` works too.

### Environment

| Variable | Effect |
| --- | --- |
| `SNIFFTEST_SKIP=1` | Skip the hook entirely for this commit. |
| `SNIFFTEST_SEND=1` | Run the judgment rules too. Needs `TYPESAFE_API_KEY`. The value names the destinations it answers for, and `1` is the shorthand for TypeSafe, which is the only place this hook sends. |
| `TYPESAFE_API_KEY` | The key the judgment rules are sent with. Read from the environment only. |
| `SNIFFTEST_STRICT=1` | Treat a broken or missing checker as a reason to block the commit. |
| `SNIFFTEST_THRESHOLD` | The probability at or above which a judgment counts as a flag. |
| `SNIFFTEST_VERSION` | The version fetched when `snifftest` is not installed. Defaults to a pinned one. |
| `SNIFFTEST_BIN` | An absolute path to the executable to run, instead of looking it up. |

Set `SNIFFTEST_SEND=1` without a key and the hook says so and runs the free
rules. It never sends on a guess.

An answer given this way covers the destinations it names and no others, so a
job that sets it for this hook has not also answered for anything else that
would send your text somewhere.

### Which checker runs

Two of the ordinary ways to find a program would let the repository you are
committing to choose one for you, so the hook refuses both.

A `snifftest` on your `PATH` that lives inside the repository is ignored, and
the pinned version is fetched instead. `node_modules/.bin` is on `PATH`
whenever a package script or a hook manager put it there, and a repository you
cloned can commit a `node_modules/snifftest` of its own.

The fetch is made from a scratch directory rather than from your working tree,
because a package manager asked for `snifftest@<version>` while standing in a
repository runs that repository's own copy and never reaches a registry. The
checker is then told which tree to read with `--root`, so the paths it prints
are the paths you staged.

### Speed

The hook looks for `snifftest` on your `PATH` first, then falls back to `bunx`
and `npx`, which fetch a pinned version. Installing it once makes every commit
noticeably faster:

```sh
npm install --global snifftest
```

## With husky

Husky owns `.husky/` instead of `.git/hooks/`. Same script, different home:

```sh
npx husky init
curl -fsSL https://raw.githubusercontent.com/DanRWilloughby/snifftest/v0.1.0/hooks/pre-commit \
  -o .husky/pre-commit && chmod +x .husky/pre-commit
```

Read it first, and swap the tag for a commit SHA, exactly as above.

Nothing else changes. The script finds the staged files itself, so it does not
need `lint-staged` in front of it, and putting one there would hand it the
working tree's content instead of the index's.

## With the pre-commit framework

In `.pre-commit-config.yaml`, pinned to a tag:

```yaml
repos:
  - repo: https://github.com/DanRWilloughby/snifftest
    rev: v0.1.0
    hooks:
      - id: snifftest
```

That is the free hook. The one that also runs the judgment rules is
`snifftest-send`, and it sits under the manual stage, so it runs when you ask:

```sh
SNIFFTEST_SEND=1 pre-commit run --hook-stage manual snifftest-send --all-files
```

## In CI

The Action runs the countable rules and nothing else, unless you turn sending
on and hand it a key. A pull request from a fork is always checked with the
countable rules only, whatever the workflow says, so a contributor's branch can
never make your repository send text or fail for a key it cannot see.

```yaml
name: Prose
on: pull_request

permissions: {}

jobs:
  snifftest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.0.0
      - uses: DanRWilloughby/snifftest@v0.1.0
        with:
          paths: docs
```

Pin the Action by commit SHA rather than by tag if you want the stronger
guarantee; `@v0.1.0` above is the readable form. A tag can be moved, a commit
cannot, which is why `actions/checkout` is pinned by SHA in the example.

To run the judgment rules on your own repository's pull requests, pass the key
in explicitly. The Action reads no other secret, and reaches for nothing on its
own:

```yaml
      - uses: DanRWilloughby/snifftest@v0.1.0
        with:
          paths: docs
          send: "true"
          api-key: ${{ secrets.TYPESAFE_API_KEY }}
```

Use the `pull_request` event. The Action refuses to run on any event whose name
ends in `_target`, because those run in your repository's context, with your
secrets, against a branch the pull request's author controls.

### Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `paths` | `.` | Files or directories to check, space separated. |
| `rules` | *(none)* | A ruleset to use instead of `.snifftest.yaml`. |
| `threshold` | *(the ruleset's)* | The probability at or above which a judgment counts. |
| `version` | pinned | The exact version of the checker to run. A floating tag is refused. |
| `send` | `false` | Run the judgment rules. Needs `api-key`. Forced off on a fork's pull request. |
| `api-key` | *(none)* | Your `TYPESAFE_API_KEY`. |
| `comment` | `false` | Post the flags as a pull request comment. |
| `github-token` | *(none)* | A token with `pull-requests: write`, used only when `comment` is on. |

The comment carries the checker's output only: file, line, rule, probability
and the message your ruleset wrote. No line of the draft is copied into it.
Turning comments on needs `permissions: pull-requests: write` on the job and a
token passed in as `github-token`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Nothing tripped a rule. |
| 1 | At least one flag at or above the threshold. |
| 2 | The checker could not do its job. |
| 3 | The judgment rules needed a yes before sending, and did not get one. |

Codes 2 and 3 are the tool reporting on itself, so neither is ever read as a
verdict on your prose. The hook says which part failed and then does two
things. If the countable rules had already flagged something, it blocks on
that, because those rules ran here, on the staged text, and their result does
not depend on the part that failed. If nothing was flagged, it steps aside and
lets the commit through, unless `SNIFFTEST_STRICT=1` says to treat a failure as
a failure.

The Action does the same in its own way. Its job summary and its pull request
comment carry a different heading for findings, for a checker that could not
finish, and for a run that was never answered, so nothing that went wrong with
the tool is posted under a sentence about the writing.
