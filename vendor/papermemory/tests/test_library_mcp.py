from __future__ import annotations

import json

import pytest

from papermemory import mcp_server

BIB = """
@article{lee2020graph, title={Graph networks for molecules}, author={Lee, Ann}, journal={Nature}, year=2020, doi={10.1/a}}
@article{roe2021vision, title={Vision transformers at scale}, author={Roe, Rae}, journal={CVPR}, year=2021, doi={10.1/b}}
"""


@pytest.fixture()
def call(monkeypatch, tmp_path):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    monkeypatch.chdir(tmp_path)

    def run(**args):
        result = mcp_server._call("papermemory_library", args)
        payload = json.loads(result["content"][0]["text"])
        return payload, bool(result.get("isError"))

    return run


def test_tool_is_listed_with_all_actions():
    tool = next(t for t in mcp_server.TOOLS if t["name"] == "papermemory_library")
    assert set(tool["inputSchema"]["properties"]["action"]["enum"]) >= {
        "list", "get", "resolve", "import", "export", "tag", "collection", "note", "keys", "dedupe", "merge", "doctor", "set_integrity"}
    assert tool["inputSchema"]["required"] == ["action"]


def test_unknown_and_incomplete_calls_are_clean_errors(call):
    payload, is_error = call(action="explode")
    assert is_error and payload["code"] == "invalid-argument"
    payload, is_error = call(action="get")
    assert is_error and "ref" in payload["error"]
    payload, is_error = call(action="tag", op="add")
    assert is_error
    payload, is_error = call(action="get", ref="nothing-here")
    assert is_error and payload["code"] == "not-found"


def test_import_list_get_resolve(call):
    imported, err = call(action="import", text=BIB, project="thesis")
    assert not err and imported["counts"]["added"] == 2
    listed, _ = call(action="list", query="year:2021..")
    assert [r["key"] for r in listed["rows"]] == ["roe2021vision"]
    got, _ = call(action="get", ref="10.1/a")
    assert got["key"]["key"] == "lee2020graph" and got["reference"]["csl"]["container-title"] == "Nature"
    res, _ = call(action="resolve", refs=["lee2020graph", "10.1/b", "ghost"], project="thesis", project_keys=True)
    assert [r["found"] for r in res["results"]] == [True, True, False]
    assert res["project_keys"] == ["lee2020graph", "roe2021vision"]
    dry, _ = call(action="import", text="@article{x, title={Other}, doi={10.1/x}}", dry_run=True)
    assert dry["dry_run"] and call(action="list")[0]["total_count"] == 2


def test_import_path_is_sandboxed(call, tmp_path):
    outside, is_error = call(action="import", path="/etc/passwd")
    assert is_error and outside["code"] == "path-escape"
    inside = tmp_path / "r.bib"
    inside.write_text(BIB, encoding="utf-8")
    payload, is_error = call(action="import", path=str(inside))
    assert not is_error and payload["counts"]["added"] == 2


def test_export_inline_to_file_and_confinement(call, tmp_path):
    call(action="import", text=BIB, project="thesis")
    inline, err = call(action="export", all=True)
    assert not err and "@article{lee2020graph," in inline["text"]
    nothing, err = call(action="export")
    assert err and nothing["code"] == "no-scope"
    ws = tmp_path / "ws"
    ws.mkdir()
    written, err = call(action="export", all=True, out="references.bib", cwd=str(ws))
    assert not err and written["written"] and (ws / "references.bib").exists()
    checked, _ = call(action="export", all=True, out="references.bib", cwd=str(ws), check=True)
    assert checked["status"] == "in_sync"
    escape, err = call(action="export", all=True, out="../x.bib", cwd=str(ws))
    assert err and escape["code"] == "path-outside-workspace"
    bad_cwd, err = call(action="export", all=True, out="x.bib", cwd="/etc")
    assert err and bad_cwd["code"] == "path-escape"


def test_organise_keys_merge_doctor_integrity(call):
    call(action="import", text=BIB + "\n@article{lee2020graph2, title={Graph networks for molecules}, author={Lee, Ann}, year=2020, abstract={Hi.}}")
    assert call(action="tag", op="add", tags=["ML"], refs=["lee2020graph"])[0]["added"] == 1
    assert call(action="tag", op="list")[0]["tags"] == [{"tag": "ml", "papers": 1}]
    assert call(action="collection", op="create", slug="refs")[0]["slug"] == "refs"
    assert call(action="collection", op="add", slug="refs", refs=["lee2020graph"])[0]["added"] == 1
    assert call(action="collection", op="show", slug="refs")[0]["total_count"] == 1
    note, _ = call(action="note", op="add", ref="lee2020graph", text="read it")
    assert call(action="note", op="list", ref="lee2020graph")[0]["notes"][0]["id"] == note["note_id"]
    assert call(action="keys", op="check")[0]["summary"]["ok"] is True
    plan, _ = call(action="keys", op="rekey", ref="lee2020graph", to="graphnets2020")
    assert plan["applied"] is False
    refused, err = call(action="keys", op="rekey", ref="lee2020graph", to="graphnets2020", apply=True)
    assert err and refused["code"] == "reason-required"
    assert call(action="keys", op="rekey", ref="lee2020graph", to="graphnets2020", apply=True, reason="clearer")[0]["applied"]
    dupes, _ = call(action="dedupe")
    assert dupes["total_groups"] == 1
    preview, _ = call(action="merge", keep="graphnets2020", drop="lee2020graph2")
    assert preview["applied"] is False
    merged, _ = call(action="merge", keep="graphnets2020", drop="lee2020graph2", apply=True, reason="same paper")
    assert merged["applied"]
    integ, _ = call(action="set_integrity", items=[
        {"ref": "10.1/b", "status": "retracted", "source": "crossref", "notice_doi": "10.1/n"},
        {"ref": "10.1/zzz", "status": "ok"}, {"ref": "10.1/a", "status": "maybe"}])
    assert integ["written"] == 1 and integ["unresolved"] == ["10.1/zzz"] and integ["rejected"][0]["ref"] == "10.1/a"
    report, _ = call(action="doctor")
    assert report["summary"]["problems"]["integrity_flagged"] == 1 and report["summary"]["ok"] is False
    flagged, _ = call(action="list", query="integrity:retracted")
    assert [r["key"] for r in flagged["rows"]] == ["roe2021vision"]


def test_host_can_hide_the_library_tool(monkeypatch, tmp_path):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    from papermemory.cli import main as cli_main

    assert "papermemory_library" in [t["name"] for t in mcp_server.active_tools()]
    monkeypatch.setenv("PAPERMEMORY_HIDE_TOOLS", "papermemory_library, nothing-else")
    names = [t["name"] for t in mcp_server.active_tools()]
    assert "papermemory_library" not in names and len(names) == len(mcp_server.TOOLS) - 1
    refused = mcp_server._call("papermemory_library", {"action": "list"})
    assert refused["isError"] and json.loads(refused["content"][0]["text"])["code"] == "tool-disabled"
    assert mcp_server._call("papermemory_search", {"query": "x"})["content"]  # the rest still works
    assert cli_main(["tools", "--json"]) == 0
