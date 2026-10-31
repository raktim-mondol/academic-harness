---
name: grade-certainty
description: Record GRADE certainty judgements and produce an evidence profile plus summary-of-findings table with the native `review` tool — outcome definitions, risk-of-bias/inconsistency/indirectness/imprecision/publication-bias ratings, observational upgrade domains, reviewer-keyed conflicts, and a human-owned overall certainty. Use when the user asks for GRADE, certainty of evidence, an evidence profile, or a summary-of-findings table.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# GRADE certainty and summary of findings

> **In Academic Harness:** GRADE lives inside the `review` ledger. It reuses
> the review's protocol, reviewers, and evidence. The tool records human
> ratings and derives a suggestion; it never stores an automatic certainty
> verdict.

Use this skill after the review question, outcomes, and evidence are defined.
For screening and appraisal, use `systematic-review-ledger` and
`risk-of-bias-appraisal`; for pooled effects, use `meta-analysis`.

## Ledger layout

```
.dsh/review/<slug>/
  grade.json      write-once outcome/comparison definitions
  grade.jsonl     append-only domain and overall judgements (g0001, …)
  exports/        grade-profile.md/csv, sof-table.md/csv/tex
```

Never edit these files by hand. Corrections are new events with a reason.

## Workflow

### 1. Define outcomes

```text
review action=grade_start slug=<name> outcomes=[
  {"id":"mortality","name":"All-cause mortality","comparison":"X vs placebo",
   "importance":"critical","studies":["S1","S2","S3"],"participants":400,
   "effect":0.75,"effect_ci":[0.6,0.9],"measure":"RR","notes":"12 months"}
]
```

- `id` and `name` are required; ids must be unique.
- `importance`: `critical`, `important`, `not_important`, or `not_recorded`.
- `studies` may be a count or a list of study ids; `participants` is a count.
- `effect`/`effect_ci`/`measure` are the values that belong in the
  summary-of-findings table. They are recorded, not recalculated here.
- `grade_start` refuses to overwrite unless `resume: true`.

### 2. Rate the domains

```text
review action=grade_judge slug=<name> outcome=mortality domain=risk_of_bias \
  rating=serious reviewer=human:alice reason="Two trials had unclear allocation concealment" \
  [quote="…" location="Methods, p. 2" paper=<papermemory-id>]
```

Downgrade domains and ratings:

| Domain | Ratings |
|---|---|
| `risk_of_bias` | `not_serious`, `serious`, `very_serious` |
| `inconsistency` | `not_serious`, `serious`, `very_serious` |
| `indirectness` | `not_serious`, `serious`, `very_serious` |
| `imprecision` | `not_serious`, `serious`, `very_serious` |
| `publication_bias` | `not_serious`, `serious`, `very_serious` |

Upgrade domains (observational evidence only):

| Domain | Ratings |
|---|---|
| `large_effect` | `upgrade`, `not_applicable` |
| `dose_response` | `upgrade`, `not_applicable` |
| `plausible_confounding` | `upgrade`, `not_applicable` |

- Every judgement needs a reason. A quote is optional; if supplied, it needs a
  location and is checked through PaperMemory when `paper` is supplied.
- A repeat by the same reviewer needs `override: true`; both events stay.
- With two or more declared reviewers, a domain is `incomplete` until every
  reviewer has judged it; different ratings are a `conflict`.

### 3. Check the derived suggestion

```text
review action=grade_status slug=<name> [outcome=<id>]
```

The suggestion starts from `high`, subtracts 1 for each `serious` and 2 for
each `very_serious` downgrade domain, adds 1 for each `upgrade`, and maps the
score to `high`/`moderate`/`low`/`very_low`. It is a **suggestion only**.
Missing domains, missing reviewers, and conflicts make it unavailable. The
stored overall is always a human decision.

### 4. Record the overall certainty

```text
review action=grade_overall slug=<name> outcome=mortality certainty=moderate \
  reviewer=human:alice reason="Downgraded for inconsistency and imprecision"
```

- `certainty`: `high`, `moderate`, `low`, or `very_low`.
- A reason is required; a repeat by the same reviewer needs `override: true`.
- If the stored certainty differs from the suggestion, `grade_status` warns.
- With multiple reviewers, different overall certainties are a `conflict`;
  the export shows `conflict` rather than choosing one.

### 5. Export

```text
review action=export slug=<name> format=grade-profile table_format=markdown
review action=export slug=<name> format=grade-profile table_format=csv
review action=export slug=<name> format=sof-table table_format=markdown
review action=export slug=<name> format=sof-table table_format=csv
review action=export slug=<name> format=sof-table table_format=latex
```

The evidence profile lists every domain rating, reviewer, reason, and quote.
The summary-of-findings table has outcome, studies, participants, effect,
certainty, and comments. Exports refuse to overwrite unless `overwrite: true`.

## Reporting rules

- Describe certainty as a **recorded human judgement**, not a tool verdict.
- Report missing domains, missing reviewers, and conflicts; do not present a
  partial assessment as complete.
- A suggestion is not the result; the stored overall certainty is.
- Report the effect and CI as recorded; GRADE does not recalculate the effect.
- Never describe a `low` or `very_low` rating as proof that an intervention
  does not work, or a `high` rating as a recommendation.
- Use "summary of findings", not "evidence table" if the required columns are
  not all present.
