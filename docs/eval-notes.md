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

- **A judgment answer inside the no-judgment band does not count as usable.**
  A run whose every answer lands between 0.4 and 0.6 has told the reader
  nothing, so it exits 2 rather than 0. A model that returns the middle of the
  range for everything is the failure this band exists to make visible.

- **A service failure part way through stops the judgment arm.** Revised after a
  real run: over 94 files and 4,587 paragraphs, eight minutes in, the service
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
  a number somebody else controls, and a header asking for an hour would park a
  check for an hour, so the wait is capped at eight seconds and a header past
  that is treated as a failure to report rather than a wait to take.

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

## Two rules now ask about a sentence, not a paragraph

`self_undercutting` and `first_x_that` used to ask whether "the paragraph"
contained the fault. A single bad sentence inside an otherwise confident
paragraph scored just under the bar, between 0.43 and 0.68, because the rest of
the paragraph pulled the answer down. Both rules now say that one sentence is
enough, in the description and in the criterion.

Measured on 2026-09-17 over the packaged corpus, eight seeds per rule, seed 1,
faults from the independent bank, flags counted at 0.7, same day and same
served model for both wordings:

| Rule | Old wording | New wording |
|---|---|---|
| self_undercutting | 4 of 8 | 7 of 8 |
| first_x_that | 5 of 8 | 6 of 8 |
| Clean paragraphs flagged, all rules | 2 of 54 | 2 of 54 |

Sixteen seeds is a small sample, and the wording was first tried on an easier
seed set before it was checked here. The run with the new wording is committed
under `bench/results/2026-09-17/`. The other judgment rules already asked about
"at least one" sentence or run and were left alone.
