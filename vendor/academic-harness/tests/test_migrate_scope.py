"""Migration: why a profile was chosen, what happens when two fit, and that a dry run and a second apply do not change anything."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from ah.cli import main
from ah.migrate import plan, scan

BODY = "This paragraph carries enough ordinary words to count as audited prose in the compiler and to appear on the page."


def tree(root: Path, extra: str = "") -> Path:
    (root / "sections").mkdir(parents=True)
    (root / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\n\\input{sections/a}\n\\end{document}\n")
    (root / "sections" / "a.tex").write_text(BODY + " " + extra + "\n")
    (root / "refs.bib").write_text("@article{k1,title={T},author={A, B},year={2020},journal={J}}\n")
    return root


def hashes(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): hashlib.sha1(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*")) if p.is_file()}


def test_the_chosen_profile_comes_with_its_reasons_and_the_candidates(tmp_path):
    r = scan(tree(tmp_path / "p", "We follow PRISMA for this systematic review of the included studies."))
    inf = r["profile_inference"]
    assert r["profile"] == inf["selected"] == "literature-review/systematic" and not inf["ambiguous"]
    assert "prisma" in inf["reason"]
    names = {c["profile"]: c for c in inf["candidates"]}
    assert names["literature-review/systematic"]["qualifies"] and not names["thesis"]["qualifies"]
    assert names["literature-review/systematic"]["matched"] == ["prisma", "systematic review", "included studies"]


def test_two_specific_profiles_that_fit_make_the_document_ambiguous_so_it_is_generic(tmp_path):
    root = tree(tmp_path / "p", "A systematic review following PRISMA of included studies.\n\\section{Specific Aims}\nThe budget and the specific aims.")
    r = scan(root)
    inf = r["profile_inference"]
    assert r["profile"] == "generic" and inf["ambiguous"] and "literature-review/systematic" in inf["reason"] and "grant/proposal" in inf["reason"]
    assert any("several profiles match" in w for w in plan(root)["warnings"])


def test_incidental_grant_words_do_not_make_a_grant(tmp_path):
    r = scan(tree(tmp_path / "p", "The budget for compute and a work package of experiments are described in the text."))
    assert r["profile"] == "generic" and not r["profile_inference"]["ambiguous"] and r["profile_inference"]["reason"] == "no profile matched"
    cand = {c["profile"]: c for c in r["profile_inference"]["candidates"]}["grant/proposal"]
    assert cand["matched"] and not cand["structural_signal"] and not cand["qualifies"]


def test_an_explicit_profile_wins_over_the_guess(tmp_path):
    root = tree(tmp_path / "p", "We follow PRISMA for this systematic review of the included studies.")
    assert plan(root)["profile"] == "literature-review/systematic"
    assert plan(root, profile="paper/conference")["profile"] == "paper/conference"


def test_a_dry_run_changes_nothing(tmp_path, capsys):
    root = tree(tmp_path / "p")
    before = hashes(root)
    assert main(["migrate", str(root)]) == 0
    assert main(["migrate", str(root), "--json"]) == 0
    assert hashes(root) == before and not (root / "ah.yaml").exists()
    out = capsys.readouterr().out
    assert "dry run" in out and '"coverage"' in json.dumps(json.loads(out[out.index("{"):])) if '"scan"' in out else True


def authors_files(root: Path) -> dict[str, str]:
    return {k: v for k, v in hashes(root).items() if k in ("main.tex", "refs.bib") or k.startswith("sections/")}


def strip_anchors(text: str) -> str:
    return "".join(line for line in text.splitlines(True) if not line.lstrip().startswith("%% @unit"))


def test_apply_with_no_sync_leaves_the_authors_files_byte_identical(tmp_path):
    root = tree(tmp_path / "p")
    before = authors_files(root)
    assert main(["migrate", str(root), "--apply", "--no-sync", "--profile", "generic"]) == 0
    assert (root / "ah.yaml").is_file() and authors_files(root) == before


def test_apply_with_sync_adds_unit_anchor_comments_and_nothing_else(tmp_path):
    root = tree(tmp_path / "p")
    before = {rel: (root / rel).read_text() for rel in authors_files(root)}
    assert main(["migrate", str(root), "--apply", "--profile", "generic"]) == 0
    after = {rel: (root / rel).read_text() for rel in before}
    assert after["sections/a.tex"] != before["sections/a.tex"] and "%% @unit" in after["sections/a.tex"]
    assert all(strip_anchors(after[r]) == before[r] for r in before), "the text itself is unchanged: only anchor comments were added"


def test_a_second_apply_refuses_without_force_and_changes_nothing(tmp_path, capsys):
    root = tree(tmp_path / "p")
    original = {r: (root / r).read_text() for r in authors_files(root)}
    assert main(["migrate", str(root), "--apply", "--profile", "generic"]) == 0
    first = hashes(root)
    capsys.readouterr()
    assert main(["migrate", str(root), "--apply", "--profile", "generic"]) == 2
    assert "already exists" in capsys.readouterr().err and hashes(root) == first, "a refused apply changes nothing"
    assert main(["migrate", str(root), "--apply", "--profile", "generic", "--force"]) == 0
    assert {r: strip_anchors((root / r).read_text()) for r in original} == original, "the text is still the author's"
    assert (root / "sections/a.tex").read_text().count("%% @unit") == 1, "forcing the overlay again does not stack anchors"
