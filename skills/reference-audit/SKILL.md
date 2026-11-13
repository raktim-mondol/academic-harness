---
name: reference-audit
description: Audit a bibliography with `citation` action=audit (DOI validity, Crossref metadata match, retraction and correction status, duplicates, missing fields, uncited entries) and check a paper's data and code links with `paper_artifacts` (repository links, accessions, availability statements, link checks). Use before submission, when reviewing a manuscript's references, or when judging whether a paper's data and code are really available.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Reference audit

> **In Academic Harness:** `citation` `audit` checks references against Crossref and
> `integrity_check`; `paper_artifacts` extracts and checks data/code links. Both report
> what a check found. Neither judges whether a reference supports the claim it is cited
> for, or whether linked data is what the paper describes.

## Auditing a bibliography

1. Pass the `.bib` (or `text`, `path`, `library`) and, if you have it, `manuscript`
   (`.tex` or `.md`) so uncited entries can be found.
2. Read the statuses:
   - **problem** — retracted, invalid DOI, DOI not registered. Fix or remove first.
   - **review** — metadata mismatch, expression of concern, correction, duplicate,
     missing field, uncited. Look at each; many are harmless (abbreviated venue,
     preprint year).
   - **unverified** — no DOI, a lookup failed, or the `max_audit` cap was reached.
     This is not a pass. Add DOIs, retry, or raise the cap.
   - **no_issues_found** — these checks found nothing. It does not show the reference is
     correct, relevant, or the best source.
3. The audit reads registry answers from a snapshot (`.ah/cache/lookups.json`), so re-running
   it on the same bibliography gives the same findings; the output line "Lookups: registry
   data as of …" says how old they are. Re-running does not look for new problems. Before
   submission, run once with `refresh_lookups: true` so a retraction or correction that
   appeared since is seen. If a refresh fails, the earlier answer is kept and the line says
   so; treat that as unverified for anything newer than its date.
4. A retracted reference carries the notice DOI. Remove it, or cite it explicitly as
   retracted when the retraction is the point.
5. `citation-checker` (the specialist) is the next step when claim support matters.

## Checking data and code availability

1. `paper_artifacts` with `text` or a workspace `path` (export a PaperMemory paper to
   Markdown with `paper_fold` first). Use `action=verify` to check the links.
2. Read the **statements** before the links. "Available on request" is not open data;
   "not available" is a legitimate statement the journal may still accept.
3. A link that **resolves** only shows something answers at that URL: it may be an
   empty repository, a landing page, or a different version. A **404** may be a moved
   record. **provider_blocked** (401/403/429) means the host refused the check, not that
   the link is dead.
4. **Accessions are never verified here.** Look them up in the database (`science_source`
   covers UniProt, PDB, AlphaFold, PubChem; GEO/SRA need the NCBI site).
5. Extraction is pattern matching. PDB ids and GenBank accessions are only recognised
   next to a cue word, so a bare id can be missed; always scan the paper.
6. Links beyond the `max_verify` cap are `manual_check`.

## Guardrails

- No claim-support verdicts, no "clean" for unknown: say `unverified`.
- Checks go to public hosts only; local and private addresses are refused.
- Nothing is downloaded. Use `dataset_get` to fetch a dataset into the workspace.
- A DOI that matches its metadata is not evidence the cited paper says what you claim.
