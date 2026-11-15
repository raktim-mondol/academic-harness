---
name: ah-plan-section
description: Propose an outline change for a new section or claim in an Academic Harness project. Use when asked to add a section, subsection or argument that is not yet in outline.yaml, before any prose is written. When the author is turning an idea note and an experiment log into a paper, the proposal also carries the draft contract.
---

# Plan a section

Academic Harness on DeepSeek Harness. Native `ah_*` tools. Pi is not required.

The author states what to write and what it must support. You propose an outline. Prose waits until the author approves.

1. Call `ah_plan` with `action: show` to read the current outline and any pending proposals.
2. Draft a complete outline: keep every existing section and claim the author did not ask to drop. Add new `sections` entries with `planned: true` for files that do not exist yet. Add `claims` with `supports: [thesis]` (or a parent claim id) and the units that will carry them. Copy forward any `literature`, `citation_hints`, `figures`, and `section_points` already on the outline unless the author asked to change them. Approving a proposal replaces `outline.yaml`, so a proposal that omits those blocks deletes them.
3. Call `ah_plan` with `action: propose`, an `id`, plus `thesis`, `sections`, `claims`, and any draft-contract blocks. This writes `plans/<id>.yaml` only.
4. Call `ah_plan` with `action: diff` and that id so the author can see the change.
5. Stop. Tell the author they can approve with `ah_author` `action: plan-approve` (DSH will ask them to confirm). You cannot approve. Leave `.tex` files, `\input` lines and briefs for files the outline does not yet name until after that approval. After approval, load skill `ah-draft-from-plan` for the searches and figures.

## Draft contract

Add these blocks when the author is turning an idea note and an experiment log (or `experiment_log` status) into a paper. A proposal that only adds a section leaves them unchanged.

- `literature.cutoff` is `YYYY-MM`. Introduction searches are broad: surveys, foundational work, and the hook. Related-work clusters are the methods this paper competes with. Do not add a competitor the log does not evaluate. `introduction.gap` names only data the log measured.
- One `citation_hints` entry for every dataset, metric, baseline, optimizer, and model named in the idea or the log. `kind` is `dataset`, `metric`, `baseline`, `model`, `method`, or `other`. Give a `query`, or a `title` when the exact title is known. A title is not a guessed BibTeX key.
- Every `figures` entry is `plot` or `diagram`. A plot names an experiment slug in `experiment` and uses `source: experiment` or `both`. The id is a token and does not contain the word "figure". `aspect` is one of `1:1`, `4:3`, `3:2`, `16:9`, `3:4`, `2:3`, `9:16`.
- Each `section_points` entry names a real equation, table, or result in the source notes, and a `file` that matches a `sections` entry.

## Outside an ah.yaml project

For pre-writing paper structure without an Academic Harness project, use the Supervisor-Skills `tech-paper-template` (or `benchmark-paper-template`). This skill is active only inside an Academic Harness project.
