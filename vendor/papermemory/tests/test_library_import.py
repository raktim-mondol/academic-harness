from __future__ import annotations

import json
import sqlite3

import pytest

from papermemory.db import Store
from papermemory.library import LibraryError, detect_format, get_entry, import_text
from papermemory.migrations import migrate_2100
from papermemory.ops import export_store, migrate, restore_store
from papermemory.schema_v2 import SCHEMA_V2000, V2_SCHEMA

BIB = r"""
@article{he2016deep,
  title={Deep {Residual} Learning for Image Recognition},
  author={He, Kaiming and Zhang, Xiangyu},
  journal={CVPR}, year={2016}, pages={770--778}, volume={5}, doi={10.1109/CVPR.2016.90},
  mrnumber={123}
}
@misc{noid, title={A note without identifiers}, author={Doe, Jane}, year={2020}}
"""


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def test_detect_format():
    assert detect_format(BIB) == "bibtex"
    assert detect_format("TY  - JOUR\nER  -\n") == "ris"
    assert detect_format('[{"id": "x"}]') == "csl-json"
    assert detect_format("", "refs.ris") == "ris"
    with pytest.raises(LibraryError):
        detect_format("plain prose")


def test_bibtex_import_is_lossless_and_keyed(tmp_path):
    store = _store(tmp_path)
    report = import_text(store, BIB, project_id="proj")
    assert report["counts"] == {"added": 2, "merged": 0, "failed": 0, "parse_errors": 0}
    entry = get_entry(store, "he2016deep")
    assert entry["key"]["key"] == "he2016deep" and entry["key"]["policy"] == "imported"
    ref = entry["reference"]
    assert ref["raw_bibtex"].startswith("@article{he2016deep")
    assert ref["extra"]["mrnumber"] == "123" and ref["extra"]["title_raw"].startswith("Deep {Residual}")
    assert ref["csl"]["page"] == "770–778" and ref["csl"]["DOI"] == "10.1109/cvpr.2016.90"
    assert entry["paper"]["bibtex_key"] == "he2016deep"
    assert any(a["key"] == "he2016deep" and a["project_key"] == "proj" for a in entry["aliases"])


def test_reimport_is_idempotent(tmp_path):
    store = _store(tmp_path)
    import_text(store, BIB, project_id="proj")
    again = import_text(store, BIB, project_id="proj")
    assert again["counts"]["added"] == 0 and again["counts"]["merged"] == 2
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 2
    assert store.conn.execute("SELECT COUNT(*) FROM bib_keys").fetchone()[0] == 2


def test_same_paper_with_another_key_becomes_an_alias(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{first, title={T}, doi={10.1/a}, year=2020}", project_id="p1")
    report = import_text(store, "@article{second, title={T}, doi={10.1/a}, year=2020}", project_id="p2")
    entry = report["entries"][0]
    assert entry["status"] == "merged" and entry["key"] == "first" and entry["key_alias"] == "second"
    assert "key_collision" not in entry
    resolved = get_entry(store, "second", project_id="p2")
    assert resolved["key"]["key"] == "first"


def test_key_collision_between_different_papers_renames_the_newcomer(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{smith2020, title={Alpha}, doi={10.1/a}, year=2020}", project_id="p1")
    report = import_text(store, "@article{smith2020, title={Beta}, doi={10.1/b}, year=2020}", project_id="p2")
    entry = report["entries"][0]
    assert entry["status"] == "added" and entry["key"] == "smith2020a" and entry["key_collision"] == "smith2020"
    # Project 2's manuscript still resolves its own key to the right paper.
    assert get_entry(store, "smith2020", project_id="p2")["paper"]["title"] == "Beta"
    assert get_entry(store, "smith2020", project_id="p1")["paper"]["title"] == "Alpha"


def test_duplicate_key_in_one_project_is_reported(tmp_path):
    store = _store(tmp_path)
    report = import_text(
        store, "@article{dup, title={One}, doi={10.1/1}}\n@article{dup, title={Two}, doi={10.1/2}}", project_id="p",
    )
    assert report["entries"][1]["alias_conflict"] == "dup"


def test_unterminated_entry_is_recovered_and_reported(tmp_path):
    store = _store(tmp_path)
    report = import_text(store, "@article{a4, title={Lost}, year=2020\n\n@article{a5, title={Next}, year=2021}\n")
    assert report["counts"]["added"] == 2 and report["counts"]["parse_errors"] == 1
    assert {e["source_key"] for e in report["entries"]} == {"a4", "a5"}


def test_richer_existing_metadata_is_not_overwritten(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{k, title={Rich title}, author={A, B}, journal={J}, doi={10.1/z}, year=2020, volume=9}")
    import_text(store, "TY  - JOUR\nTI  - Rich title\nDO  - 10.1/z\nER  -\n", fmt="ris")
    ref = get_entry(store, "k")["reference"]
    assert ref["source"] == "bibtex" and ref["csl"]["volume"] == "9"


def test_dry_run_writes_nothing(tmp_path):
    store = _store(tmp_path)
    report = import_text(store, BIB, dry_run=True)
    assert report["counts"]["added"] == 2 and report["dry_run"]
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 0
    assert store.conn.execute("SELECT COUNT(*) FROM reference_meta").fetchone()[0] == 0


def test_ris_and_csl_json_import(tmp_path):
    store = _store(tmp_path)
    ris = import_text(store, "TY  - JOUR\nTI  - From RIS\nAU  - Roe, Rae\nPY  - 2021\nDO  - 10.1/ris\nER  -\n", fmt="ris")
    assert ris["entries"][0]["key"] == "roe2021ris"  # generated: no usable source key
    assert get_entry(store, "roe2021ris")["key"]["policy"] == "generated"
    csl = json.dumps([{"id": "doe2022x", "type": "article-journal", "title": "From CSL", "DOI": "10.1/csl",
                       "author": [{"family": "Doe", "given": "J"}], "issued": {"date-parts": [[2022]]}, "weird": 1}])
    report = import_text(store, csl)
    assert report["format"] == "csl-json" and report["entries"][0]["key"] == "doe2022x"
    assert get_entry(store, "10.1/csl")["reference"]["csl"]["weird"] == 1


def test_malformed_json_is_a_parse_error_not_an_exception(tmp_path):
    store = _store(tmp_path)
    report = import_text(store, "[{not json", fmt="csl-json")
    assert report["counts"]["added"] == 0 and report["counts"]["parse_errors"] == 1


def test_batches_commit_and_failures_do_not_abort(tmp_path):
    store = _store(tmp_path)
    text = "\n".join(f"@article{{k{i}, title={{Paper {i}}}, doi={{10.1/{i}}}, year=2020}}" for i in range(25))
    report = import_text(store, text, batch_size=10)
    assert report["counts"]["added"] == 25
    store.conn.rollback()
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 25


def test_export_and_restore_round_trip_includes_library(tmp_path):
    store = _store(tmp_path)
    import_text(store, BIB, project_id="proj")
    out = tmp_path / "x.jsonl"
    summary = export_store(store, out)
    assert summary["tables"]["reference_meta"] == 2 and summary["tables"]["bib_keys"] == 2
    fresh = Store(tmp_path / "fresh.db")
    restore_store(fresh, out)
    assert get_entry(fresh, "he2016deep")["reference"]["extra"]["mrnumber"] == "123"


def test_merge_papers_moves_library_rows(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{a, title={Same}, year=2020}", project_id="p1")
    import_text(store, "@article{b, title={Same thing differently}, doi={10.1/m}, year=2020}", project_id="p2")
    a = get_entry(store, "a")["paper"]["id"]
    b = get_entry(store, "b")["paper"]["id"]
    store.conn.execute("INSERT INTO paper_tags(paper_id, tag, added_at) VALUES (?, 'ml', 'now')", (a,))
    store.merge_papers(a, b)
    merged = get_entry(store, "b")
    assert merged["paper"]["id"] == b
    assert {x["key"] for x in merged["aliases"]} >= {"a", "b"}
    assert get_entry(store, "a")["paper"]["id"] == b
    assert store.conn.execute("SELECT tag FROM paper_tags WHERE paper_id=?", (b,)).fetchone()["tag"] == "ml"
    assert not store.conn.execute("SELECT 1 FROM reference_meta WHERE paper_id=?", (a,)).fetchone()
    assert store.conn.execute("PRAGMA foreign_key_check").fetchall() == []


def _make_2000_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(V2_SCHEMA)
    conn.execute(f"PRAGMA user_version={SCHEMA_V2000}")
    conn.execute("INSERT INTO projects(key, title, kind, created_at) VALUES ('unassigned','Unassigned','manuscript','t')")
    rows = [
        ("p1", "doi", "10.1/a", "Alpha", "[\"Ann Lee\"]", 2020, "J", "10.1/a", "lee2020alpha", "t1"),
        ("p2", "doi", "10.1/b", "Beta", "[\"Bob Ray\"]", 2021, None, "10.1/b", "lee2020alpha", "t2"),  # shared legacy key
        ("p3", "title_year", "gamma|2019", "Gamma", "[]", 2019, None, None, None, "t3"),
    ]
    for pid, kind, value, title, authors, year, venue, doi, key, created in rows:
        conn.execute(
            """INSERT INTO papers(id, identity_kind, identity_value, title, title_source, authors_json, year, venue,
               doi, bibtex_key, origin_channel, cite_state, created_at, updated_at)
               VALUES (?,?,?,?, 'caller', ?,?,?,?,?, 'hand-asserted', 'chunkless', ?, ?)""",
            (pid, kind, value, title, authors, year, venue, doi, key, created, created),
        )
    conn.commit()
    conn.close()


def test_migration_2100_backfills_without_touching_existing_keys(tmp_path):
    path = tmp_path / "old.db"
    _make_2000_db(path)
    with pytest.raises(Exception) as exc:
        Store(path)
    assert "migrate" in str(exc.value)
    store = Store.connect_for_migration(path)
    result = migrate(store)
    store.close()
    assert result["user_version"] == 2100 and result["reference_meta"] == 3 and result["bib_keys"] == 2
    assert result["key_conflicts"] == [{"paper_id": "p2", "key": "lee2020alpha", "library_key": "lee2020alphaa"}]
    store = Store(path)
    keys = {r["id"]: r["bibtex_key"] for r in store.conn.execute("SELECT id, bibtex_key FROM papers")}
    assert keys == {"p1": "lee2020alpha", "p2": "lee2020alpha", "p3": None}
    assert {r["paper_id"]: r["key"] for r in store.conn.execute("SELECT paper_id, key FROM bib_keys")} == {
        "p1": "lee2020alpha", "p2": "lee2020alphaa"}
    assert get_entry(store, "lee2020alpha")["paper"]["id"] == "p1"
    csl = get_entry(store, "p1")["reference"]["csl"]
    assert csl["author"] == [{"family": "Lee", "given": "Ann"}] and csl["issued"] == {"date-parts": [[2020]]}
    assert migrate_2100(store)["changed"] is False
    assert store.conn.execute("PRAGMA foreign_key_check").fetchall() == []
