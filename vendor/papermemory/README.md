# PaperMemory

[![CI](https://github.com/raktim-mondol/papermemory/actions/workflows/ci.yml/badge.svg)](https://github.com/raktim-mondol/papermemory/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/raktim-mondol/papermemory)](https://github.com/raktim-mondol/papermemory/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)

Persistent memory for **academic paper understanding** and **academic paper writing**.

[agentmemory](https://github.com/rohitg00/agentmemory) is a strong local memory engine for coding agents (sessions, tool traces, architecture, bugs). That engine is domain-agnostic. Its **schema, hooks, and skills are not**. Coding memory stores “JWT lives in `src/middleware/auth.ts`”. Paper work needs DOIs, claims with evidence, citation graphs, venue constraints, and a hard ban on invented references.

PaperMemory keeps the useful agentmemory ideas — hybrid search, typed graph, confidence, lifecycle, MCP, agent skills — and replaces the coding ontology with an academic one.

## What it remembers

| Need | Coding memory | PaperMemory |
| --- | --- | --- |
| Identity | files, functions, PRs | papers (title, authors, year, venue, DOI, arXiv, bibtex key) |
| Evidence | stack traces, diffs | claims with quoted evidence, page/section, verified/unverified |
| Graph | imports, callers | cites / extends / contradicts / uses-method |
| Writing | commit messages | manuscripts, section word counts, contributions, terminology, reviewer comments |
| Integrity | tests pass | cite-check: every in-text key exists; never cite unverified or invented papers |
| Recap | “what did we code” | venue, citation style, section status, citation gaps |

Default store: `~/.local/share/papermemory/papermemory.db` (override with `PAPERMEMORY_DB` or `PAPERMEMORY_DATA_DIR`). SQLite + FTS5, no cloud.

## Install

```bash
pip install "papermemory[pdf] @ git+https://github.com/raktim-mondol/papermemory.git"
papermemory init
```

Editable local checkout: `pip install -e '.[pdf]'`. PDF ingest uses `pypdf` (`pip install pypdf` if you skipped the extra).

## Everyday commands

```bash
# Writing project (LaTeX tree with references.bib + sections/)
papermemory ingest ~/journal_paper_writing --kind manuscript --project scandy

# Read a paper
papermemory ingest paper.pdf --project scandy
papermemory ingest paper.pdf --doi 10.1038/s41592-024-02201-0 --project scandy
papermemory ingest notes.md --pdf-path paper.pdf --project scandy
papermemory ingest --arxiv 1706.03762 --project scandy
papermemory ingest --doi 10.1038/s41592-024-02201-0

papermemory search "spoil shear strength"
papermemory paper simmons2004shear
papermemory understand simmons2004shear --save
papermemory cite "attention-based multiple instance learning"
papermemory cite-check scandy
papermemory recap --project scandy

papermemory remember "Use Elsevier Harvard author-date for SCANDY" --concepts scandy,citation-style --project scandy
papermemory lesson "Never invent a citation. If cite returns nothing, say so." --concepts citations
```

`--json` is accepted before or after the subcommand for agent use.

## MCP

```bash
papermemory mcp
```

Stdio framing is auto-detected: newline-delimited JSON (current TypeScript MCP SDK, DeepSeek Harness, recent Grok) and LSP `Content-Length` headers (older clients). Replies use the same framing as the first inbound message.

Wire into Grok:

```toml
[mcp_servers.papermemory]
command = "papermemory"
args = ["mcp"]
```

Tools: `papermemory_search`, `papermemory_ingest`, `papermemory_get`, `papermemory_cite`, `papermemory_cite_check`, `papermemory_remember`, `papermemory_claim`, `papermemory_recap`, `papermemory_lesson`.

`papermemory_ingest` accepts `path` together with `doi` / `title` / `pdf_path` so a local PDF and a later markdown conversion merge onto one verified record.

## Citation rules (non-negotiable)

1. Only cite papers that are in PaperMemory.
2. Prefer `verified=1` (DOI or arXiv lookup succeeded). BibTeX-only records are tagged `UNVERIFIED`.
3. If `cite` returns nothing, do not invent a key, title, year, or DOI.
4. Run `cite-check` before treating a manuscript section as finished.

## Why not just install agentmemory?

Use agentmemory for coding sessions. Use PaperMemory for papers. They can coexist. Pushing PDFs through coding-session hooks would store tool traces, not claims, and would not stop hallucinated citations.

## Docs

[Changelog](CHANGELOG.md) · [Releases](https://github.com/raktim-mondol/papermemory/releases)
