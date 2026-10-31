# Cross-ledger provenance audit

Phase 3 of the [scientific expansion plan](SCIENTIFIC-EXPANSION-PLAN.md). Each
ledger in the harness keeps excellent local state — `review` knows its evidence,
`reporting_check` knows its quotes, `analysis_run` knows its input hashes, the
`ah` engine knows which passage a clause was bound to — but none of them can
answer the question a reader, a reviewer, or an author actually asks:

> Which manuscript claims, review inclusions, or hypotheses lack verified
> support, and what is the exact provenance of the ones that have it?

`provenance_audit` answers it by **joining the ledgers that already exist**. It
is strictly read-only: it creates no new source of truth, revives no old
entity graph, and writes only its own cache under `.dsh/provenance/<audit>/`.

## What it reads

| Source | What is joined | How |
|---|---|---|
| `review` | records, screening decisions, evidence quotes, extraction rows and field quotes, appraisal judgements, GRADE domain ratings and human overalls | `review-store.js` / `grade-store.js` read functions |
| `reporting_check` | item verdicts, verbatim quotes, and the manuscript snapshot hash | `reporting-store.js` read functions |
| `deep_review` | stored `review.json` claim–evidence map and flagged citation reports | `.dsh/deep-review/<key>/` |
| `notebook` | entries, `relatesTo`/`supersedes` links, and artifact paths | `.dsh/notebook/*.jsonl` |
| `analysis_run` | frozen plans, hypotheses, run manifests, hashed inputs/outputs | `.dsh/analysis/<slug>/` |
| `experiment_log` | runs, hashed artifacts, and links to papers, reviews, notebook entries, and runs | `.dsh/experiments/<slug>/` |
| `dataset_get` | download records, licenses, checksums, and file states | `.dsh/data/<slug>/manifest.jsonl` |
| `meta_analysis` | protocol, studies with their `record_id` provenance, pooled analyses, plots | `.dsh/meta/<slug>/` |
| Academic Harness | cited-clause sidecars: binding type, cited keys, passage file/quote/hashes, `unbound`/`bound`/`verified`/`stale` | `claims/*.yaml` next to `ah.yaml`, when present |
| PaperMemory | the `paper:` nodes every quote link to | only with `verify_quotes: true`, through `papermemory_quote_check` — never the SQLite file |

Two sources are reported as `unknown` with their reason rather than silently
dropped: `scientific_result` cards are returned to the session and not
persisted, and the `preregister` ledger (Phase 5A) has not shipped.

## Node and edge model

Every node id uses the [shared prefixes](../provenance.js): `paper:`, `quote:`,
`unit:`, `claim:`, `record:`, `run:`, `result:`, `review:`, `prereg:`, `export:`.
Ids are namespaced by ledger and slug — `claim:review/bcg/e0001`,
`quote:reporting/strobe/1a~quote`, `run:analysis/primary/run-…`,
`export:results.csv` — so the same file or paper referenced by three ledgers is
one node, which is exactly where cross-ledger impact becomes visible.

Each node also carries a **role**, and the role decides what the tool reports:

- `claim` — an assertion that needs support (evidence, an extraction row, an
  appraisal judgement, a GRADE domain rating, a checklist item, a notebook
  hypothesis, a plan hypothesis, a manuscript clause, a `deep_review` claim).
- `support` — the evidence itself: a quote, a file, a run, a pooled analysis.
- `container` — a record of something that is not a claim: a review, a
  screening decision, a notebook note, a dataset download, an experiment
  question, a manuscript.

`unsupported` walks only claims. Containers and support nodes appear in
`coverage` and `impact`, so nothing is double-counted as a defect.

## The seven states

| State | Recorded meaning | Never means |
|---|---|---|
| `supported` | An explicit stored link **plus** a verification or a recorded human judgement | "true", "good quality" |
| `no_link` | Nothing was linked: no quote, no paper, no binding | "false" |
| `not_checked` | Evidence was recorded and never verified | "unverified evidence" |
| `unverified` | A verification was attempted and did not confirm it | "the check failed to run" |
| `stale` | The source behind the evidence changed | "the claim was retracted" |
| `not_found` | A recorded link's far end does not exist | "unsupported" |
| `unknown` | The audit could not read that ledger at all | "unsupported" |

The rules that produce them are deliberately boring:

- Support is never inferred — not from co-occurrence, not from citation
  proximity, not from a model's reading. A `deep_review` engine verdict of
  `SUPPORTED` is stored as an `unverified` claim, because an LLM judgement is a
  reading, not a verification.
- A quote recorded with no PaperMemory paper is `no_link`, and a quote with a
  paper but no stored `quote_check` is `not_checked`. Only a stored
  `verified` status is `supported`.
- A human-signed judgement counts as evidence where the harness treats human
  decisions as evidence — a `human:` GRADE overall certainty is `supported`,
  an `ai:` one is `unverified`.
- A link is valid only if both ends exist in their owner ledger; a broken link
  is `not_found` naming the id that is missing.
- Staleness is computed from hashes the ledgers already store: a `reporting_check`
  manuscript snapshot, an `analysis_run` input, a `dataset_get` checksum, a
  `deep_review` content hash, an `ah` passage `raw_sha256` and quote text. When a
  source node goes `stale` or `not_found`, the claims that depend on it are
  marked `stale` too, keeping the state they had before in `previous_state`.
- Live re-verification is opt-in: `verify_quotes: true` re-runs
  `papermemory_quote_check` for every linked quote, and a quote that resolves
  against a different source snapshot becomes `stale`, with old and new hashes.

## Actions

| Action | What it returns |
|---|---|
| `index` | Builds or refreshes the index for the workspace and writes the cache. Optional `review`, `reporting`, `meta`, `analysis`, `experiment`, `dataset`, `deep_review` slugs narrow it, `manuscript` adds a workspace file as a source, `include_ah: false` skips the AH sidecars, `verify_quotes: true` re-checks quotes through PaperMemory. |
| `coverage` | Totals and per-ledger state counts, plus each source's status (`present`, `unknown`, `skipped`, `not_queried`, `queried`) with its reason. |
| `unsupported` | Claims lacking verified support, split into `no_link`, `not_checked`, `unverified`, `stale`, `not_found`; optional `state` filter and `limit`. |
| `stale` | Evidence whose source changed, with recorded and current hashes, location, and the state it held before. |
| `unverified` | Evidence with a verification attempt that did not confirm it — including appraisals, extractions, and dataset files whose checksum failed. |
| `impact` | The transitive dependents of a `paper:`, `quote:`, `record:`, `run:`, `result:`, or workspace path — what would need revisiting if it changed. |
| `export` | `markdown` (coverage, availability, unsupported, stale, unverified, warnings), `csv` (one row per node), `json` (the index), `graphml`, `mermaid`. |

Every non-`index` action reuses the cached index unless `refresh: true`, so a
session can query the same snapshot repeatedly; `index` (or `refresh`) after a
ledger change recomputes it.

```text
provenance_audit action=index audit=paper
provenance_audit action=unsupported audit=paper state=stale
provenance_audit action=impact audit=paper target=results.csv
provenance_audit action=export audit=paper format=markdown
```

## Read-only, enforced

`provenance-store.js` funnels every write through `assertAuditWrite`, which
resolves the target and refuses anything outside `.dsh/provenance/<audit>/`, and
the index is rewritten with an explicit `overwrite: true` because it is a cache,
not a record. Source ledgers are opened with their own read functions; nothing
here appends, mutates, or rewrites one. `scripts/test-provenance-audit.mjs`
hashes every file outside the cache before and after a full index, export, and
tool run and asserts that none of them changed, and asserts the refusal itself.

Workspace path rules still apply: `manuscript` and every artifact, input,
output, and bound-source path resolves through `resolveWorkspacePath`, so a
`..` or symlinked path is reported as `not_found` with "escapes the workspace"
rather than read.

## What an audit does not do

- It does not decide that a claim is true, that a review is complete, or that a
  manuscript is ready. It reports what is recorded.
- It does not fill gaps. A missing review, an unreadable AH project, or an absent
  PaperMemory library is `unknown` with its reason, never counted as unsupported.
- It does not recompute the science. Fact values, pooled estimates, and unit
  authorship belong to `ah`, `meta_analysis`, and `ah_provenance`.
- It does not export a database. GraphML and Mermaid are views of the index and
  contain only indexed nodes and edges.

Load the `provenance-audit` skill for the workflow, and see
[Reproducible analysis](ANALYSIS.md) and
[Reviews and synthesis](RESEARCH.md) for the ledgers it joins.
