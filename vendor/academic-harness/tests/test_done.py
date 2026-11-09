"""One answer: pass, fail or incomplete (phase 6).

"No blockers" must not be readable off a run that never looked at the external tools, never asked the rubric anything,
or relied on a month-old registry answer. These tests pin each component, the precedence between them, and that the
stop gate sees the external and admitted-rubric tiers.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import yaml

from ah.audit import audit
from ah.checks.base import DEFAULT_TIERS
from ah.cli import main
from ah.done import done_status, lookup_snapshot, render
from ah.project import Project
from test_external import INTRO, stat_finding, write_result
from test_rubric import admit, configure_model, fake, make_labels, replace_section, run_audit, set_cfg

NOW = datetime(2026, 11, 9, tzinfo=timezone.utc)


def open_gate(root: Path) -> None:
    """Nothing in the fixture's planted findings blocks, so what the test is about is the only thing that can."""
    set_cfg(root, gate={"blocking_levels": []})


def write_lookups(root: Path, ages_days: list[float]) -> None:
    d = root / ".ah" / "cache"
    d.mkdir(parents=True, exist_ok=True)
    entries = {f"api.crossref.org/works/10.1/{i}": {"status": 200, "fetched_at": (NOW - timedelta(days=a)).isoformat(), "data": {}}
               for i, a in enumerate(ages_days)}
    (d / "lookups.json").write_text(json.dumps({"version": 1, "entries": entries}))


def comp(done: dict, cid: str) -> dict:
    return next(c for c in done["components"] if c["id"] == cid)


def status(root: Path, rep: dict | None = None, **kw) -> dict:
    p = Project(str(root))
    return done_status(p, rep or audit(p, use_ledger=False, **kw), now=NOW)


# ---------------------------------------------------------------- the findings component
def test_a_blocker_fails_the_document_and_names_the_check(project_dir):
    d = status(project_dir)
    assert d["status"] == "fail" and d["failing"] == ["findings"]
    assert "TEX-02" in comp(d, "findings")["detail"]


def test_with_nothing_blocking_and_nothing_required_the_answer_is_pass(project_dir):
    open_gate(project_dir)
    d = status(project_dir)
    assert d["status"] == "pass" and d["failing"] == [] and d["incomplete_because"] == []


def test_the_report_carries_it_and_the_gate_is_unchanged(project_dir):
    p = Project(str(project_dir))
    rep = audit(p, use_ledger=False)
    assert rep["done"]["status"] == "fail" and rep["gate"]["passed"] is False and set(rep["gate"]) == {"passed", "blocking", "levels"}


# ---------------------------------------------------------------- lookups
def test_a_registry_answer_older_than_the_limit_fails_and_a_fresh_one_does_not(project_dir):
    open_gate(project_dir)
    write_lookups(project_dir, [2, 31])
    d = status(project_dir)
    assert d["status"] == "fail" and d["failing"] == ["lookups"] and "31" in comp(d, "lookups")["detail"]
    write_lookups(project_dir, [2, 29])
    assert status(project_dir)["status"] == "pass"


def test_the_age_limit_is_configurable_and_zero_never_expires(project_dir):
    open_gate(project_dir)
    write_lookups(project_dir, [200])
    set_cfg(project_dir, gate={"blocking_levels": []}, done={"lookups_max_age_days": 365})
    assert status(project_dir)["status"] == "pass"
    set_cfg(project_dir, gate={"blocking_levels": []}, done={"lookups_max_age_days": 0})
    assert status(project_dir)["status"] == "pass"
    set_cfg(project_dir, gate={"blocking_levels": []}, done={"lookups_max_age_days": 30})
    assert status(project_dir)["status"] == "fail"


def test_no_snapshot_is_not_checked_and_incomplete_only_when_required(project_dir):
    open_gate(project_dir)
    d = status(project_dir)
    assert comp(d, "lookups")["status"] == "not-checked" and d["status"] == "pass"
    set_cfg(project_dir, gate={"blocking_levels": []}, done={"require": ["lookups"]})
    d = status(project_dir)
    assert d["status"] == "incomplete" and d["incomplete_because"] == ["lookups"]


def test_an_unreadable_snapshot_fails_instead_of_passing_silently(project_dir):
    open_gate(project_dir)
    (project_dir / ".ah" / "cache").mkdir(parents=True)
    (project_dir / ".ah" / "cache" / "lookups.json").write_text("{not json")
    assert status(project_dir)["failing"] == ["lookups"]
    assert lookup_snapshot(Project(str(project_dir)), NOW)["error"].startswith("unreadable")


# ---------------------------------------------------------------- external
def test_external_results_that_exist_but_were_not_read_make_the_run_incomplete(project_dir):
    open_gate(project_dir)
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [])
    d = status(project_dir)                                   # no external= : TX not read
    assert d["status"] == "incomplete" and d["incomplete_because"] == ["external"]


def test_current_external_results_pass_and_stale_ones_fail(project_dir):
    open_gate(project_dir)
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [])
    assert status(project_dir, external="")["status"] == "pass"
    intro = project_dir / "src" / INTRO
    intro.write_text(intro.read_text() + "\n\nA new paragraph with enough words in it to count as a unit of the document.\n")
    d = status(project_dir, external="")
    assert d["status"] == "fail" and d["failing"] == ["external"] and "EXT-00" in comp(d, "external")["detail"]


def test_a_required_tool_with_no_result_fails_not_passes(project_dir):
    open_gate(project_dir)
    set_cfg(project_dir, gate={"blocking_levels": []}, external={"required": ["numbers_audit"]})
    d = status(project_dir, external="")
    assert d["failing"] == ["external"]
    assert status(project_dir)["incomplete_because"] == ["external"], "required but not read is incomplete"


def test_ext00_is_counted_once_under_external_not_also_under_findings(project_dir):
    set_cfg(project_dir, gate={"blocking_levels": ["major"]}, external={"required": ["numbers_audit"]})
    d = status(project_dir, external="")
    assert "EXT-00" not in comp(d, "findings")["detail"]


# ---------------------------------------------------------------- rubric
def admitted_project(root: Path, level: str = "minor") -> None:
    replace_section(root, {1, 3, 5, 7, 9, 11}, n=12)
    make_labels(root, {1, 3, 5, 7, 9, 11}, 12)
    (root / "rubric").mkdir(exist_ok=True)
    (root / "rubric" / "mine.yaml").write_text(yaml.safe_dump({"criteria": [
        {"id": "RUB-GENERAL", "version": 1, "level": level, "question": "Does the paragraph claim a result holds universally when it covers only a few cases?"}]}))
    assert admit(root, fake(model="m1"), "--yes") == 0
    open_gate(root)


def tiers_tr():
    return DEFAULT_TIERS + ("TR",)


def test_an_open_finding_from_an_admitted_criterion_fails_even_below_the_gate_level(project_dir):
    admitted_project(project_dir, level="minor")                 # minor does not gate: blocking_levels is empty anyway
    p = Project(str(project_dir))
    rep = audit(p, tiers_tr(), use_ledger=False, rubric_backend=fake(model="m1"))
    d = done_status(p, rep, now=NOW)
    assert rep["gate"]["passed"] is True, "the old gate cannot see it"
    assert d["status"] == "fail" and d["failing"] == ["rubric"] and "RUB-GENERAL" in comp(d, "rubric")["detail"]


def test_an_unadmitted_criterion_does_not_fail_the_document(project_dir):
    replace_section(project_dir, {1, 3}, n=6)
    open_gate(project_dir)
    configure_model(project_dir, "m1")
    set_cfg(project_dir, gate={"blocking_levels": []}, verifier={"backend": "http", "url": "http://127.0.0.1:9/v1", "model": "m1"})
    p = Project(str(project_dir))
    rep = audit(p, tiers_tr(), use_ledger=False, rubric_backend=fake(model="m1"))
    assert [f for f in rep["findings"] if f["check"] == "RUB-01"], "the criterion found something"
    assert done_status(p, rep, now=NOW)["status"] == "pass"


def test_admitted_criteria_that_were_not_read_make_it_incomplete(project_dir):
    admitted_project(project_dir)
    d = status(project_dir)                                      # TR not in tiers
    assert d["status"] == "incomplete" and d["incomplete_because"] == ["rubric"]


def test_a_paragraph_nobody_judged_leaves_it_incomplete_not_pass(project_dir):
    admitted_project(project_dir)
    p = Project(str(project_dir))
    (project_dir / ".ah" / "verdicts.sqlite").unlink()
    rep = audit(p, tiers_tr(), use_ledger=False)                 # cached verdicts only, and there are none
    d = done_status(p, rep, now=NOW)
    assert d["status"] == "incomplete" and "no verdict" in comp(d, "rubric")["detail"]


def test_a_clean_admitted_rubric_passes(project_dir):
    admitted_project(project_dir)
    replace_section(project_dir, set(), n=12)
    p = Project(str(project_dir))
    rep = audit(p, tiers_tr(), use_ledger=False, rubric_backend=fake(model="m1"))
    assert done_status(p, rep, now=NOW)["status"] == "pass"


# ---------------------------------------------------------------- unexplained and precedence
def synthetic(**over) -> dict:
    rep = {"tiers": list(DEFAULT_TIERS), "findings": [], "gate": {"passed": True, "blocking": 0, "levels": ["blocker", "major"]},
           "run": 1, "unexplained": []}
    rep.update(over)
    return rep


def test_a_finding_with_no_cause_fails(project_dir):
    p = Project(str(project_dir))
    open_gate(project_dir)
    d = done_status(p, synthetic(unexplained=["abcdef1234567890"]), now=NOW)
    assert d["status"] == "fail" and d["failing"] == ["unexplained"]


def test_without_a_ledger_unexplained_is_not_applicable(project_dir):
    rep = synthetic()
    rep.pop("run")
    assert comp(done_status(Project(str(project_dir)), rep, now=NOW), "unexplained")["detail"].startswith("not applicable")


def test_fail_beats_incomplete_beats_pass(project_dir):
    open_gate(project_dir)
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [])                         # unread external: incomplete
    assert status(project_dir)["status"] == "incomplete"
    write_lookups(project_dir, [90])                             # and a stale snapshot: fail wins
    d = status(project_dir)
    assert d["status"] == "fail" and d["failing"] == ["lookups"] and d["incomplete_because"] == ["external"]


# ---------------------------------------------------------------- surfaces
def test_the_audit_text_ends_with_the_answer_and_each_component(project_dir, capsys):
    capsys.readouterr()
    main(["audit", "--project", str(project_dir)])
    out = capsys.readouterr().out
    assert "done: FAIL" in out and "FAIL findings" in out and "lookups" in out
    assert render(audit(Project(str(project_dir)), use_ledger=False)["done"])[0] == "done: FAIL"


def test_a_view_narrowed_to_files_does_not_claim_the_document_is_done(project_dir, capsys):
    capsys.readouterr()
    main(["check", "--project", str(project_dir), "--files", "sections/03_method/index.tex", "--json"])
    assert "done" not in json.loads(capsys.readouterr().out)


def test_brief_check_carries_the_status(project_dir, capsys):
    capsys.readouterr()
    main(["check", "--project", str(project_dir), "--brief", "--json"])
    assert json.loads(capsys.readouterr().out)["done"]["status"] == "fail"


def test_ah_done_exit_codes_are_pass_fail_incomplete(project_dir, capsys):
    assert main(["done", "--project", str(project_dir)]) == 1
    open_gate(project_dir)
    assert main(["done", "--project", str(project_dir)]) == 0
    write_result(Project(str(project_dir)), "numbers_audit", [])
    assert main(["done", "--project", str(project_dir)]) == 0, "ah done reads external results by itself, so they are current"
    set_cfg(project_dir, gate={"blocking_levels": []}, done={"require": ["lookups"]})
    capsys.readouterr()
    assert main(["done", "--project", str(project_dir), "--json"]) == 3
    assert json.loads(capsys.readouterr().out)["done"]["status"] == "incomplete"


def test_ah_done_reads_the_rubric_and_external_without_being_asked(project_dir, capsys):
    admitted_project(project_dir)
    capsys.readouterr()
    code = main(["done", "--project", str(project_dir), "--json"])
    out = json.loads(capsys.readouterr().out)
    assert "TR" in out["tiers"] and code in (1, 3), "admitted criteria were read, and nothing was judged, so it cannot pass"
    assert comp(out["done"], "rubric")["status"] in ("not-checked", "fail")


def test_the_state_card_shows_the_answer(project_dir):
    from ah.state import build_state
    assert "Done: FAIL" in build_state(Project(str(project_dir)))
    open_gate(project_dir)
    write_result(Project(str(project_dir)), "numbers_audit", [])
    assert "Done: PASS" in build_state(Project(str(project_dir))), "state reads current external results just like ah done"


# ---------------------------------------------------------------- the stop gate reads TX and admitted TR
def test_the_hook_sees_external_findings_but_not_ext00(project_dir):
    from ah.hooks import current_findings
    p = Project(str(project_dir))
    write_result(p, "numbers_audit", [stat_finding(p)])
    assert "STAT-01" in {f["check"] for f in current_findings(p)}
    intro = project_dir / "src" / INTRO
    intro.write_text(intro.read_text() + "\n\nAnother paragraph, long enough to count as a unit of this small test document.\n")
    got = {f["check"] for f in current_findings(Project(str(project_dir)))}
    assert "EXT-00" not in got, "an edit always makes the stored result stale; `ah done` reports that"


def test_the_hook_sees_an_admitted_criterion_from_cached_verdicts(project_dir):
    from ah.hooks import current_findings
    admitted_project(project_dir, level="major")
    run_audit(project_dir, fake(model="m1"))                      # fills the verdict cache
    got = [f for f in current_findings(Project(str(project_dir))) if f["check"] == "RUB-01"]
    assert got and {f["level"] for f in got} == {"major"}


def test_the_hook_judges_touched_files_only_when_asked_to(project_dir, monkeypatch):
    from ah import hooks
    admitted_project(project_dir, level="major")
    (project_dir / ".ah" / "verdicts.sqlite").unlink()           # admission judged the labelled paragraphs; start with no verdicts
    p = Project(str(project_dir))
    monkeypatch.setattr("ah.verifier.backends.get_backend", lambda cfg: fake(model="m1"))
    none = [f for f in hooks.current_findings(p, ["sections/04_experiments/index.tex"]) if f["check"] == "RUB-01"]
    assert none == [], "judge_touched is off: nothing was asked, nothing was cached"
    set_cfg(project_dir, gate={"blocking_levels": [], "judge_touched": True})
    got = [f for f in hooks.current_findings(Project(str(project_dir)), ["sections/04_experiments/index.tex"]) if f["check"] == "RUB-01"]
    assert len(got) == 6 and {f["level"] for f in got} == {"major"}
    other = [f for f in hooks.current_findings(Project(str(project_dir)), ["sections/03_method/index.tex"]) if f["check"] == "RUB-01"]
    assert other == [], "only the touched files are judged (the cache holds none for the rest)"


def test_post_edit_notes_leave_out_unadmitted_rubric_hints():
    import inspect
    from ah import hooks
    assert '"RUB-"' in inspect.getsource(hooks.handle)


def test_a_pass_says_what_the_author_waived(project_dir):
    """Found live: `ah done` returned PASS after two blockers were waived and said nothing about them."""
    from ah.audit import audit
    from ah.cli import main
    from ah.done import done_status
    from ah.project import Project
    p = Project(str(project_dir))
    rep = audit(p, use_ledger=True)
    blockers = [f for f in rep["findings"] if f["level"] in rep["gate"]["levels"]]
    assert blockers
    for f in blockers:
        assert main(["finding", "waive", f["fingerprint"][:8], "--by", "author", "--reason", "known", "--yes", "--project", str(project_dir)]) == 0
    status = done_status(p, audit(p, use_ledger=True))
    findings = next(c for c in status["components"] if c["id"] == "findings")
    assert status["status"] == "pass" and findings["status"] == "ok"
    assert f"{len(blockers)} waived by the author" in findings["detail"]


def _waive_every_blocker(project_dir):
    from ah.audit import audit
    from ah.cli import main
    p = Project(str(project_dir))
    rep = audit(p, use_ledger=True)
    blockers = [f for f in rep["findings"] if f["level"] in rep["gate"]["levels"]]
    for f in blockers:
        assert main(["finding", "waive", f["fingerprint"][:8], "--by", "author", "--reason", "known", "--yes", "--project", str(project_dir)]) == 0
    return p, blockers


def test_the_state_card_and_the_stateless_audit_see_what_the_author_waived(project_dir):
    """Found live: after two waivers `ah done` said PASS while the status card shown to the model still said Gate FAIL, because the
    card audits without the ledger and every finding came back `open`."""
    from ah.audit import audit
    from ah.state import build_state
    p, blockers = _waive_every_blocker(project_dir)
    card = build_state(p)
    assert "Gate now: PASS" in card and "Done: FAIL" not in card
    rep = audit(p, use_ledger=False)
    assert rep["gate"]["passed"] and {f["state"] for f in rep["findings"] if f["fingerprint"] in {b["fingerprint"] for b in blockers}} == {"waived"}


def test_a_waiver_tied_to_a_paragraph_lapses_in_the_stateless_audit_when_the_paragraph_changes(project_dir):
    from ah.audit import audit
    p, blockers = _waive_every_blocker(project_dir)
    ref = next(b for b in blockers if b["check"] == "TEX-02")
    before = {f["fingerprint"]: f["state"] for f in audit(p, use_ledger=False)["findings"]}
    assert before[ref["fingerprint"]] == "waived"
    intro = project_dir / "src/sections/01_introduction/index.tex"
    assert "Our method proves that" in intro.read_text()          # the paragraph holding the waived \ref
    intro.write_text(intro.read_text().replace("Our method proves that", "Our method shows that"))
    after = {f["fingerprint"]: f["state"] for f in audit(p, use_ledger=False)["findings"]}
    assert after[ref["fingerprint"]] == "open", "editing the paragraph the waiver was written for brings the finding back"
