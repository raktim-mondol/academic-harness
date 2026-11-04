---
name: experiment-tracking
description: Track hyperparameter sweeps, simulations, pilots, and model comparisons with the native `experiment_log` ledger — append-only runs with params, metrics, hashed artifacts, seeds, parents, and captured environment; a staged benchmark contract with baseline/variant roles, subset/slice/full stages, sampling rules, and a protocol digest that reports spec drift; advisory good/engineer/bad verdicts with a force-bad exhausted engineering budget; best by named metric or the multi-metric Pareto front, with runs linked to a compliance-violating analysis run excluded; compare tables; links to notebook entries, analysis runs, and papers; CSV/JSON/Markdown/MLflow export. Use when a set of runs is too large or too varied for a single pre-registered analysis plan.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.1"
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
   experiment_log action=log slug=bench role=baseline baseline_ref=reproduced stage=subset
     sampling={"size":32,"seed":7,"stratification":"by dataset"} metrics={"accuracy":0.80,"latency":100}
   experiment_log action=log slug=bench role=variant baseline_ref=reproduced stage=full
     metrics={"accuracy":0.85,"latency":90}
   ```

   The baseline captures `protocol_digest`; every variant must name a baseline
   with the same `baseline_ref`. A changed `eval_script` or `metric_params` is
   stored as `spec_drift` against that baseline. Never paper over drift by
   editing the baseline; log the changed protocol as its own run and report it.

3. **Compare and select.**

   ```text
   experiment_log action=compare slug=lr-sweep field=lr
   experiment_log action=best slug=lr-sweep metric=accuracy
   experiment_log action=best slug=bench dominance=true
   ```

   `best` requires a named metric; an undeclared metric also needs an explicit
   `direction`. Ties are listed, not silently broken. `dominance: true` returns
   the Pareto front over declared metrics; a run missing a metric is incomplete
   and not ranked. Never report "the best model" without saying which metric
   and direction chose it, and do not present the front as a scientific result.

4. **Record the human verdict.** `action=verdict run_id=x0007 verdict=engineer
   reason="try a wider slice" engineering_round=2
   budget={"max_rounds":2,"used":2}`. Engineer is not terminal: an exhausted
   budget is force-`bad`, with both the request and the forced outcome stored.
   The verdict is an advisory human decision, not a model output.

5. **Link, don't duplicate.** `action=link run_id=x0007 target_kind=analysis_run
   target_id=run-…` connects a promising configuration to the pre-registered
   confirmation run, a notebook entry, or a paper. The link is live: if the
   linked `analysis_run` fails its frozen task rules (`analysis_run
   action=compliance`), this experiment run is excluded from `best`,
   `dominance`, and grouping; the exports keep the row with an exclusion
   marker, so they remain an audit trail. It stays visible with an `excluded`
   record naming the analysis run and the violated rule ids — discard the
   solution, do not "refine" it, and a recorded violation is sticky.

6. **Export.** `export format=csv|json|markdown` for reports; `format=mlflow`
   for an MLflow-compatible JSON (interop, not an MLflow backend).

## Rules

- Log the params that actually ran, including the seed — a run without a seed
  is unreproducible by construction.
- Do not edit runs.jsonl by hand; a wrong entry is corrected by logging a new
  run or an analysis note, and the original stays.
- Do not present compare/best output or a verdict as a result; findings go
  through `analysis_run`, `scientific_result`, or the manuscript with their own
  verification. The Pareto front and the verdict are advisory records.
- Never add a compliance-excluded run back into a selection by hand; fix the
  violation or report the exclusion.
- Data-leakage checks belong to `data_profile`, not here.
