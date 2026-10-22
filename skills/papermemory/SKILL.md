---
name: papermemory
description: >
  Academic paper memory for understanding papers and writing papers. Use for
  literature, citations, verbatim claims, manuscripts, related work, bibtex,
  DOI/arXiv ingest, cite-check, outlines, and recap of a writing project.
  Triggers: paper memory, remember this paper, cite this, citation check,
  literature review, manuscript status, /papermemory. Not for coding-session
  memory or the lab notebook.
license: MIT
metadata:
  version: "0.2.0"
  source: https://github.com/raktim-mondol/papermemory
---

# PaperMemory

Local, verbatim-first academic memory on the Academic Harness preset. Database:
`~/.local/share/papermemory/papermemory.db` (override `PAPERMEMORY_DB`); the
plugin auto-installs the CLI and mounts 14 MCP tools. Do not `pip install` a
second copy. Prefer `mcp__papermemory__*` when present; CLI fallback:
`papermemory <cmd> --json`.

The unit of trust is a claim anchored to a byte span of a stored markdown
paper. Raw papers are content-addressed; every chunk is a contiguous byte
slice, so quotes re-slice exactly. Memory never paraphrases source text.

## First action

Call `papermemory_recap` with the manuscript/project slug on any paper task.
If it returns `empty_reason: project-not-found`, pick a `known_projects` entry;
never present another project's papers as this project's evidence.

## Tools

| Goal | Tool |
| --- | --- |
| Project briefing (stable + volatile, budgeted) | `papermemory_recap` |
| Search chunks/claims/papers/notes (typed empty reasons) | `papermemory_search` |
| Enumerate papers, claims, lessons, coverage | `papermemory_list` |
| Paper outline (roles, spans, DOI, filename) | `papermemory_outline` |
| Ingest markdown / PDF / bib / manuscript tree | `papermemory_ingest` |
| Show a paper with full claims and chunk slices | `papermemory_get` |
| Find a citable paper (claims, support flag, degradation) | `papermemory_cite` |
| Check manuscript citations and claim gaps | `papermemory_cite_check` |
| Store a verbatim-anchored claim / lifecycle action | `papermemory_claim` |
| Exact-substring quote check | `papermemory_quote_check` |
| Claim provenance walk or paper reverse-hop | `papermemory_trace` |
| Save a project decision | `papermemory_remember` |
| Save a durable rule (supersede supported) | `papermemory_lesson` |
| Register markdown into an Academic Harness project | `papermemory_register_to_ah` |

## Claim rules

1. `papermemory_quote_check` the exact wording against the paper (or rely on
   `papermemory_claim`, which locates it and refuses a miss with
   `quote-not-verbatim`).
2. Store with `evidence`. The tool records the located span, `quote_sha256`,
   origin channel and overlapping chunks. Whitespace-only differences are
   stored `unverified-quote` / `asserted-quote-differs`; never claim them as
   verified.
3. `papermemory_trace` walks sources → chunk hashes → quote materialization →
   current doc → file sha. It promotes to `verified` only after a passing byte
   re-slice. OCR-converted papers stay capped at `extracted`.
4. Corrections are events, not edits: `action: supersede | contradict |
   rebind`, with `target_claim_id`. Contradicted claims leave cite/recap/list.
5. Near-duplicate claims (>0.9 token Jaccard on the same paper) supersede the
   older one; 0.4–0.9 returns `similar_to` without mutation.

## Absence and citation integrity

- `papermemory_search` returns `empty_reason`, `suppressed`, `legs`, and
  `coverage`. Assert "memory has no source" only for `no-match`. For
  `no-match-in-project`, `all-suppressed:*`, `absence-not-licensable`, or
  `leg-error:*`, report the reason and enumerate with `papermemory_list`.
- Cite only what `papermemory_cite`/`papermemory_get` return. Check
  `supports_statement` (a verified claim) and `degradation` (OCR pages).
- Run `papermemory_cite_check` before finishing a section; resolve
  `claim_gaps`, `missing_from_memory`, and `unverified_cited`.
- Never recopy `notebook`, session notes, or your own paraphrase as evidence.

## Reading and ingest

1. Prefer markdown per paper. `pdf_to_markdown` with `write_to` ingests
   automatically (unless a page subset was converted); scanned/OCR output is
   marked `ocr-recovered` and claims from it are capped below `verified`.
2. `papermemory_outline` then `papermemory_get` for structure and full slices;
   don't reason from 400-char previews (v2 returns bounded but complete text).
3. `papermemory_register_to_ah` for Academic Harness projects (AH id is the
   paper id; citation keys are registered as aliases).

## CLI fallback

`papermemory recap|search|list|outline|paper|cite|cite-check|claims|trace|verify|quote-check|ingest|register-ah|evidence-export|import-verdicts|sweep|catalog|health|log --json`.
`papermemory verify CLAIM` walks provenance; `papermemory lookup KEY` is DOI
metadata lookup (not the same command).

## Do not

- Do not mark a claim verified by assertion; only the byte re-slice promotes it.
- Do not invent titles, years, DOIs, or keys; missing keys are gaps to report.
- Do not treat chunkless (metadata-only) papers as evidence; they are
  bibliographic rows (`cite_state='chunkless'`).
