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
from .scan import RE_INPUT, markup_view, wrappers


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


_END = re.compile(r"\\end\s*\{document\}")
_EXEMPT = re.compile(r"\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:standalone|subfiles)\b[^}]*\}")


def input_graph(texts: dict[str, str], views: list[str]) -> dict:
    """Reachable files in reading order, what cannot be resolved, and where the document ends early.

    `\\end{document}` in a file read through \\input or \\include ends the whole document: nothing after it is typeset, in that file or in any
    file that included it. `ended` names the file and line; `never_read` lists the inputs that follow, which a build never opens. Files read
    through \\subfile, and every file when the project loads standalone or subfiles, handle their own \\end{document}, so they do not end it."""
    seen, active, order, unresolved, cycles = set(), set(), [], [], []
    live: dict[str, str] = {}
    state: dict = {"ended": None, "never_read": [], "after_words": 0}

    def view(rel: str) -> str:
        if rel not in live:
            live[rel] = markup_view(texts[rel])
        return live[rel]

    table = wrappers(view(r) for r in sorted(texts))      # \\newcommand{\\sect}[1]{\\input{sections/#1}}: the uses name the files
    exempt = any(_EXEMPT.search(view(r)) for r in texts)

    def words(tail: str) -> int:
        return len(re.findall(r"[A-Za-z]{3,}", re.sub(r"\\[A-Za-z@]+\*?|[{}]", " ", RE_INPUT.sub(" ", tail))))

    def visit(rel: str, base: str | None = None, ends: bool = True):
        if rel in active:
            cycles.append(rel)
            return
        if rel in seen or rel not in texts:
            return
        seen.add(rel)
        active.add(rel)
        order.append(rel)
        text = view(rel)
        end = _END.search(text)
        end_at = end.start() if end else None
        trigger = None                                    # the input whose file ended the document
        for inp in scan_inputs(text, table):
            dest = resolve_input(rel, inp.path, texts, inp.base or base)
            if (end_at is not None and inp.pos > end_at and ends and not exempt) or state["ended"] is not None:
                if dest and dest not in state["never_read"]:
                    state["never_read"].append(dest)
                continue
            if dest:
                visit(dest, inp.base or base, ends and not inp.subfile)
                if trigger is None and state["ended"] is not None:
                    trigger = inp
            elif not inp.optional:
                unresolved.append({"file": rel, "input": inp.path, "line": text.count("\n", 0, inp.pos) + 1, "dynamic": inp.dynamic})
        if end_at is not None and ends and not exempt and state["ended"] is None:
            state["ended"] = {"file": rel, "line": text.count("\n", 0, end_at) + 1}
            state["after_words"] += words(text[end.end():])
        elif trigger is not None:                         # an ancestor: whatever it says after the \\input that ended the document is never typeset
            state["after_words"] += words(text[trigger.pos:])
        active.remove(rel)

    for root in views:
        visit(root)
    return {"reachable": order, "unresolved": unresolved, "cycles": sorted(set(cycles)), "ended": state["ended"],
            "never_read": sorted(state["never_read"]), "text_after_end": state["after_words"]}


def supporting_file(rel: str, text: str) -> bool:
    """Conservative exclusions for definitions, never for arbitrary appendix/custom paths."""
    if any(part in ("macros", "styles", "preamble") for part in Path(rel).parts):
        return True
    lines = [s.strip() for s in text.splitlines() if s.strip()]
    return bool(lines) and all(re.match(r"\\(?:newcommand|renewcommand|providecommand|usepackage|RequirePackage|def|setlength)\b", s) for s in lines)
