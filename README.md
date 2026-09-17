<p align="center">
  <img src="assets/nose/concepts/e-sketch.svg" alt="A pencil sketch of a nose in profile" width="160">
</p>

# Sniff Test

Does the draft pass the sniff test?

Sniff Test reads Markdown and plain text and checks it against your house
rules. It prints one line per flag with the file, the line, the rule that
tripped and how sure it is.

There are two kinds of rule. **Countable rules** are regular expressions.
Long dashes, a paragraph with three colons, a banned word, every sentence the
same length. They run on your machine, cost nothing and send nothing anywhere.
**Judgment rules** need something read rather than counted. A closing sentence
that only restates the paragraph, a claim hedged three times, a line that talks
the reader out of the offer. For those it sends one paragraph at a time to a
small hosted judgment model and gets back one probability per rule. It only
does that after you have said yes.

Two things it is not. There is no general model in the loop; the judgment
model returns one probability per question and nothing else. And it will not
rewrite your text. A flag is a sentence for you to fix.

```sh
npm install --global snifftest
snifftest check --dry-run draft.md
```

That runs the countable rules and nothing leaves your machine. To run the
judgment rules too, put a TypeSafe key in `TYPESAFE_API_KEY` and drop
`--dry-run`. The first time, it prints exactly what it is about to send and
where, and waits for your answer.

It exits 0 when nothing tripped, 1 when at least one rule did, 2 when the tool
could not do its job, and 3 when the judgment rules needed a yes and did not
get one.

The nose is the mascot. It is one hand-drawn SVG with six expressions, in
`assets/nose/`, and `snifftest serve` opens a local page where you type and the
nose reacts.

## Reading a flag

```
draft.md:14 dash_present 1.00 A long dash. Give the sentence a full stop instead.
draft.md:31 restating_closer 0.84 The last sentence says the paragraph again. End one sentence earlier.
```

The number is how sure the checker is, between 0 and 1, and it says nothing
about how bad the problem is. A countable rule always scores 1.00. A judgment
rule counts as a flag at or above the threshold, which is 0.7 unless the
ruleset or `--threshold` says otherwise. A reading between 0.4 and 0.6 is
reported as no judgment and never becomes a flag or a pass. That band exists
because the judgment model answers about 0.5 on text it cannot read, and a
flat middle number is the one failure that looks like a clean draft.

`--format json` prints the same flags for a machine, with every reading
including the ones under the threshold. `snifftest rules` prints the ruleset in
force and which file each rule came from, which is the quickest answer to "why
did that flag".

## The rules

The default ruleset ships in `rules/default.yaml`. Fifteen rules, and the file
itself is the documentation. Ten apply to most prose and five are conventions
of copy meant to sell.

| Rule | Kind | What it catches |
| --- | --- | --- |
| `dash_present` | countable | An en dash or an em dash. A hyphen is fine, and so is an en dash between numerals. |
| `colon_heavy` | countable | Three or more colons in one paragraph. URLs and clock times do not count. |
| `sentence_rhythm` | countable | Every sentence the same length, in paragraphs of four sentences and sixty words or more. |
| `slop_vocab` | countable | Twelve words that turn up far more often in generated text than in prose a person wrote. |
| `banned_words` | countable | Your own list. Empty until you fill it. |
| `not_x_but_y` | judgment | A sentence whose whole job is to swap one label for another. |
| `tricolon` | judgment | Three items for the cadence. |
| `stacked_hedging` | judgment | Two or more softeners on one claim. |
| `rhetorical_opener` | judgment | A paragraph that opens on a question nobody asked. |
| `restating_closer` | judgment | A last sentence that says the paragraph again. |
| `self_undercutting` | judgment, marketing | Copy that talks the reader out of the thing on offer. |
| `first_x_that` | judgment, marketing | A claim to be the first. |
| `naked_cost_figure` | judgment, marketing | A cost with no customer price and no alternative beside it. |
| `jobs_claim` | judgment, marketing | A claim about employment. |
| `pullquote_fragment` | judgment, marketing | A display quote with no verb. |

The five rules tagged `marketing` sit out an ordinary run. Ask for them on a
landing page with `--only marketing`, which runs those five and nothing else.
To run everything, write a project file that extends the default and sets
`off_by_default: []`.

Fenced code is dropped before either kind of rule sees it. Headings, tables,
front matter, link definitions and HTML comments are never sent to the
judgment rules, and the countable rules only read the ones a rule names.

### Writing your own

A `.snifftest.yaml` in your project root is picked up on every run. It can
extend the default ruleset and change the rules it disagrees with, matched by
id, so a house that wants five colons instead of three writes one rule and
inherits the other fourteen.

```yaml
version: 1
extends: default
threshold: 0.7

rules:
  # A countable rule of your own is a pattern and a message.
  - id: no_utilize
    kind: regex
    pattern: "\\butili[sz]e"
    flags: i
    message: "Use. The word is use."

  # Override a shipped rule by reusing its id.
  - id: colon_heavy
    kind: regex
    builtin: colon_count
    min: 5
    message: "Five colons in one paragraph."

  # A judgment rule is a description, its near misses, and two criteria.
  - id: passive_apology
    kind: judgment
    what: |
      A sentence that apologises for the document itself: for its length,
      its lateness, or the writer's lack of expertise.
    not_for: |
      An apology to a person for a thing that happened.
      A stated limit of scope.
    examples:
      - "Sorry this is so long."
      - "I am no expert, but here goes."
    criteria:
      true: "At least one sentence apologises for the document or the writer."
      false: "No sentence apologises for the document or the writer."
    message: "The draft is apologising for itself. Cut the line."
```

A countable rule names either a `builtin` or a `pattern`, never both. The
built-ins are `dash_present`, `colon_count`, `sentence_rhythm`, `slop_vocab`
and `banned_words`, and each takes the tuning keys the default file shows. A
rule may carry `tags`, and a countable rule may name the kinds of block it
applies to with `chunks`. A judgment rule's `not_for` is what keeps it honest.
A rule with a `what` and no `not_for` will flag things you did not mean.

A pattern with a nested quantifier is refused when the ruleset loads, and
every pattern runs against a capped slice of text. Neither is a proof that a
pattern cannot run for a long time. See `SECURITY.md`.

To propose a rule for the shipped set, open a rule proposal issue.
`CONTRIBUTING.md` says what one needs.

## Consent, and what leaves the machine

Nothing is sent before the answer to one question is yes. The countable rules
run first, on your machine, whatever happens next. Then, if the ruleset has
judgment rules and you did not pass `--dry-run`, the checker looks for a key in
`TYPESAFE_API_KEY`. Without one it prints the countable verdict, says the
judgment rules could not run, and exits 2. With one, it prints this and waits:

```
Sniff Test is about to use the judgment rules, which run on a model.

  What leaves this machine: one paragraph of your text at a time, from 3 files,
    together with the wording of these rules: not_x_but_y, tricolon, stacked_hedging, rhetorical_opener, restating_closer.
  Where it goes: https://api.typesafe.ai/v1/systemone (TypeSafe), over HTTPS, with your TYPESAFE_API_KEY.
  What comes back: one probability per rule per paragraph.
  What is never sent: file names, file paths, anything outside the text you pointed at.
  There is no telemetry, no analytics, and nothing is stored by this tool.

  Countable rules never leave the machine. Run with --dry-run to use only those.

Send paragraphs to TypeSafe? [y/N]
```

A yes is remembered under `~/.config/snifftest/consent.json`, or under
`$XDG_CONFIG_HOME` when that is set. It is never written into the directory
being checked, because a consent file committed to a repository would answer
for everyone who clones it. `--yes` answers and remembers without the prompt.
`SNIFFTEST_SEND=1` answers for one run in CI and writes nothing down. With no
terminal to ask in and no answer in the environment, the checker exits 3 and
sends nothing.

Each request carries one paragraph and every judgment rule's wording. It goes
over HTTPS with your key as a bearer token, and the reply is a probability per
rule. The wire format and the guards around it are in `src/jev.ts`, which is
the only file in the tool that opens a network connection for `check`.

Answers are cached on disk so that a run interrupted by an outage does not pay
for every paragraph again. The cache lives under `~/.cache/snifftest`, or
`$XDG_CACHE_HOME`, or `SNIFFTEST_CACHE_DIR`. Each entry is named by a hash of
the paragraph, the exact wording of the questions asked about it and the model
they were sent to, and it holds rule ids, probabilities, the model name and a
date. The paragraph itself is never
written to disk. Entries expire after a fortnight. `--no-cache` skips the cache
for a run, and `SNIFFTEST_CACHE_DIR=off` turns it off for good.

`SECURITY.md` has the full account, including the limits.

## Before a commit

One command, from the root of your repository:

```sh
curl -fsSL https://raw.githubusercontent.com/DanRWilloughby/snifftest/v0.1.0/hooks/pre-commit \
  -o .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

Read it before you trust it. The hook checks the Markdown and text files you
staged, as you staged them, with the countable rules only. It sends nothing
unless `SNIFFTEST_SEND=1` and `TYPESAFE_API_KEY` are both in your environment.
It blocks a commit on a flag. When the checker itself is missing, broken or
could not be fetched, it says so and steps aside, because a failed download is
not evidence about your prose. `SNIFFTEST_STRICT=1` reverses that.

Skip it once with `SNIFFTEST_SKIP=1 git commit` or `git commit --no-verify`.

The same script works under husky, and there are two entries for the
pre-commit framework, `snifftest` for the free rules and `snifftest-send` under
the manual stage for the rest. `docs/husky.md` has all three.

## In CI

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

The Action runs the countable rules and nothing else unless you set `send` and
pass a key in as `api-key`. A pull request from a fork always gets the
countable rules only, whatever the workflow says. The Action refuses to run on
any event whose name ends in `_target`, refuses a floating `version`, and
fetches the exact version named from the npm registry into a scratch directory
outside the checkout, so the repository being checked cannot hand it a checker
by committing one. It needs no token of its own. With `comment: true` and a `github-token` it posts
the checker's output on the pull request, and no line of the draft is copied
into that comment.

Pin the Action by commit SHA if you want the stronger guarantee. The inputs and
the exit codes are tabled in `docs/husky.md`.

## In Claude Code

```
/plugin marketplace add DanRWilloughby/snifftest
/plugin install snifftest@snifftest
```

Then `/snifftest draft.md`, or hand Claude a draft and ask whether it passes.
The skill runs the countable rules by default. The judgment pass is the user's
call and the skill never answers the sending question on their behalf: it adds
no flag that skips the prompt and never touches the key. `docs/claude-code.md`
has the two other ways to install it.

## Measuring it

`snifftest eval` plants one known fault per rule into copies of your own clean
paragraphs, runs the corpus three ways, and reports what each way caught and
what it flagged on the clean originals. Arm A is no tool. Arm B is the
countable rules. Arm C is the countable rules plus the judgment rules, and it
is the only arm that costs anything. Each run writes a Markdown report and a
`scores.json`, and it writes the clean and seeded paragraphs beside them with
a `.gitignore`, because they carry your prose in full.

`snifftest bench` asks a panel of general models the same questions over the
same corpus, through OpenRouter and one direct Anthropic call, and puts cost,
speed and accuracy side by side. It asks for consent per destination, and a yes
given for TypeSafe is never a yes for anyone else.

The run committed under `bench/results/2026-09-17/` is the eval over the
packaged corpus with eight seeds per rule. The panel rows below come from a
blind read of the same 166 paragraphs by four general models.

<!-- numbers:start -->
| Arm | Judgment faults caught, of 80 | Clean paragraphs flagged, of 54 | Cost per 100 paragraphs | Median per paragraph |
| --- | --- | --- | --- | --- |
| Sniff Test, judgment model (Jev, measured) | 58 | 2 | $0.0121 | 188 ms |
| Claude Haiku 4.5 (estimate) | 61 | 11 | about $0.34 | not measured |
| Claude Sonnet 5 (estimate) | 63 | 2 | about $1.02 | not measured |
| Claude Opus 5 (estimate) | 72 | 0 | about $1.70 | not measured |
| OpenAI gpt-5.6-sol | 75 | 3 | not priced | not measured |
<!-- numbers:end -->

Flags count at 0.7. The panel models judged about fourteen paragraphs per
context inside agent sessions, and Jev judged one paragraph per request. The
Jev cost and latency are measured from provider-reported usage; the model costs
are estimates at list price and model latency was not measured.

What that supports. On this corpus the judgment model's accuracy sits in the
range of the mid-tier general models, with far fewer false alarms than the
cheapest one, at a small fraction of the cost, and with no general model in
the loop. The top models catch more.

Three things to read beside the table. Eight seeds per rule is a small sample,
so the per-rule figures are direction rather than measurement. The eval
measures every rule in the file, including the five marketing rules an
ordinary check sits out. And two of the ten judgment rules were reworded after
a first run on these seeds and measured again on the same seeds;
`docs/eval-notes.md` carries both numbers and the reasoning.

`snifftest eval --twins examples/adversarial` measures what a sentence written
to the checker does to the readings around it. `examples/CORPUS.md` describes
the corpus and where every paragraph came from.

## Configuration

| Option | What it does |
| --- | --- |
| `--rules <path>` | Use this ruleset instead of `.snifftest.yaml` or the built-in one. |
| `--root <dir>` | The tree being checked, when it is not the directory you are in. |
| `--threshold <0-1>` | The probability at or above which a judgment counts as a flag. |
| `--format text\|json` | How to print the flags. |
| `--only <tags>` | Run only the rules carrying one of these tags. |
| `--skip <tags>` | Never run a rule carrying one of these tags. |
| `--dry-run` | Make no network request of any kind. For `check`, the countable rules and nothing else. |
| `--no-cache` | Ask about every paragraph again instead of reusing an answer from the last fortnight. |
| `--yes`, `-y` | Answer the send question for this run and remember the answer. |

| Variable | What it does |
| --- | --- |
| `TYPESAFE_API_KEY` | The key the judgment rules are sent with. Read from the environment and nowhere else. |
| `SNIFFTEST_SEND` | Answer the send question in CI without remembering it. `1` means TypeSafe, which is where `check` sends and nowhere else. |
| `SNIFFTEST_CACHE_DIR` | Where cached answers live. `off` for none. |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` | Used by `bench` only. |

`snifftest --help` lists the options for `eval` and `bench` as well.

The package has no runtime dependencies and needs Node 20 or newer. Installing
from the npm registry needs nothing else. Installing from a git URL needs Bun
on the machine, because the executable is built on install.

## Contributing

`CONTRIBUTING.md` has the ground rules, the test setup and what a rule proposal
needs. Security problems go to a private advisory, never to a public issue.
`SECURITY.md` says how.

## Licence

MIT. See `LICENSE`.
