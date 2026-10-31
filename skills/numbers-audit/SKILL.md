---
name: numbers-audit
description: Audit a manuscript's reported numbers with `numbers_audit` — recompute p-values from test statistics, check confidence intervals and estimates, total N and subgroup counts, flow counts, percentages, table/text values, and impossible values. Use before submission or whenever a manuscript's numbers need a consistency pass. Candidates only, never a validity or misconduct verdict.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Numbers audit

> **In Academic Harness:** `numbers_audit` recomputes only what the text makes
> checkable. Everything else is `not_checked`. A flag is a candidate for human
> review, not a finding of error or misconduct.

## Workflow

1. **Pick the manuscript.** `.tex`, `.md`, `.txt`, `.docx`, or `.pdf` (PDF text
   extraction happens first). For a scanned PDF, run `pdf_to_markdown` with OCR
   first and audit the Markdown.
2. **Run the audit.** Read `summary.by_kind`, then the rows by line number.
   `grim: true` adds the mean-consistency check when a mean and N are present.
3. **Triage each candidate.** Re-read the sentence and the source output. A
   flag can be a rounding choice, a subgroup denominator, or a typo; decide with
   the authors.
4. **Recompute where possible.** For a test statistic and df, the tool computes
   the p-value. For a CI and a nearby estimate, it checks containment. For
   `x/y (z%)`, it checks the percentage. Do not "fix" a value without the
   authors' data.
5. **Report coverage.** Say how many values were checked, how many candidates
   were flagged, and what stayed `not_checked` (units, unmatched table rows,
   values without a recomputable statistic). Never say the statistics are valid.

## What is not checked

- Units and effect-size plausibility.
- Values whose label cannot be matched unambiguously to a table row.
- p-values without a reported test statistic.
- GRIM/GRIMMER unless `grim: true` (GRIMMER is not implemented).
- Anything inside references, equations, citations, or years.

## Guardrails

- Never present a candidate as confirmed misconduct.
- Never replace a reported number with the recomputed one; report both.
- Do not run the audit on a manuscript the user has not authorized.
- Keep `not_checked` in the report; dropping it overstates coverage.

## Related

- `stat_audit` (optional tool) for a narrower p/GRIM pass.
- `reporting_check` for guideline evidence.
- `numbers_audit` is included in `submission_pack` planning.
