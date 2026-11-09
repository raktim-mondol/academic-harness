"""Reviewer comments and the response letter (design 8.5).

Import splits a review into numbered items. Each item is mapped to the units it concerns and given a status and a
response. The letter is built from the items and from real diffs against the snapshot taken at import: an item
cannot be marked addressed unless a unit mapped to it actually changed.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

from . import snapshots
from .context import Context, unit_ref
from .order import heading_of
from .project import Project

STATUSES = ("open", "addressed", "rebutted", "declined", "decision-needed")

ITEM_PATTERNS = [
    re.compile(r"^\s*(?:major|minor)?\s*(?:comment|point|concern|issue|question|suggestion)\s*#?\s*(\d+)\s*[:.)\-–]\s*(.*)$", re.I),
    re.compile(r"^\s*(?:R\d+[.\-])?(\d+)\s*[.)]\s+(\S.*)$"),
]
HEADING = re.compile(r"^\s*#*\s*(major|minor)\b.*$", re.I)


def parse_review(text: str) -> list[dict]:
    """Numbered items, with major/minor taken from the nearest heading. Falls back to one item per paragraph."""
    items: list[dict] = []
    kind = "major"
    cur: dict | None = None
    for line in text.splitlines():
        h = HEADING.match(line)
        if h and len(line.split()) <= 6 and not any(p.match(line) for p in ITEM_PATTERNS):
            kind = h.group(1).lower()
            continue
        m = next((p.match(line) for p in ITEM_PATTERNS if p.match(line)), None)
        if m:
            if cur:
                items.append(cur)
            cur = {"n": int(m.group(1)), "kind": kind, "text": m.group(2).strip()}
        elif cur is not None and line.strip():
            cur["text"] += " " + line.strip()
        elif cur is not None and not line.strip():
            continue
    if cur:
        items.append(cur)
    if items:
        return items
    paras = [re.sub(r"\s+", " ", x).strip() for x in re.split(r"\n\s*\n", text) if len(x.split()) >= 6]
    return [{"n": i + 1, "kind": "major", "text": x} for i, x in enumerate(paras)]


def rpath(p: Project, rid: str) -> Path:
    return p.root / p.cfg["reviews"] / f"{rid}.yaml"


def load_review(p: Project, rid: str) -> dict | None:
    f = rpath(p, rid)
    return yaml.safe_load(f.read_text()) if f.exists() else None


def load_all(p: Project) -> list[dict]:
    d = p.root / p.cfg["reviews"]
    return [yaml.safe_load(f.read_text()) for f in sorted(d.glob("*.yaml"))] if d.exists() else []


def save_review(p: Project, rev: dict) -> None:
    f = rpath(p, rev["review"])
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(yaml.safe_dump(rev, sort_keys=False, allow_unicode=True))


def import_review(ctx: Context, src: Path, rid: str) -> dict:
    p = ctx.project
    if rpath(p, rid).exists():
        raise ValueError(f"review '{rid}' already exists")
    items = parse_review(src.read_text(errors="replace"))
    snap = f"review-{rid}-start"
    if snapshots.load(p, snap) is None:
        snapshots.save(ctx, snap)
    rev = {"review": rid, "source": src.name, "snapshot": snap,
           "items": [{"id": f"{rid}.{it['n']}", "kind": it["kind"], "text": it["text"], "status": "open", "units": [], "response": ""} for it in items]}
    save_review(p, rev)
    return rev


def record_coverage(p: Project, rid: str, rows: list[dict]) -> None:
    """Store the triage tag on each item: where the comment stands against the checks that already exist."""
    rev = load_review(p, rid)
    if rev is None:
        raise ValueError(f"no review '{rid}'")
    by_id = {r["id"]: r for r in rows}
    for it in rev["items"]:
        r = by_id.get(it["id"])
        if r:
            it["coverage"] = r["tag"]
    save_review(p, rev)


def set_item(p: Project, item_id: str, units: list[str] | None = None, status: str | None = None, response: str | None = None) -> dict:
    rid = item_id.rsplit(".", 1)[0]
    rev = load_review(p, rid)
    if rev is None:
        raise ValueError(f"no review '{rid}'")
    it = next((i for i in rev["items"] if i["id"] == item_id), None)
    if it is None:
        raise ValueError(f"no item '{item_id}'")
    if status:
        if status not in STATUSES:
            raise ValueError(f"status must be one of {STATUSES}")
        it["status"] = status
    if units is not None:
        it["units"] = units
    if response is not None:
        it["response"] = response
    save_review(p, rev)
    return it


def render(ctx: Context, text: str) -> str:
    """What a reader would see: facts replaced by their values, TeX escapes for % and ~ undone. Citations stay as markup."""
    from .tex.text import RE_FACT

    def val(m):
        try:
            return ctx.facts.plain(m.group(1).strip())
        except Exception:
            return m.group(0)
    t = RE_FACT.sub(val, text)
    t = t.replace("\\%", "%").replace("{,}", ",").replace("\\,", "").replace("~", " ")
    return re.sub(r"\s+", " ", t).strip()


def _bag(text: str):
    from collections import Counter
    return Counter(re.findall(r"[\w.%/\-]+", text.lower()))


def changes_for(ctx: Context, rev: dict) -> dict:
    d = snapshots.diff(ctx, rev["snapshot"])
    for c in d["changed"]:
        b, a = render(ctx, c["before"]), render(ctx, c["after"])
        c["visible"] = _bag(b) != _bag(a)        # a change adds or removes something; pure re-ordering or re-expression does not
        c["diff"] = snapshots.word_diff(b, a) if c["visible"] else (
            "(no word, number or symbol was added or removed: the unit was re-expressed or re-ordered, for example typed numbers now generated "
            "from the project's data; nothing new for a reader)")
    by_unit = {c["unit"]: ("changed", c) for c in d["changed"]}
    by_unit.update({a["unit"]: ("added", a) for a in d["added"]})
    by_unit.update({r["unit"]: ("removed", r) for r in d["removed"]})
    return {"diff": d, "by_unit": by_unit}


def check_review(ctx: Context, rev: dict) -> list[dict]:
    """Findings as dicts for the T5 tier."""
    out = []
    try:
        ch = changes_for(ctx, rev)
    except ValueError as e:                  # a missing snapshot is a finding, not a crash of the whole audit
        return [{"check": "REV-06", "level": "major", "key": f"{rev['review']}:snapshot", "ref": None, "file": None,
                 "message": f"[review {rev['review']}] {e}; changes cannot be compared. Import the review again or restore the snapshot"}]
    by_unit = ch["by_unit"]
    known = {unit_ref(u) for u in ctx.units}
    mapped: set[str] = set()
    rid = rev["review"]

    def add(check, level, key, msg):
        out.append({"check": check, "level": level, "key": f"{rid}:{key}", "message": f"[review {rid}] {msg}", "ref": None, "file": None})

    for it in rev["items"]:
        for u in it.get("units") or []:
            mapped.add(u)
            if u not in known and u not in by_unit:
                add("REV-05", "major", f"{it['id']}:{u}", f"{it['id']} is mapped to unit {u}, which does not exist")
        st = it["status"]
        if st == "open":
            add("REV-02", "info", f"{it['id']}:open", f"{it['id']} is still open")
        if st in ("addressed", "rebutted", "declined") and not (it.get("response") or "").strip():
            add("REV-04", "major", f"{it['id']}:noresp", f"{it['id']} is {st} but has no response text")
        if st == "addressed":
            if not (it.get("units") or []):
                add("REV-01", "major", f"{it['id']}:nounits", f"{it['id']} is addressed but is mapped to no unit")
            elif not any(u in by_unit for u in it["units"]):
                add("REV-01", "major", f"{it['id']}:nochange", f"{it['id']} is addressed but none of its units changed since the snapshot")
            elif not any(u in by_unit and (by_unit[u][0] != "changed" or by_unit[u][1].get("visible", True)) for u in it["units"]):
                add("REV-01", "major", f"{it['id']}:invisible",
                    f"{it['id']} is addressed but its units were only re-expressed or re-ordered (for example typed numbers became facts); no word or number was added or removed")
    for uid in by_unit:
        if uid not in mapped:
            add("REV-03", "info", f"unmapped:{uid}", f"unit {uid} changed since the snapshot but belongs to no review item")
    return out


def _tex_escape(s: str) -> str:
    return re.sub(r"([#$%&_{}])", r"\\\1", s.replace("\\", "\\textbackslash{}"))


def letter(ctx: Context, rev: dict, fmt: str = "md") -> str:
    ch = changes_for(ctx, rev)
    by_unit = ch["by_unit"]
    unitobj = {unit_ref(u): u for u in ctx.units}
    md = [f"# Response to reviewer comments ({rev['review']})", "",
          f"Changes below are computed from the text against the snapshot `{rev['snapshot']}`. Added text is shown as {{+like this+}}, removed text as [-like this-].", ""]
    for it in rev["items"]:
        md += [f"## {it['id']} ({it['kind']})", "", f"> {it['text']}", "", f"**Response ({it['status']}).** {render(ctx, it.get('response') or '') or '(no response yet)'}", ""]
        shown = 0
        for uid in it.get("units") or []:
            kind, rec = by_unit.get(uid, (None, None))
            u = unitobj.get(uid)
            where = f"{rec['file'] if rec else (u.file if u else '?')}, unit `{uid}`" + (f", section \"{heading_of(ctx, u)}\"" if u and heading_of(ctx, u) else "")
            if kind == "changed":
                md += [f"- Changed ({where}):" if rec.get("visible", True) else f"- Representation only ({where}):", f"  {rec['diff']}", ""]
                shown += 1 if rec.get("visible", True) else 0
            elif kind == "added":
                md += [f"- Added ({where}):", f"  {{+{rec['after']}+}}", ""]
                shown += 1
            elif kind == "removed":
                md += [f"- Removed ({where}):", f"  [-{rec['before']}-]", ""]
                shown += 1
            else:
                md += [f"- No change in {where}.", ""]
        if it["status"] == "addressed" and not shown:
            md += ["- WARNING: marked addressed but no mapped unit changed in a way a reader would see.", ""]
    text = "\n".join(md)
    if fmt == "md":
        return text
    tex = [r"\section*{Response to reviewer comments}"]
    for it in rev["items"]:
        tex += [rf"\subsection*{{{_tex_escape(it['id'])} ({it['kind']})}}", r"\begin{quote}", _tex_escape(it["text"]), r"\end{quote}",
                rf"\textbf{{Response ({it['status']}).}} {_tex_escape(it.get('response') or '(no response yet)')}", ""]
        for uid in it.get("units") or []:
            kind, rec = by_unit.get(uid, (None, None))
            if kind == "changed":
                tex += [rf"\par\noindent Changed in \texttt{{{_tex_escape(rec['file'])}}}:", r"\begin{verbatim}", rec["diff"], r"\end{verbatim}"]
            elif kind == "added":
                tex += [rf"\par\noindent Added in \texttt{{{_tex_escape(rec['file'])}}}:", r"\begin{verbatim}", rec["after"], r"\end{verbatim}"]
            elif kind == "removed":
                tex += [rf"\par\noindent Removed from \texttt{{{_tex_escape(rec['file'])}}}.", ""]
    return "\n".join(tex)
