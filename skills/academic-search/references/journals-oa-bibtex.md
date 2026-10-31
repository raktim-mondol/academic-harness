# Journals, open access, and BibTeX

## Journal discovery

`journal_search` merges:

- OpenAlex `/sources`: 2-year mean citedness, h-index, i10, works/citations, APC, DOAJ status, homepage, topics.
- DOAJ v4 journals: OA status, APC in USD, license, publisher, country, subjects.
- Crossref journals: ISSNs, publisher, DOI counts, subjects.

Deduplicate by ISSN(s), then normalized title. Use `journal_policy` for OA/self-archiving policy; use `journal_search` for metrics and venue selection.

Optional keyed metrics: Elsevier Serial Title CiteScore/SJR/SNIP (`SCOPUS_API_KEY`, optional `ELSEVIER_INSTTOKEN`) and WoS JCR JIF/JCI/quartile/percentile (`WOS_API_KEY`). They are skipped without keys and warned about when configured but failing.

## Open-access resolution

- `paper_download`: Unpaywall (with `UNPAYWALL_EMAIL`) → OpenAlex publisher PDF → Europe PMC → CORE → arXiv.
- `paper_get`: fills an OA URL through Unpaywall/OpenAlex when the merged record has none.
- `paper_context`: uses the OA URL only in its final PDF tier; it never writes the file.
- Do not invent an Unpaywall email. The other fallbacks still run without one.

## BibTeX

`paper_get` / `citation` resolve in this order:

1. DOI content negotiation (`application/x-bibtex`), with a Crossref transform fallback.
2. arXiv `/bibtex/{id}`.
3. INSPIRE `?format=bibtex`.
4. Semantic Scholar `citationStyles.bibtex`.
5. Deterministic synthesis from the merged record.

Return `bibtex_source` with the value. A synthesized entry is valid but may lack publisher-specific fields; prefer an official DOI/arXiv entry when available.
