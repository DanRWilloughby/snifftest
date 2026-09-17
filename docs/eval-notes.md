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

- **A service failure part way through stops the judgment arm.** One paragraph
  the local guard refuses is skipped and the run carries on, because the next
  paragraph is probably fine. A rejected key or a dead socket will answer every
  remaining paragraph the same way, so the arm stops asking, keeps every answer
  already paid for, and names each paragraph it did not send.

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
