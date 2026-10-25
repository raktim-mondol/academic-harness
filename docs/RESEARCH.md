# Reviews, hypotheses, and research records

This page covers the local ledgers that keep work auditable past the context window: systematic reviews, hypothesis tournaments, clinical and regulatory records, and dataset/venue/funder policy.

## Systematic reviews

`review` is a preset-only native tool — local, no key, no database — that keeps a systematic or scoping review auditable. State lives under `<cwd>/.dsh/review/<slug>/` as append-only JSONL event logs plus a write-once `protocol.json`; the current state is derived from the log, so concurrent subagent writes cannot corrupt it and overrides keep their history.

![Review ledger](assets/diagrams/review-ledger.svg)

| Action | What it does |
|---|---|
| `start` | Question, databases, inclusion/exclusion criteria, date range. Refuses to overwrite an existing review unless `resume: true`. |
| `add` | Records from a search tool's result array or a workspace JSON/JSONL file; deduplicates by DOI, PMID, arXiv ID, then normalized title+year, and logs every query in `search_log.jsonl`. |
| `screen` | `title_abstract` / `full_text` × `include` / `exclude` / `maybe`. A full-text decision requires a prior title/abstract include; exclude and maybe require a reason; re-screening requires `override: true`. |
| `evidence` | Only after a full-text include; claim, verbatim quote, and location. The ledger stores the quote but does not verify it — PaperMemory `quote_check`/`trace` remains the verifier. |
| `status` | Records, query counts, PRISMA-style stage counts, exclusion reasons, includes missing evidence. |
| `export` | `markdown` report skeleton, `csv` evidence table, or `json` full ledger under `exports/`; refuses to overwrite without `overwrite: true`. |

The tool never makes inclusion decisions — discovery stays in the search tools and every screening decision and reason comes from the user or the stated criteria. The `systematic-review-ledger` skill documents the full workflow.

## Hypothesis tournaments

`coscientist` and `coscientist_rank` are preset-only native tools — local state, no key, no database, no new dependency — for a ranked hypothesis shortlist that has to survive past this context window.

State lives under `<cwd>/.dsh/coscientist/<slug>/` as append-only `events.jsonl` / `matches.jsonl` logs plus a write-once `protocol.json`; the leaderboard is derived from the log, so a resumed session sees exactly the ratings it left behind, and concurrent subagent writes cannot corrupt it. It has the same shape as [Systematic reviews](#systematic-reviews), and the shared `.lock` implementation comes from there.

![Hypothesis tournament](assets/diagrams/tournament-loop.svg)

### `coscientist`

| Action | What it does |
|---|---|
| `start` | Goal, constraints, rubric, `max_hypotheses`, `step_budget`, `max_matches`, `seed`; defaults **5 hypotheses / 36 steps** — a ranked shortlist sized so two losses still leave three ideas competing, and a budget that lets the Elo plateau rule actually fire rather than ending on the cap. `max_matches` enforces an explicit user stop bound such as one match per pair. |
| `add` | Add a hypothesis; a near-duplicate is discarded with its similarity score, and a cap-reached add is discarded. |
| `review` | Five stages: `initial` → `full` → `deep_verification` → `simulation` → `observation`. Stages refuse to run out of order; a `fail` at `initial`/`full` rejects the hypothesis. |
| `safety` | Record a dual-use classification; the tool withholds it when the severity meets the threshold. |
| `status` | Ranked leaderboard. |
| `next` | Which task the scheduling policy samples now; it never samples a task the ledger cannot run and stops at the match cap. |
| `set_status` | Reject or release a withholding, always with a reason. |
| `lineage` | Hypothesis ancestry. |
| `design_protocol` | A protocol for testing the leading hypothesis. |
| `synthesize` | Combine compatible hypotheses. |
| `export` | `markdown` / `json` / `mermaid`. |
| `graph` | Mermaid diagram of lineage, similarity, and claim→paper support, written with `export format: mermaid` and rasterised by [`mermaid_render`](WRITING.md#mermaid-diagrams). |
| `priors` | Prior feedback, rejections, and withholdings from **other tournaments in this workspace**, ranked against the goal — read from their own logs, so nothing is duplicated and nothing can disagree with a ledger. |
| `embed` | Opt-in Gemini embeddings that switch the duplicate gate and similarity from lexical overlap to cosine, at upstream's 0.92 / 0.70 thresholds. `embed` is the only tournament call that needs a key or the network, and it reuses `GEMINI_API_KEY` from [Image generation](WRITING.md#image-generation). |

`zvec-grep` cannot supply embeddings: `zg query --vector` embeds a search query and never returns a vector. That is why `coscientist embed` uses the Gemini endpoint the plugin already uses for images.

### `coscientist_rank`

| Action | What it does |
|---|---|
| `propose` | A pair that has never met first, then the most uncertain hypothesis against a similar one. Reports `pair_matches_played` and `unplayed_pairs_remaining`. |
| `record` | A judged pair, both presentation orders, judged sequentially with the same brief. |
| `compare` | Compare two hypotheses. |
| `similarity` | Report the measure behind a similarity score. |
| `feedback` | An experimental result as a reward. |
| `history` | Match history. |

### Ratings and decisions

Ratings are Glicko-2 (rating + RD + volatility), seeded from review scores and tightened by matches, with a zero-sum update per pair. Citation integrity applies a soft penalty rather than a veto, and an experimental result moves a rating only through `coscientist_rank feedback`.

Similarity always reports which measure produced it: a 0.70 lexical score and a 0.70 cosine are not the same claim, and a partially embedded pool is called **mixed** rather than blended.

The tools decide what the code decides:

- a near-duplicate `add` is discarded with its similarity score,
- a cap-reached `add` is discarded,
- review stages refuse to run out of order,
- a `fail` at `initial`/`full` rejects the hypothesis,
- only `active` hypotheses may compete,
- a verdict that follows the presentation order counts as a draw,
- `next` reports when to stop: step budget, no pair left to play, Elo plateau, or cap ranked.

Neither tool calls a model — the session does the reasoning, normally through `subagent`, so the cost of a tournament is debate matches.

Hypotheses generated this way recombine published knowledge: they are not results, an unverified citation stays `[VERIFY]`, and a withheld dual-use idea stays withheld until the user releases it by name. The `co-scientist-tournament` skill carries the loop, the subagent briefs, and the budget defaults. For one round of ideation, use `generating-scientific-hypotheses` instead (see [Skills](SKILLS.md)).

Defaults and restart behavior for tournament settings are in [Configuration](CONFIGURATION.md#hypothesis-tournaments).

## Clinical and regulatory evidence

Two preset-only native tools cover records that are not journal literature:

- `clinicaltrials` — ClinicalTrials.gov API v2, free and keyless. `search` filters by `query` (free text), `condition`, `intervention`, `phase`, `status`, and `study_type`, returns normalized trials (NCT id, status, phase, enrollment, sponsor, conditions, interventions, endpoints, locations, `has_results`) and a `next_page_token`. `get` reads one NCT id; `include_results: true` adds posted outcome measures and adverse-event counts.
- `openfda` — openFDA, free and keyless with a low shared daily quota (`OPENFDA_API_KEY` raises it; a 429 means the quota is exhausted). One `search` action over an allowlisted endpoint: `drug/event`, `drug/enforcement`, `device/event`, `device/510k`, `drug/label`, or `food/event`. The openFDA search expression is passed through unchanged, records are compacted per endpoint, and every response carries the source query URL. A no-match search is an empty result, not an error.

Both are informational only — no medical or legal advice — and neither is a literature search: cite NCT ids/report numbers as registry evidence, not as peer-reviewed findings.

## Datasets and policy

- **`dataset_search`** — DataCite dataset discovery (`query`, `repository`, `year`, cursor paging) with DOI, title, creators, publisher, version, license, and landing URL. `get` reads one DOI; `files` lists file names/sizes/download URLs for Zenodo and Figshare DOIs and returns the landing URL for other repositories. Free, keyless, and no downloads. Optional `ZENODO_API_KEY`, `FIGSHARE_API_KEY`, and `DATACITE_API_KEY` are sent as auth headers when set (public data works without them).
- **`journal_policy`** — venue policy from DOAJ (listing, APC, license, OA start year; keyless) plus Sherpa Romeo (preprint/postprint/published permissions, embargo, conditions; needs `SHERPA_ROMERO_API_KEY`). Without the key the result is DOAJ-only with an explicit `key_not_set` note. An unknown journal is `not_found`, an ambiguous title returns candidate ISSNs, and a failed lookup is `unknown` — never reported as "not listed".
- **`funder_policy`** — OpenAlex funder identity (canonical name, alternate titles, country, award/works counts; keyless) plus Sherpa Juliet per-version OA policy (embargo, license, conditions) when `SHERPA_ROMERO_API_KEY` is set. Without the key it returns the identity and `key_not_set`; it never guesses a funder's policy.

These are compliance/discovery aids: cite dataset DOIs, never infer a license or APC, and treat policy output as compliance information rather than legal advice.

## Related

- [Search](SEARCH.md) — discovery and publication status.
- [Writing](WRITING.md) — the writing oracle, citation, and figures.
- [Optional tools](OPTIONAL-TOOLS.md) — grants, patents, OpenReview, author identity, statistical and figure audits.
- [Configuration](CONFIGURATION.md) — tournament and policy keys.
