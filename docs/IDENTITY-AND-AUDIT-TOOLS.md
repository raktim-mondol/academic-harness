# Identity, funding, and audit tools

Narrow, advisory tools on the Academic Harness preset: researcher and institution identity, peer-review records, funding and patent discovery, local audits, and the tournament verifier. Each reports what it found and never turns that into a verdict. Tools with an external requirement (`pdf_references` needs `GROBID_BASE_URL`; `patent_search` needs `PATENTSVIEW_API_KEY`) say so in their own error text.

## Tools

### `author_lookup`

ORCID author search and single-ORCID records (name, works count, employment with ROR ids) plus ROR institution search/lookup (name, aliases, country, website).

- `ORCID_TOKEN` is optional and only raises limits; ROR is keyless.
- Ambiguous names return candidates — identities are never merged automatically.

### `openreview`

OpenReview API v2 submission search, a forum's reviews/decision, and venue metadata.

- Read-only; fields a venue does not publish stay absent.
- OpenReview may answer with an HTTP 403 browser-verification challenge, in which case open the forum URL with `agent-browser`.

### `pdf_references`

GROBID bibliography extraction from a workspace PDF.

- Requires `GROBID_BASE_URL` (for example `http://127.0.0.1:8070`); the tool is not registered without it, and without a reachable GROBID service the tool reports the failure and never generates references itself.
- `resolve: true` checks each extracted DOI's title against Crossref.

### `coscientist_verify`

Citation integrity and claim support for the [hypothesis tournament](RESEARCH.md#hypothesis-tournaments).

- `citations` checks every work a hypothesis cites against Crossref (a DOI that is not registered is `fabricated`; a title nobody matches, or any registry error, is only `unverified` — never reported as verified) and records the counts that drive the rating penalty.
- `check_integrity: true` adds retraction status via `integrity_check`.
- `claims` records the supports/contradicts/unaddressed judgements a subagent reached, so the ledger holds them rather than the transcript.
- `CROSSREF_MAILTO` moves it into the polite pool; it shares one Crossref limiter with `crossref_lookup`.

### `stat_audit`

Recomputes p-values from reported t/F/χ²/z/r statistics and df, flags `p = 0` and incompatible statistic/p pairs, and optionally runs GRIM on reported means.

- Requires SciPy in the helper environment.
- Candidate inconsistencies only, never misconduct. GRIMMER is not implemented.

### `figure_audit`

Local inventory of figure files (dimensions, DPI, mode, format), low-DPI and missing-DPI flags, and dHash-based near-duplicate groups.

- Advisory; it does not detect manipulation.

#### `figure_audit action=handoff`

A read-only figure-to-result report. It joins one figure file (and an optional caption) to the generating records you **declare**, using only the existing analysis and experiment ledgers. It writes nothing, calls no model, and never reads pixels.

```
figure_audit action=handoff figure=out/fig2.png reference="Figure 2"
  caption="Accuracy was 0.81 (n = 120)."
  sources=[{kind: "analysis_run", slug: "main", run_id: "a0003", path: "out/metrics.json"},
           {kind: "experiment_run", slug: "bench", run_id: "x0007"}]
  values=[{path: "out/metrics.json", format: "json", field: "metrics.acc"}]
```

| Part | What it reports |
|---|---|
| `figure` | present / missing / `unsafe_path` (workspace confinement, symlinks included), current `sha256`, byte count, and `format_state` `supported` or `unsupported` (an unsupported format is hashed but not interpreted) |
| `sources[]` | every declared link is kept, in order. `link_state` is `resolved`, `unresolved` (no such run), or `not_checked` (bad declaration). A resolved link shows the run's recorded `execution.status`, whether the figure is listed in that run's record and whether its bytes are `current`, `stale`, `not_hashed`, or `not_recorded`, and any compliance exclusion (`excluded_by_compliance` is `null` and a gap is raised when the compliance state is unknown, for example an unresolved analysis link) |
| `values[]` | numbers read from a machine-readable file you name, with an explicit `format` (`json` dotted `field`, or `csv`/`tsv` header `column` plus zero-based `row`; a UTF-8 BOM is ignored). The located value must be a real number or a plain decimal literal; arrays, blank text, hex strings, booleans, and `null` are `not_checked`. A value is read **only** from a declared source `path` that **every** source naming it confirms by hash; one stale or unhashed record withholds the file, whatever the order |
| `caption` | advisory only: plain numeric tokens are compared with the extracted values (`matched`, `unmatched`, `ambiguous`). A stated decimal or a percentage matches at its own precision (`0.81`, `81%`); a plain integer is a count and must equal the value. Figure and panel labels, ranges (`3-5`), scientific notation, and names containing a number (`ResNet-50`) are skipped, and `parsed_scope` lists what is not interpreted |
| `vision_review` | `not_requested` unless you pass `{summary, reviewer?}`. The top-level agent cannot read images, so delegate the picture to `subagent_vision` and pass its summary here. It is stored and shown as a `model_interpretation` with `verified: false`, inside the untrusted fence. It never verifies data, closes a gap, or changes any state above |
| `gaps` | everything unconfirmed, in plain words |

What the states do and do not mean:

- A recorded relation is not proof that the figure depicts that data, and a matching hash proves byte identity, not correctness.
- `execution.status: succeeded` for an `analysis_run` is an exit code of 0. For an `experiment_run` it comes only from linked `analysis_run` records (`experiment_log` does not execute anything), so a run with no link reports `not_recorded`.
- If a run lists the figure with matching bytes but those bytes existed before the run started (`written_by_run: false`), the report adds a gap: the run cannot be credited with producing it.
- A figure with no declared source is reported as unlinked, not as matched. Missing data, stale bytes, unsupported formats, and unparsed captions stay `not_checked`, `stale`, or `unknown`.

### `prior_art`

A prior-art triage report for **one** claim. The agent runs the searches (`literature_search`, source adapters, `paper_resolve`, `paper_get`) and records what happened; `prior_art` does not search and does not judge meaning. It keeps four things apart:

- **What was searched:** each search's provider, query, `status` (required: `ok`, `partial`, `failed`, `not_run`), access time, limit, result count, and error. A missing or malformed status is `invalid` and never counted as success. Hitting a result cap, a single provider, a missing access time, and failures are listed under `coverage_limits`.
- **What each candidate was compared on:** `full_text`, `abstract_only`, `metadata_only`, `full_text_not_checked` (could not be read), or `not_checked` (a level was declared but no text supplied).
- **Your claimed overlap** (`none`, `partial`, `close`, `unknown`) and distinction, which stay assertions. `support` says whether a claimed overlap has a quotation verified against the text you supplied (`supported_by_verified_quote`), has quotations that are not verbatim (`quotes_not_verified`), or none (`no_quote`).
- **Quotations:** whitespace-collapsed exact match against the text supplied for that candidate, so a paraphrase, reordering, changed case or punctuation, or a line-break hyphen is `not_verbatim`. The tool never says PaperMemory ran (`papermemory: not_checked_by_this_tool`); use `quote_check` for ingested papers.

Quotation spans must be verbatim **and** at least 4 words and 20 characters (`verbatim_but_too_short` otherwise), because "the" is in every abstract and proves nothing about overlap. A lexical token-overlap reading (the same coverage idea `coscientist_verify` uses, over the title and the abstract if you supply one, with `lexical_basis` saying which) cross-checks your judgement. It raises flags such as `lexical_overlap_high_but_claimed_none_or_unknown` and `claimed_close_but_lexical_overlap_low` for a human to look at; it is not a verdict.

`statement` is one of `not_checked` (no successful search), `overlap_candidates`, `inconclusive` (a candidate is undecided, rests on metadata only, was contradicted by the lexical cross-check while marked `none`, or could not be compared; or searches returned results, or did not say how many, and no candidate was recorded as reviewed), or `no_close_overlap_found_in_searched_material`, whose text always adds that this is not evidence of novelty. Input is bounded to 20 searches, 50 candidates, 10 quotations per candidate, and 200,000 characters of text per candidate. Retrieved text is fenced as untrusted when rendered. It is read-only unless `write: true` with a `slug`, which saves the report (never the candidate text) under `.dsh/prior-art/<slug>/`. The `report_digest` covers the whole report except the clock, so a corrected quotation or distinction is a different report with its own snapshot. Identifiers and provider labels are validated before they reach the unfenced part of the rendering, and search error text is rendered only inside the fence.

**Evaluation.** `scripts/fixtures/prior-art-eval.json` is a regression suite, not a validation: a small synthetic set labelled by the implementer, because independent human labelling is not available (15 cases and 11 labelled quotations) covering clear and partial overlap, different methods, a misleading abstract, inaccessible full text, retrieval failure, no candidate, results with no reviewed candidate, an unread record asserted as "none", paraphrased and trivially short quotations, a capped search, and a mistaken claimed overlap. Thresholds were fixed before running: every statement, labelled candidate field, and quotation must agree, with zero novelty claims. The rules are deterministic, so a disagreement is a defect. The counts show the rules keep behaving as documented; they say nothing about accuracy on real retrieval output or against human judgement.

**Live smoke evaluation on real search results** (2026-11-08; `npm run eval:prior-art-live`, needs the network, not part of `npm test`). Eight claims were searched live on OpenAlex, arXiv, and Europe PMC; the 53 retrieved candidates that had abstracts were labelled `none`, `partial`, or `close` by the implementer (an AI assistant) from the title and abstract only, with a note each, in `scripts/fixtures/prior-art-live-labels.json`. No independent human labelled them. Results, as counts:

| Check | Result |
|---|---|
| Quotations taken from real abstracts and verified | 37 of 37 |
| Median lexical cross-check score by label | none 0.455, partial 0.636, close 0.818 (close never below 0.5) |
| Lexical score at least 0.6 vs label partial or close | 27 true positive, 3 false positive, 10 false negative, 13 true negative |
| Cross-check flags raised | 3 `lexical_overlap_high_but_claimed_none_or_unknown`, 0 `claimed_close_but_lexical_overlap_low` |
| Report statements over 8 claims | 7 `overlap_candidates`, 1 `no_close_overlap_found_in_searched_material` |

How far to trust this: the candidates were retrieved because they matched the query lexically, so a lexical cross-check separating them is partly built in; the labels are one reader's judgement; the set is eight claims. It shows the tool runs on real, messy text and that its cross-check is informative but not decisive. It is not a measurement of accuracy. One claim chosen as obscure (subset-first agent benchmarking) turned out to have a close paper, so "no close overlap" on a topic you believe is empty deserves suspicion.

The run also exposed that OpenAlex results arrived with **no abstract** through `literature_search`, because the default `select` omitted `abstract_inverted_index`. That is fixed; before the fix those candidates could only be compared on metadata.

### `repo_audit`

Static reproducibility checklist (README, LICENSE, environment file, tests, CI, entry points, data availability, release tag) for a local path or an https `repo_url` cloned into a temp dir.

- Code is not executed unless `run_tests: true`.
- `GITHUB_TOKEN` (env only) is optional for API metadata.
- `action: "probe"` is the cheap precursor: it looks for a runnable benchmark entrypoint (package/pyproject scripts, Makefile targets, top-level run/eval/benchmark scripts, Docker CMD, and README commands) and reports `runnable: yes|no|unknown`, `has_benchmark_entrypoint`, and `offers_re_execution: yes|maybe|no`. It executes nothing; a `no` means `analysis_run action=expect`/`verify_scores` is not offered yet.
- `action: "align"` maps method-section anchors to verified `file:line`: pass `anchors: [{id?, kind: equation|symbol|constant|default|other, text|pattern, file?, claim?}]`; each anchor is `verified` (exactly one match), `ambiguous` (several, so narrow it), `missing`, or `not_checked` (invalid pattern, a file that was not scanned, or a pattern that exceeded its time budget). Each verified match yields a `bind_calls` entry `{claim, source, lines}` for `ah_claims_bind`. It writes nothing and never edits the manuscript; a match is a location, not a semantic proof that the code implements the method. Scans are confined to the repository, skip symlinks and oversized files (reported as `skipped_files`), and run caller-supplied patterns in a vm with a hard timeout so a catastrophic regex is reported, not hung.

### `grant_search`

Funded-project and opportunity discovery:

- NIH RePORTER (awards, amounts, dates),
- NSF Award Search (awards),
- Grants.gov (posted/forecast opportunities).

Filters by query, PI, organization, and fiscal year; `get` reads one award/opportunity by id. Informational only, not grant-writing advice.

### `patent_search`

PatentsView prior-art/assignee/inventor lookup over US patents with grant/priority dates and optional abstracts.

- **Requires `PATENTSVIEW_API_KEY` on every call**; without it the call returns a clear error.
- No legal-status or freedom-to-operate conclusions.

## Preprints in `literature_search`

`literature_search` also has a `preprints` source (Europe PMC `SRC:PPR`), chosen automatically for biomedical queries that mention preprints.

## Related

- [Configuration](CONFIGURATION.md) — `GROBID_BASE_URL`, `GITHUB_TOKEN`, `PATENTSVIEW_API_KEY`, `ORCID_TOKEN`.
- [Research](RESEARCH.md) — tournaments and clinical/regulatory records.
- [Skills](SKILLS.md) — the `agent-browser` skill used by `openreview`.
