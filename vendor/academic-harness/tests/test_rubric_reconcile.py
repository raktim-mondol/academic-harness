"""A rubric finding can stop being reported for five different reasons. Only one of them is a model saying "no".

The ledger records which, `ah done` says when the question (not a verdict) closed findings, and a finding carried over an uncertain answer says
it is the earlier assessment. Waived and decision-needed findings survive uncertainty unchanged.
"""
from __future__ import annotations

import json
import sqlite3

import pytest
import yaml

import re

from ah.audit import CARRIED_NOTE, audit
from ah.verifier.backends import Completion
from ah.cli import main
from ah.ledger.db import Ledger
from ah.project import Project
from test_done import admitted_project, tiers_tr
from test_ledger_model import N, Scripted
from test_rubric import SECTION, set_cfg

ONLY = ["RUB-GENERAL"]


class GeneralOnly(Scripted):
    """Answers the plan for the criterion under test (the 'universally' question) and 'no' for every other criterion the profile adds."""
    def complete(self, prompt: str) -> Completion:
        if "universally" not in re.search(r"<criterion>(.*?)</criterion>", prompt, re.S).group(1):
            self.calls += 1
            return Completion('{"answer": "no", "quote": "", "note": ""}', {"input": 3, "output": 1})
        return super().complete(prompt)


def run(root, plan):
    return audit(Project(str(root)), tiers_tr(), rubric_backend=GeneralOnly(plan), use_cache=False, rubric_criteria=None)


def all_no(override: dict | None = None):
    plan = {i: "no" for i in range(N)}
    plan.update(override or {})
    return plan


@pytest.fixture
def flagged(project_dir):
    """An admitted criterion with an open RUB-01 on 'Paragraph 1'."""
    admitted_project(project_dir)
    rep = run(project_dir, all_no({1: "yes"}))
    fps = [f["fingerprint"] for f in rep["findings"] if f["check"] == "RUB-01"]
    assert len(fps) == 1 and rep["done"]["status"] == "fail"
    return project_dir, fps[0]


def row(root, fp):
    led = Ledger(Project(str(root)))
    try:
        return dict(led.get(fp)[0])
    finally:
        led.close()


def test_a_valid_no_closes_the_finding_and_the_ledger_says_it_was_the_model(flagged):
    root, fp = flagged
    rep = run(root, all_no())
    assert row(root, fp)["state"] == "fixed" and row(root, fp)["fixed_reason"] == "verdict-no"
    assert rep["fixed_by"] == {"verdict-no": 1} and rep["done"]["status"] == "pass"


def test_an_edit_followed_by_a_valid_no_is_still_a_verdict(flagged):
    root, fp = flagged
    sec = root / SECTION
    sec.write_text(sec.read_text().replace("every benchmark we examined", "two of the benchmarks we examined"))
    main(["units", "--project", str(root), "sync"])
    run(root, all_no())
    assert row(root, fp)["fixed_reason"] == "verdict-no"


def test_a_deleted_paragraph_closes_its_finding_as_unit_gone(flagged):
    root, fp = flagged
    sec = root / SECTION
    blocks = sec.read_text().split("\n\n")
    kept = [b for b in blocks if "Paragraph 01 " not in b]
    assert len(kept) == len(blocks) - 1
    sec.write_text("\n\n".join(kept))
    main(["units", "--project", str(root), "sync"])
    run(root, all_no())
    assert row(root, fp)["state"] == "fixed" and row(root, fp)["fixed_reason"] == "unit-gone"


def test_a_criterion_switched_off_closes_findings_and_done_says_no_model_did_it(flagged):
    root, fp = flagged
    set_cfg(root, criteria={"off": ["RUB-GENERAL"]})
    rep = run(root, all_no())
    assert row(root, fp)["state"] == "fixed" and row(root, fp)["fixed_reason"] == "criterion-off"
    assert rep["fixed_by"] == {"criterion-off": 1}
    rubric = next(c for c in rep["done"]["components"] if c["id"] == "rubric")
    assert "switched off or no longer covers the paragraph (no model verdict)" in rubric["detail"], rubric["detail"]


def test_a_scope_change_that_leaves_the_paragraph_out_is_not_a_verdict_either(flagged):
    root, fp = flagged
    path = root / "rubric" / "mine.yaml"
    data = yaml.safe_load(path.read_text())
    data["criteria"][0]["scope"] = {"files": ["sections/01_*/*.tex"]}
    path.write_text(yaml.safe_dump(data))
    rep = run(root, all_no())
    assert row(root, fp)["fixed_reason"] == "out-of-scope" and rep["fixed_by"] == {"out-of-scope": 1}
    assert "no model verdict" in next(c for c in rep["done"]["components"] if c["id"] == "rubric")["detail"]


def test_the_reason_is_in_the_text_report_and_in_finding_show(flagged, capsys):
    root, fp = flagged
    set_cfg(root, criteria={"off": ["RUB-GENERAL"]})
    run(root, all_no())
    capsys.readouterr()
    assert main(["finding", "show", fp[:8], "--project", str(root)]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown["state"] == "fixed" and shown["fixed_reason"] == "criterion-off"


def test_a_narrowed_run_does_not_invent_reasons_for_pairs_it_skipped(flagged):
    root, fp = flagged
    rep = audit(Project(str(root)), tiers_tr(), rubric_backend=GeneralOnly(all_no()), use_cache=False, rubric_criteria=["RUB-GENERAL"])
    assert row(root, fp)["fixed_reason"] in ("check-passes", "verdict-no"), "no claim about scope or criteria from a run that was told which criteria to ask"
    assert "out-of-scope" not in rep["fixed_by"] and "criterion-off" not in rep["fixed_by"]


# ---------------------------------------------------------------- uncertainty meets a person's decision
def test_a_waived_finding_stays_waived_when_the_pair_becomes_unclear(flagged):
    root, fp = flagged
    assert main(["finding", "waive", fp[:8], "--by", "author", "--reason", "accepted", "--yes", "--project", str(root)]) == 0
    rep = run(root, all_no({1: "unclear"}))
    assert row(root, fp)["state"] == "waived" and rep["ledger"]["waived"] == 1 and rep["ledger"]["fixed"] == 0
    assert rep["done"]["status"] == "incomplete", "the waiver holds, but the pair is unresolved, so the document cannot be called done"


def test_a_finding_handed_to_the_author_stays_so_when_the_pair_becomes_unclear(flagged):
    root, fp = flagged
    assert main(["finding", "decide", fp[:8], "--reason", "is this right?", "--project", str(root)]) == 0
    rep = run(root, all_no({1: "unclear"}))
    assert row(root, fp)["state"] == "decision-needed" and rep["ledger"]["fixed"] == 0
    assert rep["done"]["status"] == "fail"


# ---------------------------------------------------------------- a carried finding says it is carried
def test_a_finding_carried_over_an_edit_says_it_is_the_earlier_assessment(flagged):
    root, fp = flagged
    sec = root / SECTION
    sec.write_text(sec.read_text().replace("every benchmark we examined", "two of the benchmarks we examined"))
    main(["units", "--project", str(root), "sync"])
    rep = run(root, all_no({1: "unclear"}))
    carried = [f for f in rep["findings"] if f["check"] == "RUB-01"]
    assert len(carried) == 1 and carried[0]["message"].endswith(CARRIED_NOTE) and carried[0]["message"].count(CARRIED_NOTE) == 1
    again = run(root, all_no({1: "unclear"}))
    assert [f["message"] for f in again["findings"] if f["check"] == "RUB-01"][0].count(CARRIED_NOTE) == 1, "the note is not stacked"
    fresh = run(root, all_no({1: "yes"}))
    assert CARRIED_NOTE not in [f["message"] for f in fresh["findings"] if f["check"] == "RUB-01"][0], "a fresh verdict replaces the carried text"
    run(root, all_no())
    assert row(root, fp)["state"] == "fixed"


# ---------------------------------------------------------------- an old ledger
def test_a_ledger_from_before_closures_were_explained_is_upgraded(project_dir):
    admitted_project(project_dir)
    run(project_dir, all_no({1: "yes"}))
    db = sqlite3.connect(project_dir / ".ah" / "ledger.sqlite")
    db.execute("ALTER TABLE findings DROP COLUMN fixed_reason")
    db.commit()
    assert "fixed_reason" not in {r[1] for r in db.execute("PRAGMA table_info(findings)")}
    db.close()
    led = Ledger(Project(str(project_dir)))
    assert "fixed_reason" in {r[1] for r in led.db.execute("PRAGMA table_info(findings)")}
    led.close()
    rep = run(project_dir, all_no())
    assert rep["fixed_by"] == {"verdict-no": 1}
