"""The Claude Code verifier adapter accepts one finished, tool-free turn from exactly the requested model."""
from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

from ah.verifier import claude as adapter
from ah.verifier.backends import CommandBackend

MODEL = "claude-haiku-5-5"
ENGINE = str(Path(adapter.__file__).resolve().parents[2])


def result(**kw) -> str:
    d = {"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "stop_reason": "end_turn",
         "terminal_reason": "completed", "permission_denials": [], "result": '{"answer":"no","quote":"","note":""}',
         "usage": {"input_tokens": 2, "output_tokens": 22, "cache_creation_input_tokens": 708, "cache_read_input_tokens": 5},
         "total_cost_usd": 0.0001528, "modelUsage": {MODEL: {"canonicalModel": MODEL}}}
    d.update(kw)
    return json.dumps(d)


def test_a_finished_single_turn_answer_is_accepted_with_all_prompt_tokens_counted():
    text, usage = adapter.parse_result(result(), MODEL)
    assert json.loads(text)["answer"] == "no"
    assert usage == {"input": 715, "output": 22, "cache_read": 5, "cache_write": 708, "cost_usd": 0.0001528}


def test_missing_usage_is_unknown_not_zero():
    d = json.loads(result())
    del d["usage"]
    assert adapter.parse_result(json.dumps(d), MODEL)[1] == {}


@pytest.mark.parametrize("override", [
    {"is_error": True}, {"subtype": "error_max_budget_usd"}, {"num_turns": 2}, {"num_turns": None},
    {"permission_denials": [{"tool_name": "Bash"}]}, {"stop_reason": "max_tokens"}, {"terminal_reason": "aborted"},
    {"modelUsage": {"claude-sonnet-5-5": {"canonicalModel": "claude-sonnet-5-5"}}},
    {"modelUsage": {MODEL: {}, "claude-sonnet-5-5": {}}}, {"modelUsage": {}}, {"result": ""}, {"result": 7}, {"type": "assistant"},
])
def test_anything_but_one_finished_tool_free_turn_from_the_requested_model_is_an_error(override):
    with pytest.raises(ValueError):
        adapter.parse_result(result(**override), MODEL)


@pytest.mark.parametrize("stdout", ["", "not json", "[]", "null"])
def test_non_result_output_is_an_error(stdout):
    with pytest.raises(ValueError):
        adapter.parse_result(stdout, MODEL)


def test_an_alias_is_refused_before_any_call(capsys):
    with pytest.raises(SystemExit) as e:
        adapter.main(["--model", "sonnet"])
    assert e.value.code == 2
    assert "alias" in capsys.readouterr().err


def test_the_call_is_isolated_from_tools_hooks_settings_and_session_files():
    cmd = adapter.command(MODEL, 0.25, "low")
    assert cmd[:2] == ["claude", "-p"] and cmd[cmd.index("--model") + 1] == MODEL
    assert cmd[cmd.index("--tools") + 1] == "", "an empty tool list, not the default set"
    for flag in ("--safe-mode", "--no-session-persistence", "--disable-slash-commands"):
        assert flag in cmd
    assert cmd[cmd.index("--output-format") + 1] == "json" and cmd[cmd.index("--max-budget-usd") + 1] == "0.25"
    assert cmd[cmd.index("--effort") + 1] == "low"
    assert "--effort" not in adapter.command(MODEL, 0.25, None)


def fake_claude(tmp_path: Path, stdout: str, code: int = 0, stderr: str = "") -> Path:
    """A `claude` on PATH that records how it was called, so the whole chain runs without a model."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    rec = tmp_path / "call.json"
    script = bin_dir / "claude"
    script.write_text(f"""#!{sys.executable}
import json, os, sys
json.dump({{"argv": sys.argv[1:], "stdin": sys.stdin.read(), "cwd": os.getcwd(), "env": sorted(os.environ)}}, open({str(rec)!r}, "w"))
sys.stderr.write({stderr!r})
print({stdout!r}, end="")
sys.exit({code})
""")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return rec


def backend() -> CommandBackend:
    return CommandBackend([sys.executable, "-m", "ah.verifier.claude", "--model", MODEL], model=MODEL, revision=adapter.ADAPTER_REVISION,
                          response_format="json-v1")


def run_chain(tmp_path, monkeypatch, stdout, code=0, stderr="", prompt="PROMPT TEXT"):
    rec = fake_claude(tmp_path, stdout, code, stderr)
    monkeypatch.setenv("PATH", f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("PYTHONPATH", ENGINE)
    for name in adapter.ENV_DROP:
        monkeypatch.setenv(name, "parent")
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    return backend().complete(prompt), rec


def test_the_whole_chain_returns_text_and_usage_and_passes_the_prompt_on_stdin(tmp_path, monkeypatch):
    comp, rec = run_chain(tmp_path, monkeypatch, result())
    assert comp.error is None and json.loads(comp.text)["answer"] == "no"
    assert comp.usage["input"] == 715 and comp.usage["output"] == 22
    seen = json.loads(rec.read_text())
    assert seen["stdin"] == "PROMPT TEXT" and "--safe-mode" in seen["argv"]
    assert not set(adapter.ENV_DROP) & set(seen["env"]), "a nested call must not believe it is the parent session or use its socket"
    assert "CLAUDE_CODE_USE_BEDROCK" in seen["env"], "provider settings are kept"
    assert "ah-claude-verifier-" in seen["cwd"], "an empty scratch directory, not the project"


def test_a_failing_claude_is_an_error_not_a_verdict(tmp_path, monkeypatch):
    comp, _ = run_chain(tmp_path, monkeypatch, "", code=1, stderr="rate limited")
    assert comp.error and "claude exited 1" in comp.error and "rate limited" in comp.error


def test_a_wrong_model_in_the_reply_is_an_error(tmp_path, monkeypatch):
    comp, _ = run_chain(tmp_path, monkeypatch, result(modelUsage={"claude-sonnet-5-5": {"canonicalModel": "claude-sonnet-5-5"}}))
    assert comp.error and "alias" in comp.error


def test_the_identity_changes_with_the_model_and_the_effort_but_not_between_processes():
    a = backend()
    b = CommandBackend([sys.executable, "-m", "ah.verifier.claude", "--model", "claude-sonnet-5-5"], model="claude-sonnet-5-5",
                       revision=adapter.ADAPTER_REVISION, response_format="json-v1")
    c = CommandBackend([sys.executable, "-m", "ah.verifier.claude", "--model", MODEL, "--effort", "low"], model=MODEL,
                       revision=adapter.ADAPTER_REVISION, response_format="json-v1")
    assert a.identity == backend().identity
    assert len({a.identity, b.identity, c.identity}) == 3
