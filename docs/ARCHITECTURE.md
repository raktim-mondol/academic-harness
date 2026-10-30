# Architecture

Academic Harness is one plugin with two planes: a **bundle** that is mounted for every DSH preset, and an **Academic Harness preset** that mounts once per running `dsh` process and carries the research-specific identity, tools, and connectors.

![Architecture overview](assets/diagrams/architecture.svg)

## The three layers

| Layer | Mounted | What it owns |
|---|---|---|
| **DSH host** | Always | Web UI / TUI, agent session, model route, tool registry, sandbox and approval stack, persistence |
| **Academic Harness bundle** | Every preset | General-purpose tools (`notebook`, `fold_text`, `scientific_result`, `image_generate`, `sci_inspect`, `latex_compile`, `pdf_to_markdown`, `mermaid_render`, `modal_run`, `runpod_run`, `vastai_run`, `research_template`) and the **Settings → Academic Harness API keys** page |
| **Academic Harness preset** | Once per `dsh` process; every session that joins it shares the mount | Persona and research prompt, academic search and evidence tools, PaperMemory, zvec-grep, `paper_fold`, citation and manuscript tools, review and hypothesis ledgers, clinical/regulatory and policy tools, subagent routing, and local RSI |

The split matters when something is missing. A general-purpose tool is present in every session. Everything academic is only present on a session whose preset selector reads **Academic Harness**; on Standard/PTC the same call fails with `tools[name] is not a function`. See [Install → Confirm the preset](INSTALL.md#4-confirm-the-preset).

The preset is a **standing composition**: it mounts once as a shared composition for the life of the running `dsh` process. A new chat session on the same process is not a remount. That is why MCP connectors, subagent model ids, the zvec embedding model, and the optional-tools flag need a full `dsh` restart, while per-call REST tools pick up a Settings change immediately. The full restart matrix is in [Configuration](CONFIGURATION.md#when-a-change-takes-effect).

## Capability map

![Capability map](assets/diagrams/capability-map.svg)

The [tool index](TOOLS.md) lists every registered tool, its scope, and the page that documents it.

## A request through the system

![Request lifecycle](assets/diagrams/request-lifecycle.svg)

1. The user asks a question in the DSH web UI.
2. The agent runs on the Academic Harness preset, so the persona, research prompt, and preset-scoped tools are available.
3. Discovery tools call their providers: native REST tools (`openalex_search`, `s2_search`, `pubmed_search`, `arxiv_search`, `crossref_lookup`, `domain_search`, `consensus_search`, `parallel_search`) or MCP connectors (`mcp__parallel__*`, `mcp__firecrawl__*`, `mcp__scite__*`). `literature_search` also routes bioRxiv/medRxiv, INSPIRE, ADS, Scopus, and Web of Science through their source adapters.
4. Records are normalized to a common shape; `paper_resolve` collapses DOI / PMID / arXiv / OpenAlex / Semantic Scholar identifiers onto one paper, and `integrity_check` reports retraction or correction status.
5. `paper_download` resolves an open-access PDF; a successful download is ingested into PaperMemory as content-addressed markdown.
6. Quotes and claims are checked against stored text (`quote_check`, `trace`) before the agent treats them as evidence.
7. `notebook` records the running work; `scientific_result` records a terminal finding.

Discovery, orientation, and evidence are deliberately separate:

| Layer | Tool | What it answers | What it does **not** prove |
|---|---|---|---|
| Discovery | `literature_search`, `domain_search`, `openalex_search`, `s2_search`, `pubmed_search`, `arxiv_search`, `crossref_lookup`, Consensus, Parallel, Firecrawl, Scite | What exists, and where to look | That a paper supports a sentence |
| Orientation | `paper_fold` | What the paper is about, section by section | A quotation or a number |
| Evidence | PaperMemory `get`, `quote_check`, `trace`, `cite` | What the stored paper actually says | That the paper is correct or current |
| Status | `integrity_check` | Retracted, expression of concern, corrected, clean, unknown, not found | Claim support |

## Runtime installs

The first Academic Harness start prepares optional runtimes in the background, so plugin installation and the web UI are not blocked. A tool that needs a runtime before preparation finishes waits for it.

| Runtime | Installed to | Trigger | Failure behavior | Overrides |
|---|---|---|---|---|
| **zvec-grep (`zg`)** | `~/.dsh/zvec-grep`; daemon state `~/.zvec-grep/daemon/`; model cache `~/.zvec-grep/models`; index `<cwd>/.zvec-grep/` | First Academic Harness preset mount | **Fail-soft.** The rest of the preset loads; semantic search is absent and a warning is logged. | `ZVEC_GREP_CLI`, `ZVEC_GREP_EMBEDDING` |
| **PaperMemory** | venv `~/.dsh/papermemory`; SQLite store `~/.local/share/papermemory/papermemory.db` | First Academic Harness preset mount, unless `papermemory` is already on `PATH` | **Fail-loud.** A broken memory server and any drift from the expected 14-tool MCP surface are surfaced. | `PAPERMEMORY_CLI`, `PAPERMEMORY_DB`, `PAPERMEMORY_DATA_DIR`, `PAPERMEMORY_SKIP_INSTALL` |
| **TextFold** | `$DSH_HOME/textfold/venv`; documents in `$DSH_HOME/textfold/data` | First Academic Harness preset start | The first `paper_fold` call waits for install and reports a failure if it cannot complete. | `TEXTFOLD_SKIP_INSTALL`, `TEXTFOLD_PYTHON`, `TEXTFOLD_CLI`, `TEXTFOLD_DATA` |
| **Writing engine venv** | `vendor/academic-harness/.venv` | First plugin mount, in the background | An early `ah_*` call or interceptor waits for preparation and reports failure. | `ACADEMIC_HARNESS_CLI`, `AH_CMD`, `ACADEMIC_HARNESS_SKIP_INSTALL` |
| **Python helpers** (for `sci_inspect`, `power_analysis`, and the `rob-figure` export) | `python-helpers/.venv` | You run `cd python-helpers && uv sync` once | The tool reports the missing helper environment; `rob-figure` names matplotlib. | `ACADEMIC_HARNESS_HELPERS_DIR`, `ACADEMIC_HARNESS_PYTHON` |

PaperMemory and zvec-grep are separate on purpose: zg is **fail-soft** and PaperMemory is **fail-loud**. Never read a missing zg tool as missing memory. Paper markdown in the workspace is indexed by zg for *discovery*; evidence for claims, numbers, and quotations always comes from PaperMemory.

## Local state

| Path | Owner | Contents |
|---|---|---|
| `<cwd>/.dsh/notebook/<sessionId>.jsonl` | `notebook` | Running lab-notebook entries, shared across a delegation tree |
| `<cwd>/.dsh/review/<slug>/` | `review` | Write-once `protocol.json`; append-only screening, evidence, and appraisal logs; frozen `instruments.json`; exports |
| `<cwd>/.dsh/deep-review/<key>/` | `deep_review` | `review.json`, `review.md`, parsed `paper.md`, `pdf-meta.json`, `citations.json`, `estimate.json`, `meta.json`, append-only `runs.jsonl` |
| `<cwd>/.dsh/coscientist/<slug>/` | `coscientist` | Write-once protocol, append-only `events.jsonl` / `matches.jsonl` |
| `<cwd>/.dsh/paper-mcps.json` | `paper_mcp` | Registered Paper2MCP stdio servers (interpreter, script, env **names**, never secrets) |
| `<cwd>/.zvec-grep/` | zvec-grep | Workspace index |
| `~/.local/share/papermemory/papermemory.db` | PaperMemory | Shared SQLite store (Academic Harness, standalone `papermemory`, Grok) |
| `~/.zvec-grep/` | zvec-grep | Daemon state and token (`daemon/`), model cache (`models/`) |
| `$DSH_HOME/zvec-grep/` | plugin | `zg` npm install |
| `$DSH_HOME/textfold/` | plugin | Pinned TextFold runtime and document store |
| `$DSH_HOME/ah-rsi/` | RSI | Local lesson store (`AH_RSI_STORE` overrides) |
| `vendor/academic-harness/.venv` | plugin | Writing-engine Python environment (gitignored) |

The SQLite store is PaperMemory's default. A standalone `papermemory` CLI, Grok, and Academic Harness share that same database.

## Component map

| Area | Main files |
|---|---|
| Bundle apply, settings, seeding | `index.js`, `settings-keys.js`, `seed.js`, `credential-env.js` |
| Preset prompt and persona | `prompt.js`, `prompt-section.js`, `presets/academic-harness/agent.cordis.yml`, `cordis.patch.yml` |
| MCP connectors | `mcp-connectors.js` |
| Search providers | `literature-search.js`, `openalex-search.js`, `openalex-cite.js`, `semantic-scholar-search.js`, `crossref-lookup.js`, `arxiv-search.js`, `pubmed-search.js`, `consensus-search.js`, `parallel-search.js`, `parallel-extract.js`, `brave-search.js`, `tavily-search.js`, `exa-search.js`, `perplexity-search.js`, `jina-reader.js`, `core-search.js`, `elicit-search.js`, `futurehouse-agent.js`, `search-normalize.js`, `search-http.js` |
| Papers and memory | `paper-resolve.js`, `paper-download.js`, `paper-fold.js`, `textfold-runtime.js`, `pdf-to-markdown.js`, `papermemory.js`, `paper-mcp.js` |
| Citation and writing | `citation.js`, `citation-format.js`, `manuscript-citations.js`, `integrity-check.js`, `academic-harness.js`, `academic-harness-hooks.js`, `academic-harness-cli.js`, `vendor/academic-harness/` |
| Reviews and hypotheses | `review.js`, `review-store.js`, `deep-review.js`, `vendor/open-deepreview/`, `agreement.js`, `appraisal.js`, `appraisal/`, `papermemory-mcp.js`, `coscientist.js`, `coscientist-rank.js`, `coscientist-store.js`, `coscientist-models.js`, `coscientist-verify.js`, `coscientist-embed.js`, `store-lock.js` |
| Clinical, datasets, policy | `clinicaltrials.js`, `openfda.js`, `dataset-search.js`, `journal-policy.js`, `funder-policy.js` |
| Workspace and notebook | `notebook.js`, `notebook-export.js`, `notebook-zip.js`, `zvec-grep.js`, `zvec-index.js`, `zvec-index-engine.js`, `fold-core.js`, `fold-text.js`, `scientific-result.js` |
| Figures and file formats | `image-generate.js`, `image-gen-client.js`, `mermaid-render.js`, `sci-inspect.js`, `latex-compile.js`, `python-helpers/` |
| Remote compute | `modal-run.js`, `modal-runtime.js`, `modal-instances.js`, `runpod-run.js`, `runpod-client.js`, `runpod-instances.js`, `vastai-run.js`, `vastai-client.js`, `vastai-instances.js`, `ssh-client.js`, `workspace-path.js`, `pnpm-workspace.js` |
| Subagents | `subagent-models.js` + the preset's delegation rows |
| RSI | `rsi.js`, `rsi-hooks.js`, `rsi-store.js`, `rsi-core.js`, `rsi-benchmark.js`, `academic-harness-rsi-cli.js`, [RSI.md](RSI.md) |
| Web UI | `client/`, built to `lib/client.js` |
| Skills | `skills/` (746 skills); see [Skills](SKILLS.md) |

Every server-side file is plain ESM JS — no build step. Only the Settings page (`client/`) is a browser bundle; see [Development](DEVELOPMENT.md).

## Design notes

- [Academic Harness engine](ACADEMIC-HARNESS-ENGINE.md) — why the writing oracle is vendored and the open decision about its long-term home.
- [RSI](RSI.md) — the local self-improvement loop, its store, and its autonomy boundary.
- [Co-Scientist integration plan](CO-SCIENTIST-INTEGRATION-PLAN.md), [non-search tools plan](NON-SEARCH-TOOLS-PLAN.md), [search providers plan](SEARCH-PROVIDERS-PLAN.md), and [PaperMemory v2 plan](PAPERMEMORY-V2-PLAN.md) — implementation records with more detail than the user guides.
