"""Database helpers for the reference library (schema 2100).

Everything here works on an open sqlite3 connection and never commits: the
caller owns the transaction, so imports can batch and migrations stay atomic.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from typing import Any

from papermemory.util import loads, new_id, now_iso


def meta_sha256(csl: dict[str, Any], extra: dict[str, Any], entry_type: str) -> str:
    blob = json.dumps({"csl": csl, "extra": extra, "type": entry_type}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _name_from_display(name: str) -> dict[str, str]:
    """Best-effort split of an already-flattened 'Given Family' string."""
    name = (name or "").strip()
    if not name:
        return {}
    parts = name.split()
    if len(parts) == 1:
        return {"family": parts[0]}
    return {"family": parts[-1], "given": " ".join(parts[:-1])}


def csl_from_paper_row(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    """CSL-JSON for a paper known only through the eight ``papers`` columns."""
    get = row.__getitem__ if isinstance(row, sqlite3.Row) else row.get
    csl: dict[str, Any] = {"type": "article-journal" if get("venue") else "document"}
    if get("title"):
        csl["title"] = get("title")
    authors = [_name_from_display(name) for name in loads(get("authors_json"), [])]
    authors = [author for author in authors if author]
    if authors:
        csl["author"] = authors
    if get("year"):
        csl["issued"] = {"date-parts": [[int(get("year"))]]}
    if get("venue"):
        csl["container-title"] = get("venue")
    if get("doi"):
        csl["DOI"] = get("doi")
    if get("abstract"):
        csl["abstract"] = get("abstract")
    return csl


def extra_from_paper_row(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    get = row.__getitem__ if isinstance(row, sqlite3.Row) else row.get
    extra: dict[str, Any] = {}
    if get("arxiv_id"):
        extra["arxiv_id"] = get("arxiv_id")
    return extra


def free_key(conn: sqlite3.Connection, wanted: str, paper_id: str | None) -> str:
    """``wanted`` if no *other* paper owns it, else ``wantedA``, ``wantedB``, ..."""
    def owner(candidate: str) -> str | None:
        row = conn.execute("SELECT paper_id FROM bib_keys WHERE key=?", (candidate,)).fetchone()
        return row["paper_id"] if row else None

    current = owner(wanted)
    if current is None or current == paper_id:
        return wanted
    for round_number in range(1, 5):
        for letter in "abcdefghijklmnopqrstuvwxyz":
            suffix = letter * round_number
            candidate = f"{wanted}{suffix}"
            current = owner(candidate)
            if current is None or current == paper_id:
                return candidate
    raise ValueError(f"no free key for {wanted}")


def add_alias(conn: sqlite3.Connection, key: str, paper_id: str, *, project_key: str = "", source: str) -> bool:
    """Record ``key`` as a name for ``paper_id`` within ``project_key``.

    Returns False when that (key, project) already names a different paper;
    the existing mapping is kept and the caller reports the collision.
    """
    row = conn.execute(
        "SELECT paper_id FROM bib_key_aliases WHERE key=? AND project_key=?", (key, project_key)
    ).fetchone()
    if row:
        return row["paper_id"] == paper_id
    conn.execute(
        "INSERT INTO bib_key_aliases(key, project_key, paper_id, source, first_seen) VALUES (?,?,?,?,?)",
        (key, project_key, paper_id, source, now_iso()),
    )
    return True


def assign_key(
    conn: sqlite3.Connection, paper_id: str, wanted: str, *, policy: str = "imported",
) -> tuple[str, bool]:
    """Give ``paper_id`` a library key; returns (key, created).

    A paper that already has a key keeps it (keys are stable); ``created`` is
    False in that case. A key owned by another paper gets a letter suffix.
    """
    existing = conn.execute("SELECT key FROM bib_keys WHERE paper_id=?", (paper_id,)).fetchone()
    if existing:
        return existing["key"], False
    key = free_key(conn, wanted, paper_id)
    conn.execute(
        "INSERT INTO bib_keys(paper_id, key, policy, frozen, created_at) VALUES (?,?,?,0,?)",
        (paper_id, key, policy, now_iso()),
    )
    return key, True


# Records built only from the papers columns; any real import replaces them.
THIN_SOURCES = {"backfill", "ingest"}
_QUALITY_SKIP = {"id", "citation-key", "type"}
_INTERNAL_EXTRA = {"title_raw", "et_al", "year_raw", "month_raw", "date_raw", "ris_type", "ris_id", "pdf", "file"}


def record_quality(csl: dict[str, Any], extra: dict[str, Any]) -> tuple[int, int, int, int]:
    """How complete a record is: untruncated authors, author count, field count, has abstract."""
    truncated = "author" in (extra.get("et_al") or [])
    fields = sum(1 for k, v in csl.items() if k not in _QUALITY_SKIP and v) + sum(
        1 for k in extra if k not in _INTERNAL_EXTRA and not k.startswith("ris_"))
    return (0 if truncated else 1, len(csl.get("author") or []), fields, 1 if csl.get("abstract") else 0)


def record_variant(
    conn: sqlite3.Connection, paper_id: str, project_key: str, *, source: str, fmt: str, source_key: str | None,
    entry_type: str, raw_bibtex: str | None, csl: dict[str, Any], extra: dict[str, Any],
) -> bool:
    """Remember this version of the record. Identical re-imports are ignored; returns True when new."""
    cur = conn.execute(
        """INSERT OR IGNORE INTO reference_variants(id, paper_id, project_key, source, fmt, source_key, entry_type,
           raw_bibtex, csl_json, extra_json, meta_sha256, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (new_id("var"), paper_id, project_key or "", source, fmt, source_key, entry_type, raw_bibtex,
         json.dumps(csl, ensure_ascii=False, sort_keys=True), json.dumps(extra, ensure_ascii=False, sort_keys=True),
         meta_sha256(csl, extra, entry_type), now_iso()),
    )
    return bool(cur.rowcount)


def pick_canonical(
    conn: sqlite3.Connection, paper_id: str, csl: dict[str, Any], extra: dict[str, Any], entry_type: str, *,
    raw_bibtex: str | None, source: str,
) -> str:
    """Store ``csl`` as the canonical record if there is none, the stored one is a thin backfill, or it is more complete.

    Returns 'created', 'kept', or 'replaced'. The version that loses stays in ``reference_variants``.
    """
    row = conn.execute("SELECT * FROM reference_meta WHERE paper_id=?", (paper_id,)).fetchone()
    if row is None:
        return upsert_reference_meta(conn, paper_id, csl, extra, entry_type, raw_bibtex=raw_bibtex, source=source)
    old_csl, old_extra = loads(row["csl_json"], {}), loads(row["extra_json"], {})
    if row["source"] in THIN_SOURCES or record_quality(csl, extra) > record_quality(old_csl, old_extra):
        upsert_reference_meta(conn, paper_id, csl, extra, entry_type, raw_bibtex=raw_bibtex, source=source, replace=True)
        return "replaced"
    return "kept"


def upsert_reference_meta(
    conn: sqlite3.Connection,
    paper_id: str,
    csl: dict[str, Any],
    extra: dict[str, Any],
    entry_type: str,
    *,
    raw_bibtex: str | None,
    source: str,
    replace: bool = False,
) -> str:
    """Store the lossless record. Returns 'created', 'kept', or 'updated'.

    An existing record is kept unless ``replace`` is set: re-importing the same
    paper from a thinner source must not erase a richer one.
    """
    now = now_iso()
    digest = meta_sha256(csl, extra, entry_type)
    row = conn.execute("SELECT meta_sha256 FROM reference_meta WHERE paper_id=?", (paper_id,)).fetchone()
    if row is None:
        conn.execute(
            """INSERT INTO reference_meta(paper_id, csl_json, entry_type, raw_bibtex, extra_json, source,
               meta_sha256, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                paper_id, json.dumps(csl, ensure_ascii=False, sort_keys=True), entry_type, raw_bibtex,
                json.dumps(extra, ensure_ascii=False, sort_keys=True), source, digest, now, now,
            ),
        )
        return "created"
    if not replace or row["meta_sha256"] == digest:
        return "kept"
    conn.execute(
        """UPDATE reference_meta SET csl_json=?, entry_type=?, raw_bibtex=?, extra_json=?, source=?,
           meta_sha256=?, updated_at=? WHERE paper_id=?""",
        (
            json.dumps(csl, ensure_ascii=False, sort_keys=True), entry_type, raw_bibtex,
            json.dumps(extra, ensure_ascii=False, sort_keys=True), source, digest, now, paper_id,
        ),
    )
    return "updated"


def backfill_library(store: Any) -> dict[str, Any]:
    """Create a ``reference_meta`` and ``bib_keys`` row for every existing paper.

    Existing ``papers.bibtex_key`` values are never changed. If two papers
    already share a key, the older keeps it in ``bib_keys`` and the newer gets
    a suffixed library key; its original key is preserved as a project alias.
    """
    conn: sqlite3.Connection = store.conn
    papers = conn.execute("SELECT * FROM papers ORDER BY created_at, id").fetchall()
    meta_rows = key_rows = 0
    conflicts: list[dict[str, str]] = []
    for row in papers:
        csl = csl_from_paper_row(row)
        extra = extra_from_paper_row(row)
        if upsert_reference_meta(conn, row["id"], csl, extra, "misc", raw_bibtex=None, source="backfill") == "created":
            meta_rows += 1
        wanted = row["bibtex_key"]
        if not wanted:
            continue
        key, created = assign_key(conn, row["id"], wanted, policy="imported")
        if created:
            key_rows += 1
        if key != wanted:
            conflicts.append({"paper_id": row["id"], "key": wanted, "library_key": key})
        add_alias(conn, wanted, row["id"], project_key=row["project_id"] or "", source="backfill")
    return {
        "papers": len(papers), "reference_meta": meta_rows, "bib_keys": key_rows, "key_conflicts": conflicts,
    }


def merge_library_rows(conn: sqlite3.Connection, source_id: str, target_id: str, now: str) -> None:
    """Fold the source paper's library rows into the target before it is deleted."""
    has_meta = conn.execute("SELECT 1 FROM reference_meta WHERE paper_id=?", (target_id,)).fetchone()
    if not has_meta:
        conn.execute("UPDATE reference_meta SET paper_id=? WHERE paper_id=?", (target_id, source_id))
    else:
        conn.execute("DELETE FROM reference_meta WHERE paper_id=?", (source_id,))

    source_key = conn.execute("SELECT key FROM bib_keys WHERE paper_id=?", (source_id,)).fetchone()
    target_key = conn.execute("SELECT key FROM bib_keys WHERE paper_id=?", (target_id,)).fetchone()
    if source_key:
        conn.execute("DELETE FROM bib_keys WHERE paper_id=?", (source_id,))
        if target_key is None:
            conn.execute(
                "INSERT INTO bib_keys(paper_id, key, policy, frozen, created_at) "
                "VALUES (?,?, 'imported', 0, ?)", (target_id, source_key["key"], now),
            )
        else:
            add_alias(conn, source_key["key"], target_id, source="merge")
    # Aliases that pointed at the source now name the target. Where the target
    # already holds the same (key, project) the source row is simply dropped.
    for alias in conn.execute(
        "SELECT key, project_key FROM bib_key_aliases WHERE paper_id=?", (source_id,)
    ).fetchall():
        clash = conn.execute(
            "SELECT 1 FROM bib_key_aliases WHERE key=? AND project_key=? AND paper_id=?",
            (alias["key"], alias["project_key"], target_id),
        ).fetchone()
        if clash:
            conn.execute(
                "DELETE FROM bib_key_aliases WHERE key=? AND project_key=?", (alias["key"], alias["project_key"])
            )
        else:
            conn.execute(
                "UPDATE bib_key_aliases SET paper_id=?, source='merge' WHERE key=? AND project_key=?",
                (target_id, alias["key"], alias["project_key"]),
            )
    conn.execute("UPDATE OR IGNORE reference_variants SET paper_id=? WHERE paper_id=?", (target_id, source_id))
    conn.execute(
        "INSERT OR IGNORE INTO paper_tags(paper_id, tag, added_at) "
        "SELECT ?, tag, added_at FROM paper_tags WHERE paper_id=?", (target_id, source_id),
    )
    conn.execute(
        "INSERT OR IGNORE INTO collection_papers(collection_id, paper_id, ord, added_at) "
        "SELECT collection_id, ?, ord, added_at FROM collection_papers WHERE paper_id=?", (target_id, source_id),
    )
    # Notes are paper-scoped observations; they follow the surviving paper.
    conn.execute("UPDATE observations SET paper_id=? WHERE paper_id=?", (target_id, source_id))
    if not conn.execute("SELECT 1 FROM integrity WHERE paper_id=?", (target_id,)).fetchone():
        conn.execute("UPDATE integrity SET paper_id=? WHERE paper_id=?", (target_id, source_id))


def ensure_library_record(conn: sqlite3.Connection, paper_id: str) -> None:
    """Give a freshly created paper a library record and, when its metadata is good enough, a key.

    Best effort and silent: a paper with only a filename for a title gets its key later (on export or
    ``library keys assign``), when the metadata is better. Never raises, so ingest cannot be broken by it.
    """
    try:
        from papermemory.bibkeys import make_key

        row = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        if row is None:
            return
        csl, extra = csl_from_paper_row(row), extra_from_paper_row(row)
        upsert_reference_meta(conn, paper_id, csl, extra, "misc", raw_bibtex=None, source="ingest")
        if conn.execute("SELECT 1 FROM bib_keys WHERE paper_id=?", (paper_id,)).fetchone():
            return
        title = (row["title"] or "").strip()
        has_identity = bool(csl.get("author") or row["doi"] or row["arxiv_id"])
        if row["bibtex_key"]:
            assign_key(conn, paper_id, row["bibtex_key"], policy="imported")
        elif has_identity and title and title.lower() != "untitled":
            key, _ = assign_key(conn, paper_id, make_key(csl, extra), policy="generated")
            conn.execute("UPDATE papers SET bibtex_key=? WHERE id=? AND (bibtex_key IS NULL OR bibtex_key='')", (key, paper_id))
    except Exception:  # pragma: no cover - defensive: ingest must never fail because of the library
        return
