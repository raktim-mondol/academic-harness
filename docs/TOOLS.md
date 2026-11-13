# Tool index

Every tool registered by Academic Harness, with its scope and the page that documents it. Scope is not cosmetic: a tool listed as **Academic Harness preset** is absent from a session on Standard/PTC, and calling it there fails with `tools[name] is not a function`.

| Scope | Meaning |
|---|---|
| **Every preset** | Registered by the plugin bundle, so every DSH session has it |
| **Academic Harness preset** | Mounted only for sessions joined to the Academic Harness preset |
| **DSH built-in** | Supplied by DeepSeek Harness, not by this plugin |

The diagrams in [Architecture](ARCHITECTURE.md) show how the bundle and preset relate. For the general-purpose tools, see [Workspace](WORKSPACE.md), [Writing](WRITING.md), and [Compute](COMPUTE.md).

## Research workflow

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `notebook` | Every preset | Log, read, and export a living JSONL lab notebook under `<cwd>/.dsh/notebook/`, shared across a delegation tree; Markdown or zip export | [Workspace](WORKSPACE.md#lab-notebook) |
| `scientific_result` | Every preset | Schema-validated terminal finding card: results table or statistical test, with linked artifacts | [Workspace](WORKSPACE.md#scientific-results) |
| `fold_text` | Every preset | Deletion-only Markdown folding at five levels with no model call; `write_to` saves the result | [Workspace](WORKSPACE.md#reply-folding) |
| `research_template` | Every preset | Browse and fill research-task prompt templates across 22 disciplines, including limitation mining, subset-first evaluation, ablation, rebuttal planning, review-round comparison, and the approval-gated `research-cycle` guide; templates do not execute tasks | [Workspace](WORKSPACE.md#workflow-templates) |
| `workflow` | DSH built-in | DSH's Rhai multi-agent workflow orchestrator; separate from `research_template` | [Workspace](WORKSPACE.md#workflow-templates) |

## Papers, PDFs, and evidence

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `paper_download` | Academic Harness preset | DOI / arXiv ID / URL → open-access PDF, tried through Unpaywall, OpenAlex, Europe PMC, CORE, and arXiv; auto-ingests into PaperMemory | [Papers](PAPERS.md#download-a-paper) |
| `paper_backfill` | Academic Harness preset | Give a project's text-less PaperMemory papers (`cite_state: chunkless`) their open-access full text: OA PDF, or an OA page read through Exa/Firecrawl, behind a quality gate. Dry run by default; paywalled papers are never scraped | [Papers](PAPERS.md#giving-text-less-papers-their-text-paper_backfill) |
| `paper_get` | Academic Harness preset | Merge one paper across OpenAlex, S2, Crossref, Europe PMC, and arXiv; OA URL and canonical BibTeX with provenance | [Search](SEARCH.md#merged-paper-lookup-and-bibtex) |
| `paper_context` | Academic Harness preset | Focus-ranked sections/snippets from S2, arXiv HTML, PMC BioC/PubTator3, optional publisher TDM, and OA PDF; no writes | [Search](SEARCH.md#full-text-context) |
| `paper_fold` | Academic Harness preset | Map-first paper reading through TextFold: section map, then one section at a time; local first-sentence levels by default | [Papers](PAPERS.md#read-at-the-right-level) |
| `pdf_to_markdown` | Every preset | PDF → Markdown with headings, lists, tables, and reading order; optional OCR for scanned pages | [Papers](PAPERS.md#pdf-to-markdown) |
| `integrity_check` | Academic Harness preset | Retraction / expression-of-concern / correction status from Crossref and OpenAlex, with notice DOIs | [Search](SEARCH.md#publication-integrity) |
| `deep_review` | Academic Harness preset | Optional estimate, multi-pass full-manuscript critique with live background-job progress, page/quote-anchored comments, scholar-peer questions, checklist, claims, and reference verification; every pass is kept as a numbered round and `compare` diffs two rounds; `validity` adds four advisory evaluation-validity checks (`attribution`, `evaluator_drift`, `benchmark_coverage`, `unmeasured_trade_off`) over a stored round and a deterministic manuscript inventory, each answered `clear`, `flagged`, or `not_checked`, with at most one critic model call and none with `critic: false`; `score` adds advisory `soundness`/`originality`/`clarity`/`significance` readings on a declared scale, each citing stored comment ids, with one bounded model call; rounds record `evaluator_kind` (`held_out` or `in_distribution`); artifacts under `.dsh/deep-review/<key>/` | [Papers](PAPERS.md#deep-review) |
| `paper_resolve` | Academic Harness preset | Convert between DOI, PMID, arXiv ID, OpenAlex ID, Semantic Scholar ID, and source-specific INSPIRE/ACL/bibcode/Scopus/WoS/Wikidata identifiers | [Search](SEARCH.md#academic-databases) |
| `paper_mcp` | Academic Harness preset | Register / approve / status / unregister a Paper2MCP stdio server from `<cwd>/.dsh/paper-mcps.json`; each entry needs user approval before it starts | [Papers](PAPERS.md#paper-agents-paper2agent) |
| `mcp__papermemory__*` | Academic Harness preset | 14-tool local academic memory: search, ingest, get, cite, cite-check, recap, remember, claim, quote-check, trace, outline, list, register-to-ah, lesson | [Papers](PAPERS.md#paper-memory) |
| `reference_library` | Academic Harness preset | The reference manager over PaperMemory's library: import/export BibTeX, BibLaTeX, RIS, CSL-JSON; tags, collections, notes, keys, duplicates, merge, doctor. Native, so paths are relative to the session workspace | [Papers](PAPERS.md#reference-library) |

## Search and discovery

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `literature_search` | Academic Harness preset | One-shot multi-source router; RRF fusion and cross-provider dedupe. Adds bioRxiv/INSPIRE by domain and ADS when keyed; DOAJ/publisher Crossref deposits keyless; Scopus/WoS/Springer/IEEE explicit and keyed | [Search](SEARCH.md#the-literature-router) |
| `domain_search` | Academic Harness preset | Source-specific actions: bioRxiv browse, ACL records, INSPIRE citations/references/texkeys, ADS export/metrics, Scopus/WoS cited-by, Wikidata resolution | [Search](SEARCH.md#domain-sources) |
| `journal_search` | Academic Harness preset | Journal/venue discovery and metrics across OpenAlex, DOAJ, and Crossref; `match` ranks venues for a manuscript with advisory fit, constraints, and due-diligence signals; optional CiteScore/SJR/SNIP and JCR JIF/JCI | [Search](SEARCH.md#journal-and-venue-search) |
| `openalex_search` | Academic Harness preset | OpenAlex works discovery with filters, query, and group-by; `entity=sources` now surfaces source metrics | [Search](SEARCH.md#academic-databases) |
| `openalex_citations` | Academic Harness preset | Forward, backward, or both citation edges with an OpenCitations DOI-level fallback | [Search](SEARCH.md#academic-databases) |
| `database_catalog` | Academic Harness preset | Runtime source catalog with capabilities, key field, rate limit, fronting tool, and configured/not-set state | [Search](SEARCH.md#database-catalog) |
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
| `skill_search` | Academic Harness preset | Find a bundled skill by task (BM25 over name and description); the session catalogue lists only core skills | [Configuration](CONFIGURATION.md#skills-on-demand) |
| `skill_load` | Academic Harness preset | Read the instructions of a bundled skill by exact name | [Configuration](CONFIGURATION.md#skills-on-demand) |
| `core_search` | Academic Harness preset | CORE's open-access records; optional full text | [Search](SEARCH.md#additional-sources) |
| `elicit_search` | Academic Harness preset | Elicit paper/trial search with study and journal filters | [Search](SEARCH.md#additional-sources) |
| `futurehouse_agent` | Academic Harness preset | FutureHouse Crow/Falcon/Owl agents; async start/status/cancel | [Search](SEARCH.md#additional-sources) |
| `mcp__firecrawl__firecrawl_scrape`, `mcp__firecrawl__firecrawl_search`, `mcp__firecrawl__firecrawl_parse` | Academic Harness preset | Firecrawl MCP connector | [Search](SEARCH.md#mcp-connectors) |
| `mcp__scite__*` | Academic Harness preset | Scite Smart Citations and evidence datasets | [Search](SEARCH.md#mcp-connectors) |
| `web_search`, `web_fetch` | DSH built-in | DeepSeek web search and HTTP fetch; fall back to Parallel/Firecrawl when blocked | [Agents](AGENTS.md#browsing-the-web) |

## Writing, citation, and figures

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `citation` | Academic Harness preset | Format APA/Vancouver/Harvard/IEEE/Chicago/MLA or a validated custom CSL `style_file`/`style_url` (cached under `.dsh/styles/`); BibTeX/RIS export; DOI/arXiv/INSPIRE/title→BibTeX via `identifier`; validation; `audit` batch-checks a bibliography (DOI, Crossref match, retraction status, duplicates, uncited entries) with per-reference status; `repair` grounds each metadata mismatch with live DOI/title lookup and writes a NEW `.bib` plus a `.repair.json` sidecar — the input is never edited, a title-mismatched grounding is rejected, and a retracted record is reported, not rewritten | [Writing](WRITING.md#references-and-citation), [Discovery](DISCOVERY.md#citation-actionaudit) |
| `manuscript_citations` | Academic Harness preset | Manuscript ↔ `.bib` consistency, undefined `\ref`, duplicate labels | [Writing](WRITING.md#references-and-citation) |
| `reporting_check` | Academic Harness preset | Auditable reporting-guideline check: CONSORT, STROBE, PRISMA, ARRIVE, TRIPOD+AI, CARE, STARD; verified quotes, stale detection, evidence-only exports | [Writing](WRITING.md#reporting-checklists) |
| `submission_pack` | Academic Harness preset | Journal submission planning and bundling: limits, figure format/DPI/color/size/naming, citation style and manuscript citations, reporting evidence, numbers, statements, reviewers; PDF/source/figures/supplement/cover letter/highlights/checklist and a SHA-256 manifest; reproducible zip; export only, never submit | [Writing](WRITING.md#submission-and-communication) |
| `manuscript_diff` | Academic Harness preset | latexdiff/Markdown revision diff, changed blocks, DOCX tracked changes/comments with Zotero fields, and a response-letter skeleton that only cites recorded hunks | [Writing](WRITING.md#revision-diffs-and-response-letters) |
| `rebuttal` | Academic Harness preset | Advisory reviewer-response coverage ledger under `.dsh/rebuttal/<slug>/`: `import` a stored `deep_review` round, `ah_review` items, or caller-supplied `openreview` reviews (never fetches; reviewer identity and `evaluator_kind` kept per point), `plan` supplementary stubs capped by `REBUTTAL_MAX_TASKS`, `link` existing `experiment_log`/`analysis_run` runs by digest-pinned id (never executes), `respond`/`decline` in the author's own words (declines verified against the engine or labelled unverified, never created here), `coverage` in five states reading coverage not outcome (`answered`, `answered_asserted`, `declined_verified`, `declined_recorded`, `unaddressed`), plus `draft`/`export`/`status`; the engine stays authoritative in an `ah.yaml` project and nothing gates a turn — only `ah_check` blocks | [Writing](WRITING.md#reviewer-response-ledger) |
| `numbers_audit` | Academic Harness preset | Numerical-reporting candidates: recomputed p-values, CI/estimate consistency, N/subgroup/flow counts, percentages, table/text matches, impossible values; explicit `not_checked` | [Writing](WRITING.md#numbers-audit) |
| `presentation_build` | Academic Harness preset | Posters (`tikzposter`, `beamerposter`, `baposter`) and slides (Beamer, optional PowerPoint); compiled PDF/PNG, status, and a visual-QA checklist for `subagent_vision` | [Writing](WRITING.md#posters-and-slides) |
| `authorship` | Academic Harness preset | Append-only authorship record: authors, CRediT roles, ICMJE criteria, statement and Markdown/CSV/JSON exports; never decides order or qualification | [Writing](WRITING.md#authorship-and-credit) |
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
| `review` | Academic Harness preset | Systematic/scoping-review ledger: protocol, record intake, single or dual two-stage screening, evidence, structured extraction with a frozen template and field-level reconcile, risk-of-bias appraisal (RoB 2, ROBINS-I, QUADAS-2, Newcastle-Ottawa, AMSTAR 2, PROBAST, QUIPS, SYRCLE, CASP checklists), GRADE domain judgements with human overall certainty, reconciliation, κ agreement, PRISMA-style counts and flow SVG, extraction-table/JSON, grade-profile/SoF, and rob-table/rob-summary/rob-figure exports | [Research](RESEARCH.md#systematic-reviews) |
| `meta_analysis` | Academic Harness preset | Pairwise meta-analysis ledger: effect-size conversion, fixed/random pooling with DL/PM/REML τ², normal or Hartung–Knapp CIs, heterogeneity, subgroup/meta-regression, leave-one-out, Egger/Begg/funnel diagnostics, univariate diagnostic accuracy, forest/funnel/SROC plots, and review-extraction import | [Research](RESEARCH.md#meta-analysis) |
| `analysis_run` | Academic Harness preset | Frozen analysis plans plus immutable run manifests: argv execution (no shell), environment allowlist with secret redaction, hashed inputs/outputs, hard timeouts, notebook execution, run/plan diffs, lab-notebook entries, Markdown/JSON reports; Phase 8 adds `expect` (declared reported numbers, `reported|reproduced` reference, output parse formats, tolerance), `verify_scores` (compare a re-execution's hashed outputs, write `repro_check.json` with true/false/not_checked), and `compliance` (frozen `task_rules`, machine checks or caller evidence; a violated run is excluded from best, repro_package, and deposit) | [Reproducible analysis](ANALYSIS.md#analysis_run) |
| `experiment_log` | Academic Harness preset | Append-only runs with explicit staged baselines and scoped rankings; `replicates` reports seed coverage, descriptive mean/sample SD and explicit baseline-paired differences without executing or selecting a winner; `branches` is a read-only parent/link graph (text, JSON, or escaped Mermaid) with resolved analysis manifests, evidence-only status, anomalies, bounded output, and snapshot hashes — only an explicit Mermaid `write` changes the workspace. Drift, unknown identities, failed linked analyses and compliance exclusions stay visible. Advisory verdicts, links, and CSV/JSON/Markdown/MLflow exports | [Reproducible analysis](ANALYSIS.md#experiment_log) |
| `dataset_get` | Academic Harness preset | Dataset downloads with provenance: DOI resolution via DataCite/Zenodo/Figshare, size-capped downloads into `data/<slug>/`, checksum verification, and a manifest with licenses and retrieval records | [Reproducible analysis](ANALYSIS.md#dataset_get) |
| `data_profile` | Academic Harness preset | Local data profiling: schema, missingness, duplicates, ID/date heuristics, target balance, split overlap, small cells, and leakage risks with explicit `not_checked` items | [Reproducible analysis](ANALYSIS.md#data_profile) |
| `repro_package` | Academic Harness preset | Reader-facing reproducibility packages: manifest with SHA-256, environment snapshot, generated Dockerfile, README, CITATION.cff, codemeta.json, RO-Crate, checksums; runs excluded by an `analysis_run` compliance violation (and experiment runs linked to them) are left out and listed under `excluded_runs`; verify; confirm-gated draft-only Zenodo deposit | [Reproducible analysis](ANALYSIS.md#repro_package) |
| `ablation` | Academic Harness preset | Component-attribution ledger: a frozen component × arm × dataset × metric plan, records linked to existing `experiment_log`/`analysis_run` runs (it never executes), paired removal deltas with ties and missing cells, an advisory attribution reading, human `good`/`refine`/`unattributed` verdicts, append-only pruning, and Markdown/JSON/CSV export | [Reproducible analysis](ANALYSIS.md#ablation) |
| `provenance_audit` | Academic Harness preset | Read-only cross-ledger audit: joins review evidence/extraction/appraisal/GRADE, `reporting_check`, `deep_review` (stored claims, citation verdicts, and `extra_checks.json` validity flags), notebook, `analysis_run` (expectations, re-executions, compliance), `experiment_log` (protocol digest, verdicts), `ablation`, `dataset_get`, `meta_analysis`, and `ah` claim sidecars by stored ids and hashes; coverage, unsupported (nine states, including `spec_drift`, `no_attribution`, `rerun_mismatch`, `verdict_missing`), stale, unverified, impact, the four-column `arms` readiness roll-up, the ordered `rollup` loop record (report only; no store, no promotion; honest cost/time and a reproduced-baseline gate), and Markdown/CSV/JSON/GraphML/Mermaid exports | [Provenance audit](PROVENANCE.md) |
| `science_source` | Academic Harness preset | Read-only, keyless scientific databases through adapters: UniProt, RCSB PDB, AlphaFold DB, PubChem. Search/get/resolve/fetch with source, id, url, retrieved_at, license, and endpoint on every record; named failure states; host-limited `fetch` with `save_to` and a hashed retrieval ledger | [Science data](SCIENCE-DATA.md#science_source) |
| `chem_toolkit` | Academic Harness preset | Local RDKit chemistry: validate, standardize, descriptors, similarity, substructure, seeded conformers; input hashes and RDKit version recorded per run | [Science data](SCIENCE-DATA.md#chem_toolkit) |
| `seq_toolkit` | Academic Harness preset | Local sequence computation (pure Python): stats, translation, ORFs, nearest-neighbour primer Tm, global/local pairwise alignment; no BLAST | [Science data](SCIENCE-DATA.md#seq_toolkit) |
| `structure_toolkit` | Academic Harness preset | Local gemmi structure computation: chains and sequences, deposited ligands, distance contacts with symmetry flags, C-alpha/backbone superposition | [Science data](SCIENCE-DATA.md#structure_toolkit) |
| `literature_watch` | Academic Harness preset | Saved literature searches: add/list/remove/run/digest/status over the `literature_search` sources, de-duplicated against append-only ledgers under `.dsh/watch/`; per-source failures named; scheduling manual | [Discovery](DISCOVERY.md#literature_watch) |
| `paper_recommend` | Academic Harness preset | Related papers from Semantic Scholar recommendations and OpenAlex related works, merged, seeds and library duplicates removed, each with a measured reason; leads, not evidence | [Discovery](DISCOVERY.md#paper_recommend) |
| `citation_network` | Academic Harness preset | Frozen OpenAlex citation graph around seed papers: degree, PageRank, betweenness, coupling, co-citation, Louvain clusters, shortest path, GraphML/CSV/Mermaid export | [Discovery](DISCOVERY.md#citation_network) |
| `paper_artifacts` | Academic Harness preset | Data/code links, accessions, and availability statements from paper text, with capped link checks to public hosts only; accessions never reported verified | [Discovery](DISCOVERY.md#paper_artifacts) |
| `coscientist` | Academic Harness preset | Persistent hypothesis tournament ledger: start, add, review, safety, status, next, set-status, lineage, design-protocol, synthesize, export, graph, priors, embed; append-only limitation records with a verified source quote span, at least two remedy families, binary sufficient/insufficient readings under a round cap, and coverage by live ideas; read-only `trace` of experiment_log runs (failed and pruned first, also carried by an evolution dispatch); evidence-bound `select` that freezes a champion with a comparison digest | [Research](RESEARCH.md#hypothesis-tournaments) |
| `coscientist_rank` | Academic Harness preset | Pair proposal, judged matches, Glicko-2 record, compare, similarity, feedback, history | [Research](RESEARCH.md#hypothesis-tournaments) |
| `power_analysis` | Academic Harness preset | Study planning: power / sample size / smallest detectable effect, effect-size conversion, multiple-comparison correction, seeded simulation, diagnostic-accuracy precision. Requires `effect_source`; refuses post-hoc power | [Research](RESEARCH.md#study-planning) |
| `clinicaltrials` | Academic Harness preset | ClinicalTrials.gov v2 search/get, with optional posted results and adverse events | [Research](RESEARCH.md#clinical-and-regulatory-evidence) |
| `openfda` | Academic Harness preset | openFDA adverse events, recalls, 510(k), labels, food events | [Research](RESEARCH.md#clinical-and-regulatory-evidence) |
| `dataset_search` | Academic Harness preset | DataCite dataset discovery; Zenodo/Figshare file listings | [Research](RESEARCH.md#datasets-and-policy) |
| `journal_policy` | Academic Harness preset | DOAJ + Sherpa Romeo OA and self-archiving policy | [Research](RESEARCH.md#datasets-and-policy) |
| `funder_policy` | Academic Harness preset | OpenAlex funder identity + Sherpa Juliet OA policy | [Research](RESEARCH.md#datasets-and-policy) |

## Study conduct, ethics, and grants

| Tool | Scope | What it does | Details |
|---|---|---|---|
| `deep_research` | Academic Harness preset | Self-driving investigation with an append-only run ledger under `.dsh/deep-research/<run>/`: frames research questions, freezes the query verbatim, sweeps the literature through `literature_search` plus a web lane (Parallel/Exa/Tavily/Brave) for guidance and grey literature, clusters syndicated copies so five reprints count as one voice, drafts, runs four critics and a cite check, repairs with capped hunks only, and gates the ship. One scale knob (`effort=low|medium|high`) inferred from the request when omitted, and it asks instead of guessing when a request points both ways. Resumable and capped by active execution time; `from_step` is an explicit ordered restart, `gate` reads verdicts, `show` reads stored artifacts/claims/findings, `revise` appends a claim quote revision, and `patch` closes findings only when every hunk applies. Unverified checks are reported `not_checked`, never passed. Submits nothing and decides no verdict | [Research](RESEARCH.md#deep-research) |
| `preregister` | Academic Harness preset | Write-once, hashed pre-registration versions under `.dsh/preregister/<slug>/`: start/import (review, coscientist, analysis plan, causal DAG, JSON), freeze with a data-collection guard, status, hash verification, Markdown/JSON/PDF export. `submit` is disabled; no registry is contacted | [Research](RESEARCH.md#pre-registration) |
| `causal_dag` | Academic Harness preset | User-specified DAG ledger: versioned create/edit, DOT/Mermaid/edge-list import, d-separation, minimal backdoor/front-door sets, collider/M-bias and adjustment warnings, instruments, testable implications, E-values, and graph exports. No model is fitted | [Research](RESEARCH.md#causal-dags) |
| `design` | Academic Harness preset | Seeded randomization (simple/block/stratified/cluster/crossover/minimization) with allocation/blinding codes and realized-balance diagnostics; full/fractional factorial, Plackett–Burman, central composite, and Box–Behnken designs with aliasing and run sheets; CSV/JSON/Markdown export | [Research](RESEARCH.md#randomization-and-doe) |
| `ethics_protocol` | Academic Harness preset | Append-only ethics/IRB protocol and consent drafts under `.dsh/ethics/<slug>/`, with a Helsinki/Common Rule/GDPR/HIPAA concept checklist (`present`/`missing`/`manual_check`/`not_applicable`). Templates and checklist, not legal advice; approvals are never invented | [Research](RESEARCH.md#ethics-protocols-and-de-identification) |
| `deidentify` | Academic Harness preset | Local PHI/PII scanning and redaction for text/JSON/CSV/TSV under `.dsh/deidentify/<slug>/`: masked reports with offsets and column summaries, separate redacted output, per-type/per-column actions, and residual verification. Regex/heuristics only; no model call, no reversible mapping, no compliance guarantee | [Research](RESEARCH.md#ethics-protocols-and-de-identification) |
| `dmp` | Academic Harness preset | Funder-shaped data-management plans (NIH DMS, NSF DMP, Horizon Europe, Wellcome, ERC, generic) under `.dsh/dmp/<slug>/`: start/section/check/status and Markdown/JSON export. Paraphrased templates; repository, embargo, costs, and official requirements stay `manual_check` | [Research](RESEARCH.md#data-management-plans) |
| `grant_budget` | Academic Harness preset | Multi-year budget ledger under `.dsh/budget/<slug>/`: personnel effort/fringe/escalation, equipment, supplies, travel, publication, subawards, cost share, indirect rate/caps, arithmetic checks, justification, and CSV/Markdown/JSON/XLSX export. Rates are user-supplied | [Research](RESEARCH.md#grant-budgets) |

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
| `modal_run` | Every preset | Offload a command to a Modal CPU/GPU instance; optional Volume; terminate when done. Asks for approval on every call | [Compute](COMPUTE.md) |
| `runpod_run` | Every preset | Offload a command to a Runpod pod; optional network volume. Asks for approval on every call | [Compute](COMPUTE.md) |
| `vastai_run` | Every preset | Rent the cheapest matching Vast.ai offer, run a command, destroy it; spot bids and volumes. Asks for approval on every call | [Compute](COMPUTE.md) |
| `subagent` | DSH built-in | Ordinary delegated work; inherits the parent session's model. The preset adds `subagent_pro` for difficulty-bound tasks and `subagent_vision` for image reading alongside it. | [Agents](AGENTS.md#subagent-model-routing) |
| `subagent_fork` | DSH built-in | Fork delegation that inherits the parent preset and history | [Agents](AGENTS.md#subagent-model-routing) |
| `subagent_pro` | Academic Harness preset | Difficulty-bound delegation with an optional custom endpoint/model/key route; inherits the session model when unset | [Agents](AGENTS.md#subagent-model-routing) |
| `subagent_vision` | Academic Harness preset | Image-reading delegation with an optional custom endpoint/model/key route; inherits the session model when unset | [Agents](AGENTS.md#subagent-model-routing) |
| `skill` | DSH built-in | Load a bundled skill by name | [Skills](SKILLS.md) |

## Identity, funding, and audit tools

Academic Harness preset tools. `pdf_references` is registered only when `GROBID_BASE_URL` is set.

| Tool | What it does | Details |
|---|---|---|
| `author_lookup` | ORCID author search/records + ROR institution lookup | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) |
| `openreview` | OpenReview API v2 submissions, reviews, decisions, venue metadata | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) |
| `pdf_references` | GROBID bibliography extraction; optional Crossref resolution | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) |
| `coscientist_verify` | Citation integrity, claim-support, and grounded-novelty ledger for tournaments: Crossref citation checks with a soft rating penalty, recorded supports/contradicts/unaddressed judgements, and a `novelty` action that retrieves a small reference set, stores it, computes the documented lexical prior-art reading, and pins it to verbatim quote spans | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) |
| `stat_audit` | Recompute p-values and run GRIM checks | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) |
| `figure_audit` | Figure inventory, DPI flags, near-duplicate groups; `action=handoff` is a read-only figure-to-result report joining one figure to declared `analysis_run`/`experiment_run` records (link, hash, execution, and extracted-number states) | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md#figure_audit) |
| `prior_art` | Prior-art triage report for one claim from searches you already ran: coverage limits, comparison basis, claimed overlap kept apart from verified quotations; never a novelty verdict | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md#prior_art) |
| `repo_audit` | Static reproducibility checklist for a repository; `probe` finds a runnable benchmark entrypoint without executing it; `align` maps method anchors to verified `file:line` and returns `ah_claims_bind` calls | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) |
| `grant_search` | NIH RePORTER, NSF Award Search, Grants.gov | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) |
| `patent_search` | PatentsView prior-art/assignee/inventor lookup | [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) |

## Settings-only surfaces

The Settings page also has the API keys, **Image model**, **Complex-task model**, **Image-reading model**, **zvec-grep embedding**, hypothesis-tournament defaults, deep-review preferences (**Default score rubric**, **Max review rounds**, **Per-review cost ceiling**), and **Index at session start**. These are preferences, not tools; see [Configuration](CONFIGURATION.md).
