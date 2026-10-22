# PaperMemory v2 — Redesign Plan

Upstream `raktim-mondol/papermemory` (v0.1.1-era code) → re-vendored into `dsh-researchcraft`. Owner-executable across three repos; every code/SQL assertion was re-executed on the target machine (sqlite 3.45.3, the live store, the live installer) before entering the spec.

**Revision history.** Rev 2 — revised after four adversarial reviews (completeness, traceability walk, ops safety, scope discipline). Rev 3 — three residual cross-section contradictions (AH `\cite` key aliases, live-twin merge ordering, one-ledger ops) closed by direct patches; all six traceability walks verified CLOSED. Rev 4 — owner-approved deterministic section roles + `outline` surface + opt-in `section_role` filters; no stored summaries, no role-based ranking.

## 0. Provenance correction

### 0.1 The upstream pin is stale

Vendored tree vs `cb197e5` differs in `cli.py`, `db.py`, `ingest.py`, `mcp_server.py`; vs upstream HEAD `914c2b3` (**v0.1.1**) only in version strings. Upstream `d7dd106` already contains **both** DSH edits (`SOURCE.txt:4-7`). Fixes: Phase 0 re-pins `SOURCE.txt` to `914c2b3`/`0.1.1` with an **empty** exception list ("least-audited code" withdrawn — it is upstream, reviewed, tagged); Phase 8's `rsync` set becomes `papermemory/ tests/ pyproject.toml README* LICENSE` (else vendored `pyproject.toml` stays 0.1.0 and `vendoredVersion()` reads it, `papermemory-cli.js:302-303`), `__pycache__` excluded from the CI `diff -r` gate that is **red today**; vendored tests are absent (`SOURCE.txt:8-9`, pytest exit 4), so CI runs upstream until the re-vendor copies `tests/`; `requires-python` cannot express the SQLite floor (`">=3.10"`), so a runtime check replaces it (§3.2).

### 0.2 Build-start gates (Phase 0.0)

- Back up `papermemory.db` + `-wal`/`-shm` with sha before any code change (none exist).
- Ship the Phase 0b guard in the current release line: writes abort with `schema-too-new` when `user_version >= 2000`. v1 never reads it, so an old binary runs `executescript(SCHEMA)` on a v2 store and serves reads (D12's shape); patch all three binaries first (venv `0.1.0+dsh2`, PATH `0.1.1`, vendored tree).
- `papermemory doctor --schema` (DB path, `user_version`, sqlite version, module path, other PIDs) starts every acceptance; installers use `uv venv --clear` (`papermemory-cli.js:243` needs it) and enforce `MIN_PAPERMEMORY_VERSION`.

### 0.3 Evidence pointers re-pointed

r2 SYNTHESIS line 1 is a header: the 2/92 datum is `:37`/`:58`, the clobber `:22`, ANTI items `:59` (52-54 are MARKDOWN PIPELINE), converter signals `pdf-to-markdown.js:111-115`, zero-parser `:33`, partial-coverage `:58`.

## 1. Invariants

Seven pytest invariants over `pipeline_version >= 'pmv2'`, `provenance_basis='verbatim'` rows; legacy strata (§3.6) is reported as legacy, not a violation.

| # | Invariant | Testable statement |
|---|---|---|
| **INV-1** | **VERBATIM SUBSTRING** | No L1-L3 text column; a quote is materialized only as `raw_documents.text[qs:qe]`, so `quote_sha256 == sha256(raw[qs:qe])` **by construction** (`asserted_quote` is caller wording, never evidence). Test re-slices every claim and every chunk (`is_slice_of_raw`), killing the 2/92 baseline (`/tmp/r2-digest.txt:37,58`). |
| **INV-2** | **TRACEABILITY** | Chunk stores `(paper_id, doc_id, section_id, char_span, byte_span, source_sha256, origin_channel, extraction_event_id)`; claim reaches the same eight via `primary_section_id`, `quote_char_span`, `quote_sha256` → `claim_sources` → chunks. Failures are excluded from cite/recap and enumerated by `health`; test adds a hand-inserted orphan that must be reported, not citable (today `claims.paper_id` has no FK: CG-1). |
| **INV-3** | **COVERAGE** | Score all, then slice: `ORDER BY bm25(...)`; every predicate pushed into SQL (`is_bibliography=0`, project `EXISTS`, `cite_state`, `doc.is_current=1`) so default fetch = `limit`; only a rerank window over-fetches (`max(4*limit,64)`) with per-row recheck. Claim/paper legs run **without LIMIT**. Enforcement is decidable: a stdlib-`ast` scan asserts each SQL `LIMIT` also has a governing `ORDER BY`; exempt: keyset pagination, `ORDER BY recorded_at DESC LIMIT 1`, FTS `optimize`/`rebuild`, `log --tail`. Test: 300 papers/20 probes, returned set == true bm25 top-N (baseline 15/32 at 134, 8% at 320). |
| **INV-4** | **IDEMPOTENCE** | Identity = `sha256` of declared fields, computed once at creation by the function probe and write share, `UNIQUE(identity_kind,identity_value)` + `ON CONFLICT DO UPDATE`; `paper_id` immutable, lookups by `(kind,value)`/`paper_aliases`. No ambient value participates. Test: same file from two paths → 1 paper/1 doc/0 duplicate chunks; two `main.md` twins → 2 rows (today 1 row, B's text, A's claims: IQ-2). |
| **INV-5** | **FAIL-LOUD** | Zero-chunk, partial and identity-unresolved ingests are typed states, never `ok`; every tool error sets `isError:true`; every zero-output path emits one greppable event with a closed-set reason. Test: text-less scan and frontmatter-less markdown → `status="failed"` + reason + `isError` (baseline 121/134 chunk-less shells "succeeded", 90 `verified=1`). |
| **INV-6** | **NO-SILENT-REWRITE** | Unchanged bytes → `duplicate-noop`; changed → new `raw_documents` row (old `is_current=0`), fresh derivation with stable claim ids (`claim_key` = `sha256(paper_id|sha256(normalize(claim_text))|quote_sha256)[:16]`, §7.1), and a checkpointed sweep: claims on a non-current doc → `unverified-quote`/`doc-superseded`, failed quotes → `locator-drift`; old doc, chunks and slices stay readable. A killed sweep resumes from `sweeps.cursor` to the same terminal state. |
| **INV-7** | **ABSENCE IS EARNED** | "No source for X" needs every leg in the declared `absence_scope` `ok` (others named `skipped:kind`), `corpus_match_count == 0` (untruncated `COUNT(*)` over the MATCH), every `suppressed` class 0 (including non-FTS `chunkless_papers`/`uncovered`), `coverage.capped_docs=0`. `empty_reason` is one closed set with precedence: `project-not-found` > `leg-error:<leg>` > `all-suppressed:bibliography`, `all-suppressed:non-claimable`, `all-suppressed:chunkless-paper`, `all-suppressed:uncovered-span`, `all-suppressed:superseded-claim` > `absence-not-licensable` > `no-match-in-project` > `no-match`. Test: a term only in a bibliography chunk / chunkless paper / uncovered span returns its own reason, never `no-match`. |

`verified` is derived, never model- or `actor`-granted: only a passing write-time `quote_check` assigns it (§7.1 owns the ladder); AH verdicts stay orthogonal in `ah_verdicts`.

## 2. Confirmed defects

All rows were adversarially reproduced; file:line evidence is in `/tmp/pm-digest.txt`, ids match `/tmp/mem-digest.txt:55-71`.

| ID | Defect | Sev |
|---|---|---|
| D1 | FTS pool `LIMIT limit*4`, no `ORDER BY`, rank = enumerate; coverage 100%→8%; project filter after truncation | critical |
| D2 | Dead dedupe: write fingerprint `(doi,arxiv,title,year,bibtex)` vs probe `(title,year)`; live twins with 118 duplicate chunk texts | high |
| D3 | Stem fallback merges two different papers onto one row; one text replaces the other while claims stay | high |
| D4 | Metadata-only/scanned ingests report success; 0-chunk PDFs searchable; JS returns `ok:true` + hidden `error` | high |
| D5 | `verified` decorative (a `.bib` DOI grants it), gates nothing; 90 chunk-less rows verified | high |
| D6 | **No quote-grounding path**; `get` shows 4.2% of a paper; a hit is an OR of 12 tokens, not a phrase test | critical |
| D7 | Scoping fiction: no project on chunks, guard short-circuits, `cite` cannot scope, two slug namespaces | critical |
| D8 | No claim lifecycle; re-ingest duplicates every claim and duplicates read as corroboration | high |
| D9 | `recap` samples 3.6%, queries no claims, floods 8 slots with 3.5 KB dumps; `limit=1000` → 91k tokens | high |
| D10 | Hyphenated vocabulary scores 0.00 vs 1.00; rerank on 400 chars; one paper takes 8 slots; ingest-date decay self-inflated by `get` | high |
| D11 | (Re-scoped) tables must be row-atomic with bound headers; `Jan.`/`Std.` are false sentence ends; 1022/1022 v1 chunks `page=NULL` | high |
| D12 | `Store()` outside try, `_err` lacks `isError`; a fault kills the child, unregisters tools; nothing enumerable; `audit` covers 4/13 mutations, read by none, written after COMMIT; no `user_version`; 52 MB duplicates. Plugin: `failOnStartupError:false`, Content-Length-only PATH binary, 10 reconnects then tools gone | critical |
| **D13** | Manuscript state double-bookkept in memory and AH (comments, terminology, word targets, contributions); no authority declared | high |
| **D-seam** | Memory claims and AH verdicts share no state; T3 reads only AH's registry; unregistered keys degrade to `EVD-04` info, `BIB-02` skipped on an empty registry | critical |

**Preserved strengths**: WAL durability across 4 SIGKILLs; 10 concurrent writers, 0 errors; all queries sub-2 ms at 500 papers — **the fix is ranking and grounding, not indexes**; the PDF+markdown merge once the link is passed; model-free verbatim sentence extraction; `lookup_cite` refuses to fabricate.

## 3. Schema v2

### 3.1 DDL (`PRAGMA user_version = 2000`)

**`char_*`/`byte_*` 0-based half-open, `line_*` 1-based inclusive**; SQL `substr` is 1-based, so SQL re-slices add 1 (§3.4), and a test asserts each re-slice hashes to `quote_sha256`. `foreign_keys=ON` before `BEGIN`; script ends with `PRAGMA foreign_key_check`. Compact schema: unmarked TEXT, `i` INTEGER, `r` REAL, `*` NOT NULL, `=` default, `PK` primary key; `schema_v2.sql` expands 1:1.

```text
projects(key PK, title, kind='manuscript', ah_root, created_at*)
papers(id PK, identity_kind*, identity_value*, title*, title_source*, authors_json='[]',
  year i, venue, doi, arxiv_id, bibtex_key, origin_channel*, cite_state*='chunkless',
  current_doc_id, pdf_path, source_type, verified i=0, project_id,      -- last four v1 compat
  created_at*, updated_at*, UNIQUE(identity_kind,identity_value))
paper_aliases(kind, value, paper_id*, first_seen*, PK(kind,value))
raw_documents(id PK, paper_id*, sha256*, bytes i*, chars i*, text*, corpus_path*,
  origin_path*, origin_channel*, converter_json='{}', kind='paper', linked_sha256,
  provenance_basis='verbatim', pipeline_version*, is_current i=1, supersedes_doc_id,
  created_at*, UNIQUE(paper_id,sha256))
sections(id PK, doc_id*, parent_id, level i*, heading_path*, char_start i*,
  char_end i*, line_start i*, line_end i*, is_bibliography i=0, is_abstract i=0,
  kind='prose', role='unclassified', role_confidence i=0, role_source='none',
  role_secondary NULL, ord i*, pipeline_version*,
  UNIQUE(doc_id,char_start,level,heading_path))
chunks(seq i PK AUTOINCREMENT, id UNIQUE*, doc_id*, paper_id*, section_id*,
  byte_start i*, byte_end i*, char_start i*, char_end i*, slice_sha256*, source_sha256*,
  index_text*, table_id, row_start i, row_end i, header_span_json, is_bibliography i=0, claimable i=1,
  chunk_index i*, origin_channel*, extraction_event_id, pipeline_version*,
  UNIQUE(doc_id,byte_start,byte_end,pipeline_version))
extractions(id PK, doc_id*, paper_id*, pipeline_version*, status*, reason_code='',
  started_at*, finished_at, stats_json='{}')
claims(seq i PK AUTOINCREMENT, id UNIQUE*, claim_key*, paper_id*, manuscript_id, project_key, claim_text*,
  claim_text_norm*, claim_type*, asserted_quote, quote_char_start i*, quote_char_end i*,
  quote_line_start i, quote_line_end i, quote_sha256*, doc_id, primary_section_id,
  source_sha256, origin_channel*, pipeline_version*, extraction_event_id,
  status='unverified-quote', status_reason='', confidence r=0.4, is_latest i=1,
  supersedes, superseded_by, ah_binding_ref, created_at*, updated_at*)
claim_sources(claim_id, chunk_id, ord i=0, PK(claim_id,chunk_id))
claims_history(id PK, claim_id*, event*, old_status, new_status, old_claim_text,
  new_claim_text, old_doc_id, new_doc_id, actor*, reason, evidence_json='{}', at*)
sweeps(id PK, kind*, paper_id, doc_id, cursor i=0, total i=0, state*, reason_code='',
  started_at*, updated_at*)
coverage(doc_id PK, source_chars i*, indexed_chars i*, uncovered_json='[]',
  chunk_count i*, section_count i*, dropped_sections_json='{}', capped i=0,
  truncation_reason='', ratio r*, checked_at*)
events(id PK, ts*, op*, paper_id, doc_id, claim_id, project_key, status*, reason_code='', detail)
paper_projects(paper_id, project_key, first_seen*, source_event*, PK(paper_id,project_key))
ah_verdicts(id PK, claim_id*, doc_id*, raw_sha256*, char_start i*, char_end i*, verdict*,
  quote, locator, quote_hash, mismatch_json='[]', prompt_version*, model, run_id i,
  ledger_sha256*, recorded_at*)
manuscripts(id PK, slug UNIQUE*, title*, target_venue, citation_style, root_path,
  ah_project_key, status='draft', notes, created_at*, updated_at*)
citations(id PK, manuscript_id*, bibtex_key*, paper_id, tex_file*, tex_line i*,
  sentence_hash*, scanned_at*, UNIQUE(manuscript_id,tex_file,tex_line,bibtex_key))
```
The v1 manuscript block is retained verbatim from `db.py:91-144` (`manuscript_sections`, `contributions`, `terminology`, `reviewer_comments`), plus `mirror_of_ah i=0` on the latter two. FK rule: each `doc_id`/`paper_id`/`manuscript_id`/`project_key`/`section_id`/`chunk_id`/`claim_id`/`extraction_event_id`/`source_event` column references its namesake table, CASCADE except `claims.manuscript_id` SET NULL; plus `papers.current_doc_id`, `raw_documents.supersedes_doc_id`, `sections.parent_id`. Keys: partial unique `uq_raw_current(paper_id) WHERE is_current=1`, `uq_claim_latest(claim_key) WHERE is_latest=1`; indexes on `claims(ah_binding_ref)`, `claim_sources(chunk_id)`, `ah_verdicts(claim_id,recorded_at)`, `citations(paper_id)`, `chunks(paper_id,chunk_index)`, `sections(doc_id,role)`. `lessons`/`observations` keep v1 tables plus `status`, `updated_at`, `superseded_by`, `origin_channel`; `entities`/`relations` are **dropped**; v1 chunks/claims move to `legacy_*`. **D13:** with `projects.ah_root` set, AH owns review workflow and memory keeps a read-only mirror; with `ah_root` NULL memory owns it; `manuscripts`/`citations` are memory-owned always.

### 3.2 Indexes: one FTS table, two SQL legs

`CREATE VIRTUAL TABLE chunks_fts USING fts5(index_text, content='chunks', content_rowid='seq', tokenize='unicode61 remove_diacritics 2')` — external content, no UNINDEXED filters (filtering is in the JOIN). Sync inside the base-row transaction: insert `INSERT INTO chunks_fts(rowid,index_text) VALUES(NEW.seq,NEW.index_text)`; delete/update `INSERT INTO chunks_fts(chunks_fts,rowid,index_text) VALUES('delete',old.seq,old.index_text)` **before** the base delete (a base-only delete leaves the entry live — measured); rebuild `VALUES('rebuild')`. `'replace'` is not an FTS5 command (`SQL logic error`, measured 3.45.3) and a test bans it. `seq` is AUTOINCREMENT, never reused; `health` asserts count equality and zero orphan docids. Claim/paper legs are scored SQL over base tables, no second/third FTS index. Claim leg: `claims` where `is_latest=1`, `status IN ('extracted','verified')`, `project_key=:p OR EXISTS(paper_projects…)` — **no LIMIT**, Python overlap score, slice; paper leg the same over bibliographic fields. Runtime: `sqlite3.sqlite_version_info >= (3,43)` else `store-unavailable`.

### 3.3 `verify(claim_id)` — the walk

`grounding.verify_claim(store, claim_id, *, strict=True) -> Walk` is read-only, returns typed `.steps[]`/`.failures[]`: (1) claim exists and `is_latest=1`, else `missing-claim`/`superseded`; (2) `claim_sources` non-empty and every chunk resolves, else `orphan-backlink`; (3) chunks' `doc_id == claim.doc_id`, else `doc-mismatch`; (4) `raw[cs:ce]` hashes to `chunk.slice_sha256`, else `slice-hash-drift`; (5) quote inside the chunk-span union, else `quote-out-of-span`; (6) **materialize** `q = raw[qcs:qce]`; `sha256(q) == quote_sha256` or `quote-not-verbatim` (`unverified-quote`/`locator-drift`); (7) `papers.current_doc_id == claim.doc_id`, else `doc-superseded`, which **short-circuits step 10**; (8) section exists and is not bibliography (`bibliography-evidence`); (9) span inside indexed coverage, else `uncovered-span`; (10) the content-addressed `corpus_path` is realpath-contained and hashes to `raw_documents.sha256`, else `raw-file-drift`; (11) `origin_channel` matches chunk presence, else `channel-assertion-conflict`, and an `ocr-recovered` doc never reports `verified` (`channel-capped:ocr-recovered`); (12) an `ah_verdicts` row with different `raw_sha256` is `stale-verdict-sha`; absent = `no-ah-verdict`.

### 3.4 Reverse traversals (guaranteed queries)

```sql
SELECT c.id, c.claim_text, c.status, s.heading_path,
       substr(r.text, c.quote_char_start + 1, c.quote_char_end - c.quote_char_start) AS verbatim,
       v.verdict, v.prompt_version
FROM claims c JOIN raw_documents r ON r.id = c.doc_id
LEFT JOIN sections s ON s.id = c.primary_section_id
LEFT JOIN ah_verdicts v ON v.id = (SELECT id FROM ah_verdicts WHERE claim_id = c.id
                                   ORDER BY recorded_at DESC LIMIT 1)
WHERE c.paper_id = :paper_id AND c.is_latest = 1;
SELECT c.id, c.claim_text, p.title, p.bibtex_key FROM claims c JOIN papers p ON p.id = c.paper_id
WHERE (c.project_key = :key OR EXISTS(SELECT 1 FROM paper_projects pp
        WHERE pp.paper_id = p.id AND pp.project_key = :key))
  AND c.is_latest = 1 AND c.status IN ('extracted','verified');
-- never `OR project_key IS NULL` (v1 context.py:67 leak)
SELECT * FROM ah_verdicts WHERE claim_id = :id ORDER BY recorded_at;
SELECT * FROM claims WHERE ah_binding_ref = :unit_hash_claim;
SELECT tex_file, tex_line, bibtex_key FROM citations WHERE paper_id = :paper_id;
```

Reverse chain: paper → docs → chunks → claims → verdicts → projects → `citations.tex_file:tex_line`. §8's ledger keys on `(paper_id, raw_sha256, quote_sha256, AH sha16)`; paths are recorded, never joined on.

### 3.5 Ops, ledgers, health

- **One mutation ledger.** `audit` is a **view over `events`**; v1 rows import as `op='MIGRATION'`. Every mutator calls `store.mut(op, …)`, the only writer of `events`, in the same transaction as its row (v1 wrote audit after COMMIT: `db.py:219-223,375`); a test asserts one event per call and zero on rollback. `events.op` is the canonical uppercase enum of §7.3 (`INGEST, DERIVE, INDEX_REBUILD, CLAIM_WRITE, CLAIM_TRANSITION, DOC_SUPERSEDE, IDENTITY_PROMOTE, PROJECT_ENSURE, AH_REGISTER, LEDGER_EXPORT, VERDICT_IMPORT, MIGRATION, SWEEP, MERGE, BIND, REPAIR, DELETE, CITE_CHECK, REMEMBER, LESSON_WRITE, MANUSCRIPT_WRITE`); `claims_history.event` is the disjoint lowercase vocabulary of §7.3.
- **Export** starts with a `{"kind":"header","schema":"pm-2",…,"user_version":2000}` row; `restore` refuses a mismatch.
- **`user_version`.** `Store.__init__` **validates only** (`>2000` → `schema-too-new`, `<2000` → `migration-required`) and never re-runs `executescript(SCHEMA)` (`db.py:213`). Migration is explicit CLI, single-writer (lockfile + `wal_checkpoint(TRUNCATE)`), per-statement `execute()` with explicit BEGIN/COMMIT/ROLLBACK (**`executescript` implicitly commits** — measured), no PRAGMA inside the transaction, SIGTERM→SIGKILL escalation.
- **Health** single statements: FK orphans; hash drift; duplicate `is_current=1`; `is_latest=1` twins per `claim_key`; orphan `project_key`; stale `ah_verdicts`; unresolved `citations.paper_id` for keys present in `papers` (missing keys are `cite_check`'s `missing_from_memory`, not health); `chunks.paper_id`/`extractions.paper_id` ≠ `raw_documents.paper_id`; FTS/row-count mismatch; legacy census.

### 3.6 Migration 2000 and legacy strata

**A populated `papers` cannot be ALTERed into v2** (measured: `ADD COLUMN … NOT NULL` without default → "Cannot add a NOT NULL column"; `ADD COLUMN … UNIQUE` → "Cannot add a UNIQUE column"; `ADD CONSTRAINT` → syntax error). Migration 2000 rebuilds: `foreign_keys=ON` before `BEGIN`, backup verified; create v2 tables and `INSERT…SELECT` papers (quarantined rows get `cite_state='chunkless'`/`identity-unresolved` and `metadata-only`, with `verified/pdf_path/project_id` copied for CLI compat); `ALTER TABLE papers RENAME TO papers_v1; … papers_v2 RENAME TO papers;` — SQLite rewrites FK references, so dependents are created **after** the swap; create `projects` + `unassigned` and backfill `paper_projects` from `papers_v1.project_id`; rename `chunks`/`claims` to `legacy_*`, import old `audit` into `events`, drop it — **no v1 chunk/claim is promoted**: v1 chunk text is whitespace-normalized (0/1022 rows contain a double space) and has no offsets, so promotion would fabricate a verbatim base (an INV-1/INV-5 violation committed by the migration); finally `PRAGMA foreign_key_check` empty and `user_version=2000`.

**Legacy strata.** `legacy_claims` is CLI-only, `unverified-quote`/`no-source-text`, excluded from cite/recap. Census: 134 papers, 121 chunkless, 13 holding 1022 chunks, 11/13 PDFs deleted, no `corpus/`, 125 claims with zero chunk references, 12 matching none — so legacy papers are `chunkless` (bibliographically citable, substance-non-supporting; §5.10 applied *before* Phase 3), never registrable to AH (`no-raw-file`), and invariants assert only over `pipeline_version >= 'pmv2'`. The per-project "v2 delta" report is owner-signed before Phase 3.

**Merge and re-key** (Phase 1): `papermemory merge --from A --into B` runs in one transaction. SQLite checks constraints per statement, so the order is load-bearing: (i) demote A's current docs (`is_current=0`) **and set `papers.current_doc_id=NULL` on A** — releases `uq_raw_current` and the FK before any doc deletion; (ii) **move claim evidence first.** Let `D_dup` = A docs whose `(paper_id,sha256)` would collide with a B doc. For every A claim whose `doc_id`, `primary_section_id`, `claim_sources.chunk_id`, or `extraction_event_id` references a doc in `D_dup`: map `primary_section_id`→the survivor section (match on `char_start,level,heading_path`), `claim_sources.chunk_id`→the survivor chunk (match on `byte_start,byte_end`; collapse rows under `PK(claim_id,chunk_id)`), `extraction_event_id`→the survivor doc's extraction event (match on `doc_id,pipeline_version`), and re-point `ah_verdicts.doc_id` for verdicts on `D_dup` docs (identical sha ⇒ identical `raw_sha256`) — **abort with typed `merge-structural-mismatch` and zero mutations if any mapping is not total**. Then set `claims.paper_id='B'` for every A claim and set `claims.doc_id` to the survivor doc where it pointed into `D_dup`. **Re-key with demote-first ordering** (the `uq_claim_latest` partial unique is checked per UPDATE): compute each target `claim_key` per §7.1 (it includes `paper_id`); for every target key colliding with an existing `is_latest=1` row or with another moved claim, first set `is_latest=0` on all contenders — then write the new keys, choose the verified/newest row per key as `is_latest=1`, and write `claims_history('supersede')` for every demoted loser; (iii) delete the `D_dup` docs (no claim references them now — all four reference columns were re-mapped in ii; their remaining `sections`/`chunks`/`coverage`/`extractions` cascade as structural duplicates of identical bytes). For A's **non-colliding** docs, re-point `raw_documents.paper_id` and `chunks.paper_id` — note `sections` has no `paper_id`; descendants keep their own `doc_id`, and **never re-point descendants across docs** (that would violate `UNIQUE(doc_id,byte_start,byte_end,pipeline_version)` and `UNIQUE(doc_id,char_start,level,heading_path)`); (iv) re-point `extractions.paper_id`, `citations.paper_id`, `sweeps.paper_id`; (v) `INSERT OR IGNORE` A's `paper_projects` rows into B's, then delete A's (absorbs `PK(paper_id,project_key)` collisions — the normal shared-project case); (vi) transfer `paper_aliases` with the same `INSERT OR IGNORE` pattern; (vii) ensure exactly one `is_current=1` doc for B and set `papers.current_doc_id`; (viii) delete A's `papers` row (all children re-pointed; FK CASCADE is the safety net); (ix) write `claims_history('identity_change')` + `events(op='MERGE')`; (x) rebuild FTS. Mandatory for the live twin (`pap_d815e8be560b` DOI vs `pap_491b659c469b` NULL: two rows forever under `UNIQUE(identity_kind,identity_value)`, 24 duplicate claims, shared project). Acceptance: merge the live twin **and** a worst-case pair (both docs current, same sha, **equal `pipeline_version`**, shared project, claims bound via `primary_section_id`/`claim_sources`/`extraction_event_id`, `ah_verdicts` rows on both docs, and at least one duplicate `claim_key` collision between A and B) → exactly one `papers` row, one current doc, one membership, no duplicate chunk texts, every claim preserved with valid backlinks and history, every verdict preserved, and the collision resolved with one `is_latest=1` winner; the structural-mismatch fixture (different `pipeline_version`) aborts with zero mutations. `promote_identity(...)`: unowned → update identity + alias; owned → `identity-conflict` requiring `merge`; `paper_id`, `corpus_path`, ledger `file` never change. Fresh-install test: the §3.1 schema alone works and `add_claim_v2` succeeds with NULL and non-NULL `manuscript_id`. Re-key test: ingest without frontmatter, later declare the DOI → still one paper/doc, `corpus_path` and ledger `file` unchanged.

## 4. Markdown intake pipeline

Hundreds of papers, each supplied as markdown; this replaces `ingest_markdown` (`ingest.py:86-120`). `memoriki` ships zero parsers (`/tmp/r2-digest.txt:33,46`).

### 4.1 `papermemory/markdown_contract.py` — strict, stdlib-only

```python
FRONTMATTER_WHITELIST = {doi:str, arxiv_id:str, pmid:str, title:str, authors:list,
    year:int, venue:str, bibtex_key:str, language:str, origin_channel:str, license:str}
class Refusal(Exception):  # frontmatter-unclosed|-not-at-byte-0|-unknown-field|-nested-value|-type
    def __init__(self, code, detail, *, byte_offset: int | None = None): ...  # |-too-long, decode-not-utf8, newline-not-lf, identity-unresolved, zero-text, scanned-only
def parse_frontmatter(text) -> Frontmatter | Refusal: ...
def resolve_identity(fm, *, doi=None, arxiv_id=None, title=None, year=None, body_text="") -> Identity: ...
def upsert_paper_v2(store, identity, **fields) -> tuple[Paper, str]:   # created|merged|noop
def promote_identity(store, paper_id, kind, value) -> Identity:       # §3.6
def ensure_project(store, key, *, title=None, kind='manuscript', ah_root=None) -> None: ...
```

**Grammar, no YAML.** Block starts at byte 0 with `---`, ends at the next line exactly `---`, ≤80 lines; each line is `key: value` with a scalar, inline list `[a, b]`, or one-level block list `  - item`. `{}`, nested maps, deeper indentation or a second colon raise `frontmatter-nested-value`; wrong type is `frontmatter-type`; an unterminated leading block is `frontmatter-unclosed`, never a partial read. Nested author maps (`authors → ['name: Ashish Vaswani']`, `orcid` taking the second author's value, `/tmp/r2-digest.txt:22`) are a refusal, not `import yaml`.

**Identity.** `doi > arxiv_id > pmid > (title_norm, year)`, declared sources only. Without frontmatter: H1 plus the **first DOI before the first ATX heading** (`markdown.md:3` vs `:216`; a bibliography DOI never identifies the paper), never a stem. `abstract` comes from `sections.is_abstract` or Crossref/arXiv, never `text[:1500]` (`ingest.py:113`; live `pap_d3049216c5a3`). `upsert_paper_v2` is `ON CONFLICT … DO UPDATE`: equal-or-higher precedence only (`frontmatter > crossref/arxiv > h1 > caller`), metadata-only never clobbers full text, `verified` never implicitly downgraded; identifiers append to `paper_aliases`, and a value owned by another row is `identity-conflict` requiring `merge`. `ensure_project` upserts `projects`/`unassigned` in the ingest transaction (`paper_projects.project_key` is a real FK).

### 4.2 `papermemory/structure.py`

`build_section_tree(text)` makes one pass over raw chars: ATX (`#..######`, incl. `## Abstract`), SetExt underlines, `4. Methods` numbering; emits level, `heading_path`, parent, char/line spans, `is_bibliography`, `is_abstract`, `kind`. Baseline: 39 headings vs 2 + a 96,016-char `front` (`/tmp/r2-digest.txt:50`); the keyword heuristic dies, so prose cannot become a heading.

**Section roles (`classify_sections`).** Raw `heading_path` is preserved verbatim; a second deterministic pass assigns each section a canonical `role` from the closed set `{abstract, introduction, background, related_work, method, materials, results, analysis, discussion, conclusion, limitations, appendix, acknowledgements, bibliography, review_body, unclassified}` using ordered phrase rules on the heading (`related work|prior art|literature review` → `related_work`; `method|methodology|approach|materials and methods` → `method`/`materials`; `results?|evaluation|experiments?` → `results`; `discussion|implications` → `discussion`; `conclusions?` → `conclusion`). Combined headings (`Results and Discussion`, `Background and Related Work`) get a primary `role` plus `role_secondary`. Each assignment records `role_source` (`heading_rule | inherited_parent | position_heuristic | none`) and `role_confidence` (0–100); subsections inherit the parent role unless their own heading classifies (`inherited_parent`). A paper with no heading structure (flattened/OCR markdown) gets every section `unclassified` and `structure_confidence='low'` in the outline — **roles are never fabricated from prose**. Roles are derived metadata only: they do not gate claim eligibility (only `is_bibliography`/`claimable` do) and never alter default ranking; `search/get/cite` accept `section_role` as an explicit opt-in filter. The outline also derives `profile ∈ {empirical, review, theory, methods, position}` from role presence (method+results → empirical; `review_body` or no method/result sections + related work → review), with `profile_confidence` — a label for humans and filters, not an assertion about content.

### 4.3 `papermemory/chunker.py`

`chunk_document(text, sections, *, target_chars=2400, min_chars=400, hard_max_chars=6000) -> (chunks, uncovered_spans)`: contiguous `[cs,ce)` inside ONE section, moved only at structural boundaries; text never rewritten (`index_text = normalize(slice)`; stored chunk is offsets only).

- **Tables row-atomic with bound header.** Contiguous `^\|` lines form one `table_block` (repeated `| --- |` rows are one table, `markdown.md:627-631`); each chunk carries `table_id,row_start,row_end,header_span_json`, the header repeats into every continuation chunk, and splits happen **only between rows** — sentence splitting cuts at `Jan.`/`Std.`/`Yes.` and detaches numbers from columns (`/tmp/r2-digest.txt:52`).
- **Fences/math** (```, `\( \)`, `$…$`) are whole claimable slices (`kind='fence'|'math'`); math tokens join the INV-3 probe set.
- **Bibliography** via `References|Bibliography|Works cited` or numbered-reference line density ≥40%; chunks persist with `is_bibliography=1`/`claimable=0`, excluded from extraction and default recall (today another paper's entry is quotable as this paper's result).
- **Figures** resolve through realpath containment in the corpus root **before** any `isfile`/`stat`; unresolvable figures count in `dropped_sections_json`.
- **No silent `chunks[:200]`**: a ceiling sets `capped=1`, `truncation_reason='chunk-ceiling'`, ingest `partial`.

### 4.4 Origin channels

`converter|author-supplied|ocr-recovered|metadata-only|imported-bib|hand-asserted`, stamped at write and inherited by chunks and claims. Converter signals are **inputs** — `ingest_markdown_v2(..., converter={'pdf_type','confidence','pages_needing_ocr'})`, wired from `pdf-to-markdown.js:111-115` via `papermemory-cli.js:424-436`. They persist in `converter_json` and surface as `degradation` in `cite`/`get`/`verify`/ledger; non-empty `pages_needing_ocr` or `pdf_type ∈ {scanned,image-based}` downgrades to `ocr-recovered`, capping claims at `extracted` with `status_reason='channel-capped:ocr-recovered'`.

### 4.5 Re-ingest semantics (content-sha gate, resumable)

`ingest_markdown_v2(store, path, *, paper=None, project=None, origin_channel='converter', converter=None, pdf_path=None, force=False, pipeline_version=PIPELINE_VERSION) -> IngestResult`:

1. Read bytes; strict UTF-8 + LF-only (`decode-not-utf8`, `newline-not-lf`); `sha256`. 2. `WHERE paper_id=? AND sha256=?`: current+same pipeline → `duplicate-noop`; older pipeline → re-derive in place; miss → 3. 3. New `raw_documents` row, old `is_current=0`, `supersedes_doc_id` chain; bytes go to `corpus/<paper_id>/<sha16>.md` with `corpus/<paper_id>.md` refreshed atomically — per-doc addressing is mandatory, or one path overwrites every older doc and live AH binding and `doc-superseded` mimics `raw-file-drift`. 4. Structure → chunks → coverage → extractions; `claim_key` is §7.1's quote-bearing key, so an unchanged quote updates in place and a corrected translation is a new key superseded by the sweep; `project_key` is the ingest's (membership-derived, never NULL) and `paper_projects` rows are added, never replaced.
5. **Changed claim-bearing docs are not rewritten in one transaction.** A `sweeps` row processes batches of 200: claims on a non-current doc → `unverified-quote`/`doc-superseded` (old rows kept, `is_latest=0`), failed quotes → `locator-drift`, each batch commits `cursor`; a killed sweep resumes to the same terminal state, and `reindex --from-raw` reuses the mechanism.
6. Every path returns a typed `IngestResult`; `ok` needs `chunks_created > 0` and `coverage.ratio == 1.0`.

**Page subsets are refused** (`partial-page-subset`): a 3-page excerpt never replaces a 14-page chunk set and lands as `kind='excerpt'`, `cite_state='partial'`. **PDF provenance is a declared sha alias**: `pdf_path` feeds `raw_documents.linked_sha256` and `paper_aliases(kind='pdf_sha256', value=sha)`, so a PDF and its markdown are one paper with one chunk set — the merge path restated under INV-4. A PDF with no DOI/title refuses (`identity-unresolved`) or needs `--assume-identity`.

### 4.6 Coverage accounting (non-contradictory)

One `coverage` row per ingest. `indexed_chars` = chars in ≥1 chunk, *including* bibliography/fence/math/table chunks; `dropped_sections_json` = unresolvable figure spans, excluded from both `indexed_chars` and `uncovered_json`; `uncovered_json` = every non-dropped span with no chunk, **including a capped section's unchunked tail** (the section has chunks, the tail has none; `capped=1`, `truncation_reason='chunk-ceiling'`). So `indexed_chars + Σuncovered == source_chars − Σdropped`; counters never double-count. `reason_code` closed set: `ok, zero-text, scanned-only, decode-not-utf8, newline-not-lf, identity-unresolved, frontmatter-invalid, chunk-ceiling, bibliography-only, partial-page-subset, sha-unchanged, derivation-error, io-error`.

## 5. Retrieval redesign

`search_v2.py` replaces `search.py`; the graph leg is deleted (`upsert_entity` has zero callers, `entities=0`, all 121 relations are `(manuscript,cites,paper)` — `/tmp/pm-digest.txt` RR-7 lines 108-113). **One FTS index exists: `chunks_fts` (§3.2).** Claim/paper legs are scored SQL scans: `claims_fts`/`papers_fts` needed undefined views and a `seq` the base tables lack, and 3.45.3 raises `no such column` / `SQL logic error` on the prescribed sync (both schema reviews).

```python
def search(store, query, *, kind="chunk", project=None, limit=8, per_paper=2,
           require_all=False, claimable_only=True, max_payload_chars=12000) -> dict
```
`kind ∈ chunk|claim|paper|all`; `limit` clamped `[1,50]`. `recency` is deleted (ingest-date decay, 0.17× at 2.5 y, an 8× handicap — RR-6 lines 102-107; no defect asks for a year sort; `access_count` is reporting-only). Three-leg RRF is deleted: `kind='all'` returns per-leg sections under `legs`, not a blended score, so no leg hides a penalty.

### 5.1 One normalizer
`tokenizer.py: normalize(s)` (lowercase/NFKC, quote/dash mapping, stopword strip, unicode61 split) is used by `index_text()` and `query_terms()`; terms are quoted, the dual hyphen variant is deleted (unicode61 already splits `-`/`_`; unquoted `STATE_OF_THE_ART` raised `no such column: of`), and the 12-token cap is gone. This kills the 0.00-vs-1.00 asymmetry (`search.py:183` vs `:198`, RR-5).

### 5.2 Chunk leg — bm25 ordered, filters pushed down
```sql
SELECT ch.id, ch.seq, bm25(chunks_fts) AS rank
FROM chunks_fts
JOIN chunks ch       ON ch.seq = chunks_fts.rowid
JOIN papers p        ON p.id = ch.paper_id
JOIN raw_documents d ON d.id = ch.doc_id
WHERE chunks_fts MATCH :match
  AND ch.is_bibliography = 0 AND ch.claimable = 1
  AND p.cite_state IN ('citable','partial') AND d.is_current = 1
  AND (:project IS NULL OR EXISTS
       (SELECT 1 FROM paper_projects pp
        WHERE pp.paper_id = ch.paper_id AND pp.project_key = :project))
ORDER BY rank ASC
LIMIT :fetch          -- fetch = max(4*limit, 64)
```
Every filter is a real column or indexed membership join, so the SQL result is the scoped candidate set. `fetch=max(4*limit,64)` feeds the per-paper cap only — no 5×/20×/400 over-fetch (400 rows for 8 slots ≈960k chars vs the 12k budget). Membership is `EXISTS`, not UNINDEXED FTS, because membership changes without rewriting chunks (`idx_pp_project`, sub-ms); 300-paper p95 ≤120 ms is asserted **for the scoped variant**.

### 5.3 Claim and paper legs — score all, then slice
```sql
SELECT c.id, c.claim_text, c.status, c.claim_key, c.quote_sha256, c.doc_id,
       p.id AS paper_id, p.title, p.bibtex_key, p.cite_state
FROM claims c
JOIN papers p        ON p.id = c.paper_id
JOIN raw_documents d ON d.id = c.doc_id AND d.is_current = 1
WHERE c.is_latest = 1 AND c.status IN ('extracted','verified')
  AND (:project IS NULL OR EXISTS
       (SELECT 1 FROM paper_projects pp
        WHERE pp.paper_id = c.paper_id AND pp.project_key = :project))
```
The paper leg mirrors this over `papers` with the same membership predicate. Neither has `LIMIT`: every scoped row is scored in Python by `normalize` overlap + contiguous-phrase bonus, sorted `(score DESC, id ASC)`, then sliced; `candidates_scanned` is the scoped row count. This is INV-3 at full strength and the only way `kind='claim'` recall exists — today it returns a bare row with no paper join (`search.py:78-85`, CG-1 line 138).

Rerank uses the whole `index_text`/claim text, never a 400-char prefix (4× swing, RR-4 lines 84-89); table chunks include bound header tokens. `per_paper=2` with backfill; `require_all=True`; `claimable_only=False` explicit. `legs={"chunk":"ok","claim":"ok","paper":"skipped:kind"}`; a failed leg is `error:<code>` and forces `empty_reason='leg-error:<leg>'`.

### 5.4 Typed empties and INV-7 (absence needs a license)
Every result carries `results[]`, `legs{}`, `empty_reason`, `candidates_scanned`, `corpus_match_count`, `filters_applied`, `suppressed{non_claimable,bibliography,chunkless_papers,uncovered,superseded_claims}`, `coverage{capped_docs}`, `absence_scope`, `scope`, `truncated`.

- `corpus_match_count` is **untruncated** `SELECT COUNT(*) FROM chunks_fts WHERE chunks_fts MATCH :match` (no joins/LIMIT), emitted even with results; for claim/paper legs it is scoped rows with `score>0` — never the fetch/slice count. Each chunk-backed `suppressed` class (`bibliography`, `non_claimable`, `superseded_claims`) is a `COUNT(*)` over the same MATCH with one filter flipped; `chunkless_papers` and `uncovered` have no `chunks_fts` row and are counted from base tables — an in-scope current paper with no `chunks` row whose raw text or bibliographic fields contain the phrase, and `coverage.uncovered_json` spans whose `substr(raw.text, cs+1, ce-cs)` contains it (`instr`/`LIKE` after `normalize`, never FTS).
- `empty_reason` is the single closed set of §1, in precedence order: `project-not-found`, `leg-error:<leg>`, `all-suppressed:bibliography`, `all-suppressed:non-claimable`, `all-suppressed:chunkless-paper`, `all-suppressed:uncovered-span`, `all-suppressed:superseded-claim`, `absence-not-licensable`, `no-match-in-project`, `no-match`; `no-match-in-project` = global count > 0, scoped count = 0.
- **INV-7:** absence is licensed only when every leg inside `absence_scope` is `ok` (legs outside it are `skipped:kind` and named; `absence_scope` = `chunk-text` for `kind='chunk'`, `claim-text` for `claim`, `paper-metadata` for `paper`, `all-legs` for `all`, so a chunk search licenses no claim/paper absence), `corpus_match_count==0`, every `suppressed` class is 0 (including non-FTS `chunkless_papers`/`uncovered`), and `coverage.capped_docs==0` (the envelope counts in-scope current docs whose coverage row has `capped=1`); otherwise the payload names the suppression and gives a `hint`. `absence_licensed(result)` is one exported predicate used by `prompt.js`/`SKILL.md`; negative tests seed a term only in a bibliography chunk, only in a chunkless paper, only in an uncovered span — each must return its distinct reason, never `no-match`.

### 5.5 Byte-slice snippets and budget
`snippet = raw_text[cs:ce]` windowed on the match; hits carry spans, `slice_sha256`, `heading_path`, table locators, paper identity, `degradation` — never `substr(text,1,400)`, never frontmatter. `max_payload_chars=12000` drops whole hits and sets `truncated`+hint; `limit=1000` → `budget-exceeded`; a 300-paper payload ≤12k is a Phase 3 acceptance.

### 5.6 Enforcement and performance tests
- `inv3_ast_guard.py` parses `papermemory/*.py` with `ast` and asserts every `SELECT` containing `LIMIT` has a governing `ORDER BY` in the same statement node. Exemptions: keyset `list`/`get` (§9), `ORDER BY recorded_at DESC LIMIT 1` (§3.4), FTS `optimize`, `--tail`, `COUNT(*)`. Line grep cannot associate clauses across lines and fires on §5.2 itself.
- 300 papers, 20 probes (including `f_beta`, `$R^2$`): top-N equals true bm25 top-N without LIMIT; scoped p95 ≤120 ms; ranking invariant under 100× `access_count`; `COUNT(chunks_fts)==COUNT(chunks)` after insert/delete/rebuild.

## 6. Scoping model

- **Projects are written, not assumed.** `scope.py: ensure_project(store, key, *, kind='manuscript'|'unassigned', title=None, ah_root=None)` runs `INSERT … ON CONFLICT(key) DO UPDATE` **inside the ingest/claim `store.mut()` transaction**. §3.1's FKs (`paper_projects.project_key`, `claims.project_key`) then cannot fail on a first scoped ingest, and a typo cannot become free text. `unassigned` is inserted by migration.
- **One slug source.** `canonical_project_slug(cwd_or_root, *, project=None, ah_project=None)` resolves: explicit `project`; `ah.yaml` near cwd → its manuscript slug (validate `ah_root`; unreadable → `Refusal('project-unresolved')`, never a silent bucket); a `manuscripts` row whose `root_path` = cwd → `manuscripts.slug`; else `unassigned`. Only generator: `util.slugify`. `projectSlugFromCwd` (`papermemory-cli.js:335-340`) is retired for writes; the plugin passes `cwd`, Python resolves — removing the cwd-vs-manuscript slug split (SCP-6 lines 270-275).
- **Membership is add-only.** A second project ingesting a known paper adds a `paper_projects` row. `papers.project_id` is backfilled by the Phase 3 migration then dropped; acceptance asserts `COUNT(paper_projects)==COUNT(legacy papers with non-null project_id)` and an unchanged `cite_check` key set.
- **Claims have deterministic scope.** `claims.project_key TEXT REFERENCES projects(key)`; pmv2 rows never NULL. Extraction derives it from the paper's primary membership (earliest `first_seen`) in the ingest transaction; an agent claim resolves `project` or the paper's primary. **The claim-leg predicate is membership (§5.3)**, not the scalar; `project_key` only lists/denormalizes. `OR project_key IS NULL` is forbidden in `search`, `recap`, `list`, `cite` — the convicted "global rule enters every project" shape (`context.py:67`, CG-9).
- **One project rule per tool.** `search/cite/get/recap/list/trace` take optional `project`; omission is visible global mode: `scope:{project:null,mode:"global",unassigned_count:N,warning:…}`. `ingest`/`claim` resolve (or `unassigned`) and never write scope-free rows. `cite_check` **requires** a manuscript root and derives its project from `manuscripts` — never global; `register_to_ah` requires a project. `prompt.js:107`/`SKILL.md:23` become "pass `project`, or omit it and read `scope.mode`".
- **Stats split and unassigned visible.** `recap`/`list` return `scope_stats` (project-filtered) and `global_stats` (measured: recap('thread-b') reported 360 papers while thread-b owned 60 — SCP-7); `scope_stats` includes coverage/cite_state/chunkless/claim counts, so the first call cannot hide distrust data. `list(project='unassigned')`, a catalog section and `scope.unassigned_count` make routing failure a counted bucket (memoriki antiPattern, `/tmp/r2-digest.txt` line 32).

## 7. Claim lifecycle & grounding tools

### 7.1 Write path: offsets and one verbatim store (INV-1 decidable)
```python
def add_claim_v2(store, *, text, asserted_quote, paper_id, project_key=None,
                 chunk_ids=None, claim_type='finding', manuscript_id=None) -> ClaimResult
```
`asserted_quote` is required (`quote-required` otherwise) and stored **only** as `claims.asserted_quote` — caller wording, never evidence. `quote_check` locates it in `raw_documents.text` and returns `quote_char_start/end`; `quote_sha256 = sha256(raw_text[qcs:qce].encode())` comes from that slice. `claims` stores offsets + `quote_sha256` + `asserted_quote`, **no `evidence_quote` column**; reads materialize `substr(r.text, quote_char_start+1, quote_char_end-quote_char_start)` (SQL, 1-based) or `raw[qcs:qce]` (Python, 0-based half-open — the convention §3 declares). Normalize-equal but byte-different → `unverified-quote` + `status_reason='asserted-quote-differs'` + diff; no match → `Refusal('quote-not-verbatim')`, no row. INV-1 is scoped to `pipeline_version>='pmv2'` rows (legacy `provenance_basis='normalized-v1'` excluded, §3.6); `test_inv1` asserts only what the write path guarantees: every stored span re-slices to `quote_sha256`, and no quote copy exists.

**Stable identity.** `claim_key = sha256(paper_id|sha256(normalize(claim_text))|quote_sha256)[:16]`; `id = 'clm_'+sha256(claim_key|doc_id|extraction_event_id)[:12]`. §3 adds `claim_key NOT NULL` + `CREATE UNIQUE INDEX uq_claim_latest ON claims(claim_key) WHERE is_latest=1`; re-derivation hits `ON CONFLICT(claim_key) WHERE is_latest=1 DO UPDATE SET claim_text=excluded.claim_text, claim_text_norm=excluded.claim_text_norm, doc_id=excluded.doc_id, primary_section_id=excluded.primary_section_id, quote_char_start=excluded.quote_char_start, quote_char_end=excluded.quote_char_end, quote_line_start=excluded.quote_line_start, quote_line_end=excluded.quote_line_end, quote_sha256=excluded.quote_sha256, source_sha256=excluded.source_sha256, origin_channel=excluded.origin_channel, extraction_event_id=excluded.extraction_event_id, pipeline_version=excluded.pipeline_version, status='unverified-quote', status_reason='re-derived', updated_at=excluded.updated_at` instead of a twin — D8 closed at the constraint.

**Status ladder.** `unverified-quote → extracted → verified`, plus `superseded`/`contradicted`. `verified` is assigned **only** by a passing byte re-slice (deterministic, model-free); AH verdicts never grant it (§8.3), and a model can only downgrade (`NOT_SUPPORTED`/`NOT_IN_SOURCE` → `contradicted`). **Channel cap:** when the claim's doc is `origin_channel='ocr-recovered'`, the ladder stops at `extracted` with immutable `status_reason='channel-capped:ocr-recovered'`; no re-slice, `rebind`, or verdict may assign `verified`, and `verify_claim` step 11 re-asserts the cap. `actor` is transport-bound (MCP ⇒ `agent`, CLI/owner ⇒ `owner`), never an argument; the agent's `status` is ignored (`mcp_server.py:191` deleted). One shared predicate gates every citable enumeration: `status IN ('extracted','verified')` AND paper `cite_state IN ('citable','partial')`; a `contradicted` claim is absent from `list` too, asserted by the negative test.

```python
def quote_check(store, *, quote, paper_id=None, chunk_id=None, doc_id=None, max_matches=20) -> QuoteCheck
```
Chunk-index-first: FTS phrase probe over `chunks.index_text` of the candidate doc, then the decisive exact substring scan of that doc's `raw_documents.text` (≤~400 KB). Returns `{found, occurrences:[{chunk_id,char_span,byte_span,heading_path,is_bibliography,snippet}], reason:''|'no-match'|'bibliography-only'|'identity-mismatch', checked_against{sha256,doc_id}}`; never an FTS-OR hit as proof (D6, CG-4 lines 154-159). Stops at `max_matches`; p95 ≤50 ms/doc at 300 papers is in `test_scale.py` (worst case one doc, not the 117 MB corpus).

### 7.2 Lifecycle events and the resumable sweep
```python
def supersede_claim(store, claim_id, *, by_claim_id=None, reason, actor) -> None
def contradict_claim(store, claim_id, *, evidence_claim_id=None, ah_verdict=None, reason, actor) -> None
def rebind_claim(store, claim_id, *, new_doc_id) -> QuoteCheck
```
Each writes one `claims_history` row and flips `is_latest`/`status` in the same `store.mut()` transaction; old rows stay readable and leave every citable enumeration. No hard delete (supersede with `reason='retracted'`; history never purged). Jaccard advisory: same-paper `>0.9` supersedes keep-newer, `0.4–0.9` returns `similar_to[]`, zero mutation; no LLM.

**Doc-supersede sweep is batched and resumable.** `supersession_sweep(doc_id)` uses §3.1's `sweeps` row `{kind:'doc_supersede', cursor:last_claim_seq, total, state}`: select next 200 claims on non-current docs for this paper with `seq>cursor`, mark `unverified-quote/doc-superseded` + `is_latest=0` (or `locator-drift` when `quote_check` under the new doc fails), write history, advance cursor, commit. Killed mid-run, the next call resumes; the terminal state is idempotent. `reindex --from-raw` reuses `kind='reindex'`. `rebind_claim` promotes to `extracted` only when the quote re-lands byte-exact; `health` lists stranded claims.

### 7.3 Enumeration, catalog, one ledger, ops
- **`list`** (filters `project,status,cite_state,claimable,since`; keyset over `chunks.seq`/`claims.id`, `page_size≤200`, `total_count`) fixes "nothing is enumerable" (PS-1); a paging test asserts two pages equal one unbounded read. **Catalog** `corpus/CATALOG.md|.json` per project is generated from rows; never a count source.
- **One ledger.** Every mutator calls `store.mut(op, **ids)` — the only writer — which opens `BEGIN IMMEDIATE`, runs exactly one mutation + one `events` row, commits; an exception rolls back both. `MUTATORS` is an explicit registry; a test iterates it, injects failure into each, and asserts one events row on success / zero after rollback. `audit` is **retired as a table and re-created as a view over `events`** (`operation=lower(op)`, `target_type`, `target_id=coalesce(claim_id,paper_id,doc_id)`, `detail=reason_code||detail`, `created_at=ts`): legacy readers work, one ledger.
- **Disjoint vocabularies.** `events.op ∈ {INGEST, DERIVE, INDEX_REBUILD, CLAIM_WRITE, CLAIM_TRANSITION, DOC_SUPERSEDE, IDENTITY_PROMOTE, PROJECT_ENSURE, AH_REGISTER, LEDGER_EXPORT, VERDICT_IMPORT, MIGRATION, SWEEP, MERGE, BIND, REPAIR, DELETE, CITE_CHECK, REMEMBER, LESSON_WRITE, MANUSCRIPT_WRITE}`; `claims_history.event ∈ {create, status_change, supersede, contradict, rebind, identity_change}`. No string occurs in both. `claims_history` owns state transitions, `events` operations; a supersession writes `CLAIM_TRANSITION` + `claims_history('supersede')`. Every writer listed in §3.1 is covered: `cite_check`→`CITE_CHECK`, `remember`→`REMEMBER`, `lesson`→`LESSON_WRITE`, and `manuscript_sections`/`contributions`/`terminology`/`reviewer_comments`→`MANUSCRIPT_WRITE`; `MUTATORS` names one op per writer and `test_audit_mutators` fails on any writer absent from the enum.
- **Log.** One fixed-prefix line per event to `events-YYYYMM.jsonl` (`2026-10-22T14:03:11Z INGEST | paper=… status=partial reason=chunk-ceiling chunks=214`); DB keeps 90 days, JSONL is the archive; never read for dedupe (`/tmp/r2-digest.txt` ANTI line 59). Ops are CLI-only: `backup --to`, `export --format jsonl|sql` with leading `{"kind":"header","schema":"pm-2","pipeline_version":…}` (restore refuses mismatch), `restore`, `vacuum`+`optimize`, `health`, `reindex`, `repair --rederive`, `migrate`, `log --tail`, `catalog`. `Store.__init__` only validates `user_version` and refuses `schema-too-new`; migration is the explicit CLI (§3.6/§10), which owns `executescript`'s implicit commit and `PRAGMA foreign_keys` outside `BEGIN`.
- **Health** (single SQL, ids + closed reasons): claims on a non-current doc; `ah_verdicts.raw_sha256` ≠ claim doc sha; duplicate current docs; duplicate latest claims; `project_key` with no `projects` row; `chunks.paper_id`/`extractions.paper_id` ≠ `raw_documents.paper_id`; FTS/base count mismatch; pmv2 span that fails re-slice.

## 8. Academic Harness bridge (the D-seam)

Two stores, zero shared state (AH-1 lines 298-303: `registry.py:30-34`, `index.py:161-174`, `t3_evidence.py:47-59`, `academic-harness.js:122-143`). The bridge is a **file + content-hash bound ledger**, never a cross-venv import.

### 8.1 The ledger
`export_evidence_ledger(store, *, project_key, out_path=None)` writes append-only JSONL at `~/.local/share/papermemory/evidence/<project_key>.jsonl` (override `PAPERMEMORY_EVIDENCE_DIR`), schema `pm-evidence-1`:

Each row: `schema:"pm-evidence-1"`, `claim_id`, `doc_id`, `paper_id`, `raw_sha256` (full), `sha16`, `ah_sha16`, `file`, `ah_file`, line/char spans, `quote_sha256`, `quote_hash`, `clause_hash`, nullable verdict fields. AH's `bind_passage` imports the row and writes a sidecar binding storing `claim_id`, `doc_id`, `sha16`, `quote_hash` and `unit_ref`; **A4/A5 requires the sidecar to persist the full ledged row** (full `raw_sha256`, doc `sha16`, char/byte spans, `quote_sha256`), not only `sha16` — otherwise §8.3's `stale-verdict-sha` is a re-resolved tautology rather than a bind-time check. That binding is the `clause_hash`/`cid`→`claim_id` map (AH's own `cid = sha1(unit_ref|clause|keys,12)` is stored alongside), so `ah evidence export --ledger` echoes those columns and `import_verdicts` resolves `doc_id` from `claim_id` and re-checks it.

**Join key is content hashes only:** `(paper_id, raw_sha256, quote_sha256, ah_sha16)`. `file`/`ah_file` are payload, never keys (INV-4 bans paths; the rel-vs-abs split is a verified defect, `/tmp/r2-digest.txt` line 9; AH stores `file` relative to the project, `claim_sidecar.py:124`). Row id = `sha256(paper_id|raw_sha256|quote_sha256|ah_sha16)`; unchanged re-export appends nothing. `quote_sha256` is raw; `quote_hash`/`clause_hash` use AH's recipe:

```python
s  = re.sub(r"\s+", " ", raw[qcs:qce]).strip()      # bind_passage collapse, claim_sidecar.py:121
q6 = s[:600]                                         # claim_sidecar.py:125
quote_hash  = sha1(norm_text(q6), 10)                # util.py:11-13; verify.py:25-30
clause_hash = sha1(norm_text(re.sub(r"\s+"," ",claim_text).strip()[:600]), 10)
```
`norm_text` maps quotes/dashes, strips `* _ \` ``, collapses whitespace, lowercases. Both sides truncate to 600 **after** collapse, so 599/600/601/5000-char quotes join; the ledger test round-trips all four and asserts both hashes and the join.

**File mapping.** Memory keeps `corpus/<paper_id>/<sha16>.md` (content-addressed; `corpus/<paper_id>.md` is a managed current copy) and hands AH that path; AH copies to `sources/files/<paper_id>.txt`, recorded as `ah_file`/`ah_sha16`. Import/registration re-asserts `sha256_file` against the doc the claim points at.

### 8.2 memory → `ah_source` registration
`register_to_ah(store, *, paper=None, project=None, all_citable=False, ah_root=None, dry_run=False) -> HandoffResult`

1. Resolve the current RAW doc and content-addressed path; no RAW file (legacy 121 chunkless; 11 of 13 PDFs deleted) → `Refusal('no-raw-file')`, not `locator-drift`.
2. **AH id is `paper_id`; citation keys are registered as aliases.** `paper_id` stays the registry id because `bibtex_key` is not UNIQUE (`idx_papers_bib`; §9 indicts `db.py:397-400`) and AH's registry is `{s["id"]:s}`, so two author-year shortcuts would collapse into one source and T3 would bind the wrong text. But AH resolves `\cite{key}` by citation key (`sources/registry.py:155-160`; `t2_bib.py:39-44`), so registration must also pass the paper's keys: `--keys <bibtex_key>[,<alias>…]` (AH item A5). The registry entry carries `keys: []`, and `resolve_all`/BIB-02 consult it alongside `id`. Keys are unique within one manuscript `.bib`, so aliases cannot collide across projects; a paper registered in two projects mirrors its keys per project. No key and no DOI → the entry registers but resolves nothing; BIB-02 then fires correctly instead of silently passing. Absent `--doi/--title/--year` are omitted (mirror `lookup_cite`'s no-fabrication rule).
3. Shell out `ah source add <corpus_path> --id <paper_id> --keys <bibtex_key[,alias…]> [--doi …] [--title …]` via `academic-harness.js:128-139`; read back `sources/registry.yaml` and assert `resolve_all(project, <bibtex_key>)` returns the registered file. Phase-5 acceptance runs `ah check --evidence` on a seeded `\cite{key}` for both a DOI and a no-DOI paper: a T3 verdict is produced and no BIB-02 is raised.
4. `handoff_state ∈ {byte-identical, text-equivalent, locator-drift}`: equal sha = byte-identical; sha differs but the quote re-slices out of AH's copy = text-equivalent; else locator-drift and **verdict linkage is refused**. (`text-equivalent` exists because AH's `to_text` does `read_text(errors="replace")`+`write_text`, `registry.py:43-69`; §8.4 removes it.)
5. On success write no `ah_binding_ref` (source add creates no AH clause binding); `claims.ah_binding_ref='<unit>#<claim_id>'` is written by `bind` and by `import_verdicts` for each binding the export reports, in the same `store.mut()` transaction (indexed by §3.1; today read by §3.3/§3.4, written by nothing in v1). Return `{registered, ah_sha16, handoff_state, ledger_rows_written, already_registered}` + one `AH_REGISTER` event. Batch `all_citable=True` replaces per-paper manual registration (AH-4, `cli.py:752-763`).

### 8.3 verdict → memory, in the right order
`import_verdicts(store, path=...)` reads AH's export (`ah evidence export --ledger`, §8.4). **Run `supersession_sweep` to completion first**, then import. Every row requires `verdict.raw_sha256 == claim doc sha` and `verdict.doc_id == claim.doc_id`, else `Refusal('stale-verdict-sha')` (typed, counted, never dropped) — a verdict from the old file cannot re-promote a claim after a corrected re-ingest.

Mapping, no model-granted upgrade: `SUPPORTED` → `ah_verdicts` row, **status unchanged**; `PARTIAL`/`CONTESTED`/`ERROR` → record + `status_reason='ah:<verdict>'`, status unchanged; `NOT_SUPPORTED`/`NOT_IN_SOURCE` → `contradicted` + reason. `ah_verdicts` carries `doc_id, raw_sha256, char_start, char_end, quote_hash` (§3.1), anchoring the verdict to the judged text. Each import writes `claims_history('status_change')` with the ledger sha, so "what did memory assert on date X" is answerable.

### 8.4 AH-repo policy items (in `raktim-mondol/academic-harness`)
- **T3 deterministic half in the gated default** (EVD-02 numbers, EVD-05 quote; EVD-01 stays advisory with `backend is None` keeping the model out): `base.py:82`, `hooks.py:62`, `t3_evidence.py:61-74`.
- **BIB-02 major on an empty registry with `\cite` keys** (today the block is skipped and an unregistered project gets PASS): `t2_bib.py:39-44`; `migrate.py:243`.
- **EVD-04 `info` → `major` when evidence gating is on** (`no_source` `continue`s before any check): `t3_evidence.py:51-59`; `base.py:45`.
- **Byte-copy `.md` sources** in `add_source` (no `errors="replace"`, no newline translation), making `byte-identical` real (`registry.py:43-69`).
- **Accept char/byte spans + `quote_sha256`** in `bind_passage`, import `pm-evidence-1`, echo `quote_hash`/`clause_hash` on bind; table claims bind a span including the header (`header_span_json`), asserted by fixture (`claim_sidecar.py:105-125`; `t3_evidence.py:61-74`).
- **Registry key aliases (A5).** `add_source --keys`, registry entries carry a `keys` list, and `resolve`/BIB-02 consult `keys` alongside `id` (`registry.py:30-34,55-69,155-160`; `t2_bib.py:39-44`) — so `ah source add <path> --id pap_… --keys smith2020` resolves `\cite{smith2020}` while keeping ids collision-free.
- **A memory `contradicted` claim is an open major** for the bound clause (`claim_sidecar.py:83-88`).
- **`ah evidence export --ledger`** emitting memory `claim_id`, `doc_id`, full `raw_sha256`, doc `sha16`, AH `cid`, `unit_ref`, spans and `quote_hash`, joined from the sidecar binding written at bind time (§8.1): §8.3's producer does not exist (`ledger/db.py:16-31`; `verifier/verify.py:106-121`).

Closure needs both this anchored verdict and §8.2's byte-identical registration: a quote that still re-slices, numbers present in the bound passage with its header, and a `NOT_SUPPORTED` that flips memory to `contradicted` and removes it from every citable enumeration.

## 9. MCP tool surface

9 today → **13**: `search, ingest, get, cite, cite_check, remember, claim, recap, lesson, quote_check, trace, list, register_to_ah`. `verify`+`health` become `trace` (§3.3 walk + §7.3 invariants); `coverage` becomes `list(kind='coverage')` plus the envelope every ingest/cite/get carries. MCP `trace` is distinct from CLI `verify` (DOI lookup), renamed `lookup`; `doctor --schema` prints DB path, `user_version`, sqlite version, importing module/version, other DB PIDs. Every tool returns `schema:"pm-2"`, `scope{project,mode,unassigned_count,warning?}`, `legs`/`empty_reason`, `coverage`, `truncated` where relevant.

**Errors (all tools).** `_err(msg,code)` → `{"content":[{"type":"text","text":json.dumps({"error":…,"code":…,"hint":…})}],"isError":true}`; `_call` moves `Store()` inside `try` and wraps `run()`'s dispatch so no tool error kills the child (`mcp_server.py:137-139`, `:251-291`, `:133-134`). Closed codes: `store-unavailable, schema-too-new, not-a-project, project-unresolved, out-of-scope, identity-unresolved, frontmatter-invalid, decode-not-utf8, newline-not-lf, zero-text, partial-coverage, quote-not-verbatim, locator-drift, stale-verdict-sha, no-raw-file, claim-not-found, unsupported-path, path-escape, budget-exceeded, absence-not-licensable, unknown-tool`.

**Path sandbox.** `sandbox.py: resolve_in_root(raw,*,roots)` realpath-resolves and containment-checks **before any `isfile`/`stat`/`read`**, raising `path-escape`; roots = corpus dir, session workspace, `$DSH_HOME/papermemory`; covers every path argument (`ingest.path/pdf_path`, `cite_check.manuscript`, `register_to_ah.ah_root`, `export.out_path`, `trace --raw-file`).

| Tool | Delta / payload |
|---|---|
| `search` | `kind:chunk|claim|paper|all`, `+project`, `+per_paper=2`, `+require_all`, `+claimable_only=true`, `+section_role[]`, `+max_payload_chars=12000`; `limit` clamp `[1,50]`. `{results[],legs{},empty_reason?,candidates_scanned,corpus_match_count,suppressed{},coverage{capped_docs},absence_scope,scope,truncated}`; chunk hits add spans, `slice_sha256`, `heading_path`, `section_role`, table locators, `origin_channel`, `degradation`. |
| `ingest` | `+origin_channel`, `+converter{pdf_type,confidence,pages_needing_ocr}`, `+pipeline_version`, `+force`. Metadata-only → `cite_state:'chunkless'`, `assertion_level:'identifier-only'`. `{status,reason_code,paper,doc{sha256,corpus_path},coverage{indexed_chars,ratio,uncovered[],capped},chunks_created,claims_created,degradation,sweep}`. |
| `get` | `key` or `chunk_ids[]`, `+project`, `+section`, `+section_role[]`, keyset `+cursor`, `+max_chars=12000`; totals + `truncated`; claims carry `claim_text, asserted_quote, evidence_quote(materialized), status, status_reason, quote_sha256, doc_sha16, heading_path, section_role, origin_channel, ah{}`. No `LIMIT 40`/400-char prefix (4.2%, `mcp_server.py:164-172`); no ranking bump. |
| `cite` | `+project` optional with `scope.mode` warning, `+min_claims=0`, `+section_role[]`; `{paper, cite_state, coverage_ratio, matching_chunks[{id,heading_path,section_role,char_span,table locators,verbatim}], claims[{id,status,status_reason,quote,quote_sha256,heading_path,section_role,origin_channel,doc_sha16}], degradation{pdf_type,confidence,pages_needing_ocr_count}, supports_statement}`; chunkless rows are non-supporting. |
| `outline` | Read-only; `key` (paper id / DOI / bibtex_key) or `+project` list, `+sections=true`. Returns `{paper:{id,doi,title,year,source_filename,corpus_path,origin_channel,cite_state}, doc:{sha256,sha16,pipeline_version,provenance_basis}, structure:{headings,structure_confidence,profile,profile_confidence}, sections:[{id,ord,level,heading_path,role,role_secondary,role_source,role_confidence,char_span,line_span,is_bibliography,is_abstract,chunk_count,claim_count,claimable}], coverage}`. Derived on read from `sections`+`raw_documents` — no second source of truth; `source_filename`/`corpus_path` are payload for human backtracking, never join keys. |
| `cite_check` | Pool = `paper_projects` membership only (kills `citations.py:49-52` global leak); `project` required via `manuscripts`. Per-key claims bound/unbound/contradicted, `cite_state`, `quote_verified`; writes `citations(manuscript_id,bibtex_key,paper_id,tex_file,tex_line,sentence_hash,scanned_at)` with `ON CONFLICT(manuscript_id,tex_file,tex_line,bibtex_key) DO UPDATE SET paper_id=excluded.paper_id, sentence_hash=excluded.sentence_hash, scanned_at=excluded.scanned_at`, resolving `paper_id` to the unique in-project `bibtex_key` (unmatched/ambiguous → NULL + `unresolved_citation` health row), so `trace --paper`'s reverse hop is real. Persistence goes through `store.mut('CITE_CHECK', …)` — the `citations` upsert and its event commit in one transaction (§3.5). `{cited_keys,missing_from_memory,unverified_cited,in_memory_uncited,claim_gaps[{key,sentence_line,missing}],locators_persisted}`. |
| `remember` | Forwards `paper_id`/`manuscript_id` (today dropped → NULL, `mcp_server.py:75-87`/`:177-181`); `origin_channel='hand-asserted'`; `+status,+superseded_by,+updated_at`; concepts stop entering the FTS `title` column (`db.py:651`). |
| `claim` | `asserted_quote` required, `+quote_span`, `+chunk_ids`, `+project`; `status` ignored. `+action:'supersede'|'contradict'|'rebind'|'bind'` with `target_claim_id`; `bind` sets `ah_binding_ref`. Returns `{claim,quote_check,status,similar_to[],deduplicated}`. |
| `recap` | Per-section budgets + total `max_chars`; **claims windows** filtered by `paper_projects` membership (never `OR project_key IS NULL`); stable/volatile blocks for caching; manuscript dumps out of the top window (`ingest.py:233-245`); `scope_stats` + `global_stats`; typed empties. |
| `lesson` | `+updated_at,+superseded_by,+status,+paper_id`; `project_key NOT NULL` (a "global" rule belongs to `unassigned`, ending `WHERE project_id=? OR project_id IS NULL`, `context.py:66-70`); `action:'supersede'`; listable via `list(kind='lessons')`. |
| **`quote_check`** (new) | `(quote, paper?, chunk?, doc?, max_matches=20, project?)` → `{found, occurrences[{chunk_id,char_span,byte_span,heading_path,is_bibliography,snippet}], reason, checked_against{sha256,doc_id}}`. The tool `SKILL.md:87`/`prompt.js:111` assumed. |
| **`trace`** (new) | `(claim_id|paper_id|project, mode='walk'|'invariants')` → §3.3 walks (`walks[],failures_by_reason{}`) or §7.3 SQL invariants with violating ids; `paper_id` also returns the `paper → raw_documents → claims → citations → tex_file:tex_line` hop from §3.4's `citations` query. |
| **`list`** (new) | `(kind ∈ papers|claims|chunks|coverage|projects|lessons|citations, project,status,cite_state,claimable,since,cursor,page_size≤200)` → rows + `total_count` (citations scope through `manuscripts`); `kind='coverage'` returns per-doc chars/ratio/uncovered/capped/truncation/section/table counts + roll-up + `chunkless_papers[]`. Keyset, not OFFSET. |
| **`register_to_ah`** (new) | `(paper?|project, all_citable?, ah_root?, dry_run?)` → §8.2 `HandoffResult`; refuses `no-raw-file` for legacy rows rather than `locator-drift`. |
| *(CLI only)* | `backup/export/restore/vacuum/reindex/repair/migrate/log/catalog/health/doctor --schema` — ops stay off the agent surface. |

`TOOLS` (`mcp_server.py:16-126`) gains four entries and loses none; the NDJSON framing patch moves upstream unchanged.

## 10. Migration & rollout phases

**Corpus assumption.** One `.md` per paper; scale fixture 300 (§11). Order is fixed: identity → byte-slice chunks → quote verification → retrieval → AH registration. Every phase opens with `doctor --schema`. **Phase 0.0, before code changes:** `sqlite3 .backup` of the live DB plus `-wal`/`-shm` copies and a recorded sha256.

### Phase 0 — Safety net, audit, provenance (2–3 days)
**Changes.** (1) `MIGRATIONS: list[(version, sql, fn)]`; `Store.__init__` **validates only** — reads `user_version`, refuses higher (`schema-too-new`) and below the runtime floor (`sqlite3.sqlite_version >= 3.43`, typed `store-unavailable`); migration is the explicit CLI `papermemory migrate` (single-writer lockfile, `PRAGMA wal_checkpoint(TRUNCATE)`, refuse if another PID holds the DB, per-statement `execute()` with explicit BEGIN/ROLLBACK — never `executescript`, which implicitly commits and leaves half-applied DDL; `foreign_keys=ON` set before BEGIN). (2) `Store()` moves inside the try; `_err` sets `isError`; `run()` gets a per-message boundary and SIGTERM→SIGKILL escalation. (3) **Audit is folded into a view over `events`**: one row per mutation, written by `store.mut()` in the same transaction as the row it describes; `MUTATORS` is an explicit module registry (today `audit` covers 4 of 13 paths — `db.py:375/454/563/652`; merge `:333-357`, `replace_chunks :412-429`, `add_relation :476-514`, sections/contributions/term/comment `:576-630`, lessons `:656-665` write none; live orphan `aud_5a4ddbec518d`). (4) `events-YYYYMM.jsonl`; `backup|export|restore|vacuum|health-lite`; export begins `{"kind":"header","schema":"pm-2","pipeline_version":…}` and `restore` refuses a mismatched header. (5) `doctor --schema` prints DB path, `user_version`, sqlite version, importing module path/version, other PIDs holding the DB. (6) **Provenance re-pin:** `SOURCE.txt` → `914c2b3` / `v0.1.1`, exception list emptied (both DSH edits are upstream in `d7dd106`), vendored `pyproject` → 0.1.1.
**Files.** upstream `db.py`, `mcp_server.py`, `cli.py`, new `ops.py`/`audit.py`; plugin `papermemory.js` (corpus/evidence env), `papermemory-cli.js` (`BUNDLE_REV`).
**Acceptance.** kill -9 mid-ingest ×4 → `integrity_check ok`; poisoned DB answers every queued request `isError:true` with the child alive; backup/restore sha+count equality; export-header round-trip and mismatch refusal; **`MUTATORS` test** — one `events` row per mutation, zero after rollback; `doctor --schema` reports `0.1.0+dsh2`/`user_version=0`.
**Rollback.** Additive; `git revert` plus `rm -rf $DSH_HOME/papermemory/.venv` and the `installed-version` stamp (reverting the tree alone leaves the stamp equal, so the pip-installed v2 keeps running).

### Phase 0b — Rollout guard on the old release line (1 day, before Phase 1)
**Changes.** Backport a `user_version>=2000` refusal into 0.1.x and install it everywhere first; `uv venv --clear` (plain `uv venv` exits 2 on an existing venv; `papermemory-cli.js:243` passes no `--clear`); post-install `papermemory version` assertion; compare `MIN_PAPERMEMORY_VERSION` (inert today, `:68,70`); refuse the PATH fallback for writes, version-gate it for reads. **Acceptance:** v1 binary on a v2 store fails with `schema-too-new`, not `no such column: chunks.text`; a Content-Length-only PATH binary is detected; reinstall on an existing venv exits 0. **Rollback:** revert the refusal.

### Phase 1 — Identity, RAW, legacy strata, manuscripts (1.5 weeks)
**Changes.** (1) **Rebuild, not ALTER:** the live `papers` cannot take NOT NULL/UNIQUE columns (`Cannot add a NOT NULL column with default value NULL`; `ADD CONSTRAINT` is a syntax error), so this is a numbered create-new → `INSERT…SELECT` → `DROP` → `RENAME` in FK order (`projects`+`unassigned` → `papers` with `paper_projects` backfilled from the pre-rename `project_id` → `raw_documents` → `sections` → `chunks` → `claims`), `foreign_keys=OFF` outside the txn, `foreign_key_check` before COMMIT, indexes/FTS recreated after rename, `current_doc_id` added via `ADD COLUMN … REFERENCES raw_documents(id)` only after `raw_documents` exists. Fresh installs run the same list from a v1 baseline script, so `manuscripts`, `manuscript_sections`, `contributions`, `terminology`, `reviewer_comments`, `lessons`, `observations` exist before `claims` references them. (2) **Legacy strata, no fabrication:** each migrated doc gets `provenance_basis ∈ {verbatim, normalized-v1, none}` — no `corpus/`, 11/13 source files gone, `chunks.text` whitespace-normalized; the measured 12/125 unanchored claims become `unverified-quote`/`no-source-text`, the 113 normalized hits are exempt from `raw-file-drift`/AH registration. (3) Strict flat stdlib frontmatter grammar (nesting refused), one `upsert_paper_v2`, `paper_aliases`, **`promote_identity`** and **`papermemory merge --from --into`** (alias transfer, project union, claim re-key, `claims_history('identity_change')`, FTS rewrite); the live twin is merged in acceptance. (4) **PDF↔markdown link** as a declared sha alias (`paper_aliases(kind='pdf_sha256')`, `raw_documents.linked_sha256`), never a path in identity. (5) `manuscripts` + `citations(manuscript_id, bibtex_key, paper_id, tex_file, tex_line, sentence_hash, scanned_at)` written by a fixed `cite_check` scan (paper_id resolved from the in-project bibtex_key; a manuscript sentence is not a `claims` row, so no `claim_id`); authority: **AH owns review workflow when `ah_root` is set, memory otherwise**. (6) Content-addressed corpus `corpus/<paper_id>/<sha16>.md` plus the managed current-doc copy; partial unique `uq_raw_current` (`paper_id WHERE is_current=1`). (7) **CLI:** all 22 subcommands ported or retired here, `verify` (DOI lookup) renamed `lookup`, `--json` keeps `paper.verified`/`bibtex_key` as a compatibility view; `chunks.text` is deleted. (8) The PDF path survives only to emit typed `chunkless`/`scanned-only` states, never to fabricate chunks.
**Acceptance.** INV-4 twins (same file two paths → 1 row/1 doc; two `main.md` → 2 rows); **promotion test** — title_year then DOI → one row, same doc, same corpus path, same ledger `file`; PDF + converted markdown → one paper; per-project quarantine delta report signed off before Phase 3; `foreign_key_check` empty; fresh DB inserts claims with NULL and non-NULL `manuscript_id`; frontmatter refusals; 300-file ingest byte-deterministic.
**Rollback.** Step 0.0 backup; v2 columns nullable/defaulted so 0.1.x still reads for one release; no down-migration engine.

### Phase 2 — Structure, byte slices, coverage, one FTS (1 week)
**Changes.** `structure.py`; `section_roles.py` (deterministic role classifier + profile derivation, §4.2); `chunker.py` (section-scoped slices, row-atomic tables with the header in every continuation, verbatim fences/math, bibliography flagging, figure sandbox); `coverage`; `extractions`; delete `understand.split_sections`/`chunk_text`/`SECTION_PATTERNS`; `chunks` gains `pipeline_version`, `origin_channel`, `source_sha256`, `extraction_event_id`; **exactly one FTS table** — `chunks_fts` external-content over `chunks.index_text`, `content_rowid='seq'`, no UNINDEXED projection columns (filters are JOIN predicates) — claim/paper legs are scored SQL; sync: insert after the base row, `'delete'` with full old values **before** deleting the base row, `AUTOINCREMENT` seq so rowids are never recycled, `'rebuild'` for recovery.
**Acceptance.** INV-1 over `pipeline_version>=pmv2` only; heading recall ≥37/39; **role fixtures**: `Related Work`/`Prior Art`/`Literature Review` → `related_work`, `Methodology`/`Approach` → `method`, `Results and Discussion` → `results` + `role_secondary='discussion'`, `Conclusions` → `conclusion`, a numbered subsection under Methods → `inherited_parent`, and a heading-less paper → every section `unclassified` with `structure_confidence='low'`; roles never affect default ranking (identical top-N with the role columns nulled) and `section_role` filters return only matching roles; **outline is derived, not stored** — the `outline` read function (surfaced as a tool in Phase 7) returns byte-identical output after recompute and adds no rows; no chunk starts mid-row and every table continuation carries `header_span_json`; bibliography chunks exist, `claimable=0`, absent from default recall; `indexed_chars + Σ uncovered == source_chars − Σ dropped`, `uncovered` = every non-dropped span with no chunk (`dropped` is disjoint, not a subset); bibliography/fence chunks count as indexed, never double-counted; **FTS lifecycle test** — fresh schema, insert → MATCH non-empty, delete base row → count 0, `rebuild` → counts equal base rows; `reindex --from-raw` killed mid-run resumes.
**Rollback.** Derived: `reindex --from-raw`; RAW untouched; no v1 `search_fts` switch.

### Phase 3 — Scoping + retrieval (1 week)
**Changes.** `ensure_project` upserts inside the ingest/claim `store.mut()` transaction (`unassigned` inserted by migration); `paper_projects` backfill verified; `claims.project_key` real FK, membership-derived at extraction, never NULL for pmv2 rows; `scope.py`; `tokenizer.py` (one `normalize()`, terms quoted in MATCH); `search_v2.py` — bm25 `ORDER BY`, fetch `max(4*limit,64)` feeding only the per-paper cap, all scope/cite-state filters pushed into SQL, typed empties, byte-slice snippets, payload budget; **INV-7 absence counters**; `list`/`coverage` CLI.
**Acceptance.** INV-3 true-top-N equality for 20 probes at 300 papers, scoped p95 ≤120 ms; scope-leak for `kind='chunk'`, `kind='claim'` and recap's claim window (A's claim never in B's answer; `OR project_key IS NULL` forbidden); first-ever scoped ingest creates project+membership; `COUNT(paper_projects) == COUNT(legacy rows with project_id)` and cite_check keys unchanged on the migration fixture; hyphen and `$R^2$`/`f_\beta` probes; `limit=1000` → `budget-exceeded`; **stdlib-`ast` guard**: every `SELECT` with `LIMIT` has a governing `ORDER BY`, with an explicit exemption list (keyset pages, `ORDER BY recorded_at DESC LIMIT 1`, `--tail`, FTS `optimize`) plus the behavioural top-N test — no grep rule; INV-7 negatives: bibliography-only, chunkless-only, uncovered-only terms each return a distinct `empty_reason`.
**Rollback.** Revert the module; projects/memberships are additive; the signed delta report is the tripwire.

### Phase 4 — Claims, grounding, lifecycle, resumable sweep (1.5 weeks)
**Changes.** `claims` stores offsets + `quote_sha256` + `asserted_quote`; `evidence_quote` materialized at read time from `raw_documents.text`, never stored; `claim_key` + `uq_claim_latest`; contiguous `claim_sources`; `claims_extract.py` (deterministic re-derivation, replaces the `understand.py` writer); `grounding.py` (`quote_check`, `verify_claim`); ladder; **`sweeps`** (`cursor,total,state`) for supersession and `reindex --from-raw`, 200-claim batches; `verify`/`health` CLI.
**Acceptance.** INV-2 walk incl. chunk rows; write-path predicate test (norm-equal/byte-different never `verified`); doc supersede → `doc-superseded` with the old content-addressed file still readable; **kill a sweep mid-run, restart, same terminal state, zero duplicate events**; hand-edited current file → `raw-file-drift` only for the current doc.
**Rollback.** Restore backup; superseded rows retained.

### Phase 5 — AH bridge (1 week)
**Changes.** `ah_bridge.py`; `ah_verdicts` gains `doc_id/raw_sha256/char_start/char_end/quote_hash`; import refuses `stale-verdict-sha`; `claims.ah_binding_ref` set by `bind`/`import_verdicts` and indexed; ledger join keyed only on `paper_id + raw_sha256 + quote_sha256 + ah_sha16` (never a path), emitting `quote_hash = sha1(norm_text(quote[:600]),10)` and raw `quote_sha256`, plus the `corpus/<paper_id>/<sha16>.md ↔ sources/files/<id>.txt` mapping; **AH id = `paper_id`** + per-project citation-key aliases via `--keys` (absent flags omitted); `register_to_ah` refuses `no-raw-file` for legacy docs; `ah_root` validated against the AH project dir; §8.4 AH items land as a **precondition** (char/byte-span bindings, `ah evidence export --ledger`, deterministic T3 path).
**Acceptance.** 20 papers register byte-identically **and** AH's copy still satisfies INV-1 (quote re-slices out of it); two papers sharing `bibtex_key` → two AH sources; ledger round-trip joins at 599/600/601/5000-char quotes; changed source sha → `stale-verdict-sha`, never silent re-promotion; `NOT_SUPPORTED` → `contradicted`, absent from cite/recap/list; reverse walk paper→claims→`citations`→`tex_file:tex_line` returns the seeded sentence.
**Rollback.** Pure file exchange; unset `PAPERMEMORY_EVIDENCE_DIR`; no schema coupling.

### Phase 6 — Briefing, catalog, log (3 days)
**Changes.** recap rewrite (claims windows filtered by membership, `scope_stats` carrying `cite_state`/`coverage.capped`, budgets, stable/volatile split); `catalog.py` from rows; lessons/observations upgrade; `events` rotation with a size budget; `VACUUM` outside any transaction.
**Acceptance.** recap includes claims and degradation counters; ≤6k chars at 300 papers with a `list` hint; catalog count equals SQL; 9th lesson visible; wrong slug → `empty_reason:'project-not-found'` + known keys.
**Rollback.** Read-only; revert.

### Phase 7 — MCP surface + plugin wiring (4 days)
**Changes.** The §9 tool set and schemas; path sandbox on every path arg; `pdf-to-markdown.js` forwards `doi` **and** `pdf_type/confidence/pages_needing_ocr` plus resolved `origin_channel` into ingest, and stops auto-ingesting page subsets; `paper-download.js` surfaces `status`/`cite_state`/degradation instead of `ok:true`+hidden `error`; **mount fail-loud**: decide `failOnStartupError` (default true for papermemory) and surface startup/registration failure and tool-count drift; PATH binaries pass the version gate; Content-Length-only deadlock fixed and tested; resumable directory ingest; `prompt.js` + `SKILL.md` rewritten here only, with a golden-text test.
**Acceptance.** `tools/list` matches the §9 golden surface (including `outline` and `section_role` filters); poisoned DB and Content-Length-only PATH binaries each yield a loud agent-visible state; OCR fixture (confidence 0.31) shows `origin_channel='ocr-recovered'`, `degradation{pdf_type,confidence,pages_needing_ocr_count}`, `status_reason='channel-capped:ocr-recovered'` in cite/get/verify/ledger, and a direct `claim` on that fixture stays `extracted` with the same immutable reason; sandbox escapes refused; a 300-file ingest resumes with `duplicate-noop`.

### Phase 8 — Re-vendor + hardening (2 days)
**Re-vendor (the only sanctioned change path).** (1) Upstream tag `v0.2.0`, pytest green. (2) `rsync -a --delete` the **whole** upstream tree — `papermemory/`, `tests/`, `pyproject.toml` (read by `vendoredVersion()`), `README.md`, `LICENSE` — excluding `__pycache__`. (3) `SOURCE.txt`: `Commit:` the pinned sha, `Version: 0.2.0`, empty exception list. (4) Bump `BUNDLE_REV`/`MIN_PAPERMEMORY_VERSION`; `uv venv --clear`; delete `installed-version`; assert `papermemory version`; run `doctor --schema`. (5) CI `diff -r` against the pinned commit is a build failure. **Rollback:** back up + previous tag, venv/stamp removal as Phase 0.

**Per-phase matrix.** Six suites — `substring_invariant`, `no_orphan`, `coverage` (+INV-7), `twin_idempotence`, `partial_ingest_visibility`, `claim_walk` — are gated by phase (1 twins/identity; 2 substring/coverage/FTS; 3 absence; 4 walk/sweep; 5 verdict; 6–7 recap/mount). Phases 1–6 expose via CLI; MCP is Phase 7. A phase may not close with an owned suite red.

## 11. Test & CI strategy

**Upstream (pytest; `dev = ["pytest>=8.0"]`, runtime deps empty).** The vendored tree ships **no `tests/`** (`pytest vendor/papermemory/tests` exits 4; `pytest vendor/papermemory` exits 5), so the suite is authored upstream in Phases 0–4 and CI runs it there; the re-vendor copies it in.

- `tests/inv/` — the §0 invariants, scoped to `pipeline_version >= pmv2` and `provenance_basis='verbatim'`; `test_legacy_strata.py` asserts migrated rows are reported as legacy (`no-source-text`, `normalized-v1`), not violations. `test_inv1` re-slices every claim span twice — Python `raw[qs:qe]` and SQL `substr(text, qs+1, qe-qs)` — asserting sha equality, so base-offset drift is red. `test_inv2` walks claims **and** chunks (channel, extraction event, source sha) plus orphan injection. `test_inv3` seeds 300 papers and asserts true top-N equality for 20 probes; the LIMIT guard is a **stdlib `ast`** check (governing `ORDER BY`, named exemptions) — no line grep. `test_inv7_absence.py` asserts untruncated `corpus_match_count`, per-class `suppressed{}`, closed `empty_reason`, three negative fixtures.
- Blocker-named tests: `test_fts_lifecycle.py` (one `chunks_fts`; insert, MATCH, delete-before-base, rebuild, counts equal base rows; claim/paper SQL legs non-empty), `test_audit_mutators.py` (every `MUTATORS` entry writes one in-transaction `events` row; rollback writes none; `events.op`/`claims_history.event` vocabularies disjoint by set assertion), `test_write_path_inv1.py`, `test_sweep_resume.py` (kill mid-sweep, resume, same state, idempotent), `test_identity_promotion.py`, `test_pdf_md_merge.py`, `test_ledger_roundtrip.py` (599/600/601/5000 chars; `quote_hash`/`clause_hash` recipe), `test_scope_claim_recap.py`, `test_paging.py` (two pages union equals one read), `test_rank_access_count.py` (ranking invariant under `access_count` mutation), `test_sandbox.py`, `test_migration.py` (0→2000 rebuild, `foreign_key_check`, backup/restore/export reconciliation, fresh-DB claim with NULL and non-NULL `manuscript_id`).
- **Fixtures.** `tests/fixtures/corpus300/` is a committed **golden snapshot** (gzipped tarball + `MANIFEST.json` of path→sha256), never regenerated in tests: the anchor `.md` is stored as bytes because `@firecrawl/pdf-inspector` is a platform-specific native optionalDependency and regenerating it would silently move every offset INV-1/INV-3 assert on. A committed 12-paper store backs the fast lane; `tools/seed_corpus.py` builds only synthetic variants (frontmatter variants, twins, `Jan.`/`Std.` cells, fences, math, excerpts).
- `tests/test_scale.py`: 300-paper search ≤120 ms p95, scoped, ingest ≤8 min, file ≤400 MB, `quote_check` latency budget.

**Plugin (Node, `scripts/test-paper2agent.mjs` pattern: mkdtemp `$DSH_HOME`, spawn, counters, `--json`).**
- `scripts/test-papermemory-v2.mjs`: installs the bundle, seeds the 12-paper fixture, runs ingest→search→quote_check→verify→cite→register_to_ah→recap via CLI, asserts the invariants and negatives (empty scoped search typed; chunkless paper never `supports_statement:true`; OCR degradation visible).
- `scripts/test-papermemory-migration.mjs`: live-shape fixture (134 rows, 121 chunkless, 12 unanchored) → migrate → quarantine completeness, `no-source-text` excluded from cite, zero data loss.
- `scripts/test-papermemory-mount.mjs`: mounts through the actual DSH MCP client (not a bare child) with a poisoned DB and a Content-Length-only PATH binary; asserts startup/registration failure and tool-count drift are **agent-visible**, and calls still return `isError`, not absent tools.
- The golden set includes `tools/list`, `SKILL.md` and `prompt.js`, since those prose rules change once, in Phase 7.

**CI.** `.github/workflows/verify.yml` (fast, ≤10 min, keeps the existing 15-min clean-boot job): pytest unit+invariants on the 12-paper store, migration round-trip, plugin smoke, vendoring `diff -r` gate. A nightly workflow: corpus300 from a cached tarball (never rebuilt per job), scale, full migration, plugin e2e + mount, AH interop. AH extends its own suite for deterministic T3, BIB-02 on an empty registry, `pm-evidence-1` import and byte-identical registration.

## 12. Risk register + rejected alternatives

### Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Strict frontmatter refuses usable papers | High | Corpus un-ingested | H1 `title_year` + first DOI before the first ATX heading is first-class; refusals enumerable via `list(project='unassigned')`+`coverage`; `--assume-identity`; 30 no-frontmatter fixtures must ingest. |
| Legacy store cannot satisfy INV-1/2/6 | Certain | `health` red on day one | `provenance_basis` strata; 12 unanchored claims → `no-source-text`; 113 normalized claims exempt from `raw-file-drift`/AH; suites scoped to pmv2; legacy negative test. |
| Interrupted migration (boot timeouts, multiple writers) | Medium | Half-applied schema | `Store` validate-only; explicit single-writer `migrate` (lockfile+checkpoint); per-statement txns, no `executescript`; SIGTERM→SIGKILL; Phase 0b guard. |
| AH line view vs memory char/byte spans; ledger never joins | Medium | Seam reopens silently | Join on `paper_id+raw_sha256+quote_sha256+sha16`; both hashes with AH's exact collapse/truncate; char/byte bindings a Phase-5 precondition; 599/600/601/5000-char test; `stale-verdict-sha` refusal. |
| Supersession strands claims; bm25 still misses paraphrase | Certain (bounded) | Recall drops; agent concludes "nothing" | Batched resumable sweep; `rebind_claim` auto-promotes re-landing quotes; rare-term dominance with rowid cut/cap removed; `require_all`; typed `empty_reason`; documented in §13. |
| Two writers race | Medium | UNIQUE failure read as "not in memory" | `ON CONFLICT` upsert; `busy_timeout=5000` + retry; children drain during migration; loser returns `duplicate-noop`. |
| Vendored tree re-drifts | High | Divergent schema, untested merge | Provenance re-pinned, empty exception list, whole-tree rsync, CI `diff -r`, `doctor --schema`. |

### Rejected alternatives (with the evidence that rejected them)

| Rejected | Reason |
|---|---|
| **Three FTS tables (`claims_fts`/`papers_fts` over views)** | Unbuildable as specified (views with no `seq`) and unnecessary: every query path is ≤2 ms at 500 papers, "the fix is ranking, not indexes" (`/tmp/pm-digest.txt` perf-storage 374-379). One `chunks_fts`; claim/paper legs are scored SQL. |
| **LLM-paraphrase ingest / LLM dedupe** | Breaks determinism and verbatim grounding; mem0's grounding is prompt text only, the D5/D6 decorative-rule failure (`/tmp/mem-digest.txt` line 72, items 1–2). |
| **Vector DB / embeddings; reviving the graph leg** | Zero-dependency + local-first non-negotiable (mem0 is not local-first; agentmemory needs a pinned native engine), and the defect class is grounding/coverage, both SQL-fixable; `upsert_entity` has zero callers, `entities=0`, all 121 relations are `(manuscript,cites,paper)` (`/tmp/pm-digest.txt` RR-7). |
| **Trusting `verified` as a gate** | It measures "a `.bib` line contains a DOI" (90 chunk-less rows, D5). Replaced by `cite_state` + claim ladder; retained only as a compatibility view. |
| **Immutable raw layer beside a rewriting chunk layer** | 2/92 chunks verbatim because `re.sub(r"\s+"," ")` (`/tmp/r2-digest.txt` line 37); no quote check can pass. Chunks store offsets only. |
| **Blank-line chunking; tables as prose** | Re-joining breaks the substring property; tables split at `Jan.`/`Std.` and lose headers (`/tmp/r2-digest.txt` ANTI line 59, items 1–2). |
| **Hand-rolled line YAML frontmatter** | Nested authors collapse, `orcid` clobbers upward, a stray `---` eats the title (`/tmp/r2-digest.txt` line 22, ANTI line 59 item 3). Flat whitelist, stdlib, typed refusal. |
| **Identity/dedupe from stems, paths, log greps** | D3's one row/two papers and the log-grep double-append (`/tmp/r2-digest.txt` ANTI line 59, item 4). Ambient values banned by INV-4. |
| **Coverage/health from top-k probes or "graceful degradation"** | The D4/D12 false-success shape (`/tmp/r2-digest.txt` ANTI line 59, item 5); health is SQL over persisted rows, skipped legs reported in `legs`. |
| **Per-leg query mutation; enforcement by docstring** | Legs score different queries, re-introducing D10 asymmetry (ANTI line 59, item 6); `SKILL.md:87`/`prompt.js:111` has zero comparison code. One normalizer; every rule names its enforcing tool and has a test. |
| **A v1/v2 search flag and a `claims_history` downgrade engine** | The v1 path needs `chunks.text`, which Phase 2 deletes; the downgrade engine rebuilds what backup/restore already gives. Rollback = step 0.0 backup + revert. |

## 13. Out of scope (explicit non-goals)

1. **Semantic/vector retrieval, embeddings, reranking models.** Local-first + zero-dependency; paraphrase recall stays bounded and the skill says "re-issue with different terms; `require_all` for exact matching".
2. **Knowledge-graph memory, entity extraction, co-occurrence edges.** No deterministic writer; not carried into v2, export tolerates absence.
3. **LLM-written summaries, persona/consolidation, scene blocks or any L2/L3 pyramid.** Every surveyed system gates that behind a model; off the correctness path.
4. **Multi-tenant / per-workspace isolation, cloud sync, telemetry, collaboration, ACLs, HTTP gateway, dashboards.** One shared store stays a feature; logical scope is what gets fixed; per-workspace DB remains a `PAPERMEMORY_DB` decision.
5. **PDF-side extraction improvements inside PaperMemory** (OCR, layout, table detection). Intake is markdown; PDF-only ingest is `chunkless`/`identifier-only` or needs `--assume-identity`.
6. **AH engine internals beyond Phase-5 preconditions and §8.4** — verifier prompts, model backends, JEJ, briefs, plans, disclosure, LaTeX machinery.
7. **Automatic claim merging by similarity.** Jaccard yields `similar_to`; merges are explicit.
8. **Deleting history.** Superseded docs/chunks/claims are retained; events rotate out of the DB under a size budget but are not deleted from disk.
9. **Back-filling legacy metadata-only rows into full text; a GUI, dashboard, second storage format or background worker.** Quarantined rows are reported, not fabricated; single-file SQLite is the contract; ingest and the sweep are synchronous, per-file, resumable in-process.
10. **Section-role ranking bias, stored section summaries, and cross-paper semantic mining.** Roles are deterministic labels for `outline` and opt-in filters only — they never re-rank defaults; `outline` stores nothing (derived on read) and contains no generated prose; extracting methods/claims *across* papers or reconstructing a paper's "literature review" from prose stays out of scope.

## Reviewer findings addressed

**Completeness.** The unbuildable claim/paper FTS legs are removed, not patched: one `chunks_fts` with valid external-content sync and claim/paper legs as scored SQL, plus a Phase-2/§11 lifecycle test proving each leg returns rows. INV-1 now matches the write path (offsets + `asserted_quote`; quote materialized from raw) and its test asserts that predicate. INV-3's grep is an AST LIMIT/ORDER-BY check with named exemptions plus a 300-paper true-top-N test. Audit gets an owner: Phase 0 folds it into a view over `events`, routes every mutator through `store.mut()`, and adds the `MUTATORS` test. Manuscript state, the v1 manuscript tables and the `.tex:line` locator are migrated in Phase 1 with `citations` and declared authority. PDF↔markdown becomes a sha alias with a one-row twin test; identity promotion gets `promote_identity`/`merge` and a re-key test; the ledger is content-hash-only with AH-shaped `quote_hash` and a 599/600/601/5000-char round-trip; AH ids use `paper_id`; the sweep gets `sweeps` and a kill/resume test; the plugin fail-silent half gets a Phase-7 mount item and a real-mount test; every digest citation is re-pointed (2/92 → r2:37/58, clobber → r2:22, ANTI items → r2:59, converter signals → `pdf-to-markdown.js:111-115`).

**Traceability.** Chunks carry `origin_channel`/`source_sha256`/`extraction_event_id`, so INV-2 walks chunk rows; the corpus file is content-addressed per doc and `doc-superseded` short-circuits `raw-file-drift`; partial unique indexes pin one current doc and one latest claim (`claim_key`); `ah_verdicts` gains `doc_id/raw_sha256/spans`, `ah_binding_ref` gets a writer and index, stale-sha imports are refused; the 0-based-half-open / 1-based-inclusive convention is stated and INV-1 re-slices through Python and SQL; OCR degradation is surfaced in cite/get/verify/ledger with `channel-capped:ocr-recovered`; absence gets INV-7 (untruncated counts, suppression classes, closed `empty_reason`, three negatives); the `.tex:line` hop is persisted in `citations` and tested.

**Operations.** Step 0.0 backup precedes all code; the `papers` migration is rename/rebuild with FK ordering, backfill and `foreign_key_check`; `chunks.pipeline_version` exists; FTS DDL is buildable and delete-before-base/`rebuild` is explicit; migration is single-writer and non-`executescript`; legacy strata are declared instead of failing invariants; all 22 CLI subcommands are ported/retired with `verify`→`lookup`; rollback includes venv/stamp removal and Phase 0b blocks old binaries; provenance is re-pinned to `914c2b3`/v0.1.1 with a whole-tree rsync set; quarantine semantics and `papermemory merge` protect the live manuscripts' cite sets; CI splits fast/nightly with a committed corpus tarball and a `__pycache__`-aware diff gate.

**YAGNI.** Two FTS tables, the v1/v2 flag, the `claims_history` downgrade engine and a parallel `verified` mutation path are cut; over-fetch is `max(4*limit,64)` feeding only the per-paper cap; frontmatter stays stdlib-only; fixtures are committed snapshots, never regenerated through a native converter; the matrix is phase-gated, CLI first, MCP in Phase 7.


---

## Implementation status (as shipped, 2026-10-22)

Phases 0–7 are implemented in `raktim-mondol/papermemory` commit `e256eb5` (v0.2.0) and re-vendored here as `0.1.1+dsh13` of the plugin bundle. All 83 Python tests and the plugin golden-surface check (`scripts/test-phase7.mjs`) pass; CI runs both. The live store was migrated to `user_version=2000` (134 papers quarantined as chunkless, 1022 legacy chunks and 125 legacy claims retained, 267 events folded); re-ingest papers as markdown to make them citable/claimable.

Applied ahead of the AH upstream release (vendor/academic-harness only): registry `--keys` citation-key aliases (`entry_for` in resolve/resolve_all/BIB-02) and byte-copy of `.md`/`.txt` sources. Still open on the AH side: T3 deterministic-half defaults, BIB-02 on an empty registry, EVD-04 severity, char/byte-span `bind_passage`, and `ah evidence export --ledger`.

## Appendix: Open questions carried out of review

> Rev 3 note: the three validation residuals from the final walk (AH `\cite` key resolution, live-twin merge ordering, and the `cite_check`/notes ledger op) were resolved by direct specification patches in §3.5, §3.6, §8.1, §8.2, §8.4 and §9. They are retained below as review history.

- Identity upgrade path when two existing rows collide: if row A (identity=title_year) later supplies a DOI that row B already owns, the plan raises an `identity-conflict` event requiring explicit owner merge. Should `papermemory migrate --auto-merge` be offered for the unambiguous case (identical doc sha256 on both rows), or is a report + manual action the right hard stop for Phase 1?
- Owner's actual markdown: will the hundreds of supplied .md files carry YAML frontmatter at byte 0 (author-supplied) or be pure pdf-inspector output with no frontmatter? The DOI-before-first-heading fallback plus H1 identity carries most of it, but if most files have neither (e.g. single-page abstracts or paywall stubs), `identity-unresolved` volume could be large enough to need a sidecar manifest (a CSV mapping path→doi) as a declared identity source — that is a new tool surface, not currently planned.
- Does the corpus root live under `~/.local/share/papermemory/corpus/<paper_id>.md` (my plan: yes, because AH needs a stable path that survives workspace moves and it is what the evidence ledger records), or must it stay inside the user's workspace so the owner can see/edit the files where they wrote them? This decides whether `register_to_ah` copies (extra bytes) or registers the owner's original path (offsets break if the owner edits their .md).
- Should the live 134-paper store be migrated in place (user_version 0→2000 with a quarantine report) or superseded by a fresh v2 DB re-ingested from markdown, keeping the old file as an archive? In-place migration preserves claims the manuscripts already cite but inherits fingerprint-derived twins; a fresh re-ingest is cleaner but loses every agent-authored claim and note unless exported first.
- Is there a floor SQLite version we can rely on in the plugin-managed venv across all target machines? I assumed ≥3.43 (external-content + contentless_delete semantics; 3.45.3 verified present in this environment). If any target runs an older system python, external-content FTS tables need the non-external fallback path, which changes the storage argument (~150 MB at 300 papers).
- How much recall loss is acceptable from `claimable_only=true` by default (bibliography excluded from default recall)? A citation-checking agent may legitimately need bibliography text; do we expose `claimable_only=false` in `papermemory_search` and leave it out of `cite`, or add a dedicated `papermemory_reference_lookup` tool (16th) so the excluded-by-default invariant cannot be bypassed on the citation path?
- Phase 5 AH-repo policy changes (T3 in the gated default; BIB-02 on an empty registry; EVD-04 escalation; char/byte-span bindings) are cross-repo and change the stop-gate's blocking behavior, i.e. they can make previously-green gates fail. Do you want them shipped behind an `ah.yaml` opt-in (`gate.evidence: always`) for the first release, or on by default once `register_to_ah` has proven byte-identical registration?
- Timeout and batching for bulk ingest: current `INGEST_TIMEOUT_MS=90_000` / `TOOL_CALL_TIMEOUT_MS=180_000` cannot hold 300 files in one call. Should the plugin switch to one `papermemory_ingest_dir` call with server-side resumable progress + a `cursor` (new tool-ish behavior), or a JS-side loop over per-file calls (slower, simpler, no new surface)?
- VALIDATION RESIDUAL: Walk 3 STILL breaks before any sha/staleness check: §8.2 steps 2-3 register the source as `ah source add <corpus_path> --id <paper_id>` ('AH id is paper_id, never bibtex_key'), but AH resolves a manuscript `\cite{key}` by the citation key, not the memory id. `vendor/academic-harness/ah/checks/t3_evidence.py:50` calls `resolve_all(p, k, ...)`; `vendor/academic-harness/ah/sources/registry.py:155-160` returns a file only `if key in reg`, and `reg` is `{s['id']:s}` (`registry.py:30-34`; `add_source` stores `reg[sid]` at 55-69). A registry keyed by `pap_...` makes every `\cite{smith2020}` unresolved -> EVD-04 'no source text' (`t3_evidence.py:51-59`) and no T3 verdict to link. Worse, `vendor/academic-harness/ah/checks/t2_bib.py:39-44` looks up `ctx.registry.get(k)`, so every cited key becomes a BIB-02 major 'cited key is not in the source registry' even though memory registered the paper. The only fallback is `doi_index` (`registry.py:133-152`), which needs a DOI in the .bib and in the source's first 4000 chars, so no-DOI/arXiv-only papers never resolve. Required: keep `paper_id` as the file/content id but register a per-AH-project key->source alias (`source_map` row, or a `keys` list on the registry entry consulted by `resolve`; BibTeX keys are unique within the manuscript's .bib, so this avoids the global-collision worry), and add a Phase-5 test where `ah check --evidence` on a seeded `\cite{key}` produces a verdict and no BIB-02 for both a DOI and a no-DOI paper. In the same fix, §8.1's bind-time sidecar stores only `sha16`, not the full `raw_sha256` that §8.4's export must emit and §8.3 compares; specify that `bind_passage` persists the full ledged row (full `raw_sha256`, char/byte spans) so `stale-verdict-sha` is a real bind-time check, not a re-resolved tautology.
- VALIDATION RESIDUAL: Walk 5 STILL breaks at the mandatory live-twin merge. §3.1 declares `UNIQUE(paper_id,sha256)` on `raw_documents` and the partial `uq_raw_current(paper_id) WHERE is_current=1`; §3.6 says the merge 'rewrites `raw_documents.paper_id` ... leaves one `is_current=1` doc' but specifies no demote/dedupe step. A twin has two current docs, so a plain `UPDATE raw_documents SET paper_id='B' WHERE paper_id='A'` raises `UNIQUE constraint failed: raw_documents.paper_id` (the partial current index) even when the shas differ, and also violates `UNIQUE(paper_id,sha256)` when the same file was ingested twice; `UPDATE paper_projects SET paper_id='B'` violates PK(paper_id,project_key) whenever both twins are in the same project (the normal case). Both collisions were reproduced in SQLite. The merge aborts, chunks stay on A, the old project still retrieves the text and B misses it - exactly the leak the prior blocker required fixing. Required: specify merge order and dedupe - demote A's docs (`is_current=0`) before re-pointing, collapse duplicate `(paper_id,sha256)` docs by re-pointing chunks/claims/sections/coverage to the survivor (or deleting the duplicate), set `papers.current_doc_id`, `INSERT OR IGNORE` memberships then delete A's, re-key claims (Phase 1's 'claim re-key'), rebuild FTS - and add a test that merges two current docs with the same sha in a shared project.
- VALIDATION RESIDUAL: Walk 1's persistence step cannot satisfy the plan's own one-ledger rule, so the prior cross-cutting ledger blocker is only partially fixed. §3.5 requires every mutator to call `store.mut(op, ...)` with `events.op` from the closed 17-value set; §9's `cite_check` writes `citations(manuscript_id,bibtex_key,paper_id,tex_file,tex_line,sentence_hash,scanned_at)` with `ON CONFLICT`, but the §3.5/§7.3 set has no citation/locator op (nor ops for `remember` -> observations, `lesson` -> lessons, or the `manuscript_sections`/`contributions`/`terminology`/`reviewer_comments` writes retained in §3.1). `MUTATORS` can therefore omit the citation write (violating 'every mutator' and leaving the v1 audit gap) or register it with an out-of-enum string (failing the set assertion in `test_audit_mutators`). Required: add canonical ops (e.g., CITE_CHECK/LOCATOR_WRITE, REMEMBER, LESSON_WRITE, MANUSCRIPT_WRITE) to §3.5/§7.3 and `MUTATORS`, or declare named, tested exemptions so the one-ledger claim is true.
