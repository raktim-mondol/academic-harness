"""Bring an existing LaTeX tree onto Academic Harness (design §4, §15 Phase 9).

Default is an in-place overlay: write ``ah.yaml`` and empty facts/sources/glossary, leave
the author's files where they are. Fact macros are optional (D2). Binding literals into
``\\fact{}`` rewrites prose and needs ``--yes``.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import yaml

from .tex.inventory import RE_NUM, classify
from .tex.text import RE_CITE, RE_FACT, RE_INPUT, sentences, strip_comments
from .util import sha1

IGNORE_DIRS = {".ah", "build", ".git", "node_modules", "__pycache__", "vendor", "archive",
               ".venv", "dist", "htmlcov", ".pytest_cache"}
SKIP_PARTS = {".git", "vendor", "node_modules", "archive", "sources"}

RE_DOCUMENTCLASS = re.compile(r"\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}")
RE_BEGIN_DOC = re.compile(r"\\begin\{document\}")
RE_HEADING = re.compile(r"\\(?:chapter|section|subsection)\*?\{([^}]*)\}")

PROFILE_HINTS = (
    ("literature-review/systematic", ("prisma", "systematic review", "included studies", "risk of bias")),
    ("grant/proposal", ("work package", "person-month", "specific aims", "research proposal", "budget")),
    ("paper/conference", ("double-blind", "anonymous submission", "page limit", "neurips", "icml", "acl 20")),
    ("thesis", ("dissertation", "\\chapter{", "candidate", "supervisors")),
    ("rebuttal/response", ("response to reviewers", "reviewer 1", "we thank the reviewers")),
    ("paper/journal-empirical", ("\\section{methods}", "\\section{results}", "\\section{discussion}",
                                 "materials and methods")),
)


def _rel(root: Path, p: Path) -> str:
    return p.resolve().relative_to(root.resolve()).as_posix()


def _iter_tex(root: Path) -> list[Path]:
    out = []
    for p in sorted(root.rglob("*.tex")):
        if any(part in IGNORE_DIRS or part in SKIP_PARTS for part in p.relative_to(root).parts):
            continue
        out.append(p)
    return out


def _guess_profile(texts: list[str]) -> str:
    blob = strip_comments("\n".join(texts)).lower()
    for name, keys in PROFILE_HINTS:
        if name == "grant/proposal" and not re.search(r"\\(?:title|(?:sub)*section)\*?\{[^}]*(?:proposal|specific aims|work packages|budget)", blob):
            continue
        if sum(1 for k in keys if k in blob) >= (2 if name != "paper/journal-empirical" else 1):
            return name
    return "generic"


def _prose_globs(root: Path, views: list[str], tex_files: list[Path]) -> list[str]:
    rels = [_rel(root, p) for p in tex_files]
    view_set = set(views)
    globs = []
    for dirname, glob in (("sections", "sections/**/*.tex"), ("chapters", "chapters/**/*.tex"),
                          ("appendices", "appendices/**/*.tex"), ("appendix", "appendix/**/*.tex"),
                          ("paper/chapters", "paper/chapters/**/*.tex"), ("paper/appendix", "paper/appendix/**/*.tex"),
                          ("paper/appendices", "paper/appendices/**/*.tex")):
        if any(r == dirname or r.startswith(dirname + "/") for r in rels):
            globs.append(glob)
    from .tex.inputs import input_graph, supporting_file
    texts = {_rel(root, p): strip_comments(p.read_text(errors="replace")) for p in tex_files}
    for rel in input_graph(texts, views)["reachable"]:
        if rel not in view_set and not supporting_file(rel, texts[rel]) and not any((root / rel).match(g) for g in globs):
            globs.append(rel)
    if globs:
        return globs
    others = [r for r in rels if r not in view_set and not r.startswith("macros/")]
    if not others:
        return ["**/*.tex"]
    # common prefix directory, else each top-level folder
    tops = sorted({r.split("/")[0] + "/**/*.tex" if "/" in r else r for r in others})
    return tops


def _literals_in(text: str) -> list[dict]:
    body = strip_comments(text)
    out = []
    for i, s in enumerate(sentences(body) or [body]):
        has_cite = bool(RE_CITE.search(s))
        v = RE_CITE.sub(" ", s)
        v = RE_FACT.sub(" ", v)
        for m in RE_NUM.finditer(v):
            tok = m.group(1).replace(",", "")
            pct = bool(m.group(2))
            before, after = v[max(0, m.start() - 16): m.start()], v[m.end(): m.end() + 16]
            cls = classify(m.group(1), pct, before, after)
            if cls.startswith("trivial"):
                continue
            if cls == "literal" and has_cite:
                cls = "cited"
            out.append({"text": tok, "pct": pct, "cls": cls, "sent": i,
                        "ctx": v[max(0, m.start() - 24): m.end() + 24].strip()})
    return out


def _fact_id(text: str, pct: bool, used: set[str]) -> str:
    base = ("pct_" if pct else "n_") + text.replace(".", "_")
    base = re.sub(r"[^a-z0-9_]+", "_", base.lower()).strip("_") or "value"
    cid, n = base, 2
    while cid in used:
        cid = f"{base}_{n}"
        n += 1
    used.add(cid)
    return cid


def scan(root: Path) -> dict[str, Any]:
    """Inventory a LaTeX tree that may not have ah.yaml yet."""
    root = root.resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"not a directory: {root}")
    tex_files = _iter_tex(root)
    if not tex_files:
        raise FileNotFoundError(f"no .tex files under {root}")
    views, classes = [], []
    for p in tex_files:
        t = p.read_text(errors="replace")
        m = RE_DOCUMENTCLASS.search(t)
        if m and RE_BEGIN_DOC.search(t):
            views.append(_rel(root, p))
            classes.append(m.group(1))
    if not views:
        preferred = [p for p in tex_files if p.name in ("main.tex", "paper.tex", "manuscript.tex")]
        pick = preferred[0] if preferred else tex_files[0]
        views = [_rel(root, pick)]
    bibs = [p for p in sorted(root.rglob("*.bib"))
            if not any(part in IGNORE_DIRS or part in SKIP_PARTS for part in p.relative_to(root).parts)]
    texts = [(p.read_text(errors="replace") if p.stat().st_size < 2_000_000 else "") for p in tex_files]
    profile = _guess_profile(texts)
    prose = _prose_globs(root, views, tex_files)
    from .tex.inputs import input_graph, supporting_file
    text_map = {_rel(root, p): strip_comments(t) for p, t in zip(tex_files, texts)}
    graph = input_graph(text_map, views)
    covered = sorted({p.relative_to(root).as_posix() for g in prose for p in root.glob(g) if p.is_file()})
    scope = dict(graph, audited=covered, roots=views,
                 supporting=sorted(r for r in graph["reachable"] if supporting_file(r, text_map[r])),
                 unreachable=sorted(set(text_map) - set(graph["reachable"])))
    inputs = []
    for p, t in zip(tex_files, texts):
        if _rel(root, p) in views:
            inputs += [m.group(1) for m in RE_INPUT.finditer(t)]
    lits: list[dict] = []
    for p, t in zip(tex_files, texts):
        if _rel(root, p) in views:
            continue
        for n in _literals_in(t):
            lits.append({**n, "file": _rel(root, p)})
    counts: Counter[tuple[str, bool]] = Counter((n["text"], n["pct"]) for n in lits if n["cls"] in ("literal", "cited"))
    return {
        "root": str(root),
        "name": root.name,
        "views": views,
        "documentclass": classes[0] if classes else None,
        "bib": [_rel(root, p) for p in bibs],
        "tex_files": [_rel(root, p) for p in tex_files],
        "prose_globs": prose,
        "profile": profile,
        "coverage": scope,
        "profile_inference": {"selected": profile, "note": "Heuristic only; select --profile explicitly when ambiguous."},
        "inputs_from_views": inputs,
        "literals": lits,
        "literal_repeats": [{"text": t, "pct": pct, "n": n} for (t, pct), n in counts.most_common()],
        "has_ah_yaml": (root / "ah.yaml").exists(),
    }


def _outline(scan_res: dict) -> dict:
    """Name existing section files so PLN-01 does not treat a migrated tree as stray prose."""
    sections = []
    root = Path(scan_res["root"])
    for rel in scan_res["tex_files"]:
        if rel in scan_res["views"] or rel not in scan_res.get("coverage", {}).get("audited", []):
            continue
        purpose = Path(rel).stem.replace("_", " ")
        p = root / rel
        if p.is_file():
            m = RE_HEADING.search(p.read_text(errors="replace"))
            if m:
                purpose = m.group(1)
        sections.append({"file": rel, "purpose": purpose})
    if not sections:
        sections = [{"file": g, "purpose": "migrated prose"} for g in scan_res["prose_globs"]]
    return {"status": "draft", "thesis": "", "sections": sections, "claims": []}


def candidates(scan_res: dict, min_repeats: int = 2) -> list[dict]:
    used: set[str] = set()
    out = []
    by: dict[tuple[str, bool], list[dict]] = defaultdict(list)
    for n in scan_res["literals"]:
        if n["cls"] in ("literal", "cited"):
            by[(n["text"], n["pct"])].append(n)
    for (text, pct), rows in sorted(by.items(), key=lambda kv: (-len(kv[1]), kv[0][0])):
        if len(rows) < min_repeats:
            continue
        fid = _fact_id(text, pct, used)
        val = float(text)
        entry: dict[str, Any] = {"id": fid, "kind": "value", "value": int(val) if val.is_integer() and not pct else val,
                                 "note": f"migrated candidate; appears {len(rows)} times as a literal"}
        if pct:
            entry["kind"] = "value"
        out.append({"id": fid, "text": text, "pct": pct, "count": len(rows),
                    "files": sorted({r["file"] for r in rows}), "entry": entry})
    return out


def _ah_yaml(scan_res: dict, profile: str, legacy_level: str) -> str:
    tex_root = "."
    views = scan_res["views"]
    prose = scan_res["prose_globs"]
    bib = scan_res["bib"] or ["references.bib"]
    data = {
        "project": scan_res["name"],
        "profile": profile,
        "tex": {
            "root": tex_root,
            "views": views,
            "prose": prose,
            "ignore": ["build/**", ".ah/**", "macros/**"],
            "bib": bib,
        },
        "facts": "facts/facts.yaml",
        "facts_macros": "macros/facts.tex",
        "sources": "sources/registry.yaml",
        "glossary": "glossary.yaml",
        "levels": {
            "NUM-001": legacy_level,  # leftover literals are a migration backlog, not a gate
            "BIB-02": "info",
            "BIB-05": "info",
        },
        "style": {"level": "info"},
    }
    if profile.startswith("grant/") or profile.startswith("rebuttal/"):
        data["data_policy"] = "restricted"
    return yaml.safe_dump(data, sort_keys=False)


def plan(root: Path, *, profile: str | None = None, dest: Path | None = None, facts: bool = False,
         bind_facts: bool = False, min_repeats: int = 2, legacy_level: str = "info") -> dict[str, Any]:
    scan_res = scan(root)
    prof = profile or scan_res["profile"]
    dest = (dest or root).resolve()
    cand = candidates(scan_res, min_repeats) if facts or bind_facts else []
    writes = {
        "ah.yaml": _ah_yaml(scan_res, prof, legacy_level),
        "facts/facts.yaml": yaml.safe_dump({"facts": [c["entry"] for c in cand]}, sort_keys=False) if cand
        else "facts: []\n",
        "sources/registry.yaml": "sources: []\n",
        "glossary.yaml": "terms: []\n",
        "outline.yaml": yaml.safe_dump(_outline(scan_res), sort_keys=False),
    }
    from . import profiles
    prof_obj = profiles.load(prof)
    if prof_obj:
        for rel, text in (prof_obj.scaffold or {}).items():
            if rel.endswith(".tex"):
                continue  # init-only prose; migrate keeps the author's files
            writes.setdefault(rel, text)
    warnings = []
    if scan_res.get("coverage", {}).get("unresolved"):
        warnings.append("some input files could not be resolved; inspect scan.coverage.unresolved before trusting coverage")
    if scan_res["profile"] == "generic" and not profile:
        warnings.append("document profile is ambiguous; using generic (select --profile explicitly)")
    if scan_res["has_ah_yaml"] and dest == Path(scan_res["root"]).resolve():
        warnings.append("ah.yaml already exists; --apply needs --force to overwrite it")
    if not scan_res["bib"]:
        warnings.append("no .bib file found; T2 will be empty until you add one")
    if bind_facts and not cand:
        warnings.append("no repeated literals to bind; lower --min-repeats or pass --facts")
    if dest != Path(scan_res["root"]).resolve():
        warnings.append(f"dest {dest} is a new tree; only overlay files are written, not a full copy of figures/data")
    recs = [
        "Run `ah units sync` then `ah facts build` then `ah audit` after applying.",
        "NUM-001 stays at info until you bind leftover literals (D2: macros are opt-in).",
        "Register sources with `ah source add` before T3.",
    ]
    if bind_facts:
        recs.insert(0, "Binding rewrites prose: each repeated literal becomes \\fact{id}. Review the diff.")
    return {
        "scan": {k: scan_res[k] for k in ("root", "name", "views", "documentclass", "bib", "prose_globs",
                                           "profile", "tex_files", "has_ah_yaml", "coverage", "profile_inference") if k in scan_res},
        "profile": prof,
        "dest": str(dest),
        "writes": {k: {"bytes": len(v), "sha1": sha1(v, 12)} for k, v in writes.items()},
        "_bodies": writes,  # stripped before JSON print
        "candidates": [{"id": c["id"], "text": c["text"], "pct": c["pct"], "count": c["count"], "files": c["files"]}
                       for c in cand],
        "_bind": cand,
        "bind_facts": bind_facts,
        "warnings": warnings,
        "recommendations": recs,
    }


def _ensure_macro_input(view: Path) -> bool:
    text = view.read_text()
    if re.search(r"\\input\{[^}]*macros/facts\}", text) or "macros/facts" in text:
        return False
    m = RE_BEGIN_DOC.search(text)
    if not m:
        return False
    insert = "% AH: generated fact macros — do not edit macros/facts.tex by hand\n\\input{macros/facts}\n"
    view.write_text(text[:m.start()] + insert + text[m.start():])
    return True


def _bind_literals(dest: Path, cand: list[dict]) -> list[dict]:
    """Replace repeated literal tokens with \\fact{id}. Leaves comments and existing macros alone."""
    changes = []
    items = sorted(cand, key=lambda c: (-len(c["text"]), c["id"]))
    files = sorted({f for c in items for f in c["files"]})
    for rel in files:
        path = dest / rel
        if not path.is_file():
            continue
        original = path.read_text()
        protected: list[str] = []

        def stash(m):
            protected.append(m.group(0))
            return f"\x00{len(protected) - 1}\x00"

        work = re.sub(r"\\fact\{[^}]*\}", stash, original)
        work = re.sub(r"(?<!\\)%.*$", stash, work, flags=re.M)
        file_hits = []
        for c in items:
            if rel not in c["files"]:
                continue
            tok = re.escape(c["text"])
            pct = r"(?:\s*\\?%)?" if c["pct"] else ""
            pat = re.compile(rf"(?<![\w.\\]){tok}{pct}(?![\w.])")
            n = 0

            def repl(_m, fid=c["id"], is_pct=c["pct"]):
                nonlocal n
                n += 1
                return f"\\fact{{{fid}}}\\%" if is_pct else f"\\fact{{{fid}}}"

            work = pat.sub(repl, work)
            if n:
                file_hits.append({"id": c["id"], "n": n})
        for i, s in enumerate(protected):
            work = work.replace(f"\x00{i}\x00", s, 1)
        if work != original:
            path.write_text(work)
            changes.append({"file": rel, "facts": file_hits})
    return changes


def apply(plan_res: dict, *, force: bool = False, yes: bool = False) -> dict[str, Any]:
    dest = Path(plan_res["dest"])
    dest.mkdir(parents=True, exist_ok=True)
    ah = dest / "ah.yaml"
    if ah.exists() and not force:
        raise FileExistsError(f"{ah} already exists; pass --force to overwrite the overlay files")
    if plan_res.get("bind_facts") and not yes:
        raise PermissionError("binding facts rewrites prose; pass --yes (a person must confirm)")
    written = []
    for rel, body in plan_res["_bodies"].items():
        path = dest / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
        written.append(rel)
    bound = []
    macro_in = False
    if plan_res.get("bind_facts") and plan_res.get("_bind"):
        bound = _bind_literals(dest, plan_res["_bind"])
        from .project import Project
        p = Project(dest)
        for v in p.view_files():
            if _ensure_macro_input(v):
                macro_in = True
    return {"dest": str(dest), "written": written, "bound": bound, "macro_input_added": macro_in,
            "profile": plan_res["profile"], "candidates": len(plan_res.get("candidates") or [])}
