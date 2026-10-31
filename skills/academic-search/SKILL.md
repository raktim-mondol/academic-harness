---
name: academic-search
description: >-
  Route academic discovery on Academic Harness: OpenAlex/Semantic Scholar/Crossref/arXiv/PubMed,
  journal metrics, merged paper metadata and BibTeX, focused full-text context, citation trails,
  and keyed publisher sources. Use when a task needs papers, venues, identifiers, citations, or
  evidence from a paper rather than general web search.
---

# Academic search routing

Academic Harness exposes native search tools. Pick by the question, not by the number of tools:

| Question | Tool |
|---|---|
| Find papers on a topic | `literature_search` (one clean ranked list), then `openalex_search` / `s2_search` / `pubmed_search` / `arxiv_search` for source-specific filters |
| Which journal/venue, and how does it rank? | `journal_search` |
| Is this venue OA / what may I self-archive? | `journal_policy` |
| One authoritative record for a known paper | `paper_get` |
| Convert DOI/PMID/PMCID/arXiv/OpenAlex/S2 identifiers | `paper_resolve` |
| Official BibTeX for one entry | `paper_get` (or `citation` with `identifier`) |
| A specific method, number, table, or claim in a paper | `paper_context` |
| Forward/backward citations | `openalex_citations` |
| Save and ingest the PDF | `paper_download` |
| Read a whole paper already on disk | `paper_fold` / `pdf_to_markdown` |
| What sources and keys are available? | `database_catalog` |

## Keyless first

Default discovery is keyless: OpenAlex, Semantic Scholar, Crossref, arXiv, Europe PMC, DOAJ, OpenCitations, publisher Crossref deposits, and the free tiers of `paper_context`. Optional keys only raise limits or unlock publisher tiers. Never invent an email for Unpaywall; use `UNPAYWALL_EMAIL` when configured, otherwise rely on OpenAlex/CORE/Europe PMC/arXiv fallbacks.

Keyed sources (Scopus, Web of Science/JCR, Elsevier Serial/ScienceDirect, Wiley TDM, Springer, IEEE, ADS, Consensus, Scite, Elicit, FutureHouse) return `key_missing` or skip when unset. Paid/keyed tiers are implemented but are not part of the automated or live test suite; report a configured-but-failing tier as unverified, not as evidence the paper does not exist.

## Guardrails

- Resolve identifiers before citing. The same paper under a DOI, PMID, arXiv ID, and OpenAlex ID is one paper.
- `OpenCitations` fallback edges and their titles are placeholders. Enrich the DOI with `paper_get` before citing; never present a placeholder as a title.
- Paywalled, scanned, or unavailable full text returns the abstract and a warning. Do not infer the paper's content from a search snippet.
- Sources that require bot-challenge bypasses are not included; report the gap rather than building a workaround.
- A retrieved snippet or `paper_context` passage is a lead, not verified evidence. Quotes and claims must pass PaperMemory `quote_check` or `trace` before becoming citations.
- `paper_context` does not write or ingest; `paper_download` and `pdf_to_markdown` own persistence.

## Full-text order

`paper_context` cascades through Semantic Scholar snippets, arXiv LaTeXML HTML, NCBI PMC BioC, PubTator3 BioC, optional publisher TDM, and the OA PDF. Use `focus_query` to rank passages and `max_chars` to bound the excerpt. Use `paper_fold` for map-first whole-paper reading; use `pdf_to_markdown` when the PDF is local.

## References

- `references/open-scholarly-graphs.md`
- `references/journals-oa-bibtex.md`
- `references/discipline-databases.md`
- `references/publisher-and-ai-apis.md`
- `references/fulltext-pdf-context.md`
