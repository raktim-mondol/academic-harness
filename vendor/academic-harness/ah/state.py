"""The paper-state card an agent sees at the start of a prompt (design 8.3, docs/ARCHITECTURE.md).

Small, rebuilt from project files every time, so it cannot go stale. This is the substitute
oracle for academic writing: the agent is told the rules, the facts, the outline, the
neighbours of the unit it is writing, and only the findings its own edits introduced.
"""
from __future__ import annotations

from .audit import audit
from .context import build_context
from .project import Project


def build_state(project: Project, max_facts: int = 40, max_keys: int = 40, max_findings: int = 6, unit: str | None = None) -> str:
    ctx = build_context(project)
    cfg = project.cfg
    out = [f"# Paper state: {cfg['project']} (profile {cfg['profile']}, rubric {cfg['rubric']})", ""]
    out += ["Academic writing has no compiler. This card is the oracle. Do not start a new hunt for errors; the ledger already lists what is open. You are held only to findings your own edits introduce.",
            "Rules (checked by code after every edit; you cannot waive a finding):",
            "- A number that comes from data is written as `\\fact{id}` or `\\fact{id.variant}`, never typed. Look it up below or with the ah_fact tool.",
            "- Every paragraph and float starts with an anchor comment `%% @unit ...`. Never delete or edit an anchor line.",
            "- Cite only keys that exist in the bibliography; do not state a finding about a paper you have not read in the sources.",
            "- Do not rewrite units that are not in this task. Unchanged units keep their verdicts.",
            "- Files under the protected paths cannot be written. If one is wrong, record it with ah_decision_request, do not work around it.",
            ""]
    if ctx.facts.facts:
        out.append("Facts (value; variants):")
        for fid, f in list(ctx.facts.facts.items())[:max_facts]:
            dv = f.default_variant()
            alts = ", ".join(f"{v}={d['plain']}" for v, d in sorted(f.variants.items()) if v != dv)[:110]
            out.append(f"- {fid} = {f.variants[dv]['plain']}" + (f"  [{alts}]" if alts else ""))
            for s in f.superseded[:2]:
                if s.get("text") and not s.get("allow_near"):
                    out.append(f"    do not use {s['text']} (superseded; {s.get('note', 'old basis')})")
        if len(ctx.facts.facts) > max_facts:
            out.append(f"- ... {len(ctx.facts.facts) - max_facts} more (ah_fact)")
        out.append("")
    banned = [t for t in ctx.glossary if t.get("banned")]
    if banned:
        out.append("Terms: " + "; ".join(f"use \"{t.get('canonical')}\", not {', '.join(repr(b) for b in t['banned'])}" for t in banned))
        out.append("")
    if cfg.get("scope"):
        out.append("Scope (allowed source tags per file): " + "; ".join(f"{k}: {', '.join(v)}" for k, v in cfg["scope"].items()))
        out.append("")
    if cfg.get("mirrors"):
        bits = []
        for m in cfg["mirrors"][:8]:
            bits.append(f"{m.get('fact')} in {', '.join(m.get('files') or [])}")
        out.append("Mirrors (same fact must appear in each listed place): " + "; ".join(bits))
        out.append("")
    keys = sorted(ctx.bib)
    out.append(f"Bibliography: {len(keys)} keys" + (": " + ", ".join(keys[:max_keys]) + (" ..." if len(keys) > max_keys else "") if keys else ""))
    from .outline import load_outline
    ol = load_outline(project)
    from .plan import load_proposals
    pending_plans = [r for r in load_proposals(project) if r.get("status") == "pending"]
    st = ol.get("status") or "legacy"
    if ol or pending_plans:
        out.append(f"Outline status: {st}")
        if st == "draft" or pending_plans:
            out.append("Do not write prose yet. Propose outline changes with ah_plan; the author approves with `ah plan approve`.")
        if pending_plans:
            out.append("Pending outline proposals: " + ", ".join(r["id"] for r in pending_plans))
    if ol.get("thesis"):
        out.append(f"Thesis: {ol['thesis']}")
    for s in (ol.get("sections") or [])[:8]:
        flag = " [planned]" if s.get("planned") else ""
        out.append(f"Section {s.get('file')}{flag}: {s.get('purpose', '')}")
    from .briefs import load_briefs
    bl = load_briefs(project)
    if bl:
        out.append("Briefs: " + "; ".join(f"{b.id} ({b.data.get('status', 'draft')}) -> {b.data.get('unit') or b.data.get('file')}" for b in bl[:8]))
    from .reviews import load_all as _reviews
    from .proposals import list_pending
    for rv in _reviews(project):
        c: dict = {}
        for it in rv["items"]:
            c[it["status"]] = c.get(it["status"], 0) + 1
        out.append(f"Review {rv['review']}: {c}")
    pend = list_pending(project)
    if pend:
        out.append("Pending fact proposals (the author decides): " + ", ".join(r["proposal"]["id"] for r in pend))
    if ol or bl:
        out.append("")
    anchored = sum(1 for u in ctx.units if u.uid)
    out.append(f"Structure: {len(ctx.units)} units in {len(ctx.parsed)} files, {anchored} anchored.")
    out.append(f"Protected paths: {', '.join(project.protected_globs()[:12])}")
    rep = audit(project, use_ledger=False)
    blocking = [f for f in rep["findings"] if f["level"] in rep["gate"]["levels"]]
    out.append("")
    out.append(f"Gate now: {'PASS' if rep['gate']['passed'] else 'FAIL'} ({len(blocking)} blocking, {sum(rep['counts'].values())} open). "
               "You are only held to findings your own edits introduce.")
    for f in blocking[:max_findings]:
        out.append(f"- {f['check']} {f['unit'] or f['file'] or '-'}: {f['message'][:130]}")
    d = rep.get("done")
    if d and d["status"] != "pass":
        why = [c for c in d["components"] if c["status"] == "fail" or (c["status"] == "not-checked" and c["required"])]
        out.append(f"Done: {d['status'].upper()}. " + " ".join(f"[{c['id']}] {c['detail']}" for c in why[:4]))
    elif d:
        out.append("Done: PASS (every component checked in this view passed; `ah done` also reads the rubric and external results).")
    if unit:
        from .briefs import get_brief, pack
        from .order import heading_of, neighbours, summary
        from .context import unit_ref
        u = next((x for x in ctx.units if unit_ref(x) == unit), None)
        out.append("")
        if u:
            prev, nxt = neighbours(ctx, unit)
            out.append(f"## Unit {unit} ({u.file}; section {heading_of(ctx, u) or '-'})")
            if prev:
                out.append(f"Before: {summary(prev, ctx)}")
            if nxt:
                out.append(f"After:  {summary(nxt, ctx)}")
            from .claim_sidecar import load_sidecar
            cl = load_sidecar(project, unit).get("claims", [])
            if cl:
                out.append("Claims here: " + "; ".join(f"{c['id'][:6]} {c['status']}" for c in cl))
        br = next((b for b in bl if b.data.get("unit") == unit), None)
        if br:
            out.append(pack(ctx, br))
    return "\n".join(out) + "\n"
