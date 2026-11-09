"""T0: structure. Deterministic checks on units, labels, references and file layout (design 4.2)."""
from __future__ import annotations

import fnmatch
import re
from collections import Counter
from pathlib import Path

from ..context import Context, unit_ref
from ..tex.scan import inputs as scan_inputs
from ..tex.scan import labels as scan_labels
from ..tex.scan import markup_view, refs as scan_refs
from ..tex.text import (HEADING_CMDS, RE_ANCHOR, find_envs, strip_comments)
from .base import Finding, make

SECTION_PREFIX = {"section": "sec", "subsection": "sec", "subsubsection": "sec", "paragraph": "sec",
                  "chapter": "sec", "part": "sec"}


def check_t0(ctx: Context) -> list[Finding]:
    cfg, out = ctx.cfg, []

    def add(*a):
        f = make(cfg, *a)
        if f:
            out.append(f)

    # ---- UNIT-01: anchors ----
    ids = Counter(u.uid for u in ctx.units if u.uid)
    for u in ctx.units:
        if u.uid is None:
            add("UNIT-01", unit_ref(u), u.file, u.start, "missing-anchor",
                f"unit has no anchor; run `ah units sync` ({u.file}:{u.start})")
        elif ids[u.uid] > 1:
            add("UNIT-01", unit_ref(u), u.file, u.start, f"duplicate:{u.uid}",
                f"anchor id {u.uid} is used by {ids[u.uid]} units")
    for pf in ctx.parsed:
        for ln, uid in pf.orphan_anchors:
            add("UNIT-01", None, pf.file, ln, f"orphan:{uid}", f"anchor {uid} is not directly above a unit")

    # ---- UNIT-02: reachability from the views ----
    ignore = cfg.get("tex", {}).get("ignore", [])
    for rel in sorted(ctx.tex_texts):
        if rel in ctx.reachable or any(fnmatch.fnmatch(rel, p) for p in ignore):
            continue
        if rel in {ctx.project.rel(v) for v in ctx.project.view_files()}:
            continue
        if re.search(r"\\documentclass", ctx.tex_texts[rel]):      # a complete document (for example a standalone figure) is its own root
            continue
        add("UNIT-02", None, rel, None, "unreachable", f"{rel} is not input from any view")

    # ---- UNIT-03: prose inside a view file is never parsed into units, so no check reads it ----
    min_words = int(cfg.get("tex", {}).get("view_prose_words", 150))
    for v in ctx.project.view_files():
        try:
            from ..tex.units import parse_file
            parsed = parse_file(ctx.project, v)
        except Exception:
            continue
        words = sum(u.words for u in parsed.units if u.kind == "para")
        if words >= min_words:
            rel = ctx.project.rel(v)
            add("UNIT-03", None, rel, None, "view-prose",
                f"{rel} is the build root but holds {words} words of prose, and no check reads a root file: "
                f"move the text into section files that the root \\input{{}}s (then `ah units sync`)")

    # ---- included prose not selected by tex.prose ----
    from ..tex.units import parse_file
    for rel in ctx.project.input_coverage()["omitted"]:
        parsed = parse_file(ctx.project, ctx.project.tex_root / rel)
        if any(u.words >= 12 for u in parsed.units):
            add("UNIT-04", None, rel, None, "coverage:omitted", f"{rel} is included from a view but excluded from tex.prose; add it to audit coverage")

    # ---- file size (LAT-02) ----
    lim = cfg["limits"]
    for pf in ctx.parsed:
        n = len(pf.lines)
        if n > lim["lines_hard"]:
            add("LAT-02", None, pf.file, None, "lines-hard", f"{pf.file} has {n} lines (hard limit {lim['lines_hard']})")
        elif n > lim["lines_soft"]:
            add("LAT-02", None, pf.file, None, "lines-soft", f"{pf.file} has {n} lines (soft limit {lim['lines_soft']})")

    # ---- paragraph length (LAT-03) ----
    for u in ctx.units:
        if u.kind == "para" and u.words > lim["para_words_soft"]:
            lvl = "hard" if u.words > lim["para_words_hard"] else "soft"
            add("LAT-03", unit_ref(u), u.file, u.start, f"words-{lvl}",
                f"paragraph has {u.words} words (limit {lim['para_words_soft']}/{lim['para_words_hard']})")

    # ---- labels: placement (LAT-06), prefix (LAT-07) ----
    for u in ctx.units:
        body = markup_view(u.raw)
        for lab, at in scan_labels(body, ctx.wrappers):
            before = re.sub(r"\s+", " ", body[: at]).strip()
            after_heading = re.search(r"\\(" + HEADING_CMDS + r")(?:\[[^\]]*\])?\{[^}]*\}\s*(?:\\label\{[^}]*\}\s*)*$", before)
            at_start = not re.sub(r"(\\label\{[^}]*\}\s*)", "", before)
            in_caption = u.kind == "float" or re.search(r"\\(?:caption|item)\b[^\n]*$", before)
            in_display = u.kind == "display"
            if u.kind == "para" and not (after_heading or at_start or in_caption):
                add("LAT-06", unit_ref(u), u.file, u.start + body[: at].count("\n"), f"label:{lab}",
                    f"\\label{{{lab}}} sits in running prose, not next to a heading")
            expected = None
            if u.kind == "float":
                env = re.search(r"\\begin\{(\w+\*?)\}", body)
                name = env.group(1).rstrip("*") if env else ""
                expected = {"figure": "fig", "tikzpicture": "fig", "table": "tab", "longtable": "tab",
                            "tabularx": "tab", "tabular": "tab"}.get(name)
            elif in_display:
                expected = "eq"
            elif after_heading:
                cmd = after_heading.group(1).rstrip("*")
                expected = SECTION_PREFIX.get(cmd)
            pref = lab.split(":", 1)[0] if ":" in lab else ""
            if expected and pref not in (expected, "app") and not (expected == "sec" and pref in ("subsec", "sec")):
                add("LAT-07", unit_ref(u), u.file, u.start, f"prefix:{lab}",
                    f"label '{lab}' should start with '{expected}:' for this context")

    # ---- TEX-02 / TEX-03: static label and reference integrity ----
    label_files: dict[str, list[str]] = {}
    for rel, text in ctx.tex_texts.items():
        for lab, _ in scan_labels(text, ctx.wrappers):
            label_files.setdefault(lab, []).append(rel)
    for lab, files in sorted(label_files.items()):
        if len(files) > 1:
            add("TEX-03", None, files[0], None, f"label:{lab}", f"label '{lab}' is defined {len(files)} times ({', '.join(sorted(set(files)))})")
    seen_ref = set()
    for rel, text in sorted(ctx.tex_texts.items()):
        for r, at in scan_refs(text, ctx.wrappers):
            if r not in label_files and (rel, r) not in seen_ref:
                seen_ref.add((rel, r))
                ln = text.count("\n", 0, at) + 1
                ref = next((unit_ref(u) for u in ctx.units if u.file == rel and u.start <= ln <= u.end), None)
                add("TEX-02", ref, rel, ln, f"ref:{r}", f"\\ref{{{r}}} has no matching \\label")

    # ---- TEX-05: \\input of a file that does not exist (a misplaced new file shows up here) ----
    from pathlib import Path as _P
    texroot = ctx.project.tex_root
    seen_in = set()
    for rel, text in sorted(ctx.tex_texts.items()):
        base = (texroot / rel).parent
        for inp in scan_inputs(text, ctx.wrappers):
            ln = text.count("\n", 0, inp.pos) + 1
            ref = next((unit_ref(u) for u in ctx.units if u.file == rel and u.start <= ln <= u.end), None)
            if inp.dynamic:           # \input{sections/#1}: the files it loads are never read by a check
                if (rel, inp.path) not in seen_in:
                    seen_in.add((rel, inp.path))
                    add("TEX-06", ref, rel, ln, f"dyn:{inp.path}", f"\\input path '{inp.path}' is built by a macro, so the files it loads cannot be audited")
                continue
            cand = inp.path if inp.path.endswith(".tex") else inp.path + ".tex"
            dirs = ([texroot / inp.base] if inp.base else []) + [texroot, base]
            if inp.optional or any((b / cand).is_file() for b in dirs) or (rel, inp.path) in seen_in:
                continue
            seen_in.add((rel, inp.path))
            add("TEX-05", ref, rel, ln, f"input:{inp.path}", f"\\input{{{inp.path}}} names a file that does not exist (looked under {texroot.name}/)")

    # ---- TEX-09: \\end{document} in a file that is read before the document is meant to end ----
    g = getattr(ctx, "graph", None) or {}
    if g.get("ended") and (g.get("never_read") or g.get("text_after_end", 0) >= 5):
        e, later = g["ended"], g.get("never_read") or []
        said = ([f"{len(later)} later input(s) are never read: {', '.join(later[:5])}{' ...' if len(later) > 5 else ''}"] if later else []) \
            + ([f"{g['text_after_end']} words of text after it are never typeset"] if g.get("text_after_end") else [])
        add("TEX-09", next((unit_ref(u) for u in ctx.units if u.file == e["file"] and u.start <= e["line"] <= u.end), None), e["file"], e["line"],
            f"enddoc:{e['file']}", f"\\end{{document}} in {e['file']} ends the document early: " + "; ".join(said))

    # ---- LAT-11: TeX files outside the TeX root are almost always misplaced new files ----
    import os
    root, texroot = ctx.project.root.resolve(), ctx.project.tex_root.resolve()
    if texroot != root:
        skip_dirs = {".ah", ".git", "build", "node_modules", "__pycache__", ".venv", "sources", "archive"}
        pats = list(cfg.get("tex", {}).get("ignore", [])) + list(cfg.get("stray_ignore", []) or [])
        for dirpath, dirnames, files in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in skip_dirs and not (Path(dirpath, d).resolve() == texroot)]
            for fn in files:
                if not fn.endswith(".tex"):
                    continue
                rel = Path(dirpath, fn).resolve().relative_to(root).as_posix()
                if any(fnmatch.fnmatch(rel, p) for p in pats):
                    continue
                add("LAT-11", None, rel, None, f"stray:{rel}", f"{rel} is outside the TeX root ({texroot.name}/); a new file belongs under it and must be \\input from a view")

    # ---- LAT-10: commented-out prose ----
    for pf in ctx.parsed:
        for i, line in enumerate(pf.lines, 1):
            s = line.strip()
            if not s.startswith("%") or RE_ANCHOR.match(line):
                continue
            body = s.lstrip("% ").strip()
            if len(re.findall(r"[A-Za-z]{3,}", body)) >= 12 and re.search(r"[.!?]$", body) and not re.match(r"(NOTE|TODO|FIXME|Usage|Source)", body):
                add("LAT-10", None, pf.file, i, f"comment:{body[:40]}", "commented-out prose (dead text drifts out of date)")
    return out
