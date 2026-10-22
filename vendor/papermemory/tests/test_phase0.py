from __future__ import annotations

import json
import os

import pytest

from papermemory.audit import EVENT_OPS
from papermemory.db import SchemaTooNew, Store
from papermemory.corpus import ingest_markdown
from papermemory.ops import (
    backup, doctor_schema, export_events_jsonl, export_store, restore_store,
)
from papermemory import mcp_server


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _count(store: Store) -> int:
    return store.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]


def test_fresh_store_uses_events_and_audit_view(tmp_path):
    store = _store(tmp_path)
    types = {
        row["name"]: row["type"]
        for row in store.conn.execute("SELECT name, type FROM sqlite_master WHERE name IN ('events','audit')")
    }
    assert types == {"events": "table", "audit": "view"}
    assert store.conn.execute("PRAGMA user_version").fetchone()[0] == 2000
    store.close()


def test_schema_too_new_refused(tmp_path):
    import sqlite3

    path = tmp_path / "newer.db"
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA user_version=2001")
    conn.commit()
    conn.close()
    with pytest.raises(SchemaTooNew) as exc:
        Store(path)
    assert exc.value.code == "schema-too-new"


def test_mut_one_event_per_call_and_rollback(tmp_path):
    store = _store(tmp_path)
    for op in EVENT_OPS:
        before = _count(store)
        store.mut(op, detail="x")
        assert _count(store) == before + 1
    store.conn.rollback()
    assert store.conn.execute("SELECT COUNT(*) FROM events WHERE detail='x'").fetchone()[0] == 0
    with pytest.raises(ValueError):
        store.mut("NOT_AN_OP")
    store.close()


def test_each_mutator_emits_its_op(tmp_path):
    store = _store(tmp_path)
    store.upsert_paper_v2("title_year", "p|2020", "P", "caller", fields={"year": 2020})
    md = tmp_path / "m.md"
    md.write_text("# P\n\n## Methods\n\na claim body\n", encoding="utf-8")
    ingested = ingest_markdown(store, md)
    paper_id = ingested["paper_id"]
    ms = store.upsert_manuscript({"title": "M", "slug": "m"})
    cases = [
        ("INGEST", lambda: store.upsert_paper_v2("title_year", "p2|2021", "P2", "caller", fields={"year": 2021})),
        ("CLAIM_WRITE", lambda: store.add_claim_v2({"paper_id": paper_id, "claim_text": "a claim", "asserted_quote": "a claim body"})),
        ("PROJECT_ENSURE", lambda: store.ensure_project("proj")),
        ("IDENTITY_PROMOTE", lambda: store.promote_identity(paper_id, "pmid", "123")),
        ("MANUSCRIPT_WRITE", lambda: store.upsert_manuscript({"title": "M", "slug": "m"})),
        ("MANUSCRIPT_WRITE", lambda: store.replace_sections(ms["id"], [{"name": "Intro"}])),
        ("MANUSCRIPT_WRITE", lambda: store.replace_contributions(ms["id"], ["c"])),
        ("MANUSCRIPT_WRITE", lambda: store.add_term(ms["id"], "term")),
        ("MANUSCRIPT_WRITE", lambda: store.add_reviewer_comment(ms["id"], "fix")),
        ("REMEMBER", lambda: store.remember("a decision")),
        ("LESSON_WRITE", lambda: store.add_lesson("a rule")),
    ]
    for expected, call in cases:
        before = _count(store)
        call()
        assert _count(store) == before + 1
        assert store.conn.execute("SELECT op FROM events ORDER BY rowid DESC LIMIT 1").fetchone()[0] == expected
    store.close()


def test_backup_export_restore_roundtrip(tmp_path):
    store = _store(tmp_path)
    md = tmp_path / "b.md"
    md.write_text("# B\n\n## Methods\n\nbacked up claim text\n", encoding="utf-8")
    ingested = ingest_markdown(store, md)
    store.add_claim_v2({"paper_id": ingested["paper_id"], "claim_text": "c1", "asserted_quote": "backed up claim text"})

    result = backup(store, tmp_path / "bk")
    assert result["papers"] == 1
    assert (tmp_path / "bk" / "SHA256SUMS.txt").exists()

    out = tmp_path / "export.jsonl"
    exported = export_store(store, out)
    assert exported["tables"]["papers"] == 1
    header = json.loads(out.read_text().splitlines()[0])
    assert header["kind"] == "header" and header["schema"] == "pm-2"

    target = _store(tmp_path / "target")
    restored = restore_store(target, out)
    assert restored["papers"] == 1
    assert target.conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0] == 1
    assert target.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] >= 2

    bad = tmp_path / "bad.jsonl"
    bad.write_text(json.dumps({"kind": "header", "schema": "pm-1"}) + "\n")
    with pytest.raises(ValueError, match="export-schema-mismatch"):
        restore_store(target, bad, force=True)
    store.close()
    target.close()


def test_doctor_schema_reports_runtime(tmp_path):
    store = _store(tmp_path)
    report = doctor_schema(store)
    assert report["user_version"] == 2000
    assert report["db_path"].endswith("pm.db")
    assert report["sqlite_version"]
    assert report["module_version"]
    assert isinstance(report["other_pids_holding_db"], list)
    store.close()


def test_events_jsonl_export(tmp_path):
    store = _store(tmp_path)
    store.remember("note")
    result = export_events_jsonl(store, tmp_path / "ev")
    assert result["files"]
    assert any(name.startswith("events-") for name in os.listdir(tmp_path / "ev"))
    store.close()


def test_mcp_errors_are_iserror(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    unknown = mcp_server._call("nope", {})
    assert unknown["isError"] is True
    assert json.loads(unknown["content"][0]["text"])["code"] == "unknown-tool"

    missing = mcp_server._call("papermemory_get", {"key": "absent"})
    assert missing["isError"] is True
    assert json.loads(missing["content"][0]["text"])["code"] == "paper-not-found"

    poisoned = tmp_path / "poison.db"
    poisoned.write_bytes(b"not a database")
    monkeypatch.setenv("PAPERMEMORY_DB", str(poisoned))
    broken = mcp_server._call("papermemory_search", {"query": "x"})
    assert broken["isError"] is True
    assert json.loads(broken["content"][0]["text"])["code"] == "store-unavailable"
