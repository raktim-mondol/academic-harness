---
name: subset-first-eval
description: Use when planning or recording a staged benchmark comparison that starts on a subset or slice before a full evaluation, or when checking a reproduced versus reported baseline and protocol drift.
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Subset-first evaluation

Use `experiment_log` to record comparisons and `analysis_run` to execute a frozen analysis. Neither tool decides that a result is scientifically valid. Obtain permission before running code, and do not access held-out outcomes while designing the subset.

1. Agree on the question, datasets and splits, baseline, metric directions, task rules, and a deterministic sampling rule with size, seed, and stratification. A subset is not automatically representative. Freeze the benchmark and evaluation protocol (`eval_script` and `metric_params`) with `experiment_log action=start`.
2. Name the baseline reference `reproduced` only if there is actual reproduction evidence; otherwise use `reported`. Never mix the two in a comparison. Freeze an `analysis_run action=plan` with inputs, outputs, methods, and task rules; record expected values with `expect` and run `verify_scores` on an independently executed run where feasible. Missing, stale, failed, or unverifiable evidence is `not_checked`, not a pass.
3. Log the baseline first: `experiment_log action=log role=baseline baseline_ref=reproduced stage=subset sampling={...}`. Add the user-declared `comparison_identity` described in `experiment-tracking`; link the corresponding `analysis_run` by its real id. Record each variant with that identity, the explicit `baseline_run_id`, the same baseline reference, stage and sampling, its actual parameters, metrics, and seed. Scope ideas as `tournament-slug#h1` in `params.idea_id` when multiple tournaments reuse ids.
4. Read `compare` to identify scopes and supply the chosen `scope_id` to `best`. Inspect `spec_drift`, unknown identities, and compliance exclusions. A recorded compliance violation is sticky: exclude that run from selection and packages; a subsequent clean check cannot rehabilitate it. Log a new, compliant run rather than altering history. Do not fill missing metrics with zero or turn an advisory verdict into a claim.
5. Ask the author before scaling up. Log a separate `stage=full` baseline before the full variant, and supply that baseline's run ID. Inspect the new scope, drift, and missing results again. Report subset coverage, failures, metrics and direction, baseline provenance, and the author's decision; subset success alone is not proof of generalization.

See `experiment-tracking`, `reproducible-analysis`, and `ablation-attribution` for their respective ledgers.
