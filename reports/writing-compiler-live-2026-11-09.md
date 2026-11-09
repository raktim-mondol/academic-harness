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

## Follow-up: the three "not fixed" items (same day)

| Item | What was done | Evidence |
|---|---|---|
| Agent edited meaning to clear info `NUM-001` | A post-edit note now says when an edit made a number disappear and what to do instead; the prompt and `ah-fix-findings` say never to reword a number away | 4 engine tests (mutation-checked). **Re-run live:** same request on a fresh copy; the agent fixed 3 findings (`ACR-01`, `FMT-11`, `STY-01`), tried to replace the list markers `(3)` and `(4)` with words, got the note (`numbers_removed ['3','4']` in the hook log), put them back, kept `100%` and `Category 2.5`, and listed the 7 `NUM-001` hits for the author with the reason. One model, one run |
| Rubric precision | Criteria reworded; new optional `quote_pattern` (a "yes" must quote words of the kind the criterion names); `RUB-GENERAL` and `RUB-SUPERLATIVE` at version 3 | 73 paragraphs hand-labelled by me before seeing the new verdicts (one paper, one labeller). `RUB-SUPERLATIVE`: kappa 0.88, precision 1.0, recall 0.8 (5 defects). `RUB-GENERAL`: kappa 0.41, precision 0.33, recall 0.67 (3 defects). **Not admitted**: both samples have fewer than the 5 defects admission needs for `RUB-GENERAL`; `RUB-SUPERLATIVE` meets the thresholds on a sample this small, which is not enough to trust, and admission is the author's call (`ah rubric admit --yes`) |
| Agent did its own read instead of `deep_review` | Prompt and `deep-review` skill: call the tool, one section is supported (80 s, 5 calls), say so and ask if you think it is wrong | Text tests. **Re-run live:** "do a free-form deep review of the abstract only" gave a direct `deep_review` call (no stand-in reading); 16 comments, about 2 minutes, 8 model calls; the agent also noticed the report's own severity table contradicted its comment list. One model, one run |

On the `RUB-GENERAL` labels: on reading the model's flags I think three of my "no" labels were too strict (`every dump location`, `regardless of whether performed by human or machine`, `no prior work`), so the measured precision understates the criterion. I have not recomputed it: relabelling after seeing the verdicts would flatter the result, and the criterion still needs a larger, independently labelled sample before anyone admits it.

One side effect seen in the live re-run: the number-removal note also fires when a list marker like `(3)` is replaced, because `NUM-001` already counts such markers as numbers. The agent handled it correctly, but a marker is not a claim; excluding enumerators is a candidate refinement.

## Round 2: the "not run" list (same day)

One tester, one model (`deepseek-flash`), copies of the same two manuscripts plus planted errors. Real SciPy and Pillow, real Crossref/OpenAlex; the outage was simulated with a network-less namespace (`unshare -rn`).

| Scenario | Result |
|---|---|
| Planted `t(28) = 2.1, p = 0.9` | `STAT-01`. The same test with `p = 0.045`, and prose that mentions "t-SNE" and "the p parameter", gave nothing |
| Planted `M = 3.47, N = 10` | `STAT-02`, only when written as `M =` or `mean =` (a sentence such as "Mean agreement was 3.47" is not parsed; the audit does not say so, a limit worth knowing) |
| 72-DPI image, an exact copy of another figure | `FIG-01`, `FIG-02`; both are only checked if the manuscript includes them |
| Fix the p-value, do not rerun | `EXT-00` (major); `STAT-01` carried, not marked fixed. After the rerun it is fixed and `EXT-00` is gone |
| Truncated result file; required tool never run; SciPy hidden | `EXT-00` "unreadable"; `EXT-00` "has not been run"; the run reports the error and leaves the previous result file untouched |
| Lookup snapshot: online, warm, offline | 31 findings each time, byte-identical; the warm run took 1 s against 5.6 s cold |
| Offline, a reference never seen | `CIT-06` unverified, not a finding about the DOI. Back online it resolved to four `CIT-04` mismatches with cause `evidence-changed`, nothing `UNEXPLAINED` |
| One entry aged 40 days; two audits at once; `{not json`; a version-99 file | Only the aged entry was fetched again; the file stayed valid; the corrupt file was rebuilt; the version-99 file was left alone. No `mailto` or key in the file |
| Format rules on the two real drafts | Every finding that fired on the small paper was right (`ACR-01` 2/2, `ACR-02` 5/5, `FMT-07` 2/2, `FMT-09` 1/1, `FMT-11` 3/3). Seven rules never fired; an independent count of the text showed nothing for them to find (no "percent" words, one citation style, every `e.g.` with its comma, no repeated words) |
| **Fix loop** | Four planted findings (two blockers, a duplicate label, `EVD-04`). One instruction, one turn, 36 tool calls. Three were cleared, `EVD-04` was recorded as a decision request, and the stop gate saw 0 blocking. Final state: 1 `decision-needed`, 0 unexplained, `ah done` FAIL for that reason, the agent said so and named what it needs (source texts for ten citations) |

What the fix loop also showed: the agent **deleted** the three planted paragraphs (a figure reference to a figure that does not exist, a citation to a key that does not exist, two placeholder figures) instead of asking. It said so and gave the reason, but removing text to clear a blocker is a choice a person may want to make. It also tried to read the ledger with `sqlite3`; the protected-path guard blocked it, as intended.

Fixed in round 2: `numbers_audit` read `$P = 12$` and `p = 8` as p-values out of range (F9); `ACR-03` ignored `CDR = cancer detection rate` (F4); `PRF-01` rejected `Methodology` (F3); the number-removal note fired on list markers (listed above as a side effect); `ah rubric sheet` now samples through the document, shows whole paragraphs and no model verdicts.

Still open: a larger sample labelled by someone other than the tester before any rubric criterion is admitted (blind sheets are in `~/rubric-labelling/`); `PRF-01` and other profile rules remain stricter than some venues; F10/F13 (the agent proposing a rule at the wrong level, misreporting a level) are model behaviour and untouched; a stronger or different model is untested; nothing was run on the original manuscripts.

## Round 3: end to end in the web UI, on the merged main (same day)

Main at the merge of round 2, packed and installed into the isolated host, driven in a browser (agent-browser) with `deepseek-flash`. The session was created through the host's RPC with the first prompt sent there (the file dialog for "Add workspace" cannot be driven); the second prompt was typed into the UI textbox. Fresh copy of the small paper with a missing `\ref`, a wrong p-value, a list sentence `(1) (2) (3)` and a caption-defined `CDR`.

| Step | Observed |
|---|---|
| Turn 1: run the external checks, fix what blocks | Ran `ah_external` then `ah_audit` (34 new findings: 31 `CIT-06`, 2 `FIG-01`, 1 `STAT-01`). `$P = 12$` in the methodology was **not** flagged (F9 fix). `CDR` was **not** reported as undefined (F4 fix). The agent edited no prose and recorded two decision requests (the missing figure, ten sources) rather than guess |
| Turn 2 (typed in the UI): delete the paragraph, correct p to the recomputed 0.045, reword the aims sentence, make `ah_done` tell the truth | All three edits right. The hook log shows `numbers_removed: []` for the `(1) (2) (3)` rewording (list-marker fix), `baseline_kept` twice (the stop-gate fix holds), and the gate settling with 0 blocking. The agent reran the stale `ah_external` unprompted. Independent check afterwards: `TEX-02` cleared, `STAT-01` gone, `EVD-04` still `decision-needed`, 0 unexplained, `external` current, `ah_done` FAIL for that one reason, as the agent said |

One misstatement by the agent: it said I had "answered the TEX-02 decision"; I had given an instruction to delete the paragraph, which is close, but it described a decision that had not been recorded. Not a finding about the checks.

Not covered by this round: approval prompts (no `ah_author` action was requested), `deep_review` in the UI, the rubric (still no admitted criterion), and a model other than `deepseek-flash`.
