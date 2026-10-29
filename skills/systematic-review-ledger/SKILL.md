---
name: systematic-review-ledger
description: Run a systematic or scoping review as an auditable screening funnel with the native `review` tool — protocol, record intake from literature searches, two-stage screening, verbatim evidence, PRISMA-style counts, and exports. Use when the user asks for a systematic review, scoping review, PRISMA audit, reproducible screening, or an evidence table built from a search.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Systematic Review Ledger

> **In Academic Harness:** the native `review` tool is the ledger. It stores
> an append-only event log under `.dsh/review/<slug>/`; discovery still comes
> from `literature_search`, `openalex_search`, `pubmed_search`, `arxiv_search`,
> `s2_search`, or `crossref_lookup`. Run `integrity_check` before citing any
> record in the final report.

Use this skill when the deliverable must show *how* studies were selected, not
just what was found. For an ordinary narrative literature review, use the
`literature-review` skill instead — a ledger adds bookkeeping that survey does
not need. For a survey-grade report with frozen research questions and
per-citation verification, use the Supervisor-Skills `deep-research`.

## Ledger layout

```
.dsh/review/<slug>/
  protocol.json      write-once review question, criteria, database list
  records.jsonl      append-only records with stable ids (r0001, …)
  search_log.jsonl   one row per `add`: source, query, added, skipped
  screening.jsonl    append-only decision events (latest per record+stage wins)
  evidence.jsonl     append-only evidence rows (e0001, …)
  exports/           review.md, evidence.csv, review.json
```

Never edit these files by hand. The event logs are the audit trail; rewriting
them destroys the record of what was decided and by whom.

## Workflow

### 1. Protocol before search

Agree the question and criteria with the user first, then:

```text
review action=start slug=<short-name> question="…" databases=["OpenAlex","PubMed"]
  inclusion=["…"] exclusion=["…"] date_range="2015-2026" [notes="…"]
```

`start` refuses to overwrite an existing review. `resume: true` continues one;
the protocol is never silently changed. Do not start searching before the
question and criteria are explicit — screening criteria invented after results
are known invalidate the funnel.

### 2. Discovery, then intake

Run searches in the normal search tools and pass each query's results to the
ledger:

```text
review action=add slug=<name> source=literature_search query="…" records=[…]
review action=add slug=<name> source=crossref query="…" path=literature/query-1.jsonl
```

- `records` takes the tool result array directly (normalized papers or
  CSL-JSON-like objects with `title`, `doi`, `authors`, `year`, `venue`).
- `path` reads a workspace JSON array, `{ "results": [...] }`, or JSONL.
- Deduplication order: DOI → PMID → arXiv → normalized title+year. Re-adding
  the same query must add zero records; it still writes a search-log row.
- One `add` per query, with the real query string, so the search log can be
  reported. Do not merge several queries into one intake call.

### 3. Two-stage screening

```text
review action=screen slug=<name> id=r0001 stage=title_abstract decision=include
review action=screen slug=<name> id=r0002 stage=title_abstract decision=exclude reason="animal study"
review action=screen slug=<name> id=r0001 stage=full_text decision=include
```

- Decisions are `include`, `exclude`, `maybe`. `exclude` and `maybe` require a
  reason; keep reasons short and criterion-shaped ("wrong population", not
  "not relevant").
- `full_text` is rejected until that record has a `title_abstract` include.
- Re-screening a stage is rejected unless `override: true`. Both events stay
  in the log and `status` uses the latest one — say in the report that a
  decision was overridden instead of hiding it.
- The tool never decides. Ask the user (or apply the stated criteria one
  record at a time) and show the title before recording the decision. Never
  infer a decision from an abstract silently.

### 4. Evidence extraction

```text
review action=evidence slug=<name> id=r0001 claim="X reduced Y by 20%" \
  quote="X reduced Y by 20% (p=0.01)" location="Results, p. 4" page=4 section=Results
```

- Only for a record with a full-text `include`.
- `quote` is stored verbatim. If the paper is in PaperMemory, run
  `papermemory_quote_check` / `papermemory_trace` — the ledger does not verify
  quotes and an unverified quote must not be presented as verified.
- `scan`/OCR-recovered papers are capped at `extracted` in PaperMemory; carry
  that caveat into the report.

### 5. Status before counts

```text
review action=status slug=<name>
```

Report only what it returns: records total, search queries/added/skipped,
title/abstract and full-text counts, exclusion reasons, `included`, and
`included_without_evidence`. Resolve pendings and missing evidence with the
user before writing "N studies were included" — a PRISMA count is a claim
about the funnel.

### 6. Export the deliverable

```text
review action=export slug=<name> format=markdown
review action=export slug=<name> format=csv
review action=export slug=<name> format=json
```

- `markdown` — protocol, PRISMA-style table, exclusion reasons, included
  records, evidence table, review checklist.
- `csv` — evidence rows with record title/DOI.
- `json` — full protocol, derived status, records, screening events, evidence.

Exports refuse to overwrite unless `overwrite: true`; a second export of the
same format is a deliberate replacement, not routine.

## Reporting rules

- Label counts as **PRISMA-style**, derived from this ledger — not as a formal
  PRISMA 2020 flow diagram unless the user builds one.
- Name every database and the date of search from the search log. Never
  present a ledger built from one source as a multi-database review.
- Duplicates skipped is a counted outcome, not an error to hide.
- Screening is a human decision; if the user has not made it, leave records
  pending rather than filling the table.
- Publication status comes from `integrity_check`, not from this ledger.
