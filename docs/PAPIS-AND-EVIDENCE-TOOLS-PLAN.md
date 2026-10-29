# Papis library and evidence tools — implementation plan

Status: **proposed, not implemented; decisions D1–D5 resolved** · baseline **v0.25.4** · target releases **v0.26.0 – v0.30.0**
> **Update:** Phase 1 (Papis library) is **superseded** by [`PAPERMEMORY-LIBRARY-PLAN.md`](PAPERMEMORY-LIBRARY-PLAN.md): the reference-library features go into PaperMemory, and Papis is used only as a design reference (not vendored, no GPL code). Decisions D1 and the Papis items in §0.2 and §2 no longer apply. Phases 2–5 below are unchanged.

Sibling plans: `docs/NON-SEARCH-TOOLS-PLAN.md` (conventions, review ledger, audits), `docs/SEARCH-PROVIDERS-PLAN.md` (router, limiters, normalizer)

This plan covers five additions, in delivery order:

| # | Addition | New tool? | Release |
|---|---|---|---|
| 1 | **Papis reference library** (programmable reference manager) | `papis` (1 tool) | v0.26.0 |
| 2 | **Preprint and domain-specific sources** (bioRxiv/medRxiv, DBLP, ACL Anthology, INSPIRE-HEP, NASA ADS, Scopus, Web of Science, Wikidata) | router adapters + `domain_search` (1 tool) | v0.27.0 |
| 3 | **Reporting-guideline checker** (CONSORT, STROBE, PRISMA, ARRIVE, TRIPOD, CARE, …) | `reporting_check` (1 tool) | v0.28.0 |
| 4 | **Risk-of-bias / critical-appraisal ledger** with dual-reviewer agreement | new `review` actions, no new tool | v0.29.0 |
| 5 | **Statistical power and sample size** | `power_analysis` (1 tool) | v0.30.0 |

Net new default tool schemas: **4** (design principle 3 of the non-search plan allows eight per phase group). Phases 2–5 are independent of each other; each depends only on Phase 0.

## 0. Why, and what was decided earlier

- **Reference manager.** `pyzotero` ships only as a skill; the earlier native Zotero bridge was **dropped** (non-search plan §6.2: Zotero's local API is off by default and a read-only bridge added little). Zotero desktop also failed to install on the user's machine. Papis is the replacement: it is a Python CLI, stores each entry as a plain `info.yaml` plus its files in a folder, needs no running app, no account, and no desktop GUI. That makes it scriptable, diffable, git-friendly, and testable offline. Papis ships **with the plugin** as a plugin-managed runtime (§2.4), so the user never installs it by hand.
- **Coverage.** The router covers OpenAlex, Semantic Scholar, PubMed/Europe PMC, arXiv, and Crossref. CS, high-energy physics, and astronomy are thin there, and `bioRxiv`/`medRxiv` are reachable only through the Europe PMC preprint filter.
- **Evidence gaps.** `review` has screening and evidence extraction but no risk-of-bias step; `stat_audit` checks reported statistics after the fact but nothing helps at design time; reporting-guideline compliance has no tooling.

All five follow the existing principles: native tools not MCP mounts, one tool per domain with an `action` parameter, keys resolved per call through `resolveEnv()`, append-only ledgers, no second source of truth, advisory outputs, and "unknown, never clean" on lookup failure.

### 0.1 Decisions (resolved)

| # | Decision | Effect on the plan |
|---|---|---|
| D1 | Papis is **bundled in the plugin as vendored source**, installed into a plugin-managed environment with its dependencies declared; its library is **global**. | `vendor/papis/` (GPL-3.0-or-later, licence kept); pinned dependency set; `NOTICE`, `package.json`, and README licence declarations updated; one library at `$DSH_HOME/papis/library` (§2). |
| D2 | **Scopus and Web of Science are used only when the user supplies a key** in the Settings UI. No key, no request. | Both adapters ship in v0.27.0 behind Settings fields; without a key they make **no network call** and return `key_missing`. The user is on UNSW VPN, so Scopus uses IP-based entitlement and needs no institution token (§3, §7). |
| D3 | Checklist items are **paraphrases only**. | No official wording is bundled; items link to the official source (§4.2). |
| D4 | The guideline and instrument sets in §4.2 and §5.2 are confirmed. | No change. |
| D5 | Power analysis uses **SciPy only**. | No new runtime dependency; `statsmodels` stays out of `pyproject.toml` (§6.3). |

### 0.2 Plugin-development constraints that apply to every phase

These are repository facts that have already caused real bugs (the v0.25.4 `inject` failure, the `tools[name] is not a function` preset error) and so are release-checklist items, not suggestions.

1. **Registration shape.** Every tool module exports `name`, `inject = ['tools']`, and `apply(ctx)` that calls `ctx.tools.register(defineTool(...))`. A module that registers through `ctx.tools` without `inject` fails every new session with `agent-preset/invalid ... cannot get property "tools" without inject`. Each new module gets a registration test (`test-registries.mjs`) that asserts `inject` is present.
2. **Preset scope.** All new tools are **preset-only**: a row in `presets/academic-harness/agent.cordis.yml`, then `npm run build:patch` regenerates `cordis.patch.yml`. A tool on a non-academic preset fails with `tools[name] is not a function`; the docs scope column says so.
3. **Packaging.** New files are listed in `package.json` `files` and `exports`. Data directories (`checklists/`, `appraisal/`) must be added to `files` too, or they are missing from the published npm package even though tests pass in the repo. A packaging test runs `npm pack --dry-run` and asserts every new path is included.
4. **No build step for server code.** Plain ESM JS. Only the Settings page uses a bundle: after editing `client/ApiKeysSection.jsx`, run `npm run build` and commit `lib/client.js`.
5. **Keys per call.** Resolve credentials with `resolveEnv()` inside the call so a Settings change applies on the next request; only whether an optional tool is mounted needs a restart.
6. **Runtimes are managed, pinned, and skippable.** Python/CLI runtimes follow `textfold-runtime.js` and `modal-runtime.js`: pinned version, `$DSH_HOME` venv, background prepare on first mount, `*_CLI`/`*_PYTHON` overrides, and `*_SKIP_INSTALL=1`. A missing runtime degrades to a clear error; it never blocks boot.
7. **No credential is needed to install or boot.** Every keyed source stays disabled until its key exists.
8. **Licences.** Papis is **GPL-3.0-or-later** and is **vendored** (decision D1). The plugin keeps Papis in its own directory with its full licence text and unmodified source, installs it into a separate venv, and talks to it only by subprocess (never imports it), so the plugin's own code remains MIT. Declarations: `vendor/papis/LICENSE` and `SOURCE.txt` (upstream URL, tag, commit, any local patch), a `NOTICE` entry, a `package.json` `license` of `"MIT AND GPL-3.0-or-later"` with an explicit `README` licence section, and a licence inventory for Papis's runtime dependencies (§2.4). Checklists are paraphrased, and `NOTICE` cites each guideline's source. Scopus and Web of Science terms are handled by the metadata-only rule (§3.6).
9. **Prompt budget.** Four new default tool schemas; the `prompt.js` sections stay short and say when *not* to use the tool.
10. **Seeder.** If a new skill supersedes an older first-party brief (for example `citation-management`), `seed.js` refresh rules must include the stale-content marker so existing installs receive it (see v0.25.3).
11. **Versioning.** One minor release per phase: bump `package.json`, add a `CHANGELOG.md` entry, update the docs index range, and update README counts (tools, skills).
12. **Verification before release.** The offline test scripts, then a real DSH boot (as `.github/workflows/verify.yml` does) to confirm the preset mounts, every new tool name appears, and no preset validation error is logged.

## 1. Phase 0 — shared groundwork and spikes

Do this before any tool code. Each spike produces a short note appended to this plan.

### 1.1 Spikes (verify what this plan could not confirm)

| Spike | Question | Decides |
|---|---|---|
| S1 | Papis 0.16.1 (vendored): vendored size and keep list; dependency set and licences; exact non-interactive flags for `add` (`--batch`, `--from doi/arxiv/bibtex`, `--folder-name`, `--no-open`/`--no-edit`), `update`, `rm`, `export --format json/bibtex/yaml`, `-c/--config`, `--set`, `-l`. Does any path still prompt when stdin is closed? | CLI argument contract in §2.4 |
| S2 | Papis's own Python API is documented as **not stable** across versions. Confirm which reads are safe to do by parsing `info.yaml` directly. | Read path in §2.3 |
| S3 | Per-source rate limits and auth headers: INSPIRE, DBLP, ADS, Scopus, Web of Science Starter, Wikidata, bioRxiv. | Limiter budgets in §3.5 |
| S4 | Elsevier and Clarivate API terms on caching, storing, and redistributing abstracts. | What `domain_search` may write to a ledger or PaperMemory (§3.6) |
| S5 | Reporting-guideline licensing and exact current versions (CONSORT 2010 vs CONSORT 2025, SPIRIT 2025, TRIPOD+AI 2024, ARRIVE 2.0, PRISMA 2020/PRISMA-S/PRISMA-ScR). Which item texts may be bundled. | Checklist data format and bundling (§4.2) |
| S6 | Inspect `ah_inventory` / `ah_units` output to learn how an `ah` project exposes `%% @unit` ids and source offsets. The vendored engine is **read-only for this plan** (RSI boundary). | Location mapping in §4.5 |
| S7 | G*Power and R `pwr` reference tables for golden test values; optional local-only cross-check (not a dependency). | Test fixtures in §6.6 |
| S8 | Cochrane RoB 2, ROBINS-I (v1 vs v2), QUADAS-2, Newcastle-Ottawa: current versions, signalling-question text, licence for bundling. | Appraisal templates (§5.2) |

### 1.2 Infrastructure changes

- `search-normalize.js`: add `fromBiorxivRecord`, `fromDblpHit`, `fromInspireHit`, `fromAdsDoc`, `fromScopusEntry`, `fromWosHit`; extend `emptyPaper` with `ids.bibcode`, `ids.inspire`, `ids.dblp`, `ids.acl`, `ids.scopus`, `ids.wos`, `ids.qid`; extend `identifierKind` with `bibcode`, `inspire`, `dblp`, `acl`, `qid`; keep `mergePapers` DOI → arXiv → title+year order.
- `settings-keys.js` (`KEY_FIELDS`) and `client/ApiKeysSection.jsx`: new keys (§7). Rebuild `lib/client.js`.
- `review-store.js`: schema change for multi-reviewer records (§5.3). Backward compatible.
- New shared module `agreement.js` (pure functions, used by screening and appraisal): percent agreement, Cohen's κ, weighted κ, with fixtures.
- `scripts/fixtures/`: recorded API responses per source (no network in tests).

## 2. Phase 1 — Papis reference library (`papis`)

### 2.1 What it does

A single action-multiplexed tool that manages a reference library backed by Papis, so the agent can add, find, tag, deduplicate, and export references without a GUI or a cloud account.

| Action | Behaviour |
|---|---|
| `status` | Runtime state (managed venv, version, library path, entry count, last error). Never installs. |
| `init` | Create or register a library directory and an isolated Papis config for it. |
| `add` | Add by DOI, arXiv ID, PMID, URL, BibTeX/RIS text, or local PDF. Identifiers resolve through `paper_resolve`/`crossref_lookup` first, metadata is written to `info.yaml`, the file is attached when open-access (`paper_download`). Returns the entry `ref`. |
| `list` / `search` | Query by free text or Papis `key:value` expressions; structured results, paged. |
| `get` | One entry's metadata, files, tags, notes, and linked PaperMemory id. |
| `update` | Set tags, collections, notes, or fields. Field edits are recorded in a sidecar change log. |
| `remove` | Delete an entry; requires `confirm: true` and moves it to `.trash/` first. |
| `dedupe` | Report duplicate groups (DOI, arXiv, PMID, normalized title+year); `merge: true` merges after explicit confirmation, never silently. |
| `import` | BibTeX, RIS, CSL-JSON, or a folder of PDFs; returns per-item added/skipped/failed. |
| `export` | BibTeX, CSL-JSON, RIS, YAML, or a Hayagriva file, for all entries or a query, to a workspace path. |
| `sync_ingest` | Push entries with attached PDFs into PaperMemory; store `pm_id` back in `info.yaml`. |
| `check` | Batch `integrity_check` over a query or the whole library; writes the status back as a field and returns the retracted/corrected list. |

### 2.2 Where data lives

- **Library:** **global**, `$DSH_HOME/papis/library/`, so references persist across projects and sessions (decision D1). `PAPIS_LIBRARY` (env-only, an absolute path) points the tool at an existing Papis library instead; it is never auto-detected, so a user's own library is only touched by deliberate choice. There is no workspace-local library mode.
- **Config:** a generated Papis config under `$DSH_HOME/papis/config`, passed explicitly with `-c`, so the user's own `~/.config/papis` is never read or changed unless `PAPIS_LIBRARY` is set deliberately.
- **Project membership:** a `collections` list in `info.yaml` (and a `project:` tag) rather than separate libraries, so one reference can serve several projects. `export` takes a collection and writes the project's `.bib`.
- **Sidecars:** `library/.ah/changes.jsonl` (append-only edit log) and `library/.ah/trash/`. Papis ignores them.

### 2.3 Read path versus write path

- **Reads** (`list`, `search`, `get`, `dedupe`, `export` to BibTeX/CSL-JSON) parse `info.yaml` directly with a pure-JS YAML parser plus a small in-memory index cached by folder mtime. This is fast, needs no Python process, works if the managed install is absent, and avoids Papis's unstable internal API (S2).
- **Writes and format conversion** shell out to the pinned Papis CLI (`add`, `update`, `rm`, `export --format …`) so file naming, id generation, and BibTeX-key logic stay Papis's own. The tool never imports the Papis Python API.
- If a `papis` write is unavailable (not installed, skipped), the tool reports `runtime_unavailable` with the install hint. Read actions still work.

### 2.4 Runtime

Mirror `textfold-runtime.js`:

- **Vendored source.** `vendor/papis/` holds the upstream Papis release (pinned tag and commit in `SOURCE.txt`, same convention as `vendor/papermemory/`), trimmed to what installation needs (package, `pyproject.toml`, licence); docs, tests, contrib, resources, and CI files are dropped to keep the npm package small. Spike S1 measures the size and fixes the exact keep list.
- **Dependencies declared and pinned.** Papis's runtime dependencies are listed from the vendored `pyproject.toml` into `vendor/papis-constraints.txt` (exact versions resolved and tested together). The managed install runs `pip install --constraint vendor/papis-constraints.txt <vendor/papis>` into the venv, so a user gets the tested set rather than whatever is newest. Optional extras are not installed. A licence inventory of those dependencies goes into `NOTICE`; any dependency whose licence is incompatible with redistribution is flagged in S1 before release.
- New `papis-runtime.js`: venv at `$DSH_HOME/papis/venv`, prepared in the background on first preset mount from the vendored tree; the tool awaits the same promise (the `papermemory-cli.js` / `textfold-runtime.js` pattern). Papis requires **Python 3.10 or newer**, so the runtime probes `python3` and reports `python_too_old` with the found version instead of failing mid-install. Overrides: `PAPIS_CLI`, `PAPIS_PYTHON`, `PAPIS_SKIP_INSTALL=1`.
- **Offline behaviour.** Installing needs the package index for the dependencies on first run; the vendored Papis itself needs no download. A seeded wheelhouse (`vendor/papis-wheels/`) is out of scope unless S1 shows the dependency set is small enough to bundle; an air-gapped install can set `PAPIS_CLI`.
- **Upgrades.** Changing the vendored tag bumps a `PAPIS_VENDOR_VERSION` constant; the runtime compares it with the venv's installed version and reinstalls when they differ, so plugin updates reach existing installs.
- Every invocation: closed stdin, `--batch`/non-interactive flags (S1), a hard timeout, bounded stdout/stderr, no shell string interpolation (argument array only), and `PAPIS_CONFIG`/`-c` pinned to the generated config.
- Seeder note: no `seed.js` change is needed because the library is not seeded.

### 2.5 Integration with existing tools

| Tool | Integration |
|---|---|
| `paper_resolve`, `crossref_lookup`, `paper_download` | `add` uses them to build metadata and attach an open-access PDF. |
| PaperMemory | `sync_ingest`; the entry stores `pm_id`. PaperMemory stays the evidence store; Papis stays the reference store (no second source of truth). |
| `citation` | `citation` gains a `source: "papis"` option for `format`/`validate`, reading entries via the library. Formatting logic stays in `citation-format.js`. |
| `manuscript_citations` | Optional `library: true` compares a manuscript's cite keys with the library, and reports keys missing from it. |
| `integrity_check` | `check` action. |
| `review` | `review add` accepts a Papis query as a record source. |
| `literature_search` | Result rows get an `in_library` flag (cheap DOI lookup in the index) so the agent does not re-add known papers. |

### 2.6 Safety and edge cases

- Paths are resolved through real paths and cannot escape the library or workspace (reuse `workspace-path.js`); `export` writes only inside the workspace.
- Cite keys are stable once exported: `update` refuses to change a key that appears in a `.bib` exported earlier unless `rekey: true`.
- Untrusted metadata (titles, abstracts from the web) is written as YAML scalars through a safe dumper, never concatenated; control characters and very long fields are stripped or capped.
- Concurrent writers (subagents) use `store-lock.js` on a library-level lock.
- `remove` and `dedupe merge` are the only destructive actions; both require `confirm: true` and are recoverable from `.trash/`.

### 2.7 Wiring and acceptance

Files: `papis.js`, `papis-runtime.js`, `papis-store.js` (index, YAML read, locking, sidecars), `package.json` exports and `files`, preset row (preset-only), `prompt.js` section `## Reference library`, `skills/papis-library/SKILL.md`, `skills/citation-management/SKILL.md` updated to prefer the native tool, `docs/PAPERS.md` and `docs/TOOLS.md` entries, `scripts/test-papis.mjs`.

Acceptance:
- With the CLI mocked, every action returns the documented shape; reads work with no Papis installed.
- A real-Papis smoke test (opt-in, like `test-paper-fold-live.mjs`) adds a DOI, finds it, exports BibTeX, and round-trips it.
- Duplicate detection catches DOI, arXiv, and title+year cases, and never merges without `confirm`.
- Path-escape, symlink, and key-stability tests pass.
- A failed install or CLI error is reported verbatim and never reported as success.

## 3. Phase 2 — preprint and domain-specific sources

### 3.1 Design

Two surfaces, no MCP mounts:

1. **Router adapters.** Each source becomes a `run<Source>Search` function that returns `NormalizedPaper[]`, and is added to `ALLOWED` in `literature-search.js` so it is fused with RRF and deduplicated across indexes. This adds no tool schema.
2. **`domain_search` tool** (preset-only, action by `source`) for features a generic search cannot express: ADS citation and reference lists, INSPIRE texkey and citation counts, DBLP venue/author browsing, bioRxiv date/category browsing and published-version lookup, Wikidata identity resolution.

Keyed sources (Scopus, Web of Science, ADS) are **built and shipped for everyone**, configured from the Settings UI. With no key the adapter returns a structured `key_missing` result that names the Settings field, rather than being absent or failing obscurely; the router skips it silently when sources are `auto`, and reports it when the user names it explicitly. Keyless sources are always available. Because keys resolve per call, pasting a key in Settings enables the source on the next request, with no restart.

### 3.2 Per source

| Source | Access | Adapter does | `domain_search` extras |
|---|---|---|---|
| **bioRxiv / medRxiv** | `api.biorxiv.org` has date-range, DOI, category, and published-version endpoints but **no keyword search**. | Keyword search goes through Europe PMC restricted to the preprint source and bioRxiv/medRxiv publisher (already used by `pubmed_search`); results are enriched from the bioRxiv API. | `browse` by date range and category, `doi` details, `published` (preprint → journal DOI, feeds `integrity_check` and `paper_resolve`), funder search. |
| **DBLP** | Public search API, keyless, JSON. Politeness limits; a 429 must back off. | Title/author/venue query; maps DBLP keys and venue strings. | `venue` and `author` listings, BibTeX per key. |
| **ACL Anthology** | No official keyword-search REST API. Covered through DBLP (ACL venues), Semantic Scholar's ACL external id, and OpenAlex. | No separate search adapter. `paper_resolve` learns the ACL id form; `paper_download` can fetch an Anthology PDF/BibTeX by id (confirm URL patterns in S3). | `acl` by id: BibTeX, PDF link, venue. |
| **INSPIRE-HEP** | Public REST API, keyless, JSON, BibTeX format option. | `q` query with fields for title, authors, eprint, DOI, citation count, texkeys. | `citations`, `references`, `texkey`, BibTeX. |
| **NASA ADS** | `api.adsabs.harvard.edu/v1`, bearer token, daily quota. | Query → bibcode, title, authors, year, DOI, citation count. | `citations`, `references`, `export` (BibTeX by bibcode), `metrics`. |
| **Scopus** | Elsevier API key (header). On the Scopus APIs the default authentication is institutional **IP-based**, so a key used from a machine on the UNSW network or VPN works with no institution token. Weekly quota with per-second throttling; HTTP 429 when exceeded. Licence limits what may be stored (S4). **Used only when a key is set in Settings.** | Title/abstract/keyword query → EID, DOI, title, venue, year, citation count. Abstracts are not persisted. | `author` (Scopus author id), `cited_by` counts only. |
| **Web of Science** | Clarivate API (Starter or Expanded, depending on the licence), API key header. The **Starter** API is the target: free tier limited to 50 requests per day and no times-cited; institutional plans can raise that and add times-cited. **Expanded** needs a subscription plan, so it is supported only if the key's plan allows it. **Used only when a key is set in Settings.** | Topic/title query → UID, DOI, title, venue, year, times cited. | `cited_by` where the tier allows. |
| **Wikidata** | Public SPARQL and entity-search endpoints; requires a descriptive User-Agent; query timeout. | Not a literature index and **not in the router**. | `resolve` a person, institution, journal, or paper to a QID with ORCID/ROR/ISSN/DOI cross-ids; read-only allowlisted SPARQL templates, no free-form query by default. Feeds `author_lookup` and `paper_resolve`. |

Each source's exact request parameters, auth header, and limits are confirmed in spike S3 before coding.

### 3.3 Routing

`chooseSources` gains field heuristics, kept conservative so the default fan-out does not grow noisily:

- CS/ML/NLP/security terms → add `dblp`.
- High-energy, particle, nuclear, string, gravitation terms → add `inspire`.
- Astro, cosmology, planetary, solar terms → add `ads` **only if a token exists**.
- Explicit `preprints`/`biorxiv`/`medrxiv` → `biorxiv`.
- `scopus`/`wos` are never auto-selected; they run only when named in `sources`, because they are quota-limited and licence-bound.
- A routing test (like `test-coscientist-routing.mjs`) checks that representative queries pick the intended sources and that the default for a generic query is unchanged.

### 3.4 Normalization and identity

Each adapter sets only the ids it actually has. `mergePapers` dedupes on DOI first, so an INSPIRE record and its arXiv or OpenAlex twin collapse. Source-specific ids (bibcode, INSPIRE recid, DBLP key, EID, WoS UID) are kept in `ids` so follow-up `domain_search` calls need no extra lookup. A source that errors contributes an `unavailable` note to the result, never a silent empty list.

### 3.5 Limiters and errors

Limiters go through `getLimiter(name, { minIntervalMs })` with budgets fixed in S3. Quotas for keyed sources (ADS, Scopus, WoS) are read from response headers when present and surfaced in the result (`quota_remaining`), and a quota error is reported as a quota error. All HTTP uses `fetchJson`/`fetchText`, with the SSRF revalidation the other providers use.

### 3.6 Licence-aware storage

For Scopus and Web of Science, `literature_search` returns metadata for the current turn but the tool marks records `licence: "restricted"`. `review add`, `papis add`, and PaperMemory ingestion accept these records only as identifiers (DOI) plus bibliographic fields, and strip abstracts and full text. The exact rule comes from S4.

Scopus entitlement follows the network the request leaves from. `domain_search` runs on the user's machine, so the UNSW VPN applies; it must never be run from `runpod_run`/`modal_run`/`vastai_run` workers, and the tool description says so. An entitlement failure (HTTP 401/403) is reported as `not_entitled` with that hint, never as an empty result.

### 3.7 Wiring and acceptance

Files: `biorxiv-search.js`, `dblp-search.js`, `inspire-search.js`, `ads-search.js`, `scopus-search.js`, `wos-search.js`, `wikidata-lookup.js`, `domain-search.js`, edits to `literature-search.js`, `search-normalize.js`, `paper-resolve.js`, `package.json`, preset row, `prompt.js`, `docs/SEARCH.md` (new "Domain sources" section), `docs/CONFIGURATION.md`, `scripts/test-domain-sources.mjs`, extended `test-search-normalize.mjs` and `test-search-ratelimit.mjs`.

Acceptance: recorded fixtures round-trip into `NormalizedPaper` for every source; cross-source duplicates collapse; keyed adapters return a structured `key_missing` result naming the Settings field (skipped silently under `auto`, reported when named), and work on the next call after a key is saved; a 429 backs off and is reported; routing tests pass; the default `literature_search` behaviour for a non-field-specific query is byte-for-byte unchanged.

## 4. Phase 3 — reporting-guideline checker (`reporting_check`)

### 4.1 What it does

Maps each item of a reporting guideline to the passage in a manuscript that satisfies it, and reports what is missing. It is a ledger plus deterministic verification, not a verdict engine: the model proposes, the tool verifies the evidence exists.

| Action | Behaviour |
|---|---|
| `list` | Available guidelines, versions, applicable study designs. |
| `suggest` | Candidate guidelines for a manuscript, with the matching terms shown. Never decides. |
| `start` | Open a check: `slug`, `guideline`, `manuscript` (path or PaperMemory id). Snapshots the manuscript hash. |
| `items` | The checklist with current status, optionally only unassessed or failing items. |
| `candidates` | For one item, ranked passages (section, offsets, excerpt) from the manuscript, found by section heuristics and BM25 over the item's cue terms. |
| `judge` | Record a verdict for an item: `reported`, `partial`, `not_reported`, `not_applicable`, with evidence. |
| `status` | Counts by verdict, items still unassessed, stale evidence. |
| `export` | Markdown, CSV, or a LaTeX supplementary table (item, verdict, section, line/page). |

### 4.2 Guidelines and checklist data

Checklists ship as versioned JSON in `checklists/<id>/<version>.json`. First set: **CONSORT**, **STROBE**, **PRISMA 2020** (with PRISMA-S and PRISMA-ScR as variants), **ARRIVE 2.0**, **TRIPOD+AI**, **CARE**, **STARD**. Later: SPIRIT, COREQ, SRQR, CHEERS, MOOSE, SQUIRE, and ML reproducibility checklists.

Each item: `id`, `section`, `short_prompt` (**a paraphrase, never the official wording**; decision D3), `cues` (terms/regexes for candidate retrieval), `applies_when` (optional condition, e.g. "randomised crossover"), `source_url`, `version`. Item numbering follows the official checklist so exports map to the published form, and every export links to the official source for the exact wording. Spike S5 now only confirms current versions and item numbering, and that bundling ids plus paraphrases is acceptable. Counts are reported by the tool from the data, not hard-coded in prose.

### 4.3 The evidence rule (core integrity property)

- Every item starts `unassessed`.
- `reported` and `partial` require an `evidence` entry: a **verbatim quote** and its location. The tool re-reads the manuscript and verifies the quote is a substring (after whitespace normalization) of the snapshot. A quote that does not appear is rejected, not stored.
- `not_reported` is a claim of absence, so it must list the `searched` terms/sections. It is stored as advisory, and flagged for author review.
- `not_applicable` requires a reason; it is listed separately in the export so a reader can challenge it.
- If the manuscript's hash changes after a verdict, affected evidence is re-verified on `status`; quotes that no longer match become `stale`.
- No automated "compliant" label: the export says "N of M items have verified evidence", never "complies with CONSORT".

### 4.4 Manuscript input

`.tex`, `.md`, `.txt`, `.docx`, and PDF (via `pdf_to_markdown`). Reuse the workspace-path and docx-reading code from `stat_audit` (`defusedxml` is already a helper dependency). LaTeX is stripped for matching but offsets are kept against the original so locations are real file positions.

### 4.5 Integration

- **`ah_*` projects:** when the manuscript is an `ah` project, locations are also expressed as `%% @unit` ids (from `ah_inventory`; S6). The vendored engine is **not modified**; `reporting_check` only reads. A later opt-in step could register the check as a gate rule through normal development, not at runtime.
- **PaperMemory:** the same tool can check a ingested paper from the library against a guideline when appraising others' work (used by `review` appraisal, Phase 4).
- **`research_template`/skills:** a new `reporting-guidelines` skill drives `suggest → start → candidates → judge → export` and tells the agent to delegate item batches to subagents, with the same position-controlled judging discipline as the tournament skill.
- **`notebook`:** each check logs start and export entries.
- **RSI:** a new task-class signal `reporting` (unverified-quote rejections, stale evidence) is added in a normal release.

### 4.6 Wiring and acceptance

Files: `reporting-check.js`, `reporting-store.js` (ledger under `<cwd>/.dsh/reporting/<slug>/`: `check.json`, `verdicts.jsonl`, `exports/`), `checklists/**`, `skills/reporting-guidelines/SKILL.md`, preset row, `prompt.js`, `docs/WRITING.md` and `docs/TOOLS.md`, `scripts/test-reporting-check.mjs`.

Acceptance: a fabricated quote is rejected; a verified quote is accepted across LaTeX, Markdown, and docx fixtures; editing the manuscript marks evidence stale; `not_reported` without `searched` is rejected; item ids in an export match the checklist file; `suggest` returns reasons and never selects one itself.

## 5. Phase 4 — risk-of-bias and appraisal ledger (extends `review`)

### 5.1 New `review` actions

`ACTIONS` grows from `start, add, screen, evidence, status, export` by:

| Action | Behaviour |
|---|---|
| `appraise` | Record a domain-level judgement (and optional signalling-question answers) for a record under a named instrument, by a named reviewer, with a supporting quote. |
| `reconcile` | Record a consensus or third-reviewer decision that supersedes disagreeing judgements; originals stay in the log. |
| `agreement` | Inter-reviewer agreement for screening or appraisal. |
| `appraisal_status` | Per-record and per-domain completeness, disagreements outstanding. |

`export` gains `format: "rob-table"` (per-study domain table, CSV/Markdown), `rob-summary` (counts by domain), and `rob-figure` (traffic-light and summary SVG via a Python helper using matplotlib, already a helper dependency).

### 5.2 Instruments

Templates in `appraisal/<instrument>/<version>.json`, with domains, optional signalling questions, allowed judgements, and the overall-judgement rule. First set: **RoB 2** (randomised trials), **ROBINS-I** (non-randomised interventions; v1 now, v2 after S8), **QUADAS-2** (diagnostic accuracy), **Newcastle-Ottawa** (cohort and case-control, star counts). Later: SYRCLE (animal), PROBAST (prediction models), AMSTAR 2 and ROBIS (reviews), JBI tools.

- Domain judgements are always entered by a reviewer. For RoB 2 and ROBINS-I, an **overall** judgement is derived by the documented rule from domain judgements (for RoB 2: any "high" → high; otherwise any "some concerns" → some concerns; otherwise low) and marked `derived`; a reviewer can override with a reason.
- Mapping signalling-question answers to a domain judgement via the official algorithms is a separable sub-phase (4b) done only if S8 confirms the algorithms can be reproduced and bundled exactly; until then signalling answers are stored as supporting detail only.

### 5.3 Dual-reviewer support (schema change)

Today `screening.jsonl` state is the latest event per `(record_id, stage)`, and a second screener must pass `override: true` — which erases the first screener's decision from the derived state. That cannot support agreement statistics.

Change, backward compatible:
- State is derived per `(record_id, stage, reviewer)`. Events with no `reviewer` are treated as reviewer `default`, so existing ledgers read identically.
- `deriveStatus` reports a record's **resolved** decision (reconciled, or unanimous, or pending/conflict) and a list of conflicts.
- `override` keeps its meaning but applies to the same reviewer's own earlier decision.
- New `appraisal.jsonl`, same append-only discipline, keyed `(record_id, instrument, domain, reviewer)`.
- `review start` accepts an optional `reviewers` list; with two or more, `status` shows conflicts and `reconcile` is available.
- Reviewer identity types: `human:<name>`, `ai:<model-or-agent>`. AI judgements are recorded and shown, but **agreement is computed human-vs-human by default**; AI-vs-human agreement is reported as a separate line and never merged into the human κ. This keeps the audit trail honest about who judged what.

### 5.4 Agreement statistics (`agreement.js`)

- Percent agreement; Cohen's κ for two raters on nominal categories (screening: include/exclude/maybe); linearly or quadratically weighted κ for the ordinal RoB scale (low < some concerns < high); an approximate confidence interval.
- Edge cases handled explicitly: κ undefined when expected agreement is 1, unequal category sets, single-category data, missing ratings (listwise, with counts reported), and prevalence/bias caveats noted in the output.
- Fleiss' κ for more than two raters is a later addition.
- Pure functions with golden fixtures taken from published worked examples.

### 5.5 Evidence rule

An appraisal judgement of `low` or `high` should carry a supporting quote and location; when the paper is in PaperMemory the quote is checked with `quote_check`, otherwise it is flagged `unverified`, matching how `review evidence` already works.

### 5.6 Wiring and acceptance

Files: `review-store.js` (reviewer-keyed state, `appraisal.jsonl`), `review.js` (new actions and schema), `agreement.js`, `appraisal/**`, `python-helpers/rob_figure.py`, `skills/systematic-review-ledger/SKILL.md` updated, new `skills/risk-of-bias-appraisal/SKILL.md`, `docs/RESEARCH.md`, `scripts/test-review-store.mjs` and `test-review-tool.mjs` extended, new `scripts/test-appraisal.mjs`, `scripts/test-agreement.mjs`.

Acceptance: ledgers created before this change read and export identically; two reviewers can both screen a record without `override`; conflicts appear in `status`; κ matches golden values; reconciliation preserves the originals; overall RoB 2 derivation matches the rule on a truth table; AI-vs-human agreement is never folded into the human κ.

## 6. Phase 5 — power and sample size (`power_analysis`)

### 6.1 What it does

| Action | Behaviour |
|---|---|
| `power` | Solve for one of `n`, `power`, `effect_size`, or `alpha`, given the other three. |
| `effect_size` | Convert between standardized effects and compute them from summary statistics: d, Hedges' g, r, f, f², η², odds ratio, risk ratio, h, w; from t/F/χ² with df. |
| `correct` | Multiple-comparison adjustment: Bonferroni, Holm, Hochberg, Benjamini–Hochberg, Benjamini–Yekutieli; adjusted p-values and rejected sets; also the per-test α to plan with. |
| `sensitivity` | Smallest detectable effect for a fixed n, or a power curve over a grid of n and effects. |
| `simulate` | Monte-Carlo power for designs without a closed form, with a required seed. |

### 6.2 Designs covered (closed form)

One-sample, paired, and two-sample t-tests (equal-variance, plus a Welch approximation noted as such); two-proportion and one-proportion tests; one-way ANOVA; chi-square goodness-of-fit and independence; correlation (Fisher z); multiple linear regression (f²); log-rank (event-driven, Schoenfeld); equivalence and non-inferiority (TOST) for means and proportions; clustered trials via a design effect with ICC; diagnostic-accuracy precision (CI width for sensitivity/specificity). `simulate` covers repeated measures, mixed models, and custom designs the user specifies as a small declarative spec, not arbitrary code.

### 6.3 Engine

A Python helper `python-helpers/power_helper.py` using `numpy` and `scipy` (noncentral t, F, χ² distributions), both already helper dependencies, with a fixed JSON in/out contract via `python-runtime.js`. **No new runtime dependency** (decision D5); `statsmodels` is not added to `pyproject.toml`. A developer may run it locally as a one-off cross-check against the golden tables (S7), but CI does not require it. Closed-form results are validated against G*Power and `pwr` reference values; simulations are validated by agreement with the closed form within Monte-Carlo error.

### 6.4 Integrity rules

- **Effect size needs a source.** `power` requires `effect_source` (`pilot`, `literature`, `smallest_effect_of_interest`, `convention`) and, for `literature`, a PaperMemory id or DOI. A bare "medium effect" is accepted only as `convention` and is labelled so in the output.
- **No post-hoc power.** If an effect size is described as the observed effect of the same study, the tool refuses power-from-observed-effect and explains why (it is a function of the p-value), and offers `sensitivity` or a confidence-interval statement instead.
- **Assumptions are printed.** Test, tails, α, variance assumption, allocation ratio, dropout inflation, and software method are echoed in every result and stored.
- **Round up, report the exact.** `n` is rounded up to an integer per group, with the unrounded value shown; dropout inflation is explicit and separate.
- **Advisory.** The output states it is a planning aid, not a substitute for a statistician where the design is complex.
- Results can be written to the `notebook`, and `ah_fact` can bind the planned `n` to the manuscript so the number in the text is checked against the plan.

### 6.5 Wiring and acceptance

Files: `power-analysis.js`, `python-helpers/power_helper.py`, `skills/power-and-sample-size/SKILL.md`, preset row, `prompt.js`, `docs/RESEARCH.md` (or `docs/WORKSPACE.md`), `docs/TOOLS.md`, `scripts/test-power.mjs`. The existing `preregistering-analysis` skill is updated to call it.

Acceptance: closed-form results match the reference tables within stated tolerance; solving for each of the four unknowns is self-consistent (feeding a result back reproduces the inputs); correction procedures match known examples; simulations are reproducible for a seed; post-hoc power is refused; a missing `effect_source` is rejected.

### 6.6 Test fixtures

Reference values come from S7 and are stored in `scripts/fixtures/power/` with the source cited next to each value. The helper's tests skip themselves when SciPy is absent, like the other helper tests.

### 6.7 Implementation status (Phase 5 — done)

Built on branch `power-analysis` as plugin v0.27.0: `power-analysis.js`, `python-helpers/power_helper.py` (NumPy + SciPy only), `skills/power-and-sample-size`, preset row, prompt section "Study planning", `scripts/test-power.mjs` with reference fixtures in `scripts/fixtures/power/reference.json`. Every acceptance item above is covered by a test.

Differences from the plan as written: `preregistering-analysis` is vendored third-party material, so it was not edited; the new skill points to it instead. Closed-form results match the published figures to the stated tolerance (for example two-sample t at d = 0.5 gives n = 63.77, rounded to 64; ANOVA, regression f², chi-square, two-proportion, and log-rank also match). The correlation test uses Fisher's z with the small-sample correction and can differ from G*Power's exact test by one subject, so its test accepts 84 or 85.

## 7. Settings, environment, and docs

New Settings keys (`KEY_FIELDS`, `client/ApiKeysSection.jsx` group "Domain sources"):

| Key | Used by | Required |
|---|---|---|
| `ADS_API_TOKEN` | ADS adapter, `domain_search` | Yes, for ADS |
| `SCOPUS_API_KEY` | Scopus | Only to use Scopus. Request at dev.elsevier.com; the key identifies the app and access follows your institution's entitlement (IP/VPN). |
| `WOS_API_KEY` | Web of Science | Only to use Web of Science. Create an application on the Clarivate Developer Portal; the plan (free Starter vs institutional) decides limits and fields. |

**Settings UI work (`client/ApiKeysSection.jsx`):** a new group **Domain sources** with the three fields above (ADS token, Scopus key, Web of Science key), each showing a one-line hint with the portal link, password-style masking like the existing keys, and a small status indicator (`configured` / `not set`). Saving follows the existing keys flow (`settings-keys.js` schema, `volatile()` fields, legacy-id migration untouched). The Chinese locale file `locale/zh.json` gets the same labels. After the change: `npm run build`, commit `lib/client.js`, and add a test that `KEY_FIELDS` contains the new names and that the schema round-trips them.

Env-only (infrastructure switches, not secrets): `PAPIS_LIBRARY`, `PAPIS_CLI`, `PAPIS_PYTHON`, `PAPIS_SKIP_INSTALL`. Keyless sources (bioRxiv, DBLP, INSPIRE, Wikidata, ACL) need nothing; `CROSSREF_MAILTO` and the existing polite-pool emails are reused where a provider asks for contact details. No credential is required to install or boot (README principle).

Docs updated per phase: `TOOLS.md`, `CONFIGURATION.md`, `SEARCH.md`, `PAPERS.md`, `WRITING.md`, `RESEARCH.md`, `CHANGELOG.md`, `README.md` (tool counts and the capability table), regenerated `cordis.patch.yml` (`npm run build:patch`) and `lib/client.js` (`npm run build`). The `docs:diagrams` set gets a new "reference library" diagram.

## 8. Testing strategy

- Every test is offline: recorded fixtures for HTTP, a mocked Papis CLI, and golden numerical tables.
- New scripts: `test-papis`, `test-domain-sources`, `test-reporting-check`, `test-appraisal`, `test-agreement`, `test-power`; extended `test-registries`, `test-nonsearch-tools`, `test-search-normalize`, `test-search-ratelimit`, `test-review-store`, `test-review-tool`, `test-optional-tools` (if any piece is optional).
- Opt-in live tests (not in CI): real Papis round trip; one live call per keyless source; keyed sources with scratch credentials.
- CI: add the new scripts to `.github/workflows/verify.yml` and the `DEVELOPMENT.md` list.
- Routing regression: a prompt-level test that a literature question still routes to the right tool and that tool count in the preset stays within budget.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Papis CLI flags or prompts change between versions | Pin the version; closed stdin plus `--batch`; read path does not depend on Papis at all; S1 documents the contract. |
| Papis Python API instability | Never import it; CLI and `info.yaml` only. |
| User's existing Papis config leaks into runs | Generated config passed explicitly; user config only via deliberate `PAPIS_LIBRARY`. |
| Licence limits on Scopus/WoS (and checklist text) | S4/S5 gates; metadata-only storage; paraphrased checklist items with outbound links. |
| bioRxiv API has no keyword search | Keyword path is Europe PMC; bioRxiv API used only for what it supports. |
| Quota exhaustion on keyed sources | Not auto-selected (Scopus, WoS); quota surfaced; clear errors. |
| Reporting checks give false assurance | Verified-quote rule, `not_reported` flagged advisory, no "compliant" label. |
| RoB overall rules implemented wrongly | Truth-table tests; derived values marked and overridable; signalling-question algorithms only if exactly reproducible. |
| Schema change breaks existing review ledgers | Reviewer-less events map to `default`; compatibility fixtures from existing ledgers. |
| Power results misused | Required `effect_source`, no post-hoc power, assumptions echoed, advisory text. |
| Prompt/schema bloat | Four new tools, action-multiplexed; keyed adapters return `key_missing` rather than erroring; prompt sections kept short. |

## 10. Delivery order and sizing

| Order | Phase | Size | Depends on | Release |
|---|---|---|---|---|
| 1 | Phase 0 spikes S1, S2 (Papis only) | S | none | — |
| 2 | Phase 1 Papis library | L | Phase 0 | v0.26.0 |
| 3 | Phase 0 spikes S3, S4 | S | none | — |
| 4 | Phase 2 domain sources (keyless first: bioRxiv, DBLP, INSPIRE, Wikidata, ACL; then ADS, Scopus, WoS) | L | S3, S4 | v0.27.0 |
| 5 | Phase 4 appraisal + dual-reviewer schema (before reporting, because it changes a persisted format) | M | S8 | v0.29.0 |
| 6 | Phase 3 reporting check | M | S5, S6 | v0.28.0 |
| 7 | Phase 5 power analysis | M | S7 | v0.30.0 |

Phases 3, 4, and 5 are independent and can run in parallel after Phase 2 if more than one person is working. Version numbers follow merge order, so swap them if 4 lands before 3.

## 11. Remaining open items

No product decisions are open. Two items are factual checks done in the spikes:

- **Q1.** S1 must confirm Papis's dependency licences are compatible with redistribution and measure the trimmed vendored size.
- **Q2.** S3/S4 must confirm, with a real UNSW-network key, that the Scopus search API returns results over the VPN with no institution token, and which Web of Science plan the key resolves to.

## 12. Explicit non-goals

- Zotero, Mendeley, or EndNote integration, and any cloud-sync reference service.
- Any GUI for the library, including Papis's own TUI and web app. Papis is used through its CLI and the plugin's programmatic tool only; those interfaces are not installed, documented, or supported.
- Scraping Google Scholar, ResearchGate, or publisher sites; Web of Science and Scopus through their official APIs only.
- Automatic "this paper complies / is low risk" verdicts; every output is evidence for a human decision.
- Changes to the vendored `ah` engine, the RSI evaluator, or `prompt.js` beyond adding sections for the new tools.
- Meta-analysis computation (pooling, forest/funnel plots); appraisal outputs feed it but it is a separate future plan.
