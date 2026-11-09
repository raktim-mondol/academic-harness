"""Opt-in Claude Code command adapter: one tool-free, single-turn `claude -p` call per prompt.

Use verifier.backend=command, model=<full model id, for example claude-haiku-5-5>, revision=claude-v1,
response_format=json-v1, cmd=[python3, -m, ah.verifier.claude, --model, <same model>].

Claude Code keeps the credentials. The call runs in safe mode in an empty directory, with no tools, no MCP servers, no
hooks, no CLAUDE.md, no slash commands and no session file, so the model sees the prompt and nothing else. Claude Code
does not expose a temperature, so a re-run can answer differently: this route is repeatable through the verdict cache,
not through the model. An alias such as `sonnet` is refused, because the answer would change when the alias moves.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

ADAPTER_REVISION = "claude-v1"
SYSTEM_PROMPT = ("Answer the supplied verification prompt using only its quoted data. "
                 "Return only the JSON the prompt asks for. Do not use tools.")
# The parent session's identity and UI channel. A nested call must not believe it is that session or talk to its socket;
# credentials and provider settings (CLAUDE_CODE_USE_*, API keys, OAuth tokens) are deliberately kept.
ENV_DROP = ("CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_BRIDGE_SESSION_ID")


def parse_result(stdout: str, model: str) -> tuple[str, dict]:
    """The text and token usage of a `claude -p --output-format json` result, or ValueError.

    Accepts only a finished, single-turn, tool-free answer from exactly `model`; anything else is an error and is
    never cached as a verdict."""
    try:
        d = json.loads(stdout)
    except ValueError as e:
        raise ValueError(f"Claude Code did not return JSON: {e}") from None
    if not isinstance(d, dict) or d.get("type") != "result":
        raise ValueError("Claude Code did not return a result object")
    if d.get("is_error") or d.get("subtype") != "success":
        raise ValueError(f"Claude Code reported {d.get('subtype') or 'an error'}: {str(d.get('result') or d.get('api_error_status') or '')[:200]}")
    if d.get("num_turns") != 1:
        raise ValueError(f"expected one turn, Claude Code took {d.get('num_turns')}")
    if d.get("permission_denials"):
        raise ValueError("Claude Code attempted a tool call")
    if d.get("stop_reason") not in (None, "end_turn") or d.get("terminal_reason") not in (None, "completed"):
        raise ValueError(f"Claude Code did not finish normally ({d.get('stop_reason')}/{d.get('terminal_reason')})")
    used = d.get("modelUsage")
    if not isinstance(used, dict) or len(used) != 1:
        raise ValueError("Claude Code did not report exactly one model")
    (name, row), = used.items()
    canonical = row.get("canonicalModel", name) if isinstance(row, dict) else name
    if model not in (name, canonical):
        raise ValueError(f"requested {model}, Claude Code answered with {canonical}: pass the full model id, not an alias")
    text = d.get("result")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Claude Code returned no text")
    u = d.get("usage") or {}
    usage: dict = {}
    if isinstance(u, dict) and isinstance(u.get("input_tokens"), int) and isinstance(u.get("output_tokens"), int):
        cache_read, cache_write = int(u.get("cache_read_input_tokens") or 0), int(u.get("cache_creation_input_tokens") or 0)
        usage = {"input": u["input_tokens"] + cache_read + cache_write, "output": u["output_tokens"],
                 "cache_read": cache_read, "cache_write": cache_write}
        if isinstance(d.get("total_cost_usd"), (int, float)) and d["total_cost_usd"] >= 0:
            usage["cost_usd"] = d["total_cost_usd"]
    return text, usage


def command(model: str, budget: float, effort: str | None) -> list[str]:
    cmd = ["claude", "-p", "--model", model, "--safe-mode", "--tools", "", "--no-session-persistence", "--disable-slash-commands",
           "--output-format", "json", "--system-prompt", SYSTEM_PROMPT, "--max-budget-usd", str(budget)]
    if effort:
        cmd += ["--effort", effort]
    return cmd


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, help="full Claude model id; an alias is refused")
    parser.add_argument("--effort", choices=("low", "medium", "high", "xhigh", "max"), help="reasoning effort; part of the verifier identity, so set it in ah.yaml `variant`")
    parser.add_argument("--timeout", type=int, default=150)
    parser.add_argument("--max-budget-usd", type=float, default=0.25, help="spend cap for one call")
    args = parser.parse_args(argv)
    if not args.model.startswith("claude-"):
        parser.error("--model must be a full model id such as claude-haiku-5-5, not an alias")
    result: dict = {"version": 1, "model": args.model, "text": "", "usage": {}}
    prompt = sys.stdin.read()
    try:
        env = {k: v for k, v in os.environ.items() if k not in ENV_DROP}
        with tempfile.TemporaryDirectory(prefix="ah-claude-verifier-") as work:
            proc = subprocess.run(command(args.model, args.max_budget_usd, args.effort), input=prompt, cwd=work, env=env,
                                  text=True, capture_output=True, timeout=args.timeout)
        if proc.returncode:
            raise ValueError(f"claude exited {proc.returncode}: {(proc.stderr or proc.stdout)[-300:].strip()}")
        result["text"], result["usage"] = parse_result(proc.stdout, args.model)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        result["error"] = str(e)[:400]
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
