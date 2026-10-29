from __future__ import annotations

import pytest

from papermemory import library_org
from papermemory.cli import main as cli_main
from papermemory.db import Store
from papermemory.library import import_text
from papermemory.library_org import OrgError, normalize_tag
from papermemory.library_query import QueryError, list_papers, parse_query, tag_counts
from papermemory.search import search

BIB = """
@article{lee2020graph, title={Graph networks for molecules}, author={Lee, Ann}, journal={Nature}, year=2020, doi={10.1/a}, abstract={A study of graphs.}}
@article{roe2021vision, title={Vision transformers at scale}, author={Roe, Rae and van der Berg, Jan}, journal={CVPR}, year=2021, doi={10.1/b}}
@article{kim2022language, title={Language models for code}, author={Kim, Sun}, journal={ICML}, year=2022, doi={10.1/c}}
@article{poe2019early, title={Early work}, author={Poe, Edgar}, year=2019, doi={10.1/d}}
"""


@pytest.fixture()
def store(tmp_path):
    s = Store(tmp_path / "pm.db")
    import_text(s, BIB, project_id="thesis")
    yield s
    s.close()


def _keys(result):
    return [r["key"] for r in result["rows"]]


# ---------- tags ----------


def test_tag_normalisation():
    assert normalize_tag("  Deep Learning ") == "deep-learning"
    assert normalize_tag("Project:Alpha/β") == "project:alpha/β"
    for bad in ("", "  ", ",,,", "x" * 65):
        with pytest.raises(OrgError):
            normalize_tag(bad)


def test_tags_add_remove_idempotent_and_audited(store):
    first = library_org.add_tags(store, ["lee2020graph", "roe2021vision"], ["ML", "to-read"])
    assert first["added"] == 4 and first["tags"] == ["ml", "to-read"]
    assert library_org.add_tags(store, ["lee2020graph"], ["ml"])["added"] == 0
    assert library_org.remove_tags(store, ["lee2020graph"], ["to-read", "absent"])["removed"] == 1
    details = [r["detail"] for r in store.conn.execute("SELECT detail FROM events WHERE op='LIBRARY_WRITE' ORDER BY ts, id")]
    assert details.count("tag+ ml") == 2 and "tag- to-read" in details
    assert _keys(list_papers(store, "tag:ml")) == ["lee2020graph", "roe2021vision"]


def test_tag_on_unknown_paper_is_refused_before_any_change(store):
    with pytest.raises(OrgError) as exc:
        library_org.add_tags(store, ["lee2020graph", "nope"], ["x"])
    assert exc.value.code == "not-found"
    assert store.conn.execute("SELECT COUNT(*) FROM paper_tags").fetchone()[0] == 0


def test_tag_counts_respect_a_filter(store):
    library_org.add_tags(store, ["lee2020graph", "roe2021vision", "kim2022language"], ["ml"])
    library_org.add_tags(store, ["lee2020graph"], ["chem"])
    assert tag_counts(store) == [{"tag": "ml", "papers": 3}, {"tag": "chem", "papers": 1}]
    assert tag_counts(store, "year:2021..") == [{"tag": "ml", "papers": 2}]


# ---------- collections ----------


def test_collection_lifecycle_never_deletes_papers(store):
    library_org.create_collection(store, "Thesis Refs", title="Thesis references", project="thesis", bib_path="references.bib")
    library_org.create_collection(store, "chapter-1", parent="thesis-refs")
    with pytest.raises(OrgError) as exc:
        library_org.create_collection(store, "deep", parent="chapter-1")
    assert exc.value.code == "too-deep"
    with pytest.raises(OrgError):
        library_org.create_collection(store, "thesis-refs")
    with pytest.raises(OrgError) as exc:
        library_org.create_collection(store, "x", project="no-such-project")
    assert exc.value.code == "project-not-found"
    library_org.add_to_collection(store, "chapter-1", ["lee2020graph", "roe2021vision"])
    library_org.add_to_collection(store, "thesis-refs", ["kim2022language"])
    # a parent includes its child collections in filters
    assert sorted(_keys(list_papers(store, "collection:thesis-refs"))) == ["kim2022language", "lee2020graph", "roe2021vision"]
    assert _keys(list_papers(store, "collection:chapter-1")) == ["lee2020graph", "roe2021vision"]
    result = library_org.delete_collection(store, "thesis-refs")
    assert result["papers_deleted"] == 0 and result["children_detached"] == 1
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 4
    assert store.conn.execute("SELECT parent_id FROM collections WHERE slug='chapter-1'").fetchone()[0] is None


def test_collection_order_add_remove_reorder(store):
    library_org.create_collection(store, "c")
    library_org.add_to_collection(store, "c", ["lee2020graph", "roe2021vision", "kim2022language"])
    assert library_org.add_to_collection(store, "c", ["lee2020graph"])["added"] == 0
    names = lambda: [p["key"] for p in library_org.show_collection(store, "c")["papers"]]  # noqa: E731
    assert names() == ["lee2020graph", "roe2021vision", "kim2022language"]
    library_org.reorder_collection(store, "c", ["kim2022language", "roe2021vision"])
    assert names() == ["kim2022language", "roe2021vision", "lee2020graph"]
    with pytest.raises(OrgError) as exc:
        library_org.reorder_collection(store, "c", ["poe2019early"])
    assert exc.value.code == "not-a-member"
    assert library_org.remove_from_collection(store, "c", ["roe2021vision"])["removed"] == 1
    assert names() == ["kim2022language", "lee2020graph"]
    assert library_org.list_collections(store) == [
        {"slug": "c", "title": "c", "parent": None, "project": None, "bib_path": None, "papers": 2}]


def test_merge_keeps_tags_and_collections(store):
    library_org.create_collection(store, "c")
    library_org.add_tags(store, ["lee2020graph"], ["ml"])
    library_org.add_to_collection(store, "c", ["lee2020graph"])
    a = store.conn.execute("SELECT paper_id FROM bib_keys WHERE key='lee2020graph'").fetchone()[0]
    b = store.conn.execute("SELECT paper_id FROM bib_keys WHERE key='poe2019early'").fetchone()[0]
    store.merge_papers(a, b)
    row = list_papers(store, "tag:ml")["rows"][0]
    assert row["key"] == "poe2019early" and row["collections"] == ["c"]


# ---------- notes ----------


def test_notes_add_list_edit_remove(store):
    note = library_org.add_note(store, "lee2020graph", "Read section 3 for the baseline.")
    assert [n["content"] for n in library_org.list_notes(store, "lee2020graph")] == ["Read section 3 for the baseline."]
    edited = library_org.edit_note(store, note["note_id"], "Baseline is in section 4.")
    assert [n["content"] for n in library_org.list_notes(store, "lee2020graph")] == ["Baseline is in section 4."]
    old = store.conn.execute("SELECT status, superseded_by FROM observations WHERE id=?", (note["note_id"],)).fetchone()
    assert old["status"] == "superseded" and old["superseded_by"] == edited["note_id"]
    with pytest.raises(OrgError) as exc:
        library_org.edit_note(store, note["note_id"], "again")
    assert exc.value.code == "note-inactive"
    library_org.remove_note(store, edited["note_id"])
    assert library_org.list_notes(store, "lee2020graph") == []
    with pytest.raises(OrgError):
        library_org.add_note(store, "lee2020graph", "   ")
    with pytest.raises(OrgError):
        library_org.add_note(store, "nope", "text")


# ---------- query ----------


def test_query_filters(store):
    library_org.add_tags(store, ["lee2020graph"], ["chem"])
    library_org.add_note(store, "roe2021vision", "contains the ablation I need")
    store.conn.execute("UPDATE papers SET pdf_path='/x.pdf' WHERE doi='10.1/b'")
    store.conn.commit()
    q = lambda text: _keys(list_papers(store, text, sort="year"))  # noqa: E731
    assert q("year:2020") == ["lee2020graph"]
    assert q("year:2020..2021") == ["lee2020graph", "roe2021vision"]
    assert q("year:2021..") == ["roe2021vision", "kim2022language"]
    assert q("year:..2019") == ["poe2019early"]
    assert q('author:"van der"') == ["roe2021vision"]
    assert q("venue:nature") == ["lee2020graph"]
    assert q("title:transformers") == ["roe2021vision"]
    assert q("doi:10.1/c") == ["kim2022language"]
    assert q("key:kim") == ["kim2022language"]
    assert q("has:pdf") == ["roe2021vision"]
    assert q("has:notes") == ["roe2021vision"]
    assert q("has:abstract") == ["lee2020graph"]
    assert q("-has:doi") == []
    assert q("-tag:chem year:2020..2021") == ["roe2021vision"]
    assert q("project:thesis year:2022") == ["kim2022language"]
    store.conn.execute("UPDATE papers SET verified=0 WHERE doi='10.1/c'")
    store.conn.commit()
    assert q("verified:no") == ["kim2022language"]
    assert q("verified:yes") == ["poe2019early", "lee2020graph", "roe2021vision"]
    assert q("!tag:chem year:2020..2021") == ["roe2021vision"]  # '!' negates too: a leading '-' is read as an option by the shell CLI
    assert q("integrity:unchecked year:2019") == ["poe2019early"]
    # free text reaches title, abstract, authors, venue, tags and notes
    assert q("graph") == ["lee2020graph"]
    assert q("ablation") == ["roe2021vision"]
    assert q("chem") == ["lee2020graph"]
    assert q("Roe Rae") == ["roe2021vision"]
    assert q("graph chem nature") == ["lee2020graph"] and q("graph vision") == []


def test_query_errors_are_loud():
    for bad in ("colour:red", "year:20x", "year:..", "year:20202024", "has:wings", "verified:maybe", "tag:", "author:'unclosed"):
        with pytest.raises(QueryError):
            parse_query(bad)
    assert parse_query("10.1038/abc:def").terms == ["10.1038/abc:def"]
    assert parse_query("http://x.org").terms == ["http://x.org"]
    assert parse_query("-omics").terms == ["-omics"]


def test_special_characters_are_not_sql_wildcards(store):
    assert _keys(list_papers(store, "100%")) == []
    assert _keys(list_papers(store, "_____")) == []


@pytest.mark.parametrize("sort", ["added", "year", "title", "key"])
@pytest.mark.parametrize("desc", [False, True])
def test_paging_visits_every_row_once_in_order(store, sort, desc):
    seen, cursor = [], None
    while True:
        page = list_papers(store, None, sort=sort, desc=desc, limit=1, cursor=cursor)
        assert page["total_count"] == 4
        seen += _keys(page)
        cursor = page["next_cursor"]
        if not cursor:
            break
    whole = _keys(list_papers(store, None, sort=sort, desc=desc, limit=50))
    assert seen == whole and len(set(seen)) == 4


def test_cursor_for_another_sort_is_refused(store):
    page = list_papers(store, None, sort="year", limit=1)
    with pytest.raises(QueryError):
        list_papers(store, None, sort="title", cursor=page["next_cursor"])
    with pytest.raises(QueryError):
        list_papers(store, None, cursor="garbage")


# ---------- search integration ----------


def test_search_finds_papers_by_tag_and_note(store):
    library_org.add_tags(store, ["kim2022language"], ["benchmarking"])
    library_org.add_note(store, "poe2019early", "foundational reading about telegraphy")
    hits = search(store, "benchmarking", kind="paper")
    assert [h["bibtex_key"] for h in hits if h["kind"] == "paper"] == ["kim2022language"]
    hits = search(store, "telegraphy", kind="paper")
    assert any(h["kind"] == "paper" and h["bibtex_key"] == "poe2019early" for h in hits)


# ---------- CLI ----------


def test_cli_flow(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "cli.db"))
    bib = tmp_path / "r.bib"
    bib.write_text(BIB, encoding="utf-8")
    run = cli_main
    assert run(["library", "import", str(bib)]) == 0
    assert run(["library", "tag", "add", "ml,to-read", "lee2020graph", "kim2022language"]) == 0
    assert run(["library", "tag", "list"]) == 0
    assert run(["library", "collection", "create", "reading"]) == 0
    assert run(["library", "collection", "add", "reading", "lee2020graph"]) == 0
    assert run(["library", "collection", "show", "reading"]) == 0
    assert run(["library", "note", "add", "lee2020graph", "important baseline"]) == 0
    assert run(["library", "list", "tag:ml", "collection:reading", "--json"]) == 0
    out = capsys.readouterr().out
    assert '"total_count": 1' in out
    assert run(["library", "list", "colour:red"]) == 2
    assert run(["library", "tag", "add", "x", "missing-ref"]) == 2
    assert run(["library", "collection", "delete", "reading"]) == 0
