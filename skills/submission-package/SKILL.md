---
name: submission-package
description: Assemble a journal submission bundle with `submission_pack` — plan limits and required statements, build the PDF/figures/supplement/cover letter/highlights/checklist, verify every file hash, export without submitting. Use when a manuscript is going to a journal or when the user asks what is missing before upload. Advisory only; unknown requirements stay manual checks and drafts need author approval.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Submission package

> **In Academic Harness:** `submission_pack` assembles and checks a bundle. It
> never submits, emails, logs into a journal portal, or invents a claim. A local
> pass is not journal acceptance, and a `manual_check` is not a pass.

## Workflow

1. **Collect the requirements.** Ask for the journal, article type, word/abstract/
   reference/figure/table limits, figure DPI/formats/color mode/naming rule, and
   required statements. Pass them in `requirements`. Do not guess a limit from
   memory; leave it absent and report the resulting `not_checked`/`manual_check`.
2. **Plan.** Call `submission_pack` with `action: "plan"`, the manuscript, the
   bibliography, figures, and the requirements. Read the checklist before
   changing the manuscript:
   - `fail` and `missing` are blocking;
   - `manual_check` needs a human decision;
   - `not_checked` records that the journal requirement was unknown.
3. **Supply author content.** Pass `statements`, `suggested_reviewers`,
   `cover_letter`, `highlights`, and `graphical_abstract` only when the author
   supplied them. Omit them for placeholder drafts that say what is missing.
4. **Build.** Call `action: "build"`. The pack contains the manuscript PDF and
   source, figures, supplementary files, statements, checklist, cover letter,
   highlights, and a manifest hashing every bundled file. The zip is
   reproducible from that manifest.
5. **Verify.** Read `manifest.json`, confirm `failed`/`missing`/`manual_check`,
   and run `action: "status"`. Use `action: "export"` to copy the zip or
   directory somewhere the author chooses.
6. **Stop before upload.** The authors submit through the journal's own system.

## Checks worth explaining

- Word/abstract counts are local approximations on the extracted manuscript
  text; the journal's own counter wins.
- Citation checks come from `manuscript_citations`; reporting evidence comes
  from the `reporting_check` ledger; numerical candidates come from
  `numbers_audit`. None of these is a compliance or validity verdict.
- Figure metadata for raster files comes from the local figure helper; vector
  files stay `manual_check` because DPI/color mode cannot be read reliably.
- Cover letters and highlights marked as drafts contain no generated claims.
  Suggested reviewers are only the user's entries.

## Guardrails

- Do not invent journal limits, reviewer names, affiliations, funding, ethics
  approvals, or statement text.
- Do not describe a built pack as "ready to submit"; say which checks remain.
- Do not upload, email, or automate a journal portal.
- Preserve figure aspect ratio; never silently convert a figure.

## Related

- `journal_search` `action: "match"` for advisory venue fit.
- `manuscript_citations`, `citation`, `reporting_check`, `numbers_audit`.
- `authorship` for the contribution statement.
- `manuscript-revision` when the pack is for a revision.
