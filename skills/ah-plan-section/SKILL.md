---
name: ah-plan-section
description: Propose an outline change for a new section or claim in an Academic Harness project. Use when asked to add a section, subsection or argument that is not yet in outline.yaml, before any prose is written.
---

# Plan a section

Academic Harness on DeepSeek Harness. Native `ah_*` tools. Pi is not required.

The author states what to write and what it must support. You propose an outline. Prose waits until the author approves.

1. Call `ah_plan` with `action: show` to read the current outline and any pending proposals.
2. Draft a complete outline: keep every existing section and claim the author did not ask to drop. Add new `sections` entries with `planned: true` for files that do not exist yet. Add `claims` with `supports: [thesis]` (or a parent claim id) and the units that will carry them.
3. Call `ah_plan` with `action: propose`, an `id`, plus `thesis`, `sections` and `claims`. This writes `plans/<id>.yaml` only.
4. Call `ah_plan` with `action: diff` and that id so the author can see the change.
5. Stop. Tell the author they can approve with `ah_author` `action: plan-approve` (DSH will ask them to confirm). You cannot approve. Leave `.tex` files, `\input` lines and briefs for files the outline does not yet name until after that approval.

## Outside an ah.yaml project

For pre-writing paper structure without an Academic Harness project, use the Supervisor-Skills `tech-paper-template` (or `benchmark-paper-template`). This skill is active only inside an Academic Harness project.
