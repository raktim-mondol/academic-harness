# PaperMemory reference library — implementation plan

Status: **proposed, not implemented; decisions L1–L4 resolved** · baseline plugin **v0.25.4**, PaperMemory **0.2.1** (schema 2000) · target PaperMemory **0.3.0** (schema 2100), plugin **v0.26.0**
Supersedes: Phase 1 ("Papis reference library") of `docs/PAPIS-AND-EVIDENCE-TOOLS-PLAN.md`. Phases 2–5 of that plan are unchanged.
Sibling docs: `docs/PAPERS.md` (PaperMemory today), `docs/NON-SEARCH-TOOLS-PLAN.md` (the `citation` tool), `docs/PAPERMEMORY-V2-PLAN.md`

## 1. Goal and decision

The user needs a **programmable reference manager** (Zotero desktop would not install). Papis was the first candidate. Reading both code bases shows that PaperMemory already stores, deduplicates, and cites papers, so a second store (Papis) would duplicate it and add GPL code and a second Python environment. The decision is to **add the missing reference-library features to PaperMemory itself** and use Papis only as a design reference.

What "citation features in PaperMemory" means here:

1. keep the **complete bibliographic record**, not just eight columns;
2. give every paper a **stable, unique, valid citation key** with a policy;
3. let papers be **organised** (tags, collections, notes) and queried;
4. **import and export** BibTeX/BibLaTeX, CSL-JSON, and RIS reliably, including a project `.bib` with only the papers a manuscript cites;
5. keep the library **clean** (duplicates, missing fields, bad keys, retracted papers);
6. expose all of it through the existing CLI, one MCP tool, and the plugin's `citation` tool.

## 2. What exists today (verified in the code)

### PaperMemory (vendored 0.2.1, stdlib-only, SQLite)

- `papers` has `title, authors_json, year, venue, doi, arxiv_id, bibtex_key, abstract, pdf_path, verified, cite_state, project_id`. Identity is DOI → arXiv → PMID → title+year, with `paper_aliases` and a structural `merge_papers`.
- `papers` **drops everything else** a BibTeX entry has (`entry_type`, `volume`, `pages`, `publisher`, `url`, `isbn`, `editor`, …). `parse_bibtex` returns those fields and the raw entry, but `ingest_bibtex` does not store them, so a faithful export is impossible today.
- Metadata-only papers already exist (`cite_state = chunkless`), so a reference without a PDF is supported.
- `bibtex_key` is stored but there is **no key policy**: no generation for non-BibTeX ingests, no uniqueness rule, no stability guarantee.
- `cite` finds a paper to cite; `cite-check` compares a manuscript's `\cite{}` keys with the project's papers and persists locators.
- `export` is a JSONL dump of all tables for backup, not a bibliography export. There is no RIS or CSL-JSON, no tags, no collections.
- The default store is `~/.local/share/papermemory/papermemory.db`, **already global and shared** by the CLI, Grok, and the harness. The "global library" decision is therefore satisfied without new work.
- Zero runtime dependencies (`dependencies = []`); `pypdf` is an optional extra. This plan keeps that.

### Plugin side

- `citation` (JS, `citation-format.js`, `citation-js`) parses and writes BibTeX, RIS, CSL-JSON, formats APA/Vancouver/Harvard/IEEE/Chicago/MLA, generates `family+year+firstword` keys with `a, b, c` suffixes, and validates. It does not persist anything.
- `papermemory.js` mounts `mcp__papermemory__*` and **fails loudly on drift from the expected 14-tool surface**, so adding a tool means updating the expected count, `docs/TOOLS.md`, `docs/PAPERS.md`, and `scripts/test-phase7.mjs`.
- `papermemory-cli.js` installs the vendored package into `~/.dsh/papermemory` and checks `MIN_PAPERMEMORY_VERSION`; bumping the vendored version reinstalls it.

## 3. What Papis does that is worth learning from

Papis v0.16.1 (GPL-3.0-or-later) was read as a **design reference only**. The table maps each idea to the PaperMemory design. Nothing is copied.

| Papis behaviour (where I looked) | Idea taken | PaperMemory design |
|---|---|---|
| One folder and one metadata file per entry; flat BibLaTeX-style keys; `author_list` of `{family, given}` next to an `author` string (`document.py`) | Keep structured authors, derive the string | Store **CSL-JSON** (structured `author: [{family, given}]`) as the canonical record; derive BibTeX strings on export |
| `create_reference` + `ref_cleanup`: a format template, then DOI, then ISBN, then a string from the data; allowed-character cleanup; `force` to regenerate (`bibtex.py`) | A key policy with fallbacks, character cleanup, and an explicit regenerate | Key policy in §6: template, fallback chain, cleanup, uniqueness, **freeze on export**, explicit `rekey` |
| BibLaTeX type list, type aliases (`conference → inproceedings`, `phdthesis → thesis`, `techreport → report`, …) and field aliases (`journal → journaltitle`, `address → location`, `archiveprefix → eprinttype`) (`bibtex.py`) | A normalisation layer between BibTeX dialects | Type and field tables written from the **BibLaTeX manual**, covering import aliases and export mapping |
| Exporters as a registry: bibtex, csl, csv, json, yaml, typst/Hayagriva (`exporters/`, `hayagriva.py`) | Pluggable formats behind one `export` action | Format registry: `bibtex`, `biblatex`, `csl-json`, `ris`, `json`, `csv`; Hayagriva is optional and deferred |
| BibTeX export wraps single-name authors in braces, joins with `and`, and warns when a journal key is absent (`exporters/bibtex.py`) | Export edge cases that bite in real bibliographies | Golden fixtures for corporate authors, single names, `others`, missing journal, special characters |
| `merge`: field-level diff, keep one entry, move files, optionally keep both (`commands/merge.py`) | Show what will change and let the caller decide | `merge --dry-run` returns a field-level conflict report with a proposed winner per field; the existing structural `merge_papers` stays the writer |
| `tag`, query language (`key:value`), sorting (`commands/tag.py`, `cli.py`) | Tags as first-class and filterable | `paper_tags`, and a small filter syntax (`tag:ml year:2020..2024 has:pdf collection:thesis`) |
| `notes.py`: notes attached to an entry | Per-paper notes | Reuse PaperMemory observations scoped to a paper (spike confirms) |
| `citations.py`: stores a document's reference list and cited-by list | Citation edges per paper | **Deferred**: PaperMemory's typed graph can hold them later; not needed for the library |
| `doctor`, `update` (refresh from Crossref/arXiv), importers and many publisher downloaders | Library health checks and metadata refresh | `doctor` checks (§8); refresh reuses PaperMemory's `lookup` and the plugin's `paper_resolve`; publisher scrapers are out of scope |
| Git integration for the library | Library as a diffable file set | An optional **snapshot** export of the library to CSL-JSON for git; the SQLite file stays the source of truth |

### Licence boundary (read this once)

Papis is GPL-3.0-or-later; PaperMemory and this plugin are MIT. To keep that true:

- The BibLaTeX type/field tables, RIS tag map, and CSL mapping are implemented **from their public specifications** (BibLaTeX manual, CSL 1.0.2 schema, the RIS format description), not transcribed from Papis files.
- No Papis source, identifier names, or test fixtures are copied. Tests use fixtures written for this project.
- Papis is not a dependency, not vendored, and not invoked.
- If the owner later wants to reuse Papis code directly, PaperMemory would have to be relicensed GPL-3.0-or-later; that is a separate decision and is **not** assumed here.

## 4. Architecture

### 4.1 Where each piece lives

| Concern | Lives in | Why |
|---|---|---|
| Records, keys, tags, collections, notes, import, export, dedupe, doctor | **PaperMemory (Python, stdlib)** | One store; works from the standalone CLI and for Grok users; no new dependency |
| Styled bibliographies (APA, IEEE, …), DOI → metadata, ad-hoc records | **`citation` (JS)** | Already uses `citation-js`/CSL styles; PaperMemory does not reimplement styles |
| Retraction status | **`integrity_check` (JS)** | Needs Crossref/OpenAlex; its result is written into the library |
| Discovery, download | `literature_search`, `paper_resolve`, `paper_download` | Unchanged; they feed `library add` |

The interchange format between the two languages is **CSL-JSON**. `citation` gains `source: "library"` and asks PaperMemory for CSL-JSON, then formats or exports it with its existing code. PaperMemory also writes BibTeX/RIS natively so it stays useful without the plugin. The cost is two BibTeX writers; a shared golden-fixture test keeps them in agreement (§10).

### 4.2 Schema 2100 (additive only)

`papers` is **not altered**. New tables, created by a new `migrate_2100` following the `migrate_2000` pattern, behind a backup:

| Table | Columns (summary) | Purpose |
|---|---|---|
| `reference_meta` | `paper_id` PK/FK, `csl_json`, `entry_type`, `raw_bibtex` (nullable), `extra_json` (fields with no CSL home), `source`, `meta_sha256`, `updated_at` | Lossless record; `raw_bibtex` keeps an imported entry verbatim |
| `bib_keys` | `paper_id` PK/FK, `key` UNIQUE, `policy`, `frozen` 0/1, `frozen_at`, `frozen_in` | The authoritative citation key and whether an export has relied on it |
| `bib_key_aliases` | `key` PK, `paper_id` FK, `source` (`import:<project or file>` / `rekey`), `first_seen` | **Every key ever seen for a paper** (imported from a project `.bib`, or retired by `rekey`). Lets `cite-check` and old manuscripts resolve their own key even when two files used different keys for one DOI (spike P2: 285 DOIs had several keys) |
| `paper_tags` | `paper_id`, `tag`, `added_at`, PK (paper, tag) | Free-form tags |
| `collections` | `id`, `slug` UNIQUE, `title`, `parent_id`, `project_key` (nullable), `bib_path` (nullable), `created_at` | Reading lists; optionally bound to a project and its `.bib` |
| `collection_papers` | `collection_id`, `paper_id`, `ord`, `added_at` | Membership |
| `integrity` | `paper_id` PK, `status`, `source`, `notice_doi`, `checked_at` | Retraction/correction status written by the plugin |

`papers.bibtex_key` stays and is kept equal to `bib_keys.key` by the store, so every existing query, `cite-check`, and `context` keeps working. Backfill creates a `reference_meta` row (CSL-JSON built from the eight existing columns) and a `bib_keys` row for each existing paper. Existing keys are **never changed** by migration. Every mutation writes an `events` row through `store.mut()` (`LIB_ADD`, `LIB_TAG`, `KEY_ASSIGN`, `KEY_FREEZE`, `KEY_RENAME`, `EXPORT`, …) so the audit view covers the library.

### 4.3 Surfaces

- **CLI:** `papermemory library <action>` (and `papermemory import|export` aliases).
- **MCP:** **one new tool**, `papermemory_library`, with an `action` argument, matching the repo's action-multiplexed convention. The surface goes from 14 to 15 tools.
- **Plugin:** `citation` gets `source: "library"`; `manuscript_citations`, `integrity_check`, `literature_search`, and `review` get small hooks (§9).

## 5. Phase 1 — lossless records and import

1. **Hardened BibTeX parser.** The current parser is regex-based, loses fields, and (spike P2) can **silently corrupt data**. Replace it with a small state-machine parser (stdlib) that must pass these cases, each a fixture: `@string` macros and `#` concatenation expanded; `()` as well as `{}` delimiters; quoted values containing `\"` and braces; month macros; `@comment`/`@preamble`; braced corporate authors preserved as one name; `others`; duplicate fields (first wins, reported); duplicate keys (reported); and an **unterminated entry**, which must be reported as malformed and must not swallow the next entry (resync at the next line-leading `@type{`). Malformed entries are reported per entry, not fatal. The old `parse_bibtex` signature stays for existing callers.
2. **LaTeX ↔ Unicode.** A small, tested table for common accents and escapes (`\"o`, `\'e`, `\&`, `{\ss}`, …). Anything not in the table is kept raw in `extra_json`/`raw_bibtex`, never dropped.
3. **Normalisation.** Entry-type aliases and field aliases (BibTeX ↔ BibLaTeX) from the BibLaTeX manual; dates to CSL `issued`; pages normalised with an en dash; DOIs/arXiv ids through the existing `normalize_doi`/`normalize_arxiv`.
4. **Importers:** BibTeX/BibLaTeX, CSL-JSON, RIS (all stdlib), and DOI/arXiv via the existing `scholar.py` lookups. `import` returns per-entry `added | merged | skipped | failed` with the reason; it never aborts the batch on one bad entry.
5. **Identity.** Imports go through the existing `upsert_paper_v2` so DOI/arXiv/PMID/title+year dedupe and `IdentityConflict` behaviour are unchanged. Every source key is recorded in `bib_key_aliases`. When an imported key is already owned by a **different** paper (spike P2: 45 keys in the user's files name different papers), the import keeps the existing owner, assigns the newcomer a suffixed key, records the original as its alias scoped to the importing project, and reports the collision.
6. **Backfill** existing papers into `reference_meta`.

Acceptance: a BibTeX fixture set round-trips to the same CSL-JSON; no field is lost (unknown ones land in `extra_json`); malformed entries are reported; existing ingest tests still pass.

## 6. Phase 2 — citation keys

- **Policy.** A template with tokens (`{family}`, `{year}`, `{titleword}`, `{doi}`), default `{family}{year}{titleword}` (matches the plugin's `makeCitationKey`, so both sides generate the same key for the same record). Fallback chain: template → DOI → arXiv id → title slug.
- **Cleanup.** ASCII fold, allowed characters only, never start with a digit, length cap.
- **Uniqueness.** Library-wide unique; collisions get `a, b, c…` in a deterministic order.
- **Stability ("freeze").** A key is set once. When a key is written to a `.bib` or reported by `cite-check`, it is marked `frozen`. A frozen key changes only through `rekey` with an explicit reason, which records `bib_key_aliases` and returns the list of manuscripts that cite the old key.
- **Existing keys** are adopted as-is (`policy = "imported"`), even if they do not match the template.
- **Actions:** `keys assign` (fill missing), `keys check` (duplicates, invalid characters, template drift), `keys rekey` (dry-run first).

Acceptance: assignment is deterministic across runs and platforms; collisions resolve stably; a frozen key cannot change silently; `cite-check` resolves a retired key through history.

## 7. Phase 3 — organisation and query

- **Tags:** `tag add|remove|list`; case-folded, trimmed, length-capped.
- **Collections:** create, add, remove, order, nest one level; optional binding to a project and a `.bib` path.
- **Notes:** per-paper notes, stored as paper-scoped observations (spike confirms this needs no new table).
- **Filter syntax** used by `list` and `export`: `tag:`, `collection:`, `project:`, `year:` (single or range), `author:`, `venue:`, `has:pdf`, `has:doi`, `verified:`, `integrity:`, plus free text through the existing FTS search. Parsed by a tiny tokenizer; unknown fields are an error, not a silent no-op.
- **Search integration:** tags and notes are included in the paper search leg; the response still reports typed `empty_reason`.
- **Paging:** keyset paging with `total_count`, as `list` does today.
- **Bulk writes:** the store uses SQLite's default rollback journal with no `busy_timeout` set beyond Python's 5-second default, and a second writer fails with `database is locked` while one holds the write lock (spike P5). Bulk `import` therefore commits in batches (default 200 entries), sets `PRAGMA busy_timeout` to 30 s for the library actions, and returns a typed `locked` error with a retry hint instead of a raw exception. WAL is **not** enabled: it changes the on-disk layout that `backup` copies.

Acceptance: filters compose; collection order is stable; deleting a collection never deletes papers; tag edits are audited.

## 8. Phase 4 — export, project bibliographies, hygiene

### 8.1 Export

| Format | Notes |
|---|---|
| `bibtex` (classic types) and `biblatex` | Type and field mapping from the BibLaTeX manual; brace-protected titles where needed; single-name and corporate authors braced; `and` joins; month and pages normalised; stable field order for clean git diffs |
| `csl-json` | The lossless interchange format; what `citation` consumes |
| `ris` | Type map and tag map written from the RIS description |
| `json` / `csv` | Flat dumps for scripts and spreadsheets |

Scopes: all, a filter expression, a collection, a project, or **cited-only** (the keys a manuscript actually cites, from the persisted `citations` locators). Output goes to a path inside the workspace or is returned inline, capped.

### 8.2 Project `.bib` sync

- `export --project X --cited-only --path references.bib` writes a managed file with a header comment and a content hash.
- `--check` compares the file with the library and reports added, changed, and removed entries without writing.
- A file that was edited by hand since the last managed write is **not overwritten** unless `--force`; hand-added entries are listed and preserved under a marked section.
- Exporting freezes the keys it wrote (§6).

### 8.3 Dedupe, merge, doctor

- **Dedupe candidates:** identity matches plus fuzzy title + year + first-author similarity; each group lists the evidence. Nothing merges automatically.
- **`merge --dry-run`:** a field-level report (value in each paper, proposed winner by title/identity precedence, conflicts) before the existing structural `merge_papers` runs; `merge` requires confirmation.
- **`doctor` (library):** missing required fields per entry type, invalid or duplicate keys, DOI present but unverified, entries with no authors or year, unmatched `cite` keys in bound manuscripts, retracted or corrected papers that a manuscript still cites. Output is evidence, not a verdict; an unavailable check is `unknown`, never "clean".

Acceptance: golden BibTeX/RIS/CSL files match byte-for-byte; `--check` is read-only; a hand-edited `.bib` survives a sync; dedupe never merges on its own.

## 9. Phase 5 — plugin integration

| Piece | Change |
|---|---|
| `papermemory_library` MCP tool | New; actions `add`, `get`, `list`, `update`, `tag`, `collect`, `note`, `import`, `export`, `keys`, `dedupe`, `merge`, `doctor`, `set_integrity` |
| `papermemory.js` | Expected tool surface 14 → 15; keep the fail-loud drift check |
| `papermemory-cli.js` | `MIN_PAPERMEMORY_VERSION` → 0.3.0 so existing installs reinstall the vendored package |
| `citation` | `source: "library"` for format/export/validate through CSL-JSON; no change to its ad-hoc path |
| `manuscript_citations` | Report cited keys missing from the library and library entries never cited |
| `integrity_check` | `library check` sweeps a filter or the whole library and writes results back with `set_integrity` |
| `paper_download`, `literature_search` | A downloaded or found paper can be added in one step; results carry an `in_library` flag from a DOI lookup |
| `review` | `review add` accepts a collection as a record source |
| `prompt.js` | Short "Reference library" section: add papers by identifier, cite only keys from the library, never invent a key; cross-reference the existing empty-`cite` rule |
| Skills | Update `skills/papermemory/SKILL.md` and `skills/citation-management/SKILL.md`; the `pyzotero` skill is left alone |
| Docs | `PAPERS.md` ("The 15 tools", library section), `TOOLS.md`, `WRITING.md`, `README.md` count, `CHANGELOG.md`, `OPTIONAL-TOOLS.md` unaffected |

## 10. Testing

PaperMemory (pytest, offline, `vendor/papermemory/tests/`):
- `test_library_import.py` (parser, LaTeX table, RIS, CSL-JSON, malformed input), `test_library_keys.py`, `test_library_meta.py` (backfill, `reference_meta` round trip), `test_library_org.py`, `test_library_export.py` (golden BibTeX/BibLaTeX/RIS/CSL), `test_library_doctor.py`.
- **Migration test** from a saved schema-2000 database fixture: row counts unchanged, existing keys untouched, `cite`/`cite-check`/`recap` outputs identical before and after.
- **Property test:** import → export → import keeps the semantic fields for a corpus of generated entries.
- **Scale:** extend `scripts/scale-test-papermemory.py` with a 10,000-entry library (import, filter, export times) and record it in `reports/`.
- MCP framing and tool-surface tests updated for 15 tools.

Plugin (Node, offline):
- `scripts/test-phase7.mjs` expected tool list, a `citation` library-source test, and a **cross-writer test**: the same CSL-JSON fixtures exported by PaperMemory and by `citation-format.js` agree on keys and on the BibTeX fields both support.
- Registration and packaging tests as in `PAPIS-AND-EVIDENCE-TOOLS-PLAN.md` §0.2 (no new JS tool module is needed, so the `inject` checklist applies only to `citation`/hook edits).

## 11. Delivery workflow

`vendor/papermemory/SOURCE.txt` records "Upstream exceptions: none", so changes land **upstream first** in `raktim-mondol/papermemory`, are released as 0.3.0, and are then re-vendored with an updated commit pin. This keeps the vendored tree identical to a tagged release.

| Step | Work | Size |
|---|---|---|
| A | Spikes (§12) | S |
| B | Phase 1 records and import, schema 2100 migration | M |
| C | Phase 2 keys | M |
| D | Phase 3 organisation and query | M |
| E | Phase 4 export, sync, hygiene | L |
| F | Release PaperMemory 0.3.0; re-vendor; Phase 5 plugin integration; plugin v0.26.0 | M |

B → C → D are sequential (each depends on the schema); E depends on C; F last. The domain-sources, reporting, appraisal, and power phases from the sibling plan do not depend on this work and can proceed in parallel.

## 12. Spikes

| Spike | Question |
|---|---|
| P1 | **Done** (see §12a): reuse `observations`. |
| P2 | **Done** (see §12a). Re-run the same corpus script after the new parser lands as a regression check. |
| P3 | **Done for the field mapping** (§12a). Still to check in Phase 1: whether `citation-js` round-trips the `extra_json` fields. |
| P4 | **Partly done** (§12a): one real RIS sample. Real Scopus and Web of Science exports are still needed as fixtures. |
| P5 | **Done** (§12a): batching + `busy_timeout`, no WAL. |
| P6 | **Done** (§12a): call the PaperMemory CLI through `papermemory-cli.js`. |

## 12a. Spike results (2026-10-29)

Run read-only against the user's real files (scripts kept outside the repo; PaperMemory's database was only read).

| Spike | Result | Effect on the plan |
|---|---|---|
| **P1** notes | `observations` already has a nullable `paper_id`, and `remember` and the MCP `papermemory_remember` tool already accept it. No rows use it yet. | **No `paper_notes` table.** Notes are paper-scoped observations (tier `note`); editing a note supersedes the old one. |
| **P2** BibTeX corpus | 1,440 `.bib` files, 125 unique contents, **5,821 entries**. Current parser read 5,814; 7 were lost in one file with an unterminated entry. **88.9% of entries (5,168) lose at least one field on ingest** (pages 4,417; volume 4,256; number 2,761; url 909; month 579; note 222; pdf 204; series 167; isbn 157; issn 139; plus MR/zbMATH fields). 83 distinct field names. Types: article 4,724, inproceedings 470, misc 303, book 265, incollection 23. Features in files: LaTeX accents 78, `others` 97, `{\cmd}` 25, quoted values 7, `@string` 1, month macros 3. | Lossless storage is justified by data, not taste. Parser requirements and the collision rule in §5 were added. Fields with no CSL home are kept under their BibLaTeX names in `extra_json`. |
| **P2** parser behaviour | Synthetic cases: `@string` macro not expanded (venue became the literal `jn`); `()`-delimited entries dropped; quoted value with `\"` truncated; an **unterminated entry merged with the next one, giving key `a4` the title of `a5`** (silent corruption); duplicate field = last wins; braces around corporate authors dropped. | These are fixtures for the new parser; the unterminated-entry case is the highest-priority fix. |
| **P2** keys | 4,838 distinct keys; 45 keys name different papers in different files; 285 DOIs appear under more than one key. | Added `bib_key_aliases` and the collision rule in §4.2 and §5. |
| **P3** CSL coverage | CSL-JSON covers title, author/editor, issued (year+month), container-title, volume, issue, page, publisher, place, DOI, URL, ISBN, ISSN, abstract, note, language, edition, series (collection-title), keyword. It has **no home** for `eprint`/`archiveprefix`/`primaryclass`, `mrnumber`/`mrclass`/`mrreviewer`, `zbl`/`zbmath`, `msc2010`, `fjournal`, `pdf`/`file`, and DBLP's `biburl`/`bibsource`/`timestamp`. `number` maps to CSL `issue` for articles but `number` for reports. | `extra_json` keeps those under original names; `file`/`pdf` (local paths) are stored but **excluded from exports by default**; the `number` mapping is type-dependent and tested. |
| **P4** RIS | One real export available locally (a journal article): tags `TY, AU (repeated), PY, DA, TI, JO, AB, SN, UR, DO, ID, ER`. No Scopus or Web of Science RIS file exists yet. | The importer must handle repeated tags, `DA` as `YYYY/MM/DD`, `SN` as ISSN or ISBN by type, and tag variants (`T1/TI`, `JO/JF/JA/J2`, `A1/AU`, `KW` repeated, `N1`). Real Scopus and Web of Science exports are not required (dropped). |
| **P5** concurrency | Default rollback journal; a second writer gets `database is locked` while the first holds the lock; no WAL. | Batched commits, `busy_timeout`, typed `locked` error; WAL stays off (§7). |
| **P6** plugin touch points | `citation.js` and `manuscript-citations.js` do not reference PaperMemory today. The plugin already calls the PaperMemory CLI from JS (`papermemory-cli.js` `run`, JSON output) for ingest. | `citation` and `manuscript_citations` will call `papermemory --json library …` through that existing path; no MCP round trip from JS. |

The live database holds 137 papers (121 with a key, 96 verified, 136 metadata-only, 5 projects), so the migration is small and cheap to back up and test on a copy.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migrating the user's global database | Additive tables only; `papers` untouched; automatic `backup` first; migration is explicit and single-writer; rollback is "ignore the new tables" |
| Stdlib-only parsing is fragile | Real-corpus spike P2; per-entry error reporting; raw entry kept in `raw_bibtex`; fixtures for each known bad case |
| Citation keys change under a manuscript | Freeze on export, history table, `rekey` only on request with the affected manuscripts listed |
| Two BibTeX writers drift | Shared golden fixtures run against both; `citation` uses PaperMemory for library exports |
| GPL contamination | Spec-derived tables, no copied code or fixtures, Papis not used at runtime (§3) |
| Prompt/tool bloat | One new MCP tool; short prompt section; filter syntax documented once |
| Hand-edited `.bib` overwritten | Managed header + hash, `--check`, refusal without `--force` |
| Large CSL blobs slow listing | List returns a projection, not `csl_json`; blobs fetched by `get`/`export` only |
| Library check implies certainty | Evidence-not-verdict wording; unavailable checks reported as `unknown` |

## 14. Decisions (resolved)

| # | Decision |
|---|---|
| L1 | Papis is a **design reference only**; the implementation is written fresh against the public specs, and PaperMemory stays MIT. |
| L2 | **One** `papermemory_library` MCP tool with an `action` argument. |
| L3 | Default key template **`{family}{year}{titleword}`**, matching the `citation` tool. |
| L4 | **RIS is in the first release**, alongside BibTeX and BibLaTeX (import and export), CSL-JSON, JSON, and CSV. Hayagriva stays deferred. |

BibTeX is a first-class format, not an add-on: it is the main import path (Phase 1) and the main export path (Phase 4), and the project `references.bib` sync is built on it. In summary the first release supports:

| Format | Import | Export |
|---|---|---|
| BibTeX (classic types) | yes | yes |
| BibLaTeX | yes | yes |
| CSL-JSON | yes | yes |
| RIS | yes | yes |
| JSON / CSV | no | yes |
| DOI / arXiv id | yes (lookup) | n/a |

## 15. Non-goals

- A GUI for the library, or any Papis, Zotero, Mendeley, or EndNote integration.
- Publisher scrapers and PDF downloaders beyond the existing `paper_download`.
- A second styled-citation engine in PaperMemory; styles stay in `citation`.
- Citation-graph storage (cites / cited-by) in this release.
- Cloud sync; the SQLite file and optional CSL-JSON snapshot are the only persistence.

## 16. Implementation log

### Phase 1 — done (branch `library-phase1` in `~/papermemory`, commit `0add6cb`, not pushed, not merged)

Delivered: schema 2100 and `migrate_2100` (all seven library tables are created now so later phases need no second migration), tolerant BibTeX/BibLaTeX parser, RIS and CSL-JSON readers, lossless `reference_meta`, library-wide keys with project-scoped aliases, `papermemory library import|get`, `ingest` routed through the new importer, `.ris` recognised by `ingest`, `merge_papers` and JSONL export/restore extended, `cite-check` resolves project aliases. The pytest suite grew from 90 to 124 tests, all passing.

Measured against the user's real files and database:

| Check | Result |
|---|---|
| 125 unique `.bib` files, 5,821 entries | **0 failed**, 4,553 papers created, 1,268 merged as duplicates, 2.1 s total |
| Parse problems | 5 unterminated entries, each recovered and reported (the old parser silently lost 7 in one file) |
| Key collisions between different papers | 68 renamed with a letter suffix; 17 duplicate keys inside one project reported |
| Copy of the live database (137 papers) | Refused to open until `migrate`; migration added 137 records and 121 keys; every `papers.bibtex_key` unchanged; integrity and foreign-key checks clean |
| Real RIS sample | Parsed (type, authors, `DA` date, DOI from `DO`, ISSN from `SN`, `ID` as key) |

Deviations from the plan as written:

- `bib_key_aliases` has the primary key `(key, project_key)`; the project-scoped lookup order in `get_entry` is project alias → library key → any alias → paper id → DOI.
- The `papermemory_library` MCP tool is deferred to the plugin-integration step, so the tool surface is added once, with its final actions.
- RIS is tested with one real Zotero-style export and two synthetic publisher-style files written from the RIS tag set. Real Scopus and Web of Science exports are **not** required (decision: dropped); the importer is generic and unknown tags are kept under `ris_<TAG>` in `extra`.
- `make_key` already implements the default template (so RIS records without a usable id get a generated key); the template setting, `keys check`, freezing and `rekey` are Phase 2.

### Phase 2 — done (same branch, commit after `f95553f`)

Delivered: `bibkeys.py` (template with `{family} {year} {titleword} {doi} {arxiv}`, validation, BibTeX-safe cleanup, DOI/arXiv fallback), `library_keys.py` (`check`, `assign_missing`, `freeze`, `rekey`, `citing_manuscripts`), CLI `papermemory library keys check|assign|freeze|rekey`, audit ops `KEY_FREEZE` and `KEY_RENAME`, `cite-check` resolution of keys retired by `rekey`. 138 tests pass (14 new key tests).

Design points settled while building it:

- `rekey` is a **dry run unless `apply`**, and applying needs a reason. The dry run already lists citing manuscripts (recorded locators plus a live scan of each manuscript's files). Applying clears the frozen flag, because the new key has not been exported yet.
- The default template cut at 48 characters is kept only for the default template so it stays identical to the `citation` tool; custom templates are capped at 64.
- Records with neither author nor year use the DOI, then the arXiv id, instead of `anonnd...`.
- `check` treats only missing keys, unsafe keys, and a `papers.bibtex_key` mismatch as failures. Template drift (generated keys only) and alias-shadows-key are informational.

Measured: on the real 4,553-paper corpus `keys check` takes 0.08 s and finds 2 genuinely unsafe keys in the user's files (one with a space, one with a non-ASCII character) and 106 project aliases that shadow another paper's library key. On a copy of the live database, `assign` filled the 16 papers that had no key and `check` then passed.

### Phase 3 — done (same branch)

Delivered: `library_org.py` (tags, collections, notes), `library_query.py` (filter parser, keyset-paged `list_papers`, `tag_counts`), CLI `papermemory library list|tag|collection|note`, tags and paper notes in the paper search leg, `merge_papers` coverage. 160 tests pass in total (22 new).

Design points settled while building it:

- **Negation:** `-` or `!` negates a filter. A leading `-` is read as an option by the command line, so the CLI documents `!`.
- **Notes need no new table:** a note is an observation with tier `note` and a `paper_id`. Editing creates a new note and marks the old one superseded; removing sets `superseded_by='removed'`, so every existing query that filters on `superseded_by IS NULL` ignores it without change.
- **Nesting:** a collection filter includes papers in child collections. A third level is refused.
- **Paging:** the cursor encodes the sort, direction, last sort value and row id, and is refused when the sort changes. All four sorts and both directions visit every row exactly once.
- **Free-text query vs `search`:** `library list words` is a substring match over metadata, tags and notes; the existing `search` keeps its ranked behaviour and now also sees tags and notes.

Measured on the 4,553-paper corpus: filtered and sorted listings return in about 0.05 s.

### Phase 4 — done (same branch, commit `a855d2d`)

Delivered: `bibwrite.py` (BibTeX/BibLaTeX/RIS/CSV/JSON writers), `library_export.py` (scopes, key selection, managed-file sync), `library_hygiene.py` (dedupe, merge preview/apply, doctor), CLI `papermemory library export|dedupe|merge|doctor`. 196 tests pass (36 new).

Problems found by running it on the user's real data, and fixed:

| Found | Fix |
|---|---|
| The same paper in several projects' `.bib` files kept only the **first-imported version**; a project export differed from that project's own file in 8 of 36 entries (title case, a truncated author list) | New table `reference_variants` keeps every imported version; the most complete record is canonical; a project export reproduces that project's own entries (`--variant canonical` for the library record). Re-check: 36 of 36 entries identical to the original in both projects that share the file |
| A full date (`2026-05-28`) lost its day in classic BibTeX output (12 papers) | Classic output also writes `date` when a day is known |
| `dedupe` chained annual items ("News from the Bioconductor Project", 2013–2021) into one 9-paper group, and flagged "Addendum: …" as a duplicate of its paper | Titles differing only by a number, part, or notice word are not duplicates; three or more identical titles in different years are reported separately as `series_like` |
| Notes were left pointing at a deleted paper after `merge` | `merge_papers` repoints notes and variants |

Measured on the 4,553-paper corpus: export of everything 0.9 s, 0 parse errors in the written file, re-import 1.3 s with every key present and every compared field equal after the date fix; `dedupe` 0.15 s (103 candidate groups, 5 series); `doctor` 0.2 s.

Design points: the managed `.bib` records a hash of its block, so an unchanged file is not rewritten and a hand edit is detected; `--out` must stay inside the workspace (symlinks included); formats other than `.bib` never overwrite an existing file without `--force`; exporting freezes only keys written under their library key.

### Phase 5 — done (PaperMemory `main` at tag `v0.3.0`, plugin branch `library-v0.26.0`; nothing pushed)

PaperMemory: `papermemory_library` MCP tool (13 actions, dry runs by default, sandboxed paths), library records and keys created at ingest, export assigns missing keys (a check never writes), `library resolve`, `library integrity set`, version 0.3.0, tag `v0.3.0` (local). 203 tests pass.

Plugin (v0.26.0): re-vendored PaperMemory 0.3.0 (`SOURCE.txt` pins the commit), `papermemory-library.js` (non-throwing CLI bridge), `papermemory.js` expects 15 tools, `papermemory-cli.js` requires 0.3.0 and **backs up then migrates an existing store on first start**, `citation` library source, `manuscript_citations` library check, `literature_search` `in_library`, `integrity_check` library sweep, prompt section, refreshed `papermemory` skill (and a seeder rule so existing installs get it), docs and changelog, `scripts/test-library.mjs`. All 47 plugin test scripts pass.

Problems found while integrating, and fixed:

| Found | Fix |
|---|---|
| `papermemory backup` opened the store normally, so it **failed on the very store that needed migrating**; the safe upgrade path (backup, then migrate) was impossible | `backup` uses the migration connection; test added |
| Papers added by `paper_download`/ingest had no library record or key, so they could not be cited from the library | Records are created at ingest, with a key once there is an author, DOI, or arXiv id and a real title; export assigns the rest |
| An integrity sweep skipped papers whose DOI is malformed, so they stayed "unchecked" and the sweep would loop on them | They are recorded as unknown and reported as `invalid_doi` |
| `scripts/test-phase7.mjs` tested whichever PaperMemory happened to be installed under `~/.dsh`, not the vendored one | It now tests the vendored package |

Deviations from the plan: `skills/citation-management` is vendored third-party material and was **not** edited; the library guidance lives in the `papermemory` skill and the prompt. The MCP server runs in the home directory, so every path-taking action requires `cwd`; the prompt and skill say so.

Remaining before release: push `~/papermemory` `main` and the `v0.3.0` tag (the vendored `SOURCE.txt` pins that commit), review the plugin branch, and run a real DSH boot (`.github/workflows/verify.yml` does this in CI) to confirm the preset mounts with 15 tools and no validation error.

