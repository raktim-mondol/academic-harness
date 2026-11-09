"""An edit that makes a number disappear is not a fix for a finding about that number (found live: "100%" became
"complete agreement" and a specific example was dropped, to clear an info lint)."""
from __future__ import annotations

from ah.hooks import handle, removed_numbers

SID = "s-nums"


def _ev(project_dir, name, **extra):
    return handle(name, {"cwd": str(project_dir), "session_id": SID, **extra})


def _intro(project_dir):
    return project_dir / "src/sections/01_introduction/index.tex"


def _post(project_dir):
    return _ev(project_dir, "post", tool_name="Edit", tool_input={"file_path": str(_intro(project_dir))})


def _note(out):
    return (out or {}).get("hookSpecificOutput", {}).get("additionalContext", "")


def test_removed_numbers_counts_tokens():
    assert removed_numbers({"100%": 1, "20": 2}, {"20": 1}) == ["100%", "20"]
    assert removed_numbers({"20": 1}, {"20": 1, "3": 1}) == []


def test_an_edit_that_rewords_a_number_away_is_noted(project_dir):
    intro = _intro(project_dir)
    intro.write_text(intro.read_text() + "\nThe pilot reached 87\\% agreement on 412 samples.\n")
    _ev(project_dir, "userprompt")
    intro.write_text(intro.read_text().replace("reached 87\\% agreement on 412 samples", "reached strong agreement on many samples"))
    note = _note(_post(project_dir))
    assert "disappear" in note and "87%" in note and "412" in note
    assert "binding it to a \\fact" in note


def test_a_removal_is_reported_once(project_dir):
    intro = _intro(project_dir)
    intro.write_text(intro.read_text() + "\nThe pilot study reached 87\\% agreement between the two independent annotators.\n")
    _ev(project_dir, "userprompt")
    intro.write_text(intro.read_text().replace("87\\% agreement between the two independent annotators", "strong agreement between the two independent annotators"))
    assert "87%" in _note(_post(project_dir))
    intro.write_text(intro.read_text() + "\nA harmless sentence follows.\n")
    assert "disappear" not in _note(_post(project_dir))


def test_keeping_or_moving_a_number_is_silent(project_dir):
    intro = _intro(project_dir)
    intro.write_text(intro.read_text() + "\nThe pilot study reached 87\\% agreement between the two independent annotators.\n")
    _ev(project_dir, "userprompt")
    intro.write_text(intro.read_text().replace("The pilot study reached 87\\% agreement between the two independent annotators.", "Between the two independent annotators the pilot study reached 87\\% agreement."))
    assert "disappear" not in _note(_post(project_dir))


def test_a_list_marker_is_not_a_number(project_dir):
    intro = _intro(project_dir)
    intro.write_text(intro.read_text() + "\nThe study aims to (1) detect the shift, (2) classify its cause, and (3) report it to the operators of each site.\n")
    _ev(project_dir, "userprompt")
    intro.write_text(intro.read_text().replace("(1) detect the shift, (2) classify its cause, and (3) report it", "first detect the shift, then classify its cause, and finally report it"))
    assert "disappear" not in _note(_post(project_dir))
