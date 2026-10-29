# Academic Harness documentation

Academic Harness turns DeepSeek Harness into a research workbench: literature and web discovery, paper memory with verbatim evidence, a writing oracle for LaTeX, audit-friendly review and hypothesis ledgers, remote compute, and a local self-improvement loop.

New here? Read [Install and run](INSTALL.md), then [Architecture](ARCHITECTURE.md). The root [README](../README.md) is the front door.

## Start here

| Page | What it answers |
|---|---|
| [Install and run](INSTALL.md) | How to install DSH and Academic Harness, confirm the preset, migrate a profile, and troubleshoot |
| [Architecture](ARCHITECTURE.md) | What the bundle vs. preset split means, where state lives, and how a request flows |
| [Configuration](CONFIGURATION.md) | Every API key, environment variable, and which changes need a restart |
| [Tool index](TOOLS.md) | Every registered tool, its scope, and the page that documents it |

## Guides

| Page | What it covers |
|---|---|
| [Search and discovery](SEARCH.md) | Literature databases, Consensus, Parallel, MCP connectors, web indexes, publication integrity |
| [Papers and evidence](PAPERS.md) | Download, `paper_fold`, PDF conversion, PaperMemory, Paper2Agent |
| [Writing, citation, and figures](WRITING.md) | The `ah_*` writing oracle, bibliography tools, LaTeX, figures, `image_generate`, `mermaid_render` |
| [Reviews, hypotheses, and records](RESEARCH.md) | Systematic reviews, hypothesis tournaments, clinical/regulatory records, dataset and policy tools |
| [Workspace, notebook, and folding](WORKSPACE.md) | zvec-grep, lab notebook, `scientific_result`, `fold_text`, templates, `sci_inspect` |
| [Remote compute](COMPUTE.md) | `modal_run`, `runpod_run`, `vastai_run`, volumes, and the Modal/Runpod/Vast.ai skills |
| [Agents and browsing](AGENTS.md) | Subagent model routing, specialist briefs, and browser automation |
| [Skills](SKILLS.md) | The 730-skill catalogue, its sources, and workflow skills |
| [Optional tools](OPTIONAL-TOOLS.md) | The tools behind `AH_ENABLE_OPTIONAL_TOOLS=1` |
| [Local RSI](RSI.md) | The self-improvement loop, its seven layers, store, and evaluation honesty |

## Reference

| Page | What it covers |
|---|---|
| [Changelog](CHANGELOG.md) | Release notes from 0.18.0 to 0.26.0 |
| [Development](DEVELOPMENT.md) | Build, tests, docs diagrams, bundle patch, repository layout |
| [Academic Harness engine](ACADEMIC-HARNESS-ENGINE.md) | Why the writing engine is vendored and the open decision about its home |
| [Co-Scientist integration](CO-SCIENTIST-INTEGRATION-PLAN.md) | Tournament design and implementation record |
| [Fold integration](FOLD-INTEGRATION-PLAN.md) | Reply folding and `paper_fold` design |
| [Non-search tools](NON-SEARCH-TOOLS-PLAN.md) | Citation, review, clinical, dataset, and policy tool plan |
| [PaperMemory v2](PAPERMEMORY-V2-PLAN.md) | Memory v2 design record |
| [Search providers](SEARCH-PROVIDERS-PLAN.md) | Search provider plan |
| [zvec-grep/PaperMemory alignment](ZG-PAPERMEMORY-ALIGNMENT-PLAN.md) | Workspace search and memory boundaries |

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
