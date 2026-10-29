"""Citation-key operations on the library: assign, check, freeze, rekey.

Every change is explicit and audited. A key is set once; it changes only
through ``rekey`` with a reason, which keeps the old key as a library-wide
alias so manuscripts that still cite it keep resolving, and reports which
manuscripts cite it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from papermemory.bibkeys import clean_key, key_problems, make_key, resolve_template
from papermemory.db import Store
from papermemory.library import resolve_paper_id
from papermemory.library_store import add_alias, csl_from_paper_row, extra_from_paper_row, free_key
from papermemory.util import loads, now_iso

SAMPLE = 50


class KeyOperationError(Exception):
    """A key operation was refused; ``code`` says why."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _record_for(store: Store, paper: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    meta = store.conn.execute("SELECT csl_json, extra_json FROM reference_meta WHERE paper_id=?", (paper["id"],)).fetchone()
    if meta:
        return loads(meta["csl_json"], {}), loads(meta["extra_json"], {})
    return csl_from_paper_row(paper), extra_from_paper_row(paper)


def assign_for(store: Store, paper_ids: list[str] | None = None, *, template: str | None = None) -> dict[str, Any]:
    """Give papers without a library key one, in a deterministic order (all such papers if ``paper_ids`` is None)."""
    tpl = resolve_template(template)
    conn = store.conn
    conn.commit()
    rows = conn.execute(
        """SELECT p.* FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id
           WHERE k.paper_id IS NULL ORDER BY p.created_at, p.id"""
    ).fetchall()
    if paper_ids is not None:
        wanted = set(paper_ids)
        rows = [r for r in rows if r["id"] in wanted]
    assigned: list[dict[str, str]] = []
    for paper in rows:
        csl, extra = _record_for(store, paper)
        key = free_key(conn, make_key(csl, extra, tpl), paper["id"])
        conn.execute(
            "INSERT INTO bib_keys(paper_id, key, policy, frozen, created_at) VALUES (?,?, 'generated', 0, ?)",
            (paper["id"], key, now_iso()),
        )
        conn.execute("UPDATE papers SET bibtex_key=? WHERE id=? AND (bibtex_key IS NULL OR bibtex_key='')", (key, paper["id"]))
        store.mut("KEY_ASSIGN", paper_id=paper["id"], detail=f"{key} template={tpl}")
        assigned.append({"paper_id": paper["id"], "key": key})
    conn.commit()
    return {"template": tpl, "assigned": len(assigned), "sample": assigned[:SAMPLE]}


def assign_missing(store: Store, *, template: str | None = None) -> dict[str, Any]:
    """Give every paper without a key one."""
    return assign_for(store, None, template=template)


def freeze(store: Store, ref: str, label: str, *, project_id: str | None = None) -> dict[str, Any]:
    """Mark a key as relied on (written to a file or cited); it can then only change through rekey."""
    if not (label or "").strip():
        raise KeyOperationError("label-required", "freeze needs a label such as 'export:references.bib'")
    paper_id = resolve_paper_id(store, ref, project_id=project_id)
    if paper_id is None:
        raise KeyOperationError("not-found", f"nothing found for {ref!r}")
    row = store.conn.execute("SELECT key, frozen FROM bib_keys WHERE paper_id=?", (paper_id,)).fetchone()
    if row is None:
        raise KeyOperationError("no-key", "paper has no library key; run `library keys assign`")
    if row["frozen"]:
        return {"paper_id": paper_id, "key": row["key"], "frozen": True, "changed": False}
    store.conn.execute(
        "UPDATE bib_keys SET frozen=1, frozen_at=?, frozen_in=? WHERE paper_id=?", (now_iso(), label.strip(), paper_id)
    )
    store.mut("KEY_FREEZE", paper_id=paper_id, detail=f"{row['key']} in {label.strip()}")
    store.conn.commit()
    return {"paper_id": paper_id, "key": row["key"], "frozen": True, "changed": True}


def citing_manuscripts(store: Store, paper_id: str, key: str) -> list[dict[str, Any]]:
    """Manuscripts that cite ``key``: recorded locators plus a live scan of each manuscript's files."""
    from papermemory.citations import scan_tex_tree

    found: dict[str, set[tuple[str, int]]] = {}
    for row in store.conn.execute(
        """SELECT m.slug, c.tex_file, c.tex_line FROM citations c JOIN manuscripts m ON m.id=c.manuscript_id
           WHERE c.bibtex_key=? AND (c.paper_id=? OR c.paper_id IS NULL)""",
        (key, paper_id),
    ):
        found.setdefault(row["slug"], set()).add((row["tex_file"], row["tex_line"]))
    for ms in store.conn.execute("SELECT slug, root_path FROM manuscripts WHERE root_path IS NOT NULL").fetchall():
        root = Path(ms["root_path"])
        if not root.exists():
            continue
        for hit in scan_tex_tree(root):
            if hit["key"] == key:
                found.setdefault(ms["slug"], set()).add((hit["file"], hit["line"]))
    return [
        {"manuscript": slug, "citations": len(places), "files": sorted({f for f, _ in places})}
        for slug, places in sorted(found.items())
    ]


def rekey(
    store: Store, ref: str, *, to: str | None = None, template: str | None = None, reason: str = "",
    apply: bool = False, project_id: str | None = None,
) -> dict[str, Any]:
    """Plan (default) or apply a key change. The old key is kept as an alias."""
    paper_id = resolve_paper_id(store, ref, project_id=project_id)
    if paper_id is None:
        raise KeyOperationError("not-found", f"nothing found for {ref!r}")
    conn = store.conn
    current = conn.execute("SELECT * FROM bib_keys WHERE paper_id=?", (paper_id,)).fetchone()
    if current is None:
        raise KeyOperationError("no-key", "paper has no library key; run `library keys assign`")
    old = current["key"]
    paper = conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    if to:
        new = to.strip()
        problems = key_problems(new)
        if problems:
            raise KeyOperationError("invalid-key", f"{new!r} is not a safe citation key: {', '.join(problems)}")
    else:
        csl, extra = _record_for(store, paper)
        new = make_key(csl, extra, template)
        new = clean_key(new) or new
    plan: dict[str, Any] = {
        "paper_id": paper_id, "old_key": old, "new_key": new, "frozen": bool(current["frozen"]),
        "applied": False, "changed": new != old,
    }
    if new == old:
        return plan
    owner = conn.execute("SELECT paper_id FROM bib_keys WHERE key=?", (new,)).fetchone()
    if owner and owner["paper_id"] != paper_id:
        raise KeyOperationError("key-in-use", f"{new!r} is the library key of another paper")
    alias = conn.execute("SELECT paper_id FROM bib_key_aliases WHERE key=? AND project_key=''", (new,)).fetchone()
    if alias and alias["paper_id"] != paper_id:
        raise KeyOperationError("key-in-use", f"{new!r} is an alias of another paper")
    plan["affected_manuscripts"] = citing_manuscripts(store, paper_id, old)
    if not apply:
        plan["note"] = "dry run: pass apply (with a reason) to change the key; the old key stays as an alias"
        return plan
    if not (reason or "").strip():
        raise KeyOperationError("reason-required", "rekey needs a reason")
    conn.commit()
    conn.execute("DELETE FROM bib_key_aliases WHERE key=? AND project_key='' AND paper_id=?", (new, paper_id))
    add_alias(conn, old, paper_id, project_key="", source="rekey")
    conn.execute(
        "UPDATE bib_keys SET key=?, policy=?, frozen=0, frozen_at=NULL, frozen_in=NULL WHERE paper_id=?",
        (new, "manual" if to else "generated", paper_id),
    )
    conn.execute("UPDATE papers SET bibtex_key=? WHERE id=?", (new, paper_id))
    store.mut("KEY_RENAME", paper_id=paper_id, detail=json.dumps({"old": old, "new": new, "reason": reason.strip()}))
    conn.commit()
    plan["applied"] = True
    plan["reason"] = reason.strip()
    return plan


def check(store: Store, *, template: str | None = None) -> dict[str, Any]:
    """Report key problems. Evidence only: nothing is changed."""
    tpl = resolve_template(template)
    conn = store.conn
    problems: dict[str, list[dict[str, Any]]] = {
        "missing_key": [], "unsafe_key": [], "papers_column_mismatch": [], "template_drift": [], "alias_shadows_key": [],
    }
    for row in conn.execute(
        """SELECT p.id FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id WHERE k.paper_id IS NULL ORDER BY p.created_at"""
    ):
        problems["missing_key"].append({"paper_id": row["id"]})
    for row in conn.execute("SELECT * FROM bib_keys ORDER BY key"):
        issues = key_problems(row["key"])
        if issues:
            problems["unsafe_key"].append({"paper_id": row["paper_id"], "key": row["key"], "issues": issues})
    for row in conn.execute(
        """SELECT p.id, p.bibtex_key, k.key FROM papers p JOIN bib_keys k ON k.paper_id=p.id
           WHERE p.bibtex_key IS NOT NULL AND p.bibtex_key != '' AND p.bibtex_key != k.key"""
    ):
        problems["papers_column_mismatch"].append(
            {"paper_id": row["id"], "papers_bibtex_key": row["bibtex_key"], "library_key": row["key"]}
        )
    for row in conn.execute("SELECT k.paper_id, k.key, p.* FROM bib_keys k JOIN papers p ON p.id=k.paper_id WHERE k.policy='generated'"):
        csl, extra = _record_for(store, row)
        expected = make_key(csl, extra, tpl)
        if row["key"] != expected and not re.fullmatch(re.escape(expected) + r"[a-z]+", row["key"]):
            problems["template_drift"].append({"paper_id": row["paper_id"], "key": row["key"], "template_key": expected})
    for row in conn.execute(
        """SELECT a.key, a.project_key, a.paper_id AS alias_paper, k.paper_id AS owner
           FROM bib_key_aliases a JOIN bib_keys k ON k.key=a.key WHERE a.paper_id != k.paper_id"""
    ):
        problems["alias_shadows_key"].append(
            {"key": row["key"], "project": row["project_key"], "alias_of": row["alias_paper"], "library_key_of": row["owner"]}
        )
    totals = {name: len(items) for name, items in problems.items()}
    by_policy = {r["policy"]: r["n"] for r in conn.execute("SELECT policy, COUNT(*) AS n FROM bib_keys GROUP BY policy")}
    summary = {
        "template": tpl,
        "keys": conn.execute("SELECT COUNT(*) FROM bib_keys").fetchone()[0],
        "frozen": conn.execute("SELECT COUNT(*) FROM bib_keys WHERE frozen=1").fetchone()[0],
        "by_policy": by_policy,
        "problems": totals,
        "ok": not any(totals[name] for name in ("missing_key", "unsafe_key", "papers_column_mismatch")),
    }
    return {"summary": summary, "problems": {name: items[:SAMPLE] for name, items in problems.items() if items}}
