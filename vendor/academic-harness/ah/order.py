"""Reading order and neighbours (design 8.3): the order a reader meets the units, not the order of files on disk."""
from __future__ import annotations

import re
from pathlib import Path

from .context import Context, unit_ref
from .tex.text import RE_INPUT, strip_comments
from .tex.units import Unit


def reading_order(ctx: Context) -> list[str]:
    """Files in the order they are first \\input from the views (depth first, textual order)."""
    from .tex.inputs import input_graph
    out = input_graph(ctx.tex_texts, [ctx.project.rel(v) for v in ctx.project.view_files()])["reachable"]
    seen = set(out)
    for rel in sorted(ctx.tex_texts):       # files no view reaches still get a place, after the rest
        if rel not in seen:
            out.append(rel)
    return out


def ordered_units(ctx: Context) -> list[Unit]:
    pos = {f: i for i, f in enumerate(reading_order(ctx))}
    return sorted(ctx.units, key=lambda u: (pos.get(u.file, 10**6), u.start))


def neighbours(ctx: Context, uid: str) -> tuple[Unit | None, Unit | None]:
    us = ordered_units(ctx)
    for i, u in enumerate(us):
        if unit_ref(u) == uid:
            return (us[i - 1] if i else None, us[i + 1] if i + 1 < len(us) else None)
    return (None, None)


def summary(u: Unit, ctx: Context | None = None, limit: int = 150) -> str:
    """Extractive one-line summary: the first sentence, without citations or macros. Deterministic; no model."""
    from .claims import plain_claim
    from .tex.text import sentences
    body = strip_comments(u.raw)
    if u.kind != "para":
        cap = re.search(r"\\caption\{([^}]*)\}", body)
        return (cap.group(1) if cap else f"[{u.kind}]")[:limit]
    ss = sentences(body)
    s = plain_claim(ss[0], ctx) if ss else ""
    s = re.sub(r"^\\?(paragraph|section|subsection)\{[^}]*\}\s*", "", s)
    return (s[: limit - 1] + "…") if len(s) > limit else s


HEADING_RX = re.compile(r"\\(?:section|subsection|subsubsection)\*?\{([^}]*)\}")


def heading_of(ctx: Context, u: Unit) -> str:
    """Nearest section heading before the unit. In a modular project the heading often lives in an earlier file
    (an index.tex), so look back through reading order when the unit's own file has none before it."""
    text = ctx.tex_texts.get(u.file, "")
    head = ""
    for m in HEADING_RX.finditer(text):
        if text.count("\n", 0, m.start()) + 1 <= u.end:
            head = m.group(1)
    if head:
        return head
    order = reading_order(ctx)
    if u.file in order:
        for f in reversed(order[: order.index(u.file)]):
            ms = list(HEADING_RX.finditer(ctx.tex_texts.get(f, "")))
            if ms:
                return ms[-1].group(1)
    return ""
