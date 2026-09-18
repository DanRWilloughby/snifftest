# snifftest bench, 2026-09-18

112 seeded paragraphs and 54 clean ones, seed 1, 8 per rule. Every model was sent the same rule wording and the same paragraph, one call per paragraph. Rows routed through OpenRouter are asked at temperature 0; rows called on their provider's own API are asked at the provider's default, because the Claude 5 and gpt-5 models refuse the field. Beyond that the rows differ in one respect, the completion budget and reasoning each was given, and that is printed in full under "The run". A paragraph is one corpus entry of roughly 150 to 400 words, and one call: every per-paragraph figure below is per call, never per file. The detailed tables are from the first repeat; every repeat is scored and the spread sits beside the headline; latency is the median and p95 over 1 repeat; cost is from returned token usage.

## Headline

| Model | Tier | Model served | Judgment recall, own flag | Pooled recall, own flag | Spread over repeats | Judgment recall, p >= 0.7 | Median ms | $ per 100 paragraphs |
|---|---|---|---|---|---|---|---|---|
| A (no tool) | eval arm | - | - | - | - | 0.000 (pooled 0.000) | 0 (eval run) | $0 |
| B (countable rules only) | eval arm | - | - | - | - | 0.000 (pooled 0.286) | 0 (eval run) | $0 |
| C (countable rules plus judgment) | eval arm | jev-1.13.0 | - | - | - | 0.787 (pooled 0.848) | 182 (eval run) | $0.0129 |
| Claude Haiku 4.5 | fast | claude-haiku-4-5-20251001 | 0.825 | 0.875 | one repeat | 0.825 | 1971 | $0.4280 |
| Claude Sonnet 5 | mid | claude-sonnet-5 | 0.900 | 0.929 | one repeat | 0.850 | 6083 | $1.3351 |
| Claude Opus 5 | deep | claude-opus-5 | 0.963 | 0.973 | one repeat | 0.900 | 6532 | $3.0774 |
| gpt-5.6-sol | mid | gpt-5.6-sol | 0.912 | 0.938 | one repeat | 0.912 | 4428 | $1.6386 |
| Jev, the judgment arm | judgment | jev-1.13.0 | 0.738 | 0.813 | one repeat | 0.738 | 198 | unknown |

The judgment columns cover the rules a model actually decided. The pooled column adds the countable rules, which are regular expressions every row gets right for free and which the seeder guaranteed, so it puts the same floor under every row and reads higher than anything the model did. Read the judgment column; the pooled one is there to be checked against, not quoted.

Each model was asked for a boolean and a probability. The first recall column is the boolean, which is the decision the model made. The last applies this tool's own operating point of 0.7 to the probability it wrote, which a general model was never asked to calibrate, so read that column as a comparison of one number against another tool's line and no more than that.

The eval arms are joined from a separate run. Their latency was measured there, one pass and in order, so it is marked and is not comparable with the interleaved rows above it.

`unknown` in a cost column means the provider published no price for that model on the run date. It is not zero, and it is not an estimate.

## False alarms, every way they were counted

A false-alarm rate is only as strong as its denominator, so all of them are printed and the headline is the strictest. A clean paragraph counts once however many rules fired on it. A cell is one rule against one paragraph, which is the flattering denominator because most cells cannot fire. A fireable cell leaves out the rules this arm never answered and the rules the clean set was pre-filtered to pass.

| Model | Clean paragraphs flagged | Per clean cell | Per fireable clean cell | Per negative cell | Off-rule flags |
|---|---|---|---|---|---|
| Claude Haiku 4.5 | 37 of 54 (0.685) | 52 of 810 (0.064) | 52 of 540 (0.096) | 0.061 | 92 (0.0587 on seeded cells) |
| Claude Sonnet 5 | 2 of 54 (0.037) | 2 of 810 (0.003) | 2 of 540 (0.004) | 0.003 | 6 (0.0038 on seeded cells) |
| Claude Opus 5 | 0 of 54 (0.000) | 0 of 810 (0.000) | 0 of 540 (0.000) | 0.000 | 1 (0.0006 on seeded cells) |
| gpt-5.6-sol | 0 of 54 (0.000) | 0 of 810 (0.000) | 0 of 540 (0.000) | 0.001 | 3 (0.0019 on seeded cells) |
| Jev, the judgment arm | 2 of 54 (0.037) | 2 of 810 (0.003) | 2 of 540 (0.004) | 0.003 | 4 (0.0026 on seeded cells) |

## Per rule

### dash_present

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.000 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 0 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 1.000 | 0.000 | 0 |

### colon_heavy

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.000 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 0 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 1.000 | 0.000 | 0 |

### sentence_rhythm

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.000 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 0 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 1.000 | 0.000 | 0 |

### slop_vocab

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.000 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 0 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 1.000 | 0.000 | 0 |

### banned_words

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 0 | n/a | 0.000 | 0 |
| Claude Sonnet 5 | 0 | n/a | 0.000 | 0 |
| Claude Opus 5 | 0 | n/a | 0.000 | 0 |
| gpt-5.6-sol | 0 | n/a | 0.000 | 0 |
| Jev, the judgment arm | 0 | n/a | 0.000 | 0 |

### not_x_but_y

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 0.625 | 0.352 | 0 |
| Claude Sonnet 5 | 8 | 0.500 | 0.018 | 0 |
| Claude Opus 5 | 8 | 0.750 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 0.375 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.375 | 0.037 | 20 |

### tricolon

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.481 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.018 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.875 | 0.000 | 14 |

### stacked_hedging

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.000 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.500 | 0.000 | 0 |

### rhetorical_opener

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.018 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 1.000 | 0.000 | 0 |

### restating_closer

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.000 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.875 | 0.000 | 0 |

### self_undercutting

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 0.750 | 0.037 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.875 | 0.000 | 10 |

### first_x_that

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 0.500 | 0.000 | 0 |
| Claude Sonnet 5 | 8 | 0.750 | 0.000 | 0 |
| Claude Opus 5 | 8 | 0.875 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 0.875 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.625 | 0.000 | 1 |

### naked_cost_figure

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 0.625 | 0.037 | 0 |
| Claude Sonnet 5 | 8 | 0.875 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.500 | 0.000 | 6 |

### jobs_claim

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 0.750 | 0.000 | 0 |
| Claude Sonnet 5 | 8 | 0.875 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 1.000 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.875 | 0.000 | 0 |

### pullquote_fragment

| Model | n seeded | Recall @0.7 | FP rate on clean | Unanswered, this rule |
|---|---|---|---|---|
| Claude Haiku 4.5 | 8 | 1.000 | 0.037 | 0 |
| Claude Sonnet 5 | 8 | 1.000 | 0.000 | 0 |
| Claude Opus 5 | 8 | 1.000 | 0.000 | 5 |
| gpt-5.6-sol | 8 | 0.875 | 0.000 | 0 |
| Jev, the judgment arm | 8 | 0.875 | 0.000 | 1 |

## The run

830 calls, 2 failed, 2 retried. Priced rows cost $10.7554 in total; jev had no published price and are not in that figure.

| Model | Slug served | JSON mode | Calls | Failed | Parse failures | Truncated | p95 ms |
|---|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | claude-haiku-4-5-20251001 | no | 166 | 0 | 0 | 0 | 2763 |
| Claude Sonnet 5 | claude-sonnet-5 | no | 166 | 0 | 0 | 0 | 10957 |
| Claude Opus 5 | claude-opus-5 | no | 166 | 2 | 2 | 0 | 9289 |
| gpt-5.6-sol | gpt-5.6-sol | yes | 166 | 0 | 0 | 0 | 6047 |
| Jev, the judgment arm | jev-1.13.0 | no | 166 | 0 | 0 | 0 | 331 |

A truncated reply stopped at its completion budget before it was a whole JSON object. It counts as unanswered exactly as a malformed reply does, and it is listed apart from one because it says something about the budget rather than about the model.

What each row was sent:

| Model | Completion budget | Reasoning |
|---|---|---|
| Claude Haiku 4.5 | 2000 tokens | the provider's default, whatever that is for this model |
| Claude Sonnet 5 | 2000 tokens | the provider's default, whatever that is for this model |
| Claude Opus 5 | 2000 tokens | the provider's default, whatever that is for this model |
| gpt-5.6-sol | 4000 tokens | effort low |
| Jev, the judgment arm | 900 tokens | the provider's default, whatever that is for this model |

Failures, in full:

- `opus` C18 repeat 1: answered nothing usable for not_x_but_y, tricolon, stacked_hedging, rhetorical_opener, restating_closer, self_undercutting, first_x_that, naked_cost_figure, jobs_claim, pullquote_fragment
- `opus` N02 repeat 1: answered nothing usable for not_x_but_y, tricolon, stacked_hedging, rhetorical_opener, restating_closer, self_undercutting, first_x_that, naked_cost_figure, jobs_claim, pullquote_fragment
- `opus` N08 repeat 1: answered nothing usable for not_x_but_y, tricolon, stacked_hedging, rhetorical_opener, restating_closer, self_undercutting, first_x_that, naked_cost_figure, jobs_claim, pullquote_fragment
- `opus` N21 repeat 1: the reply is not JSON: {"not_x_but_y": false, "p": 0.15} Wait — I must output all rules. {"not_x_but_y": false, "tricolon": false, "stacked_... (JSON Parse error: Unable to parse JSON string)
- `opus` N30 repeat 1: the reply is not JSON: {"not_x_but_y": false, "p": 0.05, "tricolon": false, "p_tricolon": 0.03, "stacked_hedging": false, "restating_closer"... (JSON Parse error: Unable to parse JSON string)
- `jev` C03 repeat 1: answered nothing usable for naked_cost_figure
- `jev` C09 repeat 1: answered nothing usable for self_undercutting
- `jev` C11 repeat 1: answered nothing usable for tricolon
- `jev` C16 repeat 1: answered nothing usable for not_x_but_y
- `jev` N01 repeat 1: answered nothing usable for tricolon
- `jev` N04 repeat 1: answered nothing usable for not_x_but_y
- `jev` N05 repeat 1: answered nothing usable for tricolon
- `jev` N06 repeat 1: answered nothing usable for not_x_but_y
- `jev` N10 repeat 1: answered nothing usable for not_x_but_y
- `jev` N12 repeat 1: answered nothing usable for naked_cost_figure
- `jev` N14 repeat 1: answered nothing usable for not_x_but_y
- `jev` N15 repeat 1: answered nothing usable for self_undercutting
- `jev` N16 repeat 1: answered nothing usable for not_x_but_y
- `jev` N18 repeat 1: answered nothing usable for tricolon
- `jev` N24 repeat 1: answered nothing usable for not_x_but_y
- `jev` N25 repeat 1: answered nothing usable for naked_cost_figure
- `jev` S06 repeat 1: answered nothing usable for self_undercutting
- `jev` S10 repeat 1: answered nothing usable for not_x_but_y
- `jev` S19 repeat 1: answered nothing usable for tricolon
- `jev` S20 repeat 1: answered nothing usable for tricolon
- `jev` S21 repeat 1: answered nothing usable for not_x_but_y
- `jev` S26 repeat 1: answered nothing usable for not_x_but_y
- `jev` S31 repeat 1: answered nothing usable for naked_cost_figure
- `jev` S34 repeat 1: answered nothing usable for not_x_but_y
- `jev` S36 repeat 1: answered nothing usable for not_x_but_y
- `jev` S37 repeat 1: answered nothing usable for self_undercutting
- `jev` S39 repeat 1: answered nothing usable for naked_cost_figure
- `jev` S43 repeat 1: answered nothing usable for tricolon
- `jev` S50 repeat 1: answered nothing usable for self_undercutting
- `jev` S54 repeat 1: answered nothing usable for not_x_but_y
- `jev` S55 repeat 1: answered nothing usable for not_x_but_y, self_undercutting
- `jev` S58 repeat 1: answered nothing usable for not_x_but_y, self_undercutting
- `jev` S60 repeat 1: answered nothing usable for tricolon
- `jev` S64 repeat 1: answered nothing usable for not_x_but_y
- `jev` S67 repeat 1: answered nothing usable for self_undercutting
- `jev` S68 repeat 1: answered nothing usable for tricolon
- `jev` S71 repeat 1: answered nothing usable for not_x_but_y
- `jev` S73 repeat 1: answered nothing usable for self_undercutting
- `jev` S82 repeat 1: answered nothing usable for not_x_but_y
- `jev` S83 repeat 1: answered nothing usable for naked_cost_figure
- `jev` S86 repeat 1: answered nothing usable for tricolon, first_x_that
- `jev` S92 repeat 1: answered nothing usable for tricolon
- `jev` S97 repeat 1: answered nothing usable for not_x_but_y
- `jev` S98 repeat 1: answered nothing usable for tricolon
- `jev` S100 repeat 1: answered nothing usable for tricolon
- `jev` S105 repeat 1: answered nothing usable for not_x_but_y
- `jev` S106 repeat 1: answered nothing usable for self_undercutting, pullquote_fragment
- `jev` S110 repeat 1: answered nothing usable for tricolon

## Where these numbers come from

- Panel: `bench/panel-direct.yaml`; each model resolved against its provider's own model list on 2026-09-18.
- Prices: bench/prices/anthropic-2026-09-17.yaml: Anthropic published list prices, transcribed on 2026-09-17; re-verify against the published price list on the run date before quoting these figures., checked 2026-09-17
- Prices: bench/prices/openai-2026-09-17.yaml: OpenAI published list prices (developers.openai.com/api/docs/pricing), transcribed on 2026-09-17, checked 2026-09-17
- Eval arms joined from `bench/results/2026-09-17/scores.json`.
- The seeds are synthetic splices and mechanical edits, so every recall figure here is an upper bound on what the same rules would catch in defects that occurred naturally.
