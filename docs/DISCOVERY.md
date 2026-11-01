# Discovery and reference checks

Phase 7 of the scientific expansion plan. Five additions that keep a search alive, map a field, and check references and data links. None needs a key beyond the optional `OPENALEX_API_KEY`, `S2_API_KEY`, and `CROSSREF_MAILTO` that the existing search tools already read. Skills: `research-monitoring`, `citation-network`, `reference-audit`.

Every tool follows the harness rule: the tool reports what a check found, a check that could not run is `unverified` or a named failure state, and nothing here decides whether a paper is good or a claim is supported.

## `literature_watch`

Saved searches under `.dsh/watch/`.

| Action | Behaviour |
|---|---|
| `add` | Save a watch: `name`, `query`, `sources`, `year_min`/`year_max`, `since`, `open_access_only`, `frequency` (manual, daily, weekly, monthly), `max_results`, `notes`. |
| `list` / `remove` | Manage watches. A removed watch keeps its history. |
| `run` | Run one watch (`watch`) or all (`due_only` limits to those whose frequency says they are due) through the `literature_search` sources. |
| `digest` | Markdown of the new records since the last digest, grouped by watch, each with the query and sources that matched. `preview` does not advance the cut; `all` shows everything; `out` writes a workspace file. |
| `status` | Last run per watch, new counts, failures, and whether it is due. |

Ledgers: `watches.jsonl`, `seen.jsonl`, `hits.jsonl`, `runs.jsonl`, `digests.jsonl`, all append-only. Records are keyed by DOI, then arXiv/PMID/OpenAlex id, then title and year. A run is `ok`, `partial` (some source failed), or `failed`, and names each failing source. Scheduling is manual; nothing emails, runs on a timer, or ingests into PaperMemory. "New" means unseen by this watch.

## `paper_recommend`

Related papers from a `seed` or `seeds` (DOI, arXiv id, PMID, OpenAlex id for OpenAlex, Semantic Scholar id). Sources: Semantic Scholar recommendations (several seeds are sent together) and OpenAlex related works. Results are merged and de-duplicated, the seeds and papers already in the PaperMemory library are removed (reported as not checked when the library is unavailable), and each carries a `why`: shared reference count, shared topics, cites the seed, same venue, or only "suggested by the provider". Providers that agree rank first; citation count does not rank. Recommendations are leads, not evidence. Nothing is ingested.

## `citation_network`

`build` samples OpenAlex around the seeds (`direction` cites, cited_by, or both; `depth` 1–2; `limit_per_node`; `max_nodes` up to 500; a fixed call budget) and freezes it as `.dsh/network/<slug>/graph-<build>.json` with the source, retrieval time, truncation flag, and a hash that analysis re-checks. The other actions read a frozen build and make no requests:

| Action | Output |
|---|---|
| `metrics` | In-degree, PageRank, betweenness (undirected), weak components, bibliographic coupling, co-citation (a lower bound). |
| `clusters` | Louvain communities on the undirected graph, deterministic, labelled with frequent title words and the top PageRank paper. |
| `path` | Shortest citation path between two papers (`directed: false` allows any direction). |
| `export` | GraphML, CSV (`-nodes.csv`, `-edges.csv`), or Mermaid. Refuses to overwrite without `overwrite`. |
| `status` | The builds for a slug. |

The graph is a bounded sample. Centrality and citation counts are not quality, a missing edge is not a missing citation, and authors are not disambiguated.

## `paper_artifacts`

Extracts repository links (Zenodo, Figshare, OSF, Dryad, Dataverse, GitHub, GitLab, Hugging Face, Kaggle, Software Heritage), accessions (GEO, SRA, BioProject, ArrayExpress, PRIDE, MassIVE, EGA, and PDB/GenBank when a cue word is nearby), and data/code availability statements (flagging "on request" and "not available" wording) from `text` or a workspace `path`. `action=verify` (or `verify: true`) sends a HEAD, falling back to a one-byte GET, to public hosts only (redirects are re-checked, loopback/private/link-local addresses refused), capped by `max_verify`; links over the cap are `manual_check`. Statuses: `resolves`, `resolves_after_redirect`, `not_found`, `provider_blocked`, `unsafe_host`, `error`. Accessions stay `unverified`. Nothing is downloaded; use `dataset_get`. To read a PaperMemory paper, export it to Markdown with `paper_fold` and pass the path.

## `citation` `action=audit`

A batch reference audit for `records`, `text`, `path`, `library`, or `doi`. Per reference: DOI validity; Crossref metadata match (title, year more than a year apart, venue, first author); retraction, expression of concern, and correction through `integrity_check` (with the notice DOI); duplicate DOIs, keys, and title-year pairs; missing fields; whether it formats in the chosen `style`; and, with `manuscript` (`.tex` or `.md`), bibliography entries the manuscript never cites. Each finding has a severity and a suggested fix. Statuses: `problem`, `review`, `unverified` (no DOI, lookup failed, or past `max_audit`), `no_issues_found`. Unknown is never reported as clean, and the audit does not check that a reference supports the claim it is cited for.

## Not built in Phase 7

- **7C `trial_registry_search`** (WHO ICTRP, EU CTR, ISRCTN, PROSPERO) and the `clinicaltrials compliance` action.
- **7D grey literature and regional sources** (SciELO, LILACS, J-STAGE, ERIC, thesis repositories, keyed Embase/CINAHL/PsycINFO).
- **7H** the `openfda` disproportionality `signal` action.
- Local-library similarity in `paper_recommend`, license lookup in `paper_artifacts`, a notebook entry from `literature_watch digest`, SVG export and OpenCitations/Semantic Scholar sources in `citation_network`.

These need registry or API contracts that were not verified against live endpoints; the plan keeps them as separate sub-phases.
