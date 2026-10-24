# academic-harness

[![verify](https://github.com/raktim-mondol/academic-harness/actions/workflows/verify.yml/badge.svg)](https://github.com/raktim-mondol/academic-harness/actions/workflows/verify.yml)
[![npm](https://img.shields.io/npm/v/academic-harness.svg)](https://www.npmjs.com/package/academic-harness)

Academic Harness as a **DeepSeek Harness** profile: the DSH web UI and DSH agent, with its scientific skills, living lab notebook, and specialist subagents.

## Install

Academic Harness 0.19 requires **DeepSeek Harness 0.2.1 or later**. Install DSH first:

```sh
npm install -g @deepseek-ai/dsh
dsh --version   # should report 0.2.1 or later
```

Without a global install, `npx @deepseek-ai/dsh web` also works. You need a working `dsh` CLI for either installation option below.

### Option A — Install from the DSH Web UI (recommended)

1. Start the DSH web UI (`dsh web`).
2. Open **Plugins → Add plugin**.
3. Paste one of these into the package field:

   | Source | Paste this |
   |---|---|
   | GitHub (recommended) | `github:raktim-mondol/academic-harness` |
   | npm registry | `academic-harness` — not published in v0.16.0; install from GitHub or a local checkout |
   | Local checkout | the absolute path, e.g. `/home/you/academic-harness` |

4. Click **Install**. Academic Harness is installed into the profile you are currently running, enabled by default, and appears under **Installed plugins**.
5. Start a new chat and confirm the preset selector reads **Academic Harness**.

The bundle patches the web-app layer, so the profile must already include `@deepseek-ai/dsh-web-app`; the standard `web` profile does. A local path must be absolute — the dialog does not expand `~` or resolve relative paths. Installing this way adds Academic Harness to your current profile; use Option B for a dedicated `academic-harness` profile. DSH only offers **Update** for its on-demand Official plugins, so update a UI-installed Academic Harness by removing and reinstalling it.

### Option B — Install a dedicated profile from the CLI

```sh
dsh plugin --profile academic-harness add github:raktim-mondol/academic-harness
```

This creates the `academic-harness` profile if it does not exist yet and adds Academic Harness to it. Start it with:

```sh
dsh --profile academic-harness
```

To update this profile later:

```sh
dsh plugin --profile academic-harness update academic-harness
```

For local plugin development, the same command accepts an absolute checkout path:

```sh
dsh plugin --profile academic-harness add /absolute/path/to/academic-harness
```

## Run

```sh
dsh --profile academic-harness
# or, if you use the shared launcher:
academic-harness
```

Opens the Harness web UI (typically `http://127.0.0.1:3080`).

### Renamed in v0.16.0

The repo, npm package, plugin, preset, profile, launcher, and product name were renamed from `dsh-researchcraft` / ResearchCraft to **Academic Harness**.

| Old | New |
|---|---|
| repo / package `dsh-researchcraft` | `academic-harness` |
| profile `researchcraft` | `academic-harness` |
| launcher `dsh-researchcraft` | `academic-harness` (old command stays as a transition alias) |
| preset `researchcraft` | `academic-harness` (legacy preset removed) |
| Settings → ResearchCraft API keys | Settings → Academic Harness API keys |
| env `RESEARCHCRAFT_*` | `ACADEMIC_HARNESS_*` (old names still honored) |

Existing dedicated profile:

```sh
node scripts/migrate-profile.mjs --profile researchcraft --to academic-harness --apply
dsh plugin --profile academic-harness install
```

The migration backs up the old profile, moves the dependency/bundle entries, merges the API-key config into the new entry, updates the preset default, and renames the profile directory. Sessions pinned to the removed legacy `researchcraft` preset do not resolve; start a new chat on Academic Harness. `dsh plugin --profile academic-harness update academic-harness` is the new update command.

**One DSH surface at a time.** `dsh-web`, `dsh-tui`, `dsh-martty`, and `academic-harness` share `$DSH_HOME` (including port `3080` and the zvec-grep daemon). Ctrl+C does not always wait for those to exit, so starting another launcher while one is still in the background will fail or pick up the wrong process. The shared launcher (`scripts/dsh-launch`, installed as those four commands plus the transition alias `dsh-researchcraft`) stops leftover DSH processes and `zg server off` before exec. If you invoke `dsh --profile …` directly, stop the previous one first:

```sh
# leftover web UI
ss -ltnp | grep 3080
# leftover zg daemon
zg server off
```

The Academic Harness profile's bundle patch sets `agent-preset-registry` `default: academic-harness` and inserts only `preset-academic-harness` (DSH 0.2+ no longer reads `$DSH_HOME/.agent-presets/`). New chats on this profile start on **Academic Harness**, and the selector lists no legacy preset. Confirm the preset selector at the top of the message box reads "Academic Harness"; if it still says Standard/PTC, the profile patch did not apply.

The persona, the longer research system prompt (notebook discipline, specialist roster, connector guidance, …), academic search (`mcp__parallel__*`, `parallel_search`, `mcp__firecrawl__*`, `mcp__scite__*`, `consensus_search`), PaperMemory (`mcp__papermemory__*`), workspace semantic search (`mcp__zvec_grep__zvec_grep_search`), `paper_mcp` (Paper2Agent stdio mounts), `citation`, `manuscript_citations`, `review` (systematic-review ledger), `clinicaltrials`/`openfda` (trial and regulatory records), `dataset_search`/`journal_policy`/`funder_policy` (datasets and venue/funder policy), and the optional `author_lookup`/`openreview` are only present on this preset — a session left on Standard/PTC won't have them, and asking it to use e.g. the Parallel connector will fail with `tools[name] is not a function`. The general-purpose tools below (notebook, image_generate, sci_inspect, latex_compile, mermaid_render, pdf_to_markdown, modal_run/runpod_run, workflow) are available on every preset regardless, since they're registered at the plugin/bundle level rather than inside the Academic Harness preset. Native `grep` / `glob` come from the Academic Harness preset's filesystem-search row.

## What it adds

- **Academic Harness agent preset** — persona, research system prompt (notebook discipline, specialist roster, connector guidance), standard coding tools, and the academic search connectors below. This profile defaults to it — see [Run](#run).
- Scientific skills catalogue vendored into `skills/` from open-source catalogues, bundled with the plugin like the specialist briefs below — no separate checkout or setup needed (see [NOTICE](NOTICE) for exactly what was changed vs. each source):
  - 140 domain skills (chemistry, genomics/bioinformatics, imaging, stats, ML, writing, …) — [`scientific-agent-skills`](https://github.com/K-Dense-AI/scientific-agent-skills)
  - 16 research-discipline/methodology skills (question framing, pre-registration, verification-before-claiming, red-team review, …) — [`science-superpowers`](https://github.com/K-Dense-AI/science-superpowers)
  - 503 profession-specific expert-reasoning skills (accelerator-physicist, zoologist, actuarial-scientist, …), converted from AGENTS.md profiles — [`scientific-agents`](https://github.com/K-Dense-AI/scientific-agents)
  - 23 small-molecule/protein-therapeutics skills (autodock-vina, retrosynthesis, protein-binder-design, …) — [`drug-discovery-agent-skills`](https://github.com/K-Dense-AI/drug-discovery-agent-skills)
  - a `docx-editor-zotero` skill (edit `.docx` files without breaking Zotero citations) — adapted from [`claude-scientific-writer`](https://github.com/K-Dense-AI/claude-scientific-writer)
  - an `agentic-data-science-pipeline` skill (plan/review/implement/verify/reflect loop for large multi-stage tasks) — adapted from [`agentic-data-scientist`](https://github.com/K-Dense-AI/agentic-data-scientist)
  - a `hyperparameter-optimization` skill (pre-registered, verify-before-claiming search loop for tuning a DL/LLM model) — adapted from [`karpathy`](https://github.com/K-Dense-AI/karpathy)
  - a `scientific-figure-making` skill (publication matplotlib house style + helpers for bars/trends/heatmaps) — adapted from [`figures4papers`](https://github.com/ChenLiu-1996/figures4papers)
  - a `diagram-design` skill (39 editorial HTML+SVG diagram types; no Mermaid slop) — vendored from [`diagram-design`](https://github.com/cathrynlavery/diagram-design)
  - a `generating-scientific-hypotheses` skill (literature-grounded hypothesis generation: search-checked novelty, ranked falsifiable cards) — first-party, distilled from Gottweis et al. / Ghareeb et al. 2026 (see [NOTICE](NOTICE))
  - a `paper2agent` skill (turn a paper and/or its code repo into a reviewed paper skill and a tested FastMCP server) — vendored from [`Paper2Agent`](https://github.com/jmiao24/Paper2Agent) — see [Paper agents](#paper-agents-paper2agent)
  - a `remove-ai-signs` skill (density-based prose style editing: AI-ish vocabulary clusters, formulaic rhythm, hedging boilerplate; preserves meaning, numbers, and citations) — adapted from the local skill of the same name, whose guide adapts Wikipedia's "Signs of AI writing" (CC BY-SA 4.0). It is a style pass, not a detector-evasion tool

  `ACADEMIC_HARNESS_SKILLS_DIR` (or a `~/scientific-agent-skills/skills` checkout) still works as an override if you want a different catalogue instead — available on every preset; the old `RESEARCHCRAFT_SKILLS_DIR` name is still honored as a fallback
- `notebook` tool — log, read, and export a living lab notebook (JSONL under `<cwd>/.dsh/notebook/`), shared across a subagent delegation tree, with a zip-bundle export alongside the plain Markdown one — every preset
- `scientific_result` tool — a structured, schema-validated "final finding" card (table or statistical-test), distinct from the notebook's running log — every preset
- Specialist briefs (code-reviewer, literature-researcher, …) for the DSH `subagent` tool, plus `subagent_pro` and `subagent_vision` — two more delegation tools pinned to a different model for unusually heavy reasoning and image-reading tasks respectively — see [Subagent model routing](#subagent-model-routing) — every preset
- `image_generate` tool for conceptual scientific figures (Gemini "nano banana" by default) — every preset
- `sci_inspect` tool for scientific file formats (chemistry, structure, mass spec, arrays, imaging, AnnData) — every preset
- `latex_compile` tool (`.tex` → PDF, bibtex/biber-aware) — every preset
- `mermaid_render` tool (Mermaid text → SVG, via [Pele](https://github.com/obsidianmd/pele), no browser or mermaid-cli) — every preset
- [Academic Harness engine](docs/ACADEMIC-HARNESS-ENGINE.md) — writing oracle for LaTeX papers, grants, theses, literature reviews, and rebuttals: native `ah_*` tools, paper-state card, protected-path guard, post-edit checks, and a gate that settles a writing turn. The engine is vendored inside this plugin (`vendor/academic-harness`); Pi is not required. Inactive outside a tree with `ah.yaml` — **Academic Harness preset only** — see [Academic Harness engine](#academic-harness-engine)
- `pdf_to_markdown` tool (PDF → Markdown, via [pdf-inspector](https://github.com/firecrawl/pdf-inspector)) for literature-survey conversion of downloaded papers — every preset
- `runpod_run` (works with its API key) and `modal_run` (needs the optional `modal` SDK installed in the profile) for remote GPU/CPU compute offload, plus bundled `modal`/`runpod` skills covering the rest of each CLI (Serverless endpoints, volumes/secrets, Hub templates, …) — see [Remote compute](#remote-compute) — every preset
- `research_template` tool over a ~330-template research-task catalogue (not DSH's Rhai `workflow` orchestrator) — every preset
- Literature and web search: a `literature_search` multi-source router plus OpenAlex, Semantic Scholar, Crossref, arXiv, PubMed/Europe PMC, CORE, Elicit, FutureHouse, Consensus, Parallel, Brave, Tavily, Exa, Perplexity, and Jina Reader (native REST tools), plus Parallel, Firecrawl, and Scite (MCP connectors), `parallel_extract` (URL extraction), and `paper_download` (Unpaywall open-access PDF resolver) — **Academic Harness preset only**
- Paper integrity: `integrity_check` (retraction / expression-of-concern / correction status from Crossref + OpenAlex, with the notice DOIs) — **Academic Harness preset only**
- Reference and citation: `citation` (APA/Vancouver/Harvard/IEEE/Chicago/MLA formatting, BibTeX/RIS export, DOI→BibTeX, and validation) and `manuscript_citations` (manuscript ↔ `.bib` consistency: missing, unused, and duplicate keys, undefined `\ref` targets) — **Academic Harness preset only** — see [References and citation](#references-and-citation)
- Systematic reviews: `review` (protocol, record intake, two-stage screening, verbatim evidence, PRISMA-style counts, exports) — **Academic Harness preset only** — see [Systematic reviews](#systematic-reviews)
- Hypothesis tournaments: `coscientist` + `coscientist_rank` (a persistent generate → review → rank → evolve loop with a Glicko-2 leaderboard, five-stage review, duplicate gate, step budget, and dual-use withholding), plus the `co-scientist-tournament` skill — **Academic Harness preset only** — see [Hypothesis tournaments](#hypothesis-tournaments)
- Clinical and regulatory evidence: `clinicaltrials` (ClinicalTrials.gov trials and posted results) and `openfda` (adverse events, recalls, 510(k), labels, food events) — **Academic Harness preset only** — see [Clinical and regulatory evidence](#clinical-and-regulatory-evidence)
- Datasets and venue policy: `dataset_search` (DataCite discovery, Zenodo/Figshare file listings), `journal_policy` (DOAJ + Sherpa Romeo OA/self-archiving policy), and `funder_policy` (OpenAlex funder identity + Sherpa Juliet OA policy) — **Academic Harness preset only** — see [Datasets and journal policy](#datasets-and-journal-policy)
- `paper_mcp` tool — register a Paper2MCP stdio server from this workspace (`<cwd>/.dsh/paper-mcps.json`) so its tools can appear as `mcp__<serverName>__*` — **Academic Harness preset only** — see [Paper agents](#paper-agents-paper2agent)
- [PaperMemory](https://github.com/raktim-mondol/papermemory) local academic memory: `mcp__papermemory__*` (search, ingest, cite, cite-check, recap, remember, claim). First Academic Harness start uses `papermemory` on PATH or installs the vendored package into `~/.dsh/papermemory`. `paper_download` auto-ingests the saved PDF. Store: `~/.local/share/papermemory/papermemory.db` — **Academic Harness preset only** — see [Paper memory](#paper-memory)
- Workspace semantic search via [zvec-grep](https://github.com/zvec-ai/zvec-grep): `mcp__zvec_grep__zvec_grep_search` (local BM25 + vectors). First Academic Harness start installs the `zg` CLI into `~/.dsh/zvec-grep`. Indexing is **off at session start by default** (Settings → Index at session start); you can index later from chat, and the agent asks first when semantic search would help. While indexing, a progress bar with estimated time and Cancel is shown (no timeout) — exact lookup stays on native `grep` / `glob` — **Academic Harness preset only** — see [Workspace search](#workspace-search)
- Bundled `agent-browser` skill for interactive web browsing (navigate, log in, fill forms, download datasets), with screenshots delegated to `subagent_vision` — see [Browsing the web](#browsing-the-web) — every preset
- A **Settings → Academic Harness API keys** page for the connectors and models above — no shell env vars required. PaperMemory needs no key.

## API keys

Every credential below (`PARALLEL_API_KEY`, `FIRECRAWL_API_KEY`, `CONSENSUS_API_KEY`, `SCITE_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `PERPLEXITY_API_KEY`, `JINA_API_KEY`, `CORE_API_KEY`, `ELICIT_API_KEY`, `FUTUREHOUSE_API_KEY`, `UNPAYWALL_EMAIL`, `OPENALEX_API_KEY`, `S2_API_KEY`, `CROSSREF_MAILTO`, `NCBI_API_KEY`, `NCBI_EMAIL`, `GEMINI_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `RUNPOD_API_KEY`, `ZVEC_GREP_API_KEY`) can be set two ways:

- **Settings → Academic Harness API keys** in the DSH web UI — type a key, Save. Persisted in the profile's `settings.yaml`; a blank field always means "keep the current value", Clear removes it.
- **Shell environment variable** — takes priority over Settings when both are set.

The same Settings page also has an **Image model** dropdown for `IMAGE_MODEL` — not a credential, so it isn't password-masked and applies immediately on selection rather than needing Save (see [Image generation](#image-generation)). It also has two more model-id dropdowns, **Complex-task model** (`SUBAGENT_MODEL_COMPLEX`) and **Image-reading model** (`SUBAGENT_MODEL_VISION`) — not credentials either, but these two behave like the MCP connectors below, not like Image model: they need a restart to apply (see [Subagent model routing](#subagent-model-routing)). **zvec-grep embedding** (`ZVEC_GREP_EMBEDDING`) is the same restart-needed dropdown: it is passed into `zg server on` at mount time. **Index at session start** (`ZVEC_GREP_AUTO_INDEX`, default No) is live for the next Academic Harness session — no restart (see [Workspace search](#workspace-search)).

Tools that call `resolveEnv()` per invocation (`image_generate`, `modal_run`, `runpod_run`, `consensus_search`, `parallel_search`, `parallel_extract`, `brave_search`, `tavily_search`, `exa_search`, `perplexity_search`, `jina_read`, `core_search`, `elicit_search`, `futurehouse_agent`, `paper_download`, `openalex_search`, `openalex_citations`, `s2_search`, `crossref_lookup`, `arxiv_search`, `pubmed_search`, `paper_resolve`, `integrity_check`, `citation`, `review`, `clinicaltrials`, `openfda`, `dataset_search`, `journal_policy`, `funder_policy`, `author_lookup`, `coscientist`) pick up a Settings change on the very next call, no restart needed.

The **Hypothesis tournament** group on that Settings page holds four optional numbers, not credentials: `CO_SCIENTIST_MAX_HYPOTHESES` (default 5) and `CO_SCIENTIST_STEP_BUDGET` (default 36) cap what one tournament may spend — 5 is the smallest pool that survives a review veto and a withholding without stalling, and 36 is what a 5-pool needs to end on converged rankings (≈8 generations + 5 reviews + 15 matches) rather than on the budget. `CO_SCIENTIST_DUP_THRESHOLD` (default 0.7) is the similarity at which `coscientist add` discards a near-duplicate (`1` turns the gate off), and `CO_SCIENTIST_SEED` makes a tournament's sampled task schedule reproducible. An explicit argument to `coscientist start` always wins over the stored value.

The MCP connectors (Parallel, Firecrawl, Scite, zvec-grep, PaperMemory) and the two subagent-model fields are different: the `academic-harness` agent preset mounts once as a standing composition shared by every chat session for the life of the running `dsh` process, so a change only reaches them after you **stop and restart `dsh` itself** — a new chat session on the same running process is not enough. `consensus_search`, `parallel_search`, and the academic database tools aren't MCP connectors — see below — so they don't have this restart requirement.

**Also make sure the chat session is actually on the Academic Harness preset.** The MCP connectors, native academic-search tools (`literature_search`, `openalex_search`, `openalex_citations`, `s2_search`, `pubmed_search`, `arxiv_search`, `crossref_lookup`, `paper_resolve`, `integrity_check`, `consensus_search`, `parallel_search`, `parallel_extract`, `brave_search`, `tavily_search`, `exa_search`, `perplexity_search`, `jina_read`, `core_search`, `elicit_search`, `futurehouse_agent`), `mcp__zvec_grep__zvec_grep_search`, and `mcp__papermemory__*` are wired into the `academic-harness` agent preset only; a session left on the default preset (Standard/PTC/etc.) has none of them, and calling one fails with `tools[name] is not a function`. Check the preset selector next to the session title (top of the message box for a new chat, top-left of an existing one) reads "Academic Harness" before asking the agent to search.

## Workspace search

[zvec-grep](https://github.com/zvec-ai/zvec-grep) (`zg`) is the local-first hybrid search layer on the Academic Harness preset: BM25 + vectors over an on-disk index, exposed as `mcp__zvec_grep__zvec_grep_search`. Exact words, quotes, identifiers, filenames, regexes, and exhaustive hit lists stay on the preset's native `grep` / `glob` (`@deepseek-ai/dsh-tool-fs-search`). Open-web and literature search stay on the academic database tools (`literature_search`, `openalex_search`, `s2_search`, `pubmed_search`, `arxiv_search`, `crossref_lookup`), Parallel, Consensus, Firecrawl, and Scite — zg is workspace-only.

You do **not** install `zg` yourself. The first time the Academic Harness preset mounts after `dsh plugin add`, the plugin runs `npm install --prefix ~/.dsh/zvec-grep @zvec/zvec-grep@^0.2.2`, starts `zg server on` (the loopback daemon), and mounts search over Streamable HTTP at `http://127.0.0.1:7999/mcp` — no second restart. That first start can take several minutes (npm + later the ~130 MB Potion model). Later starts reuse `~/.dsh/zvec-grep`, **upgrade it if the bundled copy is older than 0.2.2**, and start the daemon again. Stopping `dsh` runs `zg server off`, so the daemon does not stay up in the background. Override with `ZVEC_GREP_CLI` if you already have a `zg` binary you want to keep. If install or the daemon fails, the rest of the preset still loads and the search tool is absent (a warning is logged).

The plugin talks to the daemon over HTTP (DSH's MCP client is Streamable HTTP), not `zg server --stdio`. 0.2.2+ also fixes the stdio heartbeat race ([zvec-grep#106](https://github.com/zvec-ai/zvec-grep/issues/106)); HTTP remains the mount we use.

Indexing is **opt-in**. Settings → Academic Harness API keys → **Index at session start** defaults to **No**. When No (the default), a new chat does not index; you can still type “index this workspace” in the chat, and whenever semantic search would help the agent asks first (and only indexes if you say yes). When Yes, opening an Academic Harness session indexes **that workspace** in the background if no index exists yet (`zg index --embedding local/potion-retrieval-32m`, local, no API key).

While an index runs — from session start or from chat — the UI shows a **progress bar with estimated time** in Settings and in the session header, and **Cancel** is always available. There is **no timeout**. Existing indexes are left alone (no silent rebuild/drop). Home directory and `/` are not indexed. Indexes live in `<cwd>/.zvec-grep/`; the model cache is `~/.zvec-grep/models` (~130 MB once).

`zvec_index action=start` accepts an `exclude` array of zg `-g` globs (for example `["!tmp/**", "!*.log"]`). PaperMemory runtime paths under the index root — the store directory's `corpus/`, `*.db*` (SQLite + WAL/SHM), `evidence/`, and `PAPERMEMORY_EVIDENCE_DIR` — are excluded automatically. Still prefer a `PAPERMEMORY_DB` outside the indexed workspace; the automatic exclusions cover the accidental case. Exclusions apply when a job starts: if an index for the same root is already running, `action=start` joins it with its original globs rather than restarting.

zg is **fail-soft**, PaperMemory is **fail-loud**. If the zg install or daemon fails, semantic search is simply absent and a warning is logged; that says nothing about PaperMemory, which surfaces its own startup failure and 14-tool drift. Never read a missing zg tool as missing memory. Paper markdown in the workspace is indexed by zg for *discovery*; evidence for claims, numbers, and quotations always comes from PaperMemory (`cite`, `quote_check`, `trace`, `get`). Ingest stores a separate corpus copy, so keep the workspace file for zg and review — do not delete it after ingest.

```sh
# only if you want to index by hand or pick a different local model
zg index --embedding local/potion-retrieval-32m    # default — papers / notes / mixed
zg index --embedding local/potion-code-16m-v2      # smaller (~65 MB model), code-heavy trees
zg status --check-ready
```

Every MCP call needs an **absolute** `root` (the session working directory). Relative paths fail. The native `zvec_index` tool (`start` / `status` / `cancel`) is what the agent uses instead of shelling out to `zg index`.

| Setting / env | What it does |
|---|---|
| `ZVEC_GREP_AUTO_INDEX` | `yes` / `no`. Index this workspace when an Academic Harness session opens. Default `no`. Live for the next session (no restart). |
| `ZVEC_GREP_EMBEDDING` | Default model id for *new* indexes. Unset means `local/potion-retrieval-32m`. Existing indexes keep their stored model. Restart `dsh` after changing — the next start brings up a fresh daemon with the new value. |
| `ZVEC_GREP_API_KEY` | **Not used** with the default local Potion models. Only if you opt into a remote (Qwen) embedding provider. |
| `ZVEC_GREP_CLI` | Absolute path to `zg` or to `@zvec/zvec-grep`'s `dist/cli/index.js`. Env only. |

The loopback daemon under `~/.zvec-grep/daemon/` is started with the Academic Harness preset and stopped when `dsh` exits. You do not need `zg server off` by hand.

Install, index, and routing details for the agent are in the bundled `zvec-grep` skill (`skills/zvec-grep`).

## Academic and web search

Three literature/web MCP servers are wired into the `academic-harness` preset and surface as `mcp__parallel__*`, `mcp__firecrawl__*`, `mcp__scite__*` tools:

| Connector | Key | Without it |
|---|---|---|
| [Parallel](https://parallel.ai) — `mcp__parallel__web_search` (search fallback, always `basic`) and `mcp__parallel__web_fetch` (read a URL) | `PARALLEL_API_KEY` (required) | Connector stays disabled. The key is always sent as a Bearer token so MCP calls are not on the anonymous rate limit. |
| [Firecrawl](https://firecrawl.dev) — `firecrawl_scrape`, `firecrawl_search`, `firecrawl_parse` | `FIRECRAWL_API_KEY` (required) | Connector stays disabled. Only these three tools are exposed; paper-index tools are not advertised. |
| [Scite](https://scite.ai) — Smart Citations, retraction/correction checks, evidence datasets (patents, clinical trials, grants, drug safety, …) | `SCITE_API_KEY` (required) | Connector stays disabled |

`parallel_search` is the **primary** Parallel search tool: a native REST call to `POST /v1/search` (`x-api-key` auth). It requires `PARALLEL_API_KEY` and a **`mode` on every call**. `mcp__parallel__web_search` is the same search job locked to `basic` — the agent is steered to use it only if `parallel_search` is missing or errors. `mcp__parallel__web_fetch` is for reading a specific URL, not for search. Pass `objective`, 1–5 keyword `search_queries`, and `mode`:

| Mode | Latency | Best for |
|---|---|---|
| `turbo` | ~250ms | Simple fact lookups, current numbers, high-volume pre-filtering. English and Japanese queries only. |
| `fast` | ~700ms | Recommended default for most agent loops (interactive lookup, tool-calling). |
| `basic` | ~1s | Longer excerpts per source; 2–3 high-quality queries. Same mode the MCP search tool always uses. |
| `advanced` | ~3s | Multi-hop retrieval for literature surveys, deep research, code-review background. |

The system prompt steers the agent to use **both** `consensus_search` and `parallel_search` (`basic` or `advanced`) for peer-reviewed literature, `fast` only for ordinary non-literature lookups, and `mcp__parallel__web_search` only as a fallback when `parallel_search` is unavailable. A Settings-changed `PARALLEL_API_KEY` takes effect on the next `parallel_search` call; the MCP connector still needs a `dsh` restart.

`brave_search` (requires `BRAVE_API_KEY`) is an independent-index web fallback for general queries when `parallel_search` is unavailable or when independent coverage matters. It is not a literature index. `parallel_extract` (same `PARALLEL_API_KEY`) is the native URL-reading path: 1–20 URLs with focused excerpts, or full content when `full_content` is true. Use it, `mcp__parallel__web_fetch`, or `mcp__firecrawl__firecrawl_scrape` (needs `FIRECRAWL_API_KEY`) after a search has produced URLs.

Four more native web tools are available per key:

| Tool | Key | Notes |
|---|---|---|
| `tavily_search` | `TAVILY_API_KEY` | AI-native chunks, topic modes (general/news/finance), domain/time filters, optional answer. |
| `exa_search` | `EXA_API_KEY` | Neural/entity search; `lite` uses cached snapshots and never fetches live pages; optional text/highlights/summary. |
| `perplexity_search` | `PERPLEXITY_API_KEY` | Raw ranked results (not synthesized answers), with country/domain/language/date filters. |
| `jina_read` | `JINA_API_KEY` optional | URL/PDF → Markdown (`read`) or Jina web search (`search`). Keyless Reader is 20 RPM; search requires a key. |

None of these is a literature index; the system prompt steers papers to the academic database tools.

[Consensus](https://consensus.app) is a native `consensus_search` tool (not an MCP connector) over its `GET /v1/search` REST API — plain `x-api-key` auth, no OAuth. Requires `CONSENSUS_API_KEY` (required — the tool returns a clear error, not a disabled connector, when unset). Supports the API's full filter set: study type, year/month range, sample size, journal quartile (SJR), citation count, study duration, domain, country, publisher, open-access/preprint/human/controlled/clinical-guideline flags, and pagination.

### Academic databases (OpenAlex, Semantic Scholar, Crossref, arXiv, PubMed)

Five keyless-by-default native tools cover the open bibliographic backbones:

| Tool | Source | Key | Notes |
|---|---|---|---|
| `openalex_search` | [OpenAlex](https://openalex.org) | `OPENALEX_API_KEY` optional | 300M+ CC0 works; `filter`, `query`, and `group_by`. Keyless 10 RPS, keyed 30 RPS; semantic queries 1 RPS. |
| `s2_search` | [Semantic Scholar](https://www.semanticscholar.org/product/api) | `S2_API_KEY` optional | `relevance`, `bulk` (1,000/page), and ~500-word `snippet` modes; TLDRs and OA PDFs. Serialized at 1 RPS. |
| `pubmed_search` | Europe PMC / PubMed | `NCBI_API_KEY`, `NCBI_EMAIL` optional | Europe PMC JSON by default (no key, MeSH support); `source: "ncbi"` uses E-utilities at 3 RPS (10 with a key). `preprints: true` restricts to Europe PMC preprints (SRC:PPR). |
| `arxiv_search` | [arXiv](https://info.arxiv.org/help/api/) | none | Fielded `ti:` / `au:` / `abs:` / `cat:` queries; serialized to one request every 3 s per arXiv's terms. |
| `crossref_lookup` | [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) | `CROSSREF_MAILTO` optional | Canonical DOI metadata; the polite pool uses `CROSSREF_MAILTO`, falling back to `UNPAYWALL_EMAIL`. |
| `integrity_check` | Crossref relationships + OpenAlex flags | `OPENALEX_API_KEY` optional | Retraction / expression-of-concern / correction status for a DOI or an exact title. |

Two further tools work across them:

- `openalex_citations` walks forward (`citations`) and backward (`references`) citation edges. Accepts a DOI, PMID, or OpenAlex ID.
- `paper_resolve` converts between DOI, PMID, arXiv ID, OpenAlex ID, and Semantic Scholar ID. Use it before citing when results came from more than one database, so the same paper is not cited twice under different IDs.

`integrity_check` reports publication status for a DOI (or an exact title): `retracted`, `expression_of_concern`, `corrected`, `clean`, `unknown`, or `not_found`, with the notice DOI for each signal. A registry that could not be queried produces `unknown` and names the failing source — a failed lookup is never presented as `clean`. PubPeer has no public API, so the tool returns its URL instead of scraping it, and status is not claim support: whether a paper backs a statement stays with PaperMemory `quote_check`/`trace` and scite. OpenAlex's keyless budget is shared per network, so an `unknown` with `openalex: OpenAlex API error 401` means the budget is exhausted — set `OPENALEX_API_KEY`.

All eight are native REST tools — no MCP mount and no restart requirement. Shared record normalization and per-provider rate limiting live in `search-normalize.js` and `search-http.js`. The system prompt steers discovery to `openalex_search` + `s2_search`, with `pubmed_search` / `arxiv_search` added by domain, and keeps `consensus_search` / `parallel_search` for their distinct filters and web excerpts.

`literature_search` is the router for one-shot discovery: auto mode runs OpenAlex + Semantic Scholar, adds PubMed for biomedical queries and arXiv for preprint/CS/physics queries, and accepts explicit sources including Crossref. It deduplicates across providers and fuses their rankings with reciprocal-rank fusion, so a paper found high in two indexes outranks one found once. Coverage is the top-N relevance slice per source, not exhaustive; use the source-specific tools afterward for filters, citation trails, or pagination.

Three additional sources extend the stack:

| Tool | Key | Notes |
|---|---|---|
| `core_search` | `CORE_API_KEY` optional | CORE's 450M+ open-access records across repositories; keyless is capped at ~10 requests/minute. `include_fulltext` returns the stored full text inline (large; off by default) and requires a key. |
| `elicit_search` | `ELICIT_API_KEY` (Pro+) | 138M+ papers or ClinicalTrials.gov; study-type, year, journal-quartile, and retraction filters. 100 requests/minute per IP, then a 5-minute block, so calls are serialized and not retried. |
| `futurehouse_agent` | `FUTUREHOUSE_API_KEY` (from [platform.edisonscientific.com](https://platform.edisonscientific.com/profile)) | FutureHouse (now Edison Scientific) Crow/Falcon/Owl agents on PaperQA3: `quick_search`, `deep_search` (high reasoning), and `precedent_search`. `action=start` returns a task ID; poll `action=status` in a later turn; `cancel` is available. |

CORE works without a key. Elicit requires a Pro plan or above. FutureHouse tasks can take minutes, so the tool never blocks: start, then poll. The FutureHouse platform now runs at `api.platform.edisonscientific.com`; the key is the Edison Scientific API key.

[Unpaywall](https://unpaywall.org) and repository fallbacks back `paper_download` (also a native REST tool, not an MCP connector): given a DOI it tries Unpaywall first (when `UNPAYWALL_EMAIL` is set), then OpenAlex's publisher open-access PDF, Europe PMC open-access links, CORE repository downloads, and arXiv when the DOI is a `10.48550/arXiv.*` DOI. An `arxiv_id` or a direct `url` also works, and a direct URL is tried first. Without `UNPAYWALL_EMAIL` the other fallbacks still run, so the email is recommended but not required; the tool never invents one. When no open-access PDF is found, it returns a plain "paywalled" result listing every source tried (with the landing-page URL) rather than an error — the agent is steered to report that honestly instead of inferring the paper's content from a search snippet. The response is checked against the PDF magic bytes before being saved, so a login/CAPTCHA page returned instead of the real file surfaces as a clear error rather than a corrupt "PDF." A successful download is ingested into PaperMemory (see [Paper memory](#paper-memory)); ingest failure does not fail the download.

## Academic Harness engine

The Academic Harness engine (vendored at `vendor/academic-harness`; see [the engine notes](docs/ACADEMIC-HARNESS-ENGINE.md)) is the writing oracle for long academic LaTeX documents: literature reviews, journal and conference papers, grant proposals, theses, and rebuttals. A paper has no compiler. The engine inventories every number, citation, unit, and declared claim, then a **gate** closes only when this turn introduced no open blocker or major. Unchanged units keep the verdicts they already had.

You do **not** install Pi, and you do not install Academic Harness into DSH. The engine is part of this plugin (`vendor/academic-harness`). Where that tree should live long-term is an [open decision](docs/ACADEMIC-HARNESS-ENGINE.md). On first mount the plugin prepares a local `.venv` next to that vendored tree (via `uv`, or `python -m venv` + pip) **in the background**, so plugin installation and the web UI are not blocked; an `ah_*` call or interceptor triggered before preparation finishes waits for it. Interceptors (paper-state card, protected-path guard, post-edit check, gate) are inactive outside a directory tree with `ah.yaml`, so ordinary Academic Harness sessions are unchanged. Override with `ACADEMIC_HARNESS_CLI` or `AH_CMD`; `ACADEMIC_HARNESS_SKIP_INSTALL=1` skips creating the plugin-local venv.

| Tool | Who | What it does |
|---|---|---|
| `ah_profile` / `ah_init` / `ah_migrate` | anyone | List document types; scaffold a new project; overlay `ah.yaml` on an existing LaTeX tree (dry-run first; apply needs `confirm`) |
| `ah_state` / `ah_inventory` / `ah_check` / `ah_audit` / `ah_config` / `ah_catalogue` | anyone | Paper-state card; coverage counts; cheap checks; full audit with ledger; project config; check catalogue |
| `ah_units` / `ah_fact` / `ah_bind` / `ah_fact_propose` / `ah_sweep` | anyone | Sync `%% @unit` anchors; list/build/check facts; suggest number→fact bindings; propose a new fact; find every use of a value |
| `ah_source` / `ah_source_search` / `ah_claims` / `ah_claims_sync` / `ah_claims_bind` | anyone | Register/list sources; quote-located passages; claim sidecars; bind a claim to a source or fact |
| `ah_pack` / `ah_brief_new` / `ah_plan` | anyone | Evidence pack before drafting; draft a brief; propose an outline (author approves) |
| `ah_build` / `ah_findings` / `ah_decision_request` | anyone | Compile with errors mapped to units; list ledger findings; hand a finding to the author |
| `ah_review` / `ah_review_set` / `ah_review_respond` / `ah_snapshot` | anyone | Import/list reviewer items; map units; response letter from real diffs; save/diff unit snapshots |
| `ah_provenance` / `ah_disclosure` | anyone | Who wrote each unit; draft an AI-use statement (author approves) |
| `ah_rsi` | anyone | Inspect/steer the local self-improvement loop: status, report, lessons, diagnose, forget, rollback, inject preview. Records reached activation, token cost, oracle manifest, and risk tier. No approval gate. |
| `ah_author` | you | Waive, accept/reject a fact, approve a brief or plan, verify a claim, decline a review item, fill provenance, approve a disclosure. DSH asks you to confirm. |

Skills: `academic-harness` (router), `ah-write-unit`, `ah-plan-section`, `ah-fix-findings`, `ah-audit-section`, `ah-revise-from-review`.

In a project directory:

1. Pick the Academic Harness preset.
2. `ah_init` (new) or `ah_migrate` (existing tree).
3. Write through `ah-write-unit`. The gate keeps the agent on this turn's findings.

T3 (does this cited clause match the source) is advisory and never a gate. Optional model backends in `ah.yaml` are `http` (OpenAI-compatible, including local Ollama) or `command`. The engine's unused `pi` backend is not required.

## Local recursive self-improvement (RSI)

The preset improves itself from local session outcomes. The loop captures tool errors, `ah` findings, gate handoffs, citation/integrity/statistics/figure/reproducibility flags, the task class, and explicit user preferences; diagnoses recurring research failures; admits short lessons automatically; injects matching lessons into later turns; compares injected against eligible control turns; and auto-promotes, keeps exploring, or quarantines the lesson. There is no approval step.

- **Local-only.** The store is `$DSH_HOME/ah-rsi` (override `AH_RSI_STORE`). No network calls by default, no full message or manuscript text. The opt-in remote judge (`AH_RSI_REMOTE=1` + `AH_RSI_JUDGE_URL`) is veto-only and receives lesson text plus evidence counts, never manuscript text.
- **Reversible.** `ah_rsi forget` / `rollback` or the matching CLI commands retire a lesson; `purge --yes` deletes the store. `AH_RSI=observe` captures without injection; `AH_RSI=off` disables the loop.
- **Bounded.** Only lesson text is mutable. The loop never edits the plugin, `vendor/academic-harness`, the project, protected paths, or the audit/evaluation code. Executable changes stay in the normal release process.
- **Observable.** Each episode records injected tokens, an oracle manifest (plugin/engine/prompt/hook/audit hashes), and a reached-action proxy; lessons carry a target, risk tier, release requirement, and reached statistics. Reached means the prescribed tool ran, not that the lesson was followed or that the outcome improved.
- **Layer scope.** The plugin implements the seven core layers for lesson-level interpreted state: capture, experience store, diagnosis/proposal, frozen evaluator, admission, activation, and observability. Versioned skills and local policy proposals (T2) are deferred; global prompt/skill changes (T3) and executable/evaluator changes (T4) are out of scope.
- **Research-wide.** Task classes cover literature, hypothesis, experiment, data analysis, statistics, manuscript, grant, review response, reproducibility, and data management; explicit preferences are remembered across projects.
- **Inspect it.** Inside a session use `ah_rsi` `status|report|lessons|diagnose|forget|rollback|inject_preview`; explicit preferences are captured from the user's message automatically. Offline use `academic-harness-rsi` with `status`, `report`, `lessons`, `diagnose`, `feedback` (manual preference entry), `forget`, `rollback`, `inject`, and `benchmark synthetic|replay|defects|snapshot --project PATH`.
- **Evaluation honesty.** `benchmark synthetic` tests the learning pipeline; `benchmark replay` reports observational statistics over captured turns; `benchmark defects --project PATH` injects known LaTeX defects into a copy and checks which ones the real audit catches and whether learned lessons cover them; the injected-versus-control comparison is a local heuristic, not causal proof. See [docs/RSI.md](docs/RSI.md) and the **OPAL** system paper with the corpus evaluation in [`paper/rsi-local/`](paper/rsi-local/).

## Paper memory

[PaperMemory](https://github.com/raktim-mondol/papermemory) is the local academic-memory layer on the Academic Harness preset: papers (title, authors, year, venue, DOI, arXiv, bibtex key), claims with quoted evidence, citation graphs, manuscript recap, and cite-check. It is how the agent remembers papers it has read and cites without inventing references — open-web and peer-reviewed discovery stays on Parallel / Consensus / Firecrawl / Scite.

You do **not** install PaperMemory yourself. The first time the Academic Harness preset mounts after `dsh plugin add`, the plugin uses `papermemory` already on `PATH` if present, otherwise installs the vendored package (with `pypdf`) into `~/.dsh/papermemory` via `uv` (or `python -m venv` + pip). It then mounts `mcp__papermemory__*` over stdio (`papermemory mcp`) — no second restart. Startup is **fail-loud**: a missing or broken memory server (and any drift from the expected 14-tool surface) is logged/surfaced instead of silently reading as an empty store. Override with `PAPERMEMORY_CLI` if you already have a binary you want to keep; `PAPERMEMORY_SKIP_INSTALL=1` skips the bundled venv.

The SQLite store is PaperMemory's default: `~/.local/share/papermemory/papermemory.db` (override `PAPERMEMORY_DB` or `PAPERMEMORY_DATA_DIR`). A standalone `papermemory` CLI, Grok, and Academic Harness share that same database. No API key.

**Memory v2 (markdown-first, verbatim).** Each paper is stored as content-addressed markdown; chunks are byte slices, sections carry heading paths and deterministic roles, and claims are anchored to exact quote spans. `papermemory_claim` requires an `evidence` quote from the stored text; an absent quote is refused and a whitespace-only mismatch stays `unverified-quote` (`asserted-quote-differs`). Only a passing byte re-slice (`papermemory verify`, or `papermemory_trace`'s walk) promotes a claim to `verified`; OCR-derived papers are capped at `extracted` (`channel-capped:ocr-recovered`). Search returns typed `empty_reason`/`suppressed`/`legs` instead of an unqualified empty list. Existing stores migrate once with `papermemory migrate` (schema 2000); legacy chunks/claims are quarantined, not promoted — re-ingest papers as markdown to make them citable. A 104-paper scale run (28/28 checks, bm25 top-N 20/20, scoped p95 11.7 ms) is documented in `reports/papermemory-v2-scale-test.md`.

| Tool | What it does |
|---|---|
| `mcp__papermemory__papermemory_recap` | Writing-project briefing: venue, sections, contributions, citation gaps |
| `mcp__papermemory__papermemory_search` | bm25-ordered chunk leg + claim/paper/notes legs; typed `empty_reason`, `suppressed`, `legs` |
| `mcp__papermemory__papermemory_ingest` | Ingest a local PDF/BibTeX/markdown/manuscript path, or an arXiv id / DOI |
| `mcp__papermemory__papermemory_get` | Paper by id or bibtex key, with claims and chunks |
| `mcp__papermemory__papermemory_cite` | Find a stored paper to cite. Empty result means do not invent a citation |
| `mcp__papermemory__papermemory_cite_check` | Compare a manuscript's in-text keys against memory |
| `mcp__papermemory__papermemory_remember` | Save a writing/reading decision |
| `mcp__papermemory__papermemory_claim` | Store a verbatim-anchored claim (evidence required); supersede/contradict/rebind/bind actions |
| `mcp__papermemory__papermemory_quote_check` | Exact-substring quote check with occurrences and locators |
| `mcp__papermemory__papermemory_trace` | Provenance walk for a claim, or paper → docs → claims → citations |
| `mcp__papermemory__papermemory_outline` | Derived section outline (roles, spans, DOI, source filename) |
| `mcp__papermemory__papermemory_list` | Enumerate papers/claims/lessons/coverage with totals |
| `mcp__papermemory__papermemory_register_to_ah` | Register stored markdown into an Academic Harness project |
| `mcp__papermemory__papermemory_lesson` | Save a durable academic writing/reading rule |

`paper_download` calls ingest on the saved PDF (and DOI metadata when a DOI was given); `pdf_to_markdown write_to` auto-ingests the converted markdown (page-subset conversions are deliberately not ingested) and forwards converter/OCR signals. The agent is steered to `recap` on paper-writing tasks, to cite only memory hits, to check `supports_statement`/`degradation`, and to `cite_check` before treating a section as finished. Load the bundled `papermemory` skill (`skills/papermemory`) for the full workflow.

**Auto-ingest project scope.** Both auto-ingest paths pass the workspace root (`cwd`) to PaperMemory and let it resolve the project, in this order: `PAPERMEMORY_PROJECT` (slugified) → nearest `ah.yaml` ancestor → a manuscript whose `root_path` equals the workspace → `unassigned`. Explicit ingest uses the same resolution (`papermemory_ingest` with `cwd`, or CLI `papermemory ingest --cwd PATH`); an explicit `--project` wins over `cwd` and is slugified. Set `PAPERMEMORY_PROJECT` to override the detected project.

**Project-key migration.** Papers ingested before v0.15.0 were tagged with the workspace directory slug. After upgrading, a new auto-ingest in the same workspace may land under the manuscript or `ah.yaml` slug instead, so one project can temporarily split across two keys. Set `PAPERMEMORY_PROJECT` to the old slug for new ingests, or re-ingest the affected papers under the canonical project; there is no automatic `project rekey` command.

## References and citation

`citation` is a preset-only native tool — local, no key — with four actions:

- `format` renders a bibliography in APA (default), Vancouver, Harvard, IEEE, Chicago author-date, or MLA, with optional in-text markers.
- `bibtex` / `ris` export from CSL-JSON records, existing BibTeX/RIS text, or DOIs (Crossref content negotiation).
- `validate` reports missing fields, duplicate DOIs/keys, and invalid DOIs; `check_dois: true` checks each DOI against Crossref (identity only, not claim support).

The IEEE, Chicago author-date, and MLA CSL styles are vendored under `styles/` (CC BY-SA 3.0; see [styles/README.md](styles/README.md)). Set `CROSSREF_MAILTO` or `UNPAYWALL_EMAIL` for the Crossref polite pool.

Use `citation` for the final bibliography. To pull a paper into the workspace and store citable evidence, use `paper_download` (open-access only) and PaperMemory — a reference in a manager is not verified evidence, so claims still need `papermemory_quote_check` / `papermemory_trace`.

`manuscript_citations` checks the manuscript against the bibliography: pass a `.tex` or Pandoc `.md` file (and optionally `bib_path`; for LaTeX the `.bib` is discovered from `\bibliography{...}` / `\addbibresource{...}`). It reports keys cited but missing from the `.bib`, entries never cited, duplicate bibliography keys, and — for LaTeX — undefined `\ref` targets and duplicate `\label`s. `\nocite{*}` suppresses unused-entry reporting. It is local and deterministic, does not reformat citations, and rejects `.docx` because Word citation fields cannot be inspected reliably.

## Systematic reviews

`review` is a preset-only native tool — local, no key, no database — that keeps a systematic or scoping review auditable. State lives under `<cwd>/.dsh/review/<slug>/` as append-only JSONL event logs plus a write-once `protocol.json`; the current state is derived from the log, so concurrent subagent writes cannot corrupt it and overrides keep their history.

- `start` — question, databases, inclusion/exclusion criteria, date range. Refuses to overwrite an existing review unless `resume: true`.
- `add` — records from a search tool's result array or a workspace JSON/JSONL file; deduplicates by DOI, PMID, arXiv ID, then normalized title+year, and logs every query in `search_log.jsonl`.
- `screen` — `title_abstract` / `full_text` × `include` / `exclude` / `maybe`. A full-text decision requires a prior title/abstract include; exclude and maybe require a reason; re-screening requires `override: true`.
- `evidence` — only after a full-text include; claim, verbatim quote, and location. The ledger stores the quote but does not verify it — PaperMemory `quote_check`/`trace` remains the verifier.
- `status` — records, query counts, PRISMA-style stage counts, exclusion reasons, includes missing evidence.
- `export` — `markdown` report skeleton, `csv` evidence table, or `json` full ledger under `exports/`; refuses to overwrite without `overwrite: true`.

The tool never makes inclusion decisions — discovery stays in the search tools and every screening decision and reason comes from the user or the stated criteria. The `systematic-review-ledger` skill documents the full workflow.

## Hypothesis tournaments

`coscientist` and `coscientist_rank` are preset-only native tools — local state, no key, no database, no new dependency — for a ranked hypothesis shortlist that has to survive past this context window. State lives under `<cwd>/.dsh/coscientist/<slug>/` as append-only `events.jsonl` / `matches.jsonl` logs plus a write-once `protocol.json`; the leaderboard is derived from the log, so a resumed session sees exactly the ratings it left behind, and concurrent subagent writes cannot corrupt it. Same shape as [Systematic reviews](#systematic-reviews), and the shared `.lock` implementation comes from there.

- `coscientist` — `start` (goal, constraints, rubric, `max_hypotheses`, `step_budget`, `max_matches`, `seed`; defaults **5 hypotheses / 36 steps** — a ranked shortlist sized so two losses still leave three ideas competing, and a budget that lets the Elo plateau rule actually fire rather than ending on the cap; `max_matches` enforces an explicit user stop bound such as one match per pair), `add`, `review` (five stages: `initial` → `full` → `deep_verification` → `simulation` → `observation`), `safety` (record a dual-use classification; the tool withholds it when the severity meets the threshold), `status` (ranked leaderboard), `next` (which task the scheduling policy samples now; it never samples a task the ledger cannot run and stops at the match cap), `set_status` (reject or release a withholding, always with a reason), `lineage`, `design_protocol`, `synthesize`, `export` (`markdown` / `json` / `mermaid`).
- `coscientist_rank` — `propose` (a pair that has never met first, then the most uncertain hypothesis against a similar one; reports `pair_matches_played` and `unplayed_pairs_remaining`), `record` (a judged pair, both presentation orders, judged sequentially with the same brief), `compare`, `similarity`, `feedback` (an experimental result as a reward), `history`.

Phase 4 adds three ledger-only capabilities to `coscientist`: `graph` (a Mermaid diagram of lineage, similarity, and claim→paper support, written with `export format: mermaid` and rasterised by [`mermaid_render`](#mermaid-diagrams)), `priors` (prior feedback, rejections, and withholdings from **other tournaments in this workspace**, ranked against the goal — read from their own logs, so nothing is duplicated and nothing can disagree with a ledger), and `embed` (opt-in Gemini embeddings that switch the duplicate gate and similarity from lexical overlap to cosine, at upstream's 0.92 / 0.70 thresholds — `embed` is the only tournament call that needs a key or the network, and it reuses `GEMINI_API_KEY` from [Image generation](#image-generation)).

Ratings are Glicko-2 (rating + RD + volatility), seeded from review scores and tightened by matches, with a zero-sum update per pair; citation integrity applies a soft penalty rather than a veto, and an experimental result moves a rating only through `coscientist_rank feedback`. Similarity always reports which measure produced it: a 0.70 lexical score and a 0.70 cosine are not the same claim, and a partially embedded pool is called **mixed** rather than blended. The tools decide what the code decides: a near-duplicate `add` is discarded with its similarity score, a cap-reached `add` is discarded, review stages refuse to run out of order, a `fail` at `initial`/`full` rejects the hypothesis, only `active` hypotheses may compete, a verdict that follows the presentation order counts as a draw, and `next` reports when to stop (step budget, no pair left to play, Elo plateau, or cap ranked). Neither tool calls a model — the session does the reasoning, normally through `subagent`, so the cost of a tournament is debate matches.

Hypotheses generated this way recombine published knowledge: they are not results, an unverified citation stays `[VERIFY]`, and a withheld dual-use idea stays withheld until the user releases it by name. The `co-scientist-tournament` skill carries the loop, the subagent briefs, and the budget defaults. For one round of ideation, use [`generating-scientific-hypotheses`](#what-it-adds) instead.


Two preset-only native tools cover records that are not journal literature:

- `clinicaltrials` — ClinicalTrials.gov API v2, free and keyless. `search` filters by `query` (free text), `condition`, `intervention`, `phase`, `status`, and `study_type`, returns normalized trials (NCT id, status, phase, enrollment, sponsor, conditions, interventions, endpoints, locations, `has_results`) and a `next_page_token`. `get` reads one NCT id; `include_results: true` adds posted outcome measures and adverse-event counts.
- `openfda` — openFDA, free and keyless with a low shared daily quota (`OPENFDA_API_KEY` raises it; a 429 means the quota is exhausted). One `search` action over an allowlisted endpoint: `drug/event`, `drug/enforcement`, `device/event`, `device/510k`, `drug/label`, or `food/event`. The openFDA search expression is passed through unchanged, records are compacted per endpoint, and every response carries the source query URL. A no-match search is an empty result, not an error.

Both are informational only — no medical or legal advice — and neither is a literature search: cite NCT ids/report numbers as registry evidence, not as peer-reviewed findings.

## Datasets and journal policy

- `dataset_search` — DataCite dataset discovery (`query`, `repository`, `year`, cursor paging) with DOI, title, creators, publisher, version, license, and landing URL. `get` reads one DOI; `files` lists file names/sizes/download URLs for Zenodo and Figshare DOIs and returns the landing URL for other repositories. Free, keyless, and no downloads. Optional `ZENODO_API_KEY`, `FIGSHARE_API_KEY`, and `DATACITE_API_KEY` are sent as auth headers when set (public data works without them).
- `journal_policy` — venue policy from DOAJ (listing, APC, license, OA start year; keyless) plus Sherpa Romeo (preprint/postprint/published permissions, embargo, conditions; needs `SHERPA_ROMERO_API_KEY`). Without the key the result is DOAJ-only with an explicit `key_not_set` note. An unknown journal is `not_found`, an ambiguous title returns candidate ISSNs, and a failed lookup is `unknown` — never reported as "not listed".
- `funder_policy` — OpenAlex funder identity (canonical name, alternate titles, country, award/works counts; keyless) plus Sherpa Juliet per-version OA policy (embargo, license, conditions) when `SHERPA_ROMERO_API_KEY` is set. Without the key it returns the identity and `key_not_set`; it never guesses a funder's policy.

These are compliance/discovery aids: cite dataset DOIs, never infer a license or APC, and treat policy output as compliance information rather than legal advice.

## Optional tools

Several tools ship behind an opt-in flag: `AH_ENABLE_OPTIONAL_TOOLS=1` (env only, not Settings). With the flag unset the tools are not registered at all — they are absent from the tool list and the system prompt. The preset rows always exist, so enabling the flag needs a **dsh restart**.

- `author_lookup` — ORCID author search and single-ORCID records (name, works count, employment with ROR ids) plus ROR institution search/lookup (name, aliases, country, website). `ORCID_TOKEN` is optional and only raises limits; ROR is keyless. Ambiguous names return candidates — identities are never merged automatically.
- `openreview` — OpenReview API v2 submission search, a forum's reviews/decision, and venue metadata. Read-only; fields a venue does not publish stay absent. OpenReview may answer with an HTTP 403 browser-verification challenge, in which case open the forum URL with `agent-browser`.
- `pdf_references` — GROBID bibliography extraction from a workspace PDF. Requires `GROBID_BASE_URL` (for example `http://127.0.0.1:8070`) **in addition** to the flag; without a reachable GROBID service the tool reports the failure and never generates references itself. `resolve: true` checks each extracted DOI's title against Crossref.
- `coscientist_verify` — citation integrity and claim support for the [hypothesis tournament](#hypothesis-tournaments). `citations` checks every work a hypothesis cites against Crossref (a DOI that is not registered is `fabricated`; a title nobody matches, or any registry error, is only `unverified` — never reported as verified) and records the counts that drive the rating penalty; `check_integrity: true` adds retraction status via `integrity_check`. `claims` records the supports/contradicts/unaddressed judgements a subagent reached, so the ledger holds them rather than the transcript. `CROSSREF_MAILTO` moves it into the polite pool; it shares one Crossref limiter with `crossref_lookup`.
- `stat_audit` — recomputes p-values from reported t/F/χ²/z/r statistics and df, flags `p = 0` and incompatible statistic/p pairs, and optionally runs GRIM on reported means. Requires sciPy in the helper environment. Candidate inconsistencies only, never misconduct; GRIMMER is not implemented.
- `figure_audit` — local inventory of figure files (dimensions, DPI, mode, format), low-DPI and missing-DPI flags, and dHash-based near-duplicate groups. Advisory; it does not detect manipulation.
- `repo_audit` — static reproducibility checklist (README, LICENSE, environment file, tests, CI, entry points, data availability, release tag) for a local path or an https `repo_url` cloned into a temp dir. Code is not executed unless `run_tests: true`; `GITHUB_TOKEN` (env only) is optional for API metadata.
- `grant_search` — funded-project and opportunity discovery: NIH RePORTER (awards, amounts, dates), NSF Award Search (awards), and Grants.gov (posted/forecast opportunities). Filters by query, PI, organization, and fiscal year; `get` reads one award/opportunity by id. Informational only, not grant-writing advice.
- `patent_search` — PatentsView prior-art/assignee/inventor lookup over US patents with grant/priority dates and optional abstracts. **Requires `PATENTSVIEW_API_KEY` on every call**; without it the call returns a clear error. No legal-status or freedom-to-operate conclusions.

`literature_search` also gains a `preprints` source (Europe PMC `SRC:PPR`) available without the flag, and chooses it automatically for biomedical queries that mention preprints.

## Paper agents (Paper2Agent)

The bundled `paper2agent` skill ([jmiao24/Paper2Agent](https://github.com/jmiao24/Paper2Agent), MIT) turns a paper and/or its code repository into (1) a reviewed, compact paper skill and (2) a tested FastMCP server of that paper's methods. Load it with the `skill` tool when the user asks to agentify a paper. It is not a replacement for `pdf_to_markdown` (fast unreviewed extract) or for catalogue skills such as `scanpy` (how-to).

A full repository conversion is long (many `subagent` specialists plus independent verifiers). The agent should confirm scope first. After a verified ZIP, connect the server **only when asked**, with native `paper_mcp` (`register` / `status` / `unregister`) on the Academic Harness preset. That writes `<cwd>/.dsh/paper-mcps.json` (interpreter, server script, env **names** — never secrets) and tries to mount the server over stdio so tools appear as `mcp__<serverName>__*`. Those mounts are standing for the life of `dsh`, same as Parallel/Scite: if tools do not appear, restart `dsh`. A different workspace that reuses the same `serverName` also needs a restart.

Do not run `claude mcp add`. GPU papers use `runpod_run` / `modal_run` rather than a silent CPU fallback.

| Setting / env | What it does |
|---|---|
| `PAPERMEMORY_CLI` | Absolute path to a `papermemory` binary. Env only. |
| `PAPERMEMORY_DB` / `PAPERMEMORY_DATA_DIR` | Override the SQLite store location. Env only. |
| `PAPERMEMORY_PROJECT` | Override the project for `paper_download` / `pdf_to_markdown` auto-ingest (slugified). Env only; otherwise PaperMemory resolves `ah.yaml` → manuscript `root_path` → `unassigned`. |
| `PAPERMEMORY_SKIP_INSTALL` | `1` to skip installing the bundled venv (PATH / `PAPERMEMORY_CLI` still work). |

## Browsing the web

Built-in `web_search` works (DeepSeek search provider). Built-in `web_fetch` retrieves public HTTP(S) pages through the local HTTP provider; if a page is blocked, needs JavaScript, or returns `WEB_PROVIDER_UNAVAILABLE`, the agent falls back to `mcp__parallel__web_fetch`, `parallel_extract`, or `mcp__firecrawl__firecrawl_scrape` (Firecrawl needs `FIRECRAWL_API_KEY`). DeepSeek's Search and Fetch APIs can be enabled in Web Search settings. For anything that needs a real rendered browser — exploring a site interactively, logging in, filling out a form, clicking through to a dataset download, or verifying a page actually renders correctly — the agent loads the bundled `agent-browser` skill (`skills/agent-browser`, shipped and seeded the same way as the skills above) and drives the [agent-browser](https://github.com/vercel-labs/agent-browser) CLI directly via `bash`. The CLI isn't bundled with this plugin's package, but the agent installs it itself when missing (`npm i -g agent-browser && agent-browser install`, or `npx agent-browser@latest ...` for a one-off task) rather than asking the user to.

Most of what it does — navigating, reading, filling forms, extracting data, downloading files — works off an accessibility-tree snapshot and needs no image at all. The one exception is `screenshot`: since the session's own model isn't guaranteed to have vision input, the skill steers the agent to delegate reading any screenshot to `subagent_vision` (see [Subagent model routing](#subagent-model-routing)) instead of guessing at its content.

Set any of these via Settings → Academic Harness API keys or the matching env var (see [API keys](#api-keys)). `SCITE_API_KEY` is an `mcp`-scoped key from [scite.ai/users/me/api](https://scite.ai/users/me/api) — Scite's own documented non-interactive path for MCP clients, sent as a bearer token to `https://api.scite.ai/mcp` (no OAuth or token exchange). Scite also offers an OAuth flow, but only for its first-party ChatGPT/Claude plugin and other interactive clients — not relevant here.

## Subagent model routing

Besides the plain `subagent`/`subagent_fork` delegation tools, the `academic-harness` preset adds two more that pin a delegated child to a specific model via `agentOptions.model`, so the agent can route a task to the model that fits it instead of running everything on whatever model the current chat session happens to be on:

| Tool | Use it for | Model (Settings or env) | Default |
|---|---|---|---|
| `subagent` | Ordinary delegated work — most specialist calls | — (inherits the parent session's model) | — |
| `subagent_pro` | Tasks where difficulty, not length, is the bottleneck: a hard proof/derivation, a causal-inference or experimental-design critique, tracing a subtle methodological flaw, multi-step reaction/pathway reasoning, a large multi-file refactor | `SUBAGENT_MODEL_COMPLEX` | `deepseek-flash` |
| `subagent_vision` | Delegated tasks that need to *see* something with `read_image` — a figure, scan, diagram, screenshot, or a rendered LaTeX PDF page | `SUBAGENT_MODEL_VISION` | `deepseek-flash` |

Both pinned tools default to `deepseek-flash` (DeepSeek-V4.1-Flash). The legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted by the API, but those models have been retired and their requests are served by Flash.

All three delegation tools use DSH 0.2.1's managed activations: a call returns a `subagentId` immediately, the child's final answer arrives as a completion notice, and `send_message` / `interrupt_agent` handle follow-ups and stops.

`subagent` is deliberately left without a pinned model: forcing every routine delegation onto a hardcoded model id would break delegation outright wherever that id isn't registered under the session's provider. Only the two escalation paths are pinned, and only where the agent is choosing to opt into a specific model rather than falling back to whatever it's already using.

The system prompt steers `subagent_pro` toward difficulty, not length: verifying a mathematical derivation step-by-step or propagating uncertainty through a multi-stage calculation, a causal-inference critique (spotting a hidden confounder, weighing conflicting evidence across several studies), tracing a subtle methodological flaw through many interacting parts (data leakage in a multi-stage ML pipeline, a silently-wrong nested cross-validation setup), multi-step reaction-mechanism or pathway reasoning, and large multi-file refactors that need many call sites kept consistent. It explicitly steers away from routine review, lookup, simple data validation, or literature search, since those get the same quality on plain `subagent` for a fraction of the cost and latency.

`subagent_vision` only routes the child to a model; the child still calls `read_image` (`@deepseek-ai/dsh-tool-fs`) itself, which refuses to read an image unless the calling route's resolved model actually declares `image` input in this deployment's model catalog — pick a `SUBAGENT_MODEL_VISION` value that's registered that way.

Beyond a plain "look at this image" request, the system prompt steers the agent to delegate to `subagent_vision` for scientific reading tasks specifically: interpreting a plot or trend, comparing panels in a multi-panel figure, reviewing a microscopy/gel/medical-imaging scan for qualitative features, checking a chemical structure/phylogenetic tree/pathway diagram for correctness, and comparing a generated figure against what was asked for. It also covers a case text tools can't: auditing a compiled LaTeX PDF's page layout — a table split across a page break, a table or figure that drifted into the references section, an overfull line, a caption stranded from its figure — since `read_image` only accepts PNG/JPEG/WebP/GIF, the agent renders the PDF pages first with `pdftoppm -png -r 150 file.pdf page` (poppler, usually already present alongside TeX Live) before delegating.

Set `SUBAGENT_MODEL_COMPLEX`/`SUBAGENT_MODEL_VISION` via Settings → Academic Harness API keys (two more dropdowns beside Image model) or the matching env var — env wins when both are set, same resolution order as the API keys above. Unlike Image model, these two need a `dsh` restart to take effect (see [API keys](#api-keys)).

## Figures

The system prompt steers the agent to pick a figure tool by content, not by habit, and to load the matching skill before drawing:

- **Numeric data** (plots, charts, distributions, trends) — `scientific-figure-making`: real matplotlib over real computed data, house-style helpers, PNG+PDF export. Never `image_generate` and never fabricated values. Named journals also load `scientific-visualization` for column widths.
- **Structural diagrams** (architecture, pipelines, flowcharts, method schematics, CONSORT, trees, timelines) — `diagram-design`: self-contained HTML+SVG editorial diagrams (one accent, no shadows, orthogonal connectors). Not Mermaid rounded boxes, not `image_generate`. For a paper or compiled PDF the agent also exports PNG/SVG. Mermaid is only when the user explicitly wants a git-diffable markdown diagram — then `mermaid_render` renders it.
- **Conceptual illustrations** with no defined structure and no real numbers — `image_generate`.

### Image generation

`image_generate` writes conceptual schematics, diagrams, and illustrations to the workspace — not quantitative plots (those should be real Python/matplotlib output over real data).

- **Default (Gemini):** set `GEMINI_API_KEY` (Settings or env). Model defaults to `gemini-2.5-flash-image` ("nano banana"); pick a different one from the **Image model** dropdown in Settings → Academic Harness API keys (`gemini-3.1-flash-image` "nano banana 2", `gemini-3-pro-image` "nano banana pro", or a custom model id), or set `IMAGE_MODEL` (env). Unlike the API-key fields, the dropdown applies immediately on selection — no Save button, and (like `resolveEnv()` fields) no restart needed.
- **OpenAI-compatible Images API instead:** set `IMAGE_PROVIDER=openai`, `IMAGE_MODEL` (Settings or env), `IMAGE_BASE_URL` (env only) plus `IMAGE_API_KEY` (Settings or env).

### Mermaid diagrams

`mermaid_render` turns Mermaid source into SVG with [Pele](https://github.com/obsidianmd/pele) (MIT, from the Obsidian team) — synchronous and in-process, so no browser, no headless Chrome, and no `mmdc`/mermaid-cli install. It covers every diagram type built into Mermaid 12.1.0: flowchart, sequence, class, state, ER, pie, gantt, gitGraph, mindmap, timeline, journey, xychart, quadrant, requirement, C4, sankey, block, packet, kanban, architecture, radar, treemap, info, agentflow, usecase, railroad, treeView, Venn, Cynefin, Wardley, swimlane, Ishikawa, and event modeling.

- `mermaid` — the source. A fenced ` ```mermaid ` block is accepted and unwrapped.
- `path` — optional `.svg` path to write (must stay inside the workspace). Written files have Pele's `--pele-*` CSS variables flattened to their literal fallback colors, because Inkscape, `rsvg-convert`, and CairoSVG do not resolve CSS variables and would otherwise rasterize the file to a blank image. Omit `path` for inline SVG, which keeps the variables so a page can re-skin it.
- `font_size`, `padding`, `max_width` — layout knobs; the diagram re-lays-out rather than stretching.

A parse failure comes back as `syntax` / `semantic` / `unsupported-diagram` / `limit` with the offending line, column, and snippet, so the source can be corrected and retried. This renders Mermaid as Mermaid — a publication-quality scientific figure still goes through `diagram-design`, which redraws a Mermaid source as an editorial SVG.

Verified against Pele's own 761-example upstream corpus: every valid example renders, and the malformed ones come back as typed errors rather than crashing. Known limits of the Node path, all inherited from Pele's browser-only resolvers:

- **External icon sets** — a node written as `(fa:bug)` or `(si:react)` renders as an empty box, because resolving those names needs an `icons` callback backed by icon data. Pele's ~40 built-in shapes (`cloud`, `database`, `server`, `disk`, …) render correctly.
- **Math** — `$$…$$` and `$…$` stay literal text; typesetting needs a `math` (KaTeX) resolver.
- **HTML in labels** — tags are stripped, not escaped, so `"<script>x</script>"` draws as `x` and `"<img …>"` draws as an empty node. Harmless in the output (no raw markup or handlers ever reach the SVG), but the label text is lost.
- **Emoji** — the characters are in the SVG text nodes; whether they rasterize depends on the fonts available to whatever opens the file.
- **External references** — `https:` image and link URLs are embedded as-is, so a rendered SVG can trigger a request when opened. `data:`, `file:`, and `javascript:` are rejected by Pele for both images and click links.

## Scientific file inspection

`sci_inspect` summarizes SMILES/MOL/SDF, PDB/CIF, mzML and other mass-spec formats, npy/npz/parquet/hdf5, TIFF/NIfTI/DICOM, and h5ad files by shelling out to the bundled Python helpers under `python-helpers/`.

Set up the helper venv once (needs [uv](https://docs.astral.sh/uv/)):

```sh
cd python-helpers && uv sync
```

The tool finds `python-helpers/.venv` automatically. Override with `ACADEMIC_HARNESS_HELPERS_DIR` (a different helpers checkout) or `ACADEMIC_HARNESS_PYTHON` (a specific interpreter); the old `RESEARCHCRAFT_HELPERS_DIR`/`RESEARCHCRAFT_PYTHON` names are still honored as fallbacks.

## LaTeX

`latex_compile` compiles a `.tex` file to PDF: `latexmk` when it's on `PATH` (handles bibtex/biber automatically), otherwise a `pdflatex`/`xelatex`/`lualatex` fallback with a bibtex/biber pass when the source needs one. Requires a TeX Live (or similar) install.

## Downloading and reading papers

Two tools cover the full loop for actually reading a paper rather than just its abstract: `paper_download` (Academic Harness preset only — see [Academic and web search](#academic-and-web-search)) gets the PDF onto disk, and `pdf_to_markdown` (every preset) turns it into readable text. A successful `paper_download` is also ingested into PaperMemory (see [Paper memory](#paper-memory)).

### PDF to Markdown

`pdf_to_markdown` converts a PDF to Markdown using [pdf-inspector](https://github.com/firecrawl/pdf-inspector) (`@firecrawl/pdf-inspector`, native Rust/napi) — built for literature-survey workflows where a lot of downloaded papers need converting. It classifies the PDF (text-based/scanned/image-based/mixed) and, for text-based PDFs, extracts headings, lists, tables, and reading order locally in milliseconds without OCR.

- `path` — the PDF to convert.
- `pages` — optional 1-indexed page numbers to limit conversion to.
- `write_to` — workspace-relative output path for the Markdown. Recommended for anything but a short excerpt; converting many papers with `write_to` set keeps each paper's full text out of the conversation and on disk instead (e.g. `literature/<author>-<year>.md`).
- `ocr` — selectively OCR pages flagged as low quality (mode `Auto`). Requires the PDFium and ONNX Runtime shared libraries installed locally (set `PDFIUM_LIB_PATH`/`ORT_DYLIB_PATH` if they're not on the library search path — see [pdf-inspector's OCR runtime guide](https://github.com/firecrawl/pdf-inspector/blob/main/docs/ocr-runtime.md)); without them, a scanned PDF still comes back with `pages_needing_ocr` populated, so the agent knows to fall back to `subagent_vision` on rendered page images instead.

Prebuilt native binaries ship as `optionalDependencies` for Linux (x64/ARM64, glibc and musl), macOS (ARM64), and Windows (x64) — a plain `npm install` picks up the right one, no Rust toolchain needed.

## Remote compute

`modal_run` and `runpod_run` offload a command to a remote CPU/GPU instance — upload inputs, run, download outputs, always terminate when done.

| Tool | Key (Settings or env) | Get credentials |
|---|---|---|
| `modal_run` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | https://modal.com/settings |
| `runpod_run` | `RUNPOD_API_KEY` | https://console.runpod.io/user/settings |

`runpod_run` works with its API key alone (`ssh`, `scp`, and `ssh-keygen` must also be on `PATH`). `modal_run` additionally needs the optional Modal SDK, which Academic Harness deliberately does not install so that Add Plugin never blocks on native build scripts. Install it into the profile and restart DSH:

```sh
dsh plugin --profile <profile> add modal
```

Without it, `modal_run` returns an `sdk_missing` message with the same instruction; `runpod_run` remains available.

By default every `runpod_run` call is a brand-new, disposable pod — `/workspace` (and anything uploaded into it) is gone once the pod terminates, so only what's named in `files_out` comes back. Pass `volume_name` to persist data across calls instead: it mounts a Runpod [network volume](https://docs.runpod.io/pods/storage/create-network-volumes) at `/workspace`, and reusing the same `volume_name` on a later call reattaches the same storage — e.g. upload a large dataset once, then run several training/eval passes against it without re-uploading it with `files_in` each time. The volume is looked up by name and created automatically the first time it's used, which requires `data_center_id` (network volumes are pinned to a data center); `volume_size_gb` (default 20) only applies when creating a new one. The pod's compute is always deleted after the call regardless — a named volume is not, and keeps costing storage until deleted from the Runpod console (this tool has no delete-volume path, so it won't silently remove a dataset).

For anything beyond what `modal_run`/`runpod_run` cover — Serverless endpoints, Hub templates, direct volume/secret management, a deployed app, checking GPU availability — the agent loads the bundled `runpod`/`modal` skills (`skills/runpod`, `skills/modal`, shipped and seeded the same way as the specialist skills above) and drives the `runpodctl`/`modal` CLIs directly via `bash`. Neither CLI ships inside this plugin's package, but the agent installs whichever it needs itself, user-locally and without root, per the steps baked into each skill — `runpodctl` as a plain release binary into `~/.local/bin`, `modal` via `uvx modal ...` (no persistent install needed) or `uv tool install modal` for a longer session — rather than asking the user to set it up first.

Note: `runpod_run`/`runpod-client.js` talk to Runpod's REST v1 API (`https://rest.runpod.io/v1`), which Runpod has flagged for retirement on 2026-11-15 in favor of REST v2 — no action needed yet, but worth knowing before that date.

## Lab notebook

`notebook` keeps a running JSONL log per session at `<cwd>/.dsh/notebook/<sessionId>.jsonl` — `action: "log"` for a hypothesis/method/observation/decision/note, `action: "read"` to recall it, `action: "export"` to render it to Markdown (or a `.zip` bundling that Markdown with every artifact file the entries link to — set `export_format: "zip"`).

A subagent the top-level agent delegates to runs in its own DSH session, but its `notebook` calls resolve to the **same** file as its ancestor's — the tool walks the session's delegation lineage (`session.header.parentSession`) back to the root, so a specialist's findings land in the one shared notebook rather than a file nobody reads.

## Scientific results

`scientific_result` is a structured, schema-validated card for a *terminal* finding — a results table (`kind: "table"`) or a statistical-test summary (`kind: "statistical_test"`) — with up to 20 linked workspace-relative artifacts (`role`: figure/table/script/report/data/log). Use it once you have a concrete finding to report; use `notebook` for the running log on the way there. It has no separate storage — the call and its result are already part of the session transcript.

## Workflow templates

`research_template` browses (`action: "list"`, filterable by `category`/`query`) and retrieves (`action: "get"`, with `values` filling `{placeholder}` tokens) a catalogue of ~330 one-click research-task prompt templates across 22 disciplines, ported from Academic Harness's own template library. It is a different tool from DSH's `workflow` (Rhai multi-agent scripts); the Academic Harness preset mounts both, so they cannot share a name.

## Release notes

### 0.22.1

- `coscientist next` no longer samples a task the ledger cannot execute: at the hypothesis cap, reflection waits for a pending review and generation/evolution are off, instead of handing back a no-op the caller has to override.
- `coscientist_rank propose` completes the first ranking before repeating a pair: while any two active hypotheses have never met, a fresh pair plays first, then selection returns to uncertainty-first. The response reports `pair_matches_played` and `unplayed_pairs_remaining`.
- `coscientist start` accepts `max_matches`; `next` reports `match_cap_reached`, so an explicit user stop bound (for example, one match per active pair) is enforced by the ledger rather than the model's judgment.
- The `co-scientist-tournament` skill judges the two presentation orders sequentially with an identical brief, retries a failed orientation with that same brief, and tells the judge not to load skills or call tools. A child that still fails is recorded as `position_controlled: false` instead of substituting a differently worded run.

### 0.22.0

- Tournament Phase 4: `coscientist graph` (Mermaid lineage/similarity/support diagram, `export format: mermaid`), `coscientist priors` (cross-session feedback and withholdings, read from sibling ledgers), and opt-in `coscientist embed` (Gemini text embeddings that move the duplicate gate to cosine). `zvec-grep` cannot supply this — `zg query --vector` embeds a search query and never returns a vector — so embeddings go through the Gemini endpoint the plugin already uses for images.
- Tournament defaults **5 hypotheses / 36 steps**, sized against the termination rules: five is the smallest pool where a review veto plus a dual-use withholding still leaves three ideas competing, and 36 is where an Elo plateau can actually be reached. A fourth stop reason, `no_competitors`, ends a pool that can no longer field a match instead of burning the budget. `coscientist_verify` (optional) adds Crossref citation integrity with the claim-support ledger, `coscientist safety` exposes the dual-use gate, and `scripts/test-coscientist-routing.mjs` checks that a problem-shaped ask still routes to a hypothesis skill.
- `coscientist` + `coscientist_rank`: a persistent hypothesis tournament (Glicko-2 leaderboard, five-stage review, save-time duplicate gate, scheduling policy with step budget, dual-use withholding, Markdown/JSON export) over append-only logs in `<cwd>/.dsh/coscientist/<slug>/`, plus the `co-scientist-tournament` skill. Algorithms and role prompts ported from [`co-scientist`](https://github.com/raktim-mondol/co-scientist) (MIT); no new dependency. See [docs/CO-SCIENTIST-INTEGRATION-PLAN.md](docs/CO-SCIENTIST-INTEGRATION-PLAN.md).
- `mermaid_render` — Mermaid text → SVG via [Pele](https://github.com/obsidianmd/pele) (npm dependency, MIT), in-process with no browser or mermaid-cli install; every Mermaid 12.1.0 diagram type. Written files get Pele's `--pele-*` CSS variables flattened to literal colors so Inkscape/rsvg/CairoSVG don't rasterize them blank.

### 0.21.0

- RSI architecture instrumentation: reached-action activation, injected-token cost, oracle manifests, lesson risk metadata, and explicit `rollback`.
- Seven-layer plugin-RSI mapping documented; versioned skills/global promotion/executable changes are explicitly deferred or out of scope.
- 96 RSI checks; corpus experiment over nine real documents (31/31 injected defects, 23/23 leave-one-project-out coverage, 56.7% routing accuracy, 0.53 held-out safety F1).
- System paper in [`paper/rsi-local/`](paper/rsi-local/).

### 0.20.0

- Local recursive self-improvement (RSI) for all research tasks: automatic capture, diagnosis, lesson admission, injection, injected-versus-control tracking, and quarantine/retirement.
- `ah_rsi` in-session control surface and `academic-harness-rsi` offline CLI.
- Synthetic pipeline benchmark, replay benchmark over real captured episodes, and real `ah audit` snapshot baseline.
- Local-only store at `$DSH_HOME/ah-rsi`; `AH_RSI=off|observe|auto`; no author-approval step; no runtime edits to plugin, engine, project, or evaluator.
- New `ah-rsi` skill and `docs/RSI.md`.

### 0.19.0

- `remove-ai-signs` skill vendored into the plugin (style editing for machine-sounding prose; no detector-evasion or provenance-removal claims) and steered from a new `## Writing quality` prompt section.
- `manuscript_citations` — manuscript ↔ `.bib` consistency for `.tex`/`.md`: missing, unused, and duplicate keys, undefined `\ref` targets, duplicate labels.
- `funder_policy` — OpenAlex funder identity plus Sherpa Juliet per-version OA policy (keyed half).

### 0.18.0

Academic tooling beyond search (see [docs/NON-SEARCH-TOOLS-PLAN.md](docs/NON-SEARCH-TOOLS-PLAN.md)):

- `citation` — local APA/Vancouver/Harvard/IEEE/Chicago/MLA formatting, BibTeX/RIS export, DOI→BibTeX, and validation.
- `integrity_check` — retraction / expression-of-concern / correction status from Crossref + OpenAlex (never `clean` on a failed lookup).
- `review` — systematic/scoping-review ledger with protocol, screening, evidence, PRISMA-style counts, and exports (new `systematic-review-ledger` skill).
- `clinicaltrials` and `openfda` — trial records/posted results and regulatory adverse-event/recall/510(k) data.
- `dataset_search` and `journal_policy` — DataCite discovery with Zenodo/Figshare file listings, and DOAJ + Sherpa Romeo venue policy; new `ZENODO_API_KEY`, `FIGSHARE_API_KEY`, and `DATACITE_API_KEY` support.
- Optional (`AH_ENABLE_OPTIONAL_TOOLS=1`): `author_lookup` (ORCID/ROR), `openreview`, `pdf_references` (BYO GROBID), `stat_audit`, `figure_audit`, `repo_audit`, `grant_search` (NIH/NSF/Grants.gov), and `patent_search` (PatentsView).
- Europe PMC preprint routing: `pubmed_search preprints: true` and a `literature_search` `preprints` source (`SRC:PPR`).

## Development

Every server-side file is plain ESM JS — no build step. The Settings page (`client/`) is the exception: it's a browser bundle (React, esbuild) served to the DSH web client, built with:

```sh
npm install   # once, for esbuild
npm run build # after any client/ change — rebuilds lib/client.js
```

`lib/client.js` is committed so installing the plugin never needs a build step or `pnpm approve-builds` for this package itself.

The tool tests are plain Node scripts and need no network (the Python-helper cases skip themselves when sciPy/Pillow are unavailable):

```sh
for t in citation-format review-store review-tool integrity registries \
         optional-tools audits grants manuscript-tools nonsearch-tools mermaid-render; do
  node scripts/test-$t.mjs
done
```

## License

MIT — see [LICENSE](LICENSE). Scientific skills are vendored or adapted from several open-source catalogues; see [NOTICE](NOTICE) for exactly what was copied, renamed, or adapted from each.
