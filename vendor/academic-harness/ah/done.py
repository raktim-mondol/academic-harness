"""One answer to "is this document done": pass, fail, or incomplete (writing-compiler phase 6).

The checks run in tiers, each with its own report. A person (or an agent) deciding whether to stop should not have to
read five of them, and should not be able to read "no blockers" off a run that never looked at the external tools or
asked the rubric anything. `done_status` folds the report into components, each ok, fail or not-checked:

  findings     no open finding at a blocking level (blocker, major by default), outside the external tier
  rubric       no open finding from an ADMITTED criterion (at any level), and no admitted criterion left unjudged
  external     no stale, unreadable or missing external-tool result (EXT-00); results that exist but were not read
               by this run are not-checked, not ok
  unexplained  every new finding has a cause (needs the ledger)
  lookups      the registry snapshot (.ah/cache/lookups.json) is younger than `done.lookups_max_age_days`

fail beats incomplete beats pass. incomplete means nothing failed but something that matters was not looked at;
`done.require: [external, rubric, lookups]` in ah.yaml adds components that must have been checked.
It does not mean the science is sound, and it is not a score.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from .project import Project

LOOKUPS_FILE = ".ah/cache/lookups.json"
DEFAULTS = {"require": [], "lookups_max_age_days": 30}


def settings(project: Project) -> dict:
    cfg = project.cfg.get("done") or {}
    out = dict(DEFAULTS, **{k: v for k, v in cfg.items() if k in DEFAULTS})
    out["require"] = [str(x) for x in (out["require"] or [])]
    return out


def external_results(project: Project) -> list[str]:
    d = project.state_dir / "external"
    return sorted(p.name for p in d.glob("*.json")) if d.is_dir() else []


def lookup_snapshot(project: Project, now: datetime | None = None) -> dict:
    """{"present": bool, "entries": n, "oldest": iso|None, "age_days": float|None, "error": str|None}."""
    f = project.root / LOOKUPS_FILE
    if not f.is_file():
        return {"present": False, "entries": 0, "oldest": None, "age_days": None, "error": None}
    try:
        entries = (json.loads(f.read_text()) or {}).get("entries") or {}
        stamps = [datetime.fromisoformat(str(e["fetched_at"]).replace("Z", "+00:00")) for e in entries.values()]
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        return {"present": True, "entries": 0, "oldest": None, "age_days": None, "error": f"unreadable ({e})"}
    if not stamps:
        return {"present": True, "entries": 0, "oldest": None, "age_days": None, "error": None}
    oldest = min(stamps)
    now = now or datetime.now(timezone.utc)
    return {"present": True, "entries": len(stamps), "oldest": oldest.isoformat(), "age_days": round((now - oldest).total_seconds() / 86400, 1), "error": None}


def _c(cid: str, status: str, detail: str, required: bool = False) -> dict:
    return {"id": cid, "status": status, "required": required, "detail": detail}


def done_status(project: Project, rep: dict, now: datetime | None = None) -> dict:
    st = settings(project)
    tiers = set(rep.get("tiers") or [])
    live = [f for f in rep["findings"] if f["state"] in ("open", "decision-needed")]
    levels = set(rep["gate"]["levels"])
    comps: list[dict] = []

    # findings: the existing gate, minus what the external and rubric components report themselves
    blocking = [f for f in live if f["level"] in levels and f["check"] != "EXT-00"]
    if blocking:
        by = {}
        for f in blocking:
            by[f["check"]] = by.get(f["check"], 0) + 1
        comps.append(_c("findings", "fail", f"{len(blocking)} open at {'/'.join(sorted(levels))}: " + ", ".join(f"{k} {v}" for k, v in sorted(by.items()))))
    else:
        comps.append(_c("findings", "ok", f"no open finding at {'/'.join(sorted(levels))} in {', '.join(sorted(tiers - {'TX'})) or 'no tier'}"))

    # rubric
    run = rep.get("rubric_run") or {}
    from .rubric import admitted_ids
    admitted = admitted_ids(project)
    need_rubric = "rubric" in st["require"] or bool(admitted)
    if "TR" in tiers:
        adm = run.get("admitted") or admitted
        bad = [f for f in live if f["check"] == "RUB-01" and f.get("level") != "info" and f["unit"] is not None]
        unjudged = sum((run.get("per_criterion") or {}).get(cid, {}).get("unjudged", 0) for cid in adm)
        if bad:
            comps.append(_c("rubric", "fail", f"{len(bad)} open finding(s) from admitted criteria: " + ", ".join(sorted({f['message'].split(':')[0] for f in bad}))))
        elif unjudged:
            comps.append(_c("rubric", "not-checked", f"{unjudged} paragraph(s) have no verdict from an admitted criterion (run with judge=true)", True))
        else:
            comps.append(_c("rubric", "ok", f"{len(adm)} admitted criteria, no open finding" if adm else "no admitted criterion, so the rubric does not gate"))
    elif need_rubric:
        comps.append(_c("rubric", "not-checked", f"{len(admitted)} admitted criteria exist but this run did not read the rubric (rubric=true)" if admitted
                        else "required, but this run did not read the rubric", True))
    else:
        comps.append(_c("rubric", "ok", "no admitted criterion, so the rubric does not gate"))

    # external
    present = external_results(project)
    required_tools = list((project.cfg.get("external") or {}).get("required") or [])
    if "TX" in tiers:
        stale = [f for f in live if f["check"] == "EXT-00"]
        if stale:
            comps.append(_c("external", "fail", f"{len(stale)} external result(s) stale, unreadable or missing (EXT-00): run ah_external"))
        else:
            comps.append(_c("external", "ok", f"{len(present)} external result file(s) are current for this text"))
    elif present or required_tools or "external" in st["require"]:
        why = "external results exist" if present else "external results are required"
        comps.append(_c("external", "not-checked", f"{why} but this run did not read them (external=use)", True))
    else:
        comps.append(_c("external", "ok", "no external results in use"))

    # unexplained
    if "run" in rep:
        un = rep.get("unexplained") or []
        comps.append(_c("unexplained", "fail", f"{len(un)} new finding(s) with no cause (a harness fault): {', '.join(u[:8] for u in un[:5])}") if un
                     else _c("unexplained", "ok", "every new finding has a cause"))
    else:
        comps.append(_c("unexplained", "ok", "not applicable (no ledger in this run)"))

    # lookups
    snap = lookup_snapshot(project, now)
    maxd = st["lookups_max_age_days"]
    req_l = "lookups" in st["require"]
    if snap["error"]:
        comps.append(_c("lookups", "fail", f"the registry snapshot {snap['error']}"))
    elif not snap["present"] or not snap["entries"]:
        comps.append(_c("lookups", "not-checked", "no registry lookups are recorded (citation audits have not been run)", req_l))
    elif maxd and snap["age_days"] > float(maxd):
        comps.append(_c("lookups", "fail", f"the oldest registry answer is {snap['age_days']} days old (limit {maxd}): refresh_lookups before relying on retraction checks"))
    else:
        comps.append(_c("lookups", "ok", f"{snap['entries']} registry answer(s), oldest {snap['age_days']} days (limit {maxd or 'none'})"))

    failing = [c for c in comps if c["status"] == "fail"]
    missing = [c for c in comps if c["status"] == "not-checked" and c["required"]]
    status = "fail" if failing else ("incomplete" if missing else "pass")
    return {"status": status, "components": comps,
            "failing": [c["id"] for c in failing], "not_checked": [c["id"] for c in comps if c["status"] == "not-checked"],
            "incomplete_because": [c["id"] for c in missing]}


def render(done: dict) -> list[str]:
    lines = [f"done: {done['status'].upper()}"]
    for c in done["components"]:
        mark = {"ok": "ok  ", "fail": "FAIL", "not-checked": "n/c "}[c["status"]]
        lines.append(f"  {mark} {c['id']:11} {c['detail']}")
    return lines
