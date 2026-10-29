from __future__ import annotations

SCHEMA_V2000 = 2000
PIPELINE_VERSION = "pmv2-p1"

# Statements only; PRAGMAs are applied by Store/migration outside transactions.
V2_STATEMENTS = [
    """CREATE TABLE IF NOT EXISTS projects (
      key TEXT PRIMARY KEY, title TEXT, kind TEXT NOT NULL DEFAULT 'manuscript',
      ah_root TEXT, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      identity_kind TEXT NOT NULL, identity_value TEXT NOT NULL,
      title TEXT NOT NULL, title_source TEXT NOT NULL,
      authors_json TEXT NOT NULL DEFAULT '[]',
      year INTEGER, venue TEXT, doi TEXT, arxiv_id TEXT, bibtex_key TEXT, abstract TEXT,
      origin_channel TEXT NOT NULL, cite_state TEXT NOT NULL DEFAULT 'chunkless',
      current_doc_id TEXT REFERENCES raw_documents(id) ON DELETE SET NULL,
      pdf_path TEXT, source_type TEXT,
      verified INTEGER NOT NULL DEFAULT 0, project_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(identity_kind, identity_value))""",
    """CREATE TABLE IF NOT EXISTS paper_aliases (
      kind TEXT NOT NULL, value TEXT NOT NULL, paper_id TEXT NOT NULL
        REFERENCES papers(id) ON DELETE CASCADE,
      first_seen TEXT NOT NULL, PRIMARY KEY(kind, value))""",
    """CREATE TABLE IF NOT EXISTS raw_documents (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, chars INTEGER NOT NULL,
      text TEXT NOT NULL, corpus_path TEXT NOT NULL,
      origin_path TEXT NOT NULL, origin_channel TEXT NOT NULL,
      converter_json TEXT NOT NULL DEFAULT '{}', kind TEXT NOT NULL DEFAULT 'paper',
      linked_sha256 TEXT, provenance_basis TEXT NOT NULL DEFAULT 'verbatim',
      pipeline_version TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1,
      supersedes_doc_id TEXT REFERENCES raw_documents(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE(paper_id, sha256))""",
    """CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_current
       ON raw_documents(paper_id) WHERE is_current=1""",
    """CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES raw_documents(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES sections(id) ON DELETE CASCADE,
      level INTEGER NOT NULL, heading_path TEXT NOT NULL,
      char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
      line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
      is_bibliography INTEGER NOT NULL DEFAULT 0,
      is_abstract INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'prose',
      role TEXT NOT NULL DEFAULT 'unclassified', role_confidence INTEGER NOT NULL DEFAULT 0,
      role_source TEXT NOT NULL DEFAULT 'none', role_secondary TEXT,
      ord INTEGER NOT NULL, pipeline_version TEXT NOT NULL,
      UNIQUE(doc_id, char_start, level, heading_path))""",
    """CREATE TABLE IF NOT EXISTS chunks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      doc_id TEXT NOT NULL REFERENCES raw_documents(id) ON DELETE CASCADE,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL,
      char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
      slice_sha256 TEXT NOT NULL, source_sha256 TEXT NOT NULL,
      index_text TEXT NOT NULL,
      table_id TEXT, row_start INTEGER, row_end INTEGER, header_span_json TEXT,
      is_bibliography INTEGER NOT NULL DEFAULT 0, claimable INTEGER NOT NULL DEFAULT 1,
      chunk_index INTEGER NOT NULL, origin_channel TEXT NOT NULL,
      extraction_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      pipeline_version TEXT NOT NULL,
      UNIQUE(doc_id, byte_start, byte_end, pipeline_version))""",
    """CREATE TABLE IF NOT EXISTS extractions (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES raw_documents(id) ON DELETE CASCADE,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      pipeline_version TEXT NOT NULL, status TEXT NOT NULL, reason_code TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, finished_at TEXT, stats_json TEXT NOT NULL DEFAULT '{}')""",
    """CREATE TABLE IF NOT EXISTS claims (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, claim_key TEXT NOT NULL,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      manuscript_id TEXT REFERENCES manuscripts(id) ON DELETE SET NULL,
      project_key TEXT NOT NULL REFERENCES projects(key),
      claim_text TEXT NOT NULL, claim_text_norm TEXT NOT NULL, claim_type TEXT NOT NULL,
      asserted_quote TEXT, quote_char_start INTEGER NOT NULL, quote_char_end INTEGER NOT NULL,
      quote_line_start INTEGER, quote_line_end INTEGER, quote_sha256 TEXT NOT NULL,
      doc_id TEXT REFERENCES raw_documents(id) ON DELETE SET NULL,
      primary_section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
      source_sha256 TEXT, origin_channel TEXT NOT NULL, pipeline_version TEXT NOT NULL,
      extraction_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'unverified-quote', status_reason TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.4, is_latest INTEGER NOT NULL DEFAULT 1,
      supersedes TEXT, superseded_by TEXT, ah_binding_ref TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS claim_sources (
      claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(claim_id, chunk_id))""",
    """CREATE TABLE IF NOT EXISTS claims_history (
      id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      event TEXT NOT NULL, old_status TEXT, new_status TEXT, old_claim_text TEXT,
      new_claim_text TEXT, old_doc_id TEXT, new_doc_id TEXT,
      actor TEXT NOT NULL, reason TEXT, evidence_json TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS sweeps (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, paper_id TEXT, doc_id TEXT,
      cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, reason_code TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS coverage (
      doc_id TEXT PRIMARY KEY REFERENCES raw_documents(id) ON DELETE CASCADE,
      source_chars INTEGER NOT NULL, indexed_chars INTEGER NOT NULL,
      uncovered_json TEXT NOT NULL DEFAULT '[]', chunk_count INTEGER NOT NULL,
      section_count INTEGER NOT NULL, dropped_sections_json TEXT NOT NULL DEFAULT '{}',
      capped INTEGER NOT NULL DEFAULT 0, truncation_reason TEXT NOT NULL DEFAULT '',
      ratio REAL NOT NULL, checked_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, op TEXT NOT NULL,
      paper_id TEXT, doc_id TEXT, claim_id TEXT, project_key TEXT,
      status TEXT NOT NULL, reason_code TEXT NOT NULL DEFAULT '', detail TEXT)""",
    """CREATE VIEW IF NOT EXISTS audit AS
      SELECT id, op AS operation,
        CASE
          WHEN paper_id IS NOT NULL AND doc_id IS NULL AND claim_id IS NULL THEN 'paper'
          WHEN doc_id IS NOT NULL AND claim_id IS NULL THEN 'document'
          WHEN claim_id IS NOT NULL THEN 'claim'
          ELSE 'system'
        END AS target_type,
        COALESCE(paper_id, doc_id, claim_id, project_key) AS target_id,
        detail, ts AS created_at
      FROM events""",
    """CREATE TABLE IF NOT EXISTS paper_projects (
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
      first_seen TEXT NOT NULL,
      source_event TEXT REFERENCES events(id) ON DELETE SET NULL,
      PRIMARY KEY(paper_id, project_key))""",
    """CREATE TABLE IF NOT EXISTS ah_verdicts (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      doc_id TEXT NOT NULL REFERENCES raw_documents(id) ON DELETE CASCADE,
      raw_sha256 TEXT NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
      verdict TEXT NOT NULL, quote TEXT, locator TEXT, quote_hash TEXT,
      mismatch_json TEXT NOT NULL DEFAULT '[]', prompt_version TEXT NOT NULL, model TEXT,
      run_id INTEGER, ledger_sha256 TEXT NOT NULL, recorded_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS manuscripts (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      target_venue TEXT, citation_style TEXT, root_path TEXT, ah_project_key TEXT,
      status TEXT NOT NULL DEFAULT 'draft', notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS citations (
      id TEXT PRIMARY KEY,
      manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
      bibtex_key TEXT NOT NULL, paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
      tex_file TEXT NOT NULL, tex_line INTEGER NOT NULL, sentence_hash TEXT NOT NULL,
      scanned_at TEXT NOT NULL,
      UNIQUE(manuscript_id, tex_file, tex_line, bibtex_key))""",
    """CREATE TABLE IF NOT EXISTS manuscript_sections (
      id TEXT PRIMARY KEY,
      manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
      name TEXT NOT NULL, path TEXT, word_target INTEGER, word_count INTEGER,
      status TEXT, notes TEXT, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS contributions (
      id TEXT PRIMARY KEY,
      manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
      text TEXT NOT NULL, order_index INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS terminology (
      id TEXT PRIMARY KEY,
      manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
      canonical TEXT NOT NULL, avoid_json TEXT NOT NULL DEFAULT '[]', notes TEXT)""",
    """CREATE TABLE IF NOT EXISTS reviewer_comments (
      id TEXT PRIMARY KEY,
      manuscript_id TEXT NOT NULL REFERENCES manuscripts(id) ON DELETE CASCADE,
      reviewer TEXT, comment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      response TEXT, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY, tier TEXT NOT NULL, content TEXT NOT NULL,
      concepts_json TEXT NOT NULL DEFAULT '[]', project_id TEXT, manuscript_id TEXT,
      paper_id TEXT, confidence REAL NOT NULL DEFAULT 0.7, created_at TEXT NOT NULL,
      accessed_at TEXT, access_count INTEGER NOT NULL DEFAULT 0, superseded_by TEXT,
      status TEXT NOT NULL DEFAULT 'active', updated_at TEXT, origin_channel TEXT NOT NULL DEFAULT 'hand-asserted')""",
    """CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, concepts_json TEXT NOT NULL DEFAULT '[]',
      project_id TEXT, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT, superseded_by TEXT, origin_channel TEXT NOT NULL DEFAULT 'hand-asserted')""",
    """CREATE TABLE IF NOT EXISTS legacy_chunks (
      id TEXT PRIMARY KEY, paper_id TEXT, section TEXT, page INTEGER,
      chunk_index INTEGER, text TEXT, created_at TEXT)""",
    """CREATE TABLE IF NOT EXISTS legacy_claims (
      id TEXT PRIMARY KEY, paper_id TEXT, manuscript_id TEXT, claim_text TEXT,
      claim_type TEXT, evidence_quote TEXT, page INTEGER, section TEXT,
      confidence REAL, status TEXT, superseded_by TEXT, created_at TEXT, updated_at TEXT)""",
    """CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      index_text, content='chunks', content_rowid='seq',
      tokenize='unicode61 remove_diacritics 2')""",
    "CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi)",
    "CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id)",
    "CREATE INDEX IF NOT EXISTS idx_papers_bib ON papers(bibtex_key)",
    "CREATE INDEX IF NOT EXISTS idx_papers_cite_state ON papers(cite_state)",
    "CREATE INDEX IF NOT EXISTS idx_raw_paper ON raw_documents(paper_id)",
    "CREATE INDEX IF NOT EXISTS idx_sections_doc ON sections(doc_id)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_paper ON chunks(paper_id)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id)",
    "CREATE INDEX IF NOT EXISTS idx_claims_paper ON claims(paper_id)",
    "CREATE INDEX IF NOT EXISTS idx_claims_ms ON claims(manuscript_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_latest ON claims(claim_key) WHERE is_latest=1",
    "CREATE INDEX IF NOT EXISTS idx_claim_sources_chunk ON claim_sources(chunk_id)",
    "CREATE INDEX IF NOT EXISTS idx_pp_project ON paper_projects(project_key)",
    "CREATE INDEX IF NOT EXISTS idx_citations_paper ON citations(paper_id)",
    "CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_id)",
    "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
]

V2_SCHEMA = ";\n".join(V2_STATEMENTS) + ";\n"


# The version a fresh store is created at: the v2 schema plus the reference
# library tables (schema_library.py). 2000 databases migrate with
# ``papermemory migrate``.
from papermemory.schema_library import LIBRARY_SCHEMA, LIBRARY_SCHEMA_VERSION  # noqa: E402

SCHEMA_VERSION = LIBRARY_SCHEMA_VERSION
FULL_SCHEMA = V2_SCHEMA + LIBRARY_SCHEMA
