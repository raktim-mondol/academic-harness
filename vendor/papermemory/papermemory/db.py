from __future__ import annotations

import hashlib
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

from papermemory.audit import EVENT_OPS
from papermemory.config import db_path, ensure_dirs
from papermemory.schema_v2 import SCHEMA_VERSION, V2_SCHEMA
from papermemory.util import (
    dumps, loads, new_id, normalize_arxiv, normalize_doi, normalize_title, now_iso,
)

SCHEMA_TOO_NEW_AT = SCHEMA_VERSION + 1
MIN_SQLITE = (3, 43)
TITLE_PRECEDENCE = {
    "frontmatter": 4, "crossref": 3, "arxiv": 3, "h1": 2, "caller": 1, "filename": 0, "legacy": -1,
}
IDENTITY_PRECEDENCE = {"doi": 4, "arxiv_id": 3, "pmid": 2, "title_year": 1, "legacy_id": 0}


class StoreError(Exception):
    code = "store-error"


class SchemaTooNew(StoreError):
    code = "schema-too-new"


class StoreUnavailable(StoreError):
    code = "store-unavailable"


class MigrationRequired(StoreError):
    code = "migration-required"


class IdentityConflict(StoreError):
    code = "identity-conflict"


class MergeStructuralMismatch(StoreError):
    code = "merge-structural-mismatch"


def _sha_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def claim_key(paper_id: str, norm_text: str, quote_sha256: str) -> str:
    return _sha_text(f"{paper_id}|{norm_text}|{quote_sha256}")[:16]


class Store:
    def __init__(self, path: Path | None = None):
        if sqlite3.sqlite_version_info < MIN_SQLITE:
            raise StoreUnavailable(
                f"sqlite {sqlite3.sqlite_version} below runtime floor "
                f"{'.'.join(str(part) for part in MIN_SQLITE)}"
            )
        ensure_dirs()
        self.path = Path(path) if path else db_path()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = None
        try:
            self.conn = sqlite3.connect(str(self.path))
            self.conn.row_factory = sqlite3.Row
            self.conn.execute("PRAGMA foreign_keys=ON")
            user_version = self.conn.execute("PRAGMA user_version").fetchone()[0]
            if user_version >= SCHEMA_TOO_NEW_AT:
                raise SchemaTooNew(
                    f"db user_version={user_version} is newer than this binary supports"
                )
            if user_version < SCHEMA_VERSION:
                if self._object_exists("papers"):
                    raise MigrationRequired(
                        f"db user_version={user_version}; run `papermemory migrate`"
                    )
                self.conn.executescript(V2_SCHEMA)
                self.conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                self.conn.commit()
            elif not self._object_exists("events"):
                self.conn.executescript(V2_SCHEMA)
                self.conn.executescript("PRAGMA user_version=%d" % SCHEMA_VERSION)
                self.conn.commit()
            self._bootstrap_search_index()
            self.conn.execute(
                "INSERT OR IGNORE INTO projects(key, title, kind, created_at) VALUES ('unassigned','Unassigned','manuscript',?)",
                (now_iso(),),
            )
            self.conn.commit()
            self._bootstrap_claims_schema()
        except sqlite3.DatabaseError as exc:
            if self.conn is not None:
                self.conn.close()
            raise StoreUnavailable(str(exc)) from exc

    def _connect_raw(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")

    @classmethod
    def connect_for_migration(cls, path: Path) -> "Store":
        store = cls.__new__(cls)
        store._connect_raw(path)
        return store

    def _object_exists(self, name: str) -> bool:
        return self.conn.execute("SELECT 1 FROM sqlite_master WHERE name=?", (name,)).fetchone() is not None

    def _bootstrap_claims_schema(self) -> None:
        if not self._object_exists("claims"):
            return
        fks = self.conn.execute("PRAGMA foreign_key_list(claims)").fetchall()
        has_project_fk = any(row["from"] == "project_key" for row in fks)
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_latest ON claims(claim_key) WHERE is_latest=1"
        )
        if has_project_fk:
            self.conn.commit()
            return
        self.conn.execute("PRAGMA foreign_keys=OFF")
        try:
            self.conn.execute("BEGIN")
            self.conn.execute(
                "INSERT OR IGNORE INTO projects(key, title, kind, created_at) "
                "SELECT DISTINCT project_key, project_key, 'manuscript', ? FROM claims WHERE project_key IS NOT NULL",
                (now_iso(),),
            )
            self.conn.execute(
                "UPDATE claims SET is_latest=0 WHERE is_latest=1 AND seq NOT IN "
                "(SELECT MAX(seq) FROM claims WHERE is_latest=1 GROUP BY claim_key)"
            )
            self.conn.execute(
                """CREATE TABLE claims_v4 (
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
                  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"""
            )
            self.conn.execute(
                """INSERT INTO claims_v4(seq, id, claim_key, paper_id, manuscript_id, project_key,
                   claim_text, claim_text_norm, claim_type, asserted_quote, quote_char_start,
                   quote_char_end, quote_line_start, quote_line_end, quote_sha256, doc_id,
                   primary_section_id, source_sha256, origin_channel, pipeline_version,
                   extraction_event_id, status, status_reason, confidence, is_latest,
                   supersedes, superseded_by, ah_binding_ref, created_at, updated_at)
                   SELECT seq, id, claim_key, paper_id, manuscript_id, COALESCE(project_key,'unassigned'),
                   claim_text, claim_text_norm, claim_type, asserted_quote, quote_char_start,
                   quote_char_end, quote_line_start, quote_line_end, quote_sha256, doc_id,
                   primary_section_id, source_sha256, origin_channel, pipeline_version,
                   extraction_event_id, status, status_reason, confidence, is_latest,
                   supersedes, superseded_by, ah_binding_ref, created_at, updated_at FROM claims"""
            )
            self.conn.execute("DROP TABLE claims")
            self.conn.execute("ALTER TABLE claims_v4 RENAME TO claims")
            self.conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_latest ON claims(claim_key) WHERE is_latest=1"
            )
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        finally:
            self.conn.execute("PRAGMA foreign_keys=ON")

    def _bootstrap_search_index(self) -> None:
        if not self._object_exists("chunks_fts"):
            self.conn.execute(
                """CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                   index_text, content='chunks', content_rowid='seq',
                   tokenize='unicode61 remove_diacritics 2')"""
            )
            for legacy in ("search_map", "search_fts"):
                if self._object_exists(legacy):
                    self.conn.execute(f"DROP TABLE {legacy}")
            if self.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]:
                self.conn.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
            self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def mut(
        self,
        op: str,
        *,
        paper_id: str | None = None,
        doc_id: str | None = None,
        claim_id: str | None = None,
        project_key: str | None = None,
        status: str = "ok",
        reason_code: str = "",
        detail: str | None = None,
    ) -> None:
        if op not in EVENT_OPS:
            raise ValueError(f"unknown event op: {op}")
        self.conn.execute(
            """INSERT INTO events(id, ts, op, paper_id, doc_id, claim_id, project_key, status, reason_code, detail)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (new_id("evt"), now_iso(), op, paper_id, doc_id, claim_id, project_key, status, reason_code, detail),
        )

    # ---------- identity ----------

    def _identity_owner(self, kind: str, value: str, exclude: str | None = None) -> str | None:
        row = self.conn.execute(
            "SELECT id FROM papers WHERE identity_kind=? AND identity_value=?", (kind, value)
        ).fetchone()
        if row and row["id"] != exclude:
            return row["id"]
        row = self.conn.execute(
            "SELECT paper_id FROM paper_aliases WHERE kind=? AND value=?", (kind, value)
        ).fetchone()
        if row and row["paper_id"] != exclude:
            return row["paper_id"]
        return None

    def _add_alias(self, kind: str, value: str, paper_id: str) -> None:
        if not value:
            return
        self.conn.execute(
            "INSERT OR IGNORE INTO paper_aliases(kind, value, paper_id, first_seen) VALUES (?,?,?,?)",
            (kind, value, paper_id, now_iso()),
        )

    def ensure_project(self, key: str, title: str | None = None, kind: str = "manuscript", ah_root: str | None = None) -> None:
        self.conn.execute(
            "INSERT OR IGNORE INTO projects(key, title, kind, ah_root, created_at) VALUES (?,?,?,?,?)",
            (key, title or key, kind, ah_root, now_iso()),
        )
        self.mut("PROJECT_ENSURE", project_key=key, detail=key)

    def add_membership(self, paper_id: str, project_key: str) -> None:
        self.ensure_project(project_key)
        self.conn.execute(
            "INSERT OR IGNORE INTO paper_projects(paper_id, project_key, first_seen) VALUES (?,?,?)",
            (paper_id, project_key, now_iso()),
        )

    def upsert_paper_v2(
        self,
        kind: str,
        value: str,
        title: str,
        title_source: str,
        *,
        fields: dict[str, Any] | None = None,
        project_key: str | None = None,
        metadata_only: bool = False,
    ) -> tuple[str, str]:
        fields = dict(fields or {})
        now = now_iso()
        title = (title or "Untitled").strip() or "Untitled"
        row = self.conn.execute(
            "SELECT * FROM papers WHERE identity_kind=? AND identity_value=?", (kind, value)
        ).fetchone()
        state = "merged" if row else "created"
        if row is None and not metadata_only and kind in {"doi", "arxiv_id", "pmid"}:
            for candidate in self.conn.execute(
                "SELECT * FROM papers WHERE lower(trim(title))=lower(trim(?)) ORDER BY created_at LIMIT 5",
                (title,),
            ):
                if candidate["identity_kind"] == "title_year" and self._identity_owner(kind, value) is None:
                    row = candidate
                    state = "merged"
                    break
        if row is None:
            owner = self._identity_owner(kind, value)
            if owner:
                raise IdentityConflict(f"identity owned by {owner}: {kind}={value}")
            paper_id = new_id("pap")
            self.conn.execute(
                """INSERT INTO papers(id, identity_kind, identity_value, title, title_source,
                   authors_json, year, venue, doi, arxiv_id, bibtex_key, abstract, origin_channel,
                   cite_state, current_doc_id, pdf_path, source_type, verified, project_id,
                   created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'chunkless', NULL,?,?,?,?,?,?)""",
                (
                    paper_id, kind, value, title, title_source,
                    fields.get("authors_json") or "[]", fields.get("year"), fields.get("venue"),
                    normalize_doi(fields.get("doi")), normalize_arxiv(fields.get("arxiv_id")),
                    fields.get("bibtex_key"), fields.get("abstract"),
                    fields.get("origin_channel") or "hand-asserted",
                    fields.get("pdf_path"), fields.get("source_type"),
                    int(fields.get("verified") or 0), project_key, now, now,
                ),
            )
        else:
            paper_id = row["id"]
            current_identity = (row["identity_kind"], row["identity_value"])
            if current_identity != (kind, value):
                owner = self._identity_owner(kind, value, exclude=paper_id)
                if owner:
                    raise IdentityConflict(f"identity owned by {owner}: {kind}={value}")
                if IDENTITY_PRECEDENCE.get(kind, 0) > IDENTITY_PRECEDENCE.get(row["identity_kind"], 0):
                    self._add_alias(row["identity_kind"], row["identity_value"], paper_id)
                    self.conn.execute(
                        "UPDATE papers SET identity_kind=?, identity_value=?, updated_at=? WHERE id=?",
                        (kind, value, now, paper_id),
                    )
            updates: dict[str, Any] = {}
            if TITLE_PRECEDENCE.get(title_source, 0) >= TITLE_PRECEDENCE.get(row["title_source"], -1):
                if title and title != "Untitled":
                    if not metadata_only or row["title"] in (None, "", "Untitled"):
                        updates["title"] = title
                        updates["title_source"] = title_source
            for column in ("authors_json", "year", "venue", "bibtex_key", "abstract", "pdf_path", "source_type", "origin_channel"):
                incoming = fields.get(column)
                if incoming in (None, "", "[]"):
                    continue
                if metadata_only and row[column] not in (None, "", "[]"):
                    continue
                if column == "origin_channel" and row["origin_channel"] == "verbatim":
                    continue
                updates[column] = incoming
            for column in ("doi", "arxiv_id"):
                incoming = normalize_doi(fields.get("doi")) if column == "doi" else normalize_arxiv(fields.get("arxiv_id"))
                if incoming:
                    updates[column] = incoming
            if fields.get("verified"):
                updates["verified"] = 1
            if project_key and not row["project_id"]:
                updates["project_id"] = project_key
            if updates:
                updates["updated_at"] = now
                assignments = ", ".join(f"{column}=?" for column in updates)
                self.conn.execute(
                    f"UPDATE papers SET {assignments} WHERE id=?",
                    (*updates.values(), paper_id),
                )
        for alias_kind, alias_value in (
            ("doi", normalize_doi(fields.get("doi"))),
            ("arxiv_id", normalize_arxiv(fields.get("arxiv_id"))),
            ("pmid", (fields.get("pmid") or "").strip() or None),
        ):
            if alias_value:
                owner = self._identity_owner(alias_kind, alias_value, exclude=paper_id)
                if owner:
                    raise IdentityConflict(f"identity owned by {owner}: {alias_kind}={alias_value}")
                self._add_alias(alias_kind, alias_value, paper_id)
        if project_key:
            self.add_membership(paper_id, project_key)
        self.mut("INGEST", paper_id=paper_id, project_key=project_key, status=state, detail=title[:200])
        self.conn.commit()
        return paper_id, state

    def promote_identity(self, paper_id: str, kind: str, value: str) -> dict[str, Any]:
        row = self.conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not row:
            raise ValueError("paper-not-found")
        if (row["identity_kind"], row["identity_value"]) == (kind, value):
            return {"paper_id": paper_id, "kind": kind, "value": value}
        owner = self._identity_owner(kind, value, exclude=paper_id)
        if owner:
            raise IdentityConflict(f"identity owned by {owner}: {kind}={value}")
        self._add_alias(row["identity_kind"], row["identity_value"], paper_id)
        self.conn.execute(
            "UPDATE papers SET identity_kind=?, identity_value=?, updated_at=? WHERE id=?",
            (kind, value, now_iso(), paper_id),
        )
        self.mut("IDENTITY_PROMOTE", paper_id=paper_id, detail=f"{row['identity_kind']}->{kind}")
        self.conn.commit()
        return {"paper_id": paper_id, "kind": kind, "value": value}

    # ---------- read ----------

    def _resolve_paper_row(self, key: str):
        row = self.conn.execute("SELECT * FROM papers WHERE id=?", (key,)).fetchone()
        if row:
            return row
        row = self.conn.execute("SELECT * FROM papers WHERE bibtex_key=?", (key,)).fetchone()
        if row:
            return row
        for kind, value in (("doi", normalize_doi(key)), ("arxiv_id", normalize_arxiv(key))):
            if value:
                row = self.conn.execute(
                    "SELECT * FROM papers WHERE identity_kind=? AND identity_value=?", (kind, value)
                ).fetchone()
                if row:
                    return row
        row = self.conn.execute(
            "SELECT p.* FROM paper_aliases a JOIN papers p ON p.id=a.paper_id WHERE a.value=?", (key,)
        ).fetchone()
        if row:
            return row
        row = self.conn.execute("SELECT * FROM papers WHERE identity_value=?", (key,)).fetchone()
        return row

    def get_paper(self, key: str) -> dict[str, Any] | None:
        row = self._resolve_paper_row(key)
        if not row:
            return None
        record = dict(row)
        record["authors"] = loads(record.get("authors_json"), [])
        return record

    def list_claims(self, paper_id: str | None = None, manuscript_id: str | None = None, status: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM claims WHERE is_latest=1"
        args: list[Any] = []
        if paper_id:
            sql += " AND paper_id=?"
            args.append(paper_id)
        if manuscript_id:
            sql += " AND manuscript_id=?"
            args.append(manuscript_id)
        if status:
            sql += " AND status=?"
            args.append(status)
        else:
            sql += " AND status != 'contradicted'"
        sql += " ORDER BY created_at DESC"
        return [dict(row) for row in self.conn.execute(sql, args)]

    def get_claim(self, claim_id: str) -> dict[str, Any]:
        return dict(self.conn.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone())

    def paper_chunks(self, paper_id: str, limit: int | None = None) -> list[dict[str, Any]]:
        sql = """SELECT c.id, c.chunk_index, c.char_start, c.char_end, c.byte_start, c.byte_end,
                        c.index_text, s.heading_path AS section, r.text
                 FROM chunks c JOIN raw_documents r ON r.id=c.doc_id
                 JOIN sections s ON s.id=c.section_id
                 WHERE c.paper_id=? ORDER BY c.chunk_index"""
        if limit:
            sql += f" LIMIT {int(limit)}"
        return [dict(row) for row in self.conn.execute(sql, (paper_id,))]

    # ---------- claims ----------

    def add_claim_v2(self, data: dict[str, Any]) -> dict[str, Any]:
        from papermemory.claims import add_claim

        result = add_claim(
            self,
            text=data.get("claim_text") or "",
            asserted_quote=data.get("asserted_quote") or data.get("evidence_quote") or "",
            paper_id=data.get("paper_id"),
            project_key=data.get("project_key"),
            chunk_ids=data.get("chunk_ids"),
            claim_type=data.get("claim_type") or "finding",
            manuscript_id=data.get("manuscript_id"),
            actor=data.get("actor") or "agent",
        )
        return result["claim"]

    # ---------- merge ----------

    def merge_papers(self, source_id: str, target_id: str) -> dict[str, Any]:
        if source_id == target_id:
            return {"merged": False}
        source = self.conn.execute("SELECT * FROM papers WHERE id=?", (source_id,)).fetchone()
        target = self.conn.execute("SELECT * FROM papers WHERE id=?", (target_id,)).fetchone()
        if not source or not target:
            raise ValueError("paper-not-found")
        now = now_iso()
        self.conn.execute("SAVEPOINT merge")
        try:
            for row in self.conn.execute(
                "SELECT project_key, first_seen FROM paper_projects WHERE paper_id=?", (source_id,)
            ).fetchall():
                self.conn.execute(
                    "INSERT OR IGNORE INTO paper_projects(paper_id, project_key, first_seen) VALUES (?,?,?)",
                    (target_id, row["project_key"], row["first_seen"]),
                )
            self.conn.execute("DELETE FROM paper_projects WHERE paper_id=?", (source_id,))
            self._add_alias(source["identity_kind"], source["identity_value"], target_id)
            self.conn.execute("UPDATE paper_aliases SET paper_id=? WHERE paper_id=?", (target_id, source_id))
            self.conn.execute("UPDATE papers SET current_doc_id=NULL WHERE id IN (?,?)", (source_id, target_id))
            target_docs = {
                row["sha256"]: row
                for row in self.conn.execute("SELECT * FROM raw_documents WHERE paper_id=?", (target_id,))
            }
            for doc in self.conn.execute(
                "SELECT * FROM raw_documents WHERE paper_id=?", (source_id,)
            ).fetchall():
                twin = target_docs.get(doc["sha256"])
                if twin:
                    if twin["pipeline_version"] != doc["pipeline_version"]:
                        raise MergeStructuralMismatch(doc["id"])
                    section_map: dict[str, str] = {}
                    for section in self.conn.execute(
                        "SELECT * FROM sections WHERE doc_id=?", (doc["id"],)
                    ).fetchall():
                        match = self.conn.execute(
                            "SELECT id FROM sections WHERE doc_id=? AND char_start=? AND level=? AND heading_path=?",
                            (twin["id"], section["char_start"], section["level"], section["heading_path"]),
                        ).fetchone()
                        if not match:
                            raise MergeStructuralMismatch(section["id"])
                        section_map[section["id"]] = match["id"]
                    for chunk in self.conn.execute(
                        "SELECT * FROM chunks WHERE doc_id=?", (doc["id"],)
                    ).fetchall():
                        match = self.conn.execute(
                            "SELECT id FROM chunks WHERE doc_id=? AND byte_start=? AND byte_end=? AND pipeline_version=?",
                            (twin["id"], chunk["byte_start"], chunk["byte_end"], chunk["pipeline_version"]),
                        ).fetchone()
                        if not match:
                            raise MergeStructuralMismatch(chunk["id"])
                        self.conn.execute(
                            "INSERT OR IGNORE INTO claim_sources(claim_id, chunk_id, ord) "
                            "SELECT claim_id, ?, ord FROM claim_sources WHERE chunk_id=?",
                            (match["id"], chunk["id"]),
                        )
                        self.conn.execute("DELETE FROM claim_sources WHERE chunk_id=?", (chunk["id"],))
                    for old_section, new_section in section_map.items():
                        self.conn.execute(
                            "UPDATE claims SET primary_section_id=? WHERE primary_section_id=?",
                            (new_section, old_section),
                        )
                    self.conn.execute("UPDATE claims SET doc_id=? WHERE doc_id=?", (twin["id"], doc["id"]))
                    self.conn.execute("DELETE FROM raw_documents WHERE id=?", (doc["id"],))
                else:
                    self.conn.execute(
                        "UPDATE raw_documents SET paper_id=?, is_current=0 WHERE id=?", (target_id, doc["id"])
                    )
                    self.conn.execute("UPDATE chunks SET paper_id=? WHERE doc_id=?", (target_id, doc["id"]))
                    self.conn.execute("UPDATE extractions SET paper_id=? WHERE doc_id=?", (target_id, doc["id"]))
            for claim in self.conn.execute(
                "SELECT * FROM claims WHERE paper_id=?", (source_id,)
            ).fetchall():
                new_key = claim_key(target_id, claim["claim_text_norm"], claim["quote_sha256"])
                collision = self.conn.execute(
                    "SELECT id FROM claims WHERE claim_key=? AND is_latest=1 AND paper_id!=?",
                    (new_key, claim["id"]),
                ).fetchone()
                if collision:
                    self.conn.execute(
                        "UPDATE claims SET is_latest=0, superseded_by=?, updated_at=? WHERE id=?",
                        (collision["id"], now, claim["id"]),
                    )
                    self.conn.execute(
                        "INSERT INTO claims_history(id, claim_id, event, old_status, new_status, old_claim_text, new_claim_text, old_doc_id, new_doc_id, actor, reason, at) "
                        "VALUES (?,?,'supersede',?,?,?,?,?,?,?,?,?)",
                        (new_id("csh"), claim["id"], claim["status"], claim["status"], claim["claim_text"], claim["claim_text"], claim["doc_id"], claim["doc_id"], "merge", "claim_key collision", now),
                    )
                self.conn.execute(
                    "UPDATE claims SET paper_id=?, claim_key=?, project_key=COALESCE(project_key, ?), updated_at=? WHERE id=?",
                    (target_id, new_key, target.get("project_id"), now, claim["id"]),
                )
            self.conn.execute("UPDATE citations SET paper_id=? WHERE paper_id=?", (target_id, source_id))
            self.conn.execute("UPDATE sweeps SET paper_id=? WHERE paper_id=?", (target_id, source_id))
            self.conn.execute("DELETE FROM papers WHERE id=?", (source_id,))
            current = self.conn.execute(
                "SELECT id FROM raw_documents WHERE paper_id=? AND is_current=1 LIMIT 1", (target_id,)
            ).fetchone()
            if not current:
                latest = self.conn.execute(
                    "SELECT id FROM raw_documents WHERE paper_id=? ORDER BY created_at DESC LIMIT 1",
                    (target_id,),
                ).fetchone()
                if latest:
                    self.conn.execute("UPDATE raw_documents SET is_current=1 WHERE id=?", (latest["id"],))
                    current = latest
            self.conn.execute(
                "UPDATE papers SET current_doc_id=?, cite_state=CASE WHEN ? IS NULL THEN 'chunkless' ELSE 'citable' END WHERE id=?",
                (current["id"] if current else None, current["id"] if current else None, target_id),
            )
            self.mut("MERGE", paper_id=target_id, detail=f"from:{source_id}")
            self.conn.execute("RELEASE merge")
            self.conn.commit()
        except Exception:
            self.conn.execute("ROLLBACK TO merge")
            self.conn.execute("RELEASE merge")
            raise
        return {"merged": True, "from": source_id, "into": target_id}

    # ---------- manuscripts / notes ----------

    def upsert_manuscript(self, data: dict[str, Any]) -> dict[str, Any]:
        slug = data["slug"]
        now = now_iso()
        existing = self.conn.execute("SELECT * FROM manuscripts WHERE slug=?", (slug,)).fetchone()
        if existing:
            ms_id = existing["id"]
            self.conn.execute(
                """UPDATE manuscripts SET title=?, target_venue=?, citation_style=?, root_path=?,
                   ah_project_key=?, status=?, notes=?, updated_at=? WHERE slug=?""",
                (
                    data.get("title") or existing["title"],
                    data.get("target_venue") if data.get("target_venue") is not None else existing["target_venue"],
                    data.get("citation_style") if data.get("citation_style") is not None else existing["citation_style"],
                    data.get("root_path") if data.get("root_path") is not None else existing["root_path"],
                    data.get("ah_project_key") if data.get("ah_project_key") is not None else existing["ah_project_key"],
                    data.get("status") or existing["status"],
                    data.get("notes") if data.get("notes") is not None else existing["notes"],
                    now, slug,
                ),
            )
        else:
            ms_id = new_id("ms")
            self.conn.execute(
                """INSERT INTO manuscripts(id, title, slug, target_venue, citation_style, root_path,
                   ah_project_key, status, notes, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    ms_id, data["title"], slug, data.get("target_venue"),
                    data.get("citation_style"), data.get("root_path"), data.get("ah_project_key"),
                    data.get("status") or "draft", data.get("notes"), now, now,
                ),
            )
        self.mut("MANUSCRIPT_WRITE", detail=f"manuscript:{slug}")
        self.conn.commit()
        return self.get_manuscript(slug)

    def get_manuscript(self, slug_or_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM manuscripts WHERE slug=? OR id=?", (slug_or_id, slug_or_id)
        ).fetchone()
        return dict(row) if row else None

    def replace_sections(self, manuscript_id: str, sections: list[dict[str, Any]]) -> None:
        self.conn.execute("DELETE FROM manuscript_sections WHERE manuscript_id=?", (manuscript_id,))
        now = now_iso()
        for section in sections:
            self.conn.execute(
                """INSERT INTO manuscript_sections(id, manuscript_id, name, path, word_target, word_count, status, notes, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (new_id("sec"), manuscript_id, section["name"], section.get("path"), section.get("word_target"), section.get("word_count"), section.get("status"), section.get("notes"), now),
            )
        self.mut("MANUSCRIPT_WRITE", detail=f"sections:{len(sections)}")
        self.conn.commit()

    def replace_contributions(self, manuscript_id: str, items: list[str]) -> None:
        self.conn.execute("DELETE FROM contributions WHERE manuscript_id=?", (manuscript_id,))
        now = now_iso()
        for index, text in enumerate(items):
            if not text.strip():
                continue
            self.conn.execute(
                "INSERT INTO contributions(id, manuscript_id, text, order_index, created_at) VALUES (?,?,?,?,?)",
                (new_id("con"), manuscript_id, text.strip(), index, now),
            )
        self.mut("MANUSCRIPT_WRITE", detail=f"contributions:{len(items)}")
        self.conn.commit()

    def add_term(self, manuscript_id: str, canonical: str, avoid: list[str] | None = None, notes: str | None = None) -> None:
        existing = self.conn.execute(
            "SELECT id FROM terminology WHERE manuscript_id=? AND canonical=?", (manuscript_id, canonical)
        ).fetchone()
        if existing:
            return
        self.conn.execute(
            "INSERT INTO terminology(id, manuscript_id, canonical, avoid_json, notes) VALUES (?,?,?,?,?)",
            (new_id("trm"), manuscript_id, canonical, dumps(avoid or []), notes),
        )
        self.mut("MANUSCRIPT_WRITE", detail=f"term:{canonical}")
        self.conn.commit()

    def add_reviewer_comment(self, manuscript_id: str, comment: str, reviewer: str | None = None) -> dict[str, Any]:
        cid = new_id("rev")
        self.conn.execute(
            "INSERT INTO reviewer_comments(id, manuscript_id, reviewer, comment, status, created_at) VALUES (?,?,?,?,'open',?)",
            (cid, manuscript_id, reviewer, comment, now_iso()),
        )
        self.mut("MANUSCRIPT_WRITE", detail=f"reviewer_comment:{cid}")
        self.conn.commit()
        return dict(self.conn.execute("SELECT * FROM reviewer_comments WHERE id=?", (cid,)).fetchone())

    def remember(self, content: str, concepts: Iterable[str] | None = None, **kwargs: Any) -> dict[str, Any]:
        oid = new_id("obs")
        now = now_iso()
        concepts_list = [c.strip().lower() for c in (concepts or []) if c and c.strip()]
        self.conn.execute(
            """INSERT INTO observations(id, tier, content, concepts_json, project_id, manuscript_id, paper_id,
               confidence, created_at, updated_at, status, superseded_by, origin_channel)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                oid, kwargs.get("tier") or "semantic", content.strip(), dumps(concepts_list),
                kwargs.get("project_id"), kwargs.get("manuscript_id"), kwargs.get("paper_id"),
                kwargs.get("confidence", 0.7), now, now, kwargs.get("status") or "active",
                kwargs.get("superseded_by"), kwargs.get("origin_channel") or "hand-asserted",
            ),
        )
        self.mut("REMEMBER", project_key=kwargs.get("project_id"), detail=content[:200])
        self.conn.commit()
        return dict(self.conn.execute("SELECT * FROM observations WHERE id=?", (oid,)).fetchone())

    def add_lesson(self, content: str, concepts: Iterable[str] | None = None, project_id: str | None = None) -> dict[str, Any]:
        lid = new_id("les")
        concepts_list = [c.strip().lower() for c in (concepts or []) if c and c.strip()]
        project_key = project_id or "unassigned"
        self.conn.execute(
            "INSERT OR IGNORE INTO projects(key, title, kind, created_at) VALUES (?,?, 'manuscript', ?)",
            (project_key, project_key, now_iso()),
        )
        self.conn.execute(
            "INSERT INTO lessons(id, content, concepts_json, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (lid, content.strip(), dumps(concepts_list), project_key, now_iso(), now_iso()),
        )
        self.mut("LESSON_WRITE", project_key=project_id, detail=content[:200])
        self.conn.commit()
        return dict(self.conn.execute("SELECT * FROM lessons WHERE id=?", (lid,)).fetchone())

    # ---------- v1 compatibility wrappers ----------

    def upsert_paper(self, data: dict[str, Any]) -> dict[str, Any]:
        doi = normalize_doi(data.get("doi"))
        arxiv = normalize_arxiv(data.get("arxiv_id"))
        if doi:
            kind, value = "doi", doi
        elif arxiv:
            kind, value = "arxiv_id", arxiv
        elif data.get("pmid"):
            kind, value = "pmid", str(data["pmid"]).strip()
        else:
            kind, value = "title_year", f"{normalize_title(data.get('title') or 'Untitled')}|{data.get('year') or ''}"
        fields = {
            key: data.get(key)
            for key in ("doi", "arxiv_id", "pmid", "year", "venue", "bibtex_key", "abstract", "pdf_path", "source_type", "origin_channel")
        }
        fields["authors_json"] = dumps(data.get("authors") or [])
        fields["verified"] = data.get("verified")
        paper_id, _ = self.upsert_paper_v2(
            kind, value, data.get("title") or "Untitled", "caller", fields=fields, metadata_only=True
        )
        return self.get_paper(paper_id)

    def add_claim(self, data: dict[str, Any]) -> dict[str, Any]:
        return self.add_claim_v2(data)

    # ---------- chunk FTS ----------

    def index_chunk(self, seq: int, index_text: str) -> None:
        self.conn.execute(
            "INSERT INTO chunks_fts(rowid, index_text) VALUES (?,?)", (seq, index_text)
        )

    def unindex_chunk(self, seq: int, index_text: str) -> None:
        self.conn.execute(
            "INSERT INTO chunks_fts(chunks_fts, rowid, index_text) VALUES ('delete',?,?)",
            (seq, index_text),
        )

    def neighbors(self, node_type: str, node_id: str, limit: int = 20) -> list[dict[str, Any]]:
        return []

    def stats(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for table in ("papers", "raw_documents", "chunks", "claims", "manuscripts", "observations", "lessons", "events"):
            out[table] = self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        out["verified_papers"] = self.conn.execute("SELECT COUNT(*) FROM papers WHERE verified=1").fetchone()[0]
        out["unverified_papers"] = self.conn.execute("SELECT COUNT(*) FROM papers WHERE verified=0").fetchone()[0]
        out["chunkless_papers"] = self.conn.execute("SELECT COUNT(*) FROM papers WHERE cite_state='chunkless'").fetchone()[0]
        return out
