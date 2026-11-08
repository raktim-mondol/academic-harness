"""Phase 0: the same text must give the same findings, every time (DET-01 and the N-run stability report)."""
from __future__ import annotations

import json

from ah.audit import audit, det_check, run_checks
from ah.cli import main
from ah.context import build_context
from ah.stability import stability

PLANTED = {"TEX-02", "BIB-05", "STY-01", "NUM-001"}



def checks_fired(project):
    return {f.check for f in run_checks(build_context(project))}


def test_fixture_plants_the_expected_findings(project):
    fired = checks_fired(project)
    missing = PLANTED - fired
    assert not missing, f"fixture no longer triggers {missing}; fired {sorted(fired)}"


def test_det01_identical(project):
    assert det_check(project)["identical"]


def test_stability_is_one_on_unchanged_text(project):
    st = stability(project, runs=5)
    assert st["verdict"] == "stable"
    assert st["identical"] and len(st["distinct_report_hashes"]) == 1
    assert st["unstable"] == []
    assert all(t["jaccard_min"] == 1.0 for t in st["per_tier"].values())


def test_fingerprints_ignore_line_moves(project, project_dir):
    before = {f.fingerprint() for f in run_checks(build_context(project))}
    intro = project_dir / "src/sections/01_introduction/index.tex"
    text = intro.read_text()
    intro.write_text(text.replace("\\label{sec:introduction}\n", "\\label{sec:introduction}\n\n\n\n"))
    after = {f.fingerprint() for f in run_checks(build_context(project))}
    assert before == after


def test_second_audit_on_unchanged_text_adds_nothing(project):
    first = audit(project)
    assert first["ledger"]["new"] > 0
    second = audit(project)
    assert second["ledger"]["new"] == 0
    assert second["ledger"]["fixed"] == 0
    assert second["unexplained"] == []
    assert second["report_hash"] == first["report_hash"]


def test_an_edit_explains_its_new_finding(project, project_dir):
    audit(project)
    method = project_dir / "src/sections/03_method/index.tex"
    method.write_text(method.read_text().replace("deliberately plain", "obviously plain"))
    rep = audit(project)
    assert rep["ledger"]["new"] == 1
    assert rep["unexplained"] == []
    assert set(rep["new_causes"]) <= {"text-changed", "unit-new"}


def test_stability_cli(project_dir, capsys):
    code = main(["stability", "--project", str(project_dir), "--runs", "3", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert code == 0, out
    assert out["verdict"] == "stable" and out["ledger_unexplained"] == []


def test_audit_cli_stability_flag(project_dir, capsys):
    code = main(["audit", "--project", str(project_dir), "--stability", "3", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert out["stability"]["verdict"] == "stable"
    assert code in (0, 1)  # 1 = the planted findings keep the gate closed; never 2


def test_unanchored_paragraphs_rekey_on_edit_and_the_report_says_so(raw_project_dir):
    """Without anchors a unit is keyed by its text hash, so any edit re-keys every finding in it (fixed + new churn)."""
    from ah.project import Project
    p = Project(str(raw_project_dir))
    st = stability(p, runs=2)
    assert st["unanchored_units"] > 0 and st["warnings"]
    audit(p)
    method = raw_project_dir / "src/sections/03_method/index.tex"
    method.write_text(method.read_text().replace("deliberately plain", "obviously plain"))
    rep = audit(p)
    assert rep["ledger"]["fixed"] >= 1 and rep["ledger"]["new"] >= 2  # UNIT-01 re-keyed + the new STY-01


def test_anchored_project_has_no_unanchored_warning(project):
    st = stability(project, runs=2)
    assert st["unanchored_units"] == 0 and st["warnings"] == []
