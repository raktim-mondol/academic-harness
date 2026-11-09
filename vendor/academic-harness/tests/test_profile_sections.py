"""PRF-01 on the method section: 'Methodology' is as good a heading as 'Methods', and a made-up one still fails."""
from __future__ import annotations

from ah.audit import run_checks
from ah.context import build_context

METHOD_FILE = "src/sections/03_method/index.tex"


def method_findings(project, project_dir, heading):
    path = project_dir / METHOD_FILE
    path.write_text(path.read_text().replace("\\section{Method}", "\\section{%s}" % heading))
    return [f for f in run_checks(build_context(project)) if f.check == "PRF-01" and "Method" in f.message]


def test_methodology_satisfies_the_method_requirement(project, project_dir):
    assert method_findings(project, project_dir, "Methodology") == []


def test_an_unrelated_heading_does_not(project, project_dir):
    assert len(method_findings(project, project_dir, "Technique")) == 1
