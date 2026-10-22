from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from papermemory import __version__  # noqa: F401  (doctor reports the module version)
from papermemory.audit import EVENT_OPS, LEGACY_OP_MAP
from papermemory.config import VERSION
from papermemory.db import Store
from papermemory.util import new_id, now_iso

EXPORT_SCHEMA = "pm-2"
EXPORT_TABLES = [
    "projects",
    "papers",
    "paper_aliases",
    "paper_projects",
    "raw_documents",
    "sections",
    "chunks",
    "extractions",
    "coverage",
    "claims",
    "claim_sources",
    "claims_history",
    "sweeps",
    "events",
    "ah_verdicts",
    "manuscripts",
    "manuscript_sections",
    "contributions",
    "terminology",
    "reviewer_comments",
    "citations",
    "observations",
    "lessons",
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def backup(store: Store, out_dir: Path | None = None) -> dict[str, Any]:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = Path(out_dir) if out_dir else store.path.parent / "backups" / f"phase0-{stamp}"
    target.mkdir(parents=True, exist_ok=True)
    dest = target / "papermemory.db"
    source = sqlite3.connect(f"file:{store.path}?mode=ro", uri=True)
    try:
        dest_conn = sqlite3.connect(dest)
        try:
            source.backup(dest_conn)
        finally:
            dest_conn.close()
    finally:
        source.close()
    for suffix in ("-wal", "-shm"):
        src = Path(str(store.path) + suffix)
        if src.exists():
            (target / (dest.name + suffix)).write_bytes(src.read_bytes())
    sums = []
    for name in sorted(p.name for p in target.iterdir() if p.name != "SHA256SUMS.txt"):
        path = target / name
        sums.append(f"{sha256_file(path)}  {name}  {path.stat().st_size} bytes")
    papers = sqlite3.connect(dest).execute("SELECT COUNT(*) FROM papers").fetchone()[0]
    (target / "SHA256SUMS.txt").write_text("\n".join(sums) + f"\npapers={papers}\n", encoding="utf-8")
    return {"path": str(target), "papers": papers, "files": sums}


def export_store(store: Store, out_path: Path) -> dict[str, Any]:
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tables: dict[str, list[dict[str, Any]]] = {}
    for table in EXPORT_TABLES:
        rows = store.conn.execute(f"SELECT * FROM {table}").fetchall()
        tables[table] = [dict(row) for row in rows]
    header = {
        "kind": "header",
        "schema": EXPORT_SCHEMA,
        "module_version": VERSION,
        "user_version": store.conn.execute("PRAGMA user_version").fetchone()[0],
        "created_at": now_iso(),
    }
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(header, ensure_ascii=False) + "\n")
        for table, rows in tables.items():
            for row in rows:
                handle.write(json.dumps({"kind": "row", "table": table, "data": row}, default=str, ensure_ascii=False) + "\n")
    return {"path": str(out_path), "tables": {name: len(rows) for name, rows in tables.items()}, "sha256": sha256_file(out_path)}


def restore_store(store: Store, in_path: Path, *, force: bool = False) -> dict[str, Any]:
    in_path = Path(in_path)
    with open(in_path, "r", encoding="utf-8") as handle:
        first = json.loads(handle.readline())
        if first.get("kind") != "header":
            raise ValueError("export-missing-header")
        if first.get("schema") != EXPORT_SCHEMA:
            raise ValueError(f"export-schema-mismatch: {first.get('schema')} != {EXPORT_SCHEMA}")
        rows: dict[str, list[dict[str, Any]]] = {table: [] for table in EXPORT_TABLES}
        for line in handle:
            entry = json.loads(line)
            if entry.get("kind") == "row":
                rows[entry["table"]].append(entry["data"])
    existing = store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
    if existing and not force:
        raise ValueError(f"restore-target-not-empty: {existing} papers (use --force)")
    conn = store.conn
    conn.execute("PRAGMA foreign_keys=OFF")
    try:
        conn.execute("BEGIN")
        for table in reversed(EXPORT_TABLES):
            conn.execute(f"DELETE FROM {table}")
        for table in EXPORT_TABLES:
            for row in rows[table]:
                columns = ", ".join(row)
                marks = ",".join("?" for _ in row)
                conn.execute(f"INSERT INTO {table}({columns}) VALUES ({marks})", list(row.values()))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.execute("PRAGMA foreign_keys=ON")
    return {"papers": len(rows["papers"]), "events": len(rows["events"]), "header": first}


def vacuum(store: Store) -> dict[str, Any]:
    before = store.path.stat().st_size
    store.conn.execute("VACUUM")
    return {"before_bytes": before, "after_bytes": store.path.stat().st_size}


def health_lite(store: Store) -> dict[str, Any]:
    integrity = store.conn.execute("PRAGMA integrity_check").fetchone()[0]
    fk_errors = store.conn.execute("PRAGMA foreign_key_check").fetchall()
    tables = ["papers", "raw_documents", "chunks", "claims", "manuscripts", "observations", "lessons", "events"]
    counts = {table: store.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in tables}
    audit_kind = store.conn.execute("SELECT type FROM sqlite_master WHERE name='audit'").fetchone()
    violations: dict[str, list[Any]] = {}

    def collect(name: str, sql: str, args: tuple = ()) -> None:
        rows = store.conn.execute(sql, args).fetchall()
        if rows:
            violations[name] = [row[0] for row in rows][:20]

    collect("claims_on_stale_doc", """SELECT c.id FROM claims c JOIN papers p ON p.id=c.paper_id
             WHERE c.is_latest=1 AND c.doc_id IS NOT NULL AND p.current_doc_id IS NOT c.doc_id""")
    collect("ah_verdict_stale", """SELECT v.id FROM ah_verdicts v
             JOIN raw_documents d ON d.id=v.doc_id WHERE v.raw_sha256 != d.sha256""")
    collect("duplicate_current_docs", """SELECT paper_id FROM raw_documents WHERE is_current=1
             GROUP BY paper_id HAVING COUNT(*) > 1""")
    collect("duplicate_latest_claims", """SELECT claim_key FROM claims WHERE is_latest=1
             GROUP BY claim_key HAVING COUNT(*) > 1""")
    collect("claims_project_orphan", """SELECT c.id FROM claims c LEFT JOIN projects p ON p.key=c.project_key
             WHERE p.key IS NULL""")
    collect("chunk_paper_mismatch", """SELECT c.id FROM chunks c JOIN raw_documents d ON d.id=c.doc_id
             WHERE c.paper_id != d.paper_id""")
    collect("extraction_paper_mismatch", """SELECT e.id FROM extractions e JOIN raw_documents d ON d.id=e.doc_id
             WHERE e.paper_id != d.paper_id""")
    base_count = counts["chunks"]
    try:
        index_count = store.conn.execute("SELECT COUNT(*) FROM chunks_fts_docsize").fetchone()[0]
        if index_count != base_count:
            violations["fts_mismatch"] = [index_count, base_count]
    except sqlite3.DatabaseError:
        violations.setdefault("fts_mismatch", ["docsize-unavailable"])
    bad_spans = []
    for claim in store.conn.execute(
        "SELECT id, doc_id, quote_char_start, quote_char_end, quote_sha256 FROM claims WHERE is_latest=1 AND doc_id IS NOT NULL"
    ).fetchall():
        doc = store.conn.execute("SELECT text FROM raw_documents WHERE id=?", (claim["doc_id"],)).fetchone()
        if doc is None:
            bad_spans.append(claim["id"])
            continue
        import hashlib

        if hashlib.sha256(doc["text"][claim["quote_char_start"]:claim["quote_char_end"]].encode()).hexdigest() != claim["quote_sha256"]:
            bad_spans.append(claim["id"])
    if bad_spans:
        violations["claim_span_mismatch"] = bad_spans[:20]
    return {
        "ok": not violations and integrity == "ok" and not fk_errors,
        "integrity_check": integrity,
        "foreign_key_errors": len(fk_errors),
        "counts": counts,
        "audit_object": audit_kind["type"] if audit_kind else "missing",
        "user_version": store.conn.execute("PRAGMA user_version").fetchone()[0],
        "violations": violations,
    }


def log_tail(store: Store, limit: int = 20) -> list[dict[str, Any]]:
    rows = store.conn.execute("SELECT * FROM events ORDER BY ts DESC LIMIT ?", (max(1, int(limit)),)).fetchall()
    return [dict(row) for row in rows]


def prune_events(store: Store, keep_days: int = 90) -> int:
    from datetime import datetime, timedelta, timezone

    cutoff = (datetime.now(timezone.utc) - timedelta(days=max(1, keep_days))).strftime("%Y-%m-%dT%H:%M:%SZ")
    cursor = store.conn.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
    store.conn.commit()
    return cursor.rowcount


def export_events_jsonl(store: Store, out_dir: Path) -> dict[str, Any]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    files: dict[str, int] = {}
    rows = store.conn.execute("SELECT * FROM events ORDER BY ts").fetchall()
    handles: dict[str, Any] = {}
    try:
        for row in rows:
            month = (row["ts"] or "unknown")[:7]
            handle = handles.get(month)
            if handle is None:
                handle = open(out_dir / f"events-{month}.jsonl", "w", encoding="utf-8")
                handles[month] = handle
                files[month] = 0
            handle.write(json.dumps(dict(row), default=str, ensure_ascii=False) + "\n")
            files[month] += 1
    finally:
        for handle in handles.values():
            handle.close()
    return {"directory": str(out_dir), "files": files}


def other_pids_holding(db_path: Path) -> list[int]:
    target = os.path.realpath(db_path)
    suffixes = ("", "-wal", "-shm")
    found: set[int] = set()
    proc = Path("/proc")
    if not proc.exists():
        return []
    me = os.getpid()
    for entry in proc.iterdir():
        if not entry.name.isdigit() or int(entry.name) == me:
            continue
        fd_dir = entry / "fd"
        try:
            for fd in fd_dir.iterdir():
                try:
                    link = os.readlink(fd)
                except OSError:
                    continue
                for suffix in suffixes:
                    if link == target + suffix:
                        found.add(int(entry.name))
        except (FileNotFoundError, PermissionError):
            continue
    return sorted(found)


def doctor_schema(store: Store) -> dict[str, Any]:
    import papermemory

    return {
        "db_path": str(store.path),
        "user_version": store.conn.execute("PRAGMA user_version").fetchone()[0],
        "sqlite_version": sqlite3.sqlite_version,
        "module_path": papermemory.__file__,
        "module_version": VERSION,
        "other_pids_holding_db": other_pids_holding(store.path),
        "integrity_check": store.conn.execute("PRAGMA integrity_check").fetchone()[0],
    }


def migrate(store: Store) -> dict[str, Any]:
    """Run explicit, single-writer migrations (v1 -> schema 2000)."""
    from papermemory.migrations import migrate_2000

    lock = Path(str(store.path) + ".migrate.lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise RuntimeError(f"migration-lock-held: {lock}") from exc
    try:
        holders = other_pids_holding(store.path)
        if holders:
            raise RuntimeError(f"db-in-use-by-pids: {holders}")
        store.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        result = migrate_2000(store)
        return {"changed": result["changed"], "user_version": result["user_version"]}
    finally:
        os.close(fd)
        lock.unlink(missing_ok=True)
