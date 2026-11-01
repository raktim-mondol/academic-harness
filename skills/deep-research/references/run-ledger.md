# The deep research run ledger

First-party reference for the `deep_research` tool. Root:
`<workspace>/.dsh/deep-research/<run_id>/`. Everything is append-only or
write-once; nothing is edited in place.

## Files

| File | What it holds |
|---|---|
| `query.md` | the request, verbatim, written once and never rewritten |
| `manifest.json` | frozen brief, RQ ids, tier, gear, step plan, query hash, budget |
| `state.jsonl` | one row per step transition; latest row per step wins |
| `corpus.jsonl` | retrieved records with `src-` ids, `cluster_id`, `independent`, `suggested_by` |
| `claims.jsonl` | `cl-` claims with `rq_id`, supporting record ids, and `quote_status` |
| `findings.jsonl` | `f-` critic findings; rejected candidates are not stored |
| `verdicts.jsonl` | `v-` gate verdicts: `clear`, `flagged`, `blocked`, `not_checked` |
| `patches.jsonl` | `p-` patch passes with before/after hashes and escalation counts |
| `accounting.jsonl` | cumulative model calls, tokens, wall clock |
| `retrieval.jsonl` | `rt-` full-text attempts: which resolver served each copy, and the reason for every failure |
| `artifacts/*.md` | per-step output: `coverage-matrix`, `sweep`, `contradictions`, `loci`, `interim-loc-0001`, `comparisons`, `source-tensions`, `corpus-gaps`, `evidence-digest`, `drafts`, `final-report`, `cite-check`, `gap-fetch`, `readability-suggestions` |
| `papers.jsonl` | `pm-` links from a corpus record to the PaperMemory paper its full text was ingested into |
| `bodies/<src-id>.md` | fetched full text, present only with `fetch_full_text: true`; a disposable run cache, not the library of record |
| `exports/report.*` | `export` output; refuses to clobber without `overwrite` |

## Effort levels

`effort` is the scale knob: `low`, `medium`, `high`. Each sets tier, gear, the
model-call cap, the wall-clock cap, `fetch_full_text`, and the web lane. An
explicit argument beats the level; the level beats inference from the request;
and `manifest.execution` records which level was used, whether it was stated or
inferred (`effort_source`), the phrases that decided it (`effort_basis`), and any
explicit overrides — so a resumed run never re-guesses.

| Level | Pipeline | Calls | Full text | Web lane |
|---|---|---|---|---|
| `low` | light: decompose, sweep, draft, cite check, polish | 8 | no | no |
| `medium` | full | 45 | yes | yes |
| `high` | full at premier scale | 140 | yes | yes |

When the request points both ways ("quickly, but make it a comprehensive
systematic review"), `start` returns `status: needs_input` with an `ask_user`
question and creates nothing: no run directory, no model call. Answer it, then
pass `effort` or `confirm_effort: true`.

## Steps

| id | Step | Tier |
|---|---|---|
| `decompose` | 1 — atomic items, coverage axes, tier and register suggestion | all |
| `chapters` | 1.5 — 4–10 chapters | dissertation |
| `sweep` | 2 — perspectives, retrieval, independence clustering | all |
| `contradictions` | 3 — ranked disagreement pairs | full |
| `loci` | 4 — two analysts, merged and scored | full |
| `depth` | 5 — one interim note per locus | full |
| `reconcile` | 6 — cross-locus comparison | full |
| `tensions` | 7 — expert disagreements | full |
| `corpus_critic` | 8 — what would overturn this, plus a gap fetch | full |
| `digest` | 9 — load-bearing claims with verbatim quotes | full |
| `draft` | 10 — three angles (one in scout gear and light tier) | all |
| `synthesize` | 11 — the report; frozen against regeneration from here | full |
| `critics` | 12 — dialectic, depth, width, instruction | full |
| `gap_fetch` | 13 — targeted retrieval for open critic gaps | full |
| `patcher` | 14 — findings applied as capped hunks | full |
| `cite_check` | 14.5 — citation-to-sentence bindings, unknown ids, retractions | light, full |
| `polish` | 15 — hygiene as hunks only | light, full |
| `readability` | 16 — suggestions the orchestrator may decline | dissertation |

Light tier is `decompose → sweep → draft → cite_check → polish`. Cite check is in
the light path on purpose: a short run earns no exemption from verification.

## Ids

`dr-0001` run · `rq-0001` research question · `src-0001` corpus record ·
`loc-0001` locus · `cl-0001` claim · `f-0001` finding · `v-0001` verdict ·
`p-0001` patch · `c0001` independence cluster. Hashes are `sha256:<hex>`; the
query hash is re-checked on every step.

## Step states

`pending` · `running` · `done` · `failed` · `skipped` · `blocked`.

`blocked` is terminal until a human clears it: `run` and `resume` both refuse to
continue past it, and only an explicit `from_step` at or before that step resets
it. This is what stops a CRITICAL gate from being bypassed by trying again.

## Finding shape

A finding is stored only with all of `severity` (`High|Medium|Low`), `reason`
(what was inspected), `target` (smallest repairable owner), `primary_check`
(exactly one of angle, coverage, citation, taxonomy, calibration, weaving), and
`verifier` (how closure is confirmed). Rejected candidates:
`unobserved_evidence`, `missing:<fields>`, `missing_inspection`,
`duplicate_target_check`. A rejected candidate is not a defect — it is evidence
the run did not have.

## Gate ids

`query_is_gospel` · `report_present` · `lane_coverage` · `research_questions_answered` ·
`quote_integrity` · `retracted_citations` · `independence_recorded` ·
`critical_findings_applied` · `patch_only` · `numeric_consistency` ·
`locus_coverage` · `hygiene`.

Only `blocked` stops delivery. `not_checked` means the check had nothing to read
— no fetched body, no retraction verifier, no numeric helper — and is disclosed
in the same breath as a pass, so a PASS never claims more than was verified.

## Errors

`query_drift`, `budget_exceeded`, `no_open_access_copy`, `pdf_conversion_failed`,
`open_access_copy_too_thin`, `not_checked`, `unknown`, `context_not_found`,
`context_ambiguous`, `hunk_escalated`, `patch_budget`,
`regeneration refused` (a patched artifact cannot be rewritten).

## Boundaries

The tool retrieves, counts, patches, gates, and records. It does not decide what
the answer is, does not estimate an effect, does not certify a manuscript as
correct, and never submits anything. A pass on the ship gate means the recorded
evidence supports the recorded claims as checked; it is not a guarantee of facts.
