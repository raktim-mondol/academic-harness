---
name: reporting-guidelines
description: Check a manuscript against a reporting guideline (CONSORT, STROBE, PRISMA, ARRIVE, TRIPOD+AI, CARE, STARD) with the native `reporting_check` tool — item-by-item verdicts, verified verbatim evidence, stale detection, and evidence-only exports. Use when a user asks whether a paper reports what a guideline requires, prepares a submission checklist, or audits a manuscript against CONSORT/STROBE/PRISMA/etc.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Reporting Guidelines

> **In Academic Harness:** `reporting_check` is the ledger. It snapshots the
> manuscript hash, records item verdicts in `.dsh/reporting/<slug>/`, verifies
> every reported quote against the current text, and marks affected evidence
> stale when the manuscript changes. It never says a manuscript is compliant.

Use this skill when the deliverable is an auditable reporting checklist: a
journal submission checklist, a co-author review of a draft, or an appraisal of
someone else's paper. For a general pre-submission read, use
`pre-submission-reviewer`; for a simulated referee report, use `peer-reviewer`.
A reporting check answers a narrower question: does the manuscript report what
this guideline asks for, with a quote a reader can verify?

## Choosing a guideline

```text
reporting_check action=suggest manuscript=paper.tex
```

`suggest` returns candidate guidelines and the study-design terms that matched.
It never chooses one. Confirm the design with the user (or the manuscript's
methods) before starting: CONSORT for randomised trials, STROBE for
observational studies, PRISMA 2020 for systematic reviews, PRISMA-S for the
search-reporting extension, PRISMA-ScR for scoping reviews, ARRIVE 2.0 for
animal research, TRIPOD+AI for prediction models, CARE for case reports, and
STARD for diagnostic accuracy studies.

If the manuscript is in PaperMemory, pass `paper=<id-or-key>` instead of a path.
Otherwise pass a workspace path: `.tex`, `.md`, `.txt`, `.docx`, or `.pdf`.

## Workflow

### 1. Open the check

```text
reporting_check action=start slug=<short-name> guideline=consort manuscript=paper.tex
```

`start` refuses to overwrite an existing check; `resume: true` continues one.
The snapshot records the manuscript hash. Do not start a check before the
guideline is chosen, and do not change the guideline mid-check.

### 2. Work through the items

```text
reporting_check action=items slug=<name> filter=unassessed
reporting_check action=candidates slug=<name> item=9
reporting_check action=judge slug=<name> item=9 verdict=reported \
  quote="The allocation sequence was concealed with sequentially numbered opaque envelopes." \
  reviewer=ai:deepseek
```

`candidates` ranks passages by section heuristics and the item's cue terms. It
is a reading aid, not a decision: read around the passage in the manuscript
before judging.

The four verdicts:

- `reported`: a verbatim quote shows the item is addressed.
- `partial`: a verbatim quote shows it is addressed only in part.
- `not_reported`: the listed terms or sections were checked and the item was
  not found. `searched` is required. This is an advisory absence claim, not a
  finding that the authors did something wrong.
- `not_applicable`: the item does not apply, with a `reason` a reader can
  challenge.

The tool re-finds every `reported`/`partial` quote in the manuscript after
whitespace normalisation. A quote that does not appear is rejected and is not
stored, so never paraphrase the manuscript into a quote. A `partial` verdict
still needs a quote; use `not_reported` only when there is no relevant passage.

### 3. Batch work with subagents

A long checklist can be split into item batches, but each batch must be judged
independently:

- Give the subagent the checklist item ids, the paraphrased prompt, the
  manuscript path, and the evidence rules above. Do not give it your own
  tentative verdicts.
- Require a verbatim quote for every `reported`/`partial`, and the exact
  `searched` terms for every `not_reported`.
- Record the reviewer as `ai:<model>` so the run is distinguishable from a
  human judgement.
- Reject any batch that returns a verdict without a quote or without searched
  terms rather than "fixing" it in the ledger.

This is the same discipline as the tournament's position-controlled judging:
the same brief, no leading context, and the tool — not the prose summary —
decides whether the evidence is acceptable.

### 4. Status and re-checks

```text
reporting_check action=status slug=<name>
```

`status` counts verdicts, lists unassessed items, and re-verifies quotes against
the current manuscript. If the manuscript changed, evidence whose quote no
longer appears is `stale` with `evidence_mismatch`; absence claims are marked
stale because they need to be checked again. Never report a stale verdict as
current: re-read the passage and judge it again with `override: true` and a
reason. Both events stay in the log.

### 5. Export

```text
reporting_check action=export slug=<name> format=markdown
reporting_check action=export slug=<name> format=csv
reporting_check action=export slug=<name> format=latex
```

The export reports **N of M items have verified evidence**, the unassessed and
stale counts, and a table of item ids, status, location, and evidence. It
contains links to the official checklist and paraphrased prompts. It never
says "compliant", "ready for submission", or "meets CONSORT". Say what the
export says: which items have evidence, which do not, and which need a human
decision.

## Academic Harness projects

When the manuscript is a `.tex` file in an `ah.yaml` project, evidence
locations also carry the `%% @unit` id from the engine's anchors. Do not edit
the anchors or run `ah units sync` from this workflow; `reporting_check` only
reads them. If the manuscript is stored in PaperMemory, use the paper id so the
check snapshots the stored text and the export says it came from indexed
chunks.

## Rules

- Never mark an item `reported` without a quote that the tool accepts.
- Never use `not_reported` as a judgement about the study's quality; it only
  means the text did not contain the item after the listed search.
- Never call a manuscript compliant, and never present a clean export as a
  submission guarantee.
- Do not edit the ledger by hand. Corrections are new `judge` events with
  `override: true` and a reason.
- Keep paths inside the workspace. `reporting_check` rejects symlink escapes.
