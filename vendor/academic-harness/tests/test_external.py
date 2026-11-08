"""Tier TX: results of external tools (numbers_audit, figure_audit, citation) as ledger findings.

The bridge that produces `.ah/external/<tool>.json` lives in the plugin's JavaScript; these tests write the
files by hand and pin what the engine does with them: stable fingerprints, a cause for every new finding,
and a stale or broken result that is reported instead of silently reused or silently fixed.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from ah.audit import audit
from ah.checks.base import CATALOGUE, DEFAULT_TIERS
from ah.cli import main
from ah.external import TOOL_CHECKS, plan
from ah.project import Project
from ah.util import sha256_file

INTRO = "sections/01_introduction/index.tex"


def _line_of(project: Project, needle: str) -> int:
    path = project.tex_root / INTRO
    return next(i for i, line in enumerate(path.read_text().splitlines(), 1) if needle in line)


def write_result(project: Project, tool: str, findings: list[dict], *, inputs: dict | None = None, **over) -> Path:
    """What external-bridge.js writes: findings plus the hash of every file the tool was run on."""
    recorded = inputs if inputs is not None else {e["path"]: sha256_file(project.root / e["path"]) for e in plan(project)[tool]["files"]}
    d = project.state_dir / "external"
    d.mkdir(parents=True, exist_ok=True)
    body = {"schema": 1, "tool": tool, "generated_at": "2026-11-09T00:00:00Z", "inputs": recorded, "findings": findings, **over}
    path = d / f"{tool}.json"
    path.write_text(json.dumps(body))
    return path


def stat_finding(project: Project, key: str = "p_value|t(28) = 2.1|p = 0.9", needle: str = "1240") -> dict:
    return {"check": "STAT-01", "file": INTRO, "line": _line_of(project, needle), "key": key,
            "message": "reported p = 0.9 but t(28) = 2.1 gives p = 0.044"}


def run(project_dir: Path, **kw) -> dict:
    return audit(Project(str(project_dir)), DEFAULT_TIERS, external="", **kw)


def tx(rep: dict) -> list[dict]:
    return [f for f in rep["findings"] if f["tier"] == "TX"]


def test_catalogue_and_tool_map_agree():
    for tool, checks in TOOL_CHECKS.items():
        for c in checks:
            assert CATALOGUE[c][0] == "TX", (tool, c)
    assert {c for c, v in CATALOGUE.items() if v[0] == "TX"} == {c for cs in TOOL_CHECKS.values() for c in cs} | {"EXT-00"}


def test_tx_is_off_unless_external_is_given(project_dir):
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [stat_finding(p)])
    rep = audit(p, DEFAULT_TIERS)
    assert "TX" not in rep["tiers"] and "external" not in rep
    assert not tx(rep)


def test_fresh_results_become_tx_findings_with_a_unit_and_a_level(project_dir):
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [stat_finding(p)])
    rep = run(project_dir)
    (f,) = tx(rep)
    assert f["check"] == "STAT-01" and f["level"] == "minor"
    assert f["unit"] and "#" not in f["unit"], "anchored unit id, resolved from file + line"
    assert rep["external"]["tools"]["numbers_audit"]["status"] == "fresh"
    assert rep["external"]["tools"]["figure_audit"]["status"] == "not-applicable"
    assert rep["external"]["tools"]["citation"]["status"] == "missing"
    assert "TX" in rep["tiers"]


def test_a_second_audit_changes_nothing_and_every_new_finding_has_a_cause(project_dir):
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [stat_finding(p)])
    first = run(project_dir)
    second = run(project_dir)
    assert second["ledger"]["new"] == 0 and second["ledger"]["fixed"] == 0
    assert not first["unexplained"] and not second["unexplained"]
    assert first["report_hash"] == second["report_hash"]


def test_the_key_not_the_line_identifies_a_finding(project_dir):
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [stat_finding(p)])
    first = tx(run(project_dir))[0]
    intro = p.tex_root / INTRO
    intro.write_text("% a note above everything\n" + intro.read_text())      # every line below moves down by one
    write_result(p, "numbers_audit", [stat_finding(p)])                      # the tool is re-run on the edited file
    again = run(project_dir)
    (f,) = tx(again)
    assert f["line"] == first["line"] + 1, "the line moved"
    assert f["fingerprint"] == first["fingerprint"], "the finding did not"
    assert [x for x in again["findings"] if x["check"] == "STAT-01"][0]["state"] == "open"
    assert not again["unexplained"]


def test_an_edit_makes_the_result_stale_and_the_old_findings_are_not_fixed_by_their_absence(project_dir):
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [stat_finding(p)])
    run(project_dir)
    intro = p.tex_root / INTRO
    intro.write_text(intro.read_text().replace("1240 documents", "1250 documents"))
    rep = run(project_dir)
    stale = [f for f in rep["findings"] if f["check"] == "EXT-00"]
    assert len(stale) == 1 and "out of date" in stale[0]["message"] and INTRO in stale[0]["message"]
    assert rep["external"]["tools"]["numbers_audit"]["status"] == "stale"
    carried = [f for f in tx(rep) if f["check"] == "STAT-01"]
    assert len(carried) == 1 and carried[0]["state"] == "open", "carried, not fixed"
    assert carried[0]["fingerprint"] == [f for f in tx(run(project_dir)) if f["check"] == "STAT-01"][0]["fingerprint"]
    assert not rep["unexplained"]
    assert [f["level"] for f in stale] == ["major"] and rep["gate"]["passed"] is False
    from ah.ledger.db import Ledger
    led = Ledger(p)
    try:
        assert {r["cause"] for r in led.list() if r["check_id"] == "EXT-00"} == {"text-changed"}, "the edit is what made it stale"
    finally:
        led.close()


def test_rerunning_the_tool_fixes_what_is_gone_and_names_the_cause(project_dir):
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [stat_finding(p, key="a")])
    run(project_dir)
    write_result(p, "numbers_audit", [stat_finding(p, key="b")])       # same text, the tool now reports something else
    rep = run(project_dir)
    assert rep["ledger"]["new"] == 1 and rep["ledger"]["fixed"] == 1
    assert rep["new_causes"] == {"evidence-changed": 1}
    assert not rep["unexplained"]
    states = {f["key"]: f["state"] for f in rep["findings"] if f["check"] == "STAT-01"}
    assert states == {"b": "open"}


def test_an_unreadable_result_is_ext00_and_keeps_its_findings(project_dir):
    p = Project(str(project_dir))
    path = write_result(p, "numbers_audit", [stat_finding(p)])
    run(project_dir)
    path.write_text("{ not json")
    rep = run(project_dir)
    assert rep["external"]["tools"]["numbers_audit"]["status"] == "invalid"
    assert [f["key"] for f in rep["findings"] if f["check"] == "EXT-00"] == ["invalid:numbers_audit"]
    assert rep["ledger"]["fixed"] == 0


@pytest.mark.parametrize("mutate,why", [
    (lambda d: d.update(schema=2), "schema"),
    (lambda d: d.update(tool="figure_audit"), "tool"),
    (lambda d: d["findings"][0].update(check="STAT-99"), "not a check"),
    (lambda d: d["findings"][0].update(check="FIG-01"), "not a check of"),
    (lambda d: d["findings"][0].pop("key"), "needs check, key and message"),
    (lambda d: d.update(inputs=[]), "inputs"),
])
def test_a_malformed_result_is_rejected_whole(project_dir, mutate, why):
    p = Project(str(project_dir))
    path = write_result(p, "numbers_audit", [stat_finding(p)])
    data = json.loads(path.read_text())
    mutate(data)
    path.write_text(json.dumps(data))
    rep = run(project_dir)
    info = rep["external"]["tools"]["numbers_audit"]
    assert info["status"] == "invalid" and why in info["detail"]
    assert not [f for f in tx(rep) if f["check"] == "STAT-01"]


def test_a_new_prose_file_makes_the_result_stale(project_dir):
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [])
    (p.tex_root / "sections/extra.tex").write_text("\\section{Extra}\n\nSome new text.\n")
    rep = run(project_dir)
    info = rep["external"]["tools"]["numbers_audit"]
    assert info["status"] == "stale" and "is new" in info["detail"]


def test_a_required_tool_that_never_ran_is_ext00_and_an_optional_one_is_not(project_dir):
    p = Project(str(project_dir))
    assert not [f for f in run(project_dir)["findings"] if f["check"] == "EXT-00"]
    cfg = yaml.safe_load((project_dir / "ah.yaml").read_text())
    cfg["external"] = {"required": ["citation"]}
    (project_dir / "ah.yaml").write_text(yaml.safe_dump(cfg))
    rep = run(project_dir)
    assert [f["key"] for f in rep["findings"] if f["check"] == "EXT-00"] == ["missing:citation"]
    assert rep["gate"]["passed"] is False, "EXT-00 is major, so the gate cannot pass on an unrun required check"


def test_levels_in_ah_yaml_promote_or_silence_a_check(project_dir):
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [stat_finding(p), dict(stat_finding(p, key="x"), check="STAT-02")])
    cfg = yaml.safe_load((project_dir / "ah.yaml").read_text())
    cfg["levels"] = {**(cfg.get("levels") or {}), "STAT-01": "major", "STAT-02": "off"}
    (project_dir / "ah.yaml").write_text(yaml.safe_dump(cfg))
    rep = run(project_dir)
    assert [(f["check"], f["level"]) for f in tx(rep)] == [("STAT-01", "major")]


def test_plan_lists_prose_bib_and_only_included_raster_figures(project_dir):
    p = Project(str(project_dir))
    fig = p.tex_root / "figures"
    fig.mkdir()
    for name in ("used.png", "unused.png", "vector.pdf"):
        (fig / name).write_bytes(b"x")
    intro = p.tex_root / INTRO
    intro.write_text(intro.read_text() + "\n\\includegraphics[width=\\linewidth]{figures/used}\n\\includegraphics{figures/vector.pdf}\n% \\includegraphics{figures/unused}\n")
    got = plan(p)
    assert [e["path"] for e in got["figure_audit"]["files"]] == ["src/figures/used.png"]
    assert [e["file"] for e in got["citation"]["files"]] == ["refs/references.bib"]
    assert INTRO in [e["file"] for e in got["numbers_audit"]["files"]]


def test_cli_status_and_audit_flag(project_dir, capsys):
    p = Project(str(project_dir))
    assert main(["external", "status", "--project", str(project_dir)]) == 0     # nothing required, nothing run
    write_result(p, "numbers_audit", [stat_finding(p)])
    (p.tex_root / INTRO).write_text((p.tex_root / INTRO).read_text() + "\nMore.\n")
    assert main(["external", "status", "--project", str(project_dir)]) == 1     # stale
    out = capsys.readouterr().out
    assert "stale" in out
    assert main(["audit", "--project", str(project_dir), "--external", "--json"]) in (0, 1)
    rep = json.loads(capsys.readouterr().out)
    assert rep["external"]["tools"]["numbers_audit"]["status"] == "stale"


def _reporting_check(project: Project, slug: str = "consort-main", manuscript: str = f"src/{INTRO}") -> Path:
    """What the reporting_check tool leaves behind: a check manifest and an append-only verdict log."""
    d = project.root / ".dsh" / "reporting" / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "check.json").write_text(json.dumps({
        "slug": slug, "guideline": {"id": "consort", "name": "CONSORT 2010", "version": "2010"},
        "manuscript": {"kind": "file", "path": manuscript, "sha256": sha256_file(project.root / manuscript)}, "item_ids": ["1a", "2a"]}))
    (d / "verdicts.jsonl").write_text(json.dumps({"item_id": "1a", "verdict": "not_reported"}) + "\n")
    return d


def test_plan_lists_reporting_checks_whose_manuscript_is_in_the_project(project_dir):
    p = Project(str(project_dir))
    assert plan(p)["reporting_check"] == {"files": [], "checks": []}
    d = _reporting_check(p)
    (p.root / ".dsh" / "reporting" / "elsewhere").mkdir()
    (p.root / ".dsh" / "reporting" / "elsewhere" / "check.json").write_text(json.dumps({"manuscript": {"kind": "file", "path": "../outside.tex"}}))
    (p.root / ".dsh" / "reporting" / "paper" ).mkdir()
    (p.root / ".dsh" / "reporting" / "paper" / "check.json").write_text(json.dumps({"manuscript": {"kind": "papermemory", "paper": "p1"}}))
    got = plan(p)["reporting_check"]
    assert got["checks"] == [{"slug": "consort-main", "file": INTRO}], "outside the project, or not a file: not ours"
    assert [e["path"] for e in got["files"]] == [f".dsh/reporting/consort-main/check.json", ".dsh/reporting/consort-main/verdicts.jsonl", f"src/{INTRO}"]
    assert d.is_dir()


def test_reporting_findings_are_file_level_and_a_new_verdict_makes_the_result_stale(project_dir):
    p = Project(str(project_dir))
    _reporting_check(p)
    item = {"check": "RPT-01", "file": INTRO, "line": None, "key": "consort-main|1a|not_reported",
            "message": "CONSORT 2010 item 1a is recorded as not reported"}
    write_result(p, "reporting_check", [item])
    rep = run(project_dir)
    (f,) = [x for x in tx(rep) if x["check"] == "RPT-01"]
    assert f["level"] == "minor" and f["unit"] is None and f["file"] == INTRO
    assert rep["external"]["tools"]["reporting_check"]["status"] == "fresh"
    again = run(project_dir)
    assert again["ledger"]["new"] == 0 and again["report_hash"] == rep["report_hash"]
    with (p.root / ".dsh" / "reporting" / "consort-main" / "verdicts.jsonl").open("a") as fh:
        fh.write(json.dumps({"item_id": "2a", "verdict": "reported"}) + "\n")
    stale = run(project_dir)
    assert stale["external"]["tools"]["reporting_check"]["status"] == "stale"
    assert "verdicts.jsonl" in stale["external"]["tools"]["reporting_check"]["detail"]
    assert [x for x in stale["findings"] if x["check"] == "RPT-01"][0]["state"] == "open", "carried, not fixed"


def test_a_recorded_verdict_with_no_quote_left_is_a_major_that_can_gate(project_dir):
    p = Project(str(project_dir))
    _reporting_check(p)
    write_result(p, "reporting_check", [{"check": "RPT-02", "file": INTRO, "key": "consort-main|1a|stale", "message": "its quote is gone"}])
    rep = run(project_dir)
    assert [(x["check"], x["level"]) for x in tx(rep)] == [("RPT-02", "major")]
    assert rep["gate"]["passed"] is False
