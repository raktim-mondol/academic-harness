"""The build log: located overfull boxes, the page count, missing glyphs, the page limit (and, with TeX installed, the same against a real build)."""
from __future__ import annotations

import re
import shutil
import subprocess

import pytest
import yaml

from ah.context import build_context
from ah.project import Project
from ah.tex.build import log_findings, parse_log, run_build

LOG = r"""(./main.tex
LaTeX2e <2024-11-01>
(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls
Document Class: article 2024/06/29 v1.4n Standard LaTeX document class
(/usr/share/texlive/texmf-dist/tex/latex/base/size10.clo))
(./sections/01_introduction/index.tex
Overfull \hbox (45.0pt too wide) in paragraph at lines 5--7
[]\OT1/cmr/m/n/10 Thisisaveryverylongword (not a file)
 []

) (./sections/03_method/index.tex [1]
Overfull \hbox (3.5pt too wide) in paragraph at lines 5--6
Missing character: There is no β in font cmr10!
Missing character: There is no γ in font cmr10!
Overfull \hbox (7.0pt too wide) in paragraph at lines 5--6
) [2] )
Output written on build/main.pdf (12 pages, 345678 bytes).
"""


def test_each_overfull_box_records_its_lines_text_and_the_open_file():
    boxes = parse_log(LOG)["overfull_boxes"]
    assert [(b["file"], b["lines"], b["pts"]) for b in boxes] == [
        ("./sections/01_introduction/index.tex", [5, 7], 45.0),
        ("./sections/03_method/index.tex", [5, 6], 3.5),
        ("./sections/03_method/index.tex", [5, 6], 7.0)]
    assert boxes[0]["text"].startswith("thisisaveryverylongword")
    assert parse_log(LOG)["overfull"] == 3


def test_a_paragraph_reported_after_its_file_closed_is_still_found_by_line_and_text(project_dir):
    """Real pdfTeX flushes the last paragraph of an \\input file after that file's closing parenthesis, so the stack names the parent."""
    ctx = build_context(Project(str(project_dir)))
    method = next(u for u in ctx.units if u.file == "sections/03_method/index.tex")
    words = re.sub(r"\s+", " ", method.norm)[:60]
    log = (f"(./views/main.tex (./sections/01_introduction/index.tex) (./sections/03_method/index.tex)\n"
           f"Overfull \\hbox (30.0pt too wide) in paragraph at lines {method.start}--{method.end + 2}\n\\OT1/cmr/m/n/10 {words}\n []\n\n)")
    box = parse_log(log)["overfull_boxes"][0]
    assert box["file"] == "./views/main.tex", "the stack alone would blame the parent"
    f = {x.key: x for x in log_findings(ctx, parse_log(log))}
    assert f"overfull:{method.uid}" in f and f[f"overfull:{method.uid}"].ref == method.uid


def test_two_candidates_that_the_text_cannot_separate_are_not_guessed(project_dir):
    ctx = build_context(Project(str(project_dir)))
    a = next(u for u in ctx.units if u.file == "sections/03_method/index.tex")
    twins = [u for u in ctx.units if u.start == a.start]
    assert len(twins) > 1, "the fixture has paragraphs that start on the same line of different files"
    log = f"(./views/main.tex\nOverfull \\hbox (9.0pt too wide) in paragraph at lines {a.start}--{a.start + 1}\nzzz qqq xxx\n []\n"
    f = {x.key: x for x in log_findings(ctx, parse_log(log))}
    assert list(f) == ["overfull"] and f["overfull"].ref is None


def test_pages_glyphs_and_float_warnings_are_read():
    p = parse_log(LOG + "LaTeX Warning: Label `x' multiply defined.\nFloat too large for page by 3pt\n")
    assert p["pages"] == 12 and p["missing_characters"] == ["β", "γ"] and p["multiply_defined"] == ["x"] and p["float_too_large"] == 1
    assert parse_log("no output")["pages"] is None
    assert parse_log("Output written on main.xdv (1 page, 1234 bytes).")["pages"] == 1


def unit_of(ctx, rel):
    return next(u for u in ctx.units if u.file == rel)


def test_overfull_findings_are_per_paragraph_and_survive_edits_above(project_dir):
    ctx = build_context(Project(str(project_dir)))
    parsed = parse_log(LOG)
    got = {f.key: f for f in log_findings(ctx, parsed)}
    mid = unit_of(ctx, "sections/03_method/index.tex")
    key = f"overfull:{mid.uid}"
    assert key in got and got[key].ref == mid.uid and "2 overfull box warning(s) in this paragraph" in got[key].message and "7pt" in got[key].message
    assert got[key].fingerprint() == {f.key: f for f in log_findings(ctx, parse_log(LOG.replace("lines 5--6", "lines 6--7")))}[key].fingerprint(), \
        "the fingerprint has no line number"


def test_a_box_in_an_unknown_file_still_counts(project_dir):
    ctx = build_context(Project(str(project_dir)))
    f = {x.key: x for x in log_findings(ctx, parse_log("Overfull \\hbox (9.0pt too wide) in paragraph at lines 1--2\n"))}
    assert "overfull" in f and f["overfull"].ref is None


def test_missing_glyphs_and_the_page_limit(project_dir):
    ctx = build_context(Project(str(project_dir)))
    f = {x.check: x for x in log_findings(ctx, parse_log(LOG))}
    assert "TEX-07" in f and "β γ" in f["TEX-07"].message and "TEX-08" not in f, "no limit configured, no page finding"
    cfg = yaml.safe_load((project_dir / "ah.yaml").read_text())
    cfg["build"] = {"max_pages": 10}
    (project_dir / "ah.yaml").write_text(yaml.safe_dump(cfg))
    f = {x.check: x for x in log_findings(build_context(Project(str(project_dir))), parse_log(LOG))}
    assert f["TEX-08"].level == "major" and "12 pages (limit 10)" in f["TEX-08"].message
    cfg["build"] = {"max_pages": 12}
    (project_dir / "ah.yaml").write_text(yaml.safe_dump(cfg))
    assert "TEX-08" not in {x.check for x in log_findings(build_context(Project(str(project_dir))), parse_log(LOG))}


# ---------------------------------------------------------------- against a real build
real = pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdfinfo")), reason="needs a TeX installation")


@real
def test_a_real_build_attributes_the_overfull_paragraph_and_counts_pages(project_dir):
    src = project_dir / "src"
    (src / "views/main.tex").write_text("\\documentclass{article}\n\\begin{document}\n\\input{sections/01_introduction/index}\n\\input{sections/03_method/index}\n"
                                        "\\newpage Second page.\n\\end{document}\n")
    (src / "sections/01_introduction/index.tex").write_text("\\section{Introduction}\n\nA short and perfectly ordinary paragraph of plain words.\n")
    (src / "sections/03_method/index.tex").write_text("\\section{Method}\n\nA paragraph with an unbreakable token " + "W" * 120 + " that cannot be hyphenated.\n")
    subprocess.run([str(__import__("sys").executable), "-m", "ah", "units", "--project", str(project_dir), "sync"], capture_output=True)
    p = Project(str(project_dir))
    b = run_build(p)
    parsed = parse_log(b["log"])
    info = subprocess.run(["pdfinfo", str(src / "build/main.pdf")], capture_output=True, text=True).stdout
    assert parsed["pages"] == int(re.search(r"Pages:\s+(\d+)", info).group(1)) == 2
    ctx = build_context(p)
    mid = unit_of(ctx, "sections/03_method/index.tex")
    f = {x.key: x for x in log_findings(ctx, parsed)}
    assert f[f"overfull:{mid.uid}"].ref == mid.uid, (parsed["overfull_boxes"], list(f))
    cfg = yaml.safe_load((project_dir / "ah.yaml").read_text())
    cfg["build"] = {"max_pages": 1}
    (project_dir / "ah.yaml").write_text(yaml.safe_dump(cfg))
    assert "TEX-08" in {x.check for x in log_findings(build_context(Project(str(project_dir))), parsed)}
