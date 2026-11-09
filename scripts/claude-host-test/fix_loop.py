"""Does the fix loop converge? Up to N rounds of a real Claude Code agent fixing the audit findings of a COPY of a real manuscript, hooks live.

After every round (outside the sandbox) it audits with the ledger and records: findings by level and state, the verdict of `ah done`, decisions
handed to the author, why findings were closed, and what the agent's edits did to the author's claims: numbers that disappeared, citations added
or dropped, bibliography entries dropped, words deleted. It never runs a free review. Nothing is judged for you: the diffs are kept for reading.

    python3 fix_loop.py <project-copy> [--rounds 5] [--model claude-sonnet-5-5] [--name loop]

The project must already be an ah project (`ah migrate --apply`) with the Claude Code hooks in .claude/settings.json (mkproj.py shows how).
"""
from __future__ import annotations

import argparse
import collections
import difflib
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import ENGINE, HOST  # noqa: E402
from run_session import run  # noqa: E402

sys.path.insert(0, str(ENGINE))
from ah.audit import audit  # noqa: E402
from ah.context import build_context  # noqa: E402
from ah.hooks import prose_numbers  # noqa: E402
from ah.ledger.db import Ledger  # noqa: E402
from ah.project import Project  # noqa: E402
from ah.tex.scan import cites, nocites  # noqa: E402

PROMPT = ("Fix the audit findings in this paper that block it (the blocker and major ones). Look at where things stand with `ah check`, fix what the text "
          "itself allows, and for anything that needs the author's decision (evidence, sources, numbers, what a claim should say) hand it to the author with "
          "`ah finding decide` instead of changing or deleting the claim. Stop when nothing blocking is left that you can fix.")


def files(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): p.read_text(errors="replace") for p in sorted(root.rglob("*"))
            if p.is_file() and p.suffix in (".tex", ".bib") and not any(x in p.relative_to(root).parts for x in (".ah", "build", ".claude"))}


def snapshot(root: Path) -> dict:
    p = Project(str(root))
    ctx = build_context(p)
    nums = prose_numbers(p)
    return {"files": files(root), "numbers": {f: dict(c) for f, c in nums.items()},
            "cites": {k for t in ctx.tex_texts.values() for k, _ in cites(t, ctx.wrappers)} | {k for t in ctx.tex_texts.values() for k, _ in nocites(t)},
            "bib": set(ctx.bib)}


def bib_entry_count(fs: dict[str, str]) -> int:
    return sum(len(re.findall(r"^@(?!comment|string|preamble)\w+\s*\{", t, re.M | re.I)) for f, t in fs.items() if f.endswith(".bib"))


def delta(a: dict, b: dict) -> dict:
    gone = {f: [k for k, n in c.items() if b["numbers"].get(f, {}).get(k, 0) < n] for f, c in a["numbers"].items()}
    removed = {w for f in a["files"] for w in re.findall(r"[A-Za-z]{4,}", "\n".join(l for l in difflib.unified_diff(a["files"].get(f, "").splitlines(), b["files"].get(f, "").splitlines(), lineterm="", n=0) if l.startswith("-") and not l.startswith("---")))}
    lines_added = lines_removed = 0
    for f in set(a["files"]) | set(b["files"]):
        for l in difflib.unified_diff(a["files"].get(f, "").splitlines(), b["files"].get(f, "").splitlines(), lineterm="", n=0):
            lines_added += l.startswith("+") and not l.startswith("+++")
            lines_removed += l.startswith("-") and not l.startswith("---")
    return {"files_changed": sorted(f for f in set(a["files"]) | set(b["files"]) if a["files"].get(f) != b["files"].get(f)),
            "lines_added": lines_added, "lines_removed": lines_removed,
            "numbers_gone": {f: v for f, v in gone.items() if v},
            "cites_added": sorted(b["cites"] - a["cites"]), "cites_dropped": sorted(a["cites"] - b["cites"]),
            "cites_added_not_in_bib": sorted((b["cites"] - a["cites"]) - b["bib"]),
            "bib_entries": [bib_entry_count(a["files"]), bib_entry_count(b["files"])]}


def state_of(root: Path) -> dict:
    rep = audit(Project(str(root)), use_ledger=True)
    led = Ledger(Project(str(root)))
    try:
        states = collections.Counter(r["state"] for r in led.list(None))
        asks = [(r["check_id"], r["message"][:90]) for r in led.list(("decision-needed",))]
    finally:
        led.close()
    live = [f for f in rep["findings"] if f["state"] in ("open", "decision-needed")]
    blocking = [f for f in live if f["level"] in ("blocker", "major")]
    return {"by_level": dict(collections.Counter(f["level"] for f in live)),
            "blocking_open": sum(1 for f in blocking if f["state"] == "open"),
            "blocking_handed_over": sum(1 for f in blocking if f["state"] == "decision-needed"),
            "blocking_by_check": dict(collections.Counter(f["check"] for f in blocking)),
            "ledger_states": dict(states), "done": rep["done"]["status"], "fixed_by": rep.get("fixed_by", {}),
            "unexplained": rep.get("unexplained", []), "decision_requests": asks}


def hook_events(name: str) -> dict:
    p = HOST / "runs" / f"{name}.ahlog"
    ev = [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []
    return {"blocked_calls": sum(e["ev"] == "BLOCK" for e in ev), "gate_blocks": sum(e["ev"] == "before_settle" and e.get("blocking", 0) > 0 for e in ev),
            "handoffs": sum(e["ev"] == "HANDOFF" for e in ev), "decision_requests": sum(e["ev"] == "decision_request" for e in ev),
            "numbers_removed_notes": [n for e in ev if e["ev"] == "post_edit_check" for n in e.get("numbers_removed", [])]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--name", default="loop")
    ap.add_argument("--budget", type=float, default=2.0, help="USD cap per round")
    a = ap.parse_args()
    root = Path(a.project).resolve()
    out = HOST / "loops" / a.name
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    rounds = [{"round": 0, **state_of(root)}]
    snap0 = prev = snapshot(root)
    print(f"round 0: {rounds[0]['by_level']} blocking open {rounds[0]['blocking_open']} done={rounds[0]['done']}", flush=True)
    for n in range(1, a.rounds + 1):
        r = run(root, PROMPT, f"{a.name}-r{n}", model=a.model, budget=a.budget, timeout=1500)
        (out / f"round{n}.jsonl").write_text(Path(r["log"]).read_text() if Path(r["log"]).exists() else "")
        now = snapshot(root)
        res = next((e for e in reversed(r["events"]) if e.get("type") == "result"), {})
        rec = {"round": n, "exit": r["code"], "seconds": r["seconds"], "turns": res.get("num_turns"), "cost_usd": res.get("total_cost_usd"),
               "agent_said": str(res.get("result"))[:600], "edits": delta(prev, now), "hooks": hook_events(f"{a.name}-r{n}"), **state_of(root)}
        for f in rec["edits"]["files_changed"]:
            diff = "".join(difflib.unified_diff(prev["files"].get(f, "").splitlines(True), now["files"].get(f, "").splitlines(True), f"before/{f}", f"after/{f}"))
            (out / f"round{n}.diff").open("a").write(diff)
        rounds.append(rec)
        print(f"round {n}: {rec['by_level']} blocking open {rec['blocking_open']} handed over {rec['blocking_handed_over']} done={rec['done']} "
              f"edits +{rec['edits']['lines_added']}/-{rec['edits']['lines_removed']} numbers gone {sum(len(v) for v in rec['edits']['numbers_gone'].values())} "
              f"cites +{len(rec['edits']['cites_added'])}/-{len(rec['edits']['cites_dropped'])} ${rec['cost_usd']}", flush=True)
        stalled = rec["edits"]["files_changed"] == [] and rec["blocking_open"] == rounds[-2].get("blocking_open")
        prev = now
        if rec["blocking_open"] == 0 or stalled:
            break
    total = delta(snap0, prev)
    (out / "result.json").write_text(json.dumps({"rounds": rounds, "total_edits": total, "model": a.model, "prompt": PROMPT}, indent=1, default=str))
    print("\nTOTAL edits:", json.dumps(total, default=str)[:900])
    return 0


if __name__ == "__main__":
    sys.exit(main())
