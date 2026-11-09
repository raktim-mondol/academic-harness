"""The static scanner against real LaTeX: what TeX read, cited, labelled and referenced vs what the engine believes.

Each case in tex_cases.py is compiled with latexmk. Truth comes from TeX itself: the compiled page (which files were typeset), the .aux
(citations, labels) and the log (the references it evaluated). Skipped when latexmk or pdftotext is missing, so CI without TeX is unaffected.
Run it where TeX is installed after any change to ah/tex/scan.py.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from ah.tex.inputs import input_graph
from ah.tex.scan import cites, labels, markup_view, nocites, refs, wrappers

from tex_cases import CASES

pytestmark = pytest.mark.skipif(not (shutil.which("latexmk") and shutil.which("pdftotext") and shutil.which("pdflatex")), reason="needs a TeX installation")


def compile_case(src: Path) -> None:
    out = src / "build"
    for d in {p.parent.relative_to(src) for p in src.rglob("*") if p.is_file() and "build" not in p.parts}:
        (out / d).mkdir(parents=True, exist_ok=True)           # \include writes sub/x.aux below the output directory
    env = dict(os.environ, max_print_line="10000", error_line="254", half_error_line="238", TEXINPUTS=f"{src}//:", BIBINPUTS=f"{src}:")
    subprocess.run(["latexmk", "-norc", "-pdf", "-f", "-interaction=nonstopmode", "-file-line-error", f"-output-directory={out}", "main.tex"],
                   cwd=src, capture_output=True, text=True, timeout=240, env=env)


def truth(src: Path) -> dict:
    out = src / "build"
    aux = "\n".join(p.read_text(errors="replace") for p in sorted(out.rglob("*.aux")))
    cited = set()
    for m in re.finditer(r"\\citation\{([^}]*)\}", aux):
        cited |= {k.strip() for k in m.group(1).split(",") if k.strip()}
    for m in re.finditer(r"\\abx@aux@cite\{[^}]*\}\{([^}]*)\}", aux):
        cited.add(m.group(1).strip())
    log = (out / "main.log").read_text(errors="replace") if (out / "main.log").exists() else ""
    pdf = out / "main.pdf"
    text = subprocess.run(["pdftotext", str(pdf), "-"], capture_output=True, text=True).stdout if pdf.exists() else ""
    flat = re.sub(r"\s+", " ", text)
    typeset = set()
    for p in src.rglob("*.tex"):
        if "build" in p.parts:
            continue
        m = re.search(r"page\.\s+([A-Za-z0-9 ]+?)\.", p.read_bytes().decode("utf-8-sig", errors="replace"))
        if m and m.group(1) in flat:
            typeset.add(p.relative_to(src).as_posix())
    return {"typeset": typeset, "cites": cited,
            "labels": {m.group(1) for m in re.finditer(r"\\newlabel\{([^}]+)\}\{", aux) if "@" not in m.group(1) and m.group(1) != "LastPage"},
            "refs": set(re.findall(r"(?:Hyper )?[Rr]eference [`']([^'`]+)' on page", log)), "pdf": pdf.exists()}


def engine(src: Path) -> dict:
    texts = {p.relative_to(src).as_posix(): p.read_bytes().decode("utf-8-sig", errors="replace") for p in src.rglob("*.tex") if "build" not in p.parts}
    graph = input_graph(texts, ["main.tex"])
    live = [markup_view(texts[r]) for r in graph["reachable"]]
    table = wrappers(markup_view(t) for t in texts.values())
    return {"inputs": {r for r in graph["reachable"] if r != "main.tex"},
            "cites": {k for t in live for k, _ in cites(t, table)} | {k for t in live for k, _ in nocites(t)},
            "labels": {k for t in live for k, _ in labels(t, table)}, "refs": {k for t in live for k, _ in refs(t, table)}}


@pytest.mark.parametrize("name", sorted(CASES))
def test_the_scanner_agrees_with_real_latex(name, tmp_path):
    spec = CASES[name]
    src = tmp_path / "src"
    for rel, text in spec["files"].items():
        (src / rel).parent.mkdir(parents=True, exist_ok=True)
        (src / rel).write_bytes(text.encode("utf-8"))
    compile_case(src)
    t, e = truth(src), engine(src)
    assert t["pdf"], f"{name}: the case did not compile, so it proves nothing"
    allow = set(spec.get("allow_extra", ()))
    problems = []
    for kind, tv, ev in (("inputs", t["typeset"], e["inputs"]), ("cites", t["cites"], e["cites"]), ("labels", t["labels"], e["labels"]), ("refs", t["refs"], e["refs"])):
        missed, extra = sorted(tv - ev), sorted(x for x in ev - tv if x not in allow)
        if missed or extra:
            problems.append(f"{kind}: engine misses {missed}, adds {extra}")
    assert not problems, f"{name} ({spec['note']}): " + "; ".join(problems)
