"""Export the library as a bibliography, and keep a project ``.bib`` in sync.

A managed ``.bib`` carries a header and begin/end markers. Everything between
the markers is rewritten on export; text after the ``hand-added`` marker is
never touched. If someone edits inside the managed block, export refuses to
overwrite it unless forced (and then keeps a timestamped backup). An existing
``.bib`` that PaperMemory did not write is only taken over with ``adopt``.
"""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

from papermemory import bibwrite
from papermemory.bibparse import parse_bib
from papermemory.db import Store
from papermemory.library import resolve_paper_id
from papermemory.library_query import QueryError, matching_ids, parse_query, rows_for_ids
from papermemory.library_store import csl_from_paper_row, extra_from_paper_row
from papermemory.util import loads, now_iso, slugify

FORMATS = ("bibtex", "biblatex", "csl-json", "ris", "json", "csv")
FILE_FORMATS = ("bibtex", "biblatex")
MAX_INLINE = 500
BEGIN = "% --- papermemory:begin ---"
END = "% --- papermemory:end ---"
HAND = "% --- papermemory:hand-added ---"
_HEADER_HASH = re.compile(r"^% managed-sha256: ([0-9a-f]{64})\s*$", re.M)


class ExportError(Exception):
    def __init__(self, code: str, message: str, **detail: Any):
        super().__init__(message)
        self.code = code
        self.detail = detail


# ---------- scope ----------


def _manuscript_keys(store: Store, ms: Any) -> list[str]:
    from papermemory.citations import scan_tex_tree

    root = Path(ms["root_path"]) if ms["root_path"] else None
    if root and root.exists():
        return sorted({hit["key"] for hit in scan_tex_tree(root)})
    rows = store.conn.execute("SELECT DISTINCT bibtex_key FROM citations WHERE manuscript_id=?", (ms["id"],)).fetchall()
    return sorted(r["bibtex_key"] for r in rows)


def select_papers(
    store: Store, *, query: list[str] | str | None = None, collection: str | None = None,
    project: str | None = None, cited_only: str | None = None, everything: bool = False,
) -> tuple[list[str], dict[str, Any]]:
    """Paper ids to export, plus notes (``missing_keys`` for cited keys that resolve to nothing)."""
    tokens = parse_query(query)
    if collection:
        tokens.filters.append((False, "collection", collection))
    if project:
        tokens.filters.append((False, "project", project))
    notes: dict[str, Any] = {}
    if not (tokens.filters or tokens.terms or cited_only or everything):
        raise ExportError("no-scope", "give a filter, --collection, --project, --cited-only, or --all")
    ids = matching_ids(store, tokens)
    if cited_only:
        ms = store.get_manuscript(cited_only)
        if ms is None:
            raise ExportError("manuscript-not-found", f"no manuscript {cited_only!r}")
        cited: list[str] = []
        missing: list[str] = []
        for key in _manuscript_keys(store, ms):
            paper_id = resolve_paper_id(store, key, project_id=ms["slug"])
            (cited if paper_id else missing).append(paper_id or key)
        allowed = set(cited)
        ids = [i for i in ids if i in allowed] if (tokens.filters or tokens.terms) else list(dict.fromkeys(cited))
        notes["missing_keys"] = missing
        notes["manuscript"] = ms["slug"]
    return ids, notes


# ---------- keys ----------


def export_keys(store: Store, ids: list[str], project: str | None, *, assign: bool = True) -> tuple[dict[str, str], list[str]]:
    """paper id -> the key to write. A project's own key wins; collisions fall back to library keys."""
    conn = store.conn
    chosen: dict[str, str] = {}
    warnings: list[str] = []
    missing = []
    lib: dict[str, str] = {}
    for start in range(0, len(ids), 400):
        chunk = ids[start:start + 400]
        marks = ",".join("?" for _ in chunk)
        for r in conn.execute(f"SELECT paper_id, key FROM bib_keys WHERE paper_id IN ({marks})", chunk):
            lib[r["paper_id"]] = r["key"]
    for paper_id in ids:
        if paper_id not in lib:
            missing.append(paper_id)
    if missing:
        if not assign:
            raise ExportError("missing-keys", f"{len(missing)} paper(s) have no key; run `library keys assign`", papers=missing[:20])
        from papermemory.library_keys import assign_for

        assign_for(store, missing)
        for start in range(0, len(missing), 400):
            chunk = missing[start:start + 400]
            marks = ",".join("?" for _ in chunk)
            for r in conn.execute(f"SELECT paper_id, key FROM bib_keys WHERE paper_id IN ({marks})", chunk):
                lib[r["paper_id"]] = r["key"]
        warnings.append(f"assigned keys to {len(missing)} paper(s) that had none")
    alias: dict[str, str] = {}
    if project:
        for start in range(0, len(ids), 400):
            chunk = ids[start:start + 400]
            marks = ",".join("?" for _ in chunk)
            for r in conn.execute(
                f"""SELECT paper_id, key FROM bib_key_aliases WHERE project_key=? AND source LIKE 'import:%'
                    AND paper_id IN ({marks}) ORDER BY first_seen, key""", [project, *chunk]):
                alias.setdefault(r["paper_id"], r["key"])
    used: dict[str, str] = {}
    for paper_id in ids:  # first pass: library keys for papers without a project alias
        if paper_id not in alias:
            used[lib[paper_id]] = paper_id
    for paper_id in ids:
        key = alias.get(paper_id, lib[paper_id])
        if key in used and used[key] != paper_id:
            fallback = lib[paper_id]
            if fallback in used and used[fallback] != paper_id:
                raise ExportError("key-clash", f"cannot export both papers under {key!r}")
            warnings.append(f"{key}: another exported paper owns this key; wrote {fallback} instead")
            key = fallback
        used[key] = paper_id
        chosen[paper_id] = key
    return chosen, warnings


# ---------- rendering ----------


def _record(store: Store, paper_id: str, project: str | None = None, variant: str = "project") -> dict[str, Any]:
    """The record to write. In a project export the project's own imported version is used when it has one."""
    if project and variant == "project":
        v = store.conn.execute(
            "SELECT * FROM reference_variants WHERE paper_id=? AND project_key=? ORDER BY imported_at DESC, id LIMIT 1",
            (paper_id, project),
        ).fetchone()
        if v:
            return {"entry_type": v["entry_type"], "csl": loads(v["csl_json"], {}),
                    "extra": loads(v["extra_json"], {}), "raw": v["raw_bibtex"]}
    meta = store.conn.execute("SELECT * FROM reference_meta WHERE paper_id=?", (paper_id,)).fetchone()
    if meta:
        return {"entry_type": meta["entry_type"], "csl": loads(meta["csl_json"], {}),
                "extra": loads(meta["extra_json"], {}), "raw": meta["raw_bibtex"]}
    paper = store.conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    return {"entry_type": "misc", "csl": csl_from_paper_row(paper), "extra": extra_from_paper_row(paper), "raw": None}


def render(
    store: Store, ids: list[str], keys: dict[str, str], fmt: str, *, style: str = "normalized", fields: str = "standard",
    project: str | None = None, variant: str = "project",
) -> str:
    if fmt not in FORMATS:
        raise ExportError("bad-format", f"format must be one of {', '.join(FORMATS)}")
    if style not in ("normalized", "original") or fields not in ("standard", "all"):
        raise ExportError("bad-option", "style: normalized|original; fields: standard|all")
    ordered = sorted(ids, key=lambda i: keys[i].lower())
    if fmt in FILE_FORMATS:
        blocks = []
        for paper_id in ordered:
            rec = _record(store, paper_id, project, variant)
            if style == "original" and rec["raw"]:
                blocks.append(bibwrite.original_entry(keys[paper_id], rec["raw"]))
                continue
            entry_type, flds = bibwrite.build_fields(
                entry_type=rec["entry_type"], csl=rec["csl"], extra=rec["extra"], raw_bibtex=rec["raw"],
                dialect=fmt, all_fields=(fields == "all"),
            )
            blocks.append(bibwrite.bib_entry(keys[paper_id], entry_type, flds))
        return "\n\n".join(blocks) + ("\n" if blocks else "")
    if fmt == "ris":
        return "\n\n".join(bibwrite.ris_entry(keys[i], _record(store, i, project, variant)["csl"], _record(store, i, project, variant)["extra"]) for i in ordered) + "\n"
    if fmt == "csl-json":
        items = []
        for paper_id in ordered:
            csl = dict(_record(store, paper_id, project, variant)["csl"])
            csl["id"] = csl["citation-key"] = keys[paper_id]
            items.append(csl)
        return bibwrite.json_text(items)
    if fmt == "json":
        out = []
        for paper_id in ordered:
            rec = _record(store, paper_id, project, variant)
            out.append({"key": keys[paper_id], "paper_id": paper_id, "entry_type": rec["entry_type"],
                        "csl": rec["csl"], "extra": rec["extra"]})
        return bibwrite.json_text(out)
    rows = {r["paper_id"]: r for r in rows_for_ids(store, ordered)}
    table = []
    for paper_id in ordered:
        r = rows[paper_id]
        csl = _record(store, paper_id, project, variant)["csl"]
        table.append({
            "key": keys[paper_id], "type": csl.get("type", ""), "title": r["title"], "authors": "; ".join(r["authors"]),
            "year": r["year"] or "", "venue": r["venue"] or "", "doi": r["doi"] or "", "arxiv": r["arxiv_id"] or "",
            "url": csl.get("URL", ""), "tags": ";".join(r["tags"]), "collections": ";".join(r["collections"]),
        })
    return bibwrite.csv_text(table)


# ---------- managed files ----------


def resolve_out_path(out: str, cwd: str | None) -> Path:
    base = Path(cwd or os.getcwd()).expanduser().resolve()
    target = Path(out).expanduser()
    target = (target if target.is_absolute() else base / target).resolve()
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise ExportError("path-outside-workspace", f"{out!r} is outside the workspace {base}") from exc
    return target


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _parse_managed(text: str) -> dict[str, Any] | None:
    begin, end = text.find(BEGIN), text.find(END)
    if begin < 0 or end < begin:
        return None
    block = text[begin + len(BEGIN):end].strip("\n")
    hand_at = text.find(HAND, end)
    hand = text[hand_at + len(HAND):].lstrip("\n") if hand_at >= 0 else ""
    recorded = _HEADER_HASH.search(text[:begin])
    return {"block": block, "hand": hand, "recorded": recorded.group(1) if recorded else None}


def _entry_map(text: str) -> dict[str, str]:
    return {e.key: re.sub(r"\s+", " ", e.raw) for e in parse_bib(text).entries}


def _diff(old_block: str, new_block: str) -> dict[str, list[str]]:
    old, new = _entry_map(old_block), _entry_map(new_block)
    return {
        "added": sorted(set(new) - set(old)), "removed": sorted(set(old) - set(new)),
        "changed": sorted(k for k in set(old) & set(new) if old[k] != new[k]),
    }


def _compose(block: str, hand: str, *, project: str | None, dialect: str, count: int, style: str, fields: str) -> str:
    body = block.rstrip("\n")
    header = (
        "% papermemory:managed v1\n"
        f"% generated: {now_iso()}  project: {project or '-'}  dialect: {dialect}  entries: {count}  style: {style}  fields: {fields}\n"
        f"% managed-sha256: {_sha(body)}\n"
        "% Entries between the begin/end markers are rewritten on every export.\n"
        "% Put your own entries after the hand-added marker; they are kept.\n"
    )
    return f"{header}{BEGIN}\n{body}\n{END}\n{HAND}\n{hand}".rstrip("\n") + "\n"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


def _backup(path: Path) -> Path:
    target = path.with_name(f"{path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    target.write_bytes(path.read_bytes())
    return target


def sync_file(
    path: Path, block: str, *, project: str | None, dialect: str, count: int, style: str, fields: str,
    check: bool = False, force: bool = False, adopt: bool = False,
) -> dict[str, Any]:
    """Bring ``path`` in line with ``block``. Returns the status and what changed."""
    new_block = block.rstrip("\n")
    result: dict[str, Any] = {"path": str(path), "written": False}
    if not path.exists():
        result["status"] = "missing"
        result["diff"] = _diff("", new_block)
        if not check:
            _atomic_write(path, _compose(new_block + "\n", "", project=project, dialect=dialect, count=count, style=style, fields=fields))
            result["written"] = True
        return result
    text = path.read_text(encoding="utf-8", errors="replace")
    managed = _parse_managed(text)
    if managed is None:
        result["status"] = "not_managed"
        existing = parse_bib(text)
        wanted = set(_entry_map(new_block))
        result["existing_entries"] = len(existing.entries)
        result["would_absorb"] = sorted(e.key for e in existing.entries if e.key in wanted)
        if check:
            return result
        if not adopt:
            raise ExportError(
                "not-managed",
                f"{path.name} was not written by papermemory; pass adopt to take it over (a backup is kept)",
                **{k: v for k, v in result.items() if k != "written"},
            )
        result["backup"] = str(_backup(path))
        hand = text
        for entry in existing.entries:
            if entry.key in wanted:
                hand = hand.replace(entry.raw, "", 1)
        hand = re.sub(r"\n{3,}", "\n\n", hand).strip("\n")
        result["status"] = "adopted"
        _atomic_write(path, _compose(new_block + "\n", (hand + "\n") if hand else "", project=project, dialect=dialect, count=count, style=style, fields=fields))
        result["written"] = True
        return result
    actual = _sha(managed["block"])
    result["diff"] = _diff(managed["block"], new_block)
    if managed["recorded"] is not None and actual != managed["recorded"]:
        result["status"] = "hand_edited"
        result["edited_keys"] = sorted(set(result["diff"]["changed"]) | set(result["diff"]["removed"]))
        if check:
            return result
        if not force:
            raise ExportError(
                "hand-edited",
                f"{path.name} was edited inside the managed block; pass force to overwrite (a backup is kept)",
                **{k: v for k, v in result.items() if k != "written"},
            )
        result["backup"] = str(_backup(path))
        result["status"] = "overwritten"
    elif actual == _sha(new_block):
        result["status"] = "in_sync"
        return result
    else:
        result["status"] = "out_of_date"
        if check:
            return result
    _atomic_write(path, _compose(new_block + "\n", managed["hand"], project=project, dialect=dialect, count=count, style=style, fields=fields))
    result["written"] = True
    return result


# ---------- entry point ----------


def export_library(
    store: Store, *, fmt: str = "bibtex", query: list[str] | str | None = None, collection: str | None = None,
    project: str | None = None, cited_only: str | None = None, everything: bool = False, out: str | None = None,
    cwd: str | None = None, style: str = "normalized", fields: str = "standard", check: bool = False,
    force: bool = False, adopt: bool = False, variant: str = "project",
) -> dict[str, Any]:
    if fmt not in FORMATS:
        raise ExportError("bad-format", f"format must be one of {', '.join(FORMATS)}")
    # A collection bound to a project and a .bib exports there by default.
    if collection and not out:
        row = store.conn.execute("SELECT * FROM collections WHERE slug=?", (slugify(collection),)).fetchone()
        if row and row["bib_path"]:
            out = row["bib_path"]
            project = project or row["project_key"]
    if cited_only and not project:
        project = store.get_manuscript(cited_only)["slug"] if store.get_manuscript(cited_only) else None
    try:
        ids, notes = select_papers(store, query=query, collection=collection, project=project if not cited_only else None,
                                   cited_only=cited_only, everything=everything)
    except QueryError as exc:
        raise ExportError("bad-query", str(exc)) from exc
    keys, warnings = export_keys(store, ids, project, assign=not check)
    if variant not in ("project", "canonical"):
        raise ExportError("bad-option", "variant: project|canonical")
    text = render(store, ids, keys, fmt, style=style, fields=fields, project=project, variant=variant)
    result: dict[str, Any] = {
        "format": fmt, "count": len(ids), "project": project, "warnings": warnings, **notes,
    }
    if out is None:
        if len(ids) > MAX_INLINE:
            raise ExportError("too-large-for-inline", f"{len(ids)} entries; write to a file with --out", count=len(ids))
        result["text"] = text
        return result
    if fmt not in FILE_FORMATS:
        path = resolve_out_path(out, cwd)
        result["path"] = str(path)
        same = path.exists() and path.read_text(encoding="utf-8", errors="replace") == text
        result["status"] = "missing" if not path.exists() else ("in_sync" if same else "differs")
        if check or same:
            return result
        if path.exists() and not force:
            raise ExportError("exists", f"{path.name} already exists; pass force to overwrite (a backup is kept)", path=str(path))
        if path.exists():
            result["backup"] = str(_backup(path))
        _atomic_write(path, text)
        result["written"] = True
        return result
    path = resolve_out_path(out, cwd)
    sync = sync_file(
        path, text, project=project, dialect=fmt, count=len(ids), style=style, fields=fields,
        check=check, force=force, adopt=adopt,
    )
    result.update(sync)
    if not check and (sync["written"] or sync["status"] == "in_sync"):
        label = f"export:{os.path.relpath(path, Path(cwd or os.getcwd()).resolve())}"
        frozen = _freeze_exported(store, ids, keys, label)
        result["frozen"] = frozen
        if sync["written"]:
            store.mut("LIBRARY_WRITE", project_key=project, detail=f"export {label} entries={len(ids)}")
        store.conn.commit()
    return result


def _freeze_exported(store: Store, ids: list[str], keys: dict[str, str], label: str) -> int:
    """Mark library keys that were written as relied on (one transaction, one event)."""
    now = now_iso()
    frozen = 0
    for paper_id in ids:
        cur = store.conn.execute(
            "UPDATE bib_keys SET frozen=1, frozen_at=?, frozen_in=? WHERE paper_id=? AND key=? AND frozen=0",
            (now, label, paper_id, keys[paper_id]),
        )
        frozen += cur.rowcount
    if frozen:
        store.mut("KEY_FREEZE", detail=f"{frozen} key(s) in {label}")
    return frozen
