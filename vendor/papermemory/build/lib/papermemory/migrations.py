from __future__ import annotations

import sqlite3

from papermemory.schema_v2 import SCHEMA_VERSION, V2_STATEMENTS
from papermemory.util import dumps, normalize_arxiv, normalize_doi, normalize_title, now_iso


def _object_type(conn, name: str):
    row = conn.execute("SELECT type FROM sqlite_master WHERE name=?", (name,)).fetchone()
    return row[0] if row else None


def _columns(conn, name: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({name})")}


def _add_column(conn, table: str, column: str, ddl: str) -> None:
    if column not in _columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def _paper_identity(row) -> tuple[str, str, str]:
    doi = normalize_doi(row["doi"])
    if doi:
        return "doi", doi, "chunkless"
    arxiv = normalize_arxiv(row["arxiv_id"])
    if arxiv:
        return "arxiv_id", arxiv, "chunkless"
    if row["pmid"]:
        return "pmid", str(row["pmid"]).strip(), "chunkless"
    if row["title"]:
        return "title_year", f"{normalize_title(row['title'])}|{row['year'] or ''}", "chunkless"
    return "legacy_id", row["id"], "identity-unresolved"


def migrate_2000(store) -> dict:
    conn: sqlite3.Connection = store.conn
    user_version = conn.execute("PRAGMA user_version").fetchone()[0]
    if user_version >= SCHEMA_VERSION:
        return {"changed": False, "user_version": user_version}
    conn.execute("PRAGMA foreign_keys=OFF")
    legacy_audit_rows: list[dict] = []
    try:
        audit_type = _object_type(conn, "audit")
        if audit_type == "table":
            legacy_audit_rows = [dict(row) for row in conn.execute("SELECT * FROM audit")]
        conn.execute("BEGIN")
        if audit_type == "view":
            conn.execute("DROP VIEW audit")
        elif audit_type == "table":
            conn.execute("DROP TABLE audit")

        for source, target in (
            ("papers", "papers_v1"),
            ("chunks", "chunks_v1"),
            ("claims", "claims_v1"),
        ):
            if _object_type(conn, source) == "table" and _object_type(conn, target) is None:
                conn.execute(f"ALTER TABLE {source} RENAME TO {target}")
        if _object_type(conn, "events") == "table" and "created_at" in _columns(conn, "events"):
            conn.execute("ALTER TABLE events RENAME TO events_v0")

        for statement in V2_STATEMENTS:
            conn.execute(statement)

        # Legacy copies are plain tables: renaming the v1 tables would keep
        # their FK references to the renamed papers table and poison
        # foreign_key_check after the rebuild.
        if _object_type(conn, "chunks_v1") == "table":
            conn.execute(
                "INSERT INTO legacy_chunks(id, paper_id, section, page, chunk_index, text, created_at) "
                "SELECT id, paper_id, section, page, chunk_index, text, created_at FROM chunks_v1"
            )
            conn.execute("DROP TABLE chunks_v1")
        if _object_type(conn, "claims_v1") == "table":
            conn.execute(
                "INSERT INTO legacy_claims(id, paper_id, manuscript_id, claim_text, claim_type, evidence_quote, page, section, confidence, status, superseded_by, created_at, updated_at) "
                "SELECT id, paper_id, manuscript_id, claim_text, claim_type, evidence_quote, page, section, confidence, status, superseded_by, created_at, updated_at FROM claims_v1"
            )
            conn.execute("DROP TABLE claims_v1")

        for table, additions in (
            ("manuscripts", [("ah_project_key", "TEXT")]),
            ("observations", [
                ("status", "TEXT NOT NULL DEFAULT 'active'"),
                ("updated_at", "TEXT"),
                ("origin_channel", "TEXT NOT NULL DEFAULT 'hand-asserted'"),
            ]),
            ("lessons", [
                ("status", "TEXT NOT NULL DEFAULT 'active'"),
                ("updated_at", "TEXT"),
                ("superseded_by", "TEXT"),
                ("origin_channel", "TEXT NOT NULL DEFAULT 'hand-asserted'"),
            ]),
        ):
            for column, ddl in additions:
                _add_column(conn, table, column, ddl)

        now = now_iso()
        conn.execute(
            "INSERT OR IGNORE INTO projects(key, title, kind, ah_root, created_at) VALUES ('unassigned','Unassigned','manuscript',NULL,?)",
            (now,),
        )
        if _object_type(conn, "papers_v1") == "table":
            seen: set[tuple[str, str]] = set()
            for row in conn.execute("SELECT * FROM papers_v1").fetchall():
                kind, value, cite_state = _paper_identity(row)
                if (kind, value) in seen:
                    kind, value, cite_state = "legacy_id", row["id"], "identity-unresolved"
                seen.add((kind, value))
                project_id = row["project_id"]
                if project_id:
                    conn.execute(
                        "INSERT OR IGNORE INTO projects(key, title, kind, ah_root, created_at) VALUES (?,?, 'manuscript', NULL, ?)",
                        (project_id, project_id, now),
                    )
                conn.execute(
                    """INSERT INTO papers(id, identity_kind, identity_value, title, title_source,
                       authors_json, year, venue, doi, arxiv_id, bibtex_key, origin_channel,
                       cite_state, current_doc_id, pdf_path, source_type, verified, project_id,
                       created_at, updated_at)
                       VALUES (?,?,?,?, 'legacy', ?,?,?,?,?,?, 'metadata-only', ?, NULL, ?, ?, ?, ?, ?, ?)""",
                    (
                        row["id"], kind, value, row["title"] or "Untitled",
                        row["authors_json"] or "[]", row["year"], row["venue"],
                        normalize_doi(row["doi"]), normalize_arxiv(row["arxiv_id"]),
                        row["bibtex_key"], cite_state, row["pdf_path"], row["source_type"],
                        row["verified"], project_id, row["created_at"] or now, row["updated_at"] or now,
                    ),
                )
                if project_id:
                    conn.execute(
                        "INSERT OR IGNORE INTO paper_projects(paper_id, project_key, first_seen) VALUES (?,?,?)",
                        (row["id"], project_id, now),
                    )
            conn.execute("DROP TABLE papers_v1")

        def insert_event(event_id, op, paper_id, doc_id, claim_id, detail, ts):
            if op not in {
                "INGEST", "DERIVE", "INDEX_REBUILD", "CLAIM_WRITE", "CLAIM_TRANSITION",
                "DOC_SUPERSEDE", "IDENTITY_PROMOTE", "PROJECT_ENSURE", "AH_REGISTER",
                "LEDGER_EXPORT", "VERDICT_IMPORT", "MIGRATION", "SWEEP", "MERGE", "BIND",
                "REPAIR", "DELETE", "CITE_CHECK", "REMEMBER", "LESSON_WRITE", "MANUSCRIPT_WRITE",
            }:
                op = "MIGRATION"
            conn.execute(
                "INSERT OR IGNORE INTO events(id, ts, op, paper_id, doc_id, claim_id, project_key, status, reason_code, detail) VALUES (?,?,?,?,?,?,NULL,'ok','',?)",
                (event_id, ts or now, op, paper_id, doc_id, claim_id, detail),
            )

        if _object_type(conn, "events_v0") == "table":
            for row in conn.execute("SELECT * FROM events_v0").fetchall():
                paper_id = row["target_id"] if "paper_id" in row.keys() else None
                doc_id = None
                claim_id = None
                target_type = row["target_type"] if "target_type" in row.keys() else None
                if target_type == "paper":
                    paper_id = row["target_id"]
                elif target_type == "document":
                    doc_id = row["target_id"]
                elif target_type == "claim":
                    claim_id = row["target_id"]
                    paper_id = None
                insert_event(row["id"], row["op"], paper_id, doc_id, claim_id, row["detail"], row["created_at"] if "created_at" in row.keys() else row["ts"])
            conn.execute("DROP TABLE events_v0")

        for row in legacy_audit_rows:
            mapping = {"paper_create": "INGEST", "claim_create": "CLAIM_WRITE", "manuscript_create": "MANUSCRIPT_WRITE", "remember": "REMEMBER"}
            op = mapping.get(row["operation"], "MIGRATION")
            paper_id = row["target_id"] if row["target_type"] == "paper" else None
            claim_id = row["target_id"] if row["target_type"] == "claim" else None
            insert_event(row["id"], op, paper_id, None, claim_id, row["detail"], row["created_at"])

        # Legacy chunk/claim text is not promoted; the v2 index is built from
        # chunks_fts (PaperMemory v2 §3.2).
        for legacy in ("search_map", "search_fts"):
            if _object_type(conn, legacy) == "table":
                conn.execute(f"DROP TABLE {legacy}")

        conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise RuntimeError(
                "migration-foreign-key-violations: "
                + repr([tuple(row) for row in violations[:10]])
            )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.execute("PRAGMA foreign_keys=ON")
    return {"changed": True, "user_version": SCHEMA_VERSION}
