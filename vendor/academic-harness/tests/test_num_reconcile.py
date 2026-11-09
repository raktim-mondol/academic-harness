"""NUM-004 reconciles "N% (a/b)". A signed percentage is a change, not a share, and must not be reconciled."""
from __future__ import annotations

from ah.checks.t1_numeric import _signed


def test_signed_numbers_are_changes():
    for text in ("CDR +10.4% (1/1000)", "recall -0.8% (3/400)", "recall −0.8% (3/400)", "diff ±2.1% (1/50)"):
        i = text.index(next(c for c in text if c.isdigit()))
        assert _signed(text, i), text


def test_plain_and_ranged_numbers_are_not_signed():
    assert not _signed("accuracy 80.0% (4/5)", 9)
    assert not _signed("between 5-10% (1/10)", 10)       # a range, not a sign
    assert not _signed("10.4% (1/1000)", 0)


def test_the_check_still_fires_on_a_true_mismatch_and_skips_a_signed_one(project, project_dir):
    from ah.audit import run_checks
    from ah.context import build_context
    intro = project_dir / "src/sections/01_introduction/index.tex"
    base = intro.read_text()
    intro.write_text(base + "\nThe cohort had a rate of 10.4\\% (1/1000) overall.\n\nThe change was +10.4\\% (1/1000) versus control.\n")
    found = [f for f in run_checks(build_context(project)) if f.check == "NUM-004"]
    assert len(found) == 1 and "1/1000 = 0.1%" in found[0].message
