---
name: experiment-tracking
description: Use when tracking sweeps, simulations, pilots, or model comparisons with the experiment ledger and scoped rankings.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.2"
  skill-author: Academic Harness
---

# Experiment Tracking

> **In Academic Harness:** `experiment_log` keeps state under
> `.dsh/experiments/<slug>/` — a write-once definition plus append-only runs
> and links. The tool records logged values; it makes no scientific claim.

Use `experiment_log` for exploratory batches (sweeps, simulations, pilots).
Use `analysis_run` when there is one pre-registered question with a frozen
plan — the two complement each other; link an experiment run to the analysis
run that confirms it.

## Workflow

1. **Start with metric directions.**

   ```text
   experiment_log action=start slug=lr-sweep question="Which learning rate wins?"
     experiment={"metrics":[{"name":"accuracy","direction":"higher"},{"name":"loss","direction":"lower"}]}
   ```

   The definition is write-once (`resume: true` to continue it). Directions
   declared here are what make `best` meaningful later.

   For a staged comparison, declare the benchmark and protocol with it:

   ```text
   experiment_log action=start slug=bench question="Does the mechanism beat the reference?"
     experiment={"metrics":[{"name":"accuracy","direction":"higher"},{"name":"latency","direction":"lower"}],
                 "benchmark":{"datasets":["D1","D2"],"splits":["val","test"],
                              "baseline_arm":"baseline","task_rules":["fixed split","no test leakage"]},
                 "protocol":{"eval_script":"eval.py","metric_params":{"threshold":0.5}}}
   ```

2. **Log every run as it finishes** — params, metrics, artifact paths (hashed,
   workspace-confined), seed, and `parent` for follow-ups. A rerun is a new
   run; nothing is deduplicated, because "same params, different result" is
   exactly the signal you want to keep. Omit missing metrics rather than
   zero-filling them.

   For a staged experiment, log the baseline first:

   ```text
   experiment_log action=log slug=bench role=baseline baseline_ref=reproduced stage=full
     comparison_identity={"dataset":{"id":"D1","version_or_hash":"v1"},"split":{"id":"test","version_or_hash":"v1"},"baseline_cohort_id":"reference-v1","metric_definitions":{"accuracy":{"unit":"fraction","implementation":"accuracy-v1","parameters":{}},"latency":{"unit":"ms","implementation":"timer-v1","parameters":{}}}}
     metrics={"accuracy":0.80,"latency":100}
   experiment_log action=log slug=bench role=variant baseline_ref=reproduced stage=full baseline_run_id=x0001
     comparison_identity={"dataset":{"id":"D1","version_or_hash":"v1"},"split":{"id":"test","version_or_hash":"v1"},"baseline_cohort_id":"reference-v1","metric_definitions":{"accuracy":{"unit":"fraction","implementation":"accuracy-v1","parameters":{}},"latency":{"unit":"ms","implementation":"timer-v1","parameters":{}}}}
     metrics={"accuracy":0.85,"latency":90}
   ```

   The baseline captures `protocol_digest`; every variant must name its explicit
   `baseline_run_id` with the same reference, stage, and sampling. A changed `eval_script` or `metric_params` is
   stored as `spec_drift` against that baseline. Never paper over drift by
   editing the baseline; log the changed protocol as its own run and report it.

3. **Compare and select.**

   ```text
   experiment_log action=compare slug=bench
   experiment_log action=compare slug=bench scope_id=<scope-id-from-compare> field=lr
   experiment_log action=best slug=bench scope_id=<scope-id-from-compare> metric=accuracy
   experiment_log action=best slug=bench scope_id=<scope-id-from-compare> dominance=true
   ```

   `best` requires a declared metric and explicit scope; its declared direction
   cannot be overridden. A scope is a user declaration, not verification.
   Runs without identities remain visible but are not ranked. Ties are listed,
   not silently broken. `dominance: true` returns
   the Pareto front over declared metrics; a run missing a metric is incomplete
   and not ranked. Never report "the best model" without saying which metric
   and direction chose it, and do not present the front as a scientific result.

4. **Summarize repeated runs.** Log the candidate label in `params.method` and
   the actual seed on every run. Use, for example:

   ```text
   experiment_log action=replicates slug=bench scope_id=<scope-id-from-compare>
     metric=accuracy candidate_field=method candidates=["base","variant"]
     baseline_candidate=base replicate_unit="one independent training run"
     expected_seeds=[1,2,3] selection_history=unknown
   ```

   If the intended seeds are unknown, omit `expected_seeds` and pass
   `coverage_unknown=true`. Duplicate seeds, missing values, failed or
   incompatible runs, and unexpected seeds are visible and not silently
   averaged. Pairing requires the variant's explicit baseline run ID and the
   same seed; equal seed numbers alone are insufficient. The grouping, unit,
   and selection history are user declarations. Mean and sample SD are
   descriptive; do not infer significance, confidence intervals, or a winner.

5. **Record the human verdict.** `action=verdict run_id=x0007 verdict=engineer
   reason="try a wider slice" engineering_round=2
   budget={"max_rounds":2,"used":2}`. Engineer is not terminal: an exhausted
   budget is force-`bad`, with both the request and the forced outcome stored.
   The verdict is an advisory human decision, not a model output.

6. **Link, don't duplicate.** `action=link run_id=x0007 target_kind=analysis_run
   target_id=run-…` connects a promising configuration to the pre-registered
   confirmation run, a notebook entry, or a paper. The link is live: if the
   linked `analysis_run` fails its frozen task rules (`analysis_run
   action=compliance`), this experiment run is excluded from `best`,
   `dominance`, and grouping; the exports keep the row with an exclusion
   marker, so they remain an audit trail. It stays visible with an `excluded`
   record naming the analysis run and the violated rule ids — discard the
   solution, do not "refine" it, and a recorded violation is sticky.

7. **Read the branch history.** When a run needs context — what it came from,
   what was tried beside it, or why it stopped — use the read-only branch view:

   ```text
   experiment_log action=branches slug=bench
   experiment_log action=branches slug=bench format=json
   experiment_log action=branches slug=bench format=mermaid write=true
   ```

   It follows recorded `parent` IDs and resolves links against the analysis,
   notebook, and review ledgers. Read `status` as evidence-only: `failed` means
   a linked analysis run recorded a non-zero exit or timeout, `pruned` means a
   human verdict said `bad`, and `not_recorded`/`unknown` mean the ledger does
   not know. A run without metrics is not failed. `paper` links are
   `not_checked` and `scientific_result` links are `unknown` by design. Missing,
   self, or cyclic parents and duplicate links are reported in `anomalies`, not
   repaired. Text and JSON are read-only; only `format=mermaid write=true`
   writes `exports/branches.mmd`.

8. **Export.** `export format=csv|json|markdown` for reports; `format=mlflow`
   for an MLflow-compatible JSON (interop, not an MLflow backend).

## Rules

- Log the params that actually ran, including the seed — a run without a seed
  is unreproducible by construction.
- Do not edit runs.jsonl by hand; a wrong entry is corrected by logging a new
  run or an analysis note, and the original stays. The branch view reports
  missing, self, or cyclic parents and duplicate links as anomalies; it never
  repairs them, and neither should you.
- Do not present compare/best output or a verdict as a result; findings go
  through `analysis_run`, `scientific_result`, or the manuscript with their own
  verification. The Pareto front and the verdict are advisory records.
- Never add a compliance-excluded run back into a selection by hand; fix the
  violation or report the exclusion.
- Data-leakage checks belong to `data_profile`, not here.
