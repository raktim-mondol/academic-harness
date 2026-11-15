"""Outline and thesis (design 8.4): what the document claims and which units carry each claim.

outline.yaml:
  status: draft | approved   # missing is legacy (unlocked)
  thesis: "one sentence"
  sections:   [{file: "sections/03_results/*", purpose: "...", planned: true}]
  claims:     [{id: t1, text: "...", units: [results_main.p002, ...], supports: [thesis]}]
Checks: ARG-01 a thesis-level claim must name units that exist (or are planned);
ARG-02 a declared section must match a file unless `planned: true`;
ARG-03 some claim supports the thesis when any claims exist;
ARG-04 supports names a missing id;
ARG-05 a planned file is still unwritten after approve;
ARG-06 a present draft block (literature, citation hints, figures, section points) is malformed.
"""
from __future__ import annotations

import fnmatch

import yaml

from .context import Context, unit_ref


def load_outline(p) -> dict:
    f = p.root / p.cfg["outline"]
    return (yaml.safe_load(f.read_text()) or {}) if f.exists() else {}


def save_outline(p, data: dict) -> None:
    f = p.root / p.cfg["outline"]
    f.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def section_matches(rel: str, pat: str) -> bool:
    pat = (pat or "").lstrip("./")
    rel = rel.lstrip("./")
    return fnmatch.fnmatch(rel, pat) or rel == pat or rel.endswith("/" + pat)


def _unit_is_planned(o: dict, uid: str) -> bool:
    """A missing unit is allowed while some outline section is still planned."""
    return any(s.get("planned") for s in (o.get("sections") or []))


def check_outline(ctx: Context) -> list[dict]:
    o = load_outline(ctx.project)
    out = []
    known = {unit_ref(u) for u in ctx.units}
    claims = o.get("claims") or []
    for c in claims:
        us = c.get("units") or []
        if not us:
            out.append({"check": "ARG-01", "level": "major", "key": f"claim:{c.get('id')}:none", "ref": None, "file": None,
                        "message": f"outline claim {c.get('id')} is supported by no unit: \"{str(c.get('text'))[:100]}\""})
        for u in us:
            if u not in known and not _unit_is_planned(o, u):
                out.append({"check": "ARG-01", "level": "major", "key": f"claim:{c.get('id')}:{u}", "ref": None, "file": None,
                            "message": f"outline claim {c.get('id')} names unit {u}, which does not exist"})
    for s in o.get("sections") or []:
        pat = s.get("file", "")
        if s.get("planned"):
            continue
        if not any(section_matches(f, pat) for f in ctx.tex_texts):
            out.append({"check": "ARG-02", "level": "major", "key": f"section:{pat}", "ref": None, "file": None,
                        "message": f"outline section '{pat}' matches no file ({str(s.get('purpose', ''))[:60]})"})
    if claims and not any("thesis" in (c.get("supports") or []) for c in claims):
        out.append({"check": "ARG-03", "level": "major", "key": "thesis:unsupported", "ref": None, "file": None,
                    "message": "outline has claims but none have supports: [thesis]"})
    ids = {c.get("id") for c in claims}
    for c in claims:
        for parent in c.get("supports") or []:
            if parent == "thesis":
                continue
            if parent not in ids:
                out.append({"check": "ARG-04", "level": "minor", "key": f"claim:{c.get('id')}:supports:{parent}",
                            "ref": None, "file": None,
                            "message": f"outline claim {c.get('id')} supports unknown id {parent}"})
    if o.get("status") == "approved":
        for s in o.get("sections") or []:
            if not s.get("planned"):
                continue
            pat = s.get("file", "")
            if not any(section_matches(f, pat) for f in ctx.tex_texts):
                out.append({"check": "ARG-05", "level": "info", "key": f"planned:{pat}", "ref": None, "file": None,
                            "message": f"planned section '{pat}' is still unwritten"})
    # Imported here: plan.py imports this module at load time.
    from .plan import draft_errors
    for i, message in enumerate(draft_errors(o)):
        out.append({"check": "ARG-06", "level": "minor", "key": f"draft:{i}", "ref": None,
                    "file": ctx.project.cfg["outline"], "message": message})
    return out
