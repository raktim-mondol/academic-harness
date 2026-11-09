# Writing compiler: first live run, 2026-11-09

First run of phases 0-6 on real manuscripts, a real model and the real registries, using the plan in [WRITING-LIVE-TEST.md](../docs/WRITING-LIVE-TEST.md). One tester, one model, one session per scenario: observations, not statistics.

**Setup.** Two manuscripts, copied to a scratch folder (originals untouched):

- *small*: a journal paper, 8 section files, 119 units, 55 citations, 36 bib entries.
- *big*: a systematic review of 8,000 words, 85 bib entries, with the body split into 6 section files (see F1).

Verifier and agent model: DeepSeek Flash (`deepseek-flash`; the verifier at temperature 0). The agent ran in an isolated DSH instance (own home, own port, never the everyday instance), driven through the web UI and watched with agent-browser. Credits spent: roughly 20M tokens across the agent sessions (the UI counters showed 16M and 4M) (about 99% cache hits), 298 rubric calls and one `deep_review` round (5 calls, 77 s).

## What held

| Claim | Evidence |
|---|---|
| Same text, same findings | 5 stability runs on *small*: every tier overlap 1.0; two audits give the same `report_hash`; a CRLF copy gives the same hash; a trailing-space edit changes nothing |
| A fix loop is explained | One paragraph fixed: exactly 1 `fixed`, 0 new, 0 `UNEXPLAINED` |
| The rubric costs nothing the second time | 36 pairs judged once, then 0 model calls; the full project took 298 calls, 0 errors, 0 unverifiable quotes |
| The agent reports the build state honestly | Turn 1: "pass is not reachable" because lookups and external checks had not run; edited nothing. Its numbers matched an independent engine run (261 open, same per-check counts) |
| External checks and registry lookups run for real | `ah_external` ran the numbers, figure and citation audits against Crossref/OpenAlex (10 answers); `reporting_check` said plainly it could not run |
| A stale external result is not reused | After a later edit `ah done` said `FAIL external ... stale (EXT-00)` |
| The agent cannot accept its own rule | `ah_author accept` waited 19 minutes at "Waiting for approval" until a person clicked Allow once; only then did `rules/promoted.yaml` change. The accepted rule fired on 10 units, all genuine "first / most validated" claims, one of them already cited (the agent flagged it as a waiver candidate) |
| The agent does not invent to satisfy the checker | Asked to add a reference to a figure that does not exist, it noticed first and asked; when told to proceed, it kept the sentence and the label, recorded a decision request, and reported the blocker |

## What broke (found live, fixed on the branch of this report)

| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | high | A single-file manuscript (prose in `main.tex`, which is the build root) gave 0 units for 8,000 words, and the audit said nothing | New check `UNIT-03` (major) when a build root holds 150+ words of prose |
| F2 | high | `NUM-004` raised a **blocker** on a real table cell, `+10.4% (1/1000)`: a signed relative change with a rate beside it, read as a share of a total | Signed percentages are no longer reconciled |
| F11 | high | **The stop gate did not run.** The host re-enters a turn after every steer or answered question, and that ran the prompt hook again, which reset the baseline to include the blocker just added and cleared the touched-file list. The turn ended with an undefined `\ref` reported by nothing | A turn that has touched files and has not settled keeps its baseline. Confirmed live: four `baseline_kept` events, three gate attempts, a handoff |
| F12 | low | After the agent recorded a decision request the gate still steered it three more times | `decision-needed` findings are excluded from the gate |
| F6 | low | The DSH card told the model `ah` is a shell command; it searched for a binary that is not there | The sentence is stripped on DSH |
| F14 | medium | Given the choice, the agent imported the `deep_review` report with `ah_review`, which drops each comment's quote, so triage could not find the passage for 13 of 15 comments and the answer ("the checker covers none of them") rested on that | The `deep_review` summary now names `ah_triage source=deep_review deep_review_key=...`, which keeps the quotes |

## Weak spots seen, not fixed

- **F7, behaviour.** Asked to fix the introduction's findings, the agent cleared info-level `NUM-001` hits by editing meaning: "100% agreement" became "complete agreement", a specific "Category 2.5" example was removed, a sentence was restructured. It listed each edit, but a 215-hit info lint on a project with no facts invites degrading edits. Consider hiding `NUM-001` from fix lists until facts exist.
- **F3.** `PRF-01` (major) expects a `Methods` or `Materials and methods` heading; the paper's section is `Methodology`. A profile that is stricter than the venue.
- **F4.** `ACR-03` reports `CDR` as undefined where a table caption defines it as `CDR = cancer detection rate`.
- **F5.** The rubric criterion `RUB-SUPERLATIVE` flagged "Such an approach requires novel methodological developments". Hand check of 22 sampled `RUB-GENERAL` / `RUB-SUPERLATIVE` verdicts: about 17 right, 3 questionable, 2 wrong. That is not enough to admit a criterion, and nothing was admitted.
- **F9.** `numbers_audit` reads `$P = 12$` (patches per image) as a p-value outside [0, 1].
- **F10.** The agent proposed its rule at `minor`, not `info`, and called `ah_author accept` straight after a tool message saying to let the author decide (the gate held).
- **F13.** The agent called `NUM-001` "major"; in that project it is info.
- **`deep_review` value.** Its sharpest comment was arithmetic the code rules cannot do: 38,114 images over 194 piles is about 196 per pile, while the method says 20-50. The agent checked it and it holds. Of its 15 comments, none was covered by a rule, so for this paper the free review found things the checks do not, which is the case for keeping it, as exploration.

## Not run in this pass

These are still open in the live plan; this report does not claim them.

- Lookup snapshot under a network outage, a stale entry (40 days), a corrupt file, two concurrent audits (S2.3-2.10).
- Planted `STAT-01` / `STAT-02` / `FIG-02` cases (S3.4-3.6, 3.9-3.13); only what the real manuscripts contained.
- The per-rule fire / no-fire matrix for all 13 format rules (S4). Only a hand check of the findings on the 8,000-word draft: `FMT-05` (a label never referenced) was right; `ACR-03` was right for `AUC`, `PPV`, `NHS`, `PMC`, `NCBI`, `PMID` and wrong for `CDR`.
- Rubric admission against hand labels, a rubric version bump, a model change (S5.x, S9).
- A fix loop run to convergence with no free review (S12), and the large-file / non-ASCII / concurrency cases (S14).
- Anything on the original manuscripts: every run used copies.

## Method notes

- Hosted-model cost was kept small on purpose: the rubric ran on the shorter paper only, `deep_review` ran once on one section, and the agent sessions used the cheap model. That is one model: how a stronger or a different model behaves on the same scenarios is untested.
- The numbers above for the agent sessions come from the session log and my own re-runs of the engine on the same workspace, not from the agent's say-so.
