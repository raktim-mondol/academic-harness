"""UNIT-03: prose written inside the build root is never read by any check, and the audit must say so."""
from __future__ import annotations

from ah.audit import run_checks
from ah.context import build_context


def fired(project):
    return [f for f in run_checks(build_context(project)) if f.check == "UNIT-03"]


def test_a_root_that_only_inputs_sections_is_fine(project):
    assert fired(project) == []


def test_prose_in_the_root_is_reported(project, project_dir):
    root = project.view_files()[0]
    text = root.read_text()
    body = " ".join(["The classifier is trained on labelled spoil images and evaluated on held-out sites."] * 20)
    root.write_text(text.replace("\\end{document}", body + "\n\\end{document}"))
    found = fired(project)
    assert len(found) == 1 and "build root" in found[0].message and found[0].level == "major"


def test_a_few_words_in_the_root_are_not_reported(project, project_dir):
    root = project.view_files()[0]
    root.write_text(root.read_text().replace("\\end{document}", "Short note.\n\\end{document}"))
    assert fired(project) == []
