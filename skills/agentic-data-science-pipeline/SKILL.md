---
name: agentic-data-science-pipeline
description: Run a large, multi-stage data-analysis or research-engineering task as a structured plan-review-implement-verify-reflect loop instead of one long unstructured pass. Use when a request is big enough to need staged execution with adaptive replanning — a full analysis pipeline, a multi-part investigation, a research-engineering build — not for a single quick task.
license: MIT
metadata:
  version: "1.0"
  skill-author: K-Dense Inc.
---

# Agentic Data Science Pipeline

## Overview

Adapted from [`K-Dense-AI/agentic-data-scientist`](https://github.com/K-Dense-AI/agentic-data-scientist)'s
agent hierarchy — a plan → implement → verify → reflect loop it runs with
Google ADK and the Claude Agent SDK. This skill carries over the *structure*
of that loop, re-expressed with this plugin's own delegation tools
(`subagent`, `todo`, `notebook`, `scientific_result`) instead of a second
agent framework running alongside DSH.

Use this for a task large enough that a single unstructured pass would lose
the thread — a full analysis pipeline, a multi-part investigation, building
out a non-trivial piece of research engineering — not for a quick lookup or
single-file edit, where the overhead isn't worth it. This is about
**delegation mechanics for large tasks**; for the *rigor* of any individual
analysis inside a stage (framing the question, pre-registering before
touching outcome data, verifying results before claiming them), combine this
with the `using-science-superpowers` skill catalogue rather than duplicating
that discipline here.

## Related Supervisor-Skills

For AI-assisted tool choice and research-workflow rules, use `vibe-research-workflow`. This pipeline is for large, staged analysis tasks, not for paper drafting or idea vetting.

## The loop

```
Planning loop (repeat until confirmed):
  plan_maker      → drafts a high-level plan: numbered stages + success criteria
  plan_reviewer   → critiques completeness, correctness, feasibility
  (confirm)       → exit the loop once the reviewer's feedback is net-positive

plan_parser        → turns the approved plan into a todo list: one item per stage,
                     each with its own success criteria

For each stage, in order:
  Implementation loop (repeat until confirmed):
    coding agent        → implements ONLY this stage (real code/analysis, not the whole plan)
    review agent        → reviews just this stage's output against its criteria
    (confirm)           → exit once the reviewer approves or only minor issues remain

  criteria_checker  → re-checks ALL success criteria so far against actual files/output,
                       not memory — mark the todo item done only once this passes
  stage_reflector   → given what was actually found, decide whether the remaining
                       stages still make sense; edit/add/drop them if not

summary            → one Markdown report: task, plan, per-stage highlights, which
                     criteria were met, key results, artifact paths, open questions
```

## Mapping onto this plugin's tools

- **Each role above is a `subagent` call**, not a persistent second agent
  framework. Put the role name in `description`, and give it a tightly
  scoped prompt for exactly that role — see `references/*.md` for the
  original, detailed per-role instructions (review criteria, what
  plan_reviewer checks for, what the criteria_checker must verify against
  actual files rather than assume) to lift into a `prompt` almost as-is. Each
  file (other than `global_preamble.md` itself) opens with a literal
  `$global_preamble` placeholder — that's the original templating engine's
  substitution marker, not something to paste in verbatim; replace it with
  `global_preamble.md`'s content (or drop it and just use the role-specific
  portion below it) when composing a `prompt`.
- **`todo`** tracks the parsed stages as a list, one item per stage — mark
  in-progress/done as the implementation loop for each stage completes.
- **`notebook`** logs the trail a plain todo list can't hold: log a
  `decision` when the planning loop confirms, a `note`/`observation` per
  stage from the criteria_checker and stage_reflector calls (use `relatesTo`
  to chain a reflector's replan back to the criteria check that triggered
  it), so the reasoning behind a re-plan is still visible afterward.
- **`scientific_result`** replaces the standalone summary agent for a
  concrete finding (a results table or statistical-test outcome); use the
  final Markdown summary (`references/summary.md` for the template) for
  everything the task produced beyond a single structured result.
- Reviewer/checker roles should default to read-only (no file writes, no
  shell) exactly as `global_preamble.md` specifies for every role but the
  coding agent and summary — a subagent whose job is to judge someone else's
  work shouldn't also be able to quietly fix it.
- `plan_reviewer`/`plan_review_confirmation` and
  `coding_review`/`implementation_review_confirmation` are each two
  references collapsing into one `subagent` call in practice: ask the
  reviewer for its critique *and* an explicit approve/needs-more-work
  verdict in the same prompt, rather than two round trips.

## When to reach for the bioinformatics domain reference

`references/bioinformatics-domain/` carries two short domain-specialization
notes (interactive framing, science-methodology rigor) from the source
project's bioinformatics vertical — skim them when a stage in the pipeline
is itself a bioinformatics analysis, alongside the relevant domain skill
(scanpy, biopython, pysam, …) for the actual technical work.

## What was deliberately left out

The source repo's own orchestration code (ADK's `SequentialAgent`/
`LoopAgent`, loop-detection, event compression, the Claude Code SDK wrapper)
was not ported — it reimplements exactly what this plugin's `subagent`/
`todo`/`notebook` tools already do natively. Porting it would mean running a
second, competing agent-orchestration stack alongside DSH rather than using
the one already here.
