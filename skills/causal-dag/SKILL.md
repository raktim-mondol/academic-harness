---
name: causal-dag
description: Make causal assumptions explicit with a user-specified DAG, derive identification diagnostics (d-separation, minimal backdoor/front-door sets, colliders, instruments, testable implications), and compute E-values. Use before an observational causal analysis, when defending an adjustment set, or when asking what a DAG implies.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Causal DAG

> **In Academic Harness:** `causal_dag` stores the graph under
> `.dsh/causal/<slug>/` and derives graph properties. It never fits a model or
> estimates an effect. Estimation belongs in `analysis_run` with explicit code.

## Workflow

1. **State the estimand first.** Name the treatment `X`, outcome `Y`, and
   target population/intervention. A DAG without an estimand cannot answer an
   identification question.
2. **Draw the assumed graph.** Include unmeasured common causes as latent
   nodes (`{id: "U", latent: true}`); omitting them asserts they are absent.
   `create` accepts nodes/edges or DOT, Mermaid, or edge-list text (`text` or
   `file` + `format`). Every later change is a new version with a reason.
3. **Check the graph.** `analyze` reports the treatment–outcome d-separation,
   minimal backdoor adjustment sets, front-door sets, collider/M-bias
   warnings, instrument candidates, and local-Markov testable implications.
   Pass `given` to test a specific conditioning set and `adjust_for` to have a
   proposed set warned about (descendant of treatment, collider, unobserved).
4. **Defend the set.** A minimal set is minimal *by inclusion under this graph*,
   not automatically the best estimator choice. Report the assumptions that
   make it valid, especially no unmeasured treatment–outcome confounding.
5. **Sensitivity.** `evalues` computes VanderWeele E-values for RR/OR/HR, or an
   approximate standardized-effect conversion. An E-value is the minimum
   confounder association needed to explain away the estimate; it is not
   evidence that confounding is absent.
6. **Estimate elsewhere.** Freeze an `analysis_run` plan that names the
   estimand, adjustment set, estimator, positivity diagnostics, and sensitivity
   analyses. Do not turn graph-implied identification into an estimated effect.

## Guardrails

- The graph is the user's assumption; do not add arrows the user did not state.
- Absence of an arrow is a claim of no direct causal effect, not a finding.
- A collider warning is a graph warning, not proof of bias in a fitted model.
- Instruments need more than the graph conditions (effect homogeneity,
  monotonicity, no unmeasured confounding); state the caveats.
- `export` writes Mermaid, DOT, edge list, or JSON. Use the same slug in
  `preregister` to import treatment/outcome and the latest adjustment set.

## References

- Pearl, *Causality* (2nd ed.) — backdoor/front-door criteria.
- Hernán & Robins, *Causal Inference: What If* — target trials, adjustment,
  positivity.
- VanderWeele & Ding (2017), *Annals of Internal Medicine* — E-values.
