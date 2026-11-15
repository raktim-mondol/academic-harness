"""Plan workflow (design 8.1): the agent proposes an outline; the author approves; nothing is written yet.

plans/<id>.yaml is a pending outline. `ah plan approve` (human-only) writes outline.yaml
and records a file snapshot so PLN-01 can see prose that appeared afterwards.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import yaml

from .briefs import load_briefs
from .context import Context
from .outline import load_outline, save_outline, section_matches
from .project import Project
from .util import sha1

# Optional draft contract on an outline. Absent keys are valid. A present key
# must match this shape or propose() refuses to write the proposal.
DRAFT_KEYS = ("literature", "citation_hints", "figures", "section_points")
HINT_KINDS = {"dataset", "metric", "baseline", "model", "method", "other"}
FIGURE_TYPES = {"plot", "diagram"}
FIGURE_SOURCES = {"experiment", "idea", "both"}
ASPECTS = {"1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"}
_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_CUTOFF = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


def _text(value, label: str, errors: list[str]) -> str:
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{label} must be a non-empty string")
        return ""
    return value.strip()


def _object(value, label: str, allowed: set[str], errors: list[str]) -> dict | None:
    if not isinstance(value, dict):
        errors.append(f"{label} must be an object")
        return None
    extra = sorted(set(value) - allowed)
    if extra:
        errors.append(f"{label} has unknown fields: {', '.join(extra)}")
        return None
    return value


def _queries(value, label: str, errors: list[str]) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= 8:
        errors.append(f"{label} needs 1 to 8 search queries")
        return []
    out = []
    for i, query in enumerate(value, 1):
        if not isinstance(query, str) or not query.strip():
            errors.append(f"{label} query {i} must be a non-empty string")
        else:
            out.append(query.strip())
    return out


def _section_known(sections: list, file: str) -> bool:
    return any(section_matches(file, s.get("file", "")) for s in sections if isinstance(s, dict))


def draft_errors(outline: dict) -> list[str]:
    """Shape errors in the optional draft blocks. An outline without them has none."""
    if not isinstance(outline, dict):
        return ["outline must be an object"]
    errors: list[str] = []
    sections = outline.get("sections") or []
    if not isinstance(sections, list):
        sections = []

    if "literature" in outline:
        lit = _object(outline.get("literature"), "literature",
                      {"cutoff", "introduction", "related_work"}, errors)
        if lit is not None:
            cutoff = lit.get("cutoff")
            if not isinstance(cutoff, str) or not _CUTOFF.match(cutoff):
                errors.append("literature.cutoff must be YYYY-MM")
            intro = _object(lit.get("introduction"), "literature.introduction",
                            {"hook", "gap", "searches"}, errors)
            if intro is not None:
                _text(intro.get("hook"), "literature.introduction.hook", errors)
                _text(intro.get("gap"), "literature.introduction.gap", errors)
                _queries(intro.get("searches"), "literature.introduction.searches", errors)
            related = lit.get("related_work")
            if not isinstance(related, list) or not related:
                errors.append("literature.related_work needs at least one cluster")
            else:
                for i, cluster in enumerate(related, 1):
                    label = f"literature.related_work[{i}]"
                    row = _object(cluster, label, {"cluster", "searches", "limitation", "bridge"}, errors)
                    if row is None:
                        continue
                    _text(row.get("cluster"), f"{label}.cluster", errors)
                    _queries(row.get("searches"), f"{label}.searches", errors)
                    _text(row.get("limitation"), f"{label}.limitation", errors)
                    _text(row.get("bridge"), f"{label}.bridge", errors)

    if "citation_hints" in outline:
        hints = outline.get("citation_hints")
        if not isinstance(hints, list):
            errors.append("citation_hints must be a list")
        else:
            for i, hint in enumerate(hints, 1):
                label = f"citation_hints[{i}]"
                row = _object(hint, label, {"name", "kind", "query", "title", "section"}, errors)
                if row is None:
                    continue
                _text(row.get("name"), f"{label}.name", errors)
                if row.get("kind") not in HINT_KINDS:
                    errors.append(f"{label}.kind must be one of {', '.join(sorted(HINT_KINDS))}")
                has_query = isinstance(row.get("query"), str) and row.get("query").strip()
                has_title = isinstance(row.get("title"), str) and row.get("title").strip()
                if not has_query and not has_title:
                    errors.append(f"{label} needs a query or an exact title")
                if "query" in row and not has_query:
                    errors.append(f"{label}.query must be a non-empty string")
                if "title" in row and not has_title:
                    errors.append(f"{label}.title must be a non-empty string")
                section = row.get("section")
                if section is not None:
                    if not isinstance(section, str) or not section.strip():
                        errors.append(f"{label}.section must be a non-empty string")
                    elif not _section_known(sections, section.strip()):
                        errors.append(f"{label}.section matches no outline section")

    if "figures" in outline:
        figures = outline.get("figures")
        if not isinstance(figures, list):
            errors.append("figures must be a list")
        else:
            for i, figure in enumerate(figures, 1):
                label = f"figures[{i}]"
                row = _object(figure, label, {"id", "type", "source", "experiment", "objective", "aspect"}, errors)
                if row is None:
                    continue
                fig_id = row.get("id")
                if not isinstance(fig_id, str) or not _TOKEN.match(fig_id) or "figure" in fig_id.lower():
                    errors.append(f"{label}.id must be a token and must not contain 'figure'")
                if row.get("type") not in FIGURE_TYPES:
                    errors.append(f"{label}.type must be plot or diagram")
                source = row.get("source")
                if source not in FIGURE_SOURCES:
                    errors.append(f"{label}.source must be experiment, idea, or both")
                experiment = row.get("experiment")
                needs_experiment = source in {"experiment", "both"}
                if needs_experiment:
                    if not isinstance(experiment, str) or not _TOKEN.match(experiment):
                        errors.append(f"{label}.experiment must name an experiment slug")
                elif experiment is not None:
                    errors.append(f"{label}.experiment is set only when source is experiment or both")
                if row.get("type") == "plot" and source == "idea":
                    errors.append(f"{label} is a plot, so source cannot be idea alone")
                _text(row.get("objective"), f"{label}.objective", errors)
                if row.get("aspect") not in ASPECTS:
                    errors.append(f"{label}.aspect must be one of {', '.join(sorted(ASPECTS))}")

    if "section_points" in outline:
        points = outline.get("section_points")
        if not isinstance(points, list):
            errors.append("section_points must be a list")
        else:
            for i, point in enumerate(points, 1):
                label = f"section_points[{i}]"
                row = _object(point, label, {"file", "point"}, errors)
                if row is None:
                    continue
                file = row.get("file")
                if not isinstance(file, str) or not file.strip():
                    errors.append(f"{label}.file must be a non-empty string")
                elif not _section_known(sections, file.strip()):
                    errors.append(f"{label}.file matches no outline section")
                _text(row.get("point"), f"{label}.point", errors)
    return errors


def validate_draft(outline: dict) -> None:
    errors = draft_errors(outline)
    if errors:
        raise ValueError("; ".join(errors))


def _cutoff_of(outline: dict) -> tuple[str | None, int | None]:
    lit = outline.get("literature")
    if not isinstance(lit, dict):
        return None, None
    cutoff = lit.get("cutoff")
    match = _CUTOFF.match(cutoff) if isinstance(cutoff, str) else None
    if not match:
        return None, None
    return cutoff, int(match.group(1))


def draft_queries(outline: dict) -> list[dict]:
    """Search tasks the approved outline names. Invalid blocks raise instead of returning a partial list."""
    validate_draft(outline)
    cutoff, year_max = _cutoff_of(outline)
    rows = []

    def add(kind: str, query: str, *, name=None, cluster=None, section=None, title=None):
        rows.append({
            "kind": kind,
            "query": query,
            "cutoff": cutoff,
            "year_max": year_max,
            "name": name,
            "cluster": cluster,
            "section": section,
            "title": title,
        })

    lit = outline.get("literature") if isinstance(outline.get("literature"), dict) else None
    if lit:
        intro = lit.get("introduction") or {}
        for query in intro.get("searches") or []:
            add("intro", query.strip())
        for cluster in lit.get("related_work") or []:
            name = cluster.get("cluster", "").strip()
            for query in cluster.get("searches") or []:
                add("related", query.strip(), cluster=name)
    for hint in outline.get("citation_hints") or []:
        query = hint.get("query") or hint.get("title") or ""
        title = hint.get("title")
        add("hint", str(query).strip(), name=hint.get("name"),
            section=hint.get("section"), title=title.strip() if isinstance(title, str) else None)
    return rows


def draft_counts(outline: dict) -> dict:
    """How many draft-contract entries an outline carries. Malformed blocks still count."""
    if not isinstance(outline, dict):
        outline = {}
    lit = outline.get("literature") if isinstance(outline.get("literature"), dict) else {}
    intro = lit.get("introduction") if isinstance(lit.get("introduction"), dict) else {}
    intro_n = len(intro.get("searches")) if isinstance(intro.get("searches"), list) else 0
    related_n = 0
    related = lit.get("related_work") if isinstance(lit.get("related_work"), list) else []
    for cluster in related:
        if isinstance(cluster, dict) and isinstance(cluster.get("searches"), list):
            related_n += len(cluster["searches"])

    def nlist(key: str) -> int:
        value = outline.get(key)
        return len(value) if isinstance(value, list) else 0

    return {
        "literature_searches": intro_n + related_n,
        "citation_hints": nlist("citation_hints"),
        "figures": nlist("figures"),
        "section_points": nlist("section_points"),
    }


def plans_dir(p: Project) -> Path:
    return p.root / p.cfg.get("plans", "plans")


def lock_path(p: Project) -> Path:
    return p.state_dir / "plan_lock.json"


def outline_sha(p: Project) -> str:
    f = p.root / p.cfg["outline"]
    return sha1(f.read_bytes()) if f.exists() else ""


def current_prose(p: Project) -> list[str]:
    return sorted(p.rel(f) for f in p.prose_files())


def load_lock(p: Project) -> dict:
    f = lock_path(p)
    if f.exists():
        return json.loads(f.read_text())
    return {}


def write_lock(p: Project, files: list[str] | None = None, sha: str | None = None) -> dict:
    p.state_dir.mkdir(parents=True, exist_ok=True)
    lock = load_lock(p)
    if files is not None:
        lock["files"] = list(files)
    if sha is not None:
        lock["outline_sha"] = sha
    lock_path(p).write_text(json.dumps(lock, indent=1) + "\n")
    return lock


def ensure_lock(p: Project) -> dict:
    """Grandfather the current prose files the first time Plan checks run."""
    lock = load_lock(p)
    if "files" not in lock:
        lock = write_lock(p, files=current_prose(p))
    return lock


def load_proposals(p: Project) -> list[dict]:
    d = plans_dir(p)
    out = []
    for f in sorted(d.glob("*.yaml")) if d.exists() else []:
        rec = yaml.safe_load(f.read_text()) or {}
        rec.setdefault("id", f.stem)
        rec["_path"] = str(f)
        out.append(rec)
    return out


def get_proposal(p: Project, pid: str) -> dict | None:
    return next((r for r in load_proposals(p) if r.get("id") == pid), None)


def propose(p: Project, data: dict) -> dict:
    """Write a pending proposal. Does not touch outline.yaml."""
    pid = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(data.get("id") or "")).strip("-")
    if not pid:
        raise ValueError("a plan proposal needs an id")
    outline = data.get("outline") or {k: v for k, v in data.items() if k not in ("id", "outline")}
    if not outline:
        raise ValueError("a plan proposal needs an outline (thesis, sections, claims)")
    validate_draft(outline)
    d = plans_dir(p)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{pid}.yaml"
    if path.exists():
        raise ValueError(f"plan proposal '{pid}' already exists")
    rec = {"id": pid, "status": "pending", "outline": outline}
    path.write_text(yaml.safe_dump(rec, sort_keys=False, allow_unicode=True))
    return rec


def new_outline(p: Project, data: dict) -> dict:
    """Create or replace a missing outline as a draft. Will not overwrite an existing file."""
    f = p.root / p.cfg["outline"]
    if f.exists():
        raise ValueError(f"{p.cfg['outline']} already exists; propose a change with `ah plan propose`")
    validate_draft(data)
    ol = {**data, "status": "draft"}
    save_outline(p, ol)
    write_lock(p, files=current_prose(p))
    return ol


def approve(p: Project, pid: str) -> dict:
    rec = get_proposal(p, pid)
    if rec is None:
        raise ValueError(f"no plan proposal '{pid}'")
    if rec.get("status") != "pending":
        raise ValueError(f"proposal '{pid}' is {rec.get('status')}, not pending")
    ol = dict(rec.get("outline") or {})
    ol["status"] = "approved"
    save_outline(p, ol)
    rec["status"] = "accepted"
    Path(rec["_path"]).write_text(yaml.safe_dump({k: v for k, v in rec.items() if k != "_path"},
                                                 sort_keys=False, allow_unicode=True))
    write_lock(p, files=current_prose(p), sha=outline_sha(p))
    return ol


def diff_text(p: Project, pid: str) -> str:
    rec = get_proposal(p, pid)
    if rec is None:
        raise ValueError(f"no plan proposal '{pid}'")
    cur = load_outline(p)
    new = rec.get("outline") or {}
    return ("--- outline.yaml\n" + yaml.safe_dump(cur, sort_keys=False, allow_unicode=True)
            + "+++ proposal " + pid + "\n" + yaml.safe_dump(new, sort_keys=False, allow_unicode=True))


def _brief_files(p: Project) -> set[str]:
    out = set()
    for b in load_briefs(p):
        if not b.approved:
            continue
        f = str(b.data.get("file") or "").lstrip("./")
        if f:
            out.add(f)
    return out


def check_plan(ctx: Context) -> list[dict]:
    """PLN-01 stray or early prose under sections/; PLN-02 approved outline edited outside approve."""
    p, out = ctx.project, []
    o = load_outline(p)
    lock = load_lock(p)
    approved = o.get("status") == "approved"
    allowed_briefs = _brief_files(p)
    sections = o.get("sections") or []
    draft = o.get("status") == "draft"

    for rel in current_prose(p):
        if not rel.startswith("sections/"):
            continue
        if rel in allowed_briefs:
            continue
        matched = [s for s in sections if section_matches(rel, s.get("file", ""))]
        if not matched:
            out.append({"check": "PLN-01", "level": "blocker", "key": f"new:{rel}", "ref": None, "file": rel,
                        "message": f"new prose file {rel} is not in the approved outline and has no approved brief"})
            continue
        if draft and matched and all(s.get("planned") for s in matched):
            out.append({"check": "PLN-01", "level": "blocker", "key": f"early:{rel}", "ref": None, "file": rel,
                        "message": f"{rel} is planned but the outline is still a draft; do not write it yet"})

    if approved and lock.get("outline_sha") and lock["outline_sha"] != outline_sha(p):
        out.append({"check": "PLN-02", "level": "major", "key": "outline-hash", "ref": None, "file": p.cfg["outline"],
                    "message": "approved outline.yaml changed outside `ah plan approve`"})
    return out
