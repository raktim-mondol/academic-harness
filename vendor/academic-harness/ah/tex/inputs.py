"""Static input graph of a document: which .tex files the build reads, in order, and which inputs cannot be resolved.

Resolution follows how a build finds files: relative to the document root first, then to the including file. Inside a file reached
through \\import the imported directory comes first, because that is what the import package does. An input whose path is built by a
macro (\\input{sections/#1}, \\input{\\jobname.tex}) is reported as dynamic, never guessed. Verified against real LaTeX by
tests/test_tex_oracle.py.
"""
from __future__ import annotations

import posixpath
import re
from pathlib import Path

from .scan import inputs as scan_inputs
from .scan import markup_view, wrappers


def resolve_input(rel: str, inc: str, texts: dict[str, str], base: str | None = None) -> str | None:
    if not inc.strip() or re.search(r"[\\#{}]", inc):
        return None
    cand = inc if inc.endswith(".tex") else inc + ".tex"
    tries = [cand, str(Path(rel).parent / cand)]
    if base:
        tries.insert(0, posixpath.join(base, cand))
    for raw in tries:
        name = posixpath.normpath(raw)
        if name in texts:
            return name
    return None


def input_graph(texts: dict[str, str], views: list[str]) -> dict:
    seen, active, order, unresolved, cycles = set(), set(), [], [], []
    live: dict[str, str] = {}

    def view(rel: str) -> str:
        if rel not in live:
            live[rel] = markup_view(texts[rel])
        return live[rel]

    table = wrappers(view(r) for r in sorted(texts))      # \\newcommand{\\sect}[1]{\\input{sections/#1}}: the uses name the files

    def visit(rel: str, base: str | None = None):
        if rel in active:
            cycles.append(rel)
            return
        if rel in seen or rel not in texts:
            return
        seen.add(rel)
        active.add(rel)
        order.append(rel)
        text = view(rel)
        for inp in scan_inputs(text, table):
            dest = resolve_input(rel, inp.path, texts, inp.base or base)
            if dest:
                visit(dest, inp.base or base)
            elif not inp.optional:
                unresolved.append({"file": rel, "input": inp.path, "line": text.count("\n", 0, inp.pos) + 1, "dynamic": inp.dynamic})
        active.remove(rel)

    for root in views:
        visit(root)
    return {"reachable": order, "unresolved": unresolved, "cycles": sorted(set(cycles))}


def supporting_file(rel: str, text: str) -> bool:
    """Conservative exclusions for definitions, never for arbitrary appendix/custom paths."""
    if any(part in ("macros", "styles", "preamble") for part in Path(rel).parts):
        return True
    lines = [s.strip() for s in text.splitlines() if s.strip()]
    return bool(lines) and all(re.match(r"\\(?:newcommand|renewcommand|providecommand|usepackage|RequirePackage|def|setlength)\b", s) for s in lines)
