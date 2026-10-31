---
name: experiment-tracking
description: Track hyperparameter sweeps, simulations, pilots, and model comparisons with the native `experiment_log` ledger — append-only runs with params, metrics, hashed artifacts, seeds, and parents; best-by-named-metric only; compare tables; links to notebook entries, analysis runs, and papers; CSV/JSON/Markdown/MLflow export. Use when a set of runs is too large or too varied for a single pre-registered analysis plan.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
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

2. **Log every run as it finishes** — params, metrics, artifact paths (hashed,
   workspace-confined), seed, and `parent` for follow-ups. A rerun is a new
   run; nothing is deduplicated, because "same params, different result" is
   exactly the signal you want to keep. Omit missing metrics rather than
   zero-filling them.

3. **Compare and select.**

   ```text
   experiment_log action=compare slug=lr-sweep field=lr
   experiment_log action=best slug=lr-sweep metric=accuracy
   ```

   `best` requires a named metric; an undeclared metric also needs an explicit
   `direction`. Ties are listed, not silently broken. Never report "the best
   model" without saying which metric and direction chose it.

4. **Link, don't duplicate.** `action=link run_id=x0007 target_kind=analysis_run
   target_id=run-…` connects a promising configuration to the pre-registered
   confirmation run, a notebook entry, or a paper.

5. **Export.** `export format=csv|json|markdown` for reports; `format=mlflow`
   for an MLflow-compatible JSON (interop, not an MLflow backend).

## Rules

- Log the params that actually ran, including the seed — a run without a seed
  is unreproducible by construction.
- Do not edit runs.jsonl by hand; a wrong entry is corrected by logging a new
  run or an analysis note, and the original stays.
- Do not present compare/best output as a result; findings go through
  `analysis_run`, `scientific_result`, or the manuscript with their own
  verification.
- Data-leakage checks belong to `data_profile`, not here.
