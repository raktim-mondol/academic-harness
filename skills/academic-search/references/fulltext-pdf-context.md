# Full-text and PDF context

`paper_context` answers “what does this paper say about X?” without dumping a whole PDF into the prompt.

## Tiers

1. **Semantic Scholar snippets** — ~500-word body passages, scoped to the paper's S2 ID when known. Keyless; 429 is possible on the shared pool.
2. **arXiv LaTeXML HTML** — structured headings and paragraphs from `https://arxiv.org/html/{id}`. This is the arXiv full-text tier; ar5iv was removed after persistent timeouts.
3. **NCBI PMC BioC** — segmented TITLE/ABSTRACT/INTRO/METHODS/RESULTS/DISCUSS/FIG/TABLE passages for PMC open-access articles.
4. **PubTator3 BioC** — additional structured biomedical passages when PMC BioC is thin.
5. **Publisher TDM (keyed)** — Wiley TDM PDF (`WILEY_TDM_TOKEN`), Elsevier ScienceDirect FULL (`SCOPUS_API_KEY`, optional `ELSEVIER_INSTTOKEN`), Springer JATS (`SPRINGER_API_KEY`). Skipped when unset.
6. **OA PDF** — the merged OA URL is fetched through the same SSRF-checked path as `paper_download` and converted with pdf-inspector. Scanned pages are reported, not OCR'd by default.

## Controls

- `focus_query` ranks sections and snippets by term overlap.
- `max_chars` caps the excerpt; sections and snippets have their own caps.
- `include_pdf: false` skips the PDF tier.
- `include_bibtex: false` skips the canonical entry when you only need context.
- No file is written and nothing is ingested into PaperMemory.

## Boundaries

- `paper_context` is remote and targeted. `paper_fold` is local map-first reading of a whole paper. `pdf_to_markdown` converts a local PDF; `paper_download` saves and ingests.
- A context snippet is a lead, not verified evidence. Quote-check or trace it in PaperMemory before citing.
- When no full text is available, the tool returns the abstract/TLDR and a `no_full_text` warning. Report that honestly rather than reconstructing the paper from the abstract.
