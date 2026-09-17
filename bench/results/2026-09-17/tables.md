# snifftest eval, 2026-09-17

112 seeded paragraphs, 24 clean ones and 30 near misses, which are counted as clean. 8 seeds per rule, seed value 1, seed version 2. Served by jev-1.13.0. Flags count at 0.7.

Every seeded paragraph is positive for its own rule and negative for every other one, so a flag on any other rule is a false positive and never a catch. Recall is measured on the seeded paragraphs for that rule, and the false-positive rate on the clean ones.

## Headline

| Arm | Countable rules caught | Judgment rules caught | Judgment recall | Clean paragraphs flagged | False alarms per paragraph | Median ms |
|---|---|---|---|---|---|---|
| A (no tool) | 0 of 32 (by construction) | 0 of 80 | 0 of 80, 0.00 (0.00 to 0.05) | 0 of 54 | 0 of 54, 0.00 (0.00 to 0.07) | 0 |
| B (countable rules only) | 32 of 32 (by construction) | 0 of 80 | 0 of 80, 0.00 (0.00 to 0.05) | 0 of 54 | 0 of 54, 0.00 (0.00 to 0.07) | 0 |
| C (countable rules plus judgment) | 32 of 32 (by construction) | 58 of 80 | 58 of 80, 0.72 (0.62 to 0.81) | 2 of 54 | 2 of 54, 0.04 (0.01 to 0.13) | 188 |

Countable rules are the regular expressions. A seeded countable fault is one the pattern itself defines, and the seeder throws away any it does not catch, so that column is a count and not a measurement of skill. Judgment rules are the ones a model answers, and only that column carries a recall figure. The false-alarm rate is per clean paragraph, which is the unit a reader meets: a rate of 0.04 on an eight-paragraph post is about a one-in-three chance of at least one false flag somewhere in it.

Pooled and per-cell figures, which are the flattering ones, are below.

| Arm | Pooled recall | FP per fireable clean cell | FP per clean cell | FP per negative cell |
|---|---|---|---|---|
| A (no tool) | 0 of 112, 0.00 | 0 of 540, 0.00 | 0 of 810, 0.00 | 0.00 |
| B (countable rules only) | 32 of 112, 0.29 | n/a | 0 of 810, 0.00 | 0.00 |
| C (countable rules plus judgment) | 90 of 112, 0.80 | 2 of 540, 0.00 | 2 of 810, 0.00 | 0.00 |

A fireable clean cell is one belonging to a rule that could have fired on a clean paragraph at all. Rules the arm never answered, and rules whose clean paragraphs were pre-filtered for them, are out of that denominator; they are still in the plain per-clean-cell column beside it, which is why the two differ.

## Arm A (no tool)

166 paragraphs, 0 requests, 0 retried, 0 rules unanswered. Median 0 ms, p95 0 ms, $0 in total, $0 per paragraph and $0 per 100 paragraphs sent.

| Rule | Seeds | Caught @0.5 | Caught @0.7 | Caught @0.9 | False alarms @0.5 | False alarms @0.7 | False alarms @0.9 |
|---|---|---|---|---|---|---|---|
| dash_present | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| colon_heavy | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| sentence_rhythm | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| slop_vocab | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| banned_words | 0 | n/a | n/a | n/a | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| not_x_but_y | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| tricolon | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| stacked_hedging | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| rhetorical_opener | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| restating_closer | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| self_undercutting | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| first_x_that | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| naked_cost_figure | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| jobs_claim | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| pullquote_fragment | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |

Every cell is k of n. A rate is printed beside it only where n is 10 or more, because a rate over three seeds is one of four possible numbers and reads as a measurement it is not.

| Threshold | Judgment rules caught | Pooled recall | FP per fireable clean cell | Off-rule flags | Clean paragraphs flagged |
|---|---|---|---|---|---|
| 0.5 | 0 of 80 | 0 of 112, 0.00 | 0 of 540, 0.00 | 0 | 0 of 54 |
| 0.7 | 0 of 80 | 0 of 112, 0.00 | 0 of 540, 0.00 | 0 | 0 of 54 |
| 0.9 | 0 of 80 | 0 of 112, 0.00 | 0 of 540, 0.00 | 0 | 0 of 54 |

## Arm B (countable rules only)

166 paragraphs, 0 requests, 0 retried, 0 rules unanswered. Median 0 ms, p95 1 ms, $0 in total, $0 per paragraph and $0 per 100 paragraphs sent.

| Rule | Seeds | Caught @0.5 | Caught @0.7 | Caught @0.9 | False alarms @0.5 | False alarms @0.7 | False alarms @0.9 |
|---|---|---|---|---|---|---|---|
| dash_present | 8 | 8 of 8 | 8 of 8 | 8 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| colon_heavy | 8 | 8 of 8 | 8 of 8 | 8 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| sentence_rhythm | 8 | 8 of 8 | 8 of 8 | 8 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| slop_vocab | 8 | 8 of 8 | 8 of 8 | 8 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| banned_words | 0 | n/a | n/a | n/a | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| not_x_but_y | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| tricolon | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| stacked_hedging | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| rhetorical_opener | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| restating_closer | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| self_undercutting | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| first_x_that | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| naked_cost_figure | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| jobs_claim | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| pullquote_fragment | 8 | 0 of 8 | 0 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |

Every cell is k of n. A rate is printed beside it only where n is 10 or more, because a rate over three seeds is one of four possible numbers and reads as a measurement it is not.

| Threshold | Judgment rules caught | Pooled recall | FP per fireable clean cell | Off-rule flags | Clean paragraphs flagged |
|---|---|---|---|---|---|
| 0.5 | 0 of 80 | 32 of 112, 0.29 | n/a | 0 | 0 of 54 |
| 0.7 | 0 of 80 | 32 of 112, 0.29 | n/a | 0 | 0 of 54 |
| 0.9 | 0 of 80 | 32 of 112, 0.29 | n/a | 0 | 0 of 54 |

## Arm C (countable rules plus judgment)

166 paragraphs, 166 requests, 0 retried, 0 rules unanswered. Median 188 ms, p95 361 ms, $0.0201 in total, $0.000121 per paragraph and $0.0121 per 100 paragraphs sent.

| Rule | Seeds | Caught @0.5 | Caught @0.7 | Caught @0.9 | False alarms @0.5 | False alarms @0.7 | False alarms @0.9 |
|---|---|---|---|---|---|---|---|
| dash_present | 8 | 8 of 8 | 8 of 8 | 8 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| colon_heavy | 8 | 8 of 8 | 8 of 8 | 8 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| sentence_rhythm | 8 | 8 of 8 | 8 of 8 | 8 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| slop_vocab | 8 | 8 of 8 | 8 of 8 | 8 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| banned_words | 0 | n/a | n/a | n/a | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| not_x_but_y | 8 | 4 of 8 | 3 of 8 | 0 of 8 | 7 of 54, 0.13 | 1 of 54, 0.02 | 0 of 54, 0.00 |
| tricolon | 8 | 7 of 8 | 5 of 8 | 1 of 8 | 2 of 54, 0.04 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| stacked_hedging | 8 | 7 of 8 | 6 of 8 | 0 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| rhetorical_opener | 8 | 8 of 8 | 8 of 8 | 6 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| restating_closer | 8 | 8 of 8 | 7 of 8 | 3 of 8 | 1 of 54, 0.02 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| self_undercutting | 8 | 8 of 8 | 7 of 8 | 1 of 8 | 1 of 54, 0.02 | 1 of 54, 0.02 | 1 of 54, 0.02 |
| first_x_that | 8 | 7 of 8 | 6 of 8 | 1 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| naked_cost_figure | 8 | 8 of 8 | 6 of 8 | 1 of 8 | 1 of 54, 0.02 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| jobs_claim | 8 | 6 of 8 | 5 of 8 | 1 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |
| pullquote_fragment | 8 | 7 of 8 | 5 of 8 | 1 of 8 | 0 of 54, 0.00 | 0 of 54, 0.00 | 0 of 54, 0.00 |

Every cell is k of n. A rate is printed beside it only where n is 10 or more, because a rate over three seeds is one of four possible numbers and reads as a measurement it is not.

| Threshold | Judgment rules caught | Pooled recall | FP per fireable clean cell | Off-rule flags | Clean paragraphs flagged |
|---|---|---|---|---|---|
| 0.5 | 70 of 80 | 102 of 112, 0.91 | 12 of 540, 0.02 | 17 | 9 of 54 |
| 0.7 | 58 of 80 | 90 of 112, 0.80 | 2 of 540, 0.00 | 3 | 2 of 54 |
| 0.9 | 15 of 80 | 47 of 112, 0.42 | 1 of 540, 0.00 | 0 | 1 of 54 |

### Calibration

| Bucket | Cells | Defective | Fraction |
|---|---|---|---|
| 0.0-0.1 | 1800 | 1 | 0.00 |
| 0.1-0.2 | 301 | 2 | 0.01 |
| 0.2-0.3 | 126 | 3 | 0.02 |
| 0.3-0.4 | 78 | 1 | 0.01 |
| 0.4-0.5 | 54 | 3 | 0.06 |
| 0.5-0.6 | 14 | 5 | 0.36 |
| 0.6-0.7 | 22 | 7 | 0.32 |
| 0.7-0.8 | 22 | 18 | 0.82 |
| 0.8-0.9 | 25 | 25 | 1.00 |
| 0.9-1.0 | 48 | 47 | 0.98 |

0 cells are not in those buckets because the arm gave no opinion on them. They count as misses in recall, and a probability of zero would have read as an answer.

### Misses at 0.7 (22)

- `S98` jobs_claim at 0.040: The last pass is the one most people skip, which is a night's sleep. A draft read the next morning is a different object from the draft y...
- `S40` not_x_but_y at 0.120: In 1732 I first publish'd my Almanack, under the name of Richard Saunders; it was continu'd by me about twenty-five years, commonly call'...
- `S38` not_x_but_y at 0.140: Keimer and I liv'd on a pretty good familiar footing, and agreed tolerably well, for he suspected nothing of my setting up. He retained a...
- `S81` first_x_that at 0.210: Keimer and I liv'd on a pretty good familiar footing, and agreed tolerably well, for he suspected nothing of my setting up. We got there ...
- `S33` not_x_but_y at 0.240: The app runs on any phone sold in the last six years and on a browser at the office. It does not draw plans, and it does not try to. The ...
- `S55` stacked_hedging at 0.270: The list has to be owned by the people who use it, or it dies within a month. A list handed down from an office is followed for a week an...
- `S43` tricolon at 0.390: Subject lines are read more than bodies, so write the subject last, after you know what the message is actually about. Six words or fewer...
- `S100` jobs_claim at 0.400: While I was intent on improving my language, I met with an English grammar (I think it was Greenwood's), at the end of which there were t...
- `S36` not_x_but_y at 0.450: Measure it. Keep a plain spreadsheet with the date, the recipient's role, the first line you used, and whether a reply came inside a week...
- `S108` pullquote_fragment at 0.490: The second change is to the configuration file. *"Twelve minutes, every morning."* The tool used to look for its settings in four places ...
- `S34` not_x_but_y at 0.500: The second pass is for the paragraph endings. A first draft tends to finish each paragraph twice, once when the point lands and once more...
- `S86` first_x_that at 0.510: While I was intent on improving my language, I met with an English grammar (I think it was Greenwood's), at the end of which there were t...
- `S106` pullquote_fragment at 0.510: The breaking into this money of Vernon's was one of the first great errata of my life; and this affair show'd that my father was not much...
- `S96` naked_cost_figure at 0.570: Crews on a job site write things down on whatever is nearest, which is usually a glove or the back of a delivery note. The whole afternoo...
- `S73` self_undercutting at 0.590: The second change is to the configuration file. The tool used to look for its settings in four places in a fixed order and take the first...
- `S90` naked_cost_figure at 0.610: About this time I met with an odd volume of the Spectator. It was the third. I had never before seen any of them. I bought it, read it ov...
- `S112` pullquote_fragment at 0.610: The second pass is for the paragraph endings. A first draft tends to finish each paragraph twice, once when the point lands and once more...
- `S46` tricolon at 0.650: The main road took a median of fourteen minutes and ten seconds, with the slowest walk at sixteen minutes because of a crossing that stay...
- `S103` jobs_claim at 0.670: The breaking into this money of Vernon's was one of the first great errata of my life; and this affair show'd that my father was not much...
- `S47` tricolon at 0.680: About this time I met with an odd volume of the Spectator. It was the third. I had never before seen any of them. I bought it, read it ov...
- `S71` restating_closer at 0.680: A cold email has one job, which is to earn a reply, and most of them fail it in the first line by talking about the sender. The reader op...
- `S49` stacked_hedging at 0.690: Subject lines are read more than bodies, so write the subject last, after you know what the message is actually about. Six words or fewer...

### False positives at 0.7 (2)

- `N01` self_undercutting at 0.940: The last pass is the one most people skip, which is a night's sleep. A draft read the next morning is a different object from the draft y...
- `N18` not_x_but_y at 0.720: The last pass is the one most people skip, which is a night's sleep. The March version dropped every file after the first symlink, which ...

## The seeded corpus

| Paragraph | Rule | Transform | Base |
|---|---|---|---|
| S01 | dash_present | insert_em_dash | C19 (examples/corpus/release-note.md) |
| S02 | dash_present | insert_em_dash | C15 (examples/corpus/on-checklists.md) |
| S03 | dash_present | insert_em_dash | C20 (examples/corpus/station-routes.md) |
| S04 | dash_present | insert_em_dash | C05 (examples/corpus/editing-by-ear.md) |
| S05 | dash_present | insert_em_dash | C00 (examples/corpus/cold-email.md) |
| S06 | dash_present | insert_em_dash | C09 (examples/corpus/franklin-the-printer.md) |
| S07 | dash_present | insert_em_dash | C21 (examples/corpus/station-routes.md) |
| S08 | dash_present | insert_em_dash | C01 (examples/corpus/cold-email.md) |
| S09 | colon_heavy | add_colons | C04 (examples/corpus/editing-by-ear.md) |
| S10 | colon_heavy | add_colons | C16 (examples/corpus/on-checklists.md) |
| S11 | colon_heavy | add_colons | C14 (examples/corpus/on-checklists.md) |
| S12 | colon_heavy | add_colons | C15 (examples/corpus/on-checklists.md) |
| S13 | colon_heavy | add_colons | C12 (examples/corpus/franklin-the-socratic-method.md) |
| S14 | colon_heavy | add_colons | C09 (examples/corpus/franklin-the-printer.md) |
| S15 | colon_heavy | add_colons | C07 (examples/corpus/field-notes-app.md) |
| S16 | colon_heavy | add_colons | C03 (examples/corpus/editing-by-ear.md) |
| S17 | sentence_rhythm | equalize_sentences | C12 (examples/corpus/franklin-the-socratic-method.md) |
| S18 | sentence_rhythm | equalize_sentences | C03 (examples/corpus/editing-by-ear.md) |
| S19 | sentence_rhythm | equalize_sentences | C05 (examples/corpus/editing-by-ear.md) |
| S20 | sentence_rhythm | equalize_sentences | C11 (examples/corpus/franklin-the-socratic-method.md) |
| S21 | sentence_rhythm | equalize_sentences | C16 (examples/corpus/on-checklists.md) |
| S22 | sentence_rhythm | equalize_sentences | C23 (examples/corpus/strunk-introduction.md) |
| S23 | sentence_rhythm | equalize_sentences | C13 (examples/corpus/franklin-the-spectator.md) |
| S24 | sentence_rhythm | equalize_sentences | C01 (examples/corpus/cold-email.md) |
| S25 | slop_vocab | insert_slop_word | C08 (examples/corpus/field-notes-app.md) |
| S26 | slop_vocab | insert_slop_word | C14 (examples/corpus/on-checklists.md) |
| S27 | slop_vocab | insert_slop_word | C11 (examples/corpus/franklin-the-socratic-method.md) |
| S28 | slop_vocab | insert_slop_word | C20 (examples/corpus/station-routes.md) |
| S29 | slop_vocab | insert_slop_word | C12 (examples/corpus/franklin-the-socratic-method.md) |
| S30 | slop_vocab | insert_slop_word | C04 (examples/corpus/editing-by-ear.md) |
| S31 | slop_vocab | insert_slop_word | C03 (examples/corpus/editing-by-ear.md) |
| S32 | slop_vocab | insert_slop_word | C18 (examples/corpus/release-note.md) |
| S33 | not_x_but_y | splice | C08 (examples/corpus/field-notes-app.md) |
| S34 | not_x_but_y | splice | C04 (examples/corpus/editing-by-ear.md) |
| S35 | not_x_but_y | splice | C05 (examples/corpus/editing-by-ear.md) |
| S36 | not_x_but_y | splice | C02 (examples/corpus/cold-email.md) |
| S37 | not_x_but_y | splice | C19 (examples/corpus/release-note.md) |
| S38 | not_x_but_y | splice | C12 (examples/corpus/franklin-the-socratic-method.md) |
| S39 | not_x_but_y | splice | C03 (examples/corpus/editing-by-ear.md) |
| S40 | not_x_but_y | splice | C10 (examples/corpus/franklin-the-printer.md) |
| S41 | tricolon | splice | C18 (examples/corpus/release-note.md) |
| S42 | tricolon | splice | C19 (examples/corpus/release-note.md) |
| S43 | tricolon | splice | C01 (examples/corpus/cold-email.md) |
| S44 | tricolon | splice | C12 (examples/corpus/franklin-the-socratic-method.md) |
| S45 | tricolon | splice | C15 (examples/corpus/on-checklists.md) |
| S46 | tricolon | splice | C21 (examples/corpus/station-routes.md) |
| S47 | tricolon | splice | C13 (examples/corpus/franklin-the-spectator.md) |
| S48 | tricolon | splice | C10 (examples/corpus/franklin-the-printer.md) |
| S49 | stacked_hedging | splice | C01 (examples/corpus/cold-email.md) |
| S50 | stacked_hedging | splice | C13 (examples/corpus/franklin-the-spectator.md) |
| S51 | stacked_hedging | splice | C06 (examples/corpus/field-notes-app.md) |
| S52 | stacked_hedging | splice | C08 (examples/corpus/field-notes-app.md) |
| S53 | stacked_hedging | splice | C14 (examples/corpus/on-checklists.md) |
| S54 | stacked_hedging | splice | C00 (examples/corpus/cold-email.md) |
| S55 | stacked_hedging | splice | C16 (examples/corpus/on-checklists.md) |
| S56 | stacked_hedging | splice | C02 (examples/corpus/cold-email.md) |
| S57 | rhetorical_opener | splice | C03 (examples/corpus/editing-by-ear.md) |
| S58 | rhetorical_opener | splice | C09 (examples/corpus/franklin-the-printer.md) |
| S59 | rhetorical_opener | splice | C15 (examples/corpus/on-checklists.md) |
| S60 | rhetorical_opener | splice | C11 (examples/corpus/franklin-the-socratic-method.md) |
| S61 | rhetorical_opener | splice | C10 (examples/corpus/franklin-the-printer.md) |
| S62 | rhetorical_opener | splice | C08 (examples/corpus/field-notes-app.md) |
| S63 | rhetorical_opener | splice | C21 (examples/corpus/station-routes.md) |
| S64 | rhetorical_opener | splice | C00 (examples/corpus/cold-email.md) |
| S65 | restating_closer | splice | C07 (examples/corpus/field-notes-app.md) |
| S66 | restating_closer | splice | C23 (examples/corpus/strunk-introduction.md) |
| S67 | restating_closer | splice | C09 (examples/corpus/franklin-the-printer.md) |
| S68 | restating_closer | splice | C11 (examples/corpus/franklin-the-socratic-method.md) |
| S69 | restating_closer | splice | C03 (examples/corpus/editing-by-ear.md) |
| S70 | restating_closer | splice | C21 (examples/corpus/station-routes.md) |
| S71 | restating_closer | splice | C00 (examples/corpus/cold-email.md) |
| S72 | restating_closer | splice | C12 (examples/corpus/franklin-the-socratic-method.md) |
| S73 | self_undercutting | splice | C18 (examples/corpus/release-note.md) |
| S74 | self_undercutting | splice | C22 (examples/corpus/station-routes.md) |
| S75 | self_undercutting | splice | C09 (examples/corpus/franklin-the-printer.md) |
| S76 | self_undercutting | splice | C15 (examples/corpus/on-checklists.md) |
| S77 | self_undercutting | splice | C06 (examples/corpus/field-notes-app.md) |
| S78 | self_undercutting | splice | C20 (examples/corpus/station-routes.md) |
| S79 | self_undercutting | splice | C23 (examples/corpus/strunk-introduction.md) |
| S80 | self_undercutting | splice | C02 (examples/corpus/cold-email.md) |
| S81 | first_x_that | splice | C12 (examples/corpus/franklin-the-socratic-method.md) |
| S82 | first_x_that | splice | C16 (examples/corpus/on-checklists.md) |
| S83 | first_x_that | splice | C03 (examples/corpus/editing-by-ear.md) |
| S84 | first_x_that | splice | C23 (examples/corpus/strunk-introduction.md) |
| S85 | first_x_that | splice | C10 (examples/corpus/franklin-the-printer.md) |
| S86 | first_x_that | splice | C11 (examples/corpus/franklin-the-socratic-method.md) |
| S87 | first_x_that | splice | C08 (examples/corpus/field-notes-app.md) |
| S88 | first_x_that | splice | C20 (examples/corpus/station-routes.md) |
| S89 | naked_cost_figure | splice | C01 (examples/corpus/cold-email.md) |
| S90 | naked_cost_figure | splice | C13 (examples/corpus/franklin-the-spectator.md) |
| S91 | naked_cost_figure | splice | C22 (examples/corpus/station-routes.md) |
| S92 | naked_cost_figure | splice | C05 (examples/corpus/editing-by-ear.md) |
| S93 | naked_cost_figure | splice | C20 (examples/corpus/station-routes.md) |
| S94 | naked_cost_figure | splice | C17 (examples/corpus/release-note.md) |
| S95 | naked_cost_figure | splice | C12 (examples/corpus/franklin-the-socratic-method.md) |
| S96 | naked_cost_figure | splice | C06 (examples/corpus/field-notes-app.md) |
| S97 | jobs_claim | splice | C14 (examples/corpus/on-checklists.md) |
| S98 | jobs_claim | splice | C05 (examples/corpus/editing-by-ear.md) |
| S99 | jobs_claim | splice | C04 (examples/corpus/editing-by-ear.md) |
| S100 | jobs_claim | splice | C11 (examples/corpus/franklin-the-socratic-method.md) |
| S101 | jobs_claim | splice | C07 (examples/corpus/field-notes-app.md) |
| S102 | jobs_claim | splice | C19 (examples/corpus/release-note.md) |
| S103 | jobs_claim | splice | C09 (examples/corpus/franklin-the-printer.md) |
| S104 | jobs_claim | splice | C21 (examples/corpus/station-routes.md) |
| S105 | pullquote_fragment | splice | C16 (examples/corpus/on-checklists.md) |
| S106 | pullquote_fragment | splice | C09 (examples/corpus/franklin-the-printer.md) |
| S107 | pullquote_fragment | splice | C03 (examples/corpus/editing-by-ear.md) |
| S108 | pullquote_fragment | splice | C18 (examples/corpus/release-note.md) |
| S109 | pullquote_fragment | splice | C10 (examples/corpus/franklin-the-printer.md) |
| S110 | pullquote_fragment | splice | C11 (examples/corpus/franklin-the-socratic-method.md) |
| S111 | pullquote_fragment | splice | C19 (examples/corpus/release-note.md) |
| S112 | pullquote_fragment | splice | C04 (examples/corpus/editing-by-ear.md) |

## Hard negatives

Each of these is a clean paragraph with a sentence planted in it that sits close to one rule and is not a defect. A flag on one is a false positive, and it is the false positive worth knowing about, because it is the one a careful writer would meet.

| Paragraph | Near | Why it is not a defect | Flagged by |
|---|---|---|---|
| N01 | not_x_but_y | a plain negation with nothing put in its place | nobody |
| N02 | not_x_but_y | a denial followed by a separate fact rather than a relabelling | nobody |
| N03 | not_x_but_y | a comparison inside a sentence that carries its own information | nobody |
| N04 | tricolon | three named steps, each carrying its own instruction | nobody |
| N05 | tricolon | a list of three that carries distinct facts | nobody |
| N06 | tricolon | three findings quoted and discussed, not a flourish | nobody |
| N07 | stacked_hedging | one hedge, used once and on purpose | nobody |
| N08 | stacked_hedging | uncertainty stated plainly | nobody |
| N09 | stacked_hedging | precise qualifiers on numbers | nobody |
| N10 | rhetorical_opener | a question reported rather than asked, and not the opening sentence | nobody |
| N11 | rhetorical_opener | a curious-sounding statement that is not a question | nobody |
| N12 | rhetorical_opener | a question somebody actually asked, addressed to a person | nobody |
| N13 | restating_closer | a closing sentence carrying a number the paragraph had not given | nobody |
| N14 | restating_closer | a closer naming a mechanism rather than repeating | nobody |
| N15 | restating_closer | a closing condition the paragraph had not yet made | nobody |
| N16 | self_undercutting | a precise statement of scope | nobody |
| N17 | self_undercutting | a measured result with its range | nobody |
| N18 | self_undercutting | a specific past failure the paragraph then explains | nobody |
| N19 | first_x_that | a dated historical fact about somebody else, with a source | nobody |
| N20 | first_x_that | first as a position in a sequence | nobody |
| N21 | first_x_that | a claim of being different rather than first | nobody |
| N22 | naked_cost_figure | a cost quoted with the customer price and the alternative | nobody |
| N23 | naked_cost_figure | a cost in a technical appendix that names what it measures | nobody |
| N24 | naked_cost_figure | a customer price quoted as a price | nobody |
| N25 | jobs_claim | the division of work described with no employment claim | nobody |
| N26 | jobs_claim | naming who reviews, with no claim about employment | nobody |
| N27 | jobs_claim | replacing a thing rather than a person | nobody |
| N28 | pullquote_fragment | a pull quote that is a complete sentence | nobody |
| N29 | pullquote_fragment | a short quotation running inline inside a sentence | nobody |
| N30 | pullquote_fragment | a heading, which is not a pull quote | nobody |

Rules that could not be fully seeded:

- `banned_words`: no paragraph could be seeded (rule "banned_words": the rule has no words, so no defect of this kind can be made)

Requests that failed: 0.

The seeds are synthetic splices and mechanical edits, so these recall figures are an upper bound on what the same rules would catch in defects that occurred naturally.

## What a paragraph is, and what a dollar figure rests on

The unit everywhere above is a paragraph: one blank-line block of a Markdown file, and one request carrying all 15 questions about it. A cost per 100 paragraphs is a cost per 100 requests, so the bill for a document is that rate times the paragraphs it holds, and it grows with the number of rules in the ruleset as well.

Token counts are provider-reported. The price used is $0.042 per million input tokens and $0.000 per million output tokens, from no published source that anyone has recorded and carrying no date. Read the dollar columns as arithmetic on measured usage at a price nobody here has verified.
