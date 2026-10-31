---
name: authorship-credit
description: Record authorship, CRediT roles, and ICMJE criteria with the `authorship` ledger and generate an author-contributions statement. Use when preparing a submission, when the user asks who did what, or when contribution and corresponding-author metadata must be collected. The tool never decides order or qualification; humans do.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Authorship and credit

> **In Academic Harness:** `authorship` is a record, not a judge. Author order,
> qualification, affiliations, ORCIDs, funding, and conflicts are human
> decisions; the tool preserves disagreements instead of resolving them.

## Workflow

1. **Start a record.** `action: "start"` with the manuscript and title. The
   record is write-once per slug.
2. **Add authors.** `action: "add"` with the exact name and any affiliation,
   ORCID, email, and corresponding flag the authors supplied. Pass `position`
   only when the authors have decided the order; omit it otherwise and the tool
   records `null`, not a guess.
3. **Record contributions.** `action: "credit"` with one or more CRediT roles:
   Conceptualization, Data curation, Formal analysis, Funding acquisition,
   Investigation, Methodology, Project administration, Resources, Software,
   Supervision, Validation, Visualization, Writing – original draft, Writing –
   review & editing.
4. **Record ICMJE.** `action: "icmje"` with the four criteria as `true`, `false`,
   or `"unknown"`; a missing criterion stays unknown and is reported.
5. **Generate the statement.** `action: "statement"` writes `statement.md` and
   `statement.json` with the recorded authors, roles, criteria, and an
   "items to resolve" list. Pass `funding`, `competing_interests`, and `ai_use`
   only when they were supplied.
6. **Export.** `action: "export"` for Markdown, CSV, or JSON under `exports/`.

## Disagreements

The event log is append-only. If a later record changes a role set or ICMJE
answer, the newest value is shown and the earlier one stays in the log; the
statement lists the change as a disagreement. Duplicate positions and duplicate
ORCIDs are reported, not merged. Multiple or missing corresponding authors are
reported as items to resolve.

## Guardrails

- Never assign an author order or infer that a contributor qualifies.
- Never invent an affiliation, ORCID, email, funding source, or conflict.
- Never resolve a disagreement by overwriting the log.
- The statement is a draft for the authors; it does not replace the journal's
  own author form.

## Related

- `author_lookup` (optional) only for independent verification, never inference.
- `submission_pack` for bundling the statement with the manuscript.
