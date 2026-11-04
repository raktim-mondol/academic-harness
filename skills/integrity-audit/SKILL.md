---
name: integrity-audit
description: Use when preparing an evidence-grounded research integrity or provenance audit of reproduced numbers, experiment protocols, references, and method–code alignment.
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Four-column research integrity audit

This is an advisory reading of recorded evidence, not an acceptance decision, misconduct finding, or new autonomous pipeline. Obtain authorization before running code, external lookups, or editing artifacts.

1. **Reported versus recomputed:** freeze `analysis_run` expectations and compare a distinct rerun via `verify_scores`; inspect hashes, environment, entrypoint, tolerance, and compliance. `not_checked` is not a match. Report mismatches and sticky compliance exclusions without laundering them into selection or packages.
2. **Protocol digest:** use `experiment_log` to compare each staged variant to the matching `reported` or `reproduced` baseline. Report `spec_drift`, missing runs, incomplete metrics, and absent human verdicts; do not mix baseline types.
3. **References:** inspect stored citation verdicts and verify identity, retraction status, and claim support separately. `citation action=repair` writes a new bibliography with a sidecar; do not overwrite the source or invent a replacement. A registry hit is not evidence that a paper supports a claim.
4. **Method–code:** use `repo_audit action=align`, inspect context, and bind only reviewed, unambiguous evidence. `missing`, `ambiguous`, skipped, and `not_checked` are not passes.
5. Run `provenance_audit action=arms` to read the four columns and `unsupported` to inspect states; use `rollup` for the ordered record. These rebuild the audit's own cache but never promote an idea or modify source ledgers. For cycle review costs, supply a manuscript to select reviews; otherwise no reviews are attributed. Report the denominators, missing evidence, and the limits of each check.

The CoE four-check framing originates with ScientistOne; do not attribute it to ScientistTwo as a pipeline stage. Use `numbers-audit`, `method-code-alignment`, `subset-first-eval`, and `provenance-audit` for the narrower workflows.
