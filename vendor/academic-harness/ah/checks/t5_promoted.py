"""T5: rules promoted from review comments (PRM-01, PRM-02). Code only; the author accepted each rule (see promote.py)."""
from __future__ import annotations

from ..context import Context, unit_ref
from ..promote import RULES_FILE, check_rule, load_rules, unit_hits
from .base import Finding, make


def check_promoted(ctx: Context) -> list[Finding]:
    cfg, out = ctx.cfg, []
    rules, problems = load_rules(ctx.project)
    for key, msg in problems:
        f = make(cfg, "PRM-02", None, RULES_FILE, None, key, msg)
        if f:
            out.append(f)
    for rule in rules:
        rx, _ = check_rule(rule)
        rid = rule["id"]
        for u in ctx.units:
            ref = unit_ref(u)
            for m in unit_hits(rule, rx, u):
                f = make(cfg, "PRM-01", ref, u.file, u.start, f"{rid}:{m.casefold()[:60]}",
                         f"{rid}: \"{m}\" ({rule['message']})")
                if f:
                    if "PRM-01" not in (cfg.get("levels") or {}):
                        f.level = str(rule.get("level") or "info")
                    out.append(f)
    return out

