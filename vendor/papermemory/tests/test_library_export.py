from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from papermemory import library_org
from papermemory.bibparse import parse_bib
from papermemory.cli import main as cli_main
from papermemory.db import Store
from papermemory.ingest import ingest_manuscript
from papermemory.library import get_entry, import_text
from papermemory.library_export import (
    BEGIN, END, HAND, ExportError, export_library, render, resolve_out_path, select_papers, export_keys,
)

BIB = r"""
@article{he2016deep,
  title={Deep {Residual} Learning for {Image} Recognition},
  author={He, Kaiming and M{\"u}ller, K. and others},
  journal={CVPR}, month=mar, year={2016}, pages={770--778}, volume={5}, number={2}, doi={10.1109/CVPR.2016.90},
  mrnumber={123}, pdf={/tmp/secret/a.pdf}, eprint={1512.03385}, archiveprefix={arXiv}}
@phdthesis{mondol2024thesis, author={Mondol, Raktim Kumar}, title={A thesis}, school={UNSW}, year=2024}
@inproceedings{lee2020conf, author={Lee, Ann}, title={Conference & talk_50%}, booktitle={Proc. X}, year=2020, address={Sydney}}
"""
RIS = "TY  - JOUR\nTI  - From RIS: a title & more\nAU  - Roe, Rae\nPY  - 2021\nDA  - 2021/05/17\nJO  - Journal Y\nVL  - 3\nSP  - 10\nEP  - 20\nDO  - 10.1/ris\nER  -\n"


@pytest.fixture()
def store(tmp_path):
    s = Store(tmp_path / "pm.db")
    import_text(s, BIB, project_id="thesis")
    import_text(s, RIS, fmt="ris")
    yield s
    s.close()


def _entries(text):
    return {e.key: e for e in parse_bib(text).entries}


def test_no_scope_is_refused(store):
    with pytest.raises(ExportError) as exc:
        export_library(store)
    assert exc.value.code == "no-scope"


def test_bibtex_inline_uses_original_values_and_standard_fields(store):
    text = export_library(store, everything=True)["text"]
    entries = _entries(text)
    assert set(entries) == {"he2016deep", "mondol2024thesis", "lee2020conf", "roe2021ris"}
    he = entries["he2016deep"].fields
    assert he["author"] == r"He, Kaiming and M{\"u}ller, K. and others"  # the author's LaTeX survives
    assert he["title"] == "Deep {Residual} Learning for {Image} Recognition"
    assert he["pages"] == "770--778" and he["month"] == "mar" and he["year"] == "2016"
    assert "mrnumber" not in he and "pdf" not in he  # unmapped and local-path fields stay out by default
    assert "/tmp/secret" not in text
    assert list(entries) == sorted(entries, key=str.lower)  # deterministic order


def test_fields_all_adds_unmapped_but_never_local_paths(store):
    text = export_library(store, everything=True, fields="all")["text"]
    fields = _entries(text)["he2016deep"].fields
    assert fields["mrnumber"] == "123" and "pdf" not in fields


def test_types_per_dialect(store):
    classic = _entries(export_library(store, everything=True, fmt="bibtex")["text"])
    assert classic["mondol2024thesis"].entry_type == "phdthesis" and classic["mondol2024thesis"].fields["school"] == "UNSW"
    modern = _entries(export_library(store, everything=True, fmt="biblatex")["text"])
    thesis = modern["mondol2024thesis"]
    assert thesis.entry_type == "thesis" and thesis.fields["type"] == "phdthesis" and thesis.fields["institution"] == "UNSW"
    assert modern["he2016deep"].fields["journaltitle"] == "CVPR" and modern["he2016deep"].fields["date"] == "2016-03"
    assert modern["lee2020conf"].fields["location"] == "Sydney" and "address" not in modern["lee2020conf"].fields


def test_a_full_date_survives_classic_bibtex(tmp_path):
    s = Store(tmp_path / "d.db")
    import_text(s, "@article{d1, title={T}, year={2026}, date={2026-05-28}, doi={10.1/d}}")
    fields = _entries(export_library(s, everything=True)["text"])["d1"].fields
    assert fields["year"] == "2026" and fields["date"] == "2026-05-28"
    import_text(s := Store(tmp_path / "d2.db"), export_library(Store(tmp_path / "d.db"), everything=True)["text"])
    assert get_entry(s, "d1")["reference"]["csl"]["issued"] == {"date-parts": [[2026, 5, 28]]}
    s.close()


def test_csl_sourced_text_is_escaped_for_bibtex(store):
    fields = _entries(export_library(store, everything=True)["text"])["roe2021ris"].fields
    assert fields["title"] == r"From RIS: a title \& more"
    assert fields["pages"] == "10--20" and fields["journal"] == "Journal Y"


def test_style_original_keeps_the_entry_as_written_with_the_export_key(store):
    text = export_library(store, everything=True, style="original")["text"]
    entry = _entries(text)["he2016deep"]
    assert entry.fields["pdf"] == "/tmp/secret/a.pdf" and entry.fields["mrnumber"] == "123"  # verbatim, as the author wrote it


def test_round_trip_keeps_the_meaning(store, tmp_path):
    text = export_library(store, everything=True, fmt="biblatex")["text"]
    fresh = Store(tmp_path / "fresh.db")
    import_text(fresh, text, fmt="bibtex")
    for key in ("he2016deep", "mondol2024thesis", "lee2020conf", "roe2021ris"):
        a = get_entry(store, key)["reference"]["csl"]
        b = get_entry(fresh, key)["reference"]["csl"]
        for field in ("title", "author", "issued", "container-title", "volume", "page", "DOI"):
            assert a.get(field) == b.get(field), (key, field)
    fresh.close()


def test_ris_csv_csl_json_and_json(store):
    ris = export_library(store, everything=True, fmt="ris")["text"]
    assert ris.count("TY  - ") == 4 and "ID  - he2016deep" in ris and "SP  - 770\nEP  - 778" in ris
    assert ris.count("ER  - ") == 4
    data = json.loads(export_library(store, everything=True, fmt="csl-json")["text"])
    assert {d["id"] for d in data} == {d["citation-key"] for d in data} and len(data) == 4
    rows = json.loads(export_library(store, everything=True, fmt="json")["text"])
    assert rows[0]["key"] == "he2016deep" and rows[0]["extra"]["mrnumber"] == "123"
    csv_text = export_library(store, everything=True, fmt="csv")["text"].splitlines()
    assert csv_text[0].startswith("key,type,title,authors") and len(csv_text) == 5


def test_scopes_filter_collection_project_and_cited_only(store, tmp_path):
    library_org.create_collection(store, "refs", project="thesis", bib_path="references.bib")
    library_org.add_to_collection(store, "refs", ["he2016deep", "lee2020conf"])
    assert export_library(store, query=["year:2020"])["count"] == 1
    assert export_library(store, collection="refs")["count"] == 2
    assert export_library(store, project="thesis")["count"] == 3  # imported under the project

    root = tmp_path / "ms"
    (root / "sections").mkdir(parents=True)
    (root / "references.bib").write_text("", encoding="utf-8")
    (root / "sections" / "i.tex").write_text(r"\citep{he2016deep} and \citep{ghost}.", encoding="utf-8")
    (root / "main.tex").write_text("\\input{sections/i}\n", encoding="utf-8")
    ingest_manuscript(store, root, slug="thesis")
    result = export_library(store, cited_only="thesis")
    assert result["count"] == 1 and result["missing_keys"] == ["ghost"]
    with pytest.raises(ExportError) as exc:
        export_library(store, cited_only="nope")
    assert exc.value.code == "manuscript-not-found"


def test_project_keys_win_and_collisions_fall_back(tmp_path):
    s = Store(tmp_path / "k.db")
    import_text(s, "@article{smith2020, title={Alpha}, doi={10.1/a}, year=2020}", project_id="one")
    import_text(s, "@article{smith2020, title={Beta}, doi={10.1/b}, year=2020}", project_id="two")
    text = export_library(s, project="two")["text"]
    assert "Beta" in text and _entries(text)["smith2020"].fields["title"] == "Beta"  # project two's own key, not smith2020a
    both = export_library(s, everything=True)["text"]
    assert set(_entries(both)) == {"smith2020", "smith2020a"}
    ids, _ = select_papers(s, everything=True)
    keys, warnings = export_keys(s, ids, "two")
    assert sorted(keys.values()) == ["smith2020", "smith2020a"] and warnings  # collision reported, both written
    s.close()


def test_export_assigns_missing_keys_but_a_check_never_writes(tmp_path):
    s = Store(tmp_path / "m.db")
    s.upsert_paper({"title": "Quantum widgets", "authors": ["Ann Lee"], "year": 2020, "doi": "10.1/q"})
    s.conn.execute("DELETE FROM bib_keys")  # simulate a paper that predates the library
    s.conn.execute("UPDATE papers SET bibtex_key=NULL")
    s.conn.commit()
    with pytest.raises(ExportError) as exc:
        export_library(s, everything=True, out="x.bib", cwd=str(tmp_path), check=True)
    assert exc.value.code == "missing-keys"
    assert s.conn.execute("SELECT COUNT(*) FROM bib_keys").fetchone()[0] == 0
    result = export_library(s, everything=True)
    assert "@misc{lee2020quantum," in result["text"] or "lee2020quantum" in result["text"]
    assert any("assigned keys" in w for w in result["warnings"])
    assert s.conn.execute("SELECT policy FROM bib_keys").fetchone()["policy"] == "generated"
    s.close()


def test_inline_cap(store, monkeypatch):
    from papermemory import library_export

    monkeypatch.setattr(library_export, "MAX_INLINE", 2)
    with pytest.raises(ExportError) as exc:
        export_library(store, everything=True)
    assert exc.value.code == "too-large-for-inline"


def test_out_path_must_stay_inside_the_workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    assert resolve_out_path("refs/a.bib", str(ws)) == (ws / "refs" / "a.bib").resolve()
    for bad in ("../x.bib", "/etc/passwd.bib", str(tmp_path / "other.bib")):
        with pytest.raises(ExportError) as exc:
            resolve_out_path(bad, str(ws))
        assert exc.value.code == "path-outside-workspace"
    link = ws / "link"
    link.symlink_to(tmp_path)
    with pytest.raises(ExportError):
        resolve_out_path("link/x.bib", str(ws))


# ---------- managed files ----------


def _export(store, ws, **kw):
    return export_library(store, everything=True, out="references.bib", cwd=str(ws), **kw)


def test_managed_file_lifecycle(store, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    path = ws / "references.bib"
    first = _export(store, ws)
    assert first["status"] == "missing" and first["written"] and first["frozen"] == 4
    text = path.read_text()
    assert BEGIN in text and END in text and HAND in text and "managed-sha256" in text
    assert store.conn.execute("SELECT frozen_in FROM bib_keys WHERE key='he2016deep'").fetchone()[0] == "export:references.bib"

    mtime = path.stat().st_mtime_ns
    again = _export(store, ws)
    assert again["status"] == "in_sync" and not again["written"] and path.stat().st_mtime_ns == mtime  # untouched, no spurious diff
    assert _export(store, ws, check=True)["status"] == "in_sync"

    library_org.add_tags(store, ["he2016deep"], ["x"])  # tags are not exported
    assert _export(store, ws, check=True)["status"] == "in_sync"
    import_text(store, "@article{new2022, title={New}, doi={10.1/n}, year=2022}")
    checked = _export(store, ws, check=True)
    assert checked["status"] == "out_of_date" and checked["diff"]["added"] == ["new2022"] and path.read_text() == text
    done = _export(store, ws)
    assert done["status"] == "out_of_date" and done["written"] and "new2022" in path.read_text()


def test_hand_added_section_is_preserved(store, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    _export(store, ws)
    path = ws / "references.bib"
    path.write_text(path.read_text() + "@misc{mine, title={Hand written}}\n", encoding="utf-8")
    import_text(store, "@article{new2022, title={New}, doi={10.1/n}, year=2022}")
    _export(store, ws)
    final = path.read_text()
    assert "@misc{mine" in final and final.index(HAND) < final.index("@misc{mine") and "new2022" in final


def test_editing_inside_the_managed_block_is_refused_then_forced_with_backup(store, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    _export(store, ws)
    path = ws / "references.bib"
    path.write_text(path.read_text().replace("Learning for", "Learning FOR"), encoding="utf-8")
    checked = _export(store, ws, check=True)
    assert checked["status"] == "hand_edited" and "he2016deep" in checked["edited_keys"]
    with pytest.raises(ExportError) as exc:
        _export(store, ws)
    assert exc.value.code == "hand-edited"
    assert "Learning FOR" in path.read_text()  # untouched
    forced = _export(store, ws, force=True)
    assert forced["status"] == "overwritten" and Path(forced["backup"]).exists()
    assert "Learning FOR" in Path(forced["backup"]).read_text() and "Learning for" in path.read_text()


def test_unmanaged_file_needs_adopt_and_keeps_unrelated_entries(store, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    path = ws / "references.bib"
    original = "% my notes\n@article{he2016deep, title={Old copy}}\n\n@misc{unrelated, title={Keep me}}\n"
    path.write_text(original, encoding="utf-8")
    checked = _export(store, ws, check=True)
    assert checked["status"] == "not_managed" and checked["would_absorb"] == ["he2016deep"]
    with pytest.raises(ExportError) as exc:
        _export(store, ws)
    assert exc.value.code == "not-managed" and path.read_text() == original
    done = _export(store, ws, adopt=True)
    assert done["status"] == "adopted" and Path(done["backup"]).read_text() == original
    text = path.read_text()
    assert "Old copy" not in text and "% my notes" in text
    hand = text[text.index(HAND):]
    assert "@misc{unrelated" in hand and "he2016deep" not in hand
    assert _export(store, ws, check=True)["status"] == "in_sync"


def test_non_bib_formats_do_not_clobber_existing_files(store, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "mine.ris").write_text("precious", encoding="utf-8")
    with pytest.raises(ExportError) as exc:
        export_library(store, everything=True, fmt="ris", out="mine.ris", cwd=str(ws))
    assert exc.value.code == "exists" and (ws / "mine.ris").read_text() == "precious"
    done = export_library(store, everything=True, fmt="ris", out="mine.ris", cwd=str(ws), force=True)
    assert done["written"] and Path(done["backup"]).read_text() == "precious"
    assert export_library(store, everything=True, fmt="ris", out="mine.ris", cwd=str(ws))["status"] == "in_sync"


def test_collection_bound_to_a_bib_exports_there_by_default(store, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    library_org.create_collection(store, "refs", project="thesis", bib_path="refs/thesis.bib")
    library_org.add_to_collection(store, "refs", ["he2016deep"])
    result = export_library(store, collection="refs", cwd=str(ws))
    assert result["written"] and (ws / "refs" / "thesis.bib").exists() and result["project"] == "thesis"


def test_export_through_a_rekey_keeps_the_old_key_resolving(store, tmp_path):
    from papermemory import library_keys

    ws = tmp_path / "ws"
    ws.mkdir()
    _export(store, ws)
    library_keys.rekey(store, "he2016deep", to="resnet2016", reason="clearer", apply=True)
    checked = _export(store, ws, check=True)
    assert checked["status"] == "out_of_date" and "resnet2016" in checked["diff"]["added"] and "he2016deep" in checked["diff"]["removed"]
    assert get_entry(store, "he2016deep")["key"]["key"] == "resnet2016"


def test_cli_export(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "cli.db"))
    ws = tmp_path / "ws"
    ws.mkdir()
    src = ws / "in.bib"
    src.write_text(BIB, encoding="utf-8")
    assert cli_main(["library", "import", str(src)]) == 0
    capsys.readouterr()
    assert cli_main(["library", "export"]) == 2  # no scope
    assert cli_main(["library", "export", "--all"]) == 0
    assert "@article{he2016deep," in capsys.readouterr().out
    assert cli_main(["library", "export", "--all", "--out", "references.bib", "--cwd", str(ws)]) == 0
    assert cli_main(["library", "export", "--all", "--out", "references.bib", "--cwd", str(ws), "--check"]) == 0
    assert cli_main(["library", "export", "--all", "--out", "../escape.bib", "--cwd", str(ws)]) == 2
    assert cli_main(["library", "export", "--all", "--format", "ris", "--out", "x.ris", "--cwd", str(ws)]) == 0


# ---------- one paper, several versions ----------

TRUNCATED = "@article{vit, title={An image is worth 16x16 words}, author={Dosovitskiy, A. and Beyer, L. and others}, year=2021, doi={10.1/vit}}"
FULL = ("@article{dosovitskiy2021image, title={An Image is Worth 16x16 Words}, author={Dosovitskiy, Alexey and Beyer, Lucas and "
        "Kolesnikov, Alexander}, journal={ICLR}, year=2021, doi={10.1/vit}, abstract={Transformers for images.}}")


def test_every_imported_version_is_kept_and_the_most_complete_is_canonical(tmp_path):
    s = Store(tmp_path / "v.db")
    import_text(s, TRUNCATED, project_id="one")
    second = import_text(s, FULL, project_id="two")
    assert second["entries"][0]["meta"] == "replaced" and second["entries"][0]["new_variant"] is True
    assert import_text(s, FULL, project_id="two")["entries"][0]["new_variant"] is False  # identical re-import adds nothing
    assert s.conn.execute("SELECT COUNT(*) FROM reference_variants").fetchone()[0] == 2
    entry = get_entry(s, "vit")
    assert len(entry["reference"]["csl"]["author"]) == 3 and entry["reference"]["csl"]["abstract"] == "Transformers for images."
    assert len(entry["paper"]["authors"]) == 3  # the list column followed the richer record
    # a thinner later version never displaces the richer canonical record
    import_text(s, TRUNCATED, project_id="three")
    assert len(get_entry(s, "vit")["reference"]["csl"]["author"]) == 3
    s.close()


def test_project_export_reproduces_that_projects_own_version(tmp_path):
    s = Store(tmp_path / "v.db")
    import_text(s, TRUNCATED, project_id="one")
    import_text(s, FULL, project_id="two")
    one = _entries(export_library(s, project="one")["text"])["vit"].fields
    two = _entries(export_library(s, project="two")["text"])["dosovitskiy2021image"].fields
    assert one["author"].endswith("and others") and one["title"] == "An image is worth 16x16 words"
    assert two["author"].count(" and ") == 2 and two["title"] == "An Image is Worth 16x16 Words"
    canonical = _entries(export_library(s, project="one", variant="canonical")["text"])["vit"].fields
    assert canonical["author"].count(" and ") == 2 and canonical["journal"] == "ICLR"
    s.close()


def test_merge_moves_variants_and_export_tables_round_trip(tmp_path):
    s = Store(tmp_path / "v.db")
    import_text(s, "@article{a, title={One thing}, doi={10.1/a}, year=2020}", project_id="p1")
    import_text(s, "@article{b, title={One thing again}, year=2020}", project_id="p2")
    a, b = get_entry(s, "a")["paper"]["id"], get_entry(s, "b")["paper"]["id"]
    s.merge_papers(b, a)
    assert s.conn.execute("SELECT COUNT(*) FROM reference_variants WHERE paper_id=?", (a,)).fetchone()[0] == 2
    from papermemory.ops import export_store, restore_store

    out = tmp_path / "x.jsonl"
    assert export_store(s, out)["tables"]["reference_variants"] == 2
    fresh = Store(tmp_path / "fresh.db")
    restore_store(fresh, out)
    assert fresh.conn.execute("SELECT COUNT(*) FROM reference_variants").fetchone()[0] == 2
    s.close()
    fresh.close()


def test_a_bound_collection_only_defaults_to_its_bib_for_bibtex_formats(store, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    library_org.create_collection(store, "refs", project="thesis", bib_path="refs/thesis.bib")
    library_org.add_to_collection(store, "refs", ["he2016deep"])
    for fmt in ("csl-json", "ris", "json", "csv"):
        result = export_library(store, collection="refs", fmt=fmt, cwd=str(ws))
        assert "text" in result and not result.get("written"), fmt  # returned inline, nothing written
    assert not (ws / "refs").exists()
    assert export_library(store, collection="refs", fmt="biblatex", cwd=str(ws))["written"]  # BibLaTeX still goes to the .bib
    # asking again for CSL-JSON after the .bib exists must not trip over the existing file
    assert json.loads(export_library(store, collection="refs", fmt="csl-json", cwd=str(ws))["text"])[0]["citation-key"] == "he2016deep"
