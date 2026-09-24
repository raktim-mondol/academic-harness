---
name: aer-skills
description: Route empirical-economics manuscript work — topic selection, causal identification (DiD/IV/RDD/SCM/shift-share), pre-registration, robustness, body/introduction drafting, AER-style tables, consistency audit, referee simulation, AEA replication deposits, submission preflight, and R&R rebuttals — targeted at AER, AER:Insights, or an AEJ journal. Use when the user is writing, analyzing, or revising a top-5 economics manuscript, or asks "what should I work on next" mid-paper. Not for generic scientific writing (use manuscript-editor / scientific-writing) or non-economics causal inference (use causal-inference-scientist).
license: MIT
metadata:
  version: "1.5.0"
  skill-source: https://github.com/brycewang-stanford/AER-Skills
---

# AER Skills

Fifteen skills covering the AER / AER:Insights / AEJ manuscript lifecycle end to end: topic selection through R&R rebuttal, plus an optional StatsPAI execution engine for the empirics.

## ResearchCraft on DSH

This is the `brycewang-stanford/AER-Skills` stack (MIT), vendored whole from its parent catalog, [Auto-Empirical-Research-Skills](https://github.com/brycewang-stanford/Auto-Empirical-Research-Skills) — a ~1,100-skill empirical-research collection where every other collection is CC BY-SA 4.0 (ShareAlike, incompatible with this plugin's MIT license without dual-licensing). `AER-Skills` is the one first-party, MIT-licensed subset, so it's the one copied in directly rather than reimplemented; nothing else from that catalog is included here.

- This skill is the **router only** — load it, pick the matching sub-skill from the table below, then open only that sub-skill's `skills/aer-<name>/SKILL.md`. Don't preload all fifteen.
- For non-economics causal inference or general statistics, prefer `causal-inference-scientist`, `biostatistician`, or `statistician`. Use this stack specifically for the AER/AEJ manuscript conventions (desk-screen norms, booktabs tables, AEA Data and Code Availability policy, Keith-Head-style introductions) — a generic writing or stats skill will miss those.
- `skills/aer-workflow/SKILL.md` is the original, complete router (gate sequence, decision cues, common mistakes, anti-patterns, handoff contract) — read it for anything beyond the condensed table below.
- `examples/` holds runnable demos (staggered DiD, weak-IV, RDD polynomial choice, synthetic control, sensitivity analysis, and more) and a replication-package skeleton. `templates/` has Stata, R, and Python starting points. `docs/` has the shared style guide, methods reference, and glossary that several sub-skills point into.

## Routing table

| Sub-skill | Use when |
|---|---|
| [`aer-workflow`](skills/aer-workflow/SKILL.md) | Deciding what to work on next, or sequencing a full paper from topic to rebuttal |
| [`aer-topic-selection`](skills/aer-topic-selection/SKILL.md) | Testing whether an idea clears the AER top-5 bar, choosing AER vs. Insights vs. AEJ, sharpening the contribution sentence |
| [`aer-literature`](skills/aer-literature/SKILL.md) | Mapping antecedent papers, novelty-scanning, or verifying every citation is real and correctly attributed |
| [`aer-identification`](skills/aer-identification/SKILL.md) | Choosing or stress-testing DiD (incl. staggered), IV (incl. weak-instrument-robust), RDD, SCM, or shift-share/Bartik |
| [`aer-preregistration`](skills/aer-preregistration/SKILL.md) | Field/lab/survey experiments — pre-analysis plan, power/MDE sample sizing, AEA RCT Registry, before the intervention runs |
| [`aer-robustness`](skills/aer-robustness/SKILL.md) | Adding the placebo, heterogeneity, mechanism, and alternative-sample checks referees will demand |
| [`aer-paper-body`](skills/aer-paper-body/SKILL.md) | Drafting/revising background, data, strategy, results narration, magnitude interpretation, mechanisms, conclusion |
| [`aer-introduction`](skills/aer-introduction/SKILL.md) | Drafting the introduction (five-paragraph Head/Bellemare formula) or compressing the abstract to 100 words |
| [`aer-tables-figures`](skills/aer-tables-figures/SKILL.md) | Regression/descriptive tables and figures in AER booktabs house style |
| [`aer-consistency`](skills/aer-consistency/SKILL.md) | Auditing a near-finished manuscript: numbers vs. tables, sample sizes, conversions, cross-references, citation matching |
| [`aer-referee-sim`](skills/aer-referee-sim/SKILL.md) | Adversarial desk-screen + three simulated referee reports before submission |
| [`aer-replication`](skills/aer-replication/SKILL.md) | Assembling the AEA Data and Code Availability deposit (openICPSR-ready) and its README |
| [`aer-submission`](skills/aer-submission/SKILL.md) | Final preflight — length, format, cover letter, disclosures — immediately before submitting |
| [`aer-rebuttal`](skills/aer-rebuttal/SKILL.md) | Writing the point-by-point R&R response letter and aligned manuscript edits |
| [`aer-statspai`](skills/aer-statspai/SKILL.md) | Running the fixed design (DiD/IV/RDD/SCM) from the agent via the StatsPAI Python API/MCP engine, once `aer-identification` has chosen the method |

## Default sequence

`aer-topic-selection` → `aer-literature` → `aer-identification` (→ `aer-preregistration` if collecting new data) → `aer-robustness` → `aer-paper-body` → `aer-introduction` → `aer-tables-figures` → `aer-consistency` → `aer-referee-sim` → `aer-replication` → `aer-submission` → `aer-rebuttal` (after external review). Full gate criteria are in `skills/aer-workflow/SKILL.md`.
