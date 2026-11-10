"""The advisory evidence check (T3) asks before it runs (review B5, decision D23).

T3 spends a verifier-model call per changed unit, so the plugin asks the person once per session. The engine
supports that with AH_T3_MODE:

    run    (default, what every earlier version did) run the check now and mark it done
    defer  report {"t3Pending": {...}} and run nothing, so the host can ask first
    skip   the person said no: mark it done without running it

The check still runs at most once per session id; that is documented behaviour, not an accident."""
from __future__ import annotations

import pytest
import yaml

from ah.hooks import handle

SID = "s-t3"


@pytest.fixture
def t3_project(project_dir):
    cfg_path = project_dir / "ah.yaml"
    cfg = yaml.safe_load(cfg_path.read_text()) or {}
    cfg.setdefault("gate", {})["verify_touched"] = True
    cfg_path.write_text(yaml.safe_dump(cfg))
    return project_dir


@pytest.fixture
def verifier(monkeypatch):
    """A verifier stand-in: counts calls and returns one flagged clause."""
    calls = []

    def fake_verify_touched(project, touched, backend=None, before=None):
        calls.append(list(touched))
        return {"checked": 2, "verdicts": {}, "flags": ["Intro clause not confirmed by its source"]}

    monkeypatch.setattr("ah.hooks.verify_touched", fake_verify_touched)
    monkeypatch.setattr("ah.verifier.backends.get_backend", lambda cfg: object())
    return calls


def _event(project_dir, name, sid=SID, **extra):
    return handle(name, {"cwd": str(project_dir), "session_id": sid, **extra})


def _clean_edit(project_dir):
    """An edit that adds prose but no blocking finding, so the gate settles and T3 is the next step."""
    method = project_dir / "src/sections/03_method/index.tex"
    method.write_text(method.read_text() + "\nThe scorer is trained once and reused for every query.\n")
    return str(method)


def _settle(project_dir, sid=SID):
    _event(project_dir, "userprompt", sid)
    _event(project_dir, "post", sid, tool_name="Edit", tool_input={"file_path": _clean_edit(project_dir)})


def _state(project_dir, sid=SID):
    from ah.hooks import load_state
    from ah.project import Project
    return load_state(Project(str(project_dir)), sid)


def test_default_mode_runs_the_check_exactly_as_before(t3_project, verifier, monkeypatch):
    monkeypatch.delenv("AH_T3_MODE", raising=False)
    _settle(t3_project)
    out = _event(t3_project, "stop")
    assert len(verifier) == 1
    assert out and "AH evidence check (advisory" in out["systemMessage"]
    assert _state(t3_project)["t3_done"] is True


def test_defer_reports_what_would_run_and_runs_nothing(t3_project, verifier, monkeypatch):
    monkeypatch.setenv("AH_T3_MODE", "defer")
    _settle(t3_project)
    out = _event(t3_project, "stop")
    assert verifier == []
    assert out and out["t3Pending"]["units"] >= 1
    assert out["t3Pending"]["files"]
    assert "decision" not in out and "systemMessage" not in out
    assert _state(t3_project).get("t3_done") is not True


def test_defer_does_not_consume_the_check(t3_project, verifier, monkeypatch):
    monkeypatch.setenv("AH_T3_MODE", "defer")
    _settle(t3_project)
    assert _event(t3_project, "stop")["t3Pending"]
    assert _event(t3_project, "stop")["t3Pending"]            # still waiting for an answer
    monkeypatch.setenv("AH_T3_MODE", "run")
    out = _event(t3_project, "stop")
    assert len(verifier) == 1 and out and "evidence check" in out["systemMessage"]


def test_skip_marks_the_check_done_without_running_it(t3_project, verifier, monkeypatch):
    monkeypatch.setenv("AH_T3_MODE", "skip")
    _settle(t3_project)
    assert _event(t3_project, "stop") is None
    assert verifier == []
    assert _state(t3_project)["t3_done"] is True
    monkeypatch.setenv("AH_T3_MODE", "run")                   # once declined, later stops do not ask or run again
    assert _event(t3_project, "stop") is None
    assert verifier == []


def test_once_per_session_even_across_later_turns(t3_project, verifier, monkeypatch):
    monkeypatch.setenv("AH_T3_MODE", "run")
    _settle(t3_project)
    _event(t3_project, "stop")
    assert len(verifier) == 1
    _settle(t3_project)                                       # a second turn in the same session edits again
    assert _event(t3_project, "stop") is None
    assert len(verifier) == 1, "documented: the evidence check runs once per session"


def test_a_new_session_gets_its_own_check(t3_project, verifier, monkeypatch):
    monkeypatch.setenv("AH_T3_MODE", "run")
    _settle(t3_project)
    _event(t3_project, "stop")
    _settle(t3_project, "s-other")
    _event(t3_project, "stop", "s-other")
    assert len(verifier) == 2


def test_defer_with_nothing_to_run_does_not_ask(t3_project, verifier, monkeypatch):
    monkeypatch.setenv("AH_T3_MODE", "defer")
    monkeypatch.setattr("ah.verifier.backends.get_backend", lambda cfg: None)      # no verifier configured
    _settle(t3_project)
    out = _event(t3_project, "stop")
    assert not (out and "t3Pending" in out)
    assert _state(t3_project)["t3_done"] is True               # settled as before: the check reported "skipped"


def test_defer_never_hides_a_blocker(t3_project, verifier, monkeypatch):
    monkeypatch.setenv("AH_T3_MODE", "defer")
    _event(t3_project, "userprompt")
    intro = t3_project / "src/sections/01_introduction/index.tex"
    intro.write_text(intro.read_text() + "\nSee Section~\\ref{sec:does_not_exist}.\n")
    _event(t3_project, "post", tool_name="Edit", tool_input={"file_path": str(intro)})
    out = _event(t3_project, "stop")
    assert out and out.get("decision") == "block" and "TEX-02" in out["reason"]
    assert verifier == []


def test_defer_without_the_config_flag_stays_silent(project_dir, monkeypatch):
    monkeypatch.setenv("AH_T3_MODE", "defer")
    _settle(project_dir)
    assert _event(project_dir, "stop") is None                # verify_touched is off by default: no cost, no question
