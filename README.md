# dsh-researchcraft

ResearchCraft as a **DeepSeek Harness** profile: the DSH web UI and DSH agent, with ResearchCraft’s scientific skills, living lab notebook, and specialist subagents.

## Install

ResearchCraft 0.13+ requires **DeepSeek Harness 0.2.1 or later**. Install DSH first:

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
   | GitHub (recommended) | `github:raktim-mondol/dsh-researchcraft` |
   | npm registry | `dsh-researchcraft` — available once this package is published to npm |
   | Local checkout | the absolute path, e.g. `/home/you/dsh-researchcraft` |

4. Click **Install**. ResearchCraft is installed into the profile you are currently running, enabled by default, and appears under **Installed plugins**.
5. Start a new chat and confirm the preset selector reads **ResearchCraft**.

The bundle patches the web-app layer, so the profile must already include `@deepseek-ai/dsh-web-app`; the standard `web` profile does. A local path must be absolute — the dialog does not expand `~` or resolve relative paths. Installing this way adds ResearchCraft to your current profile; use Option B for a dedicated `researchcraft` profile. DSH only offers **Update** for its on-demand Official plugins, so update a UI-installed ResearchCraft by removing and reinstalling it.

### Option B — Install a dedicated profile from the CLI

```sh
dsh plugin --profile researchcraft add github:raktim-mondol/dsh-researchcraft
```

This creates the `researchcraft` profile if it does not exist yet and adds ResearchCraft to it. Start it with:

```sh
dsh --profile researchcraft
```

To update this profile later:

```sh
dsh plugin --profile researchcraft update dsh-researchcraft
```

For local plugin development, the same command accepts an absolute checkout path:

```sh
dsh plugin --profile researchcraft add /absolute/path/to/dsh-researchcraft
```

## Run

```sh
dsh --profile researchcraft
# or, if you use the shared launcher:
dsh-researchcraft
```

Opens the Harness web UI (typically `http://127.0.0.1:3080`).

**One DSH surface at a time.** `dsh-web`, `dsh-tui`, `dsh-martty`, and `dsh-researchcraft` share `$DSH_HOME` (including port `3080` and the zvec-grep daemon). Ctrl+C does not always wait for those to exit, so starting another launcher while one is still in the background will fail or pick up the wrong process. The shared launcher (`scripts/dsh-launch`, installed as those four commands) stops leftover DSH processes and `zg server off` before exec. If you invoke `dsh --profile …` directly, stop the previous one first:

```sh
# leftover web UI
ss -ltnp | grep 3080
# leftover zg daemon
zg server off
```

The ResearchCraft profile's bundle patch sets `agent-preset-registry` `default: researchcraft` and inserts a `preset-researchcraft` declaration (DSH 0.2+ no longer reads `$DSH_HOME/.agent-presets/`). New chats on this profile start on **ResearchCraft**. Confirm the preset selector at the top of the message box reads "ResearchCraft"; if it still says Standard/PTC, the profile patch did not apply.

The persona, the longer research system prompt (notebook discipline, specialist roster, connector guidance, …), academic search (`mcp__parallel__*`, `parallel_search`, `mcp__firecrawl__*`, `mcp__scite__*`, `consensus_search`), PaperMemory (`mcp__papermemory__*`), workspace semantic search (`mcp__zvec_grep__zvec_grep_search`), and `paper_mcp` (Paper2Agent stdio mounts) are only present on this preset — a session left on Standard/PTC won't have them, and asking it to use e.g. the Parallel connector will fail with `tools[name] is not a function`. The general-purpose tools below (notebook, image_generate, sci_inspect, latex_compile, pdf_to_markdown, modal_run/runpod_run, workflow) are available on every preset regardless, since they're registered at the plugin/bundle level rather than inside the ResearchCraft preset. Native `grep` / `glob` come from the ResearchCraft preset's filesystem-search row.

## What it adds

- **ResearchCraft agent preset** — persona, research system prompt (notebook discipline, specialist roster, connector guidance), standard coding tools, and the academic search connectors below. This profile defaults to it — see [Run](#run).
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

  `RESEARCHCRAFT_SKILLS_DIR` (or a `~/scientific-agent-skills/skills` checkout) still works as an override if you want a different catalogue instead — available on every preset
- `notebook` tool — log, read, and export a living lab notebook (JSONL under `<cwd>/.dsh/notebook/`), shared across a subagent delegation tree, with a zip-bundle export alongside the plain Markdown one — every preset
- `scientific_result` tool — a structured, schema-validated "final finding" card (table or statistical-test), distinct from the notebook's running log — every preset
- Specialist briefs (code-reviewer, literature-researcher, …) for the DSH `subagent` tool, plus `subagent_pro` and `subagent_vision` — two more delegation tools pinned to a different model for unusually heavy reasoning and image-reading tasks respectively — see [Subagent model routing](#subagent-model-routing) — every preset
- `image_generate` tool for conceptual scientific figures (Gemini "nano banana" by default) — every preset
- `sci_inspect` tool for scientific file formats (chemistry, structure, mass spec, arrays, imaging, AnnData) — every preset
- `latex_compile` tool (`.tex` → PDF, bibtex/biber-aware) — every preset
- [Academic Harness](https://github.com/raktim-mondol/academic-harness) writing oracle for LaTeX papers, grants, theses, literature reviews, and rebuttals: native `ah_*` tools, paper-state card, protected-path guard, post-edit checks, and a gate that settles a writing turn. The engine is vendored inside this plugin (`vendor/academic-harness`); Pi is not required. Inactive outside a tree with `ah.yaml` — **ResearchCraft preset only** — see [Academic Harness](#academic-harness)
- `pdf_to_markdown` tool (PDF → Markdown, via [pdf-inspector](https://github.com/firecrawl/pdf-inspector)) for literature-survey conversion of downloaded papers — every preset
- `runpod_run` (works with its API key) and `modal_run` (needs the optional `modal` SDK installed in the profile) for remote GPU/CPU compute offload, plus bundled `modal`/`runpod` skills covering the rest of each CLI (Serverless endpoints, volumes/secrets, Hub templates, …) — see [Remote compute](#remote-compute) — every preset
- `research_template` tool over a ~330-template research-task catalogue (not DSH's Rhai `workflow` orchestrator) — every preset
- Academic search: Parallel, Firecrawl, Scite (MCP connectors), `parallel_search` / `consensus_search` (native REST tools), and `paper_download` (Unpaywall open-access PDF resolver) — **ResearchCraft preset only**
- `paper_mcp` tool — register a Paper2MCP stdio server from this workspace (`<cwd>/.dsh/paper-mcps.json`) so its tools can appear as `mcp__<serverName>__*` — **ResearchCraft preset only** — see [Paper agents](#paper-agents-paper2agent)
- [PaperMemory](https://github.com/raktim-mondol/papermemory) local academic memory: `mcp__papermemory__*` (search, ingest, cite, cite-check, recap, remember, claim). First ResearchCraft start uses `papermemory` on PATH or installs the vendored package into `~/.dsh/papermemory`. `paper_download` auto-ingests the saved PDF. Store: `~/.local/share/papermemory/papermemory.db` — **ResearchCraft preset only** — see [Paper memory](#paper-memory)
- Workspace semantic search via [zvec-grep](https://github.com/zvec-ai/zvec-grep): `mcp__zvec_grep__zvec_grep_search` (local BM25 + vectors). First ResearchCraft start installs the `zg` CLI into `~/.dsh/zvec-grep`. Indexing is **off at session start by default** (Settings → Index at session start); you can index later from chat, and the agent asks first when semantic search would help. While indexing, a progress bar with estimated time and Cancel is shown (no timeout) — exact lookup stays on native `grep` / `glob` — **ResearchCraft preset only** — see [Workspace search](#workspace-search)
- Bundled `agent-browser` skill for interactive web browsing (navigate, log in, fill forms, download datasets), with screenshots delegated to `subagent_vision` — see [Browsing the web](#browsing-the-web) — every preset
- A **Settings → ResearchCraft API keys** page for the connectors and models above — no shell env vars required. PaperMemory needs no key.

## API keys

Every credential below (`PARALLEL_API_KEY`, `FIRECRAWL_API_KEY`, `CONSENSUS_API_KEY`, `SCITE_API_KEY`, `UNPAYWALL_EMAIL`, `GEMINI_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `RUNPOD_API_KEY`, `ZVEC_GREP_API_KEY`) can be set two ways:

- **Settings → ResearchCraft API keys** in the DSH web UI — type a key, Save. Persisted in the profile's `settings.yaml`; a blank field always means "keep the current value", Clear removes it.
- **Shell environment variable** — takes priority over Settings when both are set.

The same Settings page also has an **Image model** dropdown for `IMAGE_MODEL` — not a credential, so it isn't password-masked and applies immediately on selection rather than needing Save (see [Image generation](#image-generation)). It also has two more model-id dropdowns, **Complex-task model** (`SUBAGENT_MODEL_COMPLEX`) and **Image-reading model** (`SUBAGENT_MODEL_VISION`) — not credentials either, but these two behave like the MCP connectors below, not like Image model: they need a restart to apply (see [Subagent model routing](#subagent-model-routing)). **zvec-grep embedding** (`ZVEC_GREP_EMBEDDING`) is the same restart-needed dropdown: it is passed into `zg server on` at mount time. **Index at session start** (`ZVEC_GREP_AUTO_INDEX`, default No) is live for the next ResearchCraft session — no restart (see [Workspace search](#workspace-search)).

Tools that call `resolveEnv()` per invocation (`image_generate`, `modal_run`, `runpod_run`, `consensus_search`, `parallel_search`, `paper_download`) pick up a Settings change on the very next call, no restart needed.

The MCP connectors (Parallel, Firecrawl, Scite, zvec-grep, PaperMemory) and the two subagent-model fields are different: the `researchcraft` agent preset mounts once as a standing composition shared by every chat session for the life of the running `dsh` process, so a change only reaches them after you **stop and restart `dsh` itself** — a new chat session on the same running process is not enough. `consensus_search` and `parallel_search` aren't MCP connectors — see below — so they don't have this restart requirement.

**Also make sure the chat session is actually on the ResearchCraft preset.** The MCP connectors, native academic-search tools (`consensus_search`, `parallel_search`), `mcp__zvec_grep__zvec_grep_search`, and `mcp__papermemory__*` are wired into the `researchcraft` agent preset only; a session left on the default preset (Standard/PTC/etc.) has none of them, and calling one fails with `tools[name] is not a function`. Check the preset selector next to the session title (top of the message box for a new chat, top-left of an existing one) reads "ResearchCraft" before asking the agent to search.

## Workspace search

[zvec-grep](https://github.com/zvec-ai/zvec-grep) (`zg`) is the local-first hybrid search layer on the ResearchCraft preset: BM25 + vectors over an on-disk index, exposed as `mcp__zvec_grep__zvec_grep_search`. Exact words, quotes, identifiers, filenames, regexes, and exhaustive hit lists stay on the preset's native `grep` / `glob` (`@deepseek-ai/dsh-tool-fs-search`). Open-web and literature search stay on Parallel / Consensus / Firecrawl / Scite — zg is workspace-only.

You do **not** install `zg` yourself. The first time the ResearchCraft preset mounts after `dsh plugin add`, the plugin runs `npm install --prefix ~/.dsh/zvec-grep @zvec/zvec-grep@^0.2.2`, starts `zg server on` (the loopback daemon), and mounts search over Streamable HTTP at `http://127.0.0.1:7999/mcp` — no second restart. That first start can take several minutes (npm + later the ~130 MB Potion model). Later starts reuse `~/.dsh/zvec-grep`, **upgrade it if the bundled copy is older than 0.2.2**, and start the daemon again. Stopping `dsh` runs `zg server off`, so the daemon does not stay up in the background. Override with `ZVEC_GREP_CLI` if you already have a `zg` binary you want to keep. If install or the daemon fails, the rest of the preset still loads and the search tool is absent (a warning is logged).

The plugin talks to the daemon over HTTP (DSH's MCP client is Streamable HTTP), not `zg server --stdio`. 0.2.2+ also fixes the stdio heartbeat race ([zvec-grep#106](https://github.com/zvec-ai/zvec-grep/issues/106)); HTTP remains the mount we use.

Indexing is **opt-in**. Settings → ResearchCraft API keys → **Index at session start** defaults to **No**. When No (the default), a new chat does not index; you can still type “index this workspace” in the chat, and whenever semantic search would help the agent asks first (and only indexes if you say yes). When Yes, opening a ResearchCraft session indexes **that workspace** in the background if no index exists yet (`zg index --embedding local/potion-retrieval-32m`, local, no API key).

While an index runs — from session start or from chat — the UI shows a **progress bar with estimated time** in Settings and in the session header, and **Cancel** is always available. There is **no timeout**. Existing indexes are left alone (no silent rebuild/drop). Home directory and `/` are not indexed. Indexes live in `<cwd>/.zvec-grep/`; the model cache is `~/.zvec-grep/models` (~130 MB once).

```sh
# only if you want to index by hand or pick a different local model
zg index --embedding local/potion-retrieval-32m    # default — papers / notes / mixed
zg index --embedding local/potion-code-16m-v2      # smaller (~65 MB model), code-heavy trees
zg status --check-ready
```

Every MCP call needs an **absolute** `root` (the session working directory). Relative paths fail. The native `zvec_index` tool (`start` / `status` / `cancel`) is what the agent uses instead of shelling out to `zg index`.

| Setting / env | What it does |
|---|---|
| `ZVEC_GREP_AUTO_INDEX` | `yes` / `no`. Index this workspace when a ResearchCraft session opens. Default `no`. Live for the next session (no restart). |
| `ZVEC_GREP_EMBEDDING` | Default model id for *new* indexes. Unset means `local/potion-retrieval-32m`. Existing indexes keep their stored model. Restart `dsh` after changing — the next start brings up a fresh daemon with the new value. |
| `ZVEC_GREP_API_KEY` | **Not used** with the default local Potion models. Only if you opt into a remote (Qwen) embedding provider. |
| `ZVEC_GREP_CLI` | Absolute path to `zg` or to `@zvec/zvec-grep`'s `dist/cli/index.js`. Env only. |

The loopback daemon under `~/.zvec-grep/daemon/` is started with the ResearchCraft preset and stopped when `dsh` exits. You do not need `zg server off` by hand.

Install, index, and routing details for the agent are in the bundled `zvec-grep` skill (`skills/zvec-grep`).

## Academic search

Three literature/web MCP servers are wired into the `researchcraft` preset and surface as `mcp__parallel__*`, `mcp__firecrawl__*`, `mcp__scite__*` tools:

| Connector | Key | Without it |
|---|---|---|
| [Parallel](https://parallel.ai) — `mcp__parallel__web_search` (search fallback, always `basic`) and `mcp__parallel__web_fetch` (read a URL) | `PARALLEL_API_KEY` (required) | Connector stays disabled. The key is always sent as a Bearer token so MCP calls are not on the anonymous rate limit. |
| [Firecrawl](https://firecrawl.dev) — scrape/crawl/extract | `FIRECRAWL_API_KEY` (optional) | Works keyless, rate-limited |
| [Scite](https://scite.ai) — Smart Citations, retraction/correction checks, evidence datasets (patents, clinical trials, grants, drug safety, …) | `SCITE_API_KEY` (required) | Connector stays disabled |

`parallel_search` is the **primary** Parallel search tool: a native REST call to `POST /v1/search` (`x-api-key` auth). It requires `PARALLEL_API_KEY` and a **`mode` on every call**. `mcp__parallel__web_search` is the same search job locked to `basic` — the agent is steered to use it only if `parallel_search` is missing or errors. `mcp__parallel__web_fetch` is for reading a specific URL, not for search. Pass `objective`, 1–5 keyword `search_queries`, and `mode`:

| Mode | Latency | Best for |
|---|---|---|
| `turbo` | ~250ms | Simple fact lookups, current numbers, high-volume pre-filtering. English and Japanese queries only. |
| `fast` | ~700ms | Recommended default for most agent loops (interactive lookup, tool-calling). |
| `basic` | ~1s | Longer excerpts per source; 2–3 high-quality queries. Same mode the MCP search tool always uses. |
| `advanced` | ~3s | Multi-hop retrieval for literature surveys, deep research, code-review background. |

The system prompt steers the agent to use **both** `consensus_search` and `parallel_search` (`basic` or `advanced`) for peer-reviewed literature, `fast` only for ordinary non-literature lookups, and `mcp__parallel__web_search` only as a fallback when `parallel_search` is unavailable. A Settings-changed `PARALLEL_API_KEY` takes effect on the next `parallel_search` call; the MCP connector still needs a `dsh` restart.

[Consensus](https://consensus.app) is a native `consensus_search` tool (not an MCP connector) over its `GET /v1/search` REST API — plain `x-api-key` auth, no OAuth. Requires `CONSENSUS_API_KEY` (required — the tool returns a clear error, not a disabled connector, when unset). Supports the API's full filter set: study type, year/month range, sample size, journal quartile (SJR), citation count, study duration, domain, country, publisher, open-access/preprint/human/controlled/clinical-guideline flags, and pagination.

[Unpaywall](https://unpaywall.org) backs `paper_download` (also a native REST tool, not an MCP connector): given a DOI, it resolves the best open-access location and the tool downloads that PDF straight into the workspace (or downloads a direct URL you already have, no DOI needed). Requires `UNPAYWALL_EMAIL` — Unpaywall's API asks callers to identify themselves with a real contact email; the tool returns a clear error, not a disabled connector, when unset, and never invents one on your behalf. When a DOI has no open-access copy, the tool returns a plain "paywalled" result (with the landing-page URL) rather than an error — the agent is steered to report that honestly instead of inferring the paper's content from a search snippet. The response is also checked against the PDF magic bytes before being saved, so a login/CAPTCHA page returned instead of the real file surfaces as a clear error rather than a corrupt "PDF." A successful download is ingested into PaperMemory (see [Paper memory](#paper-memory)); ingest failure does not fail the download.

## Academic Harness

[Academic Harness](https://github.com/raktim-mondol/academic-harness) is the writing oracle for long academic LaTeX documents: literature reviews, journal and conference papers, grant proposals, theses, and rebuttals. A paper has no compiler. The engine inventories every number, citation, unit, and declared claim, then a **gate** closes only when this turn introduced no open blocker or major. Unchanged units keep the verdicts they already had.

You do **not** install Pi, and you do not install Academic Harness into DSH. The engine is part of this plugin (`vendor/academic-harness`). Where that tree should live long-term is an [open decision](docs/ACADEMIC-HARNESS.md). On first mount the plugin prepares a local `.venv` next to that vendored tree (via `uv`, or `python -m venv` + pip) **in the background**, so plugin installation and the web UI are not blocked; an `ah_*` call or interceptor triggered before preparation finishes waits for it. Interceptors (paper-state card, protected-path guard, post-edit check, gate) are inactive outside a directory tree with `ah.yaml`, so ordinary ResearchCraft sessions are unchanged. Override with `ACADEMIC_HARNESS_CLI` or `AH_CMD`; `ACADEMIC_HARNESS_SKIP_INSTALL=1` skips creating the plugin-local venv.

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
| `ah_author` | you | Waive, accept/reject a fact, approve a brief or plan, verify a claim, decline a review item, fill provenance, approve a disclosure. DSH asks you to confirm. |

Skills: `academic-harness` (router), `ah-write-unit`, `ah-plan-section`, `ah-fix-findings`, `ah-audit-section`, `ah-revise-from-review`.

In a project directory:

1. Pick the ResearchCraft preset.
2. `ah_init` (new) or `ah_migrate` (existing tree).
3. Write through `ah-write-unit`. The gate keeps the agent on this turn's findings.

T3 (does this cited clause match the source) is advisory and never a gate. Optional model backends in `ah.yaml` are `http` (OpenAI-compatible, including local Ollama) or `command`. The engine's unused `pi` backend is not required.

## Paper memory

[PaperMemory](https://github.com/raktim-mondol/papermemory) is the local academic-memory layer on the ResearchCraft preset: papers (title, authors, year, venue, DOI, arXiv, bibtex key), claims with quoted evidence, citation graphs, manuscript recap, and cite-check. It is how the agent remembers papers it has read and cites without inventing references — open-web and peer-reviewed discovery stays on Parallel / Consensus / Firecrawl / Scite.

You do **not** install PaperMemory yourself. The first time the ResearchCraft preset mounts after `dsh plugin add`, the plugin uses `papermemory` already on `PATH` if present, otherwise installs the vendored package (with `pypdf`) into `~/.dsh/papermemory` via `uv` (or `python -m venv` + pip). It then mounts `mcp__papermemory__*` over stdio (`papermemory mcp`) — no second restart. If install or the MCP handshake fails, the rest of the preset still loads and the memory tools are absent (a warning is logged). Override with `PAPERMEMORY_CLI` if you already have a binary you want to keep; `PAPERMEMORY_SKIP_INSTALL=1` skips the bundled venv.

The SQLite store is PaperMemory's default: `~/.local/share/papermemory/papermemory.db` (override `PAPERMEMORY_DB` or `PAPERMEMORY_DATA_DIR`). A standalone `papermemory` CLI, Grok, and ResearchCraft share that same database. No API key.

| Tool | What it does |
|---|---|
| `mcp__papermemory__papermemory_recap` | Writing-project briefing: venue, sections, contributions, citation gaps |
| `mcp__papermemory__papermemory_search` | Hybrid search over papers, claims, chunks, notes, lessons |
| `mcp__papermemory__papermemory_ingest` | Ingest a local PDF/BibTeX/markdown/manuscript path, or an arXiv id / DOI |
| `mcp__papermemory__papermemory_get` | Paper by id or bibtex key, with claims and chunks |
| `mcp__papermemory__papermemory_cite` | Find a stored paper to cite. Empty result means do not invent a citation |
| `mcp__papermemory__papermemory_cite_check` | Compare a manuscript's in-text keys against memory |
| `mcp__papermemory__papermemory_remember` | Save a writing/reading decision |
| `mcp__papermemory__papermemory_claim` | Store a claim with optional evidence quote |
| `mcp__papermemory__papermemory_lesson` | Save a durable academic writing/reading rule |

`paper_download` calls ingest on the saved PDF (and DOI metadata when a DOI was given). The agent is steered to `recap` on paper-writing tasks, to cite only memory hits, and to `cite_check` before treating a section as finished. Load the bundled `papermemory` skill (`skills/papermemory`) for the full workflow.

## Paper agents (Paper2Agent)

The bundled `paper2agent` skill ([jmiao24/Paper2Agent](https://github.com/jmiao24/Paper2Agent), MIT) turns a paper and/or its code repository into (1) a reviewed, compact paper skill and (2) a tested FastMCP server of that paper's methods. Load it with the `skill` tool when the user asks to agentify a paper. It is not a replacement for `pdf_to_markdown` (fast unreviewed extract) or for catalogue skills such as `scanpy` (how-to).

A full repository conversion is long (many `subagent` specialists plus independent verifiers). The agent should confirm scope first. After a verified ZIP, connect the server **only when asked**, with native `paper_mcp` (`register` / `status` / `unregister`) on the ResearchCraft preset. That writes `<cwd>/.dsh/paper-mcps.json` (interpreter, server script, env **names** — never secrets) and tries to mount the server over stdio so tools appear as `mcp__<serverName>__*`. Those mounts are standing for the life of `dsh`, same as Parallel/Scite: if tools do not appear, restart `dsh`. A different workspace that reuses the same `serverName` also needs a restart.

Do not run `claude mcp add`. GPU papers use `runpod_run` / `modal_run` rather than a silent CPU fallback.

| Setting / env | What it does |
|---|---|
| `PAPERMEMORY_CLI` | Absolute path to a `papermemory` binary. Env only. |
| `PAPERMEMORY_DB` / `PAPERMEMORY_DATA_DIR` | Override the SQLite store location. Env only. |
| `PAPERMEMORY_PROJECT` | Default project slug for `paper_download` auto-ingest. Env only; otherwise the workspace directory name. |
| `PAPERMEMORY_SKIP_INSTALL` | `1` to skip installing the bundled venv (PATH / `PAPERMEMORY_CLI` still work). |

## Browsing the web

Built-in `web_search` works (DeepSeek search provider). Built-in `web_fetch` retrieves public HTTP(S) pages through the local HTTP provider; if a page is blocked, needs JavaScript, or returns `WEB_PROVIDER_UNAVAILABLE`, the agent falls back to `mcp__firecrawl__firecrawl_scrape` (Firecrawl's fetch) or `mcp__parallel__web_fetch`. DeepSeek's Search and Fetch APIs can be enabled in Web Search settings. For anything that needs a real rendered browser — exploring a site interactively, logging in, filling out a form, clicking through to a dataset download, or verifying a page actually renders correctly — the agent loads the bundled `agent-browser` skill (`skills/agent-browser`, shipped and seeded the same way as the skills above) and drives the [agent-browser](https://github.com/vercel-labs/agent-browser) CLI directly via `bash`. The CLI isn't bundled with this plugin's package, but the agent installs it itself when missing (`npm i -g agent-browser && agent-browser install`, or `npx agent-browser@latest ...` for a one-off task) rather than asking the user to.

Most of what it does — navigating, reading, filling forms, extracting data, downloading files — works off an accessibility-tree snapshot and needs no image at all. The one exception is `screenshot`: since the session's own model isn't guaranteed to have vision input, the skill steers the agent to delegate reading any screenshot to `subagent_vision` (see [Subagent model routing](#subagent-model-routing)) instead of guessing at its content.

Set any of these via Settings → ResearchCraft API keys or the matching env var (see [API keys](#api-keys)). `SCITE_API_KEY` is an `mcp`-scoped key from [scite.ai/users/me/api](https://scite.ai/users/me/api) — Scite's own documented non-interactive path for MCP clients, sent as a bearer token to `https://api.scite.ai/mcp` (no OAuth or token exchange). Scite also offers an OAuth flow, but only for its first-party ChatGPT/Claude plugin and other interactive clients — not relevant here.

## Subagent model routing

Besides the plain `subagent`/`subagent_fork` delegation tools, the `researchcraft` preset adds two more that pin a delegated child to a specific model via `agentOptions.model`, so the agent can route a task to the model that fits it instead of running everything on whatever model the current chat session happens to be on:

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

Set `SUBAGENT_MODEL_COMPLEX`/`SUBAGENT_MODEL_VISION` via Settings → ResearchCraft API keys (two more dropdowns beside Image model) or the matching env var — env wins when both are set, same resolution order as the API keys above. Unlike Image model, these two need a `dsh` restart to take effect (see [API keys](#api-keys)).

## Figures

The system prompt steers the agent to pick a figure tool by content, not by habit, and to load the matching skill before drawing:

- **Numeric data** (plots, charts, distributions, trends) — `scientific-figure-making`: real matplotlib over real computed data, house-style helpers, PNG+PDF export. Never `image_generate` and never fabricated values. Named journals also load `scientific-visualization` for column widths.
- **Structural diagrams** (architecture, pipelines, flowcharts, method schematics, CONSORT, trees, timelines) — `diagram-design`: self-contained HTML+SVG editorial diagrams (one accent, no shadows, orthogonal connectors). Not Mermaid rounded boxes, not `image_generate`. For a paper or compiled PDF the agent also exports PNG/SVG. Mermaid is only when the user explicitly wants a git-diffable markdown diagram.
- **Conceptual illustrations** with no defined structure and no real numbers — `image_generate`.

### Image generation

`image_generate` writes conceptual schematics, diagrams, and illustrations to the workspace — not quantitative plots (those should be real Python/matplotlib output over real data).

- **Default (Gemini):** set `GEMINI_API_KEY` (Settings or env). Model defaults to `gemini-2.5-flash-image` ("nano banana"); pick a different one from the **Image model** dropdown in Settings → ResearchCraft API keys (`gemini-3.1-flash-image` "nano banana 2", `gemini-3-pro-image` "nano banana pro", or a custom model id), or set `IMAGE_MODEL` (env). Unlike the API-key fields, the dropdown applies immediately on selection — no Save button, and (like `resolveEnv()` fields) no restart needed.
- **OpenAI-compatible Images API instead:** set `IMAGE_PROVIDER=openai`, `IMAGE_MODEL` (Settings or env), `IMAGE_BASE_URL` (env only) plus `IMAGE_API_KEY` (Settings or env).

## Scientific file inspection

`sci_inspect` summarizes SMILES/MOL/SDF, PDB/CIF, mzML and other mass-spec formats, npy/npz/parquet/hdf5, TIFF/NIfTI/DICOM, and h5ad files by shelling out to the bundled Python helpers under `python-helpers/`.

Set up the helper venv once (needs [uv](https://docs.astral.sh/uv/)):

```sh
cd python-helpers && uv sync
```

The tool finds `python-helpers/.venv` automatically. Override with `RESEARCHCRAFT_HELPERS_DIR` (a different helpers checkout) or `RESEARCHCRAFT_PYTHON` (a specific interpreter).

## LaTeX

`latex_compile` compiles a `.tex` file to PDF: `latexmk` when it's on `PATH` (handles bibtex/biber automatically), otherwise a `pdflatex`/`xelatex`/`lualatex` fallback with a bibtex/biber pass when the source needs one. Requires a TeX Live (or similar) install.

## Downloading and reading papers

Two tools cover the full loop for actually reading a paper rather than just its abstract: `paper_download` (ResearchCraft preset only — see [Academic search](#academic-search)) gets the PDF onto disk, and `pdf_to_markdown` (every preset) turns it into readable text. A successful `paper_download` is also ingested into PaperMemory (see [Paper memory](#paper-memory)).

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

`runpod_run` works with its API key alone (`ssh`, `scp`, and `ssh-keygen` must also be on `PATH`). `modal_run` additionally needs the optional Modal SDK, which ResearchCraft deliberately does not install so that Add Plugin never blocks on native build scripts. Install it into the profile and restart DSH:

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

`research_template` browses (`action: "list"`, filterable by `category`/`query`) and retrieves (`action: "get"`, with `values` filling `{placeholder}` tokens) a catalogue of ~330 one-click research-task prompt templates across 22 disciplines, ported from ResearchCraft's own template library. It is a different tool from DSH's `workflow` (Rhai multi-agent scripts); the ResearchCraft preset mounts both, so they cannot share a name.

## Development

Every server-side file is plain ESM JS — no build step. The Settings page (`client/`) is the exception: it's a browser bundle (React, esbuild) served to the DSH web client, built with:

```sh
npm install   # once, for esbuild
npm run build # after any client/ change — rebuilds lib/client.js
```

`lib/client.js` is committed so installing the plugin never needs a build step or `pnpm approve-builds` for this package itself.

## License

MIT — see [LICENSE](LICENSE). Scientific skills are vendored or adapted from several open-source catalogues; see [NOTICE](NOTICE) for exactly what was copied, renamed, or adapted from each.
