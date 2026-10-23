# Search Providers — gap analysis and implementation plan

Status: **Phase 0–5 implemented** (2026-10-23; optional self-hosted providers deferred) · Released as plugin **v0.17.0**
Source docs: `academic-harness_docs/Search Providers API Reference.md`,
`academic-harness_docs/Claude Code Mods  Complete Tutorial + Research Harness.md`,
`academic-harness_docs/Jev Delegation Routing for the Academic Research Harness.md`

## 1. Why

The harness currently reaches the literature through **three native REST tools**
(`consensus_search`, `parallel_search`, `paper_download`) and **three MCP connectors**
(Parallel, Firecrawl, scite), plus local `grep`/`glob`, `zvec-grep`, and PaperMemory.
That covers web search, AI-native excerpts, one peer-reviewed index, smart citations,
and open-access PDF resolution.

It does **not** cover the open bibliographic backbones that the provider reference
names as the primary academic tier (lines 468–479): OpenAlex and Semantic Scholar,
with Crossref, arXiv, and PubMed/Europe PMC as secondary sources. It also has no
shared paper record, no cross-source deduplication, no ID resolution, and no
citation-graph traversal. The tutorial's "Extending the harness" section (§7,
line 1208) already names adding `pubmed` and `arxiv` sources as the next step.

This plan closes that gap in independently shippable phases, with the
academic backbones first because they are free, high-volume, and highest-leverage.

## 2. Current state

| Layer | Implemented | Where |
|---|---|---|
| Native REST literature | `consensus_search` | `consensus-search.js` |
| Native REST web search | `parallel_search` (turbo/fast/basic/advanced) | `parallel-search.js` |
| Native REST OA resolver | `paper_download` (Unpaywall DOI→PDF) | `paper-download.js` |
| MCP connectors | Parallel, Firecrawl, scite | `mcp-connectors.js` |
| Workspace search | native `grep`/`glob`, `mcp__zvec_grep__*` | preset rows, `zvec-*.js` |
| Paper memory | `mcp__papermemory__*` | `papermemory.js` |
| Host built-in | `web_search`, `web_fetch` | `@deepseek-ai/dsh-tool-web` |
| arXiv / Crossref | indirect only (PaperMemory ingest accepts IDs) | `papermemory-cli.js` comment |
| Keys | `PARALLEL_API_KEY`, `FIRECRAWL_API_KEY`, `CONSENSUS_API_KEY`, `SCITE_API_KEY`, `UNPAYWALL_EMAIL` | `settings-keys.js:42-60` |

Known structural gaps, beyond missing providers:

1. **No normalized paper record.** Consensus and Parallel results have different
   shapes; the agent is told to issue both "in the same search round" and compare
   by eye (`prompt.js:88`).
2. **No cross-source dedupe or ID resolution.** The same paper can appear three
   ways with different identifiers.
3. **No citation-graph traversal** (forward/backward citations) and no
   recommendation/seeded search.
4. **No pagination.** Existing tools return the first batch only; the tutorial
   flags this as a coverage caveat (line 1220).
5. **No provider-specific rate-limit handling.** arXiv (1 request / 3 s), Semantic
   Scholar (1 RPS with an intro key), NCBI (3/10 RPS), Crossref polite (3 RPS list),
   CORE (0.5 RPS) all require serialization/backoff that no current module has.

## 3. Provider disposition

Every provider in the reference doc's matrix, grouped by decision (rows the doc
combines — PubMed/Europe PMC, Crossref/Unpaywall, Parallel Search/Extract,
Firecrawl/Research Index — are split where they are distinct APIs). "Done" means
a runtime code path exists today.

| Provider | Decision | Phase | Rationale |
|---|---|---|---|
| OpenAlex | Adopt | 1 | Free CC0 backbone, 300M+ works, 30 RPS with free key, rich filters, entity resolution |
| Semantic Scholar | Adopt | 1 | Free, 214M papers, TLDRs, SPECTER2, snippet search, citation graph |
| Crossref | Adopt | 1 | Canonical DOI metadata, polite pool, already a PaperMemory dependency |
| arXiv | Adopt | 1 | Free, fielded query syntax, primary preprints; tutorial names it |
| PubMed / Europe PMC | Adopt | 1 | Biomedical coverage; Europe PMC returns JSON and needs no key; tutorial names it |
| Brave Search | Adopt | 2 | Independent index, 50 RPS, doc's Tier-1 fallback |
| Parallel Extract | Adopt | 2 | REST parity with `mcp__parallel__web_fetch` |
| Firecrawl Research Index | Adopt (steering) | 2 | Free paper endpoints on an existing connector |
| Tavily | Adopt | 3 | AI-native chunks, topic modes, generous free tier |
| Exa | Adopt | 3 | Neural/entity search, `deep` synthesis |
| Perplexity | Adopt | 3 | Deep multi-hop research tier |
| Jina Reader | Adopt | 3 | JS/PDF → Markdown; alternatives to Firecrawl |
| Linkup | Optional | 3 | Deep iterative search; low priority |
| You.com | Optional | 3 | Keyless MCP tier exists; low priority |
| Valyu | Optional | 3 | Proprietary datasets; low priority for academic work |
| Kagi | Not planned | — | Paid, no permanent free tier; marginal over Brave/Exa |
| Crawl4AI | Optional self-host | 5 | Fully free but requires Docker + browser; out of scope for default preset |
| Spider.cloud | Not planned | — | Overlaps Firecrawl/Jina |
| Olostep | Not planned | — | Batch scraping, not discovery |
| Bright Data | Not planned | — | Anti-bot/enterprise scraping; not a literature source |
| Apify | Not planned | — | RAG browser; overlaps Firecrawl |
| Serper | Optional | 3 | Cheap Google Scholar endpoint, but unofficial schema |
| SerpApi | Optional | 3 | Richest Scholar params; paid |
| Google Custom Search | Not planned | — | Closed to new customers, sunset 2027-01-01 |
| Microsoft Bing | Not planned | — | Standalone API retired 2025-08-11 |
| SearXNG | Optional self-host | 5 | Free metasearch; needs an instance and proxy maintenance |
| CORE | Adopt | 4 | `fullText` inside the work record; useful for full-text retrieval |
| Elicit | Adopt | 4 | Systematic-review/screening sessions; requires Pro+ |
| FutureHouse / PaperQA2 | Adopt | 4 | Deep scientific synthesis; requires key |
| Lens / Dimensions | Optional | 4 | Patents/grants; gated licensing |
| Consensus | Done | — | `consensus-search.js` |
| scite | Done | — | `mcp-connectors.js` |
| Parallel Search | Done | — | `parallel-search.js` + MCP |
| Firecrawl | Done | — | `mcp-connectors.js` |
| Unpaywall | Done | — | `paper-download.js` |

Explicit non-goals: Bing, Google CSE, and Unpaywall `/v2/search` (retired,
HTTP 410 — route text search to OpenAlex).

## 4. Design principles

These match the conventions already used by `consensus-search.js` and
`parallel-search.js`.

1. **Native REST over MCP for new providers.** Every MCP mount inflates the
   system prompt with its tool schemas (reference doc line 466). Native tools keep
   exactly the parameters the harness needs, work with `resolveEnv()` per call
   (no `dsh` restart), and degrade with a clear "key not set" error.
2. **One module = one tool.** File `<provider>-search.js` (or `-lookup.js`),
   exporting `{ name, inject: ['tools'], apply(ctx) }`, registering one
   `defineTool`. Separate modules for routers/helpers.
3. **No hidden defaults for auth.** Optional keys may be absent; required keys
   return `{ error: '<KEY> is not set ...' }`, never a thrown exception.
4. **Normalize at the boundary.** Each provider module returns its raw payload
   plus a normalized `papers` array (see §5.1), so the router and prompt can treat
   all sources uniformly.
5. **Rate-limit at the client.** Every HTTP call goes through the shared limiter
   (§5.2); provider limits are code, not documentation.
6. **Politeness is part of the contract.** Crossref `mailto`, NCBI `tool`+`email`,
   Unpaywall email, arXiv 3 s spacing.
7. **Do not duplicate existing capability.** `parallel_search` remains the web
   search default; new web providers are alternatives, not replacements.

## 5. Shared infrastructure (Phase 0)

Prerequisite for Phase 1. All later phases reuse it.

### 5.1 `search-normalize.js`

Export:

```js
export function normalizePaper(source, raw)   // provider payload -> NormalizedPaper
export function mergePapers(records)          // dedupe + field-level merge
export function renderPapers(papers, opts)    // compact Markdown for a tool result
```

Normalized shape:

```js
{
  source: 'openalex' | 's2' | 'crossref' | 'arxiv' | 'pubmed' | 'consensus' | 'parallel' | ...,
  source_id: string,
  doi: string | null,
  pmid: string | null,
  pmcid: string | null,
  arxiv_id: string | null,
  openalex_id: string | null,
  s2_id: string | null,
  title: string,
  authors: [{ name, orcid? }],
  year: number | null,
  venue: string | null,
  abstract: string | null,
  tldr: string | null,
  citation_count: number | null,
  oa_status: string | null,
  oa_url: string | null,
  url: string | null,
  type: string | null,
  fields: string[],
  retrieved_at: string
}
```

Dedupe order: DOI (lowercased, `doi.org/` prefix stripped) → PMID → arXiv ID →
OpenAlex ID → S2 ID → `sha1(normalized title + year)`. Merge keeps the first
non-empty value per field, max `citation_count`, and prefers an OA URL. Stable
sort: source priority (OpenAlex, S2, Crossref, PubMed, arXiv, Consensus, web),
then `citation_count`, then year.

Add the provider-specific mappers in this file (or per-module
`toNormalized()` functions) so normalization is testable without network calls.

### 5.2 `search-http.js`

```js
export class RateLimiter {
  constructor({ minIntervalMs, maxConcurrent = 1 })
  async run(fn)          // serializes per provider key
}
export async function fetchJson(url, { headers, signal, timeoutMs = 15000, retries = 2 })
```

Behavior:

- Enforce per-provider minimum spacing and concurrency.
- On HTTP 429/503, honor `Retry-After`; otherwise exponential backoff
  (500 ms, 1500 ms) with a hard cap of 2 retries.
- Surface `{ error, status, detail }` in the same shape the existing tools use.
- Accept `exec.signal` so cancellation propagates.
- Emit a single `console.warn` on rate-limit wait, never per call (no log spam).

Registered rate budgets:

| Provider | Budget |
|---|---|
| OpenAlex | 10 RPS keyless / 30 RPS with key → 100 ms / 34 ms |
| OpenAlex semantic (`search=`) | 1 RPS → 1000 ms |
| Semantic Scholar | 1 RPS with intro key; shared 1000 RPS unauthenticated → 1000 ms |
| Crossref list | 1 RPS public / 3 RPS polite → 1000 ms / 334 ms |
| Crossref single DOI | 5 RPS public / 10 RPS polite → 200 ms / 100 ms |
| arXiv | 1 request / 3 s, 1 connection → 3000 ms, concurrency 1 |
| Europe PMC | conservative 200 ms; no published hard limit |
| NCBI E-utilities | 3 RPS keyless / 10 RPS key → 334 ms / 100 ms |
| CORE | 0.5 RPS unregistered / 10 RPM key → 2000 ms / 6000 ms |

### 5.3 `paper-resolve.js`

`paper_resolve` tool: convert identifiers in both directions.

- Input: `id` (DOI, PMID, arXiv ID, OpenAlex ID, or S2 ID) or `ids[]`.
- DOI/PMID/OpenAlex: OpenAlex `/works/doi:…`, `/works/pmid:…`, `/works/<id>`,
  and `ids` in the response.
- arXiv: Semantic Scholar `/paper/batch` with `ARXIV:<id>` (OpenAlex does not
  reliably index arXiv IDs as first-class IDs).
- Output: `{ resolved, papers }` using the normalized record; `resolved: false`
  with a reason when not found.

This is the citation-hygiene tool: it prevents the agent from treating a DOI,
PMID, and arXiv ID as three different papers.

## 6. Phase 1 — free academic backbones

Goal: complete the doc's Tier-4/Tier-6 stack at zero recurring cost.

### 6.1 `openalex-search.js` — `openalex_search`

- Endpoint: `GET https://api.openalex.org/works`
- Auth: `OPENALEX_API_KEY` optional (`?api_key=`); keyless works at 10 RPS.
- Parameters:
  - `query` → `search` (full text; warn in description that filters improve precision)
  - `filter` (string or array of `field:value`, joined by commas)
  - `sort` (`cited_by_count:desc`, `publication_date:desc`, …)
  - `per_page` (1–100, default 25), `page` (≤10 000), `cursor` (paging beyond
    page 1 requires an API key)
  - `select` (array of fields; default a compact set)
  - `group_by` (facet; returns counts instead of records)
  - `entity`: `works` (default) | `authors` | `sources` | `topics`
- Mapping: `id`, `doi`, `ids.pmid`, `title`, `publication_year`,
  `authorships[].author.display_name`, `primary_location.source.display_name`,
  `open_access.oa_status`, `primary_location.landing_page_url`,
  `best_oa_location.pdf_url`, `cited_by_count`, `type`, `topics[].display_name`.
- Output: `{ meta: { count, cost_usd }, results: NormalizedPaper[] }`.
- Rate limit: 10/30 RPS; force 1 RPS when `query` is present (semantic search cap).
- Acceptance: a title query returns a DOI-bearing record with `openalex_id`;
  `meta.cost_usd` is surfaced; keyless and keyed both work.

### 6.2 `openalex-cite.js` — `openalex_citations`

- Input: `id` (OpenAlex ID or DOI), `direction` = `citations` | `references`,
  `limit` (1–100), `sort`.
- Implementation:
  - forward: `/works?filter=cites:<openalex_id>`
  - backward: read `referenced_works` from `/works/<id>`, then
    `/works?filter=openalex_id:<id1>|<id2>|…` (≤100 IDs)
- Output: normalized papers plus `direction` and `total`.
- Acceptance: forward and backward traversal of a seeded DOI both return ≥1 paper.

### 6.3 `semantic-scholar-search.js` — `s2_search`

- Endpoint: `https://api.semanticscholar.org/graph/v1`
- Auth: `S2_API_KEY` optional (`x-api-key`); 1 RPS with an intro key, so the
  limiter is mandatory.
- Modes:
  - `relevance` (default): `/paper/search?query=&limit=&fields=…`
  - `bulk`: `/paper/search/bulk` (up to 1000 per call; supports boolean queries)
  - `snippet`: `/snippet/search?query=` (~500-word full-text excerpts)
- Parameters: `query`, `mode`, `limit`, `year`, `publication_types[]`,
  `fields_of_study[]`, `open_access_only`, `min_citation_count`, `fields[]`
  (default includes `title,abstract,year,venue,authors,citationCount,
  influentialCitationCount,externalIds,openAccessPdf,tldr`).
- Optional companion flags: `with_citations`, `with_references` (adds one call
  each via `/paper/{id}/citations|references` when a single paper is targeted).
- Mapping: `paperId` → `s2_id`, `externalIds.DOI/PubMed/ArXiv`,
  `tldr.text` → `tldr`, `openAccessPdf.url`.
- Acceptance: relevance and snippet modes both return normalized papers; a keyed
  call never exceeds 1 RPS (verified by limiter test).

### 6.4 `crossref-lookup.js` — `crossref_lookup`

- Endpoint: `https://api.crossref.org/v1/works` and `/works/{doi}`
- Auth: none; polite pool requires `mailto`. Use `CROSSREF_MAILTO`, falling back
  to `UNPAYWALL_EMAIL`. Never fabricate an email; keyless public pool is allowed.
- Parameters: `doi` (single lookup) or `query` (`query.bibliographic`), `filter`,
  `rows` (≤100), `offset`, `sort`, `select`.
- Mapping: `DOI`, `title[0]`, `author[]` (`given`+`family`), `issued.date-parts`,
  `container-title[0]`, `is-referenced-by-count`, `link[]`, `license[]`,
  `abstract` (JATS XML → plain text).
- Acceptance: DOI lookup and bibliographic query both normalize; polite-pool
  `mailto` appears in the request URL when configured.

### 6.5 `arxiv-search.js` — `arxiv_search`

- Endpoint: `GET https://export.arxiv.org/api/query` (Atom 1.0 XML, no key).
- Parameters:
  - `query` plus `field` = `all` | `title` | `author` | `abstract` | `category`
    → `search_query=ti:"…"` etc. If `query` already contains a field prefix
    (`ti:`, `au:`, `abs:`, `cat:`, `id:`), pass it through unchanged.
  - `ids[]` → `id_list`
  - `max_results` (≤200 per request; page with `start`), `start`,
    `sort_by` (`relevance` | `lastUpdatedDate` | `submittedDate`), `sort_order`
- Parsing: use `fast-xml-parser` (pure JS, no native build) to parse Atom.
  If dependency policy rejects it, implement a ~60-line targeted parser for
  `entry`, `id`, `title`, `summary`, `author/name`, `published`, `updated`,
  `link[@title="pdf"]`, `arxiv:doi`, `arxiv:journal_ref`, `category@term`.
- Mapping: `id` → `arxiv_id` (strip `/abs/`), `link[rel=alternate]` → `url`,
  `link[title=pdf]` → `oa_url`, DOI from `arxiv:doi` when present.
- Rate limit: 3000 ms spacing, concurrency 1, enforced for the whole process.
- Acceptance: a fielded query and an ID-list query both work; two back-to-back
  calls are ≥3 s apart (limiter test).

### 6.6 `pubmed-search.js` — `pubmed_search`

Primary path is **Europe PMC** because it returns JSON, needs no key, and exposes
open-access full-text links.

- Endpoint: `GET https://www.ebi.ac.uk/europepmc/webservices/rest/search`
- Parameters: `query` (Europe PMC syntax, MeSH terms supported), `format=json`,
  `resultType` = `lite` | `core`, `pageSize` (≤1000), `cursorMark`, `sort`
  (`CITED desc` / `P_PDATE_D desc`).
- Mapping: `pmid`, `pmcid`, `doi`, `title`, `authorString` → authors,
  `journalTitle`, `pubYear`, `abstractText`, `citedByCount`,
  `isOpenAccess`, `fullTextUrlList.fullTextUrl[]`.
- Optional NCBI fallback: `esearch.fcgi` → `esummary.fcgi`/`efetch.fcgi` with
  `NCBI_API_KEY` (10 RPS) or keyless (3 RPS), `tool=academic-harness`,
  `email` from `NCBI_EMAIL` or `UNPAYWALL_EMAIL`. Expose as
  `source: 'europepmc' | 'ncbi'`, default Europe PMC.
- Acceptance: a MeSH query returns PMID + DOI where available; OA records carry
  a full-text URL; limiter honors the configured budget.

### 6.7 Phase 1 registration work

For each new module:

- `package.json` → add `"./<slug>": "./<file>.js"` to `exports` and the file to
  `files`.
- `settings-keys.js` → add keys to `KEY_FIELDS`:
  `OPENALEX_API_KEY`, `S2_API_KEY`, `CROSSREF_MAILTO`, `NCBI_API_KEY`,
  `NCBI_EMAIL`.
- `client/ApiKeysSection.jsx` → add rows under a new `Academic databases` group
  (label + hint; state which are optional). `lib/client.js` is generated by
  `npm run build` — do not edit by hand.
- `presets/academic-harness/agent.cordis.yml` → one row per module:
  `{ id: openalex-search, name: academic-harness/openalex-search }`, etc.
- `prompt.js` → new `## Academic databases` subsection under
  `## Literature and the web`, plus update the workspace-search exclusion list
  at `prompt.js:162` to name the new tools.
- `README.md` → add rows to `## Academic search` and `## API keys`.
- `scripts/test-phase7.mjs` → golden markers (module names, tool names, prompt
  markers, preset row names, package exports).
- Run `npm run build:patch` and `npm run build`; commit generated
  `cordis.patch.yml` and `lib/client.js`.

### 6.8 Phase 1 prompt routing

Proposed rule set (concise, because tool descriptions already carry detail):

> For peer-reviewed discovery, call `openalex_search` and `s2_search` first.
> Add `pubmed_search` for biomedical questions and `arxiv_search` for
> preprints/physics/CS. Use `consensus_search` for study-design filters and
> per-paper takeaways, and `parallel_search` (`basic`/`advanced`) for web +
> literature excerpts. Resolve every identifier with `paper_resolve` before
> citing. Use `openalex_citations` for forward/backward citation trails and
> `crossref_lookup` for canonical DOI metadata. Do not issue the same query to
> more than three sources in one round; prefer breadth across source types over
> duplicate strings.

### 6.9 Phase 1 acceptance criteria

- All five tools register on the Academic Harness preset and are absent from
  other presets.
- Keyless tools (OpenAlex, Crossref, arXiv, Europe PMC) work with no Settings
  entry; keyed tools return clear errors without a key.
- `paper_resolve` round-trips DOI → PMID → OpenAlex ID on a known paper.
- Normalizer and limiter unit tests pass; no network in tests.
- Prompt, README, preset, package exports, and golden markers all updated.

## 7. Phase 2 — cheap wins on existing capabilities

### 7.1 `brave-search.js` — `brave_search`

- Endpoint: `GET https://api.search.brave.com/res/v1/web/search`
- Auth: `BRAVE_API_KEY` required, header `x-subscription-token`.
- Parameters: `query`, `count` (≤20), `country`, `search_lang`, `freshness`
  (`pd`/`pw`/`pm`/`py`), `extra_snippets`, `result_filter`.
- Mapping: web results → normalized records with `source: 'brave'`; keep
  `profile.name`, `age`, and `extra_snippets` in a `snippets[]` field.
- Rate: 50 RPS → 20 ms; limiter default 100 ms to be safe.
- Prompt placement: Tier-1 fallback when Parallel is unset or erroring, and for
  independent index coverage. Not a literature tool.

### 7.2 `parallel-extract.js` — `parallel_extract`

- Endpoint: `POST https://api.parallel.ai/v1/extract`
- Auth: `PARALLEL_API_KEY` (`x-api-key`).
- Parameters: `urls[]` (≤20), `objective`, `search_queries[]`, `full_content`,
  `excerpt_settings`.
- Output: per-URL excerpt/full content.
- Rationale: parity with `mcp__parallel__web_fetch` from the native tool path;
  useful when the MCP connector is disabled or its standing mount is stale.

### 7.3 Firecrawl Research Index (steering only)

Firecrawl's free paper endpoints (`search_papers`, `related_papers`,
`inspect_paper`, `read_paper`) are reachable through the existing keyless
connector. **Verify at implementation time** that the mounted server actually
exposes them (`paper_mcp`-style status or a manual tool list); if it does not,
document them and skip the prompt change rather than advertising dead tools.

If available:

- Add one line to `prompt.js`: use `mcp__firecrawl__*paper*` for free paper
  discovery/reading when OpenAlex/S2 have no coverage, not as a primary index.
- Add a README note under the Firecrawl row.
- No new key, no new module.

### 7.4 Phase 2 acceptance

- Brave key absent → one clear error; present → normalized results.
- Parallel Extract works with the same key as `parallel_search`.
- Firecrawl paper-tool availability confirmed or explicitly deferred.

## 8. Phase 3 — web / AI-native breadth

Add one module per provider, all using `search-normalize.js` and `search-http.js`.

| Module | Tool | Endpoint | Key | Key params | Notes |
|---|---|---|---|---|---|
| `tavily-search.js` | `tavily_search` | `POST https://api.tavily.com/search` | `TAVILY_API_KEY` | `search_depth` (ultra-fast/fast/basic/advanced), `chunks_per_source` 1–3, `max_results` ≤20, `topic`, `time_range`, `include_domains` ≤300, `exclude_domains` ≤150, `include_answer`, `include_raw_content` | 2 credits when `advanced`; reject `chunks_per_source` with `ultra-fast` |
| `exa-search.js` | `exa_search` | `POST https://api.exa.ai/search` | `EXA_API_KEY` | `type` (auto/lite/deep-lite/deep), `numResults` ≤100, `includeDomains`/`excludeDomains`, `category`, `startPublishedDate`, `contents` | `lite` never fetches live pages; `people`/`company` reject date filters |
| `perplexity-search.js` | `perplexity_search` | `POST https://api.perplexity.ai/search` | `PERPLEXITY_API_KEY` | `query`, `max_results` ≤20, `country`, `search_type: fast` | Raw ranked results only; keep Sonar synthesis out of this tool |
| `jina-reader.js` | `jina_read` | `GET https://r.jina.ai/{url}` | `JINA_API_KEY` optional | `url`, `respond_with`, `token_budget`, `with_links` | 20 RPM keyless, 500 RPM keyed; also `https://s.jina.ai/?q=` for search |
| `linkup-search.js` (optional) | `linkup_search` | `POST https://api.linkup.so/v1/search` | `LINKUP_API_KEY` | `q`, `depth` (flash/fast/standard/deep), `outputType`, `includeDomains`, `maxResults` | `deep` costs 10× standard |
| `you-search.js` (optional) | `you_search` | `https://ydc-index.io` | `YDC_API_KEY` | `query`, `count`, `freshness`, `include_domains` | Keyless MCP profile exists but not usable from native path |
| `valyu-search.js` (optional) | `valyu_search` | `https://mcp.valyu.ai/mcp` | `VALYU_API_KEY` | MCP tools | Prefer MCP mount only if requested; adds tool-schema weight |

Do **not** add a second MCP mount per provider. If a provider only ships MCP,
either call its REST surface (when one exists) or skip it until a native HTTP
path is available.

Phase 3 acceptance: each new tool normalized, limiter-configured, key-gated,
documented, and golden-tested. No tool is added to the default prompt unless it
fills a tier gap; optional providers stay discoverable but unmentioned.

## 9. Phase 4 — gated verification and synthesis

These require paid or approved access and are lower priority.

| Module | Tool | API | Key | Scope |
|---|---|---|---|---|
| `core-search.js` | `core_search` | `https://api.core.ac.uk/v3/search/works` | `CORE_API_KEY` | Repository full texts; return inline `fullText` only on explicit `include_fulltext` |
| `elicit-search.js` | `elicit_search` | `POST https://elicit.com/api/v2/search/papers` (+ `/search/trials`) | `ELICIT_API_KEY` | 138M papers, study-type/year/quartile filters, retractions excluded |
| `futurehouse-agent.js` | `futurehouse_agent` | `https://api.platform.edisonscientific.com` (formerly FutureHouse) | `FUTUREHOUSE_API_KEY` | `agent` = quick_search / deep_search / precedent_search; async task + poll |
| `lens-search.js` (optional) | `lens_search` | `https://api.lens.org` | `LENS_TOKEN` | Patents + scholarly links |
| `dimensions-search.js` (optional) | `dimensions_search` | `https://app.dimensions.ai/api/dsl/v2` | `DIMENSIONS_KEY` | DSL v2; 30 RPM; two-step auth |

Elicit caution: 100 requests/minute per IP, then a 5-minute IP ban. The limiter
must be conservative (≥1 s spacing) and polling must be bounded.

Phase 4 acceptance: asynchronous providers return a task/status shape that the
agent can poll from a follow-up turn (same pattern as `paper_mcp` status), never
a blocking multi-minute call.

## 10. Phase 5 — routing, full text, self-hosted options

### 10.1 `literature-search.js` — `literature_search` (router)

The tutorial's `search_papers(source: ['openalex','crossref'])` model, extended.

- Parameters: `query`, `sources` (default `auto`),
  `year_min`/`year_max`, `open_access_only`, `max_results`, `include_abstracts`.
- `auto` routing:
  - biomedical terms/MeSH → OpenAlex + S2 + PubMed
  - preprint/CS/physics terms → OpenAlex + S2 + arXiv
  - otherwise → OpenAlex + S2 (+ Crossref for canonical metadata)
  - `consensus_search` / `parallel_search` remain separate tools for their
    distinct strengths; the router does not silently replace them.
- Execution: `Promise.allSettled` with per-source budgets; normalize; dedupe;
  return `{ papers, by_source, failures: [{ source, error }], truncated }`.
- A source failure never fails the whole call.
- Acceptance: a query returns deduped results from ≥2 sources; a forced failure
  of one source is reported in `failures` while the rest succeed.

### 10.2 Full-text retrieval

- Extend `paper_download` with `paper_fulltext`-style fallbacks in order:
  Unpaywall → Europe PMC OA link → CORE `fullText` → arXiv PDF.
- Keep the existing PDF magic-byte check and PaperMemory ingest.
- The tutorial's "no full-text retrieval tool" gap (line 674) closes here.

### 10.3 Self-hosted (optional, not default)

- Crawl4AI and SearXNG only behind an explicit user-configured base URL
  (`CRAWL4AI_BASE_URL`, `SEARXNG_BASE_URL`); never mount by default.
- These are documented as BYO-infrastructure, not shipped integrations.

## 11. File-level change checklist

Every phase repeats this set. Phase 1 files are listed explicitly.

| File | Change |
|---|---|
| `search-normalize.js` | New (Phase 0) |
| `search-http.js` | New (Phase 0) |
| `paper-resolve.js` | New (Phase 0) |
| `openalex-search.js`, `openalex-cite.js`, `semantic-scholar-search.js`, `crossref-lookup.js`, `arxiv-search.js`, `pubmed-search.js` | New (Phase 1) |
| `brave-search.js`, `parallel-extract.js` | New (Phase 2) |
| `tavily-search.js`, `exa-search.js`, `perplexity-search.js`, `jina-reader.js` (+ optional) | New (Phase 3) |
| `core-search.js`, `elicit-search.js`, `futurehouse-agent.js` (+ optional) | New (Phase 4) |
| `literature-search.js` | New (Phase 5) |
| `package.json` | Add each module to `exports` and `files`; add `fast-xml-parser` if approved |
| `settings-keys.js` | Add new keys to `KEY_FIELDS` |
| `client/ApiKeysSection.jsx` | Add Settings rows; generated `lib/client.js` via `npm run build` |
| `presets/academic-harness/agent.cordis.yml` | One row per native module |
| `prompt.js` | Routing rules in `## Literature and the web`; update tool list at line 162 |
| `README.md` | `## Academic search` table, `## API keys`, provider-by-provider notes |
| `scripts/test-phase7.mjs` | Golden markers for modules, tools, prompt, preset, exports |
| `scripts/test-search-normalize.mjs` | New unit tests (dedupe/merge/mappers) |
| `scripts/test-search-ratelimit.mjs` | New unit tests (spacing, backoff, 429) |
| `docs/SEARCH-PROVIDERS-PLAN.md` | This plan; update status as phases land |

Registration note: native modules are added to the **preset**, not `index.js`,
because they are academic-search capabilities, matching `consensus-search.js`.
Only cross-preset tools belong in `index.js`.

## 12. Verification plan

### Automated

1. `node scripts/test-search-normalize.mjs`
   - DOI/arXiv/PMID dedupe; field merge; title+year fallback.
   - Mapper fixtures for each Phase 1 provider (recorded JSON, no network).
2. `node scripts/test-search-ratelimit.mjs`
   - Two arXiv calls are ≥3000 ms apart.
   - 429 with `Retry-After: 1` waits ≥1 s and retries once.
   - Concurrency never exceeds 1 for arXiv.
3. `node scripts/test-phase7.mjs` (extended)
   - Each module exports `name` and registers the expected tool.
   - Preset rows and package exports exist.
   - Prompt markers exist.
4. `node scripts/build-cordis-patch.mjs --check` — generated patch is current.
5. `npm run build` — client bundle reproducible; `git diff --exit-code -- lib/`.

### Manual (live, per provider, using a scratch key)

| Provider | Smoke |
|---|---|
| OpenAlex | title query; DOI lookup; `group_by`; cursor page 2 |
| OpenAlex citations | forward and backward traversal of one DOI |
| Semantic Scholar | relevance + snippet; 1 RPS honored |
| Crossref | single DOI with `mailto`; bibliographic query |
| arXiv | fielded query + ID list; spacing verified |
| PubMed/Europe PMC | MeSH query; OA full-text URL present |
| Brave / Tavily / Exa / Perplexity | one query, normalized output |
| `paper_resolve` | DOI ↔ PMID ↔ OpenAlex ID round-trip |
| `literature_search` | multi-source dedupe; one forced source failure |

Do not add CI secrets. Live calls are manual and optional.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tool-schema bloat inflates the system prompt | Native tools over MCP mounts; ≤5 new tools per phase; descriptions short; optional providers not named in the prompt |
| Rate-limit violations (arXiv, S2, NCBI, Crossref) | Central `search-http.js` limiter; unit tests assert spacing |
| Normalization drift across providers | One `NormalizedPaper` contract + fixture tests per mapper |
| Keyless endpoints change or throttle | Clear errors + limiter; document key recommendation for OpenAlex/S2 |
| XML parsing fragility (arXiv) | Prefer `fast-xml-parser`; fallback targeted parser with fixtures |
| Firecrawl paper tools not actually exposed | Verify before advertising; defer if absent |
| Paid providers behind subscriptions | Phases 4–5 are opt-in; no default prompt dependency |
| Unpaywall `/v2/search` 410 / Bing retired / Google CSE sunset | Explicit non-goals; route text search to OpenAlex |
| Duplicate tools confuse routing (`search_papers` vs PaperMemory) | Router named `literature_search`; Firecrawl tools stay namespaced as `mcp__firecrawl__*` |
| `dsh` restart semantics for MCP mounts | New providers are native REST; only Phase 4 MCP-style providers inherit the standing-mount caveat |

## 14. Sequencing and scope

| Phase | Scope | Recurring cost | Ships independently |
|---|---|---|---|
| 0 | Normalizer, HTTP limiter, `paper_resolve` | none | yes (infra only) |
| 1 | OpenAlex (+ citations), S2, Crossref, arXiv, PubMed/Europe PMC | $0 (optional free keys) | yes |
| 2 | Brave, Parallel Extract, Firecrawl paper steering | Brave $5/1K; others as today | yes |
| 3 | Tavily, Exa, Perplexity, Jina (+ optional) | paid per call | yes |
| 4 | CORE, Elicit, FutureHouse (+ optional Lens/Dimensions) | subscription/approval | yes |
| 5 | `literature_search` router, full-text fallbacks, self-hosted | none new | yes |

Recommended release cadence: one minor version per phase (Phase 1 → `0.17.0`),
each with its own golden-test update and README section.

## 15. Task checklist

Phase 0 — done 2026-10-23
- [x] `search-normalize.js` with `NormalizedPaper` + dedupe/merge
- [x] `search-http.js` with per-provider limiter + retry
- [x] `paper-resolve.js` (DOI/PMID/OpenAlex/arXiv via S2)
- [x] Unit tests for normalize and limiter

Phase 1 — done 2026-10-23
- [x] `openalex-search.js` (`openalex_search`)
- [x] `openalex-cite.js` (`openalex_citations`)
- [x] `semantic-scholar-search.js` (`s2_search`)
- [x] `crossref-lookup.js` (`crossref_lookup`)
- [x] `arxiv-search.js` (`arxiv_search`)
- [x] `pubmed-search.js` (`pubmed_search`)
- [x] Settings keys: `OPENALEX_API_KEY`, `S2_API_KEY`, `CROSSREF_MAILTO`, `NCBI_API_KEY`, `NCBI_EMAIL`
- [x] Preset rows + package exports/files
- [x] Prompt routing + README
- [x] Golden tests + manual smoke

Implementation notes / deviations:
- `paper_resolve` returns `{ results: [{ input, resolved, paper }] }` (batch-friendly) instead of a single `{ resolved, papers }`.
- Identifier resolution uses per-identifier lookups; `/paper/batch` batching is left as a future optimization.
- Crossref `link[]` is treated as a landing/resource link, not an OA assertion; the normalized record carries no `license` field yet.
- OpenAlex `group_by` calls omit `select` (OpenAlex rejects the combination).
- Semantic Scholar without a key can return 429; tools surface that as a clear error, not "not found".
- Firecrawl Research Index check (2026-10-23): the keyless MCP mount exposes only `firecrawl_scrape`, `firecrawl_search`, and `firecrawl_parse`. The paper-index tools are not advertised or prompted for; the documented free endpoints remain REST-only/unavailable through this mount.
- Phase 2 adds `parallel_extract` and `brave_search`; `parallel_search` now also goes through the shared limiter/retry client.
- Phase 3 adds `tavily_search`, `exa_search`, `perplexity_search`, and `jina_read`. Jina Reader works keyless at 20 RPM; Jina Search (`mode=search`) requires `JINA_API_KEY`.
- Perplexity Search uses `search_type` values `web`/`fast`/`people` (verified against the 2026 API reference), not `standard`.
- Phase 4 adds `core_search`, `elicit_search` (papers + ClinicalTrials.gov), and `futurehouse_agent` (async start/status/cancel). CORE works keyless at ~10 requests/minute (verified `X-RateLimit-Limit: 10`); `include_fulltext` requires a key. Elicit requires Pro+.
- FutureHouse rebranded to Edison Scientific: the API is `https://api.platform.edisonscientific.com`, with PaperQA3 jobs (`job-futurehouse-paperqa3`, `-high`, `-precedent`), and auth is `POST /auth/login` then `/v0.1/crows` and `/v0.1/trajectories/{id}`. Verified against `edison-client` 0.17.0; an invalid key returns HTTP 403 from the live endpoint. A full task run still requires a valid key.
- Elicit calls are serialized at 1000 ms and never retried, because exceeding 100 RPM blocks the IP for five minutes.
- CORE requests use the trailing-slash endpoint (the non-slash URL returns a 301 that consumes quota) and are not retried.
- Phase 5 adds `literature_search`: auto = OpenAlex + S2, plus PubMed for biomedical and arXiv for preprint/CS/physics queries; Crossref is opt-in because its relevance ranking is noisy. Results are deduplicated and fused with reciprocal-rank fusion.
- The router converts free-text discovery queries into arXiv operator queries (`all:term AND ...`) instead of quoted phrases; quoted multi-word queries were returning zero arXiv results.
- `paper_download` now tries Unpaywall -> Europe PMC -> CORE -> arXiv, accepts `arxiv_id`, and treats `UNPAYWALL_EMAIL` as recommended rather than required. Fallback resolution is lazy (it stops at the first PDF that downloads), URLs are HTTP(S)-only, every redirect is revalidated, loopback/private/link-local/ULA targets are rejected, downloads are capped at 120s/100MB, and all fallbacks still pass the PDF magic-byte check and PaperMemory ingest.
- Self-hosted Crawl4AI/SearXNG integration is intentionally deferred (BYO infrastructure, not a default preset dependency).

Phase 2 — done 2026-10-23
- [x] `brave-search.js`
- [x] `parallel-extract.js`
- [x] Firecrawl paper-tool availability verified and documented

Phase 3 — done 2026-10-23 (core four; optional providers deferred)
- [x] `tavily-search.js`
- [x] `exa-search.js`
- [x] `perplexity-search.js`
- [x] `jina-reader.js`
- [ ] Optional: Linkup, You.com, Valyu, Serper, SerpApi

Phase 4 — done 2026-10-23 (core three; Lens/Dimensions deferred)
- [x] `core-search.js`
- [x] `elicit-search.js`
- [x] `futurehouse-agent.js`
- [ ] Optional: Lens, Dimensions

Phase 5 — done 2026-10-23 (optional self-hosted deferred)
- [x] `literature-search.js` router
- [x] Full-text fallback chain in `paper_download`
- [ ] Optional self-hosted Crawl4AI / SearXNG (BYO URL only)

Release
- [x] `npm run build:patch` + `npm run build`
- [x] `node scripts/test-phase7.mjs` and new search tests pass
- [x] README and this plan's status updated
- [x] Version bump to 0.17.0
- [x] Commit/push Phases 4–5; CI green (run 39935793768)
