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
papermemory ingest paper.pdf --cwd ~/my-paper     # project from ah.yaml or manuscripts.root_path

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

`--cwd` resolves the ingest project the same way the agent does (nearest `ah.yaml` ancestor, then a manuscript whose `root_path` matches, else `unassigned`). An explicit `--project` wins over `--cwd` and is slugified (`"My Paper"` → `my-paper`). The MCP `papermemory_ingest` tool accepts the same `cwd` field.

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

## Reference library (unreleased, schema 2100)

PaperMemory keeps a lossless bibliographic record for every paper, so a reference can be stored, cited, and later exported without losing fields.

```bash
papermemory migrate                                   # once: schema 2000 -> 2100 (back up first: papermemory backup)
papermemory library import refs.bib --project thesis  # BibTeX / BibLaTeX
papermemory library import export.ris                 # RIS (Zotero, EndNote, publisher exports)
papermemory library import items.json                 # CSL-JSON
papermemory library import refs.bib --dry-run         # report only, write nothing
papermemory library get smith2020 --project thesis    # lossless record, key, and aliases
```

- **Lossless.** `reference_meta` holds CSL-JSON plus every field CSL has no home for, under its original name (`mrnumber`, `eprint`, `pdf`, ...), and the original BibTeX entry verbatim.
- **Tolerant parser.** `@string` macros, `#` concatenation, `{}` and `()` entries, quoted values, month macros, and braced corporate authors. An entry missing its closing brace is reported and recovered; it never swallows the next entry.
- **Library-wide unique keys.** Keys from your files are kept as written. If a *different* paper already owns the key, the newcomer gets a letter suffix, and the key your project used is recorded as a project alias so `cite-check` still resolves it.
- **Idempotent.** Re-importing a file merges by DOI / arXiv / PMID / title+year and never overwrites richer stored metadata.
- Existing `papers.bibtex_key` values are never changed by the migration.

### Tags, collections, notes, and queries

```bash
papermemory library tag add "ml,to-read" smith2020 lee2021       # tags are lower-cased and hyphenated
papermemory library tag list year:2020..                         # tags with counts, within a filter
papermemory library collection create thesis --title "Thesis refs" --project thesis --bib-path references.bib
papermemory library collection create chapter-1 --parent thesis  # one level of nesting
papermemory library collection add chapter-1 smith2020 lee2021
papermemory library collection reorder chapter-1 lee2021         # listed papers first, the rest keep their order
papermemory library collection show thesis                       # includes papers of child collections in filters
papermemory library note add smith2020 "Baseline is in section 4"
papermemory library note edit NOTE_ID "..."                      # the old text is kept, marked superseded
papermemory library list tag:ml year:2020..2024 has:pdf '!tag:skip' graph --sort year --desc --limit 20
```

Filters: `tag: collection: project: year:(2021 | 2020..2024 | 2020.. | ..2019) author: venue: title: key: doi: arxiv: has:(pdf|fulltext|doi|abstract|notes|key|tags) verified:(yes|no) integrity:(status|unchecked)`; plain words must all appear in the title, abstract, authors, venue, DOI, key, tags, or notes. `-` or `!` negates a filter (use `!` on the command line). An unknown field is an error, never a silent no-op. Results are keyset-paged with `total_count` and `--cursor`; `--sort added|year|title|key`.

Deleting a collection or a tag never deletes a paper. Tags and notes are searched by `papermemory search --kind paper`. All edits are audited (`papermemory log`).

### Export, project `.bib` sync, duplicates, doctor

```bash
papermemory library export --all                                  # print BibTeX
papermemory library export tag:ml year:2020.. --format biblatex --out refs/ml.bib --cwd .
papermemory library export --cited-only thesis --out references.bib --cwd .   # exactly what the manuscript cites
papermemory library export --collection chapter-1 --format ris --out ch1.ris --cwd .
papermemory library export --all --out references.bib --cwd . --check          # in_sync | out_of_date | hand_edited | not_managed | missing
papermemory library dedupe                                        # candidate duplicate groups; nothing is merged
papermemory library merge keep2020 dup2020                        # field-level preview (add --apply --reason "...")
papermemory library doctor --cwd .                                # library health: evidence, not a verdict
```

- **Formats:** `bibtex` (classic types), `biblatex`, `ris`, `csl-json`, `json`, `csv`. Entries are sorted by key with a fixed field order, so exports diff cleanly in git. Values come from the original BibTeX entry when there is one (accents and case-protection braces survive); otherwise from the CSL record, escaped. Unmapped fields and local file paths (`pdf`, `file`) stay out unless `--fields all` (paths never).
- **Scopes:** a filter, `--collection`, `--project`, `--cited-only MANUSCRIPT` (uses the keys the manuscript actually cites and reports cited keys the library lacks), or `--all`. Nothing is exported by accident.
- **A project's own version.** The library keeps every imported version of a paper (`reference_variants`) and picks the most complete as canonical. A project export reproduces that project's own entries and keys; `--variant canonical` writes the library record instead.
- **Managed `.bib`.** Output has a header and begin/end markers. Re-exporting rewrites only the managed block and keeps whatever you put after the `hand-added` marker. A file that is already in sync is not touched. If you edit inside the managed block, export refuses (`hand_edited`) unless `--force`; an existing `.bib` that PaperMemory did not write needs `--adopt`. Both keep a timestamped backup. `--out` must stay inside the workspace (`--cwd`), and other formats never overwrite an existing file without `--force`.
- **Frozen keys.** Exporting freezes the keys it writes; only `keys rekey` changes them afterwards.
- **Duplicates.** `dedupe` groups papers by title, year, and first author, recognises a preprint and its published version, and does not flag siblings in a series ("Part one/two"), notices ("Addendum:"), or yearly items ("News from X") as duplicates. `merge` is a dry run until `--apply --reason`; it moves documents, claims, tags, collections, notes, keys, and variants, and fills gaps from the dropped record.
- **Doctor.** Missing required fields per entry type, unsafe or missing keys, unverified DOIs, duplicate groups, papers flagged retracted or corrected (and whether a manuscript still cites them), and, with `--cwd`, whether each collection-bound `.bib` is in sync. A paper never integrity-checked is reported as unknown, not clean.

### MCP

`papermemory mcp` exposes the library as one tool, `papermemory_library`, with an `action` argument (`list get resolve import export tag collection note keys dedupe merge doctor set_integrity`). Reads change nothing; anything hard to undo is a dry run unless `apply` (with a `reason`), `force`, or `adopt` is set. Paths must stay inside the allowed roots, and export paths inside `cwd`.

A host that has its own front end for the library (the Academic Harness plugin does, because it knows each session's workspace) can hide this tool with `PAPERMEMORY_HIDE_TOOLS=papermemory_library`; the server then neither lists nor runs it.

A new paper gets a library record when it is ingested, and a key as soon as it has enough metadata to build a good one (an author, DOI, or arXiv id, and a real title). Others are keyed on request or on first export.

### Citation keys

```bash
papermemory library keys check                         # report problems; changes nothing
papermemory library keys assign                        # give every paper without a key one
papermemory library keys freeze smith2020 --label export:references.bib
papermemory library keys rekey smith2020 --to smith2020gnn            # dry run: shows manuscripts that cite it
papermemory library keys rekey smith2020 --to smith2020gnn --apply --reason "clearer name"
```

- **Template.** Default `{family}{year}{titleword}` (same as the Academic Harness `citation` tool). Tokens: `{family} {year} {titleword} {doi} {arxiv}`. Set `PAPERMEMORY_KEY_TEMPLATE` or pass `--template`. A record with neither author nor year falls back to its DOI, then its arXiv id. Keys are ASCII, safe for BibTeX, and never start with a digit.
- **Stable.** A key is set once and never changes by itself; keys from your files are kept as written. `freeze` marks a key as relied on (exports do this automatically). Only `rekey` changes a key, needs a reason, and keeps the old key as a library-wide alias so manuscripts that still cite it keep resolving in `cite-check`.
- **Honest checks.** `keys check` reports missing keys, unsafe characters (spaces, commas, non-ASCII), mismatches with `papers.bibtex_key`, template drift on *generated* keys only (imported keys are never "drift"), and project aliases that shadow another paper's key.

## Citation rules (non-negotiable)

1. Only cite papers that are in PaperMemory.
2. Prefer `verified=1` (DOI or arXiv lookup succeeded). BibTeX-only records are tagged `UNVERIFIED`.
3. If `cite` returns nothing, do not invent a key, title, year, or DOI.
4. Run `cite-check` before treating a manuscript section as finished.

## Why not just install agentmemory?

Use agentmemory for coding sessions. Use PaperMemory for papers. They can coexist. Pushing PDFs through coding-session hooks would store tool traces, not claims, and would not stop hallucinated citations.

## Docs

[Changelog](CHANGELOG.md) · [Releases](https://github.com/raktim-mondol/papermemory/releases)
