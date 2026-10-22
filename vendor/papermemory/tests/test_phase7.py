from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from papermemory import mcp_server
from papermemory.corpus import ingest_markdown
from papermemory.db import Store

EXPECTED_TOOLS = [
    "papermemory_search", "papermemory_ingest", "papermemory_get", "papermemory_cite",
    "papermemory_cite_check", "papermemory_remember", "papermemory_claim", "papermemory_recap",
    "papermemory_lesson", "papermemory_quote_check", "papermemory_trace",
    "papermemory_register_to_ah", "papermemory_outline", "papermemory_list",
]

BODY = """# P

## Methods

We used a sample of 120 participants in the trial.

## Results

The effect was 0.41 with a confidence interval.
"""


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _ingest(store, tmp_path, name="p.md", doi="10.20/a", converter=None, origin=None):
    path = tmp_path / name
    path.write_text(f"---\ndoi: {doi}\ntitle: Phase7\nyear: 2024\nbibtex_key: key7\n---\n" + BODY, encoding="utf-8")
    return ingest_markdown(store, path, project_id="proj", converter=converter, origin_channel=origin)


def _call(monkeypatch, tmp_path, name, args):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    return mcp_server._call(name, args)


def test_tools_golden_surface():
    names = [tool["name"] for tool in mcp_server.TOOLS]
    assert names == EXPECTED_TOOLS


def test_search_payload_and_absence(monkeypatch, tmp_path):
    store = _store(tmp_path)
    _ingest(store, tmp_path)
    result = _call(monkeypatch, tmp_path, "papermemory_search", {"query": "sample participants", "project": "proj", "limit": 5})
    payload = json.loads(result["content"][0]["text"])
    assert set(["results", "legs", "empty_reason", "suppressed", "corpus_match_count", "coverage", "absence_scope", "scope", "truncated"]) <= payload.keys()
    assert payload["results"]
    absent = _call(monkeypatch, tmp_path, "papermemory_search", {"query": "nonexistentterm", "project": "proj"})
    assert json.loads(absent["content"][0]["text"])["empty_reason"] == "no-match"
    bad = _call(monkeypatch, tmp_path, "papermemory_search", {"query": "x", "limit": 1000})
    assert bad["isError"] and json.loads(bad["content"][0]["text"])["code"] == "budget-exceeded"
    store.close()


def test_get_payload_materializes_evidence(monkeypatch, tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    claim = store.add_claim_v2({"paper_id": ingested["paper_id"], "claim_text": "Trial size.", "asserted_quote": "We used a sample of 120 participants"})
    result = _call(monkeypatch, tmp_path, "papermemory_get", {"key": ingested["paper_id"], "max_chars": 500})
    payload = json.loads(result["content"][0]["text"])
    assert payload["claims"][0]["evidence_quote"] == "We used a sample of 120 participants"
    assert payload["claims"][0]["doc_sha16"]
    assert payload["chunks"] and payload["totals"]["chunks"] >= len(payload["chunks"])
    assert payload["paper"]["doi"] == "10.20/a"
    store.close()


def test_cite_payload_and_support(monkeypatch, tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    claim = store.add_claim_v2({"paper_id": ingested["paper_id"], "claim_text": "Trial size.", "asserted_quote": "We used a sample of 120 participants"})
    from papermemory.grounding import verify_claim

    verify_claim(store, claim["id"])
    result = _call(monkeypatch, tmp_path, "papermemory_cite", {"query": "trial participants", "project": "proj"})
    hits = json.loads(result["content"][0]["text"])
    assert hits and hits[0]["supports_statement"] is True
    assert hits[0]["claims"][0]["status"] == "verified"
    assert "degradation" in hits[0]
    store.close()


def test_cite_check_gaps_and_locators(monkeypatch, tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    root = tmp_path / "ms"
    (root / "sections").mkdir(parents=True)
    (root / "sections" / "intro.tex").write_text("Text \\cite{key7}.\n", encoding="utf-8")
    store.upsert_manuscript({"title": "MS", "slug": "proj", "root_path": str(root)})
    result = _call(monkeypatch, tmp_path, "papermemory_cite_check", {"manuscript": "proj"})
    report = json.loads(result["content"][0]["text"])
    assert report["cited_keys"] == ["key7"]
    assert report["locators_persisted"] >= 1
    assert report["claim_gaps"] and report["claim_gaps"][0]["key"] == "key7"
    store.close()


def test_remember_forwards_and_lesson_supersede(monkeypatch, tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    ms = store.upsert_manuscript({"title": "MS", "slug": "proj"})
    remembered = _call(monkeypatch, tmp_path, "papermemory_remember", {
        "content": "decision", "paper": ingested["paper_id"], "manuscript": ms["id"], "project": "proj",
    })
    rec = json.loads(remembered["content"][0]["text"])
    assert rec["paper_id"] == ingested["paper_id"] and rec["manuscript_id"] == ms["id"]
    first = store.add_lesson("rule one", project_id="proj")
    second = store.add_lesson("rule two", project_id="proj")
    _call(monkeypatch, tmp_path, "papermemory_lesson", {"content": "x", "action": "supersede", "target_lesson_id": first["id"], "superseded_by": second["id"]})
    row = store.conn.execute("SELECT status, superseded_by FROM lessons WHERE id=?", (first["id"],)).fetchone()
    assert row["status"] == "superseded" and row["superseded_by"] == second["id"]
    store.close()


def test_outline_and_list_tools(monkeypatch, tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    outline = json.loads(_call(monkeypatch, tmp_path, "papermemory_outline", {"key": ingested["paper_id"]})["content"][0]["text"])
    assert outline["paper"]["doi"] == "10.20/a" and outline["sections"]
    listed = json.loads(_call(monkeypatch, tmp_path, "papermemory_list", {"kind": "papers", "project": "proj"})["content"][0]["text"])
    assert listed["total_count"] == 1 and listed["rows"][0]["id"] == ingested["paper_id"]
    store.close()


def test_sandbox_escape_refused(monkeypatch, tmp_path):
    store = _store(tmp_path)
    result = _call(monkeypatch, tmp_path, "papermemory_ingest", {"path": "/etc/passwd"})
    assert result["isError"] is True
    assert json.loads(result["content"][0]["text"])["code"] == "path-escape"
    inside = tmp_path / "ok.md"
    inside.write_text("---\ndoi: 10.20/ok\ntitle: OK\n---\n# OK\n\nbody\n", encoding="utf-8")
    ok = _call(monkeypatch, tmp_path, "papermemory_ingest", {"path": str(inside), "project": "proj"})
    payload = json.loads(ok["content"][0]["text"])
    assert payload["status"] == "created" and payload["doc"]["sha256"]
    store.close()


def test_ocr_channel_cap_through_ingest(monkeypatch, tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path, converter={"pdf_type": "scanned", "confidence": 0.31, "pages_needing_ocr": [2, 3]})
    doc = store.conn.execute("SELECT origin_channel FROM raw_documents WHERE id=?", (ingested["doc_id"],)).fetchone()
    assert doc["origin_channel"] == "ocr-recovered"
    result = _call(monkeypatch, tmp_path, "papermemory_claim", {
        "text": "Trial size.", "evidence": "We used a sample of 120 participants", "paper": ingested["paper_id"],
    })
    claim = json.loads(result["content"][0]["text"])["claim"]
    assert claim["status"] == "extracted" and claim["status_reason"] == "channel-capped:ocr-recovered"
    store.close()


def test_300_file_dir_ingest_resumes_with_duplicate_noop(tmp_path):
    store = _store(tmp_path)
    base = tmp_path / "corpus300"
    base.mkdir()
    for index in range(300):
        (base / f"p{index}.md").write_text(
            f"---\ndoi: 10.21/{index}\ntitle: Dir {index}\nyear: 2024\n---\n"
            f"# D{index}\n\n## Methods\n\nBody {index}.\n",
            encoding="utf-8",
        )
    store.close()
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]), PAPERMEMORY_DB=str(tmp_path / "pm.db"))
    cli = [sys.executable, "-m", "papermemory", "ingest", str(base), "--kind", "dir", "--json"]
    first = subprocess.run(cli, env=env, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    first_payload = json.loads(first.stdout)
    assert first_payload["count"] == 300
    second = subprocess.run(cli, env=env, capture_output=True, text=True)
    assert second.returncode == 0, second.stderr
    second_payload = json.loads(second.stdout)
    statuses = [item.get("status") for item in second_payload["items"]]
    assert statuses.count("duplicate-noop") == 300
    store = Store(tmp_path / "pm.db")
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 300
    assert store.conn.execute("SELECT COUNT(*) FROM raw_documents").fetchone()[0] == 300
    store.close()
