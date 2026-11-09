"""Opt-in OpenCode V2 command adapter. Reads one prompt on stdin; emits a json-v1 completion envelope.

Use verifier.backend=command, model=<provider/model#variant>, revision=opencode-v1,
response_format=json-v1, cmd=[python3, -m, ah.verifier.opencode, --model, <same model>].
OpenCode handles credentials. No provider fallback, tools, or auto-approval.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ADAPTER_REVISION = "opencode-v1"


def parse_events(stdout: str) -> tuple[str, dict]:
    events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
    if any(e.get("type") in ("tool_use", "error") or e.get("part", {}).get("type") == "tool" for e in events):
        raise ValueError("OpenCode attempted a tool or returned an error")
    finishes = [e["part"] for e in events if e.get("type") == "step_finish"]
    if len(finishes) != 1 or finishes[0].get("reason") != "stop":
        raise ValueError("OpenCode did not finish a single text-only step")
    text = "".join(e.get("part", {}).get("text", "") for e in events if e.get("type") == "text")
    if not text.strip():
        raise ValueError("OpenCode returned no text")
    tokens = finishes[0].get("tokens") or {}
    usage = {}
    if "input" in tokens and "output" in tokens:
        usage = {"input": tokens["input"], "output": tokens["output"],
                 "cache_read": (tokens.get("cache") or {}).get("read", 0)}
    return text, usage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, help="explicit OpenCode provider/model#variant; no fallback")
    parser.add_argument("--timeout", type=int, default=150)
    args = parser.parse_args()
    if "/" not in args.model:
        parser.error("--model must include provider/model")
    result = {"version": 1, "model": args.model, "text": "", "usage": {}}
    prompt = sys.stdin.read()
    try:
        parent = Path("/tmp/opencode")
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="ah-verifier-", dir=parent) as work:
            config = {"$schema": "https://opencode.ai/config.json", "agents": {"ah-verifier": {
                "description": "Tool-disabled paragraph verifier", "mode": "primary", "steps": 1,
                "system": "Answer the supplied verification prompt using only its quoted data. Return only the requested JSON. Do not use tools.",
                "permissions": [{"action": "*", "resource": "*", "effect": "deny"}]}}}
            Path(work, "opencode.json").write_text(json.dumps(config))
            env = dict(os.environ)
            env.pop("OPENCODE_SESSION_ID", None)  # nested CLI must not resolve the parent's project/agent catalog
            env["PWD"] = work
            # Resolve the catalog before creating the session (V2.2.6 run can otherwise select an agent before location discovery).
            ready = subprocess.run(["opencode", "debug", "agents"], cwd=work, text=True, capture_output=True,
                                   timeout=min(args.timeout, 30), env=env)
            agents = json.loads(ready.stdout) if ready.returncode == 0 else []
            verifier = next((a for a in agents if a.get("id") == "ah-verifier"), None)
            if not verifier or verifier.get("steps") != 1 or not any(
                    r == {"action": "*", "resource": "*", "effect": "deny"} for r in verifier.get("permissions", [])):
                raise ValueError("OpenCode did not load the tool-disabled verifier agent")
            proc = subprocess.run(["opencode", "run", "--model", args.model, "--agent", "ah-verifier",
                                   "--format", "json", "--archived", prompt], cwd=work, text=True,
                                  capture_output=True, timeout=args.timeout, env=env)
            if proc.returncode:
                raise ValueError(f"OpenCode exited {proc.returncode}: {proc.stderr[-300:] or proc.stdout[-300:]}")
            result["text"], result["usage"] = parse_events(proc.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        result["error"] = str(e)[:400]
    print(json.dumps(result))


if __name__ == "__main__":
    main()
