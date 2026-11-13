# Jev (TypeSafe System One) as a rubric judge: evaluation and decision

Date: 2026-11-10. Model: `jev-1.14.0` (pinned). Compared with Claude Sonnet 5.5 through the engine's own `judge()` and prompt (`ah.verifier.claude`).
The decision rules were written before any result was read (`~/.cache/ah-jev-eval/PREREG.md`, summarised below).

## What was tested

The six shipped criteria (RUB-GENERAL, -SUPERLATIVE, -CAUSAL, -METHOD-VAGUE, -RESULTS-INTERPRET, -PROMISE), each asked as a Noul (yes/no probability).

| Set | Content | Truth |
|---|---|---|
| S | 120 synthetic paragraphs: for each criterion 8 defects, 8 repaired twins, 4 hard negatives named in the criterion's own exclusions | by construction |
| R | 148 real (criterion, paragraph) pairs from copies of the maintainer's manuscripts, 2/3 chosen by lexical hits, 1/3 at random | blind labels by the assistant before any judge output on R was read: 11 yes, 129 no, 8 skipped as ambiguous |
| Pool | all 1,031 real paragraphs x 6 criteria (4,296 in-scope pairs), Jev only | the 35 pairs Jev would report (p >= 0.8) were labelled blind; 27 of the 29 not already in R were labelled, 2 skipped |

Jev variants: J1 criterion text as given to Claude; J2 candidate sentences chosen by code, max over sentences; J3 a shorter question with true/false descriptions; J4 all six questions in one request; J5 J1 on reader text instead of LaTeX source. Jev verdict: yes if p >= 0.8, no if p <= 0.2, else unclear (the engine treats unclear as unresolved).

## Results

**Separation (AUROC of the score, no thresholds).** Synthetic: J1 0.999, J3 0.998, J4 0.998, J2 0.993. Real: J1 0.966, J3 0.993, J4 0.966, J5 0.968, J2 0.958. Every criterion scores 1.000 on synthetic. The wording variants made no practical difference.

**Verdicts at 0.8 / 0.2 (J1).**

| Set | yes right | yes wrong | missed (unclear) | confidently wrong "no" | unclear overall |
|---|---|---|---|---|---|
| S (48 defects, 72 clean) | 48 | 2 | 0 | 0 | 15% |
| R (11 defects, 129 clean) | 7 | 1 | 4 | 0 | 29% |

Jev never said a confident "no" on a true defect (0 of 59). Its failures were "unclear" (engine: unresolved) or over-flagging.

**What Jev would actually report across the whole pool (p >= 0.8, 35 labelled pairs).**

| Criterion | flagged | real defects | precision |
|---|---|---|---|
| RUB-RESULTS-INTERPRET | 20 | 18 | 0.90 |
| RUB-SUPERLATIVE | 5 | 1 | 0.20 |
| RUB-GENERAL | 10 | 1 | 0.10 |
| all | 35 | 20 | 0.57 |

The RUB-GENERAL false positives were universal words in mathematics ("any grid", "every stationary operator"), scoped statements ("all nine documents") and definitions. The synthetic hard negatives of the same kind scored 0.35-0.56. The RUB-SUPERLATIVE false positives were "first/most" backed by a citation or used about another work. Claude answered "no" on all 15 of Jev's false positives (its own single false positive on R was a different paragraph, where Jev scored 0.49).

**Claude Sonnet 5.5, same pairs.** S: 120 of 120 correct, 0 unclear. R: all 11 defects found, 1 false positive, 0 unclear. On the 27 labelled pool pairs: right on 26, one "unclear". Median 4.5 s per call, about 1,190 input tokens. Caveat: the R/pool labels were made by Claude (blind), so this agreement flatters Claude.

**Operation.** 1,756 Jev requests across all variants, 0 failures; for the 804 J1 requests the median was 220 ms and p95 312 ms, about 436 input tokens each. Six questions in one request moved no score by more than 0.07 and flipped 2 verdicts of 268. Repeating the same request three times: scores agree within 0.01 on 108 of 268 pairs (maximum spread 0.10); the verdict changed between runs for 4 pairs.

## Pre-registered bars

| Bar | Result | |
|---|---|---|
| B1 AUROC >= 0.90 S, >= 0.85 R | S 0.999; R 0.964 (the one criterion with >= 5 positives: RESULTS-INTERPRET), 0.966 pooled | pass |
| B2 precision >= 0.80, kappa >= 0.6, unclear <= 25% (on R) | sampled precision 0.875 (7 of 8), kappa 0.928 on determinate verdicts, **unclear 29.3%**; precision over everything Jev would report **0.57** | **fail** |
| B3 repeatability: 3 runs within 0.01 on >= 99% of pairs | **40%** (verdict changes for 4 of 268) | **fail** as written |
| B4 kappa within 0.10 of Sonnet | Jev 0.928 vs Claude 0.953; but counting "unclear" as wrong, accuracy is 0.70 vs 0.99 | pass as written, misleading |
| B5 median latency <= 2 s, failures <= 1% | 220 ms, 0 failures | pass |

## Decision

**Do not integrate Jev as a standalone rubric backend now.** B2 and B3 failed, and the per-criterion view is clear:

- RUB-GENERAL and RUB-SUPERLATIVE: Jev over-flags (precision 0.10 and 0.20), so it must not be the judge for them.
- Fixed 0.8/0.2 verdicts leave 29% of real pairs unresolved, which would keep admitted criteria INCOMPLETE too often.
- RUB-RESULTS-INTERPRET is the one criterion where Jev alone looks usable (precision 0.90, AUROC 0.96), on a small sample.
- RUB-CAUSAL, -METHOD-VAGUE and -PROMISE: Jev flagged nothing at p >= 0.8 on real text, and I found no real defect for CAUSAL or METHOD-VAGUE and one for PROMISE (which Jev scored unclear). Real-text recall for these three is unmeasured; they are only tested on synthetic cases, where Jev separates them perfectly.

**What the data does support, to be validated before building:** an opt-in cascade where Jev screens every pair and only pairs with p > 0.2 go to a reasoning model such as Claude. In these data that skips 43% of synthetic and 65% of labelled real pairs (78% of the 4,296 in-scope pool pairs) and loses none of the 59 defects (lowest defect score 0.40 on real text). The cost is one 220 ms call per pair instead of one 4.5 s call. This is one labeller on one author's manuscripts, so it needs fresh labels, ideally by a person, before any claim of "no missed defects".

## Limits of this evaluation

- Labels for R and the pool are the assistant's, not independent human labels, and Claude is judged against labels from its own family. Nothing here is an admission and none of it measures accuracy against people.
- Real defects are rare in these polished manuscripts (11 of 148 sampled pairs). Precision on the flagged set is the strongest real-text number; recall on real text is not measured.
- The unclear-band sweep (`no <= 0.5`, `yes >= 0.8` cuts unclear to 10% at the same precision and recall on R) was run after seeing the results and used the same data, so it is not evidence.
- 6 criteria, one author's writing, LaTeX source as input. Manuscript text was sent to TypeSafe's API for this test; no real paragraph appears in this report.

## Reproduction

Scripts and raw responses are in `~/.cache/ah-jev-eval/` (probabilities and timings only; the key is read in-process and never stored): `synthetic.py`, `extract_real.py`, `sample_real.py`, `run_jev.py`, `run_claude.py`, `scan_pool.py`, `nominate.py`, `analyze.py`, `analyze2.py`, `final.py`.
