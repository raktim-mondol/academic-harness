from __future__ import annotations

import pytest

from papermemory import library_org
from papermemory.cli import main as cli_main
from papermemory.db import Store
from papermemory.library import get_entry, import_text
from papermemory.library_hygiene import HygieneError, doctor, find_duplicates, merge_apply, merge_plan

BIB = """
@article{vaswani2017attention, title={Attention Is All You Need}, author={Vaswani, Ashish and Shazeer, Noam}, journal={NeurIPS}, year=2017, doi={10.5555/3295222.3295349}}
@misc{vaswani2017arxiv, title={Attention is all you need}, author={Vaswani, Ashish and Shazeer, Noam}, year=2017, eprint={1706.03762}, archiveprefix={arXiv}}
@article{lee2020graph, title={Graph networks for molecules}, author={Lee, Ann}, journal={Nature}, year=2020, doi={10.1/g}}
@article{lee2020graph2, title={Graph networks for molecules}, author={Lee, Ann}, journal={Nature Comms}, year=2020, abstract={An abstract.}}
@article{kim2021one, title={Part one of a series on proteins}, author={Kim, Sun}, year=2021, doi={10.1/k1}}
@article{kim2021two, title={Part two of a series on proteins}, author={Kim, Sun}, year=2021, doi={10.1/k2}}
@article{solo2019, title={Something entirely different}, author={Solo, Han}, year=2019, doi={10.1/s}}
"""


@pytest.fixture()
def store(tmp_path):
    s = Store(tmp_path / "pm.db")
    import_text(s, BIB, project_id="thesis")
    yield s
    s.close()


def _group_keys(result):
    return sorted(sorted(p["key"] for p in g["papers"]) for g in result["groups"])


def test_duplicates_finds_real_candidates_and_ignores_siblings(store):
    result = find_duplicates(store)
    groups = _group_keys(result)
    assert ["lee2020graph", "lee2020graph2"] in groups
    assert ["vaswani2017arxiv", "vaswani2017attention"] in groups
    flat = {k for g in groups for k in g}
    assert not flat & {"kim2021one", "kim2021two", "solo2019"}  # "Part one/two" and unrelated papers are not duplicates
    evidence = {tuple(sorted(e["between"])): e for g in result["groups"] for e in g["evidence"]}
    assert "preprint-vs-published" in evidence[("vaswani2017arxiv", "vaswani2017attention")]["reasons"]
    assert evidence[("lee2020graph", "lee2020graph2")]["same_first_author"] is True


def test_annual_series_and_notices_are_not_duplicates(tmp_path):
    s = Store(tmp_path / "s.db")
    years = "\n".join(
        f"@article{{news{y}, title={{News from the Project}}, author={{Core Team}}, year={y}}}" for y in (2019, 2020, 2021)
    )
    import_text(s, years + """
@article{paper, title={International evaluation of an AI system}, author={McKinney, Scott}, year=2020, doi={10.1/p}}
@article{addendum, title={Addendum: International evaluation of an AI system}, author={McKinney, Scott}, year=2020, doi={10.1/a}}
""")
    result = find_duplicates(s)
    assert result["groups"] == [] and result["total_groups"] == 0
    assert result["series_like_count"] == 1 and result["series_like"][0]["years"] == [2019, 2020, 2021]
    s.close()


def test_dedupe_never_merges(store):
    before = store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
    find_duplicates(store)
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == before


def test_merge_plan_is_a_field_level_dry_run(store):
    plan = merge_plan(store, "lee2020graph", "lee2020graph2")
    fields = {f["field"]: f for f in plan["fields"]}
    assert fields["abstract"]["status"] == "drop_only" and fields["abstract"]["winner"] == "drop"
    assert fields["venue"]["status"] == "conflict" and fields["venue"]["winner"] == "keep"
    assert fields["doi"]["status"] == "keep_only"
    assert plan["conflicts"] == ["venue", "container-title"] or "venue" in plan["conflicts"]
    assert plan["applied"] is False and plan["drop_key_becomes_alias"] == "lee2020graph2"
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 7
    assert merge_plan(store, "lee2020graph", "lee2020graph2", prefer="drop")["fields"][3]["winner"] in ("drop", "keep")


def test_merge_errors(store):
    with pytest.raises(HygieneError) as exc:
        merge_plan(store, "lee2020graph", "lee2020graph")
    assert exc.value.code == "same-paper"
    with pytest.raises(HygieneError) as exc:
        merge_plan(store, "lee2020graph", "nope")
    assert exc.value.code == "not-found"
    with pytest.raises(HygieneError) as exc:
        merge_apply(store, "lee2020graph", "lee2020graph2", reason=" ")
    assert exc.value.code == "reason-required"


def test_merge_apply_keeps_everything_that_matters(store):
    library_org.add_tags(store, ["lee2020graph2"], ["from-the-duplicate"])
    note = library_org.add_note(store, "lee2020graph2", "check the supplement")
    result = merge_apply(store, "lee2020graph", "lee2020graph2", reason="same paper")
    assert result["applied"] and store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 6
    merged = get_entry(store, "lee2020graph2")  # the dropped key still resolves
    assert merged["key"]["key"] == "lee2020graph"
    paper = merged["paper"]
    assert paper["abstract"] == "An abstract." and paper["doi"] == "10.1/g" and paper["venue"] == "Nature"
    assert [r["tag"] for r in store.conn.execute("SELECT tag FROM paper_tags WHERE paper_id=?", (paper["id"],))] == ["from-the-duplicate"]
    assert [n["id"] for n in library_org.list_notes(store, "lee2020graph")] == [note["note_id"]]
    assert merged["reference"]["csl"]["abstract"] == "An abstract."
    assert store.conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert find_duplicates(store)["total_groups"] == 1  # only the vaswani pair remains


def test_merge_prefer_drop_wins_conflicts(store):
    merge_apply(store, "lee2020graph", "lee2020graph2", reason="same", prefer="drop")
    assert get_entry(store, "lee2020graph")["paper"]["venue"] == "Nature Comms"


def test_merge_preprint_into_published_gains_the_arxiv_id(store):
    merge_apply(store, "vaswani2017attention", "vaswani2017arxiv", reason="same work")
    paper = get_entry(store, "vaswani2017attention")["paper"]
    assert paper["doi"] == "10.5555/3295222.3295349" and paper["arxiv_id"] == "1706.03762"
    assert get_entry(store, "1706.03762")["paper"]["id"] == paper["id"]


def test_doctor_reports_evidence_and_unknowns(store, tmp_path):
    store.conn.execute("UPDATE papers SET verified=0 WHERE doi='10.1/s'")
    store.conn.commit()
    store.upsert_paper({"title": "Keyless paper", "year": 2018})
    report = doctor(store)
    s = report["summary"]
    assert s["papers"] == 8 and s["ok"] is False and s["problems"]["key_problems"] == 1
    assert s["problems"]["duplicate_groups"] == 2
    assert s["problems"]["doi_not_verified"] == 1
    assert s["unknown"]["integrity_unchecked"] == 8  # never reported as clean
    types = {p["type"] for p in report["problems"]["missing_required_fields"]}
    assert "article" in types or "misc" in types
    # a retracted paper that a manuscript cites is an error
    pid = get_entry(store, "solo2019")["paper"]["id"]
    store.conn.execute("INSERT INTO integrity(paper_id, status, source, checked_at) VALUES (?, 'retracted', 'crossref', 'now')", (pid,))
    store.conn.commit()
    assert doctor(store)["summary"]["problems"]["integrity_flagged"] == 1


def test_doctor_checks_bound_bibs_when_given_a_workspace(store, tmp_path):
    from papermemory.library_export import export_library

    ws = tmp_path / "ws"
    ws.mkdir()
    library_org.create_collection(store, "refs", project="thesis", bib_path="references.bib")
    library_org.add_to_collection(store, "refs", ["solo2019"])
    assert doctor(store)["summary"]["unknown"]["bound_bibs"].startswith("not checked")
    first = doctor(store, cwd=str(ws))
    assert first["problems"]["bound_bib_not_in_sync"][0]["status"] == "missing"
    export_library(store, collection="refs", cwd=str(ws))
    assert "bound_bib_not_in_sync" not in doctor(store, cwd=str(ws))["problems"]


def test_cli_dedupe_merge_doctor(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "cli.db"))
    src = tmp_path / "r.bib"
    src.write_text(BIB, encoding="utf-8")
    assert cli_main(["library", "import", str(src)]) == 0
    assert cli_main(["library", "dedupe"]) == 0
    assert cli_main(["library", "merge", "lee2020graph", "lee2020graph2"]) == 0
    assert cli_main(["library", "merge", "lee2020graph", "lee2020graph2", "--apply"]) == 2  # needs a reason
    assert cli_main(["library", "merge", "lee2020graph", "lee2020graph2", "--apply", "--reason", "same"]) == 0
    assert cli_main(["library", "doctor"]) == 0
    assert "paper(s)" in capsys.readouterr().out


def test_cli_resolve_and_integrity(tmp_path, monkeypatch, capsys):
    import json as _json

    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "cli.db"))
    src = tmp_path / "r.bib"
    src.write_text(BIB, encoding="utf-8")
    assert cli_main(["library", "import", str(src), "--project", "thesis"]) == 0
    capsys.readouterr()
    assert cli_main(["library", "resolve", "lee2020graph", "10.5555/3295222.3295349", "ghost", "--json"]) == 0
    result = _json.loads(capsys.readouterr().out)
    assert [r["found"] for r in result["results"]] == [True, True, False]
    assert cli_main(["library", "resolve", "x", "--project-keys"]) == 2  # a project is required for project keys
    items = _json.dumps([{"ref": "10.1/g", "status": "corrected", "source": "crossref"}, {"ref": "ghost", "status": "ok"}])
    assert cli_main(["library", "integrity", "set", "--items-json", items, "--json"]) == 0
    out = _json.loads(capsys.readouterr().out)
    assert out["written"] == 1 and out["unresolved"] == ["ghost"]
    assert cli_main(["library", "integrity", "set", "--items-json", "not json"]) == 2
