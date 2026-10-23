# Non-Search Academic Tools — gap analysis and implementation plan

Status: **Phases 0–8 implemented and released as v0.18.0** (2026-10-24) · previous baseline **v0.17.1**
Phase 1 note: the `citation` tool shipped; the planned **Zotero bridge was
removed** before release (decision — the local API ships off by default and
the read-only bridge added little over `paper_download` + PaperMemory). See §6.2.
Phase 2 note: `integrity_check` takes `doi` **or** `title` only — a
title is resolved through Crossref and an inexact match returns `ambiguous`
with candidates rather than picking one, so `ids[]` is deferred until a cross
registry is actually needed. See §7.4.
Sibling plan: `docs/SEARCH-PROVIDERS-PLAN.md` (Phases 0–5 implemented)
Source docs: `academic-harness_docs/Search Providers API Reference.md`,
`academic-harness_docs/Claude Code Mods  Complete Tutorial + Research Harness.md`,
`academic-harness_docs/Jev Delegation Routing for the Academic Research Harness.md`,
`README.md`, `docs/ACADEMIC-HARNESS-ENGINE.md`

## 1. Why

The search layer is complete as of v0.17.1: native REST tools for OpenAlex,
Semantic Scholar, Crossref, arXiv, PubMed/Europe PMC, CORE, Elicit,
FutureHouse, Consensus, Parallel, Brave, Tavily, Exa, Perplexity, and Jina,
plus three MCP connectors, `literature_search`, `paper_resolve`, and
`paper_download`. Adding another search provider now has low marginal value.

The remaining gaps are in the rest of the academic workflow:

1. **References and citation** — no deterministic BibTeX/RIS/CSL formatting
   and no citation-style validation; `citation-management` exists as a skill
   only, so the agent must improvise through Bash. A native `citation` tool
   closes this. (A first-class **Zotero bridge was proposed and then dropped**
   before release — see §6.2 — because Zotero's local API ships off by
   default and a read-only bridge added little over `paper_download` +
   PaperMemory.)
2. **Paper integrity** — retraction/correction checks are only available
   through scite, which requires a paid key and is not mounted otherwise.
   Crossref and OpenAlex carry the data for a free fallback.
3. **Systematic review** — the tutorial's `research-harness` mod implements
   protocol, search log, two-stage screening, evidence extraction, DOI
   checks, and PRISMA counts. The harness has the writing engine (`ah_*`) and
   PaperMemory, but no screening funnel.
4. **Free domain registries** — ClinicalTrials.gov, openFDA, DataCite,
   DOAJ, ORCID, ROR, and OpenReview cover trials, regulatory evidence,
   datasets, journal policy, identities, and peer review at no cost. None is
   a search-provider duplicate.
5. **Local audits** — statistical consistency, figure duplication/quality,
   repository reproducibility, and structured reference extraction from
   arbitrary PDFs are all local checks the model should not approximate.

This plan adds a small number of action-multiplexed native tools in phases,
starting with the layers that unblock daily writing and citation work.

## 2. Current state

| Layer | Implemented | Where |
|---|---|---|
| Literature/web search | 14+ native tools, 3 MCP connectors | see `docs/SEARCH-PROVIDERS-PLAN.md` |
| Paper storage and claims | PaperMemory (14 tools) | `papermemory.js` |
| PDF → text | `pdf_to_markdown` | `pdf-to-markdown.js` |
| PDF acquisition | `paper_download` (OA only) | `paper-download.js` |
| Writing engine | `ah_*` facts, claims, sources, review, gate | `academic-harness.js` |
| LaTeX | `latex_compile` | `latex-compile.js` |
| Scientific files | `sci_inspect` (chemistry, structures, arrays, imaging, AnnData) | `sci-inspect.js` |
| Figures | `image_generate` + figure skills | `image-generate.js` |
| Compute | `modal_run`, `runpod_run` | `modal-run.js`, `runpod-run.js` |
| Lab log / result cards | `notebook`, `scientific_result` | `notebook.js`, `scientific-result.js` |
| Workspace search | `zvec_grep`, native `grep`/`glob` | `zvec-grep.js`, preset |
| Skills-only capabilities | `clinicaltrials`, `citation-management`, `patent-landscape`, `research-grants`, `statistical-*` | `skills/` |

Known structural gaps:

1. No native reference-library or citation-formatting tool.
2. No free retraction/correction check; `scite` is the only path and is gated.
3. No systematic-review ledger or PRISMA state; `notebook` is too generic and
   the `ah_*` engine tracks writing units, not screening decisions.
4. No free trial/regulatory/dataset/journal-policy/identity/peer-review tools.
5. No local statistical, figure, or repository audit; those are delegated to
   skills and ad-hoc scripts.
6. Several API-backed capabilities exist only as skills, so credentials,
   rate limits, and structured output are not enforced by the harness.

## 3. Design principles

These extend the conventions in `docs/SEARCH-PROVIDERS-PLAN.md` §4 and the
tool-routing constraints in the Jev delegation doc.

1. **No new standing MCP mounts by default.** Every new capability is a
   native tool or a skill + CLI. MCP schemas inflate the system prompt; the
   existing `paper_mcp` escape hatch remains for project-specific servers.
2. **One module = one tool; one tool = one domain.** Use an `action`
   parameter for related operations (`notebook`, `paper_mcp`,
   `research_template`, and `zvec_index` already do this). This keeps the
   prompt schema budget under control.
3. **Default surface is deliberately small.** Target at most **eight** new
   tools in the base prompt across Phases 1–5. Optional tools (Phases 6–8)
   register only when enabled by a key or an explicit env flag.
4. **Reuse existing infrastructure.** All HTTP goes through
   `search-http.js` (`getLimiter`, `fetchJson`, `fetchText`,
   `searchUserAgent`). Paper records use the `search-normalize.js`
   `NormalizedPaper` shape. PDF ingest uses `ingestDownloadedPaper()` from
   `papermemory-cli.js`. Citation parsing uses one pure-JS library and one
   fixture suite.
5. **No second source of truth.** PaperMemory stays the paper/claim store;
   the `ah_*` engine stays the writing ledger; the systematic-review ledger
   is its own append-only event store, exportable into `ah_source` /
   `ah_claims` later. The citation tool does not persist papers.
6. **Machine-first, no scraping.** Use official APIs where they exist. Where
   there is no API (PubPeer, publisher submission systems, ResearchGate),
   return a URL and let the user/`agent-browser` open it rather than
   building a brittle scraper.
7. **Integrity results are evidence, not verdicts.** Report what a registry
   says and when it was checked. Never report "clean" when a lookup failed;
   an unavailable source is `unknown`.
8. **Local audits are advisory.** `stat_audit`, `figure_audit`, and
   `repo_audit` surface candidates for human review, never misconduct
   conclusions.
9. **BYO infrastructure for heavy services.** GROBID and any local OCR/stat
   runtime are opt-in base URLs/helpers, not default preset dependencies.
10. **Keys are per call.** Credentials resolve through `resolveEnv()` so a
    Settings change applies on the next call; only mount-time decisions
    (whether an optional tool registers) need a `dsh` restart.
11. **No legal or medical advice.** Patent, grant, regulatory, and journal
   policy results are informational; the tool descriptions say so.

## 4. Tool map

| Tool | Phase | Mode | Key | Primary source | Purpose |
|---|---|---|---|---|---|
| `citation` | 1 | local | none | citation-js / Crossref content negotiation | Format, export, and validate BibTeX/RIS/CSL; DOI → BibTeX |
| ~~`zotero`~~ | 1 | — | — | — | **Dropped before release** (local API off by default; read-only bridge adds little over `paper_download` + PaperMemory) |
| `integrity_check` | 2 | REST | none (`OPENALEX_API_KEY` optional) | Crossref + OpenAlex | Retraction/correction/concern status (`doi` or `title`) |
| `review` | 3 | local | none | workspace ledger | Systematic/scoping review protocol, screening, evidence, PRISMA |
| `clinicaltrials` | 4 | REST | none | ClinicalTrials.gov API v2 | Trial search and NCT lookup |
| `openfda` | 4 | REST | `OPENFDA_API_KEY` optional | openFDA | Drug/device adverse events, recalls, 510(k) |
| `dataset_search` | 5 | REST | none | DataCite (+ Zenodo file listing) | Find dataset DOIs and licenses |
| `journal_policy` | 5 | REST | `SHERPA_ROMERO_API_KEY` (policy half) | Sherpa Romeo + DOAJ | OA policy, self-archiving, APC/listing |
| `author_lookup` | 6 (optional) | REST | `ORCID_TOKEN` optional | ORCID + ROR | Author/institution identity resolution |
| `openreview` | 6 (optional) | REST | none | OpenReview API v2 | Submissions, reviews, decisions |
| `pdf_references` | 7 (optional) | BYO service | `GROBID_BASE_URL` | GROBID | Structured bibliography extraction from a PDF |
| `stat_audit` | 7 (optional) | local | none | Python helper | p-value/statistic consistency, GRIM/GRIMMER |
| `figure_audit` | 7 (optional) | local | none | Python helper | DPI/format/duplicate-panel checks |
| `repo_audit` | 7 (optional) | local | GitHub token optional | git + GitHub API | Reproducibility metadata audit |
| `grant_search` | 8 (gated) | REST | none | NIH RePORTER, NSF, Grants.gov | Funded-project discovery |
| `patent_search` | 8 (gated) | REST | `PATENTSVIEW_API_KEY` | PatentsView | Prior-art/assignee lookup |

Non-tool extensions:

- `literature_search` and `pubmed_search`: add explicit Europe PMC preprint
  routing (`SRC:PPR`) for bioRxiv/medRxiv-style queries. No new tool or API.
- `paper_download`: no change.
- `notebook`: no change; the review ledger is separate and exportable.
- `ah_*`: no change; a later optional exporter can register review evidence
  into `ah_source`/`ah_claims`.

## 5. Phase 0 — shared infrastructure

Prerequisite for Phases 1–5. No user-visible tool.

### 5.1 `citation-format.js`

Pure functions, no network:

```js
export function parseBibtex(text)              // -> CSL-JSON records
export function parseRis(text)                 // -> CSL-JSON records
export function normalizeCsl(records)          // shape + required-field report
export function formatBibliography(records, { style, locale })  // -> string
export function toBibtex(records)              // -> string
export function toRis(records)                 // -> string
export function validateRecords(records)       // -> { errors, warnings, duplicates }
```

Library decision: adopt `citation-js` plus its BibTeX, RIS, and CSL plugins
(pure JS, MIT, no native build). It supplies CSL styles and locales so the
harness does not hand-roll APA/IEEE/Vancouver formatting. If the dependency
policy rejects it, reduce Phase 1 to BibTeX/RIS/CSL-JSON import-export plus
a fixed APA-like formatter, and defer arbitrary CSL styles.

Do not add a `pandoc` dependency. If `pandoc` is already on `PATH`, the
`citation` tool may use it as an optional renderer for styles citation-js
does not cover; that is an enhancement, not a requirement.

### 5.2 `review-store.js`

Pure filesystem store used by `review` and its tests:

- Layout: `<cwd>/.dsh/review/<slug>/`.
- Files: `protocol.json`, `records.jsonl`, `screening.jsonl`,
  `search_log.jsonl`, `evidence.jsonl`, `exports/`.
- `screening.jsonl` is an **event log**, not a mutable state file. The current
  state of a record is derived from the last event per `(record_id, stage)`.
  This makes concurrent subagent writes safe and keeps an audit trail.
- `records.jsonl` is append-only. `add` assigns stable ids (`r0001`, …)
  under a short-lived lock directory (`.lock`) and deduplicates by DOI →
  arXiv/PMID → normalized title+year.
- `protocol.json` is write-once. `start` refuses to overwrite an existing
  review unless `resume: true`.
- Exported functions:

```js
export function reviewDir(cwd, slug)
export function startReview({ cwd, slug, protocol })
export function addRecords({ cwd, slug, records, source, query })
export function screenRecord({ cwd, slug, id, stage, decision, reason })
export function addEvidence({ cwd, slug, id, claim, quote, location })
export function deriveStatus({ cwd, slug })
export function exportReview({ cwd, slug, format })
```

- No database, no server, no background process.

### 5.3 Settings and env keys

Add to `KEY_FIELDS` in `settings-keys.js`:

| Key | Required for | Notes |
|---|---|---|
| `SHERPA_ROMERO_API_KEY` | `journal_policy` policy half | Free registration |
| `OPENFDA_API_KEY` | Higher openFDA limits | Optional; keyless works |
| `DATACITE_API_KEY` | Bearer auth for gateways/mirrors | Optional; public reads are keyless |
| `ZENODO_API_KEY` | Zenodo file access beyond public records | Optional personal access token |
| `FIGSHARE_API_KEY` | Figshare file access beyond public records | Optional personal token |
| `ORCID_TOKEN` | ORCID rate relief | Optional; public reads work without it |
| `PATENTSVIEW_API_KEY` | `patent_search` | Required; free key |

Env-only (not Settings): `GROBID_BASE_URL`, `AH_ENABLE_OPTIONAL_TOOLS`.
These are infrastructure/feature switches, like `ZVEC_GREP_CLI`, not secrets.

### 5.4 Limiter budgets

Register with `getLimiter(name, { minIntervalMs })` at the call site, matching
current search-module style:

| Source | Budget |
|---|---|
| Crossref (reuse) | 100 ms single DOI polite / 200 ms public |
| OpenAlex (reuse) | 100 ms keyed / 34 ms keyless |
| ClinicalTrials.gov | 500 ms |
| openFDA | 250 ms keyed / 1000 ms keyless |
| DataCite | 500 ms |
| Sherpa Romeo | 1000 ms |
| DOAJ | 500 ms |
| ORCID | 500 ms |
| ROR | 500 ms |
| OpenReview | 1000 ms |
| PatentsView | 1000 ms |

### 5.5 Phase 0 acceptance

- `node scripts/test-citation-format.mjs` and
  `node scripts/test-review-store.mjs` pass without network access.
- `settings-keys.js` retains the existing keys and adds the new ones without
  changing resolution order (`process.env` → Settings → default).
- No new MCP rows and no `index.js` changes.

## 6. Phase 1 — reference and citation layer

This is the highest-value phase: it closes the loop between the user's real
library, the manuscript, and PaperMemory.

### 6.1 `citation.js` — `citation`

Actions:

| Action | Input | Output |
|---|---|---|
| `format` | `records[]` (CSL-JSON) or `text` (BibTeX/RIS) | Bibliography in `style`; optional in-text form |
| `bibtex` | `doi[]` or `records[]` | BibTeX text or `.bib` at `output_path` |
| `ris` | `doi[]` or `records[]` | RIS text or `.ris` at `output_path` |
| `validate` | `text` or `path` | Errors, warnings, duplicate keys/DOIs, missing fields |

Parameters: `action`, `records`, `text`, `path`, `doi[]`, `style`
(`apa`, `ieee`, `vancouver`, `chicago-author-date`, `harvard1`, `mla`;
default `apa`), `locale` (default `en-US`), `output_path`,
`check_dois` (default false).

Behavior:

- `bibtex`/`ris` with a DOI uses Crossref content negotiation
  (`/works/{doi}/transform/application/x-bibtex`) through `fetchText` and the
  Crossref limiter, with `mailto` from `CROSSREF_MAILTO` /
  `UNPAYWALL_EMAIL`. No DOI → no network.
- `validate` never rewrites the file. `check_dois: true` adds a Crossref
  identity lookup per DOI and reports mismatched titles as warnings.
- Output paths resolve through `resolveWorkspacePath()` from
  `paper-download.js`; no absolute paths outside the workspace.
- Citation keys are deterministic: first author surname + year + short title
  slug, de-duplicated with `a`, `b`, … suffixes.

Why one tool: formatting, export, and validation are the same record model
and share parsing code; splitting them would add three schemas for one job.

### 6.2 Dropped: the Zotero bridge

Phase 1 originally shipped a `zotero.js` tool (read-only local-first library
search/export/import). It was **removed before release**. The real-world
smoke test against **Zotero 10.0.6** established that:

- The local API (`extensions.zotero.httpServer.localAPI.enabled`) ships **off
  by default** — a GET returns HTTP 403 until the user enables it in
  Zotero → Settings → Advanced, so most users would hit a dead tool.
- Reads are keyless but **writes need a locally authorized key** obtained via
  a GUI prompt, which cannot be granted headless.
- The genuinely useful outcome (pull a paper in and cite it) is already
  covered by `paper_download` (open-access PDFs) + PaperMemory ingest, and
  bibliography export by `citation`.

Decision: drop the whole integration — the tool file, the preset row, the
`./zotero` package export, the `ZOTERO_*` settings keys and the Settings UI
group, the `test-zotero-mock` test, the prompt/README mentions, and the
`extraHeaders` argument added to `fetchPdf()`. If a reference-manager bridge is
wanted later, prefer Zotero's Web API only (with an explicit key) over the
local API, since the local API's default-off posture and write authorization
make it unusable for the harness's unattended tool path.

### 6.3 Registration and wiring (citation only)

- `package.json`: add `./citation` → `./citation.js`,
  `./citation-format` → `./citation-format.js`, `./review-store` →
  `./review-store.js`; add the files to `files`; add `citation-js` and its
  BibTeX/CSL/RIS plugins to `dependencies`.
- `presets/academic-harness/agent.cordis.yml`: one preset-only row
  (`citation`).
- `prompt.js`: new `## References and citation` section after
  `## Paper memory`. Steering: format every submitted bibliography through
  `citation`; validate before submission; pull papers in with
  `paper_download` + PaperMemory, not a reference manager.
- `README.md`: new `## References and citation` section.
- Skills: update `skills/citation-management/SKILL.md` to prefer the native
  `citation` tool, keeping the Python path as fallback. The vendored
  `skills/pyzotero` skill is left as-is (no native bridge it should defer to).

### 6.4 Phase 1 acceptance

- DOI → BibTeX works with and without `CROSSREF_MAILTO`.
- APA and IEEE output for a known DOI is stable across runs and fixtures.
- `validate` catches a duplicate DOI, a duplicate key, and a missing title.
- No network calls during `scripts/test-citation-format.mjs`.

### 6.5 Phase 0–1 implementation notes (2026-10-24)

- `citation-js` is installed as `@citation-js/core` plus the BibTeX, CSL, and
  RIS plugins (not the meta-package, which pulls in the CLI and extra
  plugins). IEEE, Chicago author-date, and MLA CSL styles are vendored under
  `styles/` (CC BY-SA 3.0; see `styles/README.md` and `NOTICE`); style
  registration is fail-soft, so a missing style file degrades the supported
  list rather than breaking the tool.
- `citation` is action-multiplexed (`format`/`bibtex`/`ris`/`validate`) and
  preserves supplied BibTeX keys; keys are generated (and sanitized) only when
  absent. `validate` reports duplicate supplied keys before auto-dedup.
- New tests: `scripts/test-citation-format.mjs`,
  `scripts/test-review-store.mjs`, `scripts/test-nonsearch-tools.mjs`.
- `scripts/test-nonsearch-tools.mjs` asserts the Zotero integration is fully
  absent (no `zotero.js`, no `./zotero` export, no preset row, no `ZOTERO_*`
  keys, no Zotero in the prompt).
- The package version was not bumped; Phase 0–1 are ready for the v0.18.0
  release step.

## 7. Phase 2 — paper integrity

### 7.1 `integrity-check.js` — `integrity_check`

Input: `doi` (bare or doi.org URL), or `title` resolved through a Crossref
bibliographic query. A title that does not match a candidate verbatim
(`normalizeTitle` equality) returns `verdict: "ambiguous"` with the ranked
candidates for the caller to choose — never an auto-pick. A paper with no DOI
has no registry status to report, so `ids[]` (PMID/arXiv/OpenAlex/S2) is
deferred rather than routing through `resolveIdentifier()` for an answer that
would come back `unknown`; `paper_resolve` already converts those to a DOI.

Checks:

| Source | Signal |
|---|---|
| Crossref `/works/{doi}` | `relation` entries (`has-retraction`, `is-retracted-by`, `has-correction`, `is-correction-of`, `has-editorial-expression-of-concern`), `update-to`, `updated-by`, `update-policy` |
| OpenAlex `/works/doi:{doi}` | `is_retracted`, `is_paratext`, `updated_date` |
| Derived | `retracted`, `expression_of_concern`, `corrected`, `clean`, `unknown`, `not_found`, `ambiguous` |

Crossref relationship keys that describe the work itself are `has-*` and
`*-by`; `is-retraction-of` means the queried DOI **is** somebody else's
notice and is not a strike against it. Publisher `updated-by` entries carry a
`Label` ("Retraction", "Correction") and are classified the same way.

Output: `{ checked_at, doi, title, verdict, crossref_ok, openalex_ok,
unavailable[], signals[], links[], pubpeer_url }`.
`pubpeer_url` is `https://pubpeer.com/publications/{doi}`; PubPeer has no
stable public API, so the tool does not scrape it. The agent may open that
URL with `agent-browser` if the user asks.

Rules:

- A network/API failure produces `unknown` with the failing source named
  (in `unavailable`). It never produces `clean`.
- A retraction flagged by one registry while the other is reachable and silent
  is a disagreement → `unknown`, with both signals reported. One registry
  confirming a retraction while the other is *down* still reads `retracted`:
  a positive record outranks an unavailable source.
- The tool checks publication integrity only; it does not verify that a
  paper supports a claim. Claim support stays with PaperMemory's
  `quote_check`/`trace` and scite.
- No key. Reuse the Crossref single-DOI limiter and the OpenAlex limiter.
  `OPENALEX_API_KEY` is optional.

### 7.2 Registration and wiring

- `package.json` exports/files: `./integrity-check`.
- Preset row: `integrity-check`.
- `prompt.js`: under `## Literature and the web`, add `### Paper integrity`.
  Steering: run `integrity_check` for every DOI that will be cited in a
  manuscript, rebuttal, or review; if the verdict is `retracted` or
  `unknown`, surface it to the user and do not present the paper as current
  evidence. scite remains the licensed Smart Citations path when its key is
  configured.
- No new settings keys and no Settings UI changes.
- `README.md`: row under academic tools.

### 7.3 Phase 2 acceptance

- A known retracted DOI returns `retracted` with Crossref/OpenAlex links.
- A known clean DOI returns `clean` with `checked_at`.
- A failing registry (injected `fetchJson`) returns `unknown`, not `clean`.
- Ambiguous title searches return candidates and do not silently choose one.
- Fixture tests cover all five derived verdicts plus `not_found` and
  `ambiguous`; live smoke is manual.

### 7.4 Phase 2 implementation notes (2026-10-24)

- `integrity-check.js` exports `apply`/`inject` for the preset row plus
  `runIntegrityCheck(args, exec, deps)` and `classifyIntegrity(...)` for
  tests. `deps` injects `fetchJson` and `resolveEnv`, so
  `scripts/test-integrity.mjs` needs no network and no HTTP server.
- OpenAlex rejects unknown `select` fields with HTTP 400, so the projection is
  pinned to the live schema (`id, doi, title, display_name, is_retracted,
  is_paratext, updated_date`). `retracted_by`, `has_publication`, and `URL` are
  **not** valid select fields on `/works` and were removed; `work.id` is already
  an `https://openalex.org/W…` URL and is used for the record link.
- Crossref's single-DOI record is fetched **without** `select`, because the
  nested `relation.*` paths are not reliably projectable.
- Live smoke against a known retracted Nature article
  (`10.1038/nature00870`) produced `retracted` from `updated-by: Retraction`
  plus OpenAlex `is_retracted`, with both notice DOIs as links. OpenAlex's
  keyless budget is shared per network IP and can answer 401 "Invalid or
  missing API key"; the tool then reports `unknown` with the failing source,
  which is the intended behaviour and is documented in the README and prompt.
- Golden surface test (`scripts/test-nonsearch-tools.mjs`) now asserts the
  export/file/preset row, the `### Paper integrity` prompt marker, and the
  never-clean rule.

## 8. Phase 3 — systematic review ledger

This closes the gap between the tutorial's `research-harness` mod and the
harness. It is a workflow tool, not a search tool.

### 8.1 `review.js` — `review`

One action-multiplexed tool, storing under
`<cwd>/.dsh/review/<slug>/` (see §5.2).

| Action | Parameters | Behavior |
|---|---|---|
| `start` | `slug`, `question`, `databases[]`, `inclusion[]`, `exclusion[]`, `date_range`, `notes`, `resume` | Write `protocol.json`; refuse overwrite unless `resume: true`; return counts |
| `add` | `records[]` or `path`, `source`, `query` | Normalize via `search-normalize.js`, dedupe, assign ids, append to `records.jsonl` and `search_log.jsonl` |
| `screen` | `id`, `stage` (`title_abstract` or `full_text`), `decision` (`include`/`exclude`/`maybe`), `reason` | Enforce stage order and a non-empty reason for exclude/maybe; append an event |
| `evidence` | `id`, `claim`, `quote`, `location`, `page`, `section` | Only for a full-text `include`; refuse empty claim/quote/location; append |
| `status` | — | PRISMA counts by stage and exclusion reason; flag missing full-text decisions and includes without evidence |
| `export` | `format` (`markdown`, `csv`, `json`) | Write under `exports/`; Markdown report skeleton, evidence CSV, PRISMA counts |

Rules:

- `add` accepts output from `literature_search` / source-specific search
  tools. It does not call search itself; discovery stays in the search
  layer.
- The tool never makes an inclusion decision. The agent/user supplies every
  decision and reason.
- Re-screening a record is allowed only with `override: true`; both events
  remain in the log and `status` reports the latest state.
- `evidence.quote` is stored verbatim. If the quote is not present in the
  ingested paper, PaperMemory's `quote_check` remains the verifier; the
  review ledger does not claim verification.
- The ledger is shared across the delegation tree by resolving the session
  root `cwd`, the same way `notebook.js` does.
- Exports never overwrite an existing non-empty file unless `overwrite: true`.

### 8.2 Registration and wiring

- `package.json` exports/files: `./review`, `./review-store`.
- Preset row: `review`.
- `prompt.js`: new `## Systematic reviews` section after `## Paper memory`.
  Steering: load it only when the user asks for a systematic/scoping review
  or PRISMA-style audit; run discovery with `literature_search`, then
  `review add`; ask for decisions rather than inferring them; `status`
  before reporting counts; `export` for the deliverable.
- `README.md`: new `## Systematic reviews` section.
- New skill: `skills/systematic-review-ledger/SKILL.md` with the workflow
  and the exact action semantics. Keep `skills/literature-review` as the
  discovery/synthesis guide.
- No new keys.

### 8.3 Phase 3 acceptance

- `start` creates the protocol and refuses a second start without `resume`.
- `add` deduplicates the same DOI and the same title+year; rerunning the same
  query adds zero records.
- `screen` rejects `full_text` before a title/abstract include and rejects an
  exclude without a reason.
- `evidence` rejects a record that is not a full-text include and rejects
  empty quotes.
- `status` counts match the event log, including override history.
- `export` produces Markdown + CSV without overwriting existing artifacts.

### 8.4 Phase 3 implementation notes (2026-10-24)

- `review.js` is a thin action-multiplexed wrapper over `review-store.js`;
  stage order, reason requirements, override handling, dedupe, and export
  overwrite protection stay in the store, so the tool and any script share
  one enforcement path.
- `add` accepts `records[]` (a search tool's result array) or `path` to a
  workspace JSON array, `{ "results": [...] }`, or JSONL file; paths outside
  the workspace are rejected before reading.
- `status` returns the raw `deriveStatus()` object and renders the
  PRISMA-style table plus `included_without_evidence`; `export` returns the
  workspace-relative path and byte count.
- New `scripts/test-review-tool.mjs` exercises the registered tool end to end
  in a temp workspace: protocol refusal/resume, JSONL intake, duplicate
  skipping, path escape, all stage/reason/evidence rejections, override,
  status, export and overwrite refusal. `scripts/test-review-store.mjs`
  remains the store-level suite.
- New skill `skills/systematic-review-ledger/SKILL.md`; prompt section
  `## Systematic reviews`; README section; golden surface test covers the
  export/file/preset row and the skill.

## 9. Phase 4 — clinical and regulatory evidence

Both tools are free and keyless by default, and both are explicitly **not**
literature search.

### 9.1 `clinicaltrials.js` — `clinicaltrials`

| Action | Parameters |
|---|---|
| `search` | `query`, `condition`, `intervention`, `phase[]`, `status[]`, `study_type`, `page_size` ≤100, `page_token` |
| `get` | `nct_id`, `include_results` |

Normalized output: NCT id, title, acronym, status, phase, enrollment,
start/completion dates, sponsor, conditions, interventions, primary and
secondary outcomes, locations, `has_results`, URL.

- Base `https://clinicaltrials.gov/api/v2/studies`; no key.
- Default `fields` is a compact set to avoid oversized payloads.
- Pagination returns `next_page_token`; the agent can request the next page.
- `include_results: true` fetches the results section when available, not
  only the protocol.
- Limiter 500 ms.

### 9.2 `openfda.js` — `openfda`

| Action | Parameters |
|---|---|
| `search` | `endpoint`, `search`, `limit` ≤100, `skip`, `sort` |

Supported `endpoint` values (initial set): `drug/event`, `drug/enforcement`,
`device/event`, `device/510k`, `drug/label`, `food/event`.

- Base `https://api.fda.gov` with the selected endpoint; `api_key` from
  `OPENFDA_API_KEY` when set.
- openFDA's `search` syntax is passed through; the tool validates that the
  endpoint is in the allowlist.
- A 404 "no matches" response is an empty result, not an error.
- Output: compact normalized records plus a link to the source endpoint.
- Limiter 250 ms keyed / 1000 ms keyless.
- Keyless daily limits are low; the description says a key is recommended
  for repeated use and the Settings hint states the current published limits
  are checked at implementation time.

### 9.3 Registration and wiring

- `package.json` exports/files: `./clinicaltrials`, `./openfda`.
- Preset rows: `clinicaltrials`, `openfda`.
- `prompt.js`: under `## Literature and the web`, add
  `### Clinical and regulatory evidence`. Steering: use for trial protocols,
  eligibility, endpoints, results, adverse events, recalls, and 510(k);
  cite NCT/report IDs; do not substitute for a literature review; do not
  give medical advice.
- `client/ApiKeysSection.jsx`: group `Regulatory data` with
  `OPENFDA_API_KEY`.
- `README.md`: rows and a short section.
- Update `skills/clinicaltrials/SKILL.md` to prefer the native tool when
  present, keeping its standard-library client as fallback.

### 9.4 Phase 4 acceptance

- A condition+intervention trial search returns normalized records and a
  next-page token.
- `get` returns outcomes and `has_results` for a trial with posted results.
- openFDA search works on all initial endpoints; no-match is empty, not an
  error; a missing key still works.
- No key is required for ClinicalTrials.gov.
- Fixtures cover a normal, empty, and 429 response.

### 9.4 Phase 4 implementation notes (2026-10-24)

- ClinicalTrials.gov v2 has **no** `filter.phase` or `filter.studyType` (they
  return HTTP 400). Phase and study-type filters are built as Essie
  `filter.advanced` expressions — `AREA[Phase](PHASE2 OR PHASE3)` and
  `AREA[StudyType](INTERVENTIONAL OR OBSERVATIONAL)`; `filter.overallStatus`
  is a real parameter and is used directly.
- `search` projects a compact `fields` list. `Design` is not a valid v2 field
  name (HTTP 400) and is omitted; the projection was verified against the live
  API.
- `get` omits `fields` only when `include_results: true`, because the results
  live in `resultsSection`, which the protocol projection drops. Posted
  results are summarized as outcome measures (type/title/unit/time frame/
  status) plus adverse-event group titles and serious/other counts, not full
  measurement tables.
- openFDA normalizers are per endpoint and hand-picked from the live schema
  (`consumer.gender`, `products[].name_brand`, `device[].generic_name`,
  …). The API key is appended only to the request, never to `source_url`.
- New `scripts/test-registries.mjs` covers both tools offline: normal search,
  get with results, empty results, 429, invalid filters, the openFDA endpoint
  allowlist, no-match 404, invalid search expression, and key redaction.
- Live smoke: a phase-3 semaglutide/T2D search returned two completed trials
  with enrollment and a next-page token; `NCT00082381` returned 7 posted
  outcome measures and adverse-event counts; `drug/enforcement` Class I
  returns normalized recalls.

## 10. Phase 5 — datasets and journal policy

### 10.1 `dataset-search.js` — `dataset_search`

| Action | Parameters |
|---|---|
| `search` | `query`, `repository`, `year`, `limit` ≤100, `cursor` |
| `get` | `doi` |
| `files` | `doi` (Zenodo/Figshare records only) |

- Primary source: DataCite `/dois` with `resource-type-id=dataset`;
  `repository` filters by DataCite client/repository name; `cursor` uses
  DataCite cursor paging.
- Normalized record: DOI, title, creators, publisher/repository, year,
  resource type, version, license, URL, description.
- `files` resolves Zenodo (`https://zenodo.org/api/records/{id}/files`) and
  Figshare when the DOI prefix matches; other repositories return
  `files_unavailable` with the landing URL. No download.
- No key; limiter 500 ms; polite User-Agent with `CROSSREF_MAILTO` when set.
- Deferred: Dryad/OSF/Dataverse-specific clients; DataCite already covers
  their DOI metadata. Deposit/mint is out of scope.

### 10.2 `journal-policy.js` — `journal_policy`

Input: `issn` (preferred) or `title`.

Sources:

| Source | Data |
|---|---|
| DOAJ (`https://doaj.org/api/`) | Listing status, publisher, APC, license, OA start year |
| Sherpa Romeo (`https://v2.sherpa.ac.uk/api/`) | Preprint/postprint/published-version permissions, embargo, conditions, OA route |

- `SHERPA_ROMERO_API_KEY` required for the Sherpa half. Without it, return
  DOAJ-only data plus a `sherpa: "key_not_set"` note; not an error.
- Output: journal identity (title, ISSNs, publisher), DOAJ status, APC,
  license, and per-version policy rows. Include source URLs and a
  `retrieved_at`.
- Limiter 500 ms DOAJ / 1000 ms Sherpa.
- The description says this is compliance information, not legal advice.

### 10.3 Registration and wiring

- `package.json` exports/files: `./dataset-search`, `./journal-policy`.
- Preset rows: `dataset-search`, `journal-policy`.
- `prompt.js`: under `## Literature and the web`, add
  `### Data and journal policy`. Steering: use `dataset_search` for data
  availability statements and dataset citations; use `journal_policy` for
  venue/OA compliance before submission; cite dataset DOIs; never invent a
  license or APC.
- `client/ApiKeysSection.jsx`: group `Data and compliance` with
  `SHERPA_ROMERO_API_KEY`.
- `README.md`: rows and a short section.

### 10.4 Phase 5 acceptance

- A dataset query returns DOI, repository, license, and year; cursor paging
  works.
- `files` lists Zenodo file names/sizes for a Zenodo DOI.
- A known ISSN returns DOAJ and Sherpa data; without the Sherpa key the
  result is DOAJ-only with a clear note.
- Unknown ISSN/title returns `not_found`, not an exception.
- Fixtures cover DataCite, DOAJ, and Sherpa payloads without network.

### 10.4 Phase 5 implementation notes (2026-10-24)

- DataCite `query` is a full-text expression, so the `repository` filter is
  appended as `publisher:"<name>"` (quotes escaped) rather than mapped to a
  client id; `year` maps to DataCite's `published` parameter. Cursor paging
  returns `links.next` but not a `meta.next`, so `next_cursor` is parsed from
  the next-link URL.
- `files` resolves Zenodo (`/api/records/{id}/files`, `entries[]`) and
  Figshare (`/api/articles/{id}/files`, array) by DOI pattern; every other DOI
  returns `files_unavailable` with the landing URL and makes no request.
  Endpoints and payload shapes were verified with curl; this container's Node
  cannot reach zenodo.org/api.figshare.com (direct `fetch` times out while
  curl succeeds), so the live file path is covered by fixtures plus the curl
  probe, and the network failure is surfaced as an ordinary tool error.
- DOAJ uses `issn:<value>` (it matches eISSN too) and
  `bibjson.title:"<title>"`. Title lookups require a verbatim normalized match
  when the search returns several journals; otherwise they return
  `status: "ambiguous"` with candidate ISSNs.
- Sherpa Romeo is called through `cgi/retrieve` with
  `item-type=publication&format=Json&filter=...&api-key=...`, the documented
  v2 JSON interface. Because the API cannot be reached without a key from this
  environment, `normalizeSherpa` accepts both `publisherPolicies` and
  `publisher_policy` shapes and both `permitted`/`permitted_oa` encodings; an
  unrecognized payload yields an empty policy list rather than invented rows.
  The key never appears in `sources`.
- Failure semantics: DOAJ 5xx + no Sherpa key → `status: "unknown"` with the
  DOAJ error (never `not_found`); DOAJ down + Sherpa success → `found`;
  missing Sherpa key → `sherpa: { skipped: "key_not_set" }`.
- `scripts/test-registries.mjs` now also covers DataCite search/get/files
  (Zenodo, Figshare, unsupported repository, 404), DOAJ/Sherpa normalization,
  embargo formatting, key redaction, ambiguous title lookup, and the
  failed-lookup-is-unknown rule.

## 11. Phase 6 — identity and peer review (optional)

Both tools register only when `AH_ENABLE_OPTIONAL_TOOLS=1`. Their keys are
resolved per call where applicable. They are not named in the base prompt.

### 11.1 `author-lookup.js` — `author_lookup`

| Action | Parameters |
|---|---|
| `author` | `query` or `orcid`; `limit` ≤50 |
| `institution` | `query` or `ror_id`; `limit` ≤50 |

- ORCID: `https://pub.orcid.org/v3.0/expanded-search/` for search and
  `https://pub.orcid.org/v3.0/{orcid}` for records; `Accept:
  application/json`; optional `ORCID_TOKEN`.
- ROR: `https://api.ror.org/organizations?query=...` and
  `https://api.ror.org/organizations/{id}`.
- Output: ORCID iD, names, affiliations (with ROR iD), works count;
  institution display name, ROR iD, country, acronym, aliases.
- Ambiguous names return ranked candidates; never auto-merge identities.
- Limiter 500 ms each.

### 11.2 `openreview.js` — `openreview`

| Action | Parameters |
|---|---|
| `search` | `query`, `venue`, `limit` ≤50 |
| `reviews` | `forum_id`, `limit` ≤100 |
| `venue` | `venue_id` |

- API v2 base `https://api2.openreview.net`; public data needs no key.
- `search` returns submissions (title, authors, venue, forum/PDF URLs).
- `reviews` returns the review notes for a forum: rating, confidence,
  summary, strengths, weaknesses, decision, plus the raw content fields
  (schemas vary by venue).
- `venue` returns venue metadata and submission counts when available.
- Limiter 1000 ms. Read-only.
- If a field is absent for a venue, report it as absent; do not infer a
  rating or decision.

### 11.3 Non-tool: preprint coverage

- Extend `pubmed_search` and `literature_search` routing to add
  `SRC:PPR` (Europe PMC preprints) when the query is biomedical and the
  user asks for preprints, or when `sources` explicitly includes
  `preprints`.
- Do not build a bioRxiv/medRxiv search API: the public bioRxiv API is
  date/DOI-oriented, not full-text search. Europe PMC already indexes these
  preprints.
- Update the prompt and README; no new tool.

### 11.4 Phase 6 acceptance

- ORCID name search and ROR institution search return normalized records.
- OpenReview search returns submissions for a known venue and reviews for a
  known forum; a missing forum returns empty.
- Preprint routing returns Europe PMC `SRC:PPR` records when requested.
- Optional tools are absent unless enabled; enabling them requires a
  `dsh` restart only for the mount-time decision.

### 11.5 Phase 6 implementation notes (2026-10-24)

- Gating lives in `optional-tools.js` (`optionalToolsEnabled()` reads
  `AH_ENABLE_OPTIONAL_TOOLS`). `apply()` returns before registering, so the
  tool is absent from the tool list and prompt; the preset rows stay static.
  `scripts/test-optional-tools.mjs` asserts both states.
- ORCID: `expanded-search` for names and `/record` for one iD. Author records
  flatten employments with ROR ids when ORCID provides a disambiguated ROR
  identifier; works count is the number of work groups. `ORCID_TOKEN` is sent
  as a Bearer token. Live smoke: name search and record lookup work.
- ROR uses the v2 API (`/v2/organizations`), whose records carry `names[]`
  (`ror_display`/`label`/`alias`) and `locations[].geonames_details` instead
  of the v1 `name`/`country` fields. Live smoke returned University of
  Oxford (052gg0110).
- OpenReview `search` (with optional `group` venue filter) and `venue`
  (`/groups?id=`) work live. `/notes` reads (reviews, submission decision)
  currently answer **HTTP 403 "ChallengeRequiredError"** from this network:
  OpenReview requires an interactive browser verification. The tool returns a
  clear 403 message naming the forum URL for `agent-browser`; fixture tests
  cover the review normalization, which never infers absent fields.
- Preprint routing: `pubmed_search` gains `preprints: true` (adds
  `AND SRC:PPR` unless the query already scopes `SRC:`; NCBI rejects it), and
  `literature_search` gains a `preprints` source, auto-selected for biomedical
  queries that say "preprint(s)/bioRxiv/medRxiv". Live smoke: 210 Europe PMC
  preprint hits for a GLP-1 query.
- Registry API keys (user request): `DATACITE_API_KEY` (Bearer),
  `ZENODO_API_KEY` (Bearer), `FIGSHARE_API_KEY` (`token …`) are resolved per
  call and sent as headers only — never in URLs — with settings-keys and
  Settings UI entries. Keyless behavior is unchanged; tests assert the headers
  and the no-key case. Public DataCite metadata does not require a key; the
  key is for gateways that do.

## 12. Phase 7 — local audits (optional)

All four tools are local, keyless, and disabled unless
`AH_ENABLE_OPTIONAL_TOOLS=1`. They are advisory and never conclusions.

### 12.1 `pdf-references.js` — `pdf_references`

- Requires `GROBID_BASE_URL` (for example `http://127.0.0.1:8070`). If
  unset, the tool is not registered; no auto-install and no Docker launch.
- POST the PDF to `/api/processReferences`, parse TEI XML with
  `fast-xml-parser` (add the dependency if approved; otherwise a targeted
  parser), and return reference records: raw string, title, authors, year,
  venue, DOI when present.
- Optional `resolve: true` resolves DOIs via Crossref/OpenAlex and reports
  matches; unresolved references stay raw.
- Failure modes: service unavailable, timeout, malformed TEI. Each returns a
  clear error; never fall back to model-generated references.

### 12.2 `stat-audit.js` — `stat_audit`

- New helper `python-helpers/stat_audit.py` in the existing helper venv.
- Input: `path` to `.tex`, `.md`, `.txt`, or `.docx`, or `text`; optional
  `alpha`, `grim`, `griMMER`.
- Extract test statistics and p-values, recompute p from the reported
  statistic and df where possible, and flag:
  - incompatible statistic/p pair;
  - p-value reported as `p = 0` or impossible;
  - GRIM/GRIMMER inconsistency for integer-scale means/SDs.
- Output: JSON/CSV rows with `file`, `line`, `reported`, `recomputed`,
  `issue`, `context`.
- Wording: `candidate inconsistency`, not misconduct. No network.
- Optional R `statcheck` path if R is installed, but the Python path is the
  default and is covered by fixtures.

### 12.3 `figure-audit.js` — `figure_audit`

- Input: `paths[]` or `dir`, `min_dpi` (default 300), `similarity_threshold`
  (default 0.92).
- Uses Pillow + imagehash in the helper venv to report: dimensions, DPI,
  color mode, file format, and pairwise perceptual-hash similarity.
- Flags duplicate/near-duplicate panels and low-resolution images; does not
  claim image manipulation. No network.
- Output: per-file summary + duplicate groups + suggested review order.

### 12.4 `repo-audit.js` — `repo_audit`

- Input: `path` (local repo) or `repo_url` (public clone into a temp dir);
  optional `run_tests` (default false), `github_token` via env only.
- Static checks: README, LICENSE, environment file (`requirements.txt`,
  `pyproject.toml`, `environment.yml`, `package.json`), test directory, CI
  config, entry points, data availability statement, release/tag.
- No code execution unless `run_tests: true`; when true, run the detected
  test command with a timeout and report the command and exit status.
- Output: checklist + evidence paths + `reproducibility_notes`.
- Optional GitHub API metadata when `repo_url` is used: stars, license,
  last commit, open issues; rate-limited and token-optional.

### 12.5 Registration and acceptance

- Registers only with `AH_ENABLE_OPTIONAL_TOOLS=1`; `pdf_references` also
  requires `GROBID_BASE_URL`.
- No prompt advertising; the skills can mention them.
- Acceptance: `pdf_references` returns ≥1 DOI-bearing reference for a known
  PDF and fails clearly when GROBID is down; `stat_audit` flags a known
  inconsistent t/p fixture and leaves a consistent one alone; `figure_audit`
  catches a duplicated panel fixture; `repo_audit` reports missing
  license/tests without executing code by default.

### 12.6 Phase 7 implementation notes (2026-10-24)

- All four register behind the Phase 6 gate; `pdf_references` additionally
  requires `GROBID_BASE_URL` at mount time. None are mentioned in the prompt.
- `pdf_references` uses a targeted TEI parser (regex over `biblStruct` /
  `analytic` / `monogr` / `persName` / `idno`), not `fast-xml-parser`, so no
  dependency was added. Unparseable TEI or an unreachable service is an error;
  references are never synthesized. `resolve: true` compares titles through
  Crossref with the polite-pool mailto.
- `stat_audit` and `figure_audit` share `python-runtime.js` (extracted from
  `sci_inspect`) for helper/venv discovery; helpers read a JSON request on
  stdin and print JSON. `stat_audit` covers t/F/χ²/z/r, `p = 0`, boundary
  claims (`p <`/`>`), and GRIM. **GRIMMER is not implemented** and the output
  says so. `.docx` text is read from `word/document.xml` with a 50 MB cap and
  `defusedxml` when installed (falling back to stdlib; `defusedxml` added to
  the helper dependencies).
- `figure_audit` computes a 64-bit dHash with Pillow instead of adding
  `imagehash`; the similarity is 1 − Hamming distance / 64. DPI comes from
  PNG/JPEG metadata or TIFF tags; missing DPI is reported as a flag, not
  guessed.
- `repo_audit` is static by default; `run_tests: true` runs only a detected
  `npm test` / `pytest` / `cargo test` / `go test` command, with a 5-minute
  timeout. `repo_url` accepts https only, clones `--depth 1` into a temp dir,
  and removes it afterwards; `GITHUB_TOKEN` is read from the environment only.
- New `scripts/test-audits.mjs` covers gating, TEI parsing (entities,
  authors, DOI), GROBID failure/empty TEI, the real Python helpers when
  scipy/Pillow are available, and the repo checklist on a temp git repo
  (including no-execution-by-default and the https-only clone guard).

## 13. Phase 8 — grants and patents (gated, optional)

Not part of the default preset. Both register behind
`AH_ENABLE_OPTIONAL_TOOLS=1`; `patent_search` additionally requires its key
on every call.

### 13.1 `grant-search.js` — `grant_search`

| Action | Parameters |
|---|---|
| `search` | `funder` (`nih`, `nsf`, `grantsgov`), `query`, `pi`, `org`, `fiscal_year`, `limit` ≤100 |
| `get` | `funder`, `award_id` |

- NIH RePORTER v2 (`https://api.reporter.nih.gov/v2/projects/search`,
  POST JSON), NSF Award Search (`https://api.nsf.gov/services/v1/awards.json`),
  Grants.gov search (`https://api.grants.gov/v1/api/search2`).
- Normalized award: award id, title, PI, organization, amount, start/end,
  abstract, funder, URL.
- No key for the initial three; verify current terms at implementation.
- Limiter 1000 ms; no bulk harvesting.
- Use for funding discovery, prior-award context, and acknowledgment checks;
  not for grant-writing advice.

### 13.2 `patent-search.js` — `patent_search`

- PatentsView `https://search.patentsview.org/api/v1/patent/` with
  `X-Api-Key: $PATENTSVIEW_API_KEY` (required).
- Parameters: `query`, `assignee`, `inventor`, `date_from`, `date_to`,
  `limit` ≤100, `include_abstract`.
- Normalized record: patent id, title, assignee, inventors, priority/filing/
  grant dates, abstract, URL.
- Limiter 1000 ms; no legal-status or freedom-to-operate claim.
- Missing key → clear error naming `PATENTSVIEW_API_KEY`.

### 13.3 Phase 8 acceptance

- One query per funder returns normalized awards; empty results are clear.
- Patent search returns a known assignee's patents; missing key is a clear
  error, not a disabled tool.
- Both tools are absent from the base prompt and from sessions without the
  enable flag/key.

### 13.4 Phase 8 implementation notes (2026-10-24)

- `grant_search` hits NIH RePORTER `POST /v2/projects/search`, NSF
  `awards.json`, and Grants.gov `search2` / `fetchOpportunity`. Each has its
  own 1000 ms limiter. NIH criteria map `pi` → `pi_names[].last_name`,
  `org` → `org_names`, `year` → `fiscal_years`; NSF maps year to
  `startDateStart`/`startDateEnd`; Grants.gov is an *opportunities* index, so
  `year` filters open/close dates client-side and there is no amount or PI.
  Live smoke: NIH (83k hits for a broad query), NSF (2 awards for a 2024
  quantum filter), Grants.gov (159 opportunities), plus NSF and Grants.gov
  `get`.
- `patent_search` requires `PATENTSVIEW_API_KEY` per call and returns a clear
  error naming it when unset — it is not disabled. The query is built as
  PatentsView JSON (`_and` of `_text_any` title/abstract, assignee, inventor,
  and `_gte`/`_lte` on `patent_date`), fields are projected explicitly, and
  `X-Api-Key` is sent as a header. The 401/403 path says to check the key. The
  keyless environment prevented a live call; fixtures cover query building,
  normalization, the missing-key error, and the auth error. `include_abstract`
  adds `patent_abstract` to the projection; the link is a Google Patents page.
- Neither tool is advertised in the prompt (golden test asserts absence); both
  have Settings entries (`PATENTSVIEW_API_KEY` under Patents) and README rows.

## 14. File-level change checklist

Every phase repeats this set; no phase changes `index.js`.

| File | Change |
|---|---|
| `citation-format.js` | New (Phase 0) |
| `review-store.js` | New (Phase 0) |
| `citation.js` | New (Phase 1) |
| `integrity-check.js` | New (Phase 2) |
| `review.js` | New (Phase 3) |
| `clinicaltrials.js`, `openfda.js` | New (Phase 4) |
| `dataset-search.js`, `journal-policy.js` | New (Phase 5) |
| `author-lookup.js`, `openreview.js` | New (Phase 6, optional) |
| `pdf-references.js`, `stat-audit.js`, `figure-audit.js`, `repo-audit.js` | New (Phase 7, optional) |
| `grant-search.js`, `patent-search.js` | New (Phase 8, gated) |
| `python-helpers/stat_audit.py`, `python-helpers/figure_audit.py` | New helpers (Phase 7) |
| `python-helpers/pyproject.toml` | Add `defusedxml` for safe docx XML parsing; Pillow was already present (dHash needs no `imagehash`) |
| `package.json` | Add exports/files for every module; add `citation-js`/plugins (the TEI parser is targeted regex, so `fast-xml-parser` was not needed) |
| `settings-keys.js` | Add the keys in §5.3 |
| `client/ApiKeysSection.jsx` | New groups: Regulatory data, Data and compliance, Identity, Patents |
| `presets/academic-harness/agent.cordis.yml` | One row per module; optional tools gated in `apply()` |
| `prompt.js` | New sections and steering for default tools only |
| `README.md` | Tool sections, API keys, optional-tool enablement |
| `skills/citation-management`, `skills/clinicaltrials` | Prefer native tools, keep CLI fallback |
| `skills/systematic-review-ledger` | New skill (Phase 3) |
| `scripts/test-citation-format.mjs`, `test-review-store.mjs`, `test-review-tool.mjs`, `test-integrity.mjs`, `test-registries.mjs`, `test-optional-tools.mjs`, `test-audits.mjs`, `test-grants.mjs`, `test-nonsearch-tools.mjs` | New tests/golden markers |
| `cordis.patch.yml` | Regenerate with `npm run build:patch` |
| `lib/client.js` | Regenerate with `npm run build` |
| `docs/NON-SEARCH-TOOLS-PLAN.md` | Update status/checklist as phases land |

Registration note: every new module is preset-only and registers one tool
(`apply(ctx)` + `inject: ['tools']`), matching `crossref-lookup.js` and
`consensus-search.js`. `settings-keys.js` remains host-level because the
Settings page is shared.

## 15. Verification plan

### Automated

1. `scripts/test-citation-format.mjs`
   - BibTeX/RIS/CSL fixtures parse and round-trip.
   - APA/IEEE output is byte-stable for fixed records.
   - Validation catches duplicate DOI/key and missing fields.
   - No network.
2. `scripts/test-review-store.mjs`
   - Dedupe by DOI and title+year; rerun adds zero.
   - Stage ordering and reason enforcement.
   - Override appends an event and `status` uses the latest.
   - PRISMA counts are derived from the event log.
   - Export does not overwrite.
3. `scripts/test-integrity.mjs`
   - Fixtures for retracted, concern, corrected, clean, unknown.
   - API failure → `unknown`, never `clean`.
   - Title ambiguity returns candidates.
4. `scripts/test-registries.mjs`
   - ClinicalTrials search/get/pagination fixtures.
   - openFDA no-match and endpoint allowlist.
   - DataCite/DOAJ/Sherpa/ORCID/ROR/OpenReview fixtures.
5. `scripts/test-nonsearch-tools.mjs` (golden surface)
   - Module exports, tool names, preset rows, package exports/files.
   - Prompt markers for default tools only.
   - Settings fields present.
   - Optional tools absent unless enabled.
6. `node scripts/build-cordis-patch.mjs --check` and `npm run build`;
   `git diff --exit-code -- lib/`.

### Manual (live, per provider, scratch credentials)

| Check | Smoke |
|---|---|
| `citation` | DOI → BibTeX; APA/IEEE; validate a real `.bib` |
| `citation` | DOI → BibTeX; APA/IEEE/Vancouver/Harvard/Chicago/MLA; `validate` on a real `.bib`; live Crossref smoke |
| `integrity_check` | Known retracted DOI and a clean DOI |
| `review` | Full scratch review with 3 records, screening, evidence, status, export |
| `clinicaltrials` | Condition/intervention search; `get` with results |
| `openfda` | One query per initial endpoint; no-match |
| `dataset_search` | DataCite query; Zenodo `files` |
| `journal_policy` | Known ISSN with and without the Sherpa key |
| `author_lookup` | ORCID search; ROR search |
| `openreview` | Venue search; reviews for a forum |
| `pdf_references` | Known PDF with GROBID running |
| `stat_audit` | Known consistent/inconsistent fixtures |
| `figure_audit` | Duplicate/low-DPI fixture |
| `repo_audit` | Public repo with and without license/tests |
| `grant_search` | One query per funder |
| `patent_search` | Known assignee; missing-key error |

No CI secrets. Live calls are manual and optional.

## 16. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tool-schema bloat | Action-multiplexed tools; at most eight default tools; optional tools gated; no prompt mention for optional tools |
| Citation style fidelity | `citation-js` CSL styles + fixtures; no hand-rolled styles; fixed fallback scope if the dependency is rejected |
| Integrity false "clean" | `unknown` on any failure; name the failing source; show `checked_at` |
| Overlap with scite | Document: scite is licensed Smart Citations; `integrity_check` is a free registry check and never claim support |
| Review ledger drift/concurrency | Append-only event logs; derived state; stable ids under a lock; fixtures for reruns |
| Stage/reason bypass | Tool-level enforcement, not prompt-only |
| openFDA/ClinicalTrials schema drift | Fixtures + manual smoke; compact normalized fields; raw source link retained |
| Sherpa/DOAJ availability | Degrade to the available source with an explicit note; no fabricated policy |
| ORCID/ROR ambiguity | Ranked candidates; no automatic identity merge |
| GROBID is heavy infrastructure | BYO base URL; no auto-install; clear `service_unavailable`; never generate references |
| Stat/figure/repo audits overclaim | Advisory wording; human-review checklist; no misconduct conclusions; no execution by default |
| Grant/patent legal overreach | Informational only; patent tool says it is not legal advice |
| Rate limits | Shared limiter with conservative budgets; no bulk harvesting |
| Duplicate sources of truth | PaperMemory = papers/claims; `ah_*` = writing ledger; review = screening ledger; citation = stateless |
| Optional-tool mount needs restart | Documented; the tool is absent until enabled, then requires a `dsh` restart |

## 17. Explicit non-goals

- No new literature/web search providers; the search plan is complete.
- No plagiarism/Turnitin/iThenticate integration. If similarity checking is
  requested later, implement a local n-gram/zvec check and label it
  advisory; do not imply a commercial similarity score.
- No reference-manager integration. `skills/pyzotero` remains available as a
  skill, but the harness will not ship a native Zotero tool (see §6.2).
- No publisher submission APIs (Editorial Manager, ScholarOne); there is no
  stable public API.
- No ELN/LIMS integration (Benchling, LabArchives) in this plan.
- No Covidence/Rayyan integration; no public APIs.
- No scraping of PubPeer, ResearchGate, or Google Scholar. Return URLs and
  use `agent-browser` with user consent where appropriate.
- No paywall bypass; `paper_download` remains open-access only.
- No automatic manuscript submission, grant submission, or patent filing.
- No claim-level verification in `integrity_check`; that remains
  PaperMemory + scite + human review.
- No automatic meta-analysis in Phase 1–5; a local `meta_analysis` helper
  can be proposed separately.

## 18. Sequencing and release shape

| Phase | Scope | New default tools | Recurring cost | Ships independently |
|---|---|---|---|---|
| 0 | Citation/review infrastructure, settings, limiters | 0 | none | yes |
| 1 | `citation` (Zotero bridge dropped) | 1 | none | yes |
| 2 | `integrity_check` | 1 | none | yes |
| 3 | `review` | 1 | none | yes |
| 4 | `clinicaltrials`, `openfda` | 2 | none; openFDA key optional | yes |
| 5 | `dataset_search`, `journal_policy` | 2 | none; Sherpa key free | yes |
| 6 | `author_lookup`, `openreview` + preprint routing | 0 by default (2 optional) | none | yes |
| 7 | `pdf_references`, `stat_audit`, `figure_audit`, `repo_audit` | 0 by default (4 optional) | none | yes |
| 8 | `grant_search`, `patent_search` | 0 by default (2 gated) | none | yes |

Recommended release cadence:

- **v0.18.0** — Phase 0 + Phase 1 (reference layer)
- **v0.19.0** — Phase 2 + Phase 3 (integrity + systematic review)
- **v0.20.0** — Phase 4 + Phase 5 (registries, data, compliance)
- **v0.21.0** — Phase 6 (identity, OpenReview, preprint routing)
- **v0.22.0** — Phase 7 (local audits)
- **v0.23.0** — Phase 8 (grants, patents)

Each release repeats the file-level checklist, golden tests, README update,
and generated artifacts. Optional phases can be dropped without affecting
the default surface.

**Actual release: v0.18.0 shipped all phases 0–8 together** (2026-10-24)
rather than the staged cadence above; the phase boundaries remain useful if a
subset ever needs to be reverted.

## 19. Open decisions (resolve at implementation)

1. **citation-js vs pandoc-first.** Adopt citation-js for deterministic CSL
   output; use pandoc only as an optional renderer when present. Revisit if
   the dependency is rejected.
2. **Reference-manager bridge — RESOLVED (dropped).** Zotero was removed
   before release (§6.2). If a bridge is revisited, target the Web API only
   with an explicit key, not the default-off local API.
3. **Review ledger location.** `.dsh/review/<slug>/` for the event logs and
   `review/<slug>/` for exported deliverables. Confirm with users who prefer
   visible project folders.
4. **Optional-tool gating.** `AH_ENABLE_OPTIONAL_TOOLS=1` is a single
   process-wide switch; a per-tool Settings toggle would need mount-time
   config. Start with the env flag and revisit if the UI is required.
5. **Stat audit runtime.** Python helper first; R `statcheck` only when R is
   installed. Confirm the parser covers the manuscript formats users
   actually submit (`.tex`, `.docx`, `.md`).
6. **OpenReview review fields.** Venue schemas vary; store raw content plus
   a best-effort normalized view, and never infer a missing rating.
7. **Grant/patent scope.** NIH/NSF/Grants.gov and PatentsView are the
   initial set. CORDIS, UKRI GtR, EPO OPS, and Lens/Dimensions are future
   additions, not Phase 8 commitments.

## 20. Task checklist

Phase 0 — done 2026-10-24
- [x] Add `citation-js` and plugins (or approved fallback)
- [x] `citation-format.js` with parse/format/validate functions
- [x] `review-store.js` with append-only event log
- [x] Phase 0 registry keys in `settings-keys.js` (UI groups land with their phases)
- [x] Limiter budgets documented
- [x] Unit fixtures for citation and review store

Phase 1 — done 2026-10-24 (citation shipped; Zotero bridge dropped)
- [x] `citation.js` with `format`/`bibtex`/`ris`/`validate`
- [x] DOI → BibTeX via Crossref; `check_dois` validate mode
- [x] `styles/` CSL vendored + registered fail-soft; NOTICE attribution
- [x] Preset row, package exports/files, prompt, README
- [x] `citation-management` skill defers to the native tool
- [x] Golden surface test (`test-nonsearch-tools.mjs`) covers `citation`
- [x] Zotero integration removed; test asserts absence (no tool/export/preset/keys/prompt)

Phase 2 — done 2026-10-24 (`doi` + `title` input; `ids[]` deferred)
- [x] `integrity-check.js` with Crossref + OpenAlex checks
- [x] `unknown` on failure; PubPeer URL only
- [x] Prompt, README, fixtures, retracted/clean smoke

Phase 3 — done 2026-10-24
- [x] `review.js` with six actions
- [x] `systematic-review-ledger` skill
- [x] Stage/reason/evidence enforcement tests
- [x] PRISMA counts and export tests
- [x] Prompt, README, scratch-workspace smoke

Phase 4 — done 2026-10-24
- [x] `clinicaltrials.js` search/get with pagination
- [x] `openfda.js` with endpoint allowlist
- [x] Fixtures for normal/empty/429
- [x] Prompt, README, Settings row, skill update

Phase 5 — done 2026-10-24
- [x] `dataset-search.js` search/get/files
- [x] `journal-policy.js` DOAJ + Sherpa with graceful key-absent mode
- [x] Fixtures and smoke
- [x] Prompt, README, Settings row

Phase 6 — done 2026-10-24 (reviews note reads hit a live 403 challenge)
- [x] `author-lookup.js` ORCID + ROR
- [x] `openreview.js` search/reviews/venue
- [x] Europe PMC `SRC:PPR` routing in `pubmed_search`/`literature_search`
- [x] Enable flag, fixtures, smoke
- [x] Registry API keys: `DATACITE_API_KEY`, `ZENODO_API_KEY`, `FIGSHARE_API_KEY`

Phase 7 — done 2026-10-24 (GRIM only; GRIMMER deferred)
- [x] `pdf-references.js` with BYO GROBID
- [x] `stat_audit.py` + `stat-audit.js`
- [x] `figure_audit.py` + `figure-audit.js` (dHash, no imagehash dependency)
- [x] `repo-audit.js` with no execution by default
- [x] Fixtures and advisory-wording review

Phase 8 — done 2026-10-24 (no live patent call: no key in this environment)
- [x] `grant-search.js` NIH/NSF/Grants.gov
- [x] `patent-search.js` PatentsView
- [x] Key/enable gating and clear errors
- [x] Manual smoke and README

Release — v0.18.0, done 2026-10-24
- [x] `npm run build:patch` and `npm run build`
- [x] `scripts/test-nonsearch-tools.mjs` and new unit tests pass
- [x] README and this plan's status updated
- [x] Version bump (`package.json` / `package-lock.json` → 0.18.0)

## 21. Post-plan additions (unreleased)

- **`manuscript_citations`** (`manuscript-citations.js`) — local manuscript ↔
  bibliography audit for `.tex` and Pandoc `.md`: missing keys, unused
  entries, duplicate bibliography keys, undefined `\ref` targets, duplicate
  labels. `.docx` is rejected (opaque citation fields). No network.
- **`funder_policy`** (`funder-policy.js`) — OpenAlex funder identity keyless;
  Sherpa Juliet per-version OA policy with `SHERPA_ROMERO_API_KEY`, with the
  same `key_not_set` degrade as `journal_policy`. `versionInfo()` is shared
  from `journal-policy.js`.
- Tests: `scripts/test-manuscript-tools.mjs`; the golden surface and CI steps
  cover both tools. Release/version bump not yet made.
- **`remove-ai-signs` skill** — vendored from the user's local Qoder skill
  (guide adapted from Wikipedia WP:AICAT, CC BY-SA 4.0; see NOTICE), with the
  scanner path made workspace-relative. New `## Writing quality` prompt
  section frames it as density-based style editing that preserves meaning,
  numbers, citations, and technical language — explicitly not detector evasion
  and never provenance stripping. Golden test runs the scanner.
  This deliberately replaces the request to integrate the Turnitout-Humanizer:
  no detector-bypass, watermark, or C2PA-stripping functionality is included.
