# PaperMemory v2 — 100+ paper scale test

Generated from 310 markdown papers converted from PDFs found on this machine (pdf-inspector), ingested into a scratch store.

## Metrics

| Metric | Value |
| --- | --- |
| papers | 104 |
| documents | 184 |
| chunks | 8965 |
| sections | 6174 |
| table_chunks | 727 |
| bibliography_chunks | 554 |
| ingest_seconds | 2.29 |
| probes | 20 |
| topn_matches | 20 |
| p95_ms | 11.7 |
| recap_chars | 976 |

## Checks

| Check | Result | Detail |
| --- | --- | --- |
| 100+ unique papers ingested | PASS | papers=104, docs=184, statuses={'created': 184, 'duplicate-noop': 126} |
| all ingested files produced chunks | PASS | created=184, dup=126, chunks=8965 |
| no unexpected ingest failures | PASS | failed=0 [] |
| re-ingest is duplicate-noop | PASS | {'duplicate-noop': 25} |
| same paper from another path stays one record | PASS | {'duplicate-noop': 5} |
| no duplicate raw documents | PASS | 184 -> 184 |
| true top-N matches bm25 for all probes | PASS | 20/20 |
| scoped search p95 <= 120 ms | PASS | p95=11.7ms |
| cross-project leak blocked | PASS | no-match-in-project |
| other project can retrieve its own chunk | PASS |  |
| bibliography is suppressed, not returned | PASS | reason=all-suppressed:bibliography suppressed={'bibliography': 1, 'non_claimable': 1, 'uncovered_span': 0} results=0 token=pachetti |
| absent term reports no-match | PASS | no-match |
| claims anchored and verified at scale | PASS | added=33, verified=30 |
| contradicted claim leaves search | PASS |  |
| contradicted claim leaves list | PASS |  |
| quote_check rejects a missing quote | PASS |  |
| Jaccard supersedes a near-duplicate claim | PASS | old_latest=0 |
| OCR claim stays capped below verified | PASS | extracted |
| outline returns sections for sample papers | PASS | 5/5 profiles={'empirical': 5} |
| recap stays within 6k chars | PASS | 976 chars |
| recap reports scope stats | PASS | {'papers': 104, 'claims': 34, 'chunks': 8965, 'cite_state': {'citable': 104}, 'coverage': {'docs': 104, 'capped_docs': 0}} |
| list pages and totals agree | PASS | total=104 |
| coverage rollup is complete | PASS | {'docs': 104, 'source_chars': 5213314, 'indexed_chars': 5201961, 'capped': 0, 'with_uncovered': 104, 'ratio': 0.9978223065021596} |
| health invariants clean | PASS | {} |
| FTS index count matches chunks | PASS | fts=8969 chunks=8969 |
| reindex is count-stable | PASS | 234 -> 234 |
| CRLF markdown is refused with a typed reason | PASS | newline-not-lf |
| heading-less paper is unclassified/low confidence | PASS | {'headings': 0, 'structure_confidence': 'low', 'profile': 'unknown', 'profile_confidence': 20} |

## Section role distribution

```
{
 "unclassified": 4190,
 "method": 751,
 "results": 398,
 "related_work": 266,
 "bibliography": 166,
 "introduction": 133,
 "conclusion": 124,
 "abstract": 84,
 "analysis": 19,
 "appendix": 13,
 "limitations": 10,
 "discussion": 10,
 "materials": 7,
 "background": 2,
 "acknowledgements": 1
}
```

## MCP surface on the scale store

- tools/list: 14 tools
- search: 3 results, typed keys ['absence_scope', 'corpus_match_count', 'coverage', 'empty_reason', 'legs', 'results']… legs={'chunk': 'ok', 'claim': 'ok', 'paper': 'ok', 'notes': 'ok'}
- outline: 18 sections, profile=empirical
- get: 10 chunk slices, 0 claims, truncated=True
- cite: 4 hits, supports_statement=[False, False, False, False]
- list coverage: 105 docs, ratio 0.998, chunkless=0
- trace paper: 2 docs, 0 claims
- sandbox: isError=True, code=path-escape

