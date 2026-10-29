"""Schema 2100: reference-library tables.

Additive only. ``papers`` is never altered, so every pre-2100 query keeps
working. ``papers.bibtex_key`` stays and is kept equal to ``bib_keys.key`` by
the library code wherever the two can agree.
"""
from __future__ import annotations

LIBRARY_SCHEMA_VERSION = 2100

LIBRARY_STATEMENTS = [
    # Lossless bibliographic record: CSL-JSON plus every field CSL has no home
    # for, and the original BibTeX entry verbatim when one was imported.
    """CREATE TABLE IF NOT EXISTS reference_meta (
      paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
      csl_json TEXT NOT NULL,
      entry_type TEXT NOT NULL DEFAULT 'misc',
      raw_bibtex TEXT,
      extra_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      meta_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL)""",
    # Every version of a record that was imported, per project. The canonical
    # record lives in reference_meta; a project's own .bib can still be
    # reproduced from its variant.
    """CREATE TABLE IF NOT EXISTS reference_variants (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      project_key TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      fmt TEXT NOT NULL,
      source_key TEXT,
      entry_type TEXT NOT NULL,
      raw_bibtex TEXT,
      csl_json TEXT NOT NULL,
      extra_json TEXT NOT NULL DEFAULT '{}',
      meta_sha256 TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE(paper_id, project_key, meta_sha256))""",
    # The library-wide unique citation key of a paper.
    """CREATE TABLE IF NOT EXISTS bib_keys (
      paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
      key TEXT NOT NULL UNIQUE,
      policy TEXT NOT NULL DEFAULT 'imported',
      frozen INTEGER NOT NULL DEFAULT 0,
      frozen_at TEXT,
      frozen_in TEXT,
      created_at TEXT NOT NULL)""",
    # Every key ever seen for a paper, scoped to the project whose .bib used it
    # ('' = library-wide). Two projects may legitimately use one key for two
    # different papers, so the primary key includes the project.
    """CREATE TABLE IF NOT EXISTS bib_key_aliases (
      key TEXT NOT NULL,
      project_key TEXT NOT NULL DEFAULT '',
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      PRIMARY KEY(key, project_key))""",
    """CREATE TABLE IF NOT EXISTS paper_tags (
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY(paper_id, tag))""",
    """CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      parent_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
      project_key TEXT REFERENCES projects(key) ON DELETE SET NULL,
      bib_path TEXT,
      created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS collection_papers (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      PRIMARY KEY(collection_id, paper_id))""",
    # Retraction / correction status written by the harness's integrity check.
    """CREATE TABLE IF NOT EXISTS integrity (
      paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      source TEXT,
      notice_doi TEXT,
      checked_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_bib_aliases_paper ON bib_key_aliases(paper_id)",
    "CREATE INDEX IF NOT EXISTS idx_variants_paper ON reference_variants(paper_id, project_key)",
    "CREATE INDEX IF NOT EXISTS idx_paper_tags_tag ON paper_tags(tag)",
    "CREATE INDEX IF NOT EXISTS idx_collection_papers_paper ON collection_papers(paper_id)",
]

LIBRARY_SCHEMA = ";\n".join(LIBRARY_STATEMENTS) + ";\n"

LIBRARY_TABLES = [
    "reference_meta",
    "reference_variants",
    "bib_keys",
    "bib_key_aliases",
    "paper_tags",
    "collections",
    "collection_papers",
    "integrity",
]
