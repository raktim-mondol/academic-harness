"""Static literal TeX input graph. Root-relative resolution matches the document build order."""
from pathlib import Path
import posixpath
import re

from .text import RE_INPUT


def resolve_input(rel: str, inc: str, texts: dict[str, str]) -> str | None:
    if not inc.strip() or re.search(r"[\\#{}]", inc):
        return None
    cand = inc if inc.endswith(".tex") else inc + ".tex"
    for raw in (cand, str(Path(rel).parent / cand)):
        name = posixpath.normpath(raw)
        if name in texts:
            return name
    return None


def input_graph(texts: dict[str, str], views: list[str]) -> dict:
    seen, active, order, unresolved, cycles = set(), set(), [], [], []

    def visit(rel):
        if rel in active:
            cycles.append(rel)
            return
        if rel in seen or rel not in texts:
            return
        seen.add(rel)
        active.add(rel)
        order.append(rel)
        for m in RE_INPUT.finditer(texts[rel]):
            inc = m.group(1).strip()
            dest = resolve_input(rel, inc, texts)
            if dest:
                visit(dest)
            else:
                unresolved.append({"file": rel, "input": inc, "line": texts[rel].count("\n", 0, m.start()) + 1})
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
