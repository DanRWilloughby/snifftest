# Notes on the rules and the numbers

Where a choice in this repo is arguable, the reasoning sits here rather than in
a commit message nobody reads twice.

## Considered and rejected

Each line is a thing a reviewer asked for, a decision to leave it alone, and
the reason. A line is reopened by new evidence, not by asking again.

- **A dash inside an inline quotation is still flagged.** Telling somebody
  else's punctuation from the writer's own needs quotation marks parsed, and
  the same characters mean five other things in Markdown. A block quote is a
  whole block and is easy to tell, so `dash_present` skips those. The rule's
  note in the ruleset says so, which is the honest version of a limit the tool
  cannot cheaply reach.

- **A number range written with an en dash is not a flag.** "Pages 10 to 20"
  set with the typographer's dash is a range, and the rule is about a writer
  reaching for a dash where a full stop belongs. An em dash between numerals is
  still flagged, because it is never a range. A house that wants every long
  dash gone writes its own pattern rule, which is four lines.

- **`slop_vocab` matches ordinary suffixes, not every derivation.** The stem
  plus s, es, ed, ing, ly, ment and ion covers the forms the complaint was
  about. A word further from the stem, such as "intricacies", is a separate
  word and belongs on the list if a house wants it. Stemming properly would
  mean shipping a stemmer, and this tool has no runtime dependencies.

- **Tags filter `check` and nothing else.** `eval` and `bench` measure every
  rule in the file they are pointed at, including the ones an ordinary run sits
  out. A measurement that quietly skipped half the ruleset would report a
  recall figure for a ruleset nobody runs.

  The consequence belongs beside the numbers rather than only here. The
  headline recall and the cost per hundred paragraphs describe a request that
  asks about every judgment rule in the file. An ordinary `check` asks about
  the ones that are not tagged `marketing`, which is fewer questions per
  request, so it is cheaper than the eval's figure and its recall is measured
  over a smaller set of rules.

- **`--only` narrows what gets asked, not what gets checked.** The countable
  rules are regular expressions: they send nothing, they cost nothing, and a
  narrowing meant to limit what a model is asked about has no reason to stop
  them catching an em dash. They keep running under `--only` and go out only
  when `--skip` names their tag. A tag no rule in the file carries is a usage
  error that lists the tags that exist, because obeying it would mean running
  nothing and exiting 0, which reads exactly like a clean draft.

- **The judgment arm is never asked about structure.** A heading, a table,
  front matter, a link definition and an HTML comment go through the same
  filter `check` uses and are scored by the countable rules alone. An eval that
  asked about them would pay a paragraph's price for a question nobody asked
  and measure a product nobody ships. The count of blocks held back is printed
  under the headline table.

- **The eval carries the same breaker `check` has.** A local refusal is that
  paragraph's business and the run carries on. A 429, a 5xx or a dropped socket
  is a bad minute, and three in a row with no answer between them opens the
  breaker. A rejected key or a malformed request stops the arm on the first
  one. A run that got no usable answer to anything exits 2 with a plain line
  rather than printing a recall of zero, which would read as rules that never
  fire rather than a service that never answered.

- **The near misses are written out and travel to the bench.** They sit in
  `inputs/negatives.json` beside the clean and seeded paragraphs, and
  `bench --eval <dir>` reads them as clean documents. They are the hardest
  clean paragraphs in the corpus, so a bench that left them out would measure
  every row on the easy half of the false-alarm question. A bench given paths
  rather than an eval directory seeds from the same bank for the same reason.

- **The bench headline reports judgment-only recall beside the pooled
  figure.** The pooled column adds the countable cells, which every row gets
  right for free and which the seeder guaranteed, so it puts the same floor
  under every row. The spread across repeats is the judgment half too, because
  the countable cells do not move between repeats and pooling them shrinks
  every range towards an agreement the models never showed.

- **The tuning disclosure is written by the report code.** A rule reworded
  after watching it miss faults on this seed set, and then measured again on
  the same seeds, is named in the tables themselves rather than only in this
  file. Adding a rule to that list is part of rewording it.

- **A judgment answer inside the no-judgment band does not count as usable.**
  A run whose every answer lands between 0.4 and 0.6 has told the reader
  nothing, so it exits 2 rather than 0. A model that returns the middle of the
  range for everything is the failure this band exists to make visible.

- **A service failure part way through no longer stops the judgment arm on the
  first one.** Revised after a real run: over 94 files and 4,587 paragraphs, eight minutes in, the service
  answered 503 once. Stopping on the first failure threw away eight minutes of
  answers to learn that one minute was bad. Three kinds of failure are now told
  apart. A paragraph the local guard refuses is that paragraph's business and
  the run carries on. A 429, a 5xx or a dropped socket is a bad minute: the
  paragraph is marked unanswered, the next one is asked, and three of them in a
  row with no answer between opens the breaker. A rejected key or a malformed
  request is not a minute, it is the request, so the arm stops on the first one.
  Every route keeps the answers already received, and the exit code comes from
  the flags that exist.

- **Answers already paid for are cached on disk, rather than deferred.** The
  case against was that a judgment is a model's opinion on a day and a cache
  serves yesterday's. The case for is the run above: without one, the rerun
  after an outage pays for all 4,587 paragraphs to recover the 1,200 it lost.
  The compromise is that a cache entry is keyed by the paragraph, the exact
  wording of every question asked about it and the model it was asked of, so a
  reworded rule is never answered from an old reading, and entries expire after
  a fortnight so nothing reports a stale opinion as today's. Only an answer is
  kept: a reply that came back empty, left a question out, or put every one of
  its numbers inside the no-judgment band is never written down, because the
  alternative is that one bad minute pins "asked, and nothing came back" to a
  paragraph for a fortnight at no cost. A read checks the same things again, and
  once a run has had a live answer it stops accepting entries served by a
  different version of the model. A run answered entirely from disk cannot know
  the alias moved under it, which is the limit of doing this without spending a
  request, and the reason entries expire at all. The paragraph is never written
  to disk: the file name is a hash of it and the file holds rule ids,
  probabilities, the wording they answered, a model name and a date, written
  0600 inside 0700 directories through a temporary file and a rename. Expired
  entries are deleted the first time a run writes. `--no-cache` turns it off for
  a run and `SNIFFTEST_CACHE_DIR=off` turns it off for good; a relative
  `SNIFFTEST_CACHE_DIR` is a place in the home directory, never in the tree
  being checked.

- **`Retry-After` is honoured, up to a cap.** A service that says how long to
  wait knows better than the doubling ladder, so its number is used. It is also
  a number somebody else controls. A header asking for an hour would park a
  check for an hour, so anything past eight seconds is reported as the failure
  it is and not waited for at all; the cap used to be applied to the wait
  instead, which meant taking eight seconds three times over and reporting the
  same failure anyway. A header of zero is a service saying "at once", which is
  a request to hammer it, so it gets the ladder's first step.

- **The judgment arm has an overall budget as well as a breaker.** The breaker
  catches a service that fails. It does not catch one that answers every
  request slowly, and four attempts with three backoffs and a ten second
  timeout make a worst case near fifty seconds for a single paragraph. The
  budget is twenty seconds for every paragraph the arm means to send, with a
  floor of a minute so one slow paragraph keeps its full retry ladder. It is a
  budget rather than a timeout: it is consulted before each request, a request
  already in flight finishes, every answer already received is kept, and the
  paragraphs that went unasked are named with the reason.

- **A `.snifftest.yaml` found by looking is not followed through a symbolic
  link.** Nobody typed that path. A link there reads a ruleset from somewhere
  else in the tree, or outside it, under a name that says the rules are local.
  A ruleset named with `--rules` is the caller's own business and is followed.

- **The hook's "a few milliseconds" line has been retired.** The countable
  check itself is that fast. Finding snifftest is not: an installed one runs at
  once, and the `bunx` and `npx` paths fetch the package the first time, which
  is a download. The hook now says so.

- **The judgment service's price prints as unknown in the bench and as a
  disclosed constant in the eval.** No dated published price has been recorded
  for that endpoint. The bench table compares it against rows whose prices come
  from a provider's own list or a dated file, and an unsourced number in that
  column would read as one of them, so the row prints unknown. The eval's own
  report has one arm and prints the constant with its basis beside it: the
  usage is provider-reported, the price is not sourced, and it says so. When a
  dated price exists it goes in `bench/prices/` beside the Anthropic file and
  both surfaces read it.
- **Arm C's accuracy is still joined from the eval, not measured in the bench.**
  Jev is in the bench rotation for latency and cost, on the same interleaving
  and the same repeats as every other row. Its accuracy stays where it is
  scored against arms A and B over the same corpus, because moving it would
  give the project two recall figures for one arm measured two ways, which is
  the fault this change exists to remove.

## Five rules now ask about a sentence, not a paragraph

A rule that asks whether "the paragraph" contains a fault is answered about the
paragraph. A single bad sentence inside an otherwise careful paragraph scored
just under the bar, between 0.43 and 0.68, because the rest of the paragraph
pulled the answer down. `self_undercutting` and `first_x_that` were reworded
first. `tricolon`, `jobs_claim` and `pullquote_fragment` were each catching 5 of
8 and have had the same treatment: the description says to judge sentence by
sentence, and the criterion says that one sentence, anywhere in the paragraph,
is enough and the good sentences around it do not excuse it.

Measured on 2026-09-17 over the packaged corpus, eight seeds per rule, faults
from the independent bank, flags counted at 0.7, cache off, same served model
(`jev-1.13.0`) throughout. The baseline column is the committed seed 1 run under
`bench/results/2026-09-17/`, whose three reworded rules carried the old wording.
Seed 2 is a different draw of faults and hosts, and is the held-out check: the
wording was never looked at against it.

| Rule | Old wording, seed 1 | New wording, seed 1 | New wording, seed 2 |
|---|---|---|---|
| tricolon | 5 of 8 | 7 of 8 | 7 of 8 |
| jobs_claim | 5 of 8 | 7 of 8 | 5 of 8 |
| pullquote_fragment | 5 of 8 | 7 of 8 | 8 of 8 |
| Judgment rules, all ten | 58 of 80 | 63 of 80 | 60 of 80 |
| Clean paragraphs flagged, all rules | 2 of 54 | 2 of 54 | 1 of 54 |

All three are kept. None of the three raised a false alarm on a clean paragraph
in either run, at 0 of 54 each in all three columns.

Read the gain against the noise, which the same two runs measure for free. Seven
rules were not touched at all and still moved between the three columns:
`first_x_that` went 6, 5, 4, `not_x_but_y` went 3, 3, 2, `stacked_hedging` went
6, 5, 6, `restating_closer` went 7, 8, 7 and `rhetorical_opener` went 8, 8, 7.
A swing of one or two out of eight is what this corpus does on its own. So
`tricolon` and `pullquote_fragment` clear it on both seeds and `jobs_claim` does
not: it holds at its old 5 of 8 on the held-out seed rather than improving, and
it is kept on that basis and no stronger one.

Eight seeds per rule is a small sample and every figure here carries an interval
wider than the differences in the table. The honest summary is that three rules
were reworded, two of them look better on unseen faults, and the third looks the
same.

## Recording a replay, so the demo plays back a real run

`examples/replays/example.json` was written by hand. Its probabilities are made
up, the page says so in its mode line, and that is honest enough for trying the
page without a key. It is not honest enough for a launch capture. A video of
numbers nobody measured is a claim, and the argument this repository makes is
that a claim needs a run behind it.

So there is a recorder:

```
snifftest serve --record demo.json --yes draft.md
```

It never starts the page. It reads each draft, walks it the way a writer does,
and at every sentence boundary takes the draft so far as a state the page would
score on its next pause. Each of those prefixes goes through the same chunker
the page's scorer uses, `chunkDocument` with the page's own character guard, and
each prose chunk is asked about with the same questions, built from the same
judgment rules. Structure blocks are skipped, because the page's arm does not
ask about them either. A paragraph state already asked about is not asked again,
so a four sentence draft costs four requests, not ten.

What comes back is written down as it came back: the probability for every rule
the reply carried a usable reading for, the input tokens, the latency and the
cost, all in the gateway's own field names. Nothing is rounded or filled in.
The file carries `measured: true` and a `runDate`, which is the newest run under
`bench/results/` that is committed, not merely present on disk. An eval writes
into today's directory by default, so the newest directory is often a run from
five minutes ago that no reader can open. `--run-date` names one instead.

Two refusals keep the recording honest.

A failed answer stops the whole run and nothing is written. A recording with one
hole in it plays back as a paragraph the nose ignores, which on a capture reads
as a clean paragraph rather than as a request that failed. The file is written
whole or not at all.

And a paragraph the recording does not hold falls through to the file's default,
which carries no readings, no tokens, no time and no cost, because nothing was
measured for it. Filling that gap with a plausible number would be the
hand-written file again.

No test makes a live call. The writer takes a client, and the tests hand it one
that answers from a table.
