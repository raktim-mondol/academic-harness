"""Run one headless Claude Code turn inside a bubblewrap sandbox, with the engine's hooks live, and keep the full event stream.

The sandbox makes / read-only and only the project (plus Claude's own state) writable, so a test agent with a shell cannot touch
anything else on this machine. The hooks under test run inside the same sandbox.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import HOME, HOST  # noqa: E402
DROP = ("CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_BRIDGE_SESSION_ID")


def sandbox(project: Path) -> list[str]:
    cmd = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", str(project), str(project),
           "--die-with-parent", "--chdir", str(project)]
    for p in (HOST / "runs", HOME / ".claude", HOME / ".claude.json", HOME / ".cache" / "claude", HOME / ".config" / "claude"):
        if p.exists():
            cmd += ["--bind", str(p), str(p)]
    return cmd


def claude_cmd(model: str, budget: float, persist: bool, resume: str | None, permission: str, allowed: str | None, extra: list[str]) -> list[str]:
    cmd = ["claude", "-p", "--model", model, "--output-format", "stream-json", "--verbose", "--include-hook-events",
           "--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands",
           "--permission-mode", permission, "--max-budget-usd", str(budget)]
    if allowed:
        cmd += ["--allowedTools", allowed]
    if resume:
        cmd += ["--resume", resume]
    elif not persist:
        cmd += ["--no-session-persistence"]
    return cmd + extra


def run(project: Path, prompt: str, name: str, model: str = "claude-haiku-5-5", budget: float = 1.0, persist: bool = False,
        resume: str | None = None, permission: str = "acceptEdits", allowed: str | None = "Bash", timeout: int = 600,
        extra: list[str] | None = None, env_extra: dict | None = None) -> dict:
    runs = HOST / "runs"
    runs.mkdir(exist_ok=True)
    log = runs / f"{name}.jsonl"
    env = {k: v for k, v in os.environ.items() if k not in DROP}
    env["PATH"] = f"{HOST / 'bin'}{os.pathsep}{env.get('PATH', '')}"
    env["AH_LOG"] = str(runs / f"{name}.ahlog")
    env.update(env_extra or {})
    cmd = sandbox(project) + claude_cmd(model, budget, persist, resume, permission, allowed, extra or [])
    start = time.time()
    try:
        p = subprocess.run(cmd, input=prompt, text=True, capture_output=True, timeout=timeout, env=env)
        out, err, code = p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        out, err, code = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or ""), "TIMEOUT", -9
    log.write_text(out)
    events = []
    for line in out.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    return {"name": name, "code": code, "seconds": round(time.time() - start, 1), "stderr": err[-600:], "events": events, "log": str(log)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("prompt")
    ap.add_argument("--name", required=True)
    ap.add_argument("--model", default="claude-haiku-5-5")
    ap.add_argument("--budget", type=float, default=1.0)
    a = ap.parse_args()
    r = run(Path(a.project), a.prompt, a.name, a.model, a.budget)
    print(json.dumps({k: r[k] for k in ("name", "code", "seconds", "stderr", "log")}), len(r["events"]), "events")
