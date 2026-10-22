---
name: ah-audit-section
description: Audit a section or chapter of an Academic Harness project and report problems grouped by unit, without editing. Use when asked to review, audit or check a section.
---

# Audit a section (read-only)

Academic Harness on DeepSeek Harness. Native `ah_*` tools. Pi is not required.

1. Run `ah_check` with the section's files and `evidence: true`. These are code results: report them as they are, ordered by level.
2. Run `ah_claims` for the file. For each numeric or comparative claim that matters, use `ah_source_search` with the cited key and compare the source's wording, value, measure and condition with the claim. Report only what you verified in a passage, and quote it with its locator.
3. Separate three things in the report: findings from code (certain), mismatches you verified in a source (quote and locator), and suspicions you could not verify (say so). Do not present a suspicion as a finding.
4. Do not edit files. Do not re-report a finding that is `waived` or already `decision-needed` (see `ah_findings`).
5. End with counts by level and the three or four items the author should look at first.
