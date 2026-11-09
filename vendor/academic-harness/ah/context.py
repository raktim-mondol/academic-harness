"""Everything a check may read, loaded once per run (so a run is a pure function of the snapshot)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .facts.model import FactSet, build_facts
from .project import Project
from .tex.inventory import UnitInv, inventory
from .tex.scan import markup_view, wrappers
from .tex.units import ParsedFile, Unit, load_units


@dataclass
class BibEntry:
    key: str
    kind: str
    fields: dict[str, str]
    file: str


def parse_bib(text: str, file: str) -> tuple[dict[str, BibEntry], list[str]]:
    """Brace-aware .bib parser. Returns (entries, duplicate keys)."""
    entries: dict[str, BibEntry] = {}
    dups: list[str] = []
    for m in re.finditer(r"^@(\w+)\s*\{\s*([^,\s]+)\s*,", text, re.M):
        kind, key = m.group(1).lower(), m.group(2)
        if kind in ("comment", "string", "preamble"):
            continue
        depth, i = 1, m.end()
        while i < len(text) and depth:
            c = text[i]
            depth += (c == "{") - (c == "}")
            i += 1
        body = text[m.end(): i - 1]
        fields: dict[str, str] = {}
        for fm in re.finditer(r"(\w+)\s*=\s*", body):
            name, j = fm.group(1).lower(), fm.end()
            if j >= len(body):
                continue
            if body[j] == "{":
                d, k = 1, j + 1
                while k < len(body) and d:
                    d += (body[k] == "{") - (body[k] == "}")
                    k += 1
                val = body[j + 1: k - 1]
            elif body[j] == '"':
                k = body.find('"', j + 1)
                val = body[j + 1: k if k > 0 else len(body)]
            else:
                mm = re.match(r"[^,\n]+", body[j:])
                val = mm.group(0).strip() if mm else ""
            fields.setdefault(name, re.sub(r"\s+", " ", val).strip())
        if key in entries:
            dups.append(key)
        entries[key] = BibEntry(key, kind, fields, file)
    return entries, dups


@dataclass
class Context:
    project: Project
    units: list[Unit]
    parsed: list[ParsedFile]
    inv: list[UnitInv]
    facts: FactSet
    fact_errors: list[str]
    bib: dict[str, BibEntry]
    bib_dups: list[str]
    registry: dict[str, dict]
    glossary: list[dict]
    bindings: list[dict]
    tex_texts: dict[str, str] = field(default_factory=dict)   # every .tex file as TeX executes it: comments, dead branches, verbatim bodies gone
    reachable: set[str] = field(default_factory=set)
    wrappers: dict = field(default_factory=dict)   # user macros that only wrap a cite, ref, label or input
    graph: dict = field(default_factory=dict)      # the input graph: reachable, unresolved, where the document ends early
    recheck: set[str] | None = None   # unit refs to re-derive; None = all (incremental audits)

    @property
    def cfg(self) -> dict:
        return self.project.cfg

    def unit_by_ref(self) -> dict[str, Unit]:
        return {unit_ref(u): u for u in self.units}


def unit_ref(u: Unit) -> str:
    """Anchor id when present, otherwise a content-addressed fallback so checks still work un-synced."""
    return u.uid or f"{u.file}#{u.hash}"


def _load_yaml(p: Path, key: str):
    if not p.exists():
        return []
    return (yaml.safe_load(p.read_text()) or {}).get(key, []) or []


def _reachable(project: Project, texts: dict[str, str]) -> set[str]:
    from .tex.inputs import input_graph
    return set(input_graph(texts, [project.rel(p) for p in project.view_files()])["reachable"])


def build_context(project: Project) -> Context:
    units, parsed = load_units(project)
    files = project.all_tex_files()
    views = {project.rel(p): markup_view(p.read_text(errors="replace")) for p in files}
    table = wrappers(views.values())
    inv = inventory(units, table)
    fs, errs = build_facts(project)
    bib: dict[str, BibEntry] = {}
    dups: list[str] = []
    for bp in project.bib_files():
        e, d = parse_bib(bp.read_text(errors="replace"), project.rel(bp))
        for k, v in e.items():
            if k in bib:
                dups.append(k)
            bib[k] = v
        dups += d
    registry = {s["id"]: s for s in _load_yaml(project.path("sources"), "sources")}
    macros = project.macros_file().resolve()
    texts = {project.rel(p): views[project.rel(p)] for p in files if p.resolve() != macros}
    ctx = Context(project, units, parsed, inv, fs, errs, bib, sorted(set(dups)), registry,
                  _load_yaml(project.path("glossary"), "terms"), _load_yaml(project.path("bindings"), "bindings"),
                  texts)
    ctx.wrappers = table
    from .tex.inputs import input_graph
    ctx.graph = input_graph(texts, [project.rel(p) for p in project.view_files()])
    ctx.reachable = set(ctx.graph["reachable"])
    from .claim_sidecar import sidecar_fact_bindings
    ctx.bindings = list(ctx.bindings) + sidecar_fact_bindings(project)      # claim bindings count like bindings.yaml
    return ctx
