"""Organising the library: tags, collections, and per-paper notes.

All edits are audited (``LIBRARY_WRITE`` / ``REMEMBER`` events). Deleting a
collection or a tag never deletes a paper.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any

from papermemory.db import Store
from papermemory.library import resolve_paper_id
from papermemory.util import new_id, now_iso, slugify

TAG_MAX = 64
NOTE_MAX = 20_000


class OrgError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def normalize_tag(tag: str) -> str:
    text = unicodedata.normalize("NFKC", tag or "").strip().lower()
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"[^\w:./\-]", "", text, flags=re.UNICODE).strip("-")
    if not text:
        raise OrgError("bad-tag", f"{tag!r} is not a usable tag")
    if len(text) > TAG_MAX:
        raise OrgError("bad-tag", f"tag longer than {TAG_MAX} characters")
    return text


def _resolve_all(store: Store, refs: list[str], project_id: str | None) -> list[str]:
    ids, missing = [], []
    for ref in refs:
        paper_id = resolve_paper_id(store, ref, project_id=project_id)
        (ids if paper_id else missing).append(paper_id or ref)
    if missing:
        raise OrgError("not-found", f"nothing found for: {', '.join(missing)}")
    return list(dict.fromkeys(ids))


# ---------- tags ----------


def add_tags(store: Store, refs: list[str], tags: list[str], *, project_id: str | None = None) -> dict[str, Any]:
    clean = list(dict.fromkeys(normalize_tag(t) for t in tags))
    ids = _resolve_all(store, refs, project_id)
    added = 0
    for paper_id in ids:
        for tag in clean:
            cur = store.conn.execute(
                "INSERT OR IGNORE INTO paper_tags(paper_id, tag, added_at) VALUES (?,?,?)", (paper_id, tag, now_iso())
            )
            if cur.rowcount:
                added += 1
                store.mut("LIBRARY_WRITE", paper_id=paper_id, detail=f"tag+ {tag}")
    store.conn.commit()
    return {"papers": len(ids), "tags": clean, "added": added}


def remove_tags(store: Store, refs: list[str], tags: list[str], *, project_id: str | None = None) -> dict[str, Any]:
    clean = list(dict.fromkeys(normalize_tag(t) for t in tags))
    ids = _resolve_all(store, refs, project_id)
    removed = 0
    for paper_id in ids:
        for tag in clean:
            cur = store.conn.execute("DELETE FROM paper_tags WHERE paper_id=? AND tag=?", (paper_id, tag))
            if cur.rowcount:
                removed += 1
                store.mut("LIBRARY_WRITE", paper_id=paper_id, detail=f"tag- {tag}")
    store.conn.commit()
    return {"papers": len(ids), "tags": clean, "removed": removed}


# ---------- collections ----------


def _collection(store: Store, slug: str) -> Any:
    row = store.conn.execute("SELECT * FROM collections WHERE slug=?", (slugify(slug),)).fetchone()
    if row is None:
        raise OrgError("collection-not-found", f"no collection {slug!r}")
    return row


def create_collection(
    store: Store, slug: str, *, title: str | None = None, parent: str | None = None,
    project: str | None = None, bib_path: str | None = None,
) -> dict[str, Any]:
    key = slugify(slug)
    if store.conn.execute("SELECT 1 FROM collections WHERE slug=?", (key,)).fetchone():
        raise OrgError("collection-exists", f"collection {key!r} already exists")
    parent_id = None
    if parent:
        parent_row = _collection(store, parent)
        if parent_row["parent_id"]:
            raise OrgError("too-deep", "collections nest one level only; the parent is itself a child")
        parent_id = parent_row["id"]
    if project and not store.conn.execute("SELECT 1 FROM projects WHERE key=?", (project,)).fetchone():
        raise OrgError("project-not-found", f"no project {project!r}")
    cid = new_id("col")
    store.conn.execute(
        "INSERT INTO collections(id, slug, title, parent_id, project_key, bib_path, created_at) VALUES (?,?,?,?,?,?,?)",
        (cid, key, (title or key).strip(), parent_id, project, (bib_path or "").strip() or None, now_iso()),
    )
    store.mut("LIBRARY_WRITE", project_key=project, detail=f"collection+ {key}")
    store.conn.commit()
    return {"id": cid, "slug": key, "title": (title or key).strip(), "parent": slugify(parent) if parent else None,
            "project": project, "bib_path": (bib_path or "").strip() or None}


def add_to_collection(store: Store, slug: str, refs: list[str], *, project_id: str | None = None) -> dict[str, Any]:
    col = _collection(store, slug)
    ids = _resolve_all(store, refs, project_id)
    nxt = (store.conn.execute("SELECT COALESCE(MAX(ord), -1) FROM collection_papers WHERE collection_id=?", (col["id"],)).fetchone()[0]) + 1
    added = 0
    for paper_id in ids:
        cur = store.conn.execute(
            "INSERT OR IGNORE INTO collection_papers(collection_id, paper_id, ord, added_at) VALUES (?,?,?,?)",
            (col["id"], paper_id, nxt, now_iso()),
        )
        if cur.rowcount:
            nxt += 1
            added += 1
            store.mut("LIBRARY_WRITE", paper_id=paper_id, detail=f"collection+ {col['slug']}")
    store.conn.commit()
    return {"collection": col["slug"], "papers": len(ids), "added": added}


def remove_from_collection(store: Store, slug: str, refs: list[str], *, project_id: str | None = None) -> dict[str, Any]:
    col = _collection(store, slug)
    ids = _resolve_all(store, refs, project_id)
    removed = 0
    for paper_id in ids:
        cur = store.conn.execute(
            "DELETE FROM collection_papers WHERE collection_id=? AND paper_id=?", (col["id"], paper_id)
        )
        if cur.rowcount:
            removed += 1
            store.mut("LIBRARY_WRITE", paper_id=paper_id, detail=f"collection- {col['slug']}")
    store.conn.commit()
    return {"collection": col["slug"], "papers": len(ids), "removed": removed}


def reorder_collection(store: Store, slug: str, refs: list[str], *, project_id: str | None = None) -> dict[str, Any]:
    """Put the listed papers first, in the given order; the rest keep their relative order after them."""
    col = _collection(store, slug)
    ids = _resolve_all(store, refs, project_id)
    members = [r["paper_id"] for r in store.conn.execute(
        "SELECT paper_id FROM collection_papers WHERE collection_id=? ORDER BY ord, added_at, paper_id", (col["id"],))]
    outside = [i for i in ids if i not in members]
    if outside:
        raise OrgError("not-a-member", f"not in collection {col['slug']!r}: {', '.join(outside)}")
    order = ids + [m for m in members if m not in ids]
    for position, paper_id in enumerate(order):
        store.conn.execute(
            "UPDATE collection_papers SET ord=? WHERE collection_id=? AND paper_id=?", (position, col["id"], paper_id)
        )
    store.mut("LIBRARY_WRITE", detail=f"collection order {col['slug']}")
    store.conn.commit()
    return {"collection": col["slug"], "count": len(order)}


def delete_collection(store: Store, slug: str) -> dict[str, Any]:
    """Remove the collection and its memberships. Papers are never deleted."""
    col = _collection(store, slug)
    members = store.conn.execute("SELECT COUNT(*) FROM collection_papers WHERE collection_id=?", (col["id"],)).fetchone()[0]
    children = store.conn.execute("SELECT COUNT(*) FROM collections WHERE parent_id=?", (col["id"],)).fetchone()[0]
    store.conn.execute("DELETE FROM collections WHERE id=?", (col["id"],))
    store.mut("LIBRARY_WRITE", detail=f"collection- {col['slug']}")
    store.conn.commit()
    return {"deleted": col["slug"], "memberships_removed": members, "children_detached": children, "papers_deleted": 0}


def list_collections(store: Store) -> list[dict[str, Any]]:
    rows = store.conn.execute(
        """SELECT c.*, par.slug AS parent_slug,
             (SELECT COUNT(*) FROM collection_papers cp WHERE cp.collection_id=c.id) AS papers
           FROM collections c LEFT JOIN collections par ON par.id=c.parent_id ORDER BY c.slug"""
    ).fetchall()
    return [
        {"slug": r["slug"], "title": r["title"], "parent": r["parent_slug"], "project": r["project_key"],
         "bib_path": r["bib_path"], "papers": r["papers"]}
        for r in rows
    ]


def show_collection(store: Store, slug: str, *, limit: int = 50, offset: int = 0) -> dict[str, Any]:
    col = _collection(store, slug)
    total = store.conn.execute("SELECT COUNT(*) FROM collection_papers WHERE collection_id=?", (col["id"],)).fetchone()[0]
    rows = store.conn.execute(
        """SELECT cp.ord, p.id, p.title, p.year, k.key FROM collection_papers cp JOIN papers p ON p.id=cp.paper_id
           LEFT JOIN bib_keys k ON k.paper_id=p.id WHERE cp.collection_id=? ORDER BY cp.ord, cp.added_at, p.id LIMIT ? OFFSET ?""",
        (col["id"], max(1, min(int(limit), 200)), max(0, int(offset))),
    ).fetchall()
    return {
        "slug": col["slug"], "title": col["title"], "project": col["project_key"], "bib_path": col["bib_path"],
        "total_count": total,
        "papers": [{"position": r["ord"], "paper_id": r["id"], "key": r["key"], "title": r["title"], "year": r["year"]} for r in rows],
    }


# ---------- notes (paper-scoped observations, tier 'note') ----------


def _note_row(store: Store, note_id: str) -> Any:
    row = store.conn.execute(
        "SELECT * FROM observations WHERE id=? AND tier='note' AND paper_id IS NOT NULL", (note_id,)
    ).fetchone()
    if row is None:
        raise OrgError("note-not-found", f"no note {note_id!r}")
    if row["superseded_by"]:
        raise OrgError("note-inactive", f"note {note_id} was already replaced or removed")
    return row


def _clean_note(text: str) -> str:
    body = (text or "").strip()
    if not body:
        raise OrgError("empty-note", "a note needs text")
    if len(body) > NOTE_MAX:
        raise OrgError("note-too-long", f"notes are limited to {NOTE_MAX} characters")
    return body


def add_note(store: Store, ref: str, text: str, *, project_id: str | None = None) -> dict[str, Any]:
    body = _clean_note(text)
    paper_id = resolve_paper_id(store, ref, project_id=project_id)
    if paper_id is None:
        raise OrgError("not-found", f"nothing found for {ref!r}")
    obs = store.remember(body, concepts=["note"], tier="note", paper_id=paper_id, confidence=1.0)
    return {"note_id": obs["id"], "paper_id": paper_id}


def list_notes(store: Store, ref: str, *, project_id: str | None = None) -> list[dict[str, Any]]:
    paper_id = resolve_paper_id(store, ref, project_id=project_id)
    if paper_id is None:
        raise OrgError("not-found", f"nothing found for {ref!r}")
    rows = store.conn.execute(
        "SELECT id, content, created_at, updated_at FROM observations WHERE paper_id=? AND tier='note' "
        "AND superseded_by IS NULL ORDER BY created_at, id", (paper_id,)
    ).fetchall()
    return [dict(r) for r in rows]


def edit_note(store: Store, note_id: str, text: str) -> dict[str, Any]:
    """Replace a note. The old text stays in the database, marked superseded."""
    body = _clean_note(text)
    old = _note_row(store, note_id)
    new = store.remember(body, concepts=["note"], tier="note", paper_id=old["paper_id"], confidence=1.0)
    store.conn.execute(
        "UPDATE observations SET superseded_by=?, status='superseded', updated_at=? WHERE id=?",
        (new["id"], now_iso(), note_id),
    )
    store.conn.commit()
    return {"note_id": new["id"], "replaced": note_id, "paper_id": old["paper_id"]}


def remove_note(store: Store, note_id: str) -> dict[str, Any]:
    old = _note_row(store, note_id)
    store.conn.execute(
        "UPDATE observations SET superseded_by='removed', status='removed', updated_at=? WHERE id=?",
        (now_iso(), note_id),
    )
    store.mut("LIBRARY_WRITE", paper_id=old["paper_id"], detail=f"note- {note_id}")
    store.conn.commit()
    return {"removed": note_id, "paper_id": old["paper_id"]}
