from __future__ import annotations

import json

from papermemory import mcp_server
from papermemory.cli import build_parser, cmd_ingest
from papermemory.db import Store

BODY = """# P

## Methods

We used a sample of 120 participants in the trial.

## Results

The effect was 0.41 with a confidence interval.
"""


def _paper(tmp_path, name="p.md", doi="10.30/wire"):
    path = tmp_path / name
    path.write_text(f"---\ndoi: {doi}\ntitle: Scope Wiring\nyear: 2024\n---\n" + BODY, encoding="utf-8")
    return path


def _ah_project(tmp_path, name="My Paper"):
    root = tmp_path / name
    child = root / "draft"
    child.mkdir(parents=True)
    (root / "ah.yaml").write_text("project: {}\n", encoding="utf-8")
    return root, child


def _run_cli(monkeypatch, tmp_path, capsys, paper, *, cwd=None, project=None):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    argv = ["ingest", str(paper), "--json"]
    if cwd is not None:
        argv.extend(["--cwd", str(cwd)])
    if project is not None:
        argv.extend(["--project", project])
    assert cmd_ingest(build_parser().parse_args(argv)) == 0
    return json.loads(capsys.readouterr().out)


def _project_keys(doi: str) -> set[str]:
    store = Store()
    row = store.conn.execute("SELECT id FROM papers WHERE doi=?", (doi,)).fetchone()
    keys = {
        record["project_key"]
        for record in store.conn.execute(
            "SELECT project_key FROM paper_projects WHERE paper_id=?", (row["id"],)
        )
    }
    store.close()
    return keys


def test_cli_cwd_inside_ah_root_uses_directory_slug(monkeypatch, tmp_path, capsys):
    _, child = _ah_project(tmp_path)
    _run_cli(monkeypatch, tmp_path, capsys, _paper(tmp_path, doi="10.30/ah"), cwd=child)
    assert _project_keys("10.30/ah") == {"my-paper"}


def test_cli_cwd_equal_to_manuscript_root_uses_manuscript_slug(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    manuscript_root = tmp_path / "msroot"
    manuscript_root.mkdir()
    store = Store()
    store.upsert_manuscript({"title": "MS", "slug": "ms-slug", "root_path": str(manuscript_root)})
    store.close()

    _run_cli(monkeypatch, tmp_path, capsys, _paper(tmp_path, doi="10.30/ms"), cwd=manuscript_root)
    assert _project_keys("10.30/ms") == {"ms-slug"}


def test_cli_explicit_project_is_slugified_and_wins_over_cwd(monkeypatch, tmp_path, capsys):
    ah_root, child = _ah_project(tmp_path, name="ah-dir")
    _run_cli(monkeypatch, tmp_path, capsys, _paper(tmp_path, doi="10.30/explicit"), cwd=child, project="My Paper")
    assert _project_keys("10.30/explicit") == {"my-paper"}


def test_cli_unknown_cwd_uses_unassigned(monkeypatch, tmp_path, capsys):
    _run_cli(monkeypatch, tmp_path, capsys, _paper(tmp_path, doi="10.30/unknown"), cwd=tmp_path / "nowhere")
    assert _project_keys("10.30/unknown") == {"unassigned"}


def test_cli_without_project_or_cwd_stays_unscoped(monkeypatch, tmp_path, capsys):
    _run_cli(monkeypatch, tmp_path, capsys, _paper(tmp_path, doi="10.30/unscoped"))
    assert _project_keys("10.30/unscoped") == set()


def test_mcp_ingest_cwd_matches_cli(monkeypatch, tmp_path):
    _, child = _ah_project(tmp_path)
    paper = _paper(tmp_path, doi="10.30/mcp")
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    result = mcp_server._call("papermemory_ingest", {"path": str(paper), "cwd": str(child)})
    assert not result.get("isError")
    assert _project_keys("10.30/mcp") == {"my-paper"}


def test_mcp_ingest_explicit_project_is_slugified(monkeypatch, tmp_path):
    _, child = _ah_project(tmp_path, name="ah-dir")
    paper = _paper(tmp_path, doi="10.30/mcp-explicit")
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    result = mcp_server._call(
        "papermemory_ingest", {"path": str(paper), "cwd": str(child), "project": "My Paper"}
    )
    assert not result.get("isError")
    assert _project_keys("10.30/mcp-explicit") == {"my-paper"}
