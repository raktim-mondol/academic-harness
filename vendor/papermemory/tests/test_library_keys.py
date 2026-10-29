from __future__ import annotations

from pathlib import Path

import pytest

from papermemory import library_keys
from papermemory.bibkeys import TemplateError, clean_key, key_problems, make_key, resolve_template, usable_source_key
from papermemory.citations import cite_check
from papermemory.cli import main as cli_main
from papermemory.db import Store
from papermemory.ingest import ingest_manuscript
from papermemory.library import get_entry, import_text
from papermemory.library_keys import KeyOperationError

CSL = {
    "title": "The Deep Learning Era", "author": [{"family": "M\u00fcller", "given": "K"}],
    "issued": {"date-parts": [[2020]]}, "DOI": "10.1/AB-c",
}


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def test_default_template_matches_the_citation_tool():
    assert make_key(CSL) == "muller2020deep"
    assert make_key({"title": "On the Nature of Things", "author": [{"family": "Smith"}], "issued": {"date-parts": [[1999]]}}) == "smith1999nature"


def test_custom_templates_and_fallbacks():
    assert make_key(CSL, {}, "{family}_{year}") == "muller_2020"
    assert make_key(CSL, {}, "{doi}") == "ref101abc"
    assert make_key({"DOI": "10.1/Z"}) == "ref101z"
    assert make_key({"title": "Only a title here"}, {"arxiv_id": "2101.00001"}) == "ref210100001"
    assert make_key({"author": [{"family": "Roe"}], "issued": {"date-parts": [[2020]]}}, {}, "{family}{year}") == "roe2020"


def test_template_validation(monkeypatch):
    assert resolve_template("") == "{family}{year}{titleword}"  # empty means "not given"
    for bad in ("{nope}", "{family", "a b{year}", "{family}{{year}"):
        with pytest.raises(TemplateError):
            resolve_template(bad)
    monkeypatch.setenv("PAPERMEMORY_KEY_TEMPLATE", "{year}{family}")
    assert resolve_template() == "{year}{family}"
    assert make_key(CSL) == "ref2020muller"  # digit-leading keys get a prefix


def test_key_hygiene():
    assert clean_key("2020 foo!") == "ref2020foo"
    assert key_problems("a b,c") == ["whitespace", "comma"]
    assert "non-ascii" in key_problems("m\u00fcller2020") and "reserved-character" in key_problems("a{b}")
    assert key_problems("ok:key-1.v2") == []
    assert usable_source_key("Dawood2026") and not usable_source_key("12345") and not usable_source_key(None)


def test_new_papers_get_a_key_when_their_metadata_is_good_enough(tmp_path):
    store = _store(tmp_path)
    store.upsert_paper({"title": "Same Title", "authors": ["Ann Lee"], "year": 2020, "doi": "10.1/a"})
    store.upsert_paper({"title": "Untitled", "year": 2020})  # nothing to build a key from yet
    store.upsert_paper({"title": "Some title", "year": 2020})  # no author, DOI, or arXiv id
    rows = {r["title"]: r for r in store.conn.execute(
        "SELECT p.title, k.key, k.policy FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id")}
    assert rows["Same Title"]["key"] == "lee2020same" and rows["Same Title"]["policy"] == "generated"
    assert rows["Untitled"]["key"] is None and rows["Some title"]["key"] is None
    assert store.conn.execute("SELECT source FROM reference_meta").fetchone()[0] == "ingest"
    assert library_keys.assign_missing(store)["assigned"] == 2  # the rest are filled on request


def test_assign_missing_is_deterministic_and_unique(tmp_path):
    store = _store(tmp_path)
    for i, doi in enumerate(("10.1/a", "10.1/b", "10.1/c")):
        store.upsert_paper({"title": "Same Title", "authors": ["Ann Lee"], "year": 2020, "doi": doi})
    store.conn.execute("DELETE FROM bib_keys")  # papers that predate the library
    store.conn.execute("UPDATE papers SET bibtex_key=NULL")
    store.conn.commit()
    first = library_keys.assign_missing(store)
    assert first["assigned"] == 3
    keys = sorted(r["key"] for r in store.conn.execute("SELECT key FROM bib_keys"))
    assert keys == ["lee2020same", "lee2020samea", "lee2020sameb"]
    assert library_keys.assign_missing(store)["assigned"] == 0
    bound = {r["bibtex_key"] for r in store.conn.execute("SELECT bibtex_key FROM papers")}
    assert bound == set(keys)


def test_check_reports_problems_without_changing_anything(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{good2020, title={A}, doi={10.1/a}, year=2020}\n@article{bad key, title={B}, doi={10.1/b}, year=2020}")
    store.upsert_paper({"title": "No key yet", "year": 2019})
    report = library_keys.check(store)
    problems = report["problems"]
    assert len(problems["missing_key"]) == 1
    assert report["summary"]["ok"] is False
    before = store.conn.execute("SELECT COUNT(*) FROM bib_keys").fetchone()[0]
    library_keys.check(store)
    assert store.conn.execute("SELECT COUNT(*) FROM bib_keys").fetchone()[0] == before


def test_check_flags_template_drift_only_for_generated_keys(tmp_path):
    store = _store(tmp_path)
    store.upsert_paper({"title": "Alpha Beta", "authors": ["Ann Lee"], "year": 2020, "doi": "10.1/a"})
    library_keys.assign_missing(store)
    assert library_keys.check(store)["summary"]["problems"]["template_drift"] == 0
    drift = library_keys.check(store, template="{family}_{year}")
    assert drift["summary"]["problems"]["template_drift"] == 1
    import_text(store, "@article{whatever, title={Imported}, doi={10.1/i}, year=2021}")
    assert library_keys.check(store, template="{family}_{year}")["summary"]["problems"]["template_drift"] == 1  # imported keys are never "drift"


def test_freeze_is_recorded_and_idempotent(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{k1, title={A}, doi={10.1/a}, year=2020}")
    with pytest.raises(KeyOperationError) as exc:
        library_keys.freeze(store, "k1", " ")
    assert exc.value.code == "label-required"
    assert library_keys.freeze(store, "k1", "export:references.bib")["changed"] is True
    assert library_keys.freeze(store, "k1", "export:other.bib")["changed"] is False
    row = store.conn.execute("SELECT frozen, frozen_in FROM bib_keys WHERE key='k1'").fetchone()
    assert row["frozen"] == 1 and row["frozen_in"] == "export:references.bib"


def test_assign_key_never_changes_an_existing_key(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{first, title={A}, doi={10.1/a}, year=2020}")
    import_text(store, "@article{second, title={A}, doi={10.1/a}, year=2020}")
    assert get_entry(store, "second")["key"]["key"] == "first"


def _manuscript(tmp_path: Path, key: str):
    root = tmp_path / "ms"
    (root / "sections").mkdir(parents=True)
    (root / "references.bib").write_text("", encoding="utf-8")
    (root / "sections" / "intro.tex").write_text(rf"Prior work \citep{{{key}}} showed it.", encoding="utf-8")
    (root / "main.tex").write_text("\\input{sections/intro}\n", encoding="utf-8")
    return root


def test_rekey_dry_run_then_apply_keeps_old_key_resolving(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{oldkey, title={A paper}, doi={10.1/a}, year=2020}", project_id="ms")
    ingest_manuscript(store, _manuscript(tmp_path, "oldkey"), slug="ms")
    store.conn.execute("UPDATE papers SET project_id='ms' WHERE doi='10.1/a'")
    store.conn.commit()
    library_keys.freeze(store, "oldkey", "export:references.bib")

    plan = library_keys.rekey(store, "oldkey", to="newkey")
    assert plan["applied"] is False and plan["new_key"] == "newkey"
    assert plan["affected_manuscripts"] == [{"manuscript": "ms", "citations": 1, "files": plan["affected_manuscripts"][0]["files"]}]
    assert store.conn.execute("SELECT key FROM bib_keys").fetchone()["key"] == "oldkey"

    with pytest.raises(KeyOperationError) as exc:
        library_keys.rekey(store, "oldkey", to="newkey", apply=True)
    assert exc.value.code == "reason-required"

    done = library_keys.rekey(store, "oldkey", to="newkey", reason="clearer name", apply=True)
    assert done["applied"] and done["reason"] == "clearer name"
    row = store.conn.execute("SELECT key, policy, frozen FROM bib_keys").fetchone()
    assert (row["key"], row["policy"], row["frozen"]) == ("newkey", "manual", 0)
    assert store.conn.execute("SELECT bibtex_key FROM papers").fetchone()["bibtex_key"] == "newkey"
    assert get_entry(store, "oldkey")["key"]["key"] == "newkey"
    alias = store.conn.execute("SELECT source FROM bib_key_aliases WHERE key='oldkey' AND project_key=''").fetchone()
    assert alias["source"] == "rekey"
    events = [r["op"] for r in store.conn.execute("SELECT op FROM events WHERE op IN ('KEY_FREEZE','KEY_RENAME')")]
    assert events == ["KEY_FREEZE", "KEY_RENAME"]
    report = cite_check(store, "ms")
    assert report["missing_from_memory"] == [], report


def test_rekey_refuses_unsafe_taken_and_noop(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{one, title={A}, doi={10.1/a}, year=2020}\n@article{two, title={B}, doi={10.1/b}, year=2020}")
    with pytest.raises(KeyOperationError) as exc:
        library_keys.rekey(store, "one", to="bad key")
    assert exc.value.code == "invalid-key"
    with pytest.raises(KeyOperationError) as exc:
        library_keys.rekey(store, "one", to="two", reason="x", apply=True)
    assert exc.value.code == "key-in-use"
    with pytest.raises(KeyOperationError) as exc:
        library_keys.rekey(store, "missing")
    assert exc.value.code == "not-found"
    assert library_keys.rekey(store, "one", to="one")["changed"] is False


def test_rekey_back_to_a_retired_key(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{a, title={A}, doi={10.1/a}, year=2020}")
    library_keys.rekey(store, "a", to="b", reason="r", apply=True)
    library_keys.rekey(store, "b", to="a", reason="undo", apply=True)
    assert store.conn.execute("SELECT key FROM bib_keys").fetchone()["key"] == "a"
    assert not store.conn.execute("SELECT 1 FROM bib_key_aliases WHERE key='a' AND project_key='' AND source='rekey'").fetchone()
    assert store.conn.execute("SELECT 1 FROM bib_key_aliases WHERE key='b' AND project_key='' AND source='rekey'").fetchone()


def test_rekey_from_template_regenerates(tmp_path):
    store = _store(tmp_path)
    import_text(store, "@article{legacy, title={Neural Nets}, author={Roe, Rae}, doi={10.1/a}, year=2020}")
    plan = library_keys.rekey(store, "legacy")
    assert plan["new_key"] == "roe2020neural"
    assert library_keys.rekey(store, "legacy", template="{family}{year}")["new_key"] == "roe2020"


def test_cli_keys_flow(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "cli.db"))
    bib = tmp_path / "r.bib"
    bib.write_text("@article{k, title={A}, author={Roe, Rae}, doi={10.1/a}, year=2020}", encoding="utf-8")
    assert cli_main(["library", "import", str(bib)]) == 0
    assert cli_main(["library", "keys", "check", "--json"]) == 0
    assert cli_main(["library", "keys", "rekey", "k", "--to", "bad key"]) == 2
    assert cli_main(["library", "keys", "rekey", "k", "--to", "good"]) == 0  # dry run
    assert cli_main(["library", "keys", "rekey", "k", "--to", "good", "--apply"]) == 2  # reason required
    assert cli_main(["library", "keys", "rekey", "k", "--to", "good", "--apply", "--reason", "tidy"]) == 0
    assert cli_main(["library", "keys", "freeze", "good", "--label", "export:x.bib"]) == 0
    assert cli_main(["library", "get", "k"]) == 0
    out = capsys.readouterr().out
    assert "good" in out
