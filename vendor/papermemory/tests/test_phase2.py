from __future__ import annotations

import hashlib
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

from papermemory.chunker import chunk_document
from papermemory.corpus import ingest_markdown
from papermemory.db import Store
from papermemory.outline import outline
from papermemory.reindex import reindex_from_raw
from papermemory.section_roles import classify_sections, paper_profile, structure_confidence
from papermemory.search import search
from papermemory.structure import build_section_tree


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _md(tmp_path, name, body, fm="") -> Path:
    path = tmp_path / name
    path.write_text((fm + "\n" if fm else "") + body, encoding="utf-8")
    return path


PAPER = """# A Study of Things

## Abstract

We report a robust effect across sites.

## 1. Introduction

Prior work leaves a gap.

## 2. Related Work

Earlier studies report mixed results.

## 3. Methods

### 3.1 Data

We collected 120 samples.

### 3.2 Model

We fit a linear model.

## 4. Results

| Method | Acc | F1 |
| --- | --- | --- |
| A | 0.91 | 0.88 |
| B | 0.87 | 0.84 |

## 5. Discussion and Limitations

The effect is modest and site-specific.

## 6. Conclusion

We conclude the effect is real but small.

## References

[1] Smith et al. 2020. A cited title that must never flood recall.
"""


def test_structure_headings_paths_and_fences():
    text = PAPER + "\n```python\n# not a heading\nprint(1)\n```\n\n## 7. Appendix\n\nExtra.\n"
    sections = build_section_tree(text)
    headings = [s["heading"] for s in sections]
    assert "Abstract" in headings and "3.1 Data" in headings and "7. Appendix" in headings
    assert "# not a heading" not in headings
    methods = next(s for s in sections if s["heading"] == "3. Methods")
    data = next(s for s in sections if s["heading"] == "3.1 Data")
    assert data["parent_index"] == sections.index(methods)
    assert "3. Methods" in data["heading_path"] and "3.1 Data" in data["heading_path"]
    for section in sections:
        if section["heading"]:
            assert section["heading"][:10] in text[section["char_start"]:section["char_end"]][:200]
    assert any(s["is_bibliography"] for s in sections)
    assert any(s["is_abstract"] for s in sections)


def test_structure_setext_and_numbered_and_recall():
    lines = ["Title", "=====", "", "Body.", ""]
    for index in range(1, 40):
        lines += [f"{index}. Section {index}", "", f"Body {index}.", ""]
    sections = build_section_tree("\n".join(lines))
    assert len(sections) >= 39
    assert sections[0]["level"] == 1
    assert sections[0]["heading"] == "Title"


def test_roles_inheritance_combined_and_profile():
    sections = build_section_tree(PAPER)
    classify_sections(PAPER, sections)
    by_heading = {s["heading"]: s for s in sections}
    assert by_heading["2. Related Work"]["role"] == "related_work"
    assert by_heading["3. Methods"]["role"] == "method"
    assert by_heading["3.1 Data"]["role"] == "method"
    assert by_heading["3.1 Data"]["role_source"] == "inherited_parent"
    discussion = by_heading["5. Discussion and Limitations"]
    assert discussion["role"] == "discussion" and discussion["role_secondary"] == "limitations"
    assert by_heading["4. Results"]["role"] == "results"
    assert structure_confidence(sections) == "high"
    assert paper_profile(sections)["profile"] == "empirical"


def test_roles_never_fabricated_for_headingless_paper():
    text = "Just prose.\n\nMore prose with no headings.\n"
    sections = build_section_tree(text)
    classify_sections(text, sections)
    assert all(s["role"] == "unclassified" for s in sections)
    assert structure_confidence(sections) == "low"


def test_chunker_slices_tables_and_fences():
    table_rows = ["| Method | Acc | F1 |", "| --- | --- | --- |"]
    table_rows += [f"| M{i} | 0.{70 + i % 20:02d} | 0.{50 + i % 40:02d} |" for i in range(40)]
    text = "# P\n\n## Results\n\n" + "\n".join(table_rows) + "\n\n## Code\n\n```python\n# hash line\nx = 1\n```\n\nTail paragraph.\n"
    sections = build_section_tree(text)
    classify_sections(text, sections)
    chunks, uncovered, dropped = chunk_document(text, sections, target_chars=300, min_chars=100)
    raw = text.encode("utf-8")
    for chunk in chunks:
        assert raw[chunk["byte_start"]:chunk["byte_end"]].decode("utf-8") == text[chunk["char_start"]:chunk["char_end"]]
        assert hashlib.sha256(raw[chunk["byte_start"]:chunk["byte_end"]]).hexdigest() == chunk["slice_sha256"]
        if chunk.get("table_id"):
            stripped = text[chunk["char_start"]:chunk["char_end"]].lstrip()
            assert stripped.startswith("|"), "table chunk must start at a row boundary"
    table_chunks = [c for c in chunks if c.get("table_id")]
    assert len(table_chunks) >= 2
    assert all(c.get("header_span_json") for c in table_chunks)
    fence_chunks = [c for c in chunks if "```" in text[c["char_start"]:c["char_end"]] and "x = 1" in text[c["char_start"]:c["char_end"]]]
    assert fence_chunks and "# hash line" in text[fence_chunks[0]["char_start"]:fence_chunks[0]["char_end"]]
    indexed = sum(c["char_end"] - c["char_start"] for c in chunks)
    assert indexed + sum(end - start for start, end in uncovered) == len(text) - dropped


def test_ingest_v2_chunks_and_fts_single_table(tmp_path):
    store = _store(tmp_path)
    path = _md(tmp_path, "paper.md", PAPER, "---\ndoi: 10.2/roles\ntitle: Roles\nyear: 2024\n---")
    result = ingest_markdown(store, path)
    assert result["status"] == "created"
    fts_tables = [
        row["name"]
        for row in store.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'"
        )
    ]
    assert fts_tables == ["chunks_fts"]
    assert store.conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0] == result["chunks_created"]
    roles = {
        row["role"]
        for row in store.conn.execute(
            "SELECT role FROM sections WHERE doc_id=?", (result["doc_id"],)
        )
    }
    assert {"related_work", "method", "results", "discussion", "conclusion", "bibliography"} <= roles
    coverage = dict(store.conn.execute("SELECT * FROM coverage WHERE doc_id=?", (result["doc_id"],)).fetchone())
    assert coverage["chunk_count"] > 0 and coverage["section_count"] > 2
    store.close()


def test_bibliography_default_recall_and_role_filter(tmp_path):
    store = _store(tmp_path)
    path = _md(tmp_path, "paper.md", PAPER, "---\ndoi: 10.2/filter\ntitle: Filter\nyear: 2024\n---")
    ingest_markdown(store, path)
    hits = search(store, "cited title flood recall", kind="chunk", limit=10)
    assert all(hit.get("is_bibliography") == 0 for hit in hits)
    assert not any("cited title" in (hit.get("snippet") or "") for hit in hits)
    method_hits = search(store, "linear model", kind="chunk", limit=10, section_roles=["method"])
    assert method_hits and all(hit["role"] == "method" for hit in method_hits)
    before = [hit["id"] for hit in search(store, "model", kind="chunk", limit=5)]
    store.conn.execute("UPDATE sections SET role='unclassified'")
    store.conn.commit()
    after = [hit["id"] for hit in search(store, "model", kind="chunk", limit=5)]
    assert before == after
    store.close()


def test_outline_is_derived_and_deterministic(tmp_path):
    store = _store(tmp_path)
    path = _md(tmp_path, "paper.md", PAPER, "---\ndoi: 10.2/outline\ntitle: Outline\nyear: 2024\n---")
    ingested = ingest_markdown(store, path)
    sections_before = store.conn.execute("SELECT COUNT(*) FROM sections").fetchone()[0]
    first = outline(store, ingested["paper_id"])
    second = outline(store, ingested["paper_id"])
    assert json.dumps(first, sort_keys=True, default=str) == json.dumps(second, sort_keys=True, default=str)
    assert store.conn.execute("SELECT COUNT(*) FROM sections").fetchone()[0] == sections_before
    assert first["paper"]["doi"] == "10.2/outline"
    assert first["paper"]["source_filename"].endswith("paper.md")
    assert first["structure"]["profile"] == "empirical"
    assert first["structure"]["structure_confidence"] == "high"
    assert any(section["role"] == "method" for section in first["sections"])
    store.close()


def test_reindex_from_raw_is_idempotent(tmp_path):
    store = _store(tmp_path)
    path = _md(tmp_path, "paper.md", PAPER, "---\ndoi: 10.2/reindex\ntitle: Reindex\nyear: 2024\n---")
    ingested = ingest_markdown(store, path)
    count = store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    first = reindex_from_raw(store, paper_id=ingested["paper_id"])
    assert first["documents"] == 1
    assert store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == count
    assert store.conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0] == count
    assert search(store, "linear model", kind="chunk", limit=3)
    store.close()


def test_reindex_kill_resume(tmp_path):
    store = _store(tmp_path)
    for index in range(60):
        body = f"# Paper {index}\n\n## Introduction\n\nIntro {index}.\n\n## Methods\n\nMethod {index}.\n\n## Results\n\nResult {index}.\n"
        _md(tmp_path, f"p{index}.md", body, f"---\ndoi: 10.3/{index}\ntitle: Paper {index}\nyear: 2024\n---")
        ingest_markdown(store, tmp_path / f"p{index}.md")
    expected = store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    store.close()
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]), PAPERMEMORY_DB=str(tmp_path / "pm.db"))
    proc = subprocess.Popen(
        [sys.executable, "-m", "papermemory", "reindex", "--from-raw"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(0.12)
    proc.send_signal(signal.SIGKILL)
    proc.wait()
    result = subprocess.run(
        [sys.executable, "-m", "papermemory", "reindex", "--from-raw", "--json"],
        env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    store = Store(tmp_path / "pm.db")
    assert store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == expected
    assert store.conn.execute("SELECT COUNT(*) FROM chunks_fts").fetchone()[0] == expected
    assert store.conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    duplicates = store.conn.execute(
        "SELECT COUNT(*) FROM (SELECT doc_id, byte_start, byte_end, pipeline_version, COUNT(*) c FROM chunks GROUP BY 1,2,3,4 HAVING c > 1)"
    ).fetchone()[0]
    assert duplicates == 0
    store.close()
