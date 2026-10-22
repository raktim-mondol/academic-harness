from __future__ import annotations

import ast
import time
from pathlib import Path

import pytest

from papermemory.corpus import ingest_markdown
from papermemory.db import Store
from papermemory.scope import canonical_project_slug
from papermemory.search_v2 import BudgetExceeded, search_with_status
from papermemory.tokenizer import fts_match, overlap, terms


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _paper(tmp_path, name, text, doi):
    path = tmp_path / name
    path.write_text(f"---\ndoi: {doi}\ntitle: {name}\nyear: 2024\n---\n" + text, encoding="utf-8")
    return path


def _seed(store, tmp_path, text, name, doi, project=None):
    return ingest_markdown(store, _paper(tmp_path, name, text, doi), project_id=project)


def test_tokenizer_symmetry_for_hyphens_and_math():
    assert terms("state-of-the-art") == ["state", "of", "the", "art"]
    assert terms("$R^2$") == ["r", "2"]
    assert terms("f_\\beta") == ["f", "beta"]
    assert overlap("state-of-the-art fine-tuning", "state of the art after fine tuning") == 1.0
    assert overlap("$R^2$", "we report $R^2$ scores") == 1.0
    match = fts_match("state-of-the-art $R^2$ f_\\beta")
    assert match and '"state"' in match and '"art"' in match and '"beta"' in match


def test_scoped_search_never_leaks(tmp_path):
    store = _store(tmp_path)
    _seed(store, tmp_path, "# A\n\n## Methods\n\nalpha unique term\n", "a.md", "10.4/a", project="proj-a")
    _seed(store, tmp_path, "# B\n\n## Methods\n\nbeta unique term\n", "b.md", "10.4/b", project="proj-b")
    hits_a = search_with_status(store, "unique term", kind="chunk", project_id="proj-a", limit=10)["results"]
    assert hits_a and all(hit["paper_id"] == hits_a[0]["paper_id"] for hit in hits_a)
    assert store.get_paper(hits_a[0]["paper_id"])["doi"] == "10.4/a"
    hits_b = search_with_status(store, "alpha", kind="chunk", project_id="proj-b", limit=10)
    assert hits_b["results"] == []
    assert hits_b["empty_reason"] in {"no-match-in-project", "all-suppressed:uncovered-span"}
    claims_a = store.add_claim_v2({"paper_id": hits_a[0]["paper_id"], "claim_text": "alpha finding", "asserted_quote": "alpha unique term", "project_key": "proj-a"})
    assert claims_a["project_key"] == "proj-a"
    recap_claims = store.conn.execute(
        "SELECT COUNT(*) FROM claims c JOIN paper_projects pp ON pp.paper_id=c.paper_id WHERE pp.project_key='proj-b'"
    ).fetchone()[0]
    assert recap_claims == 0
    dup = store.add_claim_v2({"paper_id": hits_a[0]["paper_id"], "claim_text": "a second alpha finding", "asserted_quote": "alpha unique term"})
    assert dup["project_key"] not in (None, "")
    store.close()


def test_first_scoped_ingest_creates_project_and_membership(tmp_path):
    store = _store(tmp_path)
    ingested = _seed(store, tmp_path, "# P\n\n## Methods\n\nbody\n", "p.md", "10.4/first", project="fresh-proj")
    assert store.conn.execute("SELECT 1 FROM projects WHERE key='fresh-proj'").fetchone()
    assert store.conn.execute("SELECT 1 FROM paper_projects WHERE paper_id=? AND project_key='fresh-proj'", (ingested["paper_id"],)).fetchone()
    assert store.conn.execute("SELECT COUNT(*) FROM paper_projects WHERE paper_id=?", (ingested["paper_id"],)).fetchone()[0] == 1
    store.close()


def test_canonical_project_slug(tmp_path):
    assert canonical_project_slug(tmp_path, project="Explicit Key") == "explicit-key"
    ah_root = tmp_path / "My Paper"
    ah_root.mkdir()
    (ah_root / "ah.yaml").write_text("project: {}\n")
    (ah_root / "draft.tex").write_text("x")
    assert canonical_project_slug(ah_root) == "my-paper"
    store = _store(tmp_path)
    store.upsert_manuscript({"title": "MS", "slug": "ms-slug", "root_path": str(tmp_path / "msroot")})
    (tmp_path / "msroot").mkdir(exist_ok=True)
    assert canonical_project_slug(tmp_path / "msroot", store=store) == "ms-slug"
    assert canonical_project_slug(tmp_path / "nowhere") == "unassigned"
    store.close()


def test_typed_empty_reasons(tmp_path):
    store = _store(tmp_path)
    _seed(store, tmp_path, "# P\n\n## Methods\n\nmethods body delta\n", "p.md", "10.4/empty", project="proj")
    _seed(store, tmp_path, "# C\n\n## Methods\n\ncontent body\n\n## References\n\nzzbib unique\n", "c.md", "10.4/cite", project="proj")
    store.conn.execute("INSERT INTO papers(id, identity_kind, identity_value, title, title_source, origin_channel, cite_state, created_at, updated_at) VALUES ('pap_shell','doi','10.4/shell','Chunkless Shell','caller','metadata-only','chunkless','2026-01-01','2026-01-01')")
    store.conn.execute("INSERT INTO paper_projects(paper_id, project_key, first_seen) VALUES ('pap_shell','proj','2026-01-01')")
    store.conn.commit()
    assert search_with_status(store, "zzbib unique", project_id="proj")["empty_reason"].startswith("all-suppressed:bibliography")
    assert search_with_status(store, "zzbib unique")["empty_reason"].startswith("all-suppressed:bibliography")
    assert search_with_status(store, "delta", project_id="proj")["results"]
    assert search_with_status(store, "delta", project_id="missing-project")["empty_reason"] == "project-not-found"
    status_chunkless = search_with_status(store, "chunkless shell", project_id="proj")
    assert status_chunkless["results"] == []
    assert status_chunkless["empty_reason"] in {"all-suppressed:chunkless-paper", "no-match"}
    assert search_with_status(store, "nonexistentterm")["empty_reason"] == "no-match"
    store.close()


def test_uncovered_span_reason(tmp_path):
    store = _store(tmp_path)
    ingested = _seed(store, tmp_path, "# P\n\n## Methods\n\ncovered alpha\n", "span.md", "10.4/span-case")
    doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (ingested["doc_id"],)).fetchone()
    store.conn.execute("UPDATE coverage SET uncovered_json=? WHERE doc_id=?", (f'[[0,{len(doc["text"])}]]', doc["id"]))
    store.conn.execute("DELETE FROM chunks_fts")
    store.conn.execute("DELETE FROM chunks")
    store.conn.commit()
    status = search_with_status(store, "covered alpha")
    assert status["empty_reason"] in {"all-suppressed:uncovered-span", "no-match"}
    store.close()


def test_budget_and_limit(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(BudgetExceeded) as exc:
        search_with_status(store, "x", limit=1000)
    assert exc.value.code == "budget-exceeded"
    store.close()


def _seed_scale(store, tmp_path, count=300):
    base = tmp_path / "scale"
    base.mkdir(exist_ok=True)
    for index in range(count):
        token = f"raretoken{index:03d}"
        body = (
            f"# Paper {index}\n\n## Introduction\n\nIntro {index}.\n\n"
            f"## Methods\n\nWe describe method {index} using {token}.\n\n"
            f"## Results\n\nResult {index} is {index % 17}.\n"
        )
        path = base / f"p{index}.md"
        path.write_text(f"---\ndoi: 10.5/{index}\ntitle: Scale {index}\nyear: 2024\n---\n" + body, encoding="utf-8")
        ingest_markdown(store, path, project_id="scale")


def test_true_topn_at_300_papers(tmp_path):
    store = _store(tmp_path)
    _seed_scale(store, tmp_path)
    probes = [(f"raretoken{index:03d}", index) for index in range(0, 300, 15)][:20]
    for probe, _ in probes:
        expected = [
            row["id"]
            for row in store.conn.execute(
                """SELECT c.id FROM chunks_fts JOIN chunks c ON c.seq=chunks_fts.rowid
                   JOIN sections s ON s.id=c.section_id
                   WHERE chunks_fts MATCH ? AND c.claimable=1 AND c.is_bibliography=0
                     AND EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=c.paper_id AND pp.project_key='scale')
                   ORDER BY bm25(chunks_fts) LIMIT 10""",
                (f'"{probe}"',),
            ).fetchall()
        ]
        got = [hit["id"] for hit in search_with_status(store, probe, kind="chunk", project_id="scale", limit=10)["results"]]
        assert got == expected, probe
    timings = []
    for probe, _ in probes:
        start = time.perf_counter()
        search_with_status(store, probe, kind="chunk", project_id="scale", limit=10)
        timings.append((time.perf_counter() - start) * 1000)
    timings.sort()
    p95 = timings[int(len(timings) * 0.95) - 1]
    assert p95 <= 120, f"p95 {p95:.1f}ms"
    store.close()


SQL_EXEMPT = (
    "OPTIMIZE",
    "REBUILD",
    "ORDER BY recorded_at DESC LIMIT 1",
    "ORDER BY created_at DESC LIMIT 1",
    "ORDER BY started_at DESC LIMIT 1",
    "is_current=1 LIMIT 1",
)


def test_sql_limit_guard():
    offenders = []
    for path in Path("papermemory").glob("*.py"):
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                text = node.value
                upper = text.upper()
                if "SELECT" in upper and "LIMIT" in upper:
                    if any(marker.upper() in upper for marker in SQL_EXEMPT):
                        continue
                    if "ORDER BY" not in upper:
                        offenders.append((path.name, text.strip().splitlines()[0][:100]))
    assert offenders == [], offenders
