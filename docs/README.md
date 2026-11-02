# Academic Harness documentation

Academic Harness turns DeepSeek Harness into a research workbench: literature and web discovery, paper memory with verbatim evidence, a writing oracle for LaTeX, audit-friendly review and hypothesis ledgers, remote compute, and a local self-improvement loop.

New here? Read [Install and run](INSTALL.md), then [Architecture](ARCHITECTURE.md). The root [README](../README.md) is the front door.

## Start here

| Page | What it answers |
|---|---|
| [Install and run](INSTALL.md) | How to install DSH and Academic Harness, confirm the preset, and troubleshoot |
| [Architecture](ARCHITECTURE.md) | What the bundle vs. preset split means, where state lives, and how a request flows |
| [Configuration](CONFIGURATION.md) | Every API key, environment variable, and which changes need a restart |
| [Tool index](TOOLS.md) | Every registered tool, its scope, and the page that documents it |

## Guides

| Page | What it covers |
|---|---|
| [Search and discovery](SEARCH.md) | Literature databases, Consensus, Parallel, MCP connectors, web indexes, publication integrity |
| [Papers and evidence](PAPERS.md) | Download, `paper_fold`, PDF conversion, PaperMemory, Paper2Agent |
| [Writing, citation, and figures](WRITING.md) | The `ah_*` writing oracle, bibliography tools with custom CSL, submission packs, revision diffs, numbers audit, posters/slides, authorship/CRediT, LaTeX, figures, `image_generate`, `mermaid_render` |
| [Reviews, synthesis, and records](RESEARCH.md) | Systematic reviews, dual-reviewer screening, structured extraction, meta-analysis, GRADE certainty and summary-of-findings tables, risk-of-bias appraisal, agreement statistics, hypothesis tournaments, pre-registration, causal DAGs, randomization/DOE, ethics and de-identification, data-management plans, grant budgets, clinical/regulatory records, dataset and policy tools |
| [Reproducible analysis and data](ANALYSIS.md) | Frozen plans and auditable `analysis_run` executions, `experiment_log` sweeps, `dataset_get` provenance downloads, `data_profile` leakage review, `repro_package` shipping and Zenodo drafts |
| [Provenance audit](PROVENANCE.md) | The read-only cross-ledger index: how `provenance_audit` joins review, reporting, deep-review, notebook, analysis, experiment, dataset, meta-analysis, and AH records, and what its seven states do and do not mean |
| [Scientific data and toolkits](SCIENCE-DATA.md) | `science_source` over UniProt, RCSB PDB, AlphaFold DB, and PubChem, and the local `chem_toolkit`, `seq_toolkit`, and `structure_toolkit` |
| [Discovery and reference checks](DISCOVERY.md) | Saved searches, recommendations, citation networks, data-link extraction, and the bibliography audit |
| [Workspace, notebook, and folding](WORKSPACE.md) | zvec-grep, lab notebook, `scientific_result`, `fold_text`, templates, `sci_inspect` |
| [Remote compute](COMPUTE.md) | `modal_run`, `runpod_run`, `vastai_run`, volumes, and the Modal/Runpod/Vast.ai skills |
| [Agents and browsing](AGENTS.md) | Subagent model routing, specialist briefs, and browser automation |
| [Skills](SKILLS.md) | The 766-skill catalogue, its sources, and workflow skills |
| [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md) | Author identity, OpenReview, grants, patents, statistical/figure/repo audits, GROBID references |
| [Local RSI](RSI.md) | The self-improvement loop, its seven layers, store, and evaluation honesty |

## Reference

| Page | What it covers |
|---|---|
| [Changelog](CHANGELOG.md) | Release notes from 0.18.0 onward |
| [Development](DEVELOPMENT.md) | Build, tests, docs diagrams, bundle patch, repository layout |
| [Academic Harness engine](ACADEMIC-HARNESS-ENGINE.md) | Why the writing engine is vendored and the open decision about its home |

## Diagrams

All figures are Mermaid sources in [`diagrams/`](diagrams/) rendered to SVG with Pele into [`assets/diagrams/`](assets/diagrams/). Regenerate with:

```sh
npm run docs:diagrams
```

- [Architecture](assets/diagrams/architecture.svg)
- [Capability map](assets/diagrams/capability-map.svg)
- [Request lifecycle](assets/diagrams/request-lifecycle.svg)
- [Install flow](assets/diagrams/install-flow.svg)
- [Search routing](assets/diagrams/search-routing.svg)
- [Paper pipeline](assets/diagrams/paper-pipeline.svg)
- [Writing loop](assets/diagrams/writing-loop.svg)
- [Review ledger](assets/diagrams/review-ledger.svg)
- [Deep research](assets/diagrams/deep-research.svg)
- [Deep review](assets/diagrams/deep-review.svg)
- [Analysis lifecycle](assets/diagrams/analysis-lifecycle.svg)
- [Hypothesis tournament](assets/diagrams/tournament-loop.svg)
- [Workspace vs. PaperMemory](assets/diagrams/workspace-memory.svg)
- [Subagent routing](assets/diagrams/subagent-routing.svg)
- [Remote compute](assets/diagrams/compute-flow.svg)
- [RSI loop](assets/diagrams/rsi-loop.svg)
- [Skill sources](assets/diagrams/skills-map.svg)

## Conventions

- **Every preset** means a tool is registered by the plugin bundle and is present in every DSH session.
- **Academic Harness preset** means a tool is added for sessions whose preset selector reads **Academic Harness**; plain delegation tools such as `subagent` are DSH built-ins.
- Commands and tool arguments are shown in code font; tool names are the exact registered names.
- "Keyless" means no API key is required for the default tier, not that the source is unlimited.
- Claims are separated from evidence: discovery and orientation never substitute for PaperMemory `quote_check`/`trace`.
