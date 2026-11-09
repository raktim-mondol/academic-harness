"""T2: bibliography and source registry (design 7.1, Appendix A BIB-*)."""
from __future__ import annotations

import re

from ..context import Context, unit_ref
from ..sources.registry import entry_for
from ..tex.scan import cites as scan_cites
from ..tex.scan import nocites as scan_nocites
from .base import Finding, make


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def check_t2(ctx: Context) -> list[Finding]:
    cfg, out = ctx.cfg, []

    def add(*a):
        f = make(cfg, *a)
        if f:
            out.append(f)

    cited: dict[str, list[tuple[str, int, str | None]]] = {}   # key -> [(file, line, unit ref)]
    nocited_all = False                                         # \\nocite{*}: every entry is in the bibliography on purpose
    for rel, text in sorted(ctx.tex_texts.items()):
        for k, at in scan_cites(text, ctx.wrappers):
            ln = text.count("\n", 0, at) + 1
            ref = next((unit_ref(u) for u in ctx.units if u.file == rel and u.start <= ln <= u.end), None)
            cited.setdefault(k, []).append((rel, ln, ref))
        for k, at in scan_nocites(text):       # in the bibliography without a sentence: counts as cited, but no claim hangs on it
            if k == "*":
                nocited_all = True
            else:
                cited.setdefault(k, []).append((rel, text.count("\n", 0, at) + 1, None))

    for k in ctx.bib_dups:
        add("BIB-06", None, ctx.bib[k].file if k in ctx.bib else None, None, f"dup:{k}", f"bibliography key '{k}' is defined more than once")

    for k, where in sorted(cited.items()):
        if k not in ctx.bib:
            for rel, ln, ref in where[:1]:
                add("BIB-01", ref, rel, ln, f"cite:{k}", f"\\cite key '{k}' is not in the bibliography")
    for k, where in sorted(cited.items()):
        src = entry_for(ctx.registry, k)
        rel, ln, ref = where[0]
        if src is None:
            add("BIB-02", ref, rel, ln, f"reg:{k}", f"cited key '{k}' is not in the source registry")
            continue
        st = src.get("status", "ok")
        if st in ("retracted", "corrected", "superseded"):
            add("BIB-04", ref, rel, ln, f"status:{k}:{st}", f"cited source '{k}' is {st}")
            e = ctx.bib.get(k)
            if e:
                bad = []
                if src.get("doi") and e.fields.get("doi") and _norm(src["doi"]) != _norm(e.fields["doi"]):
                    bad.append("doi")
                if src.get("year") and e.fields.get("year") and str(src["year"]) != e.fields["year"]:
                    bad.append("year")
                if src.get("title") and e.fields.get("title") and _norm(src["title"]) != _norm(e.fields["title"]):
                    bad.append("title")
                if bad:
                    add("BIB-03", ref, rel, ln, f"fields:{k}:{','.join(bad)}", f"bibliography and registry differ for '{k}' in: {', '.join(bad)}")
    unused = [] if nocited_all else sorted(set(ctx.bib) - set(cited))
    if unused:
        add("BIB-05", None, None, None, "unused", f"{len(unused)} of {len(ctx.bib)} bibliography entries are never cited (first: {', '.join(unused[:8])})")
    return out
