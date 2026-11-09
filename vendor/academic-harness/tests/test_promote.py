"""Promote a review comment to a rule (phase 5): proposals are validated, only the author accepts, an accepted rule
is checked on every run and keeps its own fixtures honest, and review comments are triaged against what the checks
already know."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from ah import promote as PM
from ah.audit import audit
from ah.cli import main
from ah.context import build_context
from ah.project import Project

SPAN = "We evaluate on 1240 documents drawn from three corpora and report the results in a later section of the paper."


def spec(**kw) -> dict:
    base = {"kind": "pattern", "id": "PRM-LATER", "pattern": r"\ba later section\b", "message": "say which section",
            "why": "fixed wording", "comment": "the intro points to 'a later section' without saying which", "span": SPAN,
            "source": "deep_review:round-1:c-7"}
    base.update(kw)
    return base


def run(root, *argv) -> int:
    return main([argv[0], "--project", str(root), *argv[1:]])


def propose(root, **kw):
    return PM.propose(build_context(Project(str(root))), spec(**kw))


def accept(root, rid="PRM-LATER"):
    return PM.accept(build_context(Project(str(root))), rid)


def findings(root, check):
    return [f for f in audit(Project(str(root)), use_ledger=False)["findings"] if f["check"] == check]


# ---------------------------------------------------------------- proposals
def test_a_proposal_is_validated_against_the_manuscript_and_checks_nothing_yet(project_dir):
    r = propose(project_dir)
    assert r["kind"] == "pattern" and r["fires_on_units"] == 1
    assert r["fires_now"][0]["match"] == "a later section"
    assert (project_dir / "proposals/rules/PRM-LATER.yaml").exists()
    assert not (project_dir / "rules/promoted.yaml").exists()
    assert findings(project_dir, "PRM-01") == [], "a proposal is not a rule"


def test_the_positive_fixture_is_the_sentence_the_comment_pointed_at(project_dir):
    propose(project_dir)
    rec = yaml.safe_load((project_dir / "proposals/rules/PRM-LATER.yaml").read_text())
    assert rec["rule"]["fixtures"]["positive"] == [SPAN]
    assert rec["origin"]["unit"].startswith("introduction")


@pytest.mark.parametrize("bad,why", [
    (dict(span="a sentence that is nowhere in this manuscript at all"), "not in the manuscript"),
    (dict(span="later"), "not in the manuscript"),                      # too short to be a quote: it would match anywhere
    (dict(pattern=r"\bsomething else entirely\b"), "positive fixture"),
    (dict(pattern=r"(\w+)*$"), "empty text|repeats a repeated"),
    (dict(pattern=r"(a+)+b"), "repeats a repeated"),
    (dict(pattern="("), "does not compile"),
    (dict(pattern=""), "needs a pattern"),
    (dict(pattern=r"\ba later section\b", negatives=["We report in a later section of the appendix."]), "negative fixture"),
    (dict(id="LATER"), "must look like PRM"),
    (dict(message=""), "needs a message"),
    (dict(why=""), "why a program can decide"),
    (dict(comment=""), "review comment"),
    (dict(span=""), "give the span"),
    (dict(level="severe"), "level must be"),
    (dict(kind="regex"), "kind must be"),
])
def test_a_bad_proposal_is_refused_with_a_reason(project_dir, bad, why):
    with pytest.raises(PM.PromoteError, match=why):
        propose(project_dir, **bad)
    assert not list((project_dir / "proposals").glob("rules/*.yaml")) if (project_dir / "proposals").exists() else True


def test_a_pattern_that_fires_on_most_of_the_manuscript_is_refused_as_noise(project_dir):
    with pytest.raises(PM.PromoteError, match="too broad|noise"):
        propose(project_dir, pattern=r"\bthe\b|\bof\b|\bwe\b|\ba\b|\band\b|\bin\b", span=SPAN)


def test_the_same_id_cannot_be_proposed_twice_or_over_an_accepted_rule(project_dir):
    propose(project_dir)
    with pytest.raises(PM.PromoteError, match="already"):
        propose(project_dir)
    accept(project_dir)
    with pytest.raises(PM.PromoteError, match="already"):
        propose(project_dir)


def test_a_span_copied_from_a_pdf_still_finds_its_paragraph(project_dir):
    pdf = "We evaluate on 1240 documents drawn from three corpora,  and report the\nresults in a later section of the paper"
    assert propose(project_dir, span=pdf)["fires_on_units"] == 1


# ---------------------------------------------------------------- the author's act
def test_accepting_needs_a_human_and_an_agent_without_yes_cannot(project_dir, capsys):
    propose(project_dir)
    assert run(project_dir, "rule", "accept", "PRM-LATER") == 2          # no tty, no --yes
    assert not (project_dir / "rules/promoted.yaml").exists()
    assert run(project_dir, "rule", "accept", "PRM-LATER", "--yes") == 0
    assert (project_dir / "rules/promoted.yaml").exists()
    assert not (project_dir / "proposals/rules/PRM-LATER.yaml").exists()


def test_an_agent_cannot_write_the_rules_file(project_dir):
    globs = Project(str(project_dir)).protected_globs()
    assert "rules/**" in globs and "rubric/**" in globs


def test_reject_removes_the_proposal_and_changes_nothing(project_dir):
    propose(project_dir)
    assert run(project_dir, "rule", "reject", "PRM-LATER", "--yes") == 0
    assert not (project_dir / "proposals/rules/PRM-LATER.yaml").exists()
    assert findings(project_dir, "PRM-01") == []


# ---------------------------------------------------------------- an accepted rule is a check
def test_an_accepted_rule_is_found_on_every_run_with_a_stable_fingerprint(project_dir):
    propose(project_dir)
    accept(project_dir)
    a, b = findings(project_dir, "PRM-01"), findings(project_dir, "PRM-01")
    assert len(a) == 1 and a[0]["level"] == "info"
    assert [f["fingerprint"] for f in a] == [f["fingerprint"] for f in b]
    assert "PRM-LATER" in a[0]["message"] and "a later section" in a[0]["message"]


def test_the_fingerprint_survives_a_line_move_and_dies_with_the_fix(project_dir):
    propose(project_dir)
    accept(project_dir)
    before = findings(project_dir, "PRM-01")[0]["fingerprint"]
    intro = project_dir / "src/sections/01_introduction/index.tex"
    intro.write_text(intro.read_text().replace("\\section{Introduction}", "\\section{Introduction}\n\n% a note\n"))
    assert findings(project_dir, "PRM-01")[0]["fingerprint"] == before
    intro.write_text(intro.read_text().replace("a later section of the paper", "Section~\\ref{sec:method}"))
    assert findings(project_dir, "PRM-01") == []


def test_the_ledger_records_a_new_rule_as_a_rule_change_and_the_fix_as_fixed(project_dir):
    audit(Project(str(project_dir)))                                      # baseline run with no promoted rules
    propose(project_dir)
    accept(project_dir)
    rep = audit(Project(str(project_dir)))
    row = next(f for f in rep["findings"] if f["check"] == "PRM-01")
    assert row["cause"] == "rubric-changed", "a new rule explains its own first findings"
    assert rep["unexplained"] == []
    intro = project_dir / "src/sections/01_introduction/index.tex"
    intro.write_text(intro.read_text().replace("a later section of the paper", "Section~\\ref{sec:method}"))
    again = audit(Project(str(project_dir)))
    assert not [f for f in again["findings"] if f["check"] == "PRM-01"]
    from ah.ledger.db import Ledger
    led = Ledger(Project(str(project_dir)))
    try:
        assert next(r for r in led.list() if r["fp"] == row["fingerprint"])["state"] == "fixed"
    finally:
        led.close()
    assert again["unexplained"] == []


def test_a_rule_edited_by_hand_so_its_fixture_fails_is_a_finding(project_dir):
    propose(project_dir)
    accept(project_dir)
    f = project_dir / "rules/promoted.yaml"
    data = yaml.safe_load(f.read_text())
    data["rules"][0]["pattern"] = r"\bsomething else\b"
    f.write_text(yaml.safe_dump(data))
    bad = findings(project_dir, "PRM-02")
    assert bad and bad[0]["level"] == "major" and "positive fixture" in bad[0]["message"]
    assert findings(project_dir, "PRM-01") == [], "a broken rule is not half-applied"


def test_a_corrupt_rules_file_is_one_finding_not_a_crash(project_dir):
    (project_dir / "rules").mkdir()
    (project_dir / "rules/promoted.yaml").write_text("rules: [oops: [")
    assert findings(project_dir, "PRM-02")


def test_the_rules_file_is_part_of_the_snapshot(project_dir):
    p = Project(str(project_dir))
    assert "rules" not in p.snapshot(), "projects without promoted rules keep their old snapshot"
    propose(project_dir)
    accept(project_dir)
    assert "rules" in Project(str(project_dir)).snapshot()


def test_level_can_be_overridden_in_the_project_and_in_the_rule(project_dir):
    propose(project_dir, level="minor")
    accept(project_dir)
    assert findings(project_dir, "PRM-01")[0]["level"] == "minor"
    cfg = project_dir / "ah.yaml"
    cfg.write_text(cfg.read_text() + "\nlevels:\n  PRM-01: 'off'\n")
    assert findings(project_dir, "PRM-01") == []


def test_the_rule_applies_only_inside_its_scope(project_dir):
    propose(project_dir, files=["sections/03_*/*"])        # the phrase is in the introduction, not in the method
    accept(project_dir)
    assert findings(project_dir, "PRM-01") == []


def test_an_incremental_audit_still_reports_a_promoted_rule_on_an_unchanged_unit(project_dir):
    propose(project_dir)
    accept(project_dir)
    audit(Project(str(project_dir)))
    rep = audit(Project(str(project_dir)), incremental=True)
    assert [f["state"] for f in rep["findings"] if f["check"] == "PRM-01"] == ["open"], "unchanged units keep their finding"


# ---------------------------------------------------------------- criteria
def test_a_criterion_proposal_joins_the_rubric_unadmitted(project_dir):
    crit = dict(kind="criterion", id="RUB-VAGUEREF", question="Does the paragraph point to a later section without saying which one?",
                pattern=None, message="")
    crit.pop("pattern"); crit.pop("message")
    r = propose(project_dir, **crit)
    assert r["kind"] == "criterion" and r["example_unit"]
    accept(project_dir, "RUB-VAGUEREF")
    from ah.rubric import is_admitted, load_admissions, load_criteria
    p = Project(str(project_dir))
    c = next(c for c in load_criteria(p)[0] if c.id == "RUB-VAGUEREF")
    assert not is_admitted(c, load_admissions(p), "any-model"), "a promoted criterion reports at info until the author measures it"
    assert (project_dir / "rubric/promoted.yaml").exists()


def test_a_criterion_must_be_a_real_question(project_dir):
    with pytest.raises(PM.PromoteError, match="question"):
        propose(project_dir, kind="criterion", id="RUB-X", question="Fix the vague references.", pattern=None)


# ---------------------------------------------------------------- triage
def comments(*rows):
    return [dict(id=i, text=t, quote=q) for i, t, q in rows]


def test_a_comment_about_a_paragraph_a_rule_fires_on_is_covered(project_dir):
    propose(project_dir)
    accept(project_dir)
    ctx = build_context(Project(str(project_dir)))
    from ah.cli_author import triage_items
    rows = triage_items(ctx.project, ctx, comments(
        ("c1", "It says the results are in a later section, which does not help.", "report the results in a later section of the paper"),
        ("c2", "The abstract is hard to read.", ""),
    ))
    assert rows[0]["tag"] == "covered-by:PRM-01" and rows[0]["status"] == "covered"
    assert rows[1]["tag"] == "exploratory" and not rows[1]["located"]


def test_a_rule_on_the_same_paragraph_with_no_evident_link_is_same_unit_not_covered(project_dir):
    propose(project_dir)
    accept(project_dir)
    ctx = build_context(Project(str(project_dir)))
    from ah.cli_author import triage_items
    rows = triage_items(ctx.project, ctx, comments(("c1", "The corpora are not described anywhere.", "drawn from three corpora")))
    assert rows[0]["status"] == "same-unit" and rows[0]["tag"].startswith("same-unit:")


def test_a_comment_whose_passage_cannot_be_found_is_exploratory_and_says_so(project_dir):
    ctx = build_context(Project(str(project_dir)))
    from ah.cli_author import triage_items
    rows = triage_items(ctx.project, ctx, comments(("c1", "Table 9 is wrong.", "Table nine in the appendix of the paper")))
    assert rows[0]["tag"] == "exploratory" and rows[0]["located"] is False


def test_a_passage_quoted_inside_the_comment_text_is_found(project_dir):
    propose(project_dir)
    accept(project_dir)
    ctx = build_context(Project(str(project_dir)))
    from ah.cli_author import triage_items
    rows = triage_items(ctx.project, ctx, comments(("c1", 'The phrase "report the results in a later section of the paper" is vague.', "")))
    assert rows[0]["located"] and rows[0]["status"] == "covered"


def test_triage_is_deterministic(project_dir):
    propose(project_dir)
    accept(project_dir)
    ctx = build_context(Project(str(project_dir)))
    from ah.cli_author import triage_items
    cs = comments(("c1", "later section vague", "report the results in a later section of the paper"), ("c2", "x", ""))
    assert triage_items(ctx.project, ctx, cs) == triage_items(ctx.project, ctx, cs)


def test_review_import_tags_each_item_and_triage_can_rewrite_the_tags(project_dir, tmp_path, capsys):
    propose(project_dir)
    accept(project_dir)
    f = tmp_path / "review.txt"
    f.write_text('1. Major: "report the results in a later section of the paper" is vague about the later section.\n2. Minor: the abstract is dull.\n')
    capsys.readouterr()
    assert run(project_dir, "review", "import", "r1", "--file", str(f)) == 0
    out = capsys.readouterr().out
    assert "[covered-by:PRM-01]" in out and "[exploratory]" in out
    rev = yaml.safe_load((project_dir / "reviews/r1.yaml").read_text())
    assert [it["coverage"] for it in rev["items"]] == ["covered-by:PRM-01", "exploratory"]
    capsys.readouterr()
    assert run(project_dir, "review", "list") == 0
    assert "[covered-by:PRM-01]" in capsys.readouterr().out
    assert run(project_dir, "triage", "--review", "r1", "--write") == 0


def test_triage_json_has_a_summary(project_dir, capsys):
    capsys.readouterr()
    assert run(project_dir, "triage", "--data", json.dumps(comments(("c1", "vague", "")))) == 0
    assert "1 comment(s): 0 covered, 0 same-unit, 1 exploratory (1 unlocated)" in capsys.readouterr().out


def test_rule_test_command_reports_fixtures_and_hits(project_dir, capsys):
    propose(project_dir)
    accept(project_dir)
    capsys.readouterr()
    assert run(project_dir, "rule", "test") == 0
    out = capsys.readouterr().out
    assert "PRM-LATER" in out and "fires on 1 unit" in out
