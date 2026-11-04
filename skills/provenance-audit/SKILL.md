---
name: provenance-audit
description: Trace where a claim came from across the whole workspace with the read-only `provenance_audit` tool — join review evidence, extraction, appraisal and GRADE events, reporting_check verdicts, deep_review claims, citation verdicts and validity flags, notebook hypotheses, analysis expectations/re-executions/compliance, experiment protocol digests and verdicts, ablation attribution, dataset downloads, meta-analysis studies, and Academic Harness claim sidecars by the ids and hashes they already store. Use the report-only `rollup` action for the ordered loop record across a coscientist cycle. Use before reporting a result, submitting a manuscript, editing a source that claims depend on, or answering "what supports this?"
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Provenance audit

> **In Academic Harness:** `provenance_audit` is **read-only**. It indexes the
> ledgers that already exist, writes only its own cache under
> `.dsh/provenance/<audit>/`, and never decides whether a claim is true. The
> model proposes, the tool verifies what is recorded, the human decides.

## What the states mean

Every indexed claim is in exactly one state, and each state is a statement about
the **record**, not about the science:

| State | What was recorded | What to do |
|---|---|---|
| `supported` | An explicit stored link plus a verification or a recorded human judgement | Report it, with the link |
| `no_link` | No evidence was linked at all | Add the quote, the paper, or the binding |
| `not_checked` | Evidence exists but was never verified | Run the quote check or ask the author |
| `unverified` | A verification was attempted and did not confirm it | Re-quote, re-resolve the paper, or downgrade the claim |
| `stale` | The source behind the evidence changed | Re-verify before repeating the claim |
| `not_found` | A recorded link has no far end (a missing record, run, entry, or file) | Fix the link or record the target |
| `spec_drift` | An experiment run changed its evaluation protocol against its baseline | Compare against a matching baseline or disclose the change |
| `rerun_mismatch` | A declared reported value did not reproduce in a re-execution | Inspect the metric, the tolerance, and the environment; do not restate the number as reproduced |
| `no_attribution` | An ablation reading or human verdict attributes no component to the gain | Report the gain as unattributed, or plan a removal arm |
| `verdict_missing` | A staged variant run or an ablation has no human verdict | Record the verdict before treating the run as selected |
| `unknown` | The ledger itself could not be read | Say it is unknown — never call it unsupported |

Support is never inferred from co-occurrence, citation proximity, or a model
judgement. A `deep_review` engine verdict, for instance, is recorded as
`unverified` precisely because it is a reading, not a verification.

## Workflow

1. **Index the workspace.**

   ```text
   provenance_audit action=index audit=paper
   ```

   Default selection indexes every review, reporting check, stored deep review,
   notebook, analysis plan, experiment, ablation, dataset, meta-analysis, and
   (when the workspace has `ah.yaml`) Academic Harness claim sidecar. Narrow it
   with `review`, `reporting`, `meta`, `analysis`, `experiment`, `ablation`,
   `dataset`, `deep_review`, and `manuscript`; exclude AH sidecars with
   `include_ah: false`. Add `verify_quotes: true` only when PaperMemory is
   available — otherwise the stored quote-check statuses are used, unchanged.

2. **Read coverage first.**

   ```text
   provenance_audit action=coverage audit=paper
   ```

   This lists per-ledger state counts and, crucially, which sources were
   `present`, `unknown`, `not_queried`, or `skipped`. An `unknown` source means
   the audit saw nothing to join: report it as a gap in knowledge.

3. **Ask what is unsupported.**

   ```text
   provenance_audit action=unsupported audit=paper
   provenance_audit action=unsupported audit=paper state=stale
   ```

   `unsupported` lists only claims (evidence, extractions, appraisals, GRADE
   domain ratings, checklist items, hypotheses, manuscript clauses, analysis
   expectations, compliance readings, experiment verdicts, ablation
   attribution), split by the nine unsupported states. Fix `no_link` and
   `not_checked` by recording the missing link, not by rephrasing the claim.

4. **Check staleness after any source changed.**

   ```text
   provenance_audit action=stale audit=paper
   ```

   Stale entries carry the recorded and the current hash. A changed manuscript
   marks the checklist quotes that depend on it, and anything that depends on
   them, as stale. Re-verify, then re-index; do not hand-edit a ledger to clear
   a state.

5. **Check impact before you edit or re-run.**

   ```text
   provenance_audit action=impact audit=paper target=paper:10.1000/trial1
   provenance_audit action=impact audit=paper target=results.csv
   ```

   Targets accept a node id, a paper key, a workspace path, or a run id, and the
   report is the transitive set of ledger records that reference it — which
   review records, extractions, hypotheses, runs, and pooled studies would need
   revisiting.

6. **Read the readiness roll-up.**

   ```text
   provenance_audit action=arms audit=paper
   ```

   One table, four columns — reported vs recomputed, protocol digest,
   references, method–code — over the artifacts that already exist. A missing
   column is `n/a`, never a pass; `ready` means the recorded columns are
   verified, `partial` means something is unchecked, and `not_ready` means a
   recorded mismatch, drift, flag, or missing verdict. It re-indexes first and
   is a reading, not an acceptance decision.

7. **Roll the loop up.**

   ```text
   provenance_audit action=rollup audit=paper coscientist=cycle manuscript=paper.md
   ```

   One ordered record: frozen problem → limitations → idea pool → subset
   verdicts → scale-up → selection → ablation → review rounds with
   `evaluator_kind` → integrity columns → incumbent. It is a **report, not a
   store**: it reads the coscientist ledger directly, writes no promotion, and
   leaves the champion `selected`. Cost/time sums only what the ledgers
   recorded (`analysis_run` durations and `deep_review` round duration/tokens);
   everything else is listed as missing, never zero. The baseline-gate row says
   whether a reproduced baseline was itself checked by
   `analysis_run expect`/`verify_scores`; compute no headline gain and do not
   average over successful cases only.

8. **Attach the audit.**

   ```text
   provenance_audit action=export audit=paper format=markdown
   provenance_audit action=export audit=paper format=graphml
   ```

   `markdown` and `csv` are for people, `json` is the index itself, and
   `graphml`/`mermaid` are views of it — never a new database. Exports refuse to
   overwrite unless `overwrite: true`.

## Limits to state out loud

- The audit reads what the ledgers recorded. A quote verified last month and
  silently re-ingested into PaperMemory is only `stale` if a hash was recorded.
- `scientific_result` cards are not persisted, and the `preregister` ledger
  (Phase 5A) is not indexed yet; both are reported `unknown` with that reason.
- The audit does not execute anything. `rerun_mismatch` reads an
  `analysis_run` verification that already happened, and `arms` is a roll-up,
  not a re-run or an acceptance decision.
- `rollup` does not promote an incumbent and does not compute a headline gain;
  a missing duration or token tally is `not recorded`, never zero, and the
  report shows its denominators instead of averaging over successful cases
  only.
- Academic Harness unit provenance (who wrote each unit) belongs to
  `ah_provenance`; the audit indexes cited-clause bindings, not authorship.
- A clean audit is not a correct paper. It says which claims have recorded
  support, and it says nothing about whether the support establishes the claim.
