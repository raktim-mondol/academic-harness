"""Reference-library import: BibTeX/BibLaTeX, RIS, and CSL-JSON into PaperMemory.

Identity, deduplication and conflict handling are the existing
``Store.upsert_paper_v2`` rules; this module adds the lossless record
(``reference_meta``), the library-wide citation key (``bib_keys``), and the
per-project key aliases. A bad entry is reported, never fatal, and an import
never overwrites richer metadata that is already stored.
"""
from __future__ import annotations

import re
from typing import Any

from papermemory.bibkeys import make_key, usable_source_key
from papermemory.bibparse import parse_bib
from papermemory.bibrecord import Record, paper_columns, record_from_bib
from papermemory.csl_import import parse_csl_json
from papermemory.db import IdentityConflict, Store
from papermemory.library_store import add_alias, assign_key, pick_canonical, record_variant
from papermemory.ris import parse_ris
from papermemory.util import dumps, loads, normalize_arxiv, normalize_doi, normalize_title

FORMATS = ("bibtex", "ris", "csl-json")
DEFAULT_BATCH = 200


class LibraryError(Exception):
    code = "library-error"


def detect_format(text: str, path: str | None = None) -> str:
    suffix = (path or "").lower().rsplit(".", 1)[-1] if path and "." in path else ""
    if suffix in {"bib", "bibtex", "biblatex"}:
        return "bibtex"
    if suffix == "ris":
        return "ris"
    if suffix in {"json", "csljson"}:
        return "csl-json"
    head = text.lstrip("﻿ \t\r\n")[:2000]
    if head.startswith(("[", "{")):
        return "csl-json"
    if re.search(r"^TY\s{1,2}-", head, re.M):
        return "ris"
    if re.search(r"^\s*@\s*[A-Za-z]+\s*[{(]", head, re.M):
        return "bibtex"
    raise LibraryError("cannot detect format: pass format=bibtex|ris|csl-json")


def read_records(text: str, fmt: str) -> tuple[list[Record], list[dict[str, Any]]]:
    if fmt == "bibtex":
        parsed = parse_bib(text)
        return [record_from_bib(entry) for entry in parsed.entries], parsed.errors
    if fmt == "ris":
        return parse_ris(text)
    if fmt == "csl-json":
        return parse_csl_json(text)
    raise LibraryError(f"unknown format: {fmt} (use {', '.join(FORMATS)})")


def _identity(cols: dict[str, Any]) -> tuple[str, str]:
    doi = normalize_doi(cols.get("doi"))
    if doi:
        return "doi", doi
    arxiv = normalize_arxiv(cols.get("arxiv_id"))
    if arxiv:
        return "arxiv_id", arxiv
    if cols.get("pmid"):
        return "pmid", str(cols["pmid"]).strip()
    return "title_year", f"{normalize_title(cols.get('title') or 'Untitled')}|{cols.get('year') or ''}"


def _refresh_columns(conn: Any, paper_id: str, cols: dict[str, Any]) -> None:
    """A more complete record won: bring the list columns along without touching identity or title."""
    row = conn.execute("SELECT authors_json, venue, abstract FROM papers WHERE id=?", (paper_id,)).fetchone()
    updates: dict[str, Any] = {}
    if len(cols["authors"]) > len(loads(row["authors_json"], [])):
        updates["authors_json"] = dumps(cols["authors"])
    for column in ("venue", "abstract"):
        if cols[column] and not row[column]:
            updates[column] = cols[column]
    if updates:
        sets = ", ".join(f"{c}=?" for c in updates)
        conn.execute(f"UPDATE papers SET {sets} WHERE id=?", (*updates.values(), paper_id))


def _import_one(store: Store, record: Record, project_id: str | None, source: str) -> dict[str, Any]:
    conn = store.conn
    cols = paper_columns(record)
    kind, value = _identity(cols)
    fields = {
        "doi": cols["doi"], "arxiv_id": cols["arxiv_id"], "pmid": cols["pmid"], "year": cols["year"],
        "venue": cols["venue"], "abstract": cols["abstract"], "bibtex_key": None,
        "authors_json": dumps(cols["authors"]), "source_type": record.fmt,
        "verified": 1 if (cols["doi"] or cols["arxiv_id"]) else 0,
    }
    paper_id, state = store.upsert_paper_v2(
        kind, value, cols["title"], "caller", fields=fields, project_key=project_id,
        metadata_only=True, commit=False, library=False,
    )
    new_variant = record_variant(
        conn, paper_id, project_id or "", source=source, fmt=record.fmt, source_key=record.source_key,
        entry_type=record.entry_type, raw_bibtex=record.raw, csl=record.csl, extra=record.extra,
    )
    meta_state = pick_canonical(
        conn, paper_id, record.csl, record.extra, record.entry_type, raw_bibtex=record.raw, source=record.fmt,
    )
    if meta_state == "replaced":
        _refresh_columns(conn, paper_id, cols)
    wanted = record.source_key if usable_source_key(record.source_key) or (
        record.fmt == "bibtex" and record.source_key) else None
    policy = "imported"
    if not wanted:
        wanted, policy = make_key(record.csl, record.extra), "generated"
    key, created = assign_key(conn, paper_id, wanted, policy=policy)
    conn.execute("UPDATE papers SET bibtex_key=? WHERE id=? AND (bibtex_key IS NULL OR bibtex_key='')", (key, paper_id))
    collision = None
    if record.source_key:
        if not add_alias(conn, record.source_key, paper_id, project_key=project_id or "", source=f"import:{source}"):
            collision = record.source_key
    result: dict[str, Any] = {
        "source_key": record.source_key, "key": key, "paper_id": paper_id,
        "status": "added" if state == "created" else "merged", "meta": meta_state,
        "new_variant": new_variant,
    }
    if record.source_key and key != record.source_key:
        # A new paper whose key was taken by a different paper is a collision
        # (it was renamed); an existing paper that already had another key just
        # gains the source key as an alias.
        result["key_collision" if created and state == "created" else "key_alias"] = record.source_key
    if collision:
        result["alias_conflict"] = collision
    if record.warnings:
        result["warnings"] = record.warnings
    if record.line:
        result["line"] = record.line
    return result


def import_records(
    store: Store, records: list[Record], *, project_id: str | None = None, source: str = "inline",
    batch_size: int = DEFAULT_BATCH, dry_run: bool = False,
) -> dict[str, Any]:
    conn = store.conn
    conn.commit()
    if project_id:
        store.ensure_project(project_id)
    entries: list[dict[str, Any]] = []
    pending = 0
    for record in records:
        try:
            entries.append(_import_one(store, record, project_id, source))
        except IdentityConflict as exc:
            entries.append({
                "source_key": record.source_key, "status": "failed", "reason": str(exc),
                "line": record.line,
            })
        pending += 1
        if not dry_run and pending >= batch_size:
            conn.commit()
            pending = 0
    counts = {"added": 0, "merged": 0, "failed": 0}
    for entry in entries:
        counts[entry["status"]] += 1
    if dry_run:
        conn.rollback()
    else:
        store.mut(
            "LIBRARY_IMPORT", project_key=project_id, status="ok",
            detail=f"{source}: added={counts['added']} merged={counts['merged']} failed={counts['failed']}",
        )
        conn.commit()
    return {"dry_run": dry_run, "source": source, "project": project_id, "counts": counts, "entries": entries}


def import_text(
    store: Store, text: str, *, fmt: str = "auto", path: str | None = None, project_id: str | None = None,
    batch_size: int = DEFAULT_BATCH, dry_run: bool = False,
) -> dict[str, Any]:
    fmt = detect_format(text, path) if fmt in (None, "", "auto") else fmt
    records, errors = read_records(text, fmt)
    report = import_records(
        store, records, project_id=project_id, source=path or "inline", batch_size=batch_size, dry_run=dry_run,
    )
    report["format"] = fmt
    report["parse_errors"] = errors
    report["counts"]["parse_errors"] = len(errors)
    return report


def resolve_paper_id(store: Store, ref: str, *, project_id: str | None = None) -> str | None:
    """Paper id for a project key, library key, any alias, paper id, or DOI."""
    conn = store.conn
    paper_id = None
    # Inside a project, that project's own key wins: two projects may use one
    # key for two different papers.
    if project_id is not None:
        alias = conn.execute(
            "SELECT paper_id FROM bib_key_aliases WHERE key=? AND project_key=?", (ref, project_id)
        ).fetchone()
        paper_id = alias["paper_id"] if alias else None
    if paper_id is None:
        row = conn.execute("SELECT paper_id FROM bib_keys WHERE key=?", (ref,)).fetchone()
        paper_id = row["paper_id"] if row else None
    if paper_id is None:
        alias = conn.execute("SELECT paper_id FROM bib_key_aliases WHERE key=? ORDER BY first_seen LIMIT 1", (ref,)).fetchone()
        paper_id = alias["paper_id"] if alias else None
    if paper_id is None:
        paper = store.get_paper(ref) or None
        paper_id = paper["id"] if paper else None
    if paper_id is None and normalize_doi(ref):
        found = conn.execute("SELECT id FROM papers WHERE doi=?", (normalize_doi(ref),)).fetchone()
        paper_id = found["id"] if found else None
    return paper_id


def get_entry(store: Store, ref: str, *, project_id: str | None = None) -> dict[str, Any] | None:
    """A paper with its lossless record, key, and aliases; None if ``ref`` names nothing."""
    conn = store.conn
    paper_id = resolve_paper_id(store, ref, project_id=project_id)
    if paper_id is None:
        return None
    paper = store.get_paper(paper_id)
    meta = conn.execute("SELECT * FROM reference_meta WHERE paper_id=?", (paper_id,)).fetchone()
    key = conn.execute("SELECT * FROM bib_keys WHERE paper_id=?", (paper_id,)).fetchone()
    aliases = [
        dict(r) for r in conn.execute(
            "SELECT key, project_key, source, first_seen FROM bib_key_aliases WHERE paper_id=? ORDER BY first_seen, key",
            (paper_id,),
        )
    ]
    entry: dict[str, Any] = {"paper": paper, "key": dict(key) if key else None, "aliases": aliases}
    if meta:
        entry["reference"] = {
            "entry_type": meta["entry_type"], "source": meta["source"], "csl": loads(meta["csl_json"], {}),
            "extra": loads(meta["extra_json"], {}), "raw_bibtex": meta["raw_bibtex"], "updated_at": meta["updated_at"],
        }
    return entry
