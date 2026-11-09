"""The stop gate must still see a blocker the agent introduced after the host re-enters the turn.

Found live: on DSH `agent/pre-step` ran the `userprompt` hook again after an edit (the turn had been suspended on a
question and resumed). That reset the baseline to include the blocker the agent had just added and cleared the touched
list, so the stop gate saw nothing and the turn ended with a new TEX-02 blocker unreported."""
from __future__ import annotations

from ah.hooks import handle

SID = "s-reentry"


def _event(project_dir, name, **extra):
    return handle(name, {"cwd": str(project_dir), "session_id": SID, **extra})


def _edit_intro(project_dir):
    intro = project_dir / "src/sections/01_introduction/index.tex"
    intro.write_text(intro.read_text() + "\nWe describe the system in Section~\\ref{sec:does_not_exist}.\n")
    return str(intro)


def test_stop_blocks_on_a_new_blocker(project_dir):
    _event(project_dir, "userprompt")
    _event(project_dir, "post", tool_name="Edit", tool_input={"file_path": _edit_intro(project_dir)})
    out = _event(project_dir, "stop")
    assert out and out.get("decision") == "block" and "TEX-02" in out["reason"]


def test_a_mid_turn_reentry_does_not_forgive_the_blocker(project_dir):
    _event(project_dir, "userprompt")
    _event(project_dir, "post", tool_name="Edit", tool_input={"file_path": _edit_intro(project_dir)})
    _event(project_dir, "userprompt")                       # the host re-enters the same turn
    out = _event(project_dir, "stop")
    assert out and out.get("decision") == "block" and "TEX-02" in out["reason"]


def test_a_new_prompt_after_the_turn_settled_starts_fresh(project_dir):
    _event(project_dir, "userprompt")
    _event(project_dir, "post", tool_name="Edit", tool_input={"file_path": _edit_intro(project_dir)})
    for _ in range(4):                                       # the gate steers up to max_loops, then hands off
        _event(project_dir, "stop")
    _event(project_dir, "userprompt")                       # the author's next message
    assert _event(project_dir, "stop") is None              # the old blocker belongs to the baseline now


def test_a_finding_handed_to_the_author_stops_the_steering(project_dir):
    """Live: after the agent recorded a decision request, the gate still steered it three more times on the same finding."""
    from ah.guard import new_findings
    open_ = {"fp": "a1", "level": "blocker", "state": "open"}
    handed = {"fp": "b2", "level": "blocker", "state": "decision-needed"}
    waived = {"fp": "c3", "level": "blocker", "state": "waived"}
    assert new_findings(set(), [open_, handed, waived]) == [open_]
