# Open scholarly graphs

## OpenAlex

- 300M+ works and 250K+ sources under CC0.
- `openalex_search` supports `filter`, `query`, `group_by`, and `entity=works|authors|sources|topics`.
- `entity=sources` now surfaces ISSNs, publisher, OA/DOAJ, APC, 2-year mean citedness, h-index, and i10.
- Keyless budget is shared per network; `OPENALEX_API_KEY` raises the rate and daily budget.
- Singleton lookups (DOI, PMID, PMCID, OpenAlex ID) are free and are used by `paper_get` and `paper_resolve`.
- Semantic `search=` queries are capped at 1 RPS.

## Semantic Scholar

- Relevance search, bulk boolean search, and ~500-word snippet search.
- `snippet` mode accepts `paper_ids` to scope passages to one paper; `paper_context` uses this.
- `S2_API_KEY` is optional but gives a dedicated 1 RPS bucket. Keyless calls share a throttled pool and can return 429.
- Records include TLDRs, citation/influential-citation counts, OA PDFs, and `citationStyles.bibtex`.

## Crossref

- Canonical DOI metadata and journals.
- `CROSSREF_MAILTO` moves requests into the polite pool; it falls back to `UNPAYWALL_EMAIL`.
- Publisher member search uses Crossref `/v1/members/{id}/works` and is keyless.
- DOI content negotiation at `https://doi.org/{doi}` is the first BibTeX tier.

## OpenCitations

- DOI-level COCI edges: citing works and references, with OCI, creation date, and timespan.
- `openalex_citations` uses it only when OpenAlex returns no edges for a DOI.
- Titles are placeholders by design; enrich the DOI with `paper_get` before citing.

## Identifiers

- `paper_resolve` converts DOI, PMID, PMCID, arXiv, OpenAlex, S2, INSPIRE, ACL, bibcode, Scopus, WoS, and Wikidata identifiers.
- Use it before citing whenever results came from more than one index.
