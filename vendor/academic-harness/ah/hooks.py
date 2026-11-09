"""Claude Code hook handlers (design 10): the same guard, post-edit check, gate and context as the Pi extension.

Claude Code runs a command per event and passes JSON on stdin. `ah hook <event>` reads it, applies the rules in `ah.guard`, and prints
the JSON Claude Code expects. State that must survive between calls (baseline, touched files, gate loops) lives in
`.ah/session/<session>.json`, which the guard itself protects from the agent.

  userprompt  records the baseline of findings and injects the paper-state card
  pre         PreToolUse: blocks protected writes, anchor loss, shell writes, author-only commands
  post        PostToolUse: after an edit, re-sync anchors and tell the agent what the edit introduced
  stop        Stop: keeps the agent working while its edits introduced blocking findings (capped), then hands off

Environment: AH_LOG records events as JSON lines (same names as the Pi extension); AH_NO_STATE=1 skips the card; AH_NO_ENFORCE=1 skips pre/post/stop.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

from . import guard as G
from .audit import audit
from .project import Project
from .tex.units import sync_project

EDIT_TOOLS = ("Write", "Edit", "MultiEdit")


def log(ev: str, **kw) -> None:
    path = os.environ.get("AH_LOG")
    if path:
        with open(path, "a") as f:
            f.write(json.dumps({"t": int(time.time() * 1000), "ev": ev, **kw}) + "\n")


def find_root(start: str) -> Path | None:
    d = Path(start).resolve()
    for p in [d, *d.parents]:
        if (p / "ah.yaml").exists():
            return p
    return None


def _state_path(project: Project, sid: str) -> Path:
    return project.state_dir / "session" / f"{sid or 'default'}.json"


def load_state(project: Project, sid: str) -> dict:
    f = _state_path(project, sid)
    return json.loads(f.read_text()) if f.exists() else {"baseline": [], "touched": [], "loops": 0, "last_state": ""}


def save_state(project: Project, sid: str, st: dict) -> None:
    f = _state_path(project, sid)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(st))


def current_findings(project: Project, judge_files: list[str] | None = None) -> list[dict]:
    """What the checks report now, for the baseline, the post-edit note and the stop gate.

    Beyond the default tiers it reads the external results when the project has them (tier TX) and the rubric from cached
    verdicts (tier TR, so only an ADMITTED criterion can show a finding above info). With `gate.judge_touched` and a verifier
    configured, `judge_files` (the files this turn changed) are also judged against the admitted criteria, so cost is bounded
    by what the agent touched. EXT-00 (an external result went stale) is left to `ah done`: an edit always makes the stored
    result stale, and the agent cannot run the external tools from here."""
    from .checks.base import DEFAULT_TIERS
    from .done import external_results
    from .rubric import admitted_ids, load_criteria
    tiers = DEFAULT_TIERS + (("TR",) if any(load_criteria(project)) else ())
    kw: dict = {}
    if judge_files and "TR" in tiers and project.cfg["gate"].get("judge_touched"):
        from .verifier.backends import get_backend
        backend, admitted = get_backend(project.cfg), admitted_ids(project)
        if backend is not None and admitted:
            kw = {"rubric_backend": backend, "rubric_criteria": admitted, "only_files": judge_files}
    rep = audit(project, tiers, use_ledger=False, external=True if external_results(project) else None, **kw)
    rep["findings"] = [f for f in rep["findings"] if f["check"] != "EXT-00"]
    return [{"fp": f["fingerprint"], "check": f["check"], "level": f["level"], "unit": f["unit"], "file": f["file"], "line": f["line"],
             "state": f["state"], "message": f["message"]} for f in rep["findings"] if f["state"] in ("open", "decision-needed")]


def prose_hashes(project: Project) -> dict[str, str]:
    """Hash of every prose file, keyed by project-relative path. Lets the gate see changes made by any tool, including shell redirects."""
    out = {}
    for p in project.prose_files():
        try:
            out[p.resolve().relative_to(project.root).as_posix()] = hashlib.sha1(p.read_bytes()).hexdigest()
        except (OSError, ValueError):
            pass
    return out


def changed_prose(project: Project, st: dict) -> list[str]:
    now = prose_hashes(project)
    return sorted(rel for rel, h in now.items() if st.get("hashes", {}).get(rel) != h)


def _is_prose(project: Project, rel: str) -> bool:
    return rel.endswith(".tex") and not G.is_protected(rel, project.protected_globs())


def unit_hashes(project: Project) -> dict[str, str]:
    from .context import unit_ref
    from .tex.units import load_units
    return {unit_ref(u): u.hash for u in load_units(project)[0]}


def _is_enumerator(n) -> bool:
    """A list marker such as "(3)" in "(1) detect, (2) classify, (3) report" is not a claim, so rewording it is not a lost number."""
    import re
    return not n.pct and n.value == int(n.value) and 0 < n.value <= 20 and bool(re.search(r"(?<![\w.])\(\s*%s\s*\)" % re.escape(n.text), n.ctx or ""))


def prose_numbers(project: Project) -> dict[str, dict[str, int]]:
    """The numbers written in each prose file (literal, cited or bound; not years, labels, dates or 0-2), counted by token.
    Lets the post-edit check see an edit that made a number disappear."""
    from collections import Counter
    from .context import unit_ref
    from .tex.inventory import inventory
    from .tex.units import load_units
    out: dict[str, Counter] = {}
    for i in inventory(load_units(project)[0]):
        for n in i.nums:
            if n.cls in ("literal", "cited", "bound") and not _is_enumerator(n):
                out.setdefault(i.unit.file, Counter())[f"{n.text}{'%' if n.pct else ''}"] += 1
    return {f: dict(c) for f, c in out.items()}


def removed_numbers(before: dict[str, int], after: dict[str, int]) -> list[str]:
    return sorted(k for k, c in before.items() if after.get(k, 0) < c)


def resolve_touched(project: Project, touched: list[str]) -> list[str]:
    """TeX-root-relative paths for prose the adapter marked as touched (project-relative or TeX-relative)."""
    out: list[str] = []
    for t in touched:
        t = (t or "").strip()
        if not t:
            continue
        for cand in (project.root / t, project.tex_root / t):
            if cand.is_file():
                out.append(project.rel(cand))
                break
    return list(dict.fromkeys(out))


def verify_touched(project: Project, touched: list[str], backend=None, before: dict | None = None) -> dict:
    """Advisory T3 over the units an agent changed, with every claim kind (default T3 skips plain descriptive claims, which are the ones an agent
    gets wrong when it misreads a source). Never gates: the verifier flags most clauses, so its output is for a person to read."""
    from .verifier.backends import get_backend
    only = resolve_touched(project, touched)
    if not only:
        return {"checked": 0, "verdicts": {}, "flags": [], "skipped": "no touched prose files"}
    backend = backend or get_backend(project.cfg)
    if backend is None:
        return {"skipped": "no verifier configured"}
    cfg = project.cfg.setdefault("verifier", {})
    cfg["kinds"] = ["numeric-cited", "comparative", "causal", "attributive", "other"]
    now = unit_hashes(project)
    units = sorted(u for u, h in now.items() if before is None or before.get(u) != h)      # only paragraphs whose text changed or are new
    rep = audit(project, ("T3",), use_ledger=False, backend=backend, only_files=only, only_units=units if before is not None else None)
    flags = [f["message"][:260] for f in rep["findings"] if f["check"] == "EVD-01" and f["file"] in only and (before is None or f["unit"] in units)]
    return {"checked": rep.get("evidence", {}).get("verified", 0), "verdicts": rep.get("evidence", {}).get("verdicts", {}), "flags": flags}


def card(project: Project) -> str:
    """The paper-state card, worded for an agent that runs `ah` commands through its shell instead of Pi tools."""
    from .state import build_state
    text = build_state(project)
    return (text.replace("ah_fact tool", "`ah facts list`").replace("ah_decision_request", "`ah finding decide <id> --reason \"<question>\"`")
            + "\nHarness commands run in your shell as `ah ...` (for example `ah check`, `ah facts list`, `ah pack <brief>`, `ah claims bind`, `ah review ...`). "
              "Finding ids are the 8 characters printed first on each finding.\n")


def handle(event: str, data: dict) -> dict | None:
    data = dict(data, cwd=os.path.abspath(data.get("cwd") or os.getcwd()))
    root = find_root(data["cwd"])
    if root is None:
        return None                                   # not an Academic Harness project: do nothing
    project = Project(root)
    sid = data.get("session_id", "")
    no_enforce = os.environ.get("AH_NO_ENFORCE") == "1"

    if event == "userprompt":
        st = load_state(project, sid)
        if st.get("touched") and not st.get("settled", True):
            # The host entered this turn again (a question was answered, a message was queued). The edits already made
            # are still this turn's: keep the baseline and the touched list, or the blockers they introduced become
            # "already there" and the stop gate says nothing. Found live on DSH.
            log("baseline_kept", touched=st["touched"])
        else:
            st.update(loops=0, touched=[], settled=False)
            st["baseline"] = [f["fp"] for f in current_findings(project)]
            st["hashes"], st["reported"] = prose_hashes(project), []
            st["unit_hashes"] = unit_hashes(project) if project.cfg["gate"].get("verify_touched") else {}
            try:
                st["nums"] = prose_numbers(project)
            except Exception:
                st["nums"] = {}
            log("baseline", findings=len(st["baseline"]))
        out = None
        if os.environ.get("AH_NO_STATE") != "1":
            text = card(project)
            h = hashlib.sha1(text.encode()).hexdigest()
            if h != st.get("last_state"):
                st["last_state"] = h
                log("state_injected", chars=len(text))
                out = {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}}
        save_state(project, sid, st)
        return out

    if event == "pre":
        tool, inp = data.get("tool_name", ""), data.get("tool_input") or {}
        log("tool", name=tool, **({"cmd": str(inp.get("command", ""))[:300]} if tool == "Bash" else {}))
        if no_enforce:
            return None
        cwd = data.get("cwd") or str(root)
        prot = project.protected_globs()

        def deny(reason: str, **kw):
            log("BLOCK", tool=tool, **kw)
            return {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}

        if tool in EDIT_TOOLS:
            rel = G.rel_to_root(str(root), cwd, str(inp.get("file_path", "")))
            if rel is None:
                return None
            hit = G.is_protected(rel, prot)
            if hit:
                return deny(f"AH guard: {rel} is protected ({hit}): evidence, state, or the definition of facts and rules. Do not work around this. "
                            f"If it is wrong, record a question for the author with `ah finding decide <id> --reason \"...\"`.", why="protected", path=rel, glob=hit)
            if _is_prose(project, rel):
                lost: list[str] = []
                if tool == "Edit":
                    lost = G.anchors_lost(inp.get("old_string", ""), inp.get("new_string", ""))
                elif tool == "MultiEdit":
                    for e in inp.get("edits", []):
                        lost += G.anchors_lost(e.get("old_string", ""), e.get("new_string", ""))
                else:
                    p = root / rel
                    if p.exists():
                        lost = G.anchors_lost(p.read_text(errors="replace"), str(inp.get("content", "")))
                if lost:
                    return deny(f"AH guard: this {tool} would drop the unit anchor(s) {', '.join(lost)} while keeping text. Keep every \"%% @unit ...\" line with its "
                                f"paragraph (delete an anchor only together with the whole paragraph, using Edit). New paragraphs need no anchor; the harness adds it.",
                                why="anchor", path=rel, anchors=lost)
            return None
        if tool == "Bash":
            cmd = str(inp.get("command", ""))
            if "finding decide" in cmd:
                log("decision_request", cmd=cmd[:120])
            human = G.bash_is_human_only(cmd)
            if human:
                return deny(f"AH guard: only the author can do this ({human}). Ask with `ah finding decide <id> --reason \"...\"`.", why="human-only", cmd=cmd[:120])
            hit = G.bash_writes_protected(cmd, prot, str(root), cwd)
            if hit:
                return deny(f"AH guard: this command would write the protected path {hit}. Do not work around this; ask the author with `ah finding decide`.",
                            why="protected-bash", path=hit, cmd=cmd[:120])
        return None

    if event == "post":
        tool, inp = data.get("tool_name", ""), data.get("tool_input") or {}
        if no_enforce or (tool not in EDIT_TOOLS and tool != "Bash"):
            return None
        st = load_state(project, sid)
        if tool == "Bash":                            # a shell command can write prose (redirects, sed -i): compare with the prompt-start hashes
            changed = [r for r in changed_prose(project, st) if r not in st["touched"]]
            if not changed:
                return None
            st["touched"] += changed
            rel = ", ".join(changed)
        else:
            rel = G.rel_to_root(str(root), data.get("cwd") or str(root), str(inp.get("file_path", "")))
            if rel is None or not _is_prose(project, rel):
                return None
            if rel not in st["touched"]:
                st["touched"].append(rel)
        sync_project(project)
        try:
            from .provenance import record_files
            paths = changed if tool == "Bash" else [rel]
            record_files(project, [x for x in paths if x],
                         author_type=os.environ.get("AH_AUTHOR_TYPE") or "agent",
                         model=os.environ.get("AH_MODEL") or os.environ.get("CLAUDE_MODEL") or os.environ.get("PI_MODEL"),
                         brief_id=os.environ.get("AH_BRIEF"), by="agent")
        except Exception:
            pass
        fs = current_findings(project)
        fresh = G.new_findings(set(st["baseline"]), fs)
        # The format rules (ACR-*, FMT-*) are advisory until the author promotes one: they are in the audit, not in an agent's
        # turn, where a low-precision hint ("define this acronym") would only make it rewrite text that was fine.
        fresh = [f for f in fresh if not (f["level"] == "info" and f["check"].startswith(("ACR-", "FMT-", "RUB-")))]
        gone = []
        try:
            after = prose_numbers(project)
            for f in (changed if tool == "Bash" else [rel]):
                try:
                    key = project.rel(project.root / f)              # the name the inventory uses for the same file
                except Exception:
                    key = f
                gone += [f"{k} ({f})" for k in removed_numbers(st.get("nums", {}).get(key, {}), after.get(key, {}))]
                st.setdefault("nums", {})[key] = after.get(key, {})      # each removal is reported once
        except Exception:
            pass
        log("post_edit_check", path=rel, via=tool, total=len(fs), new=[f"{f['check']}:{f['level']}" for f in fresh], numbers_removed=gone)
        save_state(project, sid, st)
        parts = []
        if fresh:
            parts.append(f"[AH] This edit introduced {len(fresh)} finding(s) (checked by code, not opinion):\n{G.format_findings(fresh)}\n"
                         "Fix them in the text. Numbers from data are written \\fact{id}; `ah facts list` shows ids. You cannot waive findings.")
        if gone:
            parts.append("[AH] This edit made number(s) disappear from the text: " + ", ".join(gone[:8]) + ". A number is a claim. "
                         "A finding about a number is cleared by binding it to a \\fact{id} or citing its source, not by rewording it away. "
                         "If the figure was right, put it back; if it was wrong or unsupported, say so to the author instead of editing it out silently.")
        if not parts:
            return None
        return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "\n\n".join(parts)}}

    if event == "stop":
        st = load_state(project, sid)
        if no_enforce:
            return None
        st["touched"] = sorted(set(st["touched"]) | set(changed_prose(project, st)))      # also files changed through the shell
        if not st["touched"]:
            return None
        sync_project(project)
        levels = project.cfg["gate"]["blocking_levels"]
        blocking = G.new_findings(set(st["baseline"]), current_findings(project, resolve_touched(project, st["touched"])), levels)
        log("before_settle", loops=st["loops"], blocking=len(blocking), touched=st["touched"])
        if not blocking:
            st["settled"] = True
            save_state(project, sid, st)
            if project.cfg["gate"].get("verify_touched") and not st.get("t3_done"):
                st["t3_done"] = True
                save_state(project, sid, st)
                try:
                    t3 = verify_touched(project, st["touched"], before=st.get("unit_hashes") or None)
                except Exception as e:                      # advisory only: never break the session
                    t3 = {"skipped": repr(e)[:160]}
                log("t3_touched", **t3)
                if t3.get("flags"):
                    return {"systemMessage": "AH evidence check (advisory, a model read the cited sources): " + str(len(t3["flags"])) + " clause(s) in the text this session changed are not confirmed by their cited sources:\n- "
                                             + "\n- ".join(t3["flags"][:6]) + "\nRead them against the sources before you rely on them."}
            return None
        mx = int(project.cfg["gate"].get("max_loops", 3))
        if st["loops"] >= mx:
            log("HANDOFF", loops=st["loops"], blocking=len(blocking))
            st["settled"] = True
            save_state(project, sid, st)
            return {"systemMessage": f"AH gate: stopped after {st['loops']} attempts with {len(blocking)} blocking finding(s) the agent's edits introduced:\n"
                                     f"{G.format_findings(blocking)}\nThe author decides what to do next."}
        st["loops"] += 1
        save_state(project, sid, st)
        return {"decision": "block", "reason": f"AH gate (attempt {st['loops']}/{mx}): your edits introduced blocking findings.\n{G.format_findings(blocking)}\n"
                                               "Fix them in the text. If the author's instruction forces this, do not override it: run "
                                               "`ah finding decide <id> --reason \"<question>\"` with the finding's id and stop."}
    return None


def hooks_config(cmd: str) -> dict:
    """The `hooks` block for Claude Code settings, given how to run the engine (for example "uv run --project /path ah")."""
    def h(event: str):
        return {"type": "command", "command": f"{cmd} hook {event}", "timeout": 120}
    return {"hooks": {
        "UserPromptSubmit": [{"hooks": [h("userprompt")]}],
        "PreToolUse": [{"matcher": "*", "hooks": [h("pre")]}],
        "PostToolUse": [{"matcher": "Write|Edit|MultiEdit|Bash", "hooks": [h("post")]}],
        "Stop": [{"hooks": [h("stop")]}],
    }}


def main(event: str) -> int:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    try:
        out = handle(event, data)
    except Exception as e:                        # a hook must not break the agent's session: report on stderr and allow
        print(f"ah hook {event}: {e!r}", file=sys.stderr)
        log("hook_error", event=event, error=repr(e)[:200])
        return 0
    if out:
        print(json.dumps(out))
    return 0
