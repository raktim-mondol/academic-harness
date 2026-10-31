# Publisher and AI-native sources

## Keyless publisher deposits

`literature_search` `sources=publishers` with a `publishers` array searches Crossref member deposits:

`wiley`, `elsevier`/`scopus`/`sciencedirect`, `springer`/`springer_nature`/`nature`, `ieee`, `taylor_francis`, `sage`, `oup`/`oxford`, `cup`/`cambridge`, `acm`, `acs`, `aps`, `iop`, `rsc`, `mdpi`, `frontiers`, `plos`.

This is metadata search, not entitlement to the publisher's full text.

## Keyed publisher tiers

- Scopus: `literature_search` `sources=scopus`, `domain_search` record/author/cited_by; also the Elsevier API key for Serial Title/ScienceDirect.
- Web of Science: `literature_search` `sources=wos`, `domain_search` record/cited_by; also JCR metrics.
- Springer: `literature_search` `sources=springer` and JATS full text in `paper_context` (`SPRINGER_API_KEY`).
- IEEE Xplore: `literature_search` `sources=ieee` (`IEEE_API_KEY`).
- Wiley TDM: `paper_context` PDF tier (`WILEY_TDM_TOKEN`).
- Elsevier Serial Title / ScienceDirect: `journal_search` CiteScore/SJR/SNIP and `paper_context` FULL (`SCOPUS_API_KEY`, optional `ELSEVIER_INSTTOKEN`).

These tiers degrade to `key_missing` or skip when unset. They are implemented but intentionally not automated-tested; treat a configured-but-failing tier as unverified.

## AI-native evidence tools

- Consensus: study-design, sample-size, journal-quartile, and OA filters; per-paper takeaways.
- Scite: supporting/contrasting/mentioning Smart Citations and regulatory evidence datasets.
- Elicit: paper/trial search and systematic-review workflows; Pro+ key; 100 RPM cap.
- FutureHouse/Edison: asynchronous Crow/Falcon/Owl agents; start, then poll.

Do not substitute AI-native summaries for a primary source when the task needs a verified quote, number, or method.
