"""Offline consolidation ("dreaming") of PaperMemory's free-text notes.

Claims are checked against the stored paper text when they are written. The
notes around them (observations and lessons) are not: they are plain inserts,
so duplicates pile up, a note derived from a file keeps being believed after
the file changes, and quarantined legacy claims wait forever for markdown.

``dream`` is the background pass that fixes that. It never deletes a row and
never edits a note's text. Everything it does is a status change that names
its reason in the event log, and ``apply=False`` (the default) only reports.

Phases
  1. ``dedupe``      near-duplicate observations / lessons -> the older copy is
                     marked ``superseded`` by the newest one.
  2. ``verify``      a note is re-derived from its ground truth where one
                     exists (manuscript notes from the files on disk, paper /
                     manuscript references from the store); a mismatch is
                     marked ``stale``.
  3. ``recover``     quarantined legacy claims are re-submitted through
                     ``add_claim`` once their paper has markdown, so the verbatim
                     check decides, never the old row.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from papermemory.claims import ClaimError, add_claim
from papermemory.grounding import quote_check
from papermemory.tokenizer import terms
from papermemory.util import now_iso

NOTE_TABLES = ("observations", "lessons")
INACTIVE = ("stale", "superseded")
DEFAULT_SIMILARITY = 0.9
MAX_GROUP = 400  # pairwise comparison cap per group; a bigger group is reported, not guessed at


def _norm(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _similar(a_norm: str, b_norm: str, a_terms: set[str], b_terms: set[str], threshold: float) -> bool:
    if a_norm == b_norm:
        return True
    if not a_terms or not b_terms:
        return False
    return len(a_terms & b_terms) / len(a_terms | b_terms) >= threshold


def _pinned(store, table: str) -> set[str]:
    """Notes a person restored after dream retired them: dream does not touch them again."""
    prefix = f"{table}:"
    return {
        r[0][len(prefix):]
        for r in store.conn.execute(
            "SELECT detail FROM events WHERE op='SWEEP' AND reason_code='note-restored'"
        ).fetchall()
        if r[0] and r[0].startswith(prefix)
    }


def _active_rows(store, table: str, project: str | None) -> list[dict[str, Any]]:
    sql = f"SELECT *, rowid AS _rid FROM {table} WHERE superseded_by IS NULL AND COALESCE(status,'active') NOT IN ('stale','superseded')"
    args: list[Any] = []
    if project:
        sql += " AND (project_id=?)"
        args.append(project)
    pinned = _pinned(store, table)
    return [dict(r) for r in store.conn.execute(sql, args).fetchall() if r["id"] not in pinned]


def _group_key(table: str, row: dict[str, Any]) -> tuple:
    if table == "observations":
        return (row.get("project_id"), row.get("tier"), row.get("paper_id"), row.get("manuscript_id"))
    return (row.get("project_id"),)


def plan_dedupe(store, project: str | None = None, similarity: float = DEFAULT_SIMILARITY) -> dict[str, Any]:
    """Pure planning: which active notes are copies of a newer one."""
    out: dict[str, Any] = {"duplicates": [], "skipped_groups": []}
    for table in NOTE_TABLES:
        groups: dict[tuple, list[dict[str, Any]]] = {}
        for row in _active_rows(store, table, project):
            groups.setdefault(_group_key(table, row), []).append(row)
        for key, rows in groups.items():
            if len(rows) < 2:
                continue
            if len(rows) > MAX_GROUP:
                out["skipped_groups"].append({"table": table, "group": list(key), "size": len(rows)})
                continue
            # newest first; among equals, the more-used note is the keeper
            rows.sort(key=lambda r: (r["created_at"], r.get("access_count") or 0, r["_rid"]), reverse=True)
            keepers: list[tuple[dict[str, Any], str, set[str]]] = []
            for row in rows:
                norm = _norm(row["content"])
                tset = set(terms(row["content"]))
                match = next((k for k in keepers if _similar(norm, k[1], tset, k[2], similarity)), None)
                if match is None:
                    keepers.append((row, norm, tset))
                else:
                    out["duplicates"].append(
                        {
                            "table": table,
                            "id": row["id"],
                            "keeper": match[0]["id"],
                            "project": row.get("project_id"),
                            "preview": row["content"][:80].replace("\n", " "),
                        }
                    )
    return out


def plan_verify(store, project: str | None = None) -> list[dict[str, Any]]:
    """Notes whose ground truth no longer supports them. Only checks what can be checked."""
    from papermemory.ingest import manuscript_notes_text

    stale: list[dict[str, Any]] = []
    for row in _active_rows(store, "observations", project):
        reason = None
        if row.get("paper_id") and not store.conn.execute(
            "SELECT 1 FROM papers WHERE id=?", (row["paper_id"],)
        ).fetchone():
            reason = "paper-missing"
        ms = None
        if not reason and row.get("manuscript_id"):
            ms = store.conn.execute("SELECT * FROM manuscripts WHERE id=?", (row["manuscript_id"],)).fetchone()
            if ms is None:
                reason = "manuscript-missing"
        if not reason and ms is not None and row["content"].startswith(f"Manuscript {ms['slug']} notes:"):
            root = Path(ms["root_path"]) if ms["root_path"] else None
            if root is not None and root.is_dir():
                current = manuscript_notes_text(root, ms["slug"])
                if current is None:
                    reason = "source-files-missing"
                elif _norm(current) != _norm(row["content"]):
                    reason = "source-files-changed"
            # root not on this machine: unknown, not stale. Leave it alone.
        if reason:
            stale.append({"id": row["id"], "reason": reason, "project": row.get("project_id"),
                          "preview": row["content"][:80].replace("\n", " ")})
    return stale


def _legacy_pending(store) -> list[dict[str, Any]]:
    return [
        dict(r)
        for r in store.conn.execute(
            "SELECT * FROM legacy_claims WHERE COALESCE(status,'extracted')='extracted' ORDER BY created_at, id"
        ).fetchall()
    ]


def plan_recover(store, project: str | None = None) -> dict[str, Any]:
    """Read-only: which quarantined claims could come back now, and which papers block the rest."""
    recoverable, not_verbatim, awaiting = [], [], {}
    for row in _legacy_pending(store):
        paper = store.get_paper(row["paper_id"]) if row.get("paper_id") else None
        if project and paper:
            in_project = store.conn.execute(
                "SELECT 1 FROM paper_projects WHERE paper_id=? AND project_key=?", (paper["id"], project)
            ).fetchone()
            if not in_project:
                continue
        doc_id = (paper or {}).get("current_doc_id")
        if not paper or not doc_id:
            slot = awaiting.setdefault(
                row.get("paper_id") or "?",
                {"paper_id": row.get("paper_id"), "title": (paper or {}).get("title"),
                 "bibtex_key": (paper or {}).get("bibtex_key"), "claims": 0},
            )
            slot["claims"] += 1
            continue
        quote = (row.get("evidence_quote") or "").strip()
        check = quote_check(store, quote, doc_id=doc_id) if quote else {"found": False}
        (recoverable if check.get("found") else not_verbatim).append(row["id"])
    return {"recoverable": recoverable, "not_verbatim": not_verbatim,
            "awaiting_markdown": sorted(awaiting.values(), key=lambda s: -s["claims"])}


def _set_status(store, table: str, row_id: str, status: str, superseded_by: str | None = None) -> None:
    store.conn.execute(
        f"UPDATE {table} SET status=?, superseded_by=COALESCE(?, superseded_by), updated_at=? WHERE id=?",
        (status, superseded_by, now_iso(), row_id),
    )


def dream(store, project: str | None = None, *, apply: bool = False,
          similarity: float = DEFAULT_SIMILARITY) -> dict[str, Any]:
    dedupe = plan_dedupe(store, project, similarity)
    stale = plan_verify(store, project)
    recover = plan_recover(store, project)
    report: dict[str, Any] = {
        "applied": apply,
        "project": project,
        "dedupe": dedupe,
        "stale": stale,
        "recover": {**recover, "recovered": [], "rejected": []},
    }
    if apply:
        for dup in dedupe["duplicates"]:
            if dup["table"] == "observations":
                used = store.conn.execute(
                    "SELECT COALESCE(access_count,0) FROM observations WHERE id=?", (dup["id"],)
                ).fetchone()[0]
                if used:
                    store.conn.execute(
                        "UPDATE observations SET access_count=COALESCE(access_count,0)+? WHERE id=?",
                        (used, dup["keeper"]),
                    )
            _set_status(store, dup["table"], dup["id"], "superseded", superseded_by=dup["keeper"])
            store.mut("SWEEP", project_key=dup["project"], reason_code="note-duplicate",
                      detail=f"{dup['table']}:{dup['id']}->{dup['keeper']}")
        for item in stale:
            _set_status(store, "observations", item["id"], "stale")
            store.mut("SWEEP", project_key=item["project"], reason_code=f"note-stale:{item['reason']}",
                      detail=f"observations:{item['id']}")
        store.conn.commit()
        for legacy_id in recover["recoverable"]:
            row = dict(store.conn.execute("SELECT * FROM legacy_claims WHERE id=?", (legacy_id,)).fetchone())
            try:
                result = add_claim(
                    store, text=row["claim_text"], asserted_quote=row["evidence_quote"],
                    paper_id=row["paper_id"], manuscript_id=row.get("manuscript_id"),
                    claim_type=row.get("claim_type") or "finding", actor="dream",
                )
                store.conn.execute("UPDATE legacy_claims SET status='recovered', updated_at=? WHERE id=?",
                                   (now_iso(), legacy_id))
                store.conn.commit()
                report["recover"]["recovered"].append({"legacy_id": legacy_id, "claim_id": result.get("claim", {}).get("id"),
                                                        "status": result.get("status")})
            except ClaimError as exc:
                store.conn.rollback()
                store.conn.execute("UPDATE legacy_claims SET status=?, updated_at=? WHERE id=?",
                                   (f"unrecoverable:{exc}", now_iso(), legacy_id))
                store.conn.commit()
                report["recover"]["rejected"].append({"legacy_id": legacy_id, "reason": str(exc)})
            except Exception as exc:  # e.g. a dangling manuscript id; leave the row pending, report it
                store.conn.rollback()
                report["recover"]["rejected"].append({"legacy_id": legacy_id, "reason": f"error:{type(exc).__name__}",
                                                       "retry": True})
        for legacy_id in recover["not_verbatim"]:
            store.conn.execute(
                "UPDATE legacy_claims SET status='unrecoverable:quote-not-verbatim', updated_at=? WHERE id=?",
                (now_iso(), legacy_id),
            )
            report["recover"]["rejected"].append({"legacy_id": legacy_id, "reason": "quote-not-verbatim"})
        store.mut("SWEEP", project_key=project, reason_code="dream",
                  detail=(f"dup={len(dedupe['duplicates'])} stale={len(stale)} "
                          f"recovered={len(report['recover']['recovered'])}"))
        store.conn.commit()
    report["summary"] = {
        "duplicates": len(dedupe["duplicates"]),
        "stale": len(stale),
        "recoverable_claims": len(recover["recoverable"]),
        "recovered_claims": len(report["recover"]["recovered"]),
        "claims_awaiting_markdown": sum(p["claims"] for p in recover["awaiting_markdown"]),
        "papers_awaiting_markdown": len(recover["awaiting_markdown"]),
    }
    return report


def restore(store, note_id: str) -> dict[str, Any]:
    """Undo dream for one note. The note is then left alone by later dream passes."""
    for table in NOTE_TABLES:
        row = store.conn.execute(f"SELECT id, status, superseded_by FROM {table} WHERE id=?", (note_id,)).fetchone()
        if not row:
            continue
        if (row["status"] or "active") == "active" and not row["superseded_by"]:
            return {"restored": False, "id": note_id, "reason": "already-active"}
        store.conn.execute(
            f"UPDATE {table} SET status='active', superseded_by=NULL, updated_at=? WHERE id=?", (now_iso(), note_id)
        )
        store.mut("SWEEP", reason_code="note-restored", detail=f"{table}:{note_id}")
        store.conn.commit()
        return {"restored": True, "id": note_id, "table": table}
    return {"restored": False, "id": note_id, "reason": "not-found"}
