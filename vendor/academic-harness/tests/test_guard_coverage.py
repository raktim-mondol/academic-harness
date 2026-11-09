"""The agent's shell cannot do the author's acts, and a broken engine does not switch the guard off.

Found live on Claude Code: `ah rule accept`, `ah disclosure approve` and `ah provenance set|fill` were allowed to an agent, a
confirmation prompt could be answered through a pseudo-terminal (`script`), and a failing debug log aborted the `pre` hook before the
protection logic ran, which the host reads as "allow".
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ah import guard
from ah.hooks import handle, main
from ah.project import Project

ENGINE = Path(guard.__file__).resolve().parents[1]


def pre(project_dir, command: str) -> dict | None:
    return handle("pre", {"cwd": str(project_dir), "session_id": "t", "tool_name": "Bash", "tool_input": {"command": command}})


def decision(out: dict | None) -> str:
    return (out or {}).get("hookSpecificOutput", {}).get("permissionDecision", "allow")


# Every act the engine reserves for a person, as an agent would type it. Add the new command here when you add an act.
AUTHOR_ACTS = [
    "ah finding waive abcd1234 --reason ok",
    "uv run ah finding   waive abcd1234 --reason ok",
    "python3 -m ah proposals accept P1",
    "ah proposals reject P1",
    "ah brief approve B1",
    "ah plan approve PL1",
    "ah claims verify c1",
    "ah review set R1 --status declined --response no",
    "ah rule accept PRM-abc",
    "ah rule reject PRM-abc",
    "ah rubric admit RUB-GENERAL --labels l.yaml --yes",
    "ah disclosure approve",
    "ah provenance set method_index.p001 --type human",
    "ah provenance fill --type human --by me",
    "ah provenance record --files a.tex --type human",
    "ah provenance record --files a.tex --type mixed",
    "ah migrate . --apply --force",
    "ah finding waive abcd1234 --reason ok --yes",
]

# What an agent is meant to be able to do, including everything that asks the author instead of deciding.
AGENT_ALLOWED = [
    "ah check", "ah audit", "ah done", "ah facts list", "ah units sync", "ah state",
    "ah finding list", "ah finding show abcd1234", "ah finding decide abcd1234 --reason 'is this figure right?'",
    "ah propose --id x --value 1", "ah proposals list", "ah rule propose --comment c", "ah rule list", "ah rubric run RUB-GENERAL",
    "ah rubric admit RUB-GENERAL --labels l.yaml", "ah provenance list", "ah provenance show", "ah provenance record --files a.tex --type agent",
    "ah disclosure draft", "ah migrate . --apply", "ah brief new --data '{}'", "python3 script.py && ah check", "grep expected ah.log",
]

# Wrapping the engine in a terminal answers the confirmation prompt without the author.
PTY_TRICKS = [
    "printf 'yes\\n' | script -qec 'ah some-future-act' /dev/null",
    "unbuffer ah some-future-act",
    "expect -c 'spawn ah some-future-act; send yes\\r'",
    "python3 -c \"import pty; pty.spawn(['ah','some-future-act'])\"",
]


@pytest.mark.parametrize("command", AUTHOR_ACTS)
def test_an_agent_shell_cannot_do_the_authors_acts(project_dir, command):
    out = pre(project_dir, command)
    assert decision(out) == "deny", command
    assert "AH guard" in out["hookSpecificOutput"]["permissionDecisionReason"]


@pytest.mark.parametrize("command", AGENT_ALLOWED)
def test_the_agent_keeps_everything_that_asks_the_author_instead_of_deciding(project_dir, command):
    assert decision(pre(project_dir, command)) == "allow", command


@pytest.mark.parametrize("command", PTY_TRICKS)
def test_a_terminal_cannot_be_allocated_to_answer_the_authors_confirmation(project_dir, command):
    assert decision(pre(project_dir, command)) == "deny", command


def test_every_terminal_confirmed_act_has_a_guard_entry():
    """`isatty()` is the engine's "a person is here" test. A new use of it is a new author act, which needs a guard rule and a row above."""
    uses = sorted(f"{p.name}:{i + 1}" for p in (ENGINE / "ah").glob("*.py") if p.name != "guard.py" for i, line in enumerate(p.read_text().splitlines()) if "isatty()" in line)
    known = {"cli.py": 3, "cli_author.py": 1}      # fill, disclosure approve, finding waive | the shared human() prompt
    counted: dict[str, int] = {}
    for u in uses:
        counted[u.split(":")[0]] = counted.get(u.split(":")[0], 0) + 1
    assert counted == known, f"a terminal-confirmed act was added or removed: {uses}. Update guard.HUMAN_ONLY and AUTHOR_ACTS."


def test_the_hook_settings_cannot_be_rewritten_by_the_agent(project_dir):
    prot = Project(str(project_dir)).protected_globs()
    for rel in (".claude/settings.json", ".claude/settings.local.json"):
        assert guard.is_protected(rel, prot), rel
    out = handle("pre", {"cwd": str(project_dir), "session_id": "t", "tool_name": "Write",
                         "tool_input": {"file_path": str(project_dir / ".claude" / "settings.json"), "content": "{}"}})
    assert decision(out) == "deny"


# ---------------------------------------------------------------- a broken log or engine does not switch the guard off
def test_an_unwritable_debug_log_does_not_abort_the_guard(project_dir, monkeypatch, tmp_path):
    monkeypatch.setenv("AH_LOG", str(tmp_path / "missing-dir" / "ah.log"))
    out = handle("pre", {"cwd": str(project_dir), "session_id": "t", "tool_name": "Write",
                         "tool_input": {"file_path": str(project_dir / "facts" / "facts.yaml"), "content": "x"}})
    assert decision(out) == "deny", "the protected-path rule must run even when the log sink fails"


def run_main(monkeypatch, capsys, event: str, payload: dict) -> dict | None:
    import io
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    assert main(event) == 0
    text = capsys.readouterr().out.strip()
    return json.loads(text) if text else None


@pytest.fixture
def broken_engine(project_dir, monkeypatch):
    (project_dir / "ah.yaml").write_text("project: [unterminated\n  tex: {")      # a typo the author makes by hand
    monkeypatch.setattr("ah.hooks.find_root", lambda start: project_dir)
    return project_dir


@pytest.mark.parametrize("tool,inp", [("Write", {"file_path": "src/sections/01_introduction/index.tex", "content": "x"}),
                                      ("Edit", {"file_path": "facts/facts.yaml", "old_string": "a", "new_string": "b"}),
                                      ("Bash", {"command": "echo x >> facts/facts.yaml"})])
def test_an_engine_error_stops_edits_and_shell_instead_of_letting_them_through(broken_engine, monkeypatch, capsys, tool, inp):
    out = run_main(monkeypatch, capsys, "pre", {"cwd": str(broken_engine), "session_id": "t", "tool_name": tool, "tool_input": inp})
    assert decision(out) == "deny"
    reason = out["hookSpecificOutput"]["permissionDecisionReason"]
    assert "could not be checked" in reason and "AH_NO_ENFORCE" in reason


def test_an_engine_error_still_lets_the_agent_read(broken_engine, monkeypatch, capsys):
    out = run_main(monkeypatch, capsys, "pre", {"cwd": str(broken_engine), "session_id": "t", "tool_name": "Read", "tool_input": {"file_path": "ah.yaml"}})
    assert out is None


def test_an_engine_error_in_the_other_hooks_still_fails_open(broken_engine, monkeypatch, capsys):
    for event in ("userprompt", "post", "stop"):
        assert run_main(monkeypatch, capsys, event, {"cwd": str(broken_engine), "session_id": "t", "tool_name": "Write", "tool_input": {}}) is None


def test_the_escape_hatch_still_works(broken_engine, monkeypatch, capsys):
    monkeypatch.setenv("AH_NO_ENFORCE", "1")
    out = run_main(monkeypatch, capsys, "pre", {"cwd": str(broken_engine), "session_id": "t", "tool_name": "Write", "tool_input": {"file_path": "x.tex", "content": "x"}})
    assert out is None


# ---------------------------------------------------------------- reading a protected file is not writing it
READS = [
    "cat facts/facts.yaml 2>&1 | head -40",
    "cat facts/facts.yaml 2>/dev/null",
    "ls facts/ 2>&1; cat facts/facts.yaml 2>&1 | head -40; ah facts --help 2>&1 | head -20",
    "grep -n smith2020 sources/registry.yaml > /tmp/found.txt",
    "cat ah.yaml >out.txt",
    "diff facts/facts.yaml facts/facts.yaml.bak 2>&1",
    "ah check > report.txt 2>&1",
    "python3 -c \"print(open('facts/facts.yaml').read())\"",
    "python3 gen.py > out.log; cat facts/facts.yaml",
]
WRITES = [
    "echo x > facts/facts.yaml",
    "echo x >> ah.yaml",
    "echo x 1> ah.yaml",
    "cat notes.txt >>facts/facts.yaml",
    "echo x |tee ah.yaml",
    "sed -i s/a/b/ facts/facts.yaml",
    "cp /tmp/x facts/facts.yaml",
    "rm sources/registry.yaml",
    "python3 -c \"open('facts/facts.yaml','w').write('x')\"",
    "git checkout -- facts/facts.yaml",
    "echo x &> ah.yaml",
    "echo x >| ah.yaml",
    "bash -c 'echo x > ah.yaml'",
    "F=facts/facts.yaml; sed -i s/a/b/ $F",          # indirection: the whole command is judged, not each segment
    "python3 -c \"import shutil; shutil.copy('a','facts/facts.yaml')\"",
]


@pytest.mark.parametrize("command", READS)
def test_reading_a_protected_file_is_allowed_even_with_redirects(project_dir, command):
    assert decision(pre(project_dir, command)) == "allow", command


@pytest.mark.parametrize("command", WRITES)
def test_writing_a_protected_file_is_still_denied(project_dir, command):
    assert decision(pre(project_dir, command)) == "deny", command
