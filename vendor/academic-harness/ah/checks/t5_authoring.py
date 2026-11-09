"""T5: authoring. Briefs against the text, the outline, and review items (design 8.2, 8.4, 8.5). All code, no model."""
from __future__ import annotations

from ..briefs import check_brief, load_briefs
from ..context import Context
from ..outline import check_outline
from ..plan import check_plan
from ..reviews import check_review, load_all
from .base import Finding, make


def check_t5(ctx: Context) -> list[Finding]:
    cfg, out = ctx.cfg, []
    raw: list[dict] = []
    for b in load_briefs(ctx.project):
        raw += check_brief(ctx, b)
    raw += check_outline(ctx)
    raw += check_plan(ctx)
    for rev in load_all(ctx.project):
        raw += check_review(ctx, rev)
    for d in raw:
        f = make(cfg, d["check"], d.get("ref"), d.get("file"), None, d["key"], d["message"])
        if f:
            if d["check"] not in (cfg.get("levels") or {}):
                f.level = d["level"]
            out.append(f)
    from .t5_format import check_format
    from .t5_style import check_style
    out += check_style(ctx)
    out += check_format(ctx)
    return out
