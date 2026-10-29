# PaperMemory 0.3.1 inside the plugin: verification report

Date: 2026-10-29 · plugin v0.27.1 · vendored PaperMemory 0.3.1 · DSH 0.2.1-rc.2 · Python 3.13, Node 24

Everything below ran against throwaway data (`DSH_HOME`, `PAPERMEMORY_DB`, and `PAPERMEMORY_DATA_DIR` pointed at a scratch directory); the real PaperMemory database and the running DSH session were not touched.

## What was tested

| # | Scenario | Result |
|---|---|---|
| 1 | **Fresh managed install.** `ensurePaperMemoryInstalled()` with no `PAPERMEMORY_CLI`: builds the venv under `$DSH_HOME/papermemory` from the vendored source (with `pypdf`), stamps `0.3.1+dsh16` | CLI ready in 0.9 s; `papermemory version` 0.3.1; `tools` lists 14 with `PAPERMEMORY_HIDE_TOOLS` set, 15 without |
| 2 | **Upgrade from a real 0.2.1 install.** Installed `v0.2.1` from GitHub into the managed path, stamped `0.2.1+dsh15`, created a schema-2000 database (2 papers via BibTeX, 1 markdown paper, 1 note), then ran the plugin's start-up path | Detected the stale stamp and reinstalled; took a backup; migrated 2000 → 2100; all rows kept; library records backfilled; old keys unchanged |
| 3 | **Re-import after the upgrade.** Importing the same `.bib` through `reference_library` | Both records upgraded from `backfill` to `bibtex` (volume and pages now present), 0 failures |
| 4 | **Real MCP protocol** (NDJSON over stdio, `cwd` = home, `PAPERMEMORY_HIDE_TOOLS=papermemory_library`) | `initialize` OK; 14 tools, library hidden; a call to the hidden tool returns `tool-disabled`; `search`, `cite`, `get`, `recap`, `list`, `remember` work; `ingest` of `/etc/passwd` is refused (`path-escape`) |
| 5 | **Plugin tools on the managed install** (no test wrapper): `reference_library` import/tag/collection/export/check, `citation` with a library source, `manuscript_citations` with `library: true`, `literature_search` `in_library` flag, `integrity_check` library sweep and `doctor`, and a PDF ingested through `ingestDownloadedPaper` showing up in the library | All pass |
| 6 | **Real DSH boot** (`dsh --profile ci`, a throwaway profile depending on this plugin, `--port 0`) with a pre-migration database | Booted to `dsh web:`; installed PaperMemory, backed up and migrated the database during start-up; seeded 731 skills; no import, preset, or drift errors in the log. The PaperMemory MCP child ran with `PAPERMEMORY_HIDE_TOOLS=papermemory_library` and `cwd` = home, confirming why the library is a native tool |
| 7 | **Skill refresh on an existing install** | An old `papermemory` skill is replaced with the reference-library brief; `power-and-sample-size` is seeded (test added) |
| 8 | **Concurrency.** 127 real `.bib` files (5,821 entries) imported by the CLI while 150 concurrent listings and 40 concurrent tag writes ran against the same database | 0 import failures, 0 reader failures, 0 "database is locked"; `PRAGMA integrity_check` ok; 12 s wall time |
| 9 | **Package.** `npm pack`, installed the tarball into a clean project | Vendored PaperMemory present and runnable, new modules import, power helper runs, skills present |
| 10 | **CI-equivalent steps** | `cordis.patch.yml` current; client bundle committed; 36 plugin test scripts pass; 207 vendored PaperMemory tests pass; live `paper_fold` test (14 checks) passes |

## Bug found and fixed

Scenario 5 found that exporting a collection **bound to a `.bib`** as CSL-JSON (which the `citation` tool does) tried to write CSL-JSON into the `.bib` and failed with "already exists". The collection's default output file now applies only to BibTeX and BibLaTeX; other formats are returned inline. Fixed in PaperMemory 0.3.1, with a PaperMemory test and a plugin regression test.

## Not covered

- The model-facing tool list of a running DSH (its UI does not expose a documented HTTP route for it). The mount arguments and the child process environment were checked instead.
- macOS and Windows.
- A real session driven by a model.
