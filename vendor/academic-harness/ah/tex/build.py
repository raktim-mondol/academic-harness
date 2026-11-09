"""Build wrapper and compile-log parser (design 4.5).

Runs the project's build command and turns the log into findings. Errors carry file:line (via
-file-line-error) so they land on a unit. Warnings that carry no location are mapped by content
(a duplicate PDF destination, an undefined \\fact key) or reported at document level.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from ..checks.base import Finding, make
from ..context import Context, unit_ref
from ..project import Project

DEFAULT_CMD = ["latexmk", "-pdf", "-interaction=nonstopmode", "-file-line-error", "-output-directory=build"]


def run_build(project: Project, view: str | None = None, timeout: int = 600) -> dict:
    view = view or project.cfg["tex"]["views"][0]
    cmd = list(project.cfg.get("build", {}).get("cmd") or DEFAULT_CMD) + [view]
    if shutil.which(cmd[0]) is None:
        return {"ok": False, "error": f"{cmd[0]} not found", "log": ""}
    (project.tex_root / "build").mkdir(exist_ok=True)
    import os
    env = dict(os.environ)
    # latexmk runs bibtex inside the output directory, so point it back at the TeX root
    env["BIBINPUTS"] = f"{project.tex_root}:" + env.get("BIBINPUTS", "")
    env["TEXINPUTS"] = f"{project.tex_root}//:" + env.get("TEXINPUTS", "")
    env["max_print_line"] = "10000"      # TeX hard-wraps log lines at 79 chars, which cuts file paths in half
    env["error_line"] = "254"
    env["half_error_line"] = "238"
    p = subprocess.run(cmd, cwd=project.tex_root, capture_output=True, text=True, timeout=timeout, env=env)
    log_path = project.tex_root / "build" / (Path(view).stem + ".log")
    log = log_path.read_text(errors="replace") if log_path.exists() else p.stdout
    return {"ok": p.returncode == 0, "returncode": p.returncode, "log": log, "view": view}


# A line the engine prints about the document, not a place where files open or close: parentheses in it are text ("(45.0pt too wide)").
_MESSAGE = re.compile(r"^(?:Overfull|Underfull|LaTeX\s+(?:Font\s+)?(?:Warning|Info|Error)|Package\b|Class\b|! |l\.\d+|\*\*|Missing character|\s*\[\]|\s*\\[A-Za-z]+/)")
_FILE_OR_CLOSE = re.compile(r"\((?P<path>(?:\./|\.\./|/|~/)?[^\s()]+\.[A-Za-z0-9]{1,6})|(?P<close>\))")
_OVERFULL = re.compile(r"^Overfull \\(?P<kind>[hv])box \((?P<pts>[\d.]+)pt too (?:wide|high)\)(?: in (?:paragraph|alignment) at lines (?P<a>\d+)--(?P<b>\d+))?")


def _dump_text(lines: list[str], at: int) -> str:
    """The first words TeX prints after an Overfull warning (the start of the paragraph), as lower-case letters and digits only."""
    got = []
    for line in lines[at + 1: at + 6]:
        if not line.strip() or line.strip() == "[]":
            break
        got.append(re.sub(r"\\[A-Za-z0-9]+(?:/[A-Za-z0-9-]+)+\s?", " ", line))      # font specifiers such as \OT1/cmr/m/n/10
    return re.sub(r"[^a-z0-9]", "", " ".join(got).lower())


def _overfull_boxes(log: str) -> list[dict]:
    """Overfull boxes with where they start (line numbers), the first words of the box, and the .tex file TeX had open at that moment.

    The open file is only a hint. A paragraph is flushed when the next one starts, so the last paragraph of an \\input file is reported
    after that file's closing parenthesis, and the stack then names the parent. The line number and the text decide (see log_findings)."""
    out, stack, lines = [], [], log.splitlines()
    for at, line in enumerate(lines):
        m = _OVERFULL.match(line)
        if m:
            tex = next((f for f in reversed(stack) if f.endswith(".tex")), None)
            out.append({"kind": m.group("kind") + "box", "pts": float(m.group("pts")),
                        "lines": [int(m.group("a")), int(m.group("b"))] if m.group("a") else None, "file": tex, "text": _dump_text(lines, at)})
        if _MESSAGE.match(line):
            continue
        for t in _FILE_OR_CLOSE.finditer(line):
            if t.group("path"):
                stack.append(t.group("path"))
            elif stack:
                stack.pop()
    return out


def parse_log(log: str) -> dict:
    """Pure function over log text, so it is unit-testable without TeX."""
    errors = [{"file": m.group(1), "line": int(m.group(2)), "msg": m.group(3).strip()}
              for m in re.finditer(r"^(\S+?\.tex):(\d+): (.+)$", log, re.M)]
    bare = [m.group(1).strip() for m in re.finditer(r"^! (.+)$", log, re.M)] if not errors else []
    dest = sorted(set(re.findall(r"destination with the same identifier \(name\{([^}]+)\}\)", log)))
    undefined_facts = sorted(set(re.findall(r"AH warning: undefined fact (\S+)", log)))
    undef_refs = sorted(set(re.findall(r"Reference `([^']+)' on page \d+ undefined", log)))
    undef_cites = sorted(set(re.findall(r"Citation `([^']+)' on page \d+ undefined", log)))
    overfull = len(re.findall(r"^Overfull \\[hv]box", log, re.M))
    pages = re.search(r"Output written on .*?\((\d+) pages?", log)
    missing = sorted(set(re.findall(r"^Missing character: There is no (.+?) in font", log, re.M)))
    return {"errors": errors, "bare_errors": bare, "duplicate_destinations": dest, "undefined_facts": undefined_facts,
            "undefined_refs": undef_refs, "undefined_cites": undef_cites, "overfull": overfull, "overfull_boxes": _overfull_boxes(log),
            "pages": int(pages.group(1)) if pages else None, "missing_characters": missing,
            "multiply_defined": sorted(set(re.findall(r"Label `([^']+)' multiply defined", log))),
            "float_too_large": len(re.findall(r"Float too large for page", log))}


def _project_rel(ctx: Context, file: str | None) -> str | None:
    """The TeX-root-relative name of a file the log mentions ('./sections/a.tex', or an absolute path under the root)."""
    if not file:
        return None
    f = file[2:] if file.startswith("./") else file
    root = str(ctx.project.tex_root.resolve()).rstrip("/") + "/"
    if f.startswith("/"):
        f = f[len(root):] if f.startswith(root) else f
    known = sorted({u.file for u in ctx.units})
    if f not in known:                                  # a wrapped or odd path: accept a unique suffix match
        cand = [k for k in known if k.endswith(f) or f.endswith(k)]
        f = cand[0] if len(cand) == 1 else f
    return f


def _plain(u) -> str:
    from .text import prose_view
    return re.sub(r"[^a-z0-9]", "", prose_view(u.norm).lower())


def _box_unit(ctx: Context, box: dict):
    """The one paragraph an overfull box belongs to, or None when the log does not say. The box starts on a line of some file; among the
    units starting there, the open file narrows it and the first words of the box decide. Never a guess between several candidates."""
    if not box.get("lines"):
        return None
    a = box["lines"][0]
    cands = [u for u in ctx.units if u.start == a] or [u for u in ctx.units if u.start <= a <= u.end]
    rel = _project_rel(ctx, box.get("file"))
    if rel and any(u.file == rel for u in cands):
        cands = [u for u in cands if u.file == rel]
    if len(cands) > 1 and box.get("text"):
        head = box["text"][:24]
        cands = [u for u in cands if _plain(u).startswith(head)] or cands
    return cands[0] if len(cands) == 1 else None


def log_findings(ctx: Context, parsed: dict) -> list[Finding]:
    cfg, out = ctx.cfg, []

    def add(*a):
        f = make(cfg, *a)
        if f:
            out.append(f)

    def unit_at(rel: str | None, line: int | None) -> str | None:
        return next((unit_ref(u) for u in ctx.units if u.file == rel and line and u.start <= line <= u.end), None)

    for e in parsed["errors"]:
        rel = _project_rel(ctx, e["file"])
        add("TEX-01", unit_at(rel, e["line"]), rel, e["line"], f"err:{e['msg'][:60]}", f"LaTeX error: {e['msg']}")
    for m in parsed["bare_errors"]:
        add("TEX-01", None, None, None, f"err:{m[:60]}", f"LaTeX error: {m}")
    for d in parsed["duplicate_destinations"]:
        add("TEX-03", None, None, None, f"dest:{d}", f"duplicate PDF destination '{d}' (hyperref)")
    for k in parsed["undefined_facts"]:
        add("NUM-005", None, None, None, f"logfact:{k}", f"\\fact{{{k}}} is undefined in the compiled document")

    # Overfull boxes: text running into the margin. One finding per paragraph (the key has no line number, so it survives edits above it).
    here: dict[str, dict] = {}
    for b in parsed.get("overfull_boxes") or []:
        u = _box_unit(ctx, b)
        key = f"overfull:{unit_ref(u)}" if u else "overfull"
        row = here.setdefault(key, {"ref": unit_ref(u) if u else None, "file": u.file if u else None, "line": u.start if u else None, "n": 0, "worst": 0.0})
        row["n"] += 1
        row["worst"] = max(row["worst"], b["pts"])
    for key, row in here.items():
        if row["ref"]:
            add("TEX-04", row["ref"], row["file"], row["line"], key,
                f"{row['n']} overfull box warning(s) in this paragraph: the text runs {row['worst']:g}pt into the margin at worst")
        else:
            add("TEX-04", None, None, None, key, f"{row['n']} overfull box warning(s) the log does not tie to one paragraph (worst {row['worst']:g}pt)")
    if not parsed.get("overfull_boxes") and parsed["overfull"]:
        add("TEX-04", None, None, None, "overfull", f"{parsed['overfull']} overfull box warning(s) in the log")

    if parsed.get("missing_characters"):
        chars = parsed["missing_characters"]
        add("TEX-07", None, None, None, "missing-glyphs",
            f"{len(chars)} character(s) are not in the font and print as blanks: {' '.join(chars[:8])}{' ...' if len(chars) > 8 else ''}")

    limit = (cfg.get("build") or {}).get("max_pages")
    if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0 and parsed.get("pages") and parsed["pages"] > limit:
        add("TEX-08", None, None, None, "pages", f"the compiled document has {parsed['pages']} pages (limit {limit})")
    return out
