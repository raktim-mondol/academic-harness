"""Tier TR: the frozen rubric.

A model is faked with a function of the prompt, so every property is tested directly: a verdict needs a verified
quote, an unchanged paragraph is never asked twice, a pair that could not be judged is carried and not closed,
and a criterion cannot gate until the author has measured it against hand labels.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

from ah.audit import audit, report_hash, run_checks
from ah.checks.base import CATALOGUE, DEFAULT_TIERS
from ah.checks.rubric import cache_key, parse_reply, quote_in, run_rubric
from ah.cli import main
from ah.context import build_context
from ah.ledger.db import Ledger
from ah.project import Project
from ah.rubric import (Criterion, admission_failures, agreement, cohens_kappa, criteria_digest, in_scope, is_admitted,
                       load_admissions, load_criteria)
from ah.verifier.backends import FakeBackend

TIERS_TR = DEFAULT_TIERS + ("TR",)
SECTION = "src/sections/04_experiments/index.tex"
GENERAL_QUESTION = "universally"            # a word from RUB-GENERAL's question, how the fake model tells criteria apart
CLAIM = "claims the method wins on every benchmark we examined across all of the available corpora in the study"


def paragraph(i: int, defect: bool) -> str:
    if defect:
        return f"Paragraph {i:02d} {CLAIM}, and this is stated without any caveat about where it was tried."
    return f"Paragraph {i:02d} reports a careful measurement on {100 + i} documents collected from the public corpus in the second round."


def replace_section(root: Path, defects: set[int], n: int = 6) -> None:
    body = "\\section{Experiments}\n\n" + "\n\n".join(paragraph(i, i in defects) for i in range(n)) + "\n"
    (root / SECTION).write_text(body)
    assert main(["units", "--project", str(root), "sync"]) == 0


def set_cfg(root: Path, **updates) -> None:
    cfg = yaml.safe_load((root / "ah.yaml").read_text())
    cfg.update(updates)
    (root / "ah.yaml").write_text(yaml.safe_dump(cfg))


def model_fn(prompt: str) -> str:
    """A deterministic reviewer: RUB-GENERAL fires on 'every benchmark'; every other criterion says no."""
    question = re.search(r"<criterion>(.*?)</criterion>", prompt, re.S).group(1)
    text = re.search(r"<paragraph>\n(.*?)\n</paragraph>", prompt, re.S).group(1)
    if GENERAL_QUESTION in question and "every benchmark we examined" in text:
        return json.dumps({"answer": "yes", "quote": "every benchmark we examined", "note": "universal claim"})
    return json.dumps({"answer": "no", "quote": "", "note": ""})


def fake(fn=model_fn, model: str = "m1") -> FakeBackend:
    return FakeBackend(fn, model)


def configure_model(root: Path, model: str = "m1") -> None:
    set_cfg(root, verifier={"backend": "http", "url": "http://127.0.0.1:9/v1", "model": model})


def only_general(rep_or_findings):
    fs = rep_or_findings["findings"] if isinstance(rep_or_findings, dict) else rep_or_findings
    return [f for f in fs if (f["check"] if isinstance(f, dict) else f.check) == "RUB-01"]


def run_audit(root: Path, backend=None, **kw) -> dict:
    return audit(Project(str(root)), TIERS_TR, rubric_backend=backend, **kw)


def test_catalogue_and_defaults():
    assert CATALOGUE["RUB-01"][0] == "TR" and CATALOGUE["RUB-01"][1] == "info"
    assert "TR" not in DEFAULT_TIERS


def test_the_profile_ships_criteria_and_a_project_can_reword_or_add(project_dir):
    p = Project(str(project_dir))
    crits, problems = load_criteria(p)
    assert not problems and {c.id for c in crits} >= {"RUB-CAUSAL", "RUB-GENERAL", "RUB-SUPERLATIVE", "RUB-METHOD-VAGUE", "RUB-RESULTS-INTERPRET"}
    (project_dir / "rubric").mkdir()
    (project_dir / "rubric" / "mine.yaml").write_text(yaml.safe_dump({"criteria": [
        {"id": "RUB-CAUSAL", "version": 2, "level": "major", "question": "Does the paragraph claim that a drug cured a disease without a control group?"},
        {"id": "RUB-HYPE", "question": "Does the paragraph call a result remarkable or groundbreaking instead of reporting it?"}]}))
    crits, problems = load_criteria(Project(str(project_dir)))
    by = {c.id: c for c in crits}
    assert not problems and by["RUB-CAUSAL"].version == 2 and by["RUB-CAUSAL"].origin == "rubric/mine.yaml", "the project's definition replaces the bundled one"
    assert by["RUB-HYPE"].level == "minor" and by["RUB-GENERAL"].origin == "profile set core"
    set_cfg(project_dir, criteria={"off": ["RUB-SUPERLATIVE"]})
    assert "RUB-SUPERLATIVE" not in {c.id for c in load_criteria(Project(str(project_dir)))[0]}


def test_malformed_criteria_files_are_a_finding_not_a_crash(project_dir):
    (project_dir / "rubric").mkdir()
    (project_dir / "rubric" / "bad.yaml").write_text(yaml.safe_dump({"criteria": [
        {"id": "no-prefix", "question": "Is this a question that is long enough to pass?"},
        {"id": "RUB-SHORT", "question": "Too short"},
        {"id": "RUB-DUP", "question": "Does the paragraph contain a first duplicate definition here?"},
        {"id": "RUB-DUP", "question": "Does the paragraph contain a second duplicate definition here?"}]}))
    (project_dir / "rubric" / "worse.yaml").write_text("criteria: [ not closed")
    ctx = build_context(Project(str(project_dir)))
    findings, stats = run_rubric(ctx, None)
    msgs = " | ".join(f.message for f in findings if f.check == "RUB-02")
    assert len([f for f in findings if f.check == "RUB-02"]) == 4
    assert "RUB-SHORT" in msgs and "defined twice" in msgs and "cannot be read" in msgs and "no-prefix" in msgs
    assert all(f.level == "major" for f in findings if f.check == "RUB-02")


def test_reply_parsing_and_quote_checking():
    assert parse_reply('```json\n{"answer": "YES", "quote": "x", "note": "n"}\n```') == {"answer": "yes", "quote": "x", "note": "n"}
    assert parse_reply('{"answer": "maybe"}') is None and parse_reply("no json here") is None
    assert quote_in("every  benchmark", "Wins on Every\nbenchmark we tried")
    assert quote_in("wins on every ... we tried", "Wins on Every benchmark we tried")
    assert not quote_in("every benchmark", "wins on each benchmark") and not quote_in("wins", "wins on each benchmark"), "a short span proves nothing"
    assert not quote_in("", "anything at all here")


def test_a_failure_needs_a_verified_quote(project_dir):
    replace_section(project_dir, {2})
    ctx = build_context(Project(str(project_dir)))
    liar = fake(lambda prompt: json.dumps({"answer": "yes", "quote": "words that are not in this paragraph", "note": "x"}))
    findings, stats = run_rubric(ctx, liar)
    assert not [f for f in findings if f.check == "RUB-01"], "a yes with no real quote is not a finding"
    assert stats["unverifiable"] == stats["judged"] > 0 and stats["yes"] == 0
    assert liar.calls == 2 * stats["pairs"], "one retry, then it gives up"

    replace_section(project_dir, {0})                       # the first paragraph, which is the one limit=1 will judge
    ctx = build_context(Project(str(project_dir)))
    seq = iter([json.dumps({"answer": "yes", "quote": "invented", "note": ""}), json.dumps({"answer": "yes", "quote": "every benchmark we examined", "note": "ok"})])
    corrected = fake(lambda prompt: next(seq))
    findings, stats = run_rubric(ctx, corrected, only_files=["sections/04_experiments/index.tex"], only_criteria=["RUB-GENERAL"], limit=1)
    assert len([f for f in findings if f.check == "RUB-01"]) == 1 and corrected.calls == 2, "the corrected quote is accepted"


def test_an_unadmitted_criterion_reports_at_info_and_cannot_gate(project_dir):
    replace_section(project_dir, {1, 4})
    configure_model(project_dir)
    rep = run_audit(project_dir, fake())
    found = only_general(rep)
    assert len(found) == 2 and {f["level"] for f in found} == {"info"}
    assert all("every benchmark we examined" in f["message"] and f["unit"] and f["file"] == "sections/04_experiments/index.tex" for f in found)
    assert rep["rubric_run"]["yes"] == 2 and rep["rubric_run"]["admitted"] == []
    assert not any(f["level"] in ("blocker", "major") for f in found)
    assert rep["rubric"] == "1.4.0", "the engine's rubric version is still there, not the run's stats"


def test_an_unchanged_paragraph_is_never_asked_twice(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir)
    b1 = fake()
    first = run_audit(project_dir, b1)
    assert b1.calls == first["rubric_run"]["pairs"] > 0
    b2 = fake()
    second = run_audit(project_dir, b2)
    assert b2.calls == 0 and second["rubric_run"]["cached"] == second["rubric_run"]["judged"]
    assert second["report_hash"] == first["report_hash"] and second["ledger"]["new"] == 0 and not second["unexplained"]
    b3 = fake()
    run_audit(project_dir, b3, use_cache=False)
    assert b3.calls == first["rubric_run"]["pairs"], "--no-cache asks again"


def test_with_no_backend_the_cache_is_replayed_and_nothing_is_asked(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir)
    first = run_audit(project_dir, fake())
    replay = run_audit(project_dir, None)           # no model: the configured model name finds the cached verdicts
    assert replay["report_hash"] == first["report_hash"]
    assert replay["rubric_run"]["calls"] == 0 and replay["rubric_run"]["unjudged_count"] == 0


def test_editing_one_paragraph_judges_exactly_that_one(project_dir):
    replace_section(project_dir, set())
    configure_model(project_dir)
    run_audit(project_dir, fake())
    path = project_dir / SECTION
    path.write_text(path.read_text().replace("Paragraph 03 reports a careful measurement", "Paragraph 03 " + CLAIM + ", and also a careful measurement"))
    b = fake()
    rep = run_audit(project_dir, b)
    ctx = build_context(Project(str(project_dir)))
    edited = next(u for u in ctx.units if "Paragraph 03" in u.norm)
    asked_about_it = sum(1 for c in load_criteria(Project(str(project_dir)))[0] if in_scope(c, edited))
    assert asked_about_it >= 3 and b.calls == asked_about_it, "one call per criterion for the edited paragraph, none for the other five"
    (new,) = only_general(rep)
    assert new["unit"] and not rep["unexplained"]
    led = Ledger(Project(str(project_dir)))
    try:
        assert [r["cause"] for r in led.list() if r["check_id"] == "RUB-01"] == ["text-changed"]
    finally:
        led.close()


def test_a_pair_that_could_not_be_judged_is_carried_not_closed(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir)
    first = run_audit(project_dir, fake())
    (f,) = only_general(first)
    # the cache is gone and there is no model: the finding is not judged, which is not the same as fixed
    (project_dir / ".ah" / "verdicts.sqlite").unlink()
    rep = run_audit(project_dir, None)
    assert rep["rubric_run"]["unjudged_count"] == rep["rubric_run"]["pairs"] > 0
    (carried,) = only_general(rep)
    assert carried["fingerprint"] == f["fingerprint"] and carried["state"] == "open" and rep["ledger"]["fixed"] == 0
    # with a model again the paragraph is judged and, being unchanged, still fails
    again = run_audit(project_dir, fake())
    assert only_general(again)[0]["fingerprint"] == f["fingerprint"] and again["ledger"]["fixed"] == 0


def test_a_fix_is_recorded_when_the_model_no_longer_finds_the_defect(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir)
    run_audit(project_dir, fake())
    path = project_dir / SECTION
    path.write_text(path.read_text().replace("every benchmark we examined across all of the available corpora", "three of the five benchmarks we examined"))
    rep = run_audit(project_dir, fake())
    assert not only_general(rep) and rep["ledger"]["fixed"] >= 1 and not rep["unexplained"]


def test_first_judging_on_unchanged_text_is_evidence_changed_not_unexplained(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir)
    nothing = run_audit(project_dir, None)          # TR ran, but nothing could be judged
    assert not only_general(nothing)
    judged = run_audit(project_dir, fake())         # same text, same criteria: the model's answer is new evidence
    assert len(only_general(judged)) == 1 and judged["new_causes"] == {"evidence-changed": 1} and not judged["unexplained"]


def test_editing_a_criterion_is_rubric_changed(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir)
    run_audit(project_dir, fake())
    digest_before = criteria_digest(Project(str(project_dir)))
    (project_dir / "rubric").mkdir()
    (project_dir / "rubric" / "mine.yaml").write_text(yaml.safe_dump({"criteria": [
        {"id": "RUB-HYPE", "question": "Does the paragraph claim that the method wins on every benchmark we examined without hedging?"}]}))
    assert criteria_digest(Project(str(project_dir))) != digest_before

    def hype(prompt: str) -> str:
        q = re.search(r"<criterion>(.*?)</criterion>", prompt, re.S).group(1)
        t = re.search(r"<paragraph>\n(.*?)\n</paragraph>", prompt, re.S).group(1)
        if "without hedging" in q and "every benchmark we examined" in t:
            return json.dumps({"answer": "yes", "quote": "every benchmark we examined", "note": ""})
        return model_fn(prompt)

    rep = run_audit(project_dir, fake(hype))
    assert {f["key"] for f in only_general(rep)} == {"RUB-GENERAL", "RUB-HYPE"}
    assert rep["new_causes"] == {"rubric-changed": 1} and not rep["unexplained"]


def test_the_model_name_is_part_of_the_cache_key(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir, "m1")
    run_audit(project_dir, fake(model="m1"))
    b = fake(model="m2")
    run_audit(project_dir, b)
    assert b.calls > 0, "another model has no cached verdicts"
    c = Criterion("RUB-X", 1, "Does it?", "minor", ["*"], ("para",), 12, "x")
    assert cache_key(c, "h", "m1") != cache_key(c, "h", "m2") != cache_key(c, "h2", "m2")


def test_the_call_budget_leaves_the_rest_unjudged(project_dir):
    replace_section(project_dir, {1, 2})
    configure_model(project_dir)
    b = fake()
    rep = run_audit(project_dir, b, rubric_limit=3)
    assert b.calls == 3 and rep["rubric_run"]["unjudged_count"] == rep["rubric_run"]["pairs"] - 3


def test_a_transport_error_is_unjudged_and_not_remembered(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir)
    broken = fake(lambda prompt: "")                        # FakeBackend returns an empty completion, which parses to nothing
    rep = run_audit(project_dir, broken)
    assert rep["rubric_run"]["unjudged_count"] == rep["rubric_run"]["pairs"] and rep["rubric_run"]["errors"] == rep["rubric_run"]["pairs"]
    good = fake()
    again = run_audit(project_dir, good)
    assert good.calls == again["rubric_run"]["pairs"], "the failures were not cached, so they are asked again"
    assert len(only_general(again)) == 1


# ---- admission ----

def make_labels(root: Path, defects: set[int], n: int, wrong: set[int] = frozenset()) -> Path:
    units = {u.file + str(u.start): u for u in build_context(Project(str(root))).units}
    ctx = build_context(Project(str(root)))
    rows = []
    for u in ctx.units:
        if u.file != "sections/04_experiments/index.tex":
            continue
        i = int(re.search(r"Paragraph (\d+)", u.norm).group(1))
        truth = i in defects
        rows.append({"unit": u.uid or f"{u.file}#{u.hash}", "hash": u.hash, "label": "yes" if (truth != (i in wrong)) else "no"})
    path = root / "labels.yaml"
    path.write_text(yaml.safe_dump({"labels": rows}))
    return path


def admit(root: Path, backend, *extra) -> int:
    set_cfg(root, verifier={"backend": "http", "url": "http://127.0.0.1:9/v1", "model": backend.model})
    import ah.cli as cli
    original = cli._build_backend
    cli._build_backend = lambda a, p, flag: backend
    try:
        return main(["rubric", "admit", "RUB-GENERAL", "--project", str(root), "--labels", str(root / "labels.yaml"),
                     "--min-labels", "10", "--min-per-class", "3", *extra])
    finally:
        cli._build_backend = original


def test_kappa_and_the_admission_thresholds():
    assert cohens_kappa([(True, True), (False, False)] * 5) == 1.0
    assert cohens_kappa([(True, False), (False, True)] * 5) == -1.0
    assert cohens_kappa([(True, True)] * 10) == 1.0
    stats = agreement([(True, True)] * 4 + [(True, False)] + [(False, False)] * 5)
    assert (stats["tp"], stats["fp"], stats["tn"]) == (4, 1, 5) and stats["precision"] == 0.8
    assert admission_failures(stats, 10, 3, 0.6, 0.8) == []
    assert any("precision" in f for f in admission_failures(stats, 10, 3, 0.6, 0.9))
    assert any("usable labels" in f for f in admission_failures(stats, 50, 3, 0.6, 0.8))
    assert any("labelled defects" in f for f in admission_failures(agreement([(True, True)] * 12), 10, 3, 0.6, 0.8))


def test_a_criterion_is_admitted_only_by_measured_agreement_and_only_on_yes(project_dir, capsys):
    replace_section(project_dir, {1, 3, 5, 7, 9, 11}, n=12)
    labels = make_labels(project_dir, {1, 3, 5, 7, 9, 11}, 12)
    assert admit(project_dir, fake(model="m1")) == 0
    assert not (project_dir / "rubric" / "admissions.yaml").exists(), "meeting the thresholds is not admitting: that is the author's `--yes`"
    assert "Not recorded" in capsys.readouterr().out
    assert admit(project_dir, fake(model="m1"), "--yes") == 0
    adm = load_admissions(Project(str(project_dir)))["RUB-GENERAL"]
    assert adm["kappa"] == 1.0 and adm["precision"] == 1.0 and adm["model"] == "m1" and adm["n"] == 12 and len(adm["labels_sha"]) == 16

    configure_model(project_dir, "m1")
    rep = run_audit(project_dir, fake(model="m1"))
    found = only_general(rep)
    assert len(found) == 6 and {f["level"] for f in found} == {"minor"}, "now it reports at the criterion's own level"
    assert rep["rubric_run"]["admitted"] == ["RUB-GENERAL"]

    # another model: the admission says nothing about it
    other = run_audit(project_dir, fake(model="m2"))
    assert {f["level"] for f in only_general(other)} == {"info"}
    # a reworded question: the admission is void
    (project_dir / "rubric").mkdir(exist_ok=True)
    (project_dir / "rubric" / "mine.yaml").write_text(yaml.safe_dump({"criteria": [
        {"id": "RUB-GENERAL", "version": 1, "level": "minor", "question": "Does the paragraph claim a result holds universally when it covers only a few cases?"}]}))
    crit = {c.id: c for c in load_criteria(Project(str(project_dir)))[0]}["RUB-GENERAL"]
    assert not is_admitted(crit, load_admissions(Project(str(project_dir))), "m1")


def test_a_model_that_disagrees_with_the_author_is_not_admitted(project_dir, capsys):
    replace_section(project_dir, {1, 3, 5, 7, 9, 11}, n=12)
    make_labels(project_dir, {1, 3, 5, 7, 9, 11}, 12, wrong={3, 5, 7, 9})      # the author's labels contradict the model
    assert admit(project_dir, fake(model="m1"), "--yes") == 1
    assert "NOT ADMITTED" in capsys.readouterr().out
    assert not (project_dir / "rubric" / "admissions.yaml").exists()


def test_stale_and_missing_labels_are_skipped_not_trusted(project_dir):
    replace_section(project_dir, {1, 3, 5, 7, 9, 11}, n=12)
    path = make_labels(project_dir, {1, 3, 5, 7, 9, 11}, 12)
    data = yaml.safe_load(path.read_text())
    data["labels"][0]["hash"] = "0000dead"                  # the paragraph was edited after it was labelled
    data["labels"].append({"unit": "sections/04_experiments/index.tex#nope", "hash": "", "label": "no"})
    path.write_text(yaml.safe_dump(data))
    assert admit(project_dir, fake(model="m1"), "--json") == 0
    # 12 labels, 1 stale and 1 missing extra: 11 usable
    out = json.loads(subprocess_free_json(project_dir))
    assert out["agreement"]["n"] == 11 and len(out["skipped"]["stale"]) == 1 and len(out["skipped"]["missing"]) == 1


def subprocess_free_json(root: Path) -> str:
    import contextlib
    import io
    buf = io.StringIO()
    set_cfg(root, verifier={"backend": "http", "url": "http://127.0.0.1:9/v1", "model": "m1"})
    import ah.cli as cli
    original = cli._build_backend
    cli._build_backend = lambda a, p, flag: fake(model="m1")
    try:
        with contextlib.redirect_stdout(buf):
            main(["rubric", "admit", "RUB-GENERAL", "--project", str(root), "--labels", str(root / "labels.yaml"),
                  "--min-labels", "10", "--min-per-class", "3", "--json"])
    finally:
        cli._build_backend = original
    return buf.getvalue()


def test_an_admitted_criterion_can_gate_and_an_agent_cannot_write_its_own_admission(project_dir):
    replace_section(project_dir, {1, 3, 5, 7, 9, 11}, n=12)
    make_labels(project_dir, {1, 3, 5, 7, 9, 11}, 12)
    (project_dir / "rubric").mkdir(exist_ok=True)
    (project_dir / "rubric" / "mine.yaml").write_text(yaml.safe_dump({"criteria": [
        {"id": "RUB-GENERAL", "version": 1, "level": "major", "question": "Does the paragraph claim a result holds universally when it covers only a few cases?"}]}))
    configure_model(project_dir, "m1")
    before = run_audit(project_dir, fake(model="m1"))
    assert before["gate"]["passed"] or all(f["level"] == "info" for f in only_general(before))
    assert admit(project_dir, fake(model="m1"), "--yes") == 0
    after = run_audit(project_dir, fake(model="m1"))
    assert {f["level"] for f in only_general(after)} == {"major"} and after["gate"]["passed"] is False
    assert "rubric/**" in Project(str(project_dir)).protected_globs(), "agents cannot edit criteria, labels or admissions"


def test_a_carried_finding_falls_back_to_info_when_its_admission_is_void(project_dir):
    replace_section(project_dir, {1, 3, 5, 7, 9, 11}, n=12)
    make_labels(project_dir, {1, 3, 5, 7, 9, 11}, 12)
    assert admit(project_dir, fake(model="m1"), "--yes") == 0
    admitted = run_audit(project_dir, fake(model="m1"))
    assert {f["level"] for f in only_general(admitted)} == {"minor"}
    configure_model(project_dir, "m2")                       # the configured model changes; nothing is cached for it
    (project_dir / ".ah" / "verdicts.sqlite").unlink()
    rep = run_audit(project_dir, None)
    assert len(only_general(rep)) == 6 and {f["level"] for f in only_general(rep)} == {"info"}, "carried, but no longer allowed to gate"


# ---- the CLI ----

COMMAND_MODEL = '''import json, re, sys
prompt = sys.stdin.read()
q = re.search(r"<criterion>(.*?)</criterion>", prompt, re.S).group(1)
t = re.search(r"<paragraph>\\n(.*?)\\n</paragraph>", prompt, re.S).group(1)
hit = "universally" in q and "every benchmark we examined" in t
print(json.dumps({"answer": "yes" if hit else "no", "quote": "every benchmark we examined" if hit else "", "note": "stub"}))
'''


def test_the_cli_judges_replays_and_lists(project_dir, tmp_path, capsys):
    replace_section(project_dir, {1, 4})
    capsys.readouterr()                      # the unit sync above printed a line
    script = tmp_path / "model.py"
    script.write_text(COMMAND_MODEL)
    set_cfg(project_dir, verifier={"backend": "command", "cmd": [sys.executable, str(script)]})
    assert main(["rubric", "run", "--project", str(project_dir), "--json"]) == 0
    cold = json.loads(capsys.readouterr().out)
    assert cold["stats"]["unjudged_count"] == cold["stats"]["pairs"] and cold["stats"]["calls"] == 0, "without --judge nothing is asked"
    assert main(["rubric", "run", "--project", str(project_dir), "--judge", "--json"]) == 0
    judged = json.loads(capsys.readouterr().out)
    assert judged["stats"]["calls"] == judged["stats"]["pairs"] and [f["check"] for f in judged["findings"]] == ["RUB-01"] * 2
    assert main(["rubric", "run", "--project", str(project_dir), "--json"]) == 0
    replay = json.loads(capsys.readouterr().out)
    assert replay["stats"]["calls"] == 0 and replay["stats"]["cached"] == judged["stats"]["pairs"] and len(replay["findings"]) == 2
    assert main(["audit", "--project", str(project_dir), "--rubric", "--json"]) in (0, 1)
    rep = json.loads(capsys.readouterr().out)
    assert len([f for f in rep["findings"] if f["check"] == "RUB-01"]) == 2 and rep["rubric_run"]["calls"] == 0
    assert main(["rubric", "list", "--project", str(project_dir), "--json"]) == 0
    listing = json.loads(capsys.readouterr().out)
    assert listing["model"] and all(not c["admitted"] and c["effective_level"] == "info" for c in listing["criteria"])
    assert main(["rubric", "sheet", "RUB-GENERAL", "--project", str(project_dir), "--limit", "2"]) == 0
    sheet = capsys.readouterr().out
    assert "label: null" in sheet and sheet.count("unit:") == 2
    assert main(["rubric", "run", "RUB-NOPE", "--project", str(project_dir)]) == 2


def test_judge_needs_a_verifier_section(project_dir):
    import pytest
    with pytest.raises(SystemExit) as e:
        main(["rubric", "run", "--project", str(project_dir), "--judge"])
    assert "verifier" in str(e.value)


def test_the_rubric_tier_gives_the_same_findings_every_time_with_a_cache(project_dir):
    replace_section(project_dir, {1})
    configure_model(project_dir)
    b = fake()
    first = run_checks(build_context(Project(str(project_dir))), ("TR",), rubric_backend=b)
    calls = b.calls
    assert calls > 0
    for _ in range(4):
        again = run_checks(build_context(Project(str(project_dir))), ("TR",), rubric_backend=b)
        assert report_hash(again) == report_hash(first)
    assert b.calls == calls, "four more runs asked nothing"
