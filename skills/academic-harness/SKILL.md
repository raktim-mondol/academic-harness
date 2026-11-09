---
name: academic-harness
description: "Write, revise, and verify academic LaTeX (literature reviews, journal/conference papers, grants, theses, rebuttals) with Academic Harness on DeepSeek Harness. Use when the workspace has ah.yaml, or the user asks to start, audit, plan, or fix a paper/grant/thesis in LaTeX. Routes to ah-write-unit, ah-plan-section, ah-fix-findings, ah-audit-section, ah-revise-from-review."
---

# Academic Harness on DeepSeek Harness

The engine is the substitute oracle for academic writing. DeepSeek Harness is the chat. Pi is not required.

Inactive outside a directory tree with `ah.yaml`. To start: `ah_init` (new) or `ah_migrate` (existing LaTeX tree, dry-run first).

## What DSH already does in this session

- Injects the paper-state card (conventions, facts, terms, scope, thesis, briefs, blockers)
- Blocks writes to `sources/`, facts, ledger, briefs, claim records, reviews, plans, and the outline
- Blocks dropping a `%% @unit` anchor while rewriting a paragraph
- After each `write`/`edit`/`bash` that changes prose, appends the findings that edit introduced
- Loops until those findings are gone, then stops or hands off to the author

You never close a finding. Only a later check that no longer fires marks it fixed. A waiver is the author's.

## Route

| User ask | Load |
|---|---|
| Draft or rewrite a paragraph / table / figure | `ah-write-unit` |
| Add a section or argument not yet in the outline | `ah-plan-section` |
| Fix audit findings | `ah-fix-findings` |
| Review / audit a section without editing | `ah-audit-section` |
| Address reviewer or supervisor comments | `ah-revise-from-review` |

## Non-LaTeX paper work

Outside an `ah.yaml` project, the Supervisor-Skills suite covers the paper lifecycle: `deep-research`, `idea-evaluator`, `tech-paper-template` or `benchmark-paper-template`, `intro-drafter`/`paper-writer`/`paper-polish`, `figure-designer`/`drawio-reconstruction`, `pre-submission-reviewer`, and `rebuttal-guidance`. Do not use this engine as a generic paper template when no `ah.yaml` exists; its tools return "not a project".

## Tools

Native `ah_*` tools (not MCP, not Pi). Prefer them over shelling out to `ah`. Do not `pip install academic-harness` and do not install it into DSH; the engine is vendored inside this plugin (`vendor/academic-harness`).

| Need | Tool |
|---|---|
| Coverage | `ah_inventory`, then `ah_check` / `ah_audit` |
| "Is it done" (one answer: pass, fail or incomplete) | `ah_done` |
| Numbers, figures, references (outside the engine) | `ah_external` `run`, then `ah_audit` `external=use` |
| Which format rules are worth promoting (fixed vs waived) | `ah_precision` |
| Free-review comments (`deep_review`, referee simulations): which a rule already covers, and turning a recurring one into a rule | `ah_triage`, `ah_rule_propose` (the author accepts) |
| Fixed yes/no writing criteria (overclaiming, causal wording, ...) | `ah_rubric` `list`/`run`; `ah_audit` `rubric=true` (cached verdicts) or `judge=true` (asks the model) |
| Anchors, facts macros | `ah_units`, `ah_fact` `build` |
| Evidence | `ah_source` `add`/`list`, `ah_source_search` |
| Draft | `ah_plan` → `ah_brief_new` → `ah_pack` → `edit` |
| Numbers | `ah_fact`, `ah_bind`, `ah_sweep`, `ah_fact_propose` |
| Reviews | `ah_review` `import`, `ah_review_set`, `ah_review_respond`, `ah_snapshot` |
| Provenance / AI-use | `ah_provenance`, `ah_disclosure` |
| Profiles / overlay | `ah_profile`, `ah_init`, `ah_migrate`, `ah_config`, `ah_catalogue` |

Author-only (human must have asked this message; DSH confirms): waive, accept/reject a fact or a proposed rule, approve a brief or plan, verify a claim, decline a review item, fill provenance, approve a disclosure. You cannot do those. Call `ah_decision_request` and stop, or `ah_author` after they asked.

Free reviews (`deep_review`, `peer-reviewer`, `pre-submission-reviewer`) are exploratory and never gating: they raise different points on each run. Fix ledger findings (`ah_check`); treat review comments as candidates for promotion to a rule; never rerun a free review just to check that fixes worked.

Numbers from data: `\fact{id}`. Cite only registered sources. Do not invent citations, numbers, or quotes. Done means inventory coverage is complete and this turn introduced no open blocker or major. For the document as a whole ask `ah_done`: it says pass, fail or incomplete and names the component that decides (findings, admitted rubric criteria, external results, findings with no cause, the age of the registry snapshot). "Incomplete" is not a pass: something that matters was not looked at, so say so instead of reporting it as done. It is not a verdict on the science.
