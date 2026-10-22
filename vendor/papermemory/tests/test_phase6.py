from __future__ import annotations

import json
from pathlib import Path

from papermemory import claims as claimlib
from papermemory.context import recap
from papermemory.corpus import ingest_markdown
from papermemory.db import Store
from papermemory.listing import list_rows
from papermemory.ops import export_events_jsonl, health_lite, log_tail, prune_events


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _paper(tmp_path, name, text, doi, project=None, store=None):
    path = tmp_path / name
    path.write_text(f"---\ndoi: {doi}\ntitle: {name}\nyear: 2024\n---\n" + text, encoding="utf-8")
    return ingest_markdown(store, path, project_id=project)


def test_recap_budget_stable_volatile_and_scope_stats(tmp_path):
    store = _store(tmp_path)
    _paper(tmp_path, "a.md", "# A\n\n## Methods\n\nWe used a sample of 120 participants.\n", "10.13/a", "alpha", store)
    _paper(tmp_path, "b.md", "# B\n\n## Methods\n\nA different study.\n", "10.13/b", "beta", store)
    alpha = store.conn.execute("SELECT id FROM papers WHERE doi='10.13/a'").fetchone()[0]
    claimlib.add_claim(store, text="Alpha claim.", asserted_quote="We used a sample of 120 participants", paper_id=alpha)
    store.remember("alpha decision " + "x" * 3500, project_id="alpha", tier="episodic")
    store.remember("alpha semantic rule", project_id="alpha", tier="semantic")
    store.add_lesson("alpha durable rule", project_id="alpha")
    store.upsert_manuscript({"title": "Alpha MS", "slug": "alpha", "root_path": str(tmp_path)})
    result = recap(store, "alpha", max_chars=6000)
    assert len(json.dumps(result, default=str)) <= 6000
    assert "stable" in result and "volatile" in result
    assert result["scope_stats"]["papers"] == 1
    assert result["scope_stats"]["claims"] == 1
    assert result["scope_stats"]["cite_state"].get("citable") == 1
    assert result["global_stats"]["papers"] == 2
    assert any(item["claim_text"] == "Alpha claim." for item in result["claims"])
    assert all(item.get("paper_id") == alpha for item in result["claims"])
    observations = result["observations"]
    assert observations and observations[0]["tier"] == "semantic"
    assert any(item.get("truncated") for item in observations if item["tier"] == "episodic")
    store.close()


def test_recap_300_papers_under_6k(tmp_path):
    store = _store(tmp_path)
    base = tmp_path / "scale"
    base.mkdir()
    for index in range(300):
        path = base / f"p{index}.md"
        path.write_text(
            f"---\ndoi: 10.14/{index}\ntitle: Scale {index}\nyear: 2024\n---\n"
            f"# P{index}\n\n## Methods\n\n" + ("body text " * 40) + "\n",
            encoding="utf-8",
        )
        ingest_markdown(store, path, project_id="scale")
    result = recap(store, "scale", max_chars=6000)
    assert len(json.dumps(result, default=str)) <= 6000
    assert result.get("hint") or result.get("truncated")
    assert result["scope_stats"]["papers"] == 300
    store.close()


def test_recap_wrong_slug_and_9th_lesson(tmp_path):
    store = _store(tmp_path)
    _paper(tmp_path, "a.md", "# A\n\nbody\n", "10.15/a", "proj", store)
    store.upsert_manuscript({"title": "P", "slug": "proj", "root_path": str(tmp_path)})
    for index in range(9):
        store.add_lesson(f"durable rule {index}", project_id="proj")
    result = recap(store, "proj")
    contents = [item["content"] for item in result["lessons"]]
    assert "durable rule 8" in contents
    missing = recap(store, "does-not-exist")
    assert missing["empty_reason"] == "project-not-found"
    assert "known_projects" in missing and "proj" in missing["known_projects"]
    store.close()


def test_catalog_counts_match_sql(tmp_path):
    store = _store(tmp_path)
    _paper(tmp_path, "a.md", "# A\n\n## Methods\n\nWe used a sample of 120 participants.\n", "10.16/a", "proj", store)
    alpha = store.conn.execute("SELECT id FROM papers WHERE doi='10.16/a'").fetchone()[0]
    claimlib.add_claim(store, text="Claim one.", asserted_quote="We used a sample of 120 participants", paper_id=alpha)
    catalog = claimlib.write_catalog(store, "proj")
    data = json.loads(Path(catalog["json"]).read_text())
    entry = data["projects"]["proj"]
    assert entry["papers"] == store.conn.execute("SELECT COUNT(*) FROM papers WHERE project_id='proj'").fetchone()[0]
    assert entry["claims"] == store.conn.execute("SELECT COUNT(*) FROM claims WHERE paper_id=?", (alpha,)).fetchone()[0]
    assert entry["chunks"] == store.conn.execute("SELECT COUNT(*) FROM chunks WHERE paper_id=?", (alpha,)).fetchone()[0]
    store.close()


def test_log_tail_and_prune(tmp_path):
    store = _store(tmp_path)
    _paper(tmp_path, "a.md", "# A\n\nbody\n", "10.17/a", "proj", store)
    store.conn.execute(
        "INSERT INTO events(id, ts, op, status, reason_code, detail) VALUES ('evt_old','2020-01-01T00:00:00Z','MIGRATION','ok','','old')"
    )
    store.conn.commit()
    tail = log_tail(store, limit=2)
    assert len(tail) == 2 and tail[0]["ts"] >= tail[1]["ts"]
    removed = prune_events(store, keep_days=90)
    assert removed >= 1
    assert store.conn.execute("SELECT COUNT(*) FROM events WHERE id='evt_old'").fetchone()[0] == 0
    files = export_events_jsonl(store, tmp_path / "ev")
    assert files["files"]
    store.close()


def test_list_kinds_and_chunkless(tmp_path):
    store = _store(tmp_path)
    _paper(tmp_path, "a.md", "# A\n\n## Methods\n\nbody\n", "10.18/a", "proj", store)
    alpha = store.conn.execute("SELECT id FROM papers WHERE doi='10.18/a'").fetchone()[0]
    shell, _ = store.upsert_paper_v2("doi", "10.18/shell", "Shell", "caller", fields={"doi": "10.18/shell"}, metadata_only=True)
    store.add_membership(shell, "proj")
    store.add_lesson("lesson one", project_id="proj")
    papers = list_rows(store, "papers", project="proj")
    assert papers["total_count"] == 2
    claims = list_rows(store, "claims", project="proj")
    assert claims["total_count"] == 0
    lessons = list_rows(store, "lessons", project="proj")
    assert lessons["total_count"] == 1
    coverage = list_rows(store, "coverage", project="proj")
    assert coverage["rollup"]["docs"] == 1
    assert coverage["chunkless_papers"] == [shell]
    store.close()


def test_health_detects_violations(tmp_path):
    store = _store(tmp_path)
    _paper(tmp_path, "a.md", "# A\n\n## Methods\n\nWe used a sample of 120 participants.\n", "10.19/a", "proj", store)
    alpha = store.conn.execute("SELECT id FROM papers WHERE doi='10.19/a'").fetchone()[0]
    claim = claimlib.add_claim(store, text="Claim.", asserted_quote="We used a sample of 120 participants", paper_id=alpha)["claim"]
    store.conn.execute("UPDATE claims SET quote_sha256='deadbeef' WHERE id=?", (claim["id"],))
    doc = store.conn.execute("SELECT * FROM raw_documents WHERE paper_id=?", (alpha,)).fetchone()
    store.conn.execute(
        "INSERT INTO ah_verdicts(id, claim_id, doc_id, raw_sha256, char_start, char_end, verdict, prompt_version, ledger_sha256, recorded_at) VALUES ('v1',?,?, 'wrong',0,1,'SUPPORTED','p','l','2026')",
        (claim["id"], doc["id"]),
    )
    store.conn.execute("DELETE FROM chunks_fts WHERE rowid=(SELECT seq FROM chunks LIMIT 1)")
    store.conn.commit()
    report = health_lite(store)
    assert report["ok"] is False
    violations = report["violations"]
    assert any("quote" in key or "span" in key for key in violations)
    assert "ah_verdict_stale" in violations
    assert "fts_mismatch" in violations
    store.close()
