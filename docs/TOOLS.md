# Tool index

Every tool registered by Academic Harness, with its scope and the page that documents it. Scope is not cosmetic: a tool listed as **Academic Harness preset** is absent from a session on Standard/PTC, and calling it there fails with `tools[name] is not a function`.

| Scope | Meaning |
|---|---|
| **Every preset** | Registered by the plugin bundle, so every DSH session has it |
| **Academic Harness preset** | Mounted only for sessions joined to the Academic Harness preset |
| **Optional** | Needs `AH_ENABLE_OPTIONAL_TOOLS=1`; absent from the tool list and prompt otherwise |
| **DSH built-in** | Supplied by DeepSeek Harness, not by this plugin |

The diagrams in [Architecture](ARCHITECTURE.md) show how the bundle and preset relate. For the general-purpose tools, see [Workspace](WORKSPACE.md), [Writing](WRITING.md), and [Compute](COMPUTE.md).

## Research workflow

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `notebook` | Every preset | Log, read, and export a living JSONL lab notebook under `<cwd>/.dsh/notebook/`, shared across a delegation tree; Markdown or zip export | [Workspace](WORKSPACE.md#lab-notebook) |
| `scientific_result` | Every preset | Schema-validated terminal finding card: results table or statistical test, with linked artifacts | [Workspace](WORKSPACE.md#scientific-results) |
| `fold_text` | Every preset | Deletion-only Markdown folding at five levels with no model call; `write_to` saves the result | [Workspace](WORKSPACE.md#reply-folding) |
| `research_template` | Every preset | Browse and fill ~330 research-task prompt templates across 22 disciplines | [Workspace](WORKSPACE.md#workflow-templates) |
| `workflow` | DSH built-in | DSH's Rhai multi-agent workflow orchestrator; separate from `research_template` | [Workspace](WORKSPACE.md#workflow-templates) |

## Papers, PDFs, and evidence

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `paper_download` | Academic Harness preset | DOI / arXiv ID / URL → open-access PDF, tried through Unpaywall, OpenAlex, Europe PMC, CORE, and arXiv; auto-ingests into PaperMemory | [Papers](PAPERS.md#download-a-paper) |
| `paper_fold` | Academic Harness preset | Map-first paper reading through TextFold: section map, then one section at a time; local first-sentence levels by default | [Papers](PAPERS.md#read-at-the-right-level) |
| `pdf_to_markdown` | Every preset | PDF → Markdown with headings, lists, tables, and reading order; optional OCR for scanned pages | [Papers](PAPERS.md#pdf-to-markdown) |
| `integrity_check` | Academic Harness preset | Retraction / expression-of-concern / correction status from Crossref and OpenAlex, with notice DOIs | [Search](SEARCH.md#publication-integrity) |
| `paper_resolve` | Academic Harness preset | Convert between DOI, PMID, arXiv ID, OpenAlex ID, Semantic Scholar ID, and source-specific INSPIRE/ACL/bibcode/Scopus/WoS/Wikidata identifiers | [Search](SEARCH.md#academic-databases) |
| `paper_mcp` | Academic Harness preset | Register / status / unregister a Paper2MCP stdio server from `<cwd>/.dsh/paper-mcps.json` | [Papers](PAPERS.md#paper-agents-paper2agent) |
| `mcp__papermemory__*` | Academic Harness preset | 14-tool local academic memory: search, ingest, get, cite, cite-check, recap, remember, claim, quote-check, trace, outline, list, register-to-ah, lesson | [Papers](PAPERS.md#paper-memory) |
| `reference_library` | Academic Harness preset | The reference manager over PaperMemory's library: import/export BibTeX, BibLaTeX, RIS, CSL-JSON; tags, collections, notes, keys, duplicates, merge, doctor. Native, so paths are relative to the session workspace | [Papers](PAPERS.md#reference-library) |

## Search and discovery

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `literature_search` | Academic Harness preset | One-shot multi-source router; RRF fusion and cross-provider dedupe. Adds bioRxiv/INSPIRE by domain and ADS when keyed; Scopus/WoS explicit-only | [Search](SEARCH.md#the-literature-router) |
| `domain_search` | Academic Harness preset | Source-specific actions: bioRxiv browse, ACL records, INSPIRE citations/references/texkeys, ADS export/metrics, Scopus/WoS cited-by, Wikidata resolution | [Search](SEARCH.md#domain-sources) |
| `openalex_search` | Academic Harness preset | OpenAlex works discovery with filters, query, and group-by | [Search](SEARCH.md#academic-databases) |
| `openalex_citations` | Academic Harness preset | Forward and backward citation edges from a DOI, PMID, or OpenAlex ID | [Search](SEARCH.md#academic-databases) |
| `s2_search` | Academic Harness preset | Semantic Scholar relevance, bulk, and snippet search with TLDRs and OA PDFs | [Search](SEARCH.md#academic-databases) |
| `pubmed_search` | Academic Harness preset | Europe PMC JSON by default; NCBI E-utilities with `source: "ncbi"`; preprint filter | [Search](SEARCH.md#academic-databases) |
| `arxiv_search` | Academic Harness preset | Fielded arXiv queries, serialized to one request every 3 s | [Search](SEARCH.md#academic-databases) |
| `crossref_lookup` | Academic Harness preset | Canonical DOI metadata; polite pool via `CROSSREF_MAILTO` | [Search](SEARCH.md#academic-databases) |
| `consensus_search` | Academic Harness preset | Consensus peer-reviewed search with study-type, year, sample, quartile, and OA filters | [Search](SEARCH.md#consensus) |
| `parallel_search` | Academic Harness preset | Parallel Search REST with per-call `turbo` / `fast` / `basic` / `advanced` mode | [Search](SEARCH.md#parallel) |
| `parallel_extract` | Academic Harness preset | URL extraction with focused excerpts or full content | [Search](SEARCH.md#parallel) |
| `brave_search` | Academic Harness preset | Independent-index web fallback; not a literature index | [Search](SEARCH.md#web-indexes) |
| `tavily_search` | Academic Harness preset | AI-native chunks, topic modes, domain/time filters | [Search](SEARCH.md#web-indexes) |
| `exa_search` | Academic Harness preset | Neural/entity search; `lite` uses cached snapshots | [Search](SEARCH.md#web-indexes) |
| `perplexity_search` | Academic Harness preset | Raw ranked results with country/domain/language/date filters | [Search](SEARCH.md#web-indexes) |
| `jina_read` | Academic Harness preset | URL/PDF → Markdown, or Jina web search | [Search](SEARCH.md#web-indexes) |
| `core_search` | Academic Harness preset | CORE's open-access records; optional full text | [Search](SEARCH.md#additional-sources) |
| `elicit_search` | Academic Harness preset | Elicit paper/trial search with study and journal filters | [Search](SEARCH.md#additional-sources) |
| `futurehouse_agent` | Academic Harness preset | FutureHouse Crow/Falcon/Owl agents; async start/status/cancel | [Search](SEARCH.md#additional-sources) |
| `mcp__parallel__web_search`, `mcp__parallel__web_fetch` | Academic Harness preset | Parallel MCP connector; search is locked to `basic`, fetch reads one URL | [Search](SEARCH.md#mcp-connectors) |
| `mcp__firecrawl__firecrawl_scrape`, `mcp__firecrawl__firecrawl_search`, `mcp__firecrawl__firecrawl_parse` | Academic Harness preset | Firecrawl MCP connector | [Search](SEARCH.md#mcp-connectors) |
| `mcp__scite__*` | Academic Harness preset | Scite Smart Citations and evidence datasets | [Search](SEARCH.md#mcp-connectors) |
| `web_search`, `web_fetch` | DSH built-in | DeepSeek web search and HTTP fetch; fall back to Parallel/Firecrawl when blocked | [Agents](AGENTS.md#browsing-the-web) |

## Writing, citation, and figures

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `citation` | Academic Harness preset | Format APA/Vancouver/Harvard/IEEE/Chicago/MLA; BibTeX/RIS export; DOI→BibTeX; validation | [Writing](WRITING.md#references-and-citation) |
| `manuscript_citations` | Academic Harness preset | Manuscript ↔ `.bib` consistency, undefined `\ref`, duplicate labels | [Writing](WRITING.md#references-and-citation) |
| `reporting_check` | Academic Harness preset | Auditable reporting-guideline check: CONSORT, STROBE, PRISMA, ARRIVE, TRIPOD+AI, CARE, STARD; verified quotes, stale detection, evidence-only exports | [Writing](WRITING.md#reporting-checklists) |
| `latex_compile` | Every preset | `.tex` → PDF through `latexmk`, with a `pdflatex`/`xelatex`/`lualatex` fallback | [Writing](WRITING.md#latex) |
| `image_generate` | Every preset | Conceptual scientific images through Gemini "nano banana" or an OpenAI-compatible Images API | [Writing](WRITING.md#image-generation) |
| `mermaid_render` | Every preset | Mermaid text → SVG through Pele, in-process, no browser | [Writing](WRITING.md#mermaid-diagrams) |
| `ah_profile`, `ah_init`, `ah_migrate` | Academic Harness preset | List document types; scaffold a project; overlay `ah.yaml` on an existing LaTeX tree | [Writing](WRITING.md#academic-harness-engine) |
| `ah_state`, `ah_inventory`, `ah_check`, `ah_audit`, `ah_config`, `ah_catalogue` | Academic Harness preset | Paper-state card, coverage counts, cheap checks, full audit, config, check catalogue | [Writing](WRITING.md#academic-harness-engine) |
| `ah_units`, `ah_fact`, `ah_bind`, `ah_fact_propose`, `ah_sweep` | Academic Harness preset | Sync `%% @unit` anchors; build/check facts; suggest bindings; find every use of a value | [Writing](WRITING.md#academic-harness-engine) |
| `ah_source`, `ah_source_search`, `ah_claims`, `ah_claims_sync`, `ah_claims_bind` | Academic Harness preset | Register sources; quote-located passages; claim sidecars; bind claims | [Writing](WRITING.md#academic-harness-engine) |
| `ah_pack`, `ah_brief_new`, `ah_plan` | Academic Harness preset | Evidence pack; draft brief; propose an outline for author approval | [Writing](WRITING.md#academic-harness-engine) |
| `ah_build`, `ah_findings`, `ah_decision_request` | Academic Harness preset | Compile with errors mapped to units; ledger findings; hand a finding to the author | [Writing](WRITING.md#academic-harness-engine) |
| `ah_review`, `ah_review_set`, `ah_review_respond`, `ah_snapshot` | Academic Harness preset | Reviewer items, unit mapping, response letter from real diffs, unit snapshots | [Writing](WRITING.md#academic-harness-engine) |
| `ah_provenance`, `ah_disclosure` | Academic Harness preset | Who wrote each unit; draft an AI-use statement | [Writing](WRITING.md#academic-harness-engine) |
| `ah_author` | Academic Harness preset | Human-only approvals: waive, accept/reject a fact, approve a brief/plan, verify a claim, decline a review item, fill provenance, approve a disclosure | [Writing](WRITING.md#academic-harness-engine) |
| `ah_rsi` | Academic Harness preset | Inspect or steer the local self-improvement loop | [RSI](RSI.md) |

## Reviews, hypotheses, and records

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `review` | Academic Harness preset | Systematic/scoping-review ledger: protocol, record intake, single or dual two-stage screening, evidence, risk-of-bias appraisal (RoB 2, ROBINS-I, QUADAS-2, Newcastle-Ottawa), reconciliation, κ agreement, PRISMA-style counts, rob-table/rob-summary/rob-figure exports | [Research](RESEARCH.md#systematic-reviews) |
| `coscientist` | Academic Harness preset | Persistent hypothesis tournament ledger: start, add, review, safety, status, next, set-status, lineage, design-protocol, synthesize, export, graph, priors, embed | [Research](RESEARCH.md#hypothesis-tournaments) |
| `coscientist_rank` | Academic Harness preset | Pair proposal, judged matches, Glicko-2 record, compare, similarity, feedback, history | [Research](RESEARCH.md#hypothesis-tournaments) |
| `power_analysis` | Academic Harness preset | Study planning: power / sample size / smallest detectable effect, effect-size conversion, multiple-comparison correction, seeded simulation, diagnostic-accuracy precision. Requires `effect_source`; refuses post-hoc power | [Research](RESEARCH.md#study-planning) |
| `clinicaltrials` | Academic Harness preset | ClinicalTrials.gov v2 search/get, with optional posted results and adverse events | [Research](RESEARCH.md#clinical-and-regulatory-evidence) |
| `openfda` | Academic Harness preset | openFDA adverse events, recalls, 510(k), labels, food events | [Research](RESEARCH.md#clinical-and-regulatory-evidence) |
| `dataset_search` | Academic Harness preset | DataCite dataset discovery; Zenodo/Figshare file listings | [Research](RESEARCH.md#datasets-and-policy) |
| `journal_policy` | Academic Harness preset | DOAJ + Sherpa Romeo OA and self-archiving policy | [Research](RESEARCH.md#datasets-and-policy) |
| `funder_policy` | Academic Harness preset | OpenAlex funder identity + Sherpa Juliet OA policy | [Research](RESEARCH.md#datasets-and-policy) |

## Workspace and index

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `zvec_index` | Academic Harness preset | Start, check, or cancel a zvec-grep index with progress and no timeout | [Workspace](WORKSPACE.md#workspace-search) |
| `mcp__zvec_grep__zvec_grep_search` | Academic Harness preset | Local BM25 + vector search over the workspace | [Workspace](WORKSPACE.md#workspace-search) |
| `sci_inspect` | Every preset | Summarize chemistry, structure, mass-spec, array, imaging, and h5ad files | [Workspace](WORKSPACE.md#scientific-file-inspection) |
| `grep`, `glob` | DSH built-in, preset row | Exact strings, filenames, regexes, exhaustive hit lists | [Workspace](WORKSPACE.md#workspace-search) |

## Compute and delegation

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `modal_run` | Every preset | Offload a command to a Modal CPU/GPU instance; optional Volume; terminate when done | [Compute](COMPUTE.md) |
| `runpod_run` | Every preset | Offload a command to a Runpod pod; optional network volume | [Compute](COMPUTE.md) |
| `vastai_run` | Every preset | Rent the cheapest matching Vast.ai offer, run a command, destroy it; spot bids and volumes | [Compute](COMPUTE.md) |
| `subagent` | DSH built-in | Ordinary delegated work; inherits the parent session's model. The preset adds `subagent_pro`/`subagent_vision` alongside it. | [Agents](AGENTS.md#subagent-model-routing) |
| `subagent_fork` | DSH built-in | Fork delegation that inherits the parent preset and history | [Agents](AGENTS.md#subagent-model-routing) |
| `subagent_pro` | Academic Harness preset | Delegation pinned to `SUBAGENT_MODEL_COMPLEX` for difficult reasoning | [Agents](AGENTS.md#subagent-model-routing) |
| `subagent_vision` | Academic Harness preset | Delegation pinned to `SUBAGENT_MODEL_VISION` for image reading | [Agents](AGENTS.md#subagent-model-routing) |
| `skill` | DSH built-in | Load a bundled skill by name | [Skills](SKILLS.md) |

## Optional tools

These are registered only with `AH_ENABLE_OPTIONAL_TOOLS=1` and a `dsh` restart.

| Tool | What it does | Details |
|---|---|---|
| `author_lookup` | ORCID author search/records + ROR institution lookup | [Optional tools](OPTIONAL-TOOLS.md) |
| `openreview` | OpenReview API v2 submissions, reviews, decisions, venue metadata | [Optional tools](OPTIONAL-TOOLS.md) |
| `pdf_references` | GROBID bibliography extraction; optional Crossref resolution | [Optional tools](OPTIONAL-TOOLS.md) |
| `coscientist_verify` | Citation integrity and claim-support ledger for tournaments | [Optional tools](OPTIONAL-TOOLS.md) |
| `stat_audit` | Recompute p-values and run GRIM checks | [Optional tools](OPTIONAL-TOOLS.md) |
| `figure_audit` | Figure inventory, DPI flags, near-duplicate groups | [Optional tools](OPTIONAL-TOOLS.md) |
| `repo_audit` | Static reproducibility checklist for a repository | [Optional tools](OPTIONAL-TOOLS.md) |
| `grant_search` | NIH RePORTER, NSF Award Search, Grants.gov | [Optional tools](OPTIONAL-TOOLS.md) |
| `patent_search` | PatentsView prior-art/assignee/inventor lookup | [Optional tools](OPTIONAL-TOOLS.md) |

## Settings-only surfaces

The Settings page also has the API keys, **Image model**, **Complex-task model**, **Image-reading model**, **zvec-grep embedding**, hypothesis-tournament defaults, and **Index at session start**. These are preferences, not tools; see [Configuration](CONFIGURATION.md).
