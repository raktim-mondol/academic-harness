from __future__ import annotations

from papermemory.corpus import ingest_markdown
from papermemory.db import Store
from papermemory.reindex import reindex_from_raw
from papermemory.search_v2 import search_with_status
from papermemory.structure import build_section_tree

BODY = "The classifier was trained on labelled spoil imagery and evaluated on held out sites. " * 40
REFS = "1. Smith J. Quokka telemetry in alpine habitats. J Ecol 2019. " * 30


def _doc(refs_heading: str, toc: str = "") -> str:
    return f"# A study of spoil\n\n{toc}## Introduction\n\n{BODY}\n\n## Results\n\n{BODY}\n\n{refs_heading}\n\n{REFS}\n"


def _roles(text: str):
    return [(s["heading_path"].split(" > ")[-1].strip(), s["is_bibliography"]) for s in build_section_tree(text)]


def test_a_bare_references_line_starts_a_bibliography_section():
    assert ("References", 1) in _roles(_doc("References"))
    assert ("References", 1) in _roles(_doc("**References**"))
    assert ("Bibliography", 1) in _roles(_doc("Bibliography:"))


def test_a_markdown_references_heading_is_unchanged():
    assert ("References", 1) in _roles(_doc("## References"))


def test_a_table_of_contents_entry_near_the_top_is_not_a_bibliography():
    toc = "Contents\n\nIntroduction\n\nResults\n\nReferences\n\n"
    roles = _roles(_doc("## References", toc=toc))
    assert sum(flag for _, flag in roles) == 1  # only the real reference list


def test_the_word_inside_prose_is_not_a_heading():
    text = _doc("## References").replace("held out sites.", "held out sites. See the references below.", 1)
    assert sum(flag for _, flag in _roles(text)) == 1


def test_reference_list_chunks_are_not_searchable_body_text(tmp_path):
    store = Store(tmp_path / "pm.db")
    path = tmp_path / "p.md"
    path.write_text("---\ndoi: 10.1234/refs\ntitle: A study of spoil\nyear: 2024\n---\n" + _doc("References"), encoding="utf-8")
    ingest_markdown(store, path, project_id="p")
    flagged = store.conn.execute("SELECT COUNT(*) FROM chunks WHERE is_bibliography=1 AND claimable=0").fetchone()[0]
    assert flagged >= 1
    result = search_with_status(store, "quokka telemetry alpine habitats", kind="chunk", project_id="p")
    assert result["results"] == []  # the term exists only in the reference list
    assert result["empty_reason"] == "all-suppressed:bibliography"


def test_reindex_repairs_a_document_stored_with_a_bare_references_line(tmp_path):
    store = Store(tmp_path / "pm.db")
    path = tmp_path / "p.md"
    path.write_text("---\ndoi: 10.1234/refs2\ntitle: A study of spoil\nyear: 2024\n---\n" + _doc("References"), encoding="utf-8")
    ingest_markdown(store, path, project_id="p")
    store.conn.execute("UPDATE chunks SET is_bibliography=0, claimable=1")  # as stored before the parser fix
    store.conn.commit()
    assert store.conn.execute("SELECT COUNT(*) FROM chunks WHERE is_bibliography=1").fetchone()[0] == 0
    reindex_from_raw(store)
    assert store.conn.execute("SELECT COUNT(*) FROM chunks WHERE is_bibliography=1").fetchone()[0] >= 1
