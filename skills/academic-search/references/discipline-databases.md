# Discipline databases

## arXiv

- Fielded queries: `ti:`, `au:`, `abs:`, `cat:`, `all:`, combined with AND/OR/ANDNOT.
- One request every 3 seconds; `arxiv_search` serializes calls.
- arXiv HTML (`https://arxiv.org/html/{id}`) is the free section-level tier in `paper_context`.
- arXiv API availability can vary by network; `paper_get` also resolves arXiv IDs through OpenAlex's DataCite DOI (`10.48550/arXiv.*`).
- ar5iv was removed after it repeatedly timed out; do not use it as a fallback.

## PubMed / Europe PMC

- Europe PMC is the default `pubmed_search` source: JSON, no key, MeSH support, OA links.
- `source: "ncbi"` uses E-utilities; `NCBI_API_KEY` raises 3 → 10 RPS, `NCBI_EMAIL` identifies the caller.
- `preprints: true` restricts Europe PMC to `SRC:PPR`.
- `paper_context` uses PMC BioC JSON and PubTator3 for structured biomedical sections.

## bioRxiv / medRxiv

- `domain_search` `source=biorxiv` supports browse, DOI, and published-version lookup.
- Keyword discovery goes through Europe PMC `SRC:PPR`; the CSHL API handles date/category browse.

## INSPIRE-HEP

- `domain_search` supports record, citations, references, texkey, and BibTeX.
- High-energy physics coverage; no key.

## ADS

- `ADS_API_TOKEN` required; auto-selected for astronomy only when the token exists.
- `domain_search` supports record, citations, references, export, and metrics.
