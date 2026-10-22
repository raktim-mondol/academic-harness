from __future__ import annotations

import json
from typing import Any

from papermemory.citations import cite_check
from papermemory.db import Store
from papermemory.util import loads


def _short(text: str | None, limit: int) -> tuple[str, bool]:
    value = (text or "").strip()
    if len(value) <= limit:
        return value, False
    return value[:limit].rstrip() + " … [truncated; call list for the full row]", True


def _scope_stats(store: Store, project: str | None) -> dict[str, Any]:
    if project:
        scope = "EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)"
        args = [project]
        papers = store.conn.execute(f"SELECT COUNT(*) FROM papers p WHERE {scope}", args).fetchone()[0]
        chunks = store.conn.execute(
            f"SELECT COUNT(*) FROM chunks c JOIN papers p ON p.id=c.paper_id WHERE {scope}", args
        ).fetchone()[0]
        claims = store.conn.execute(
            f"SELECT COUNT(*) FROM claims c JOIN papers p ON p.id=c.paper_id WHERE c.is_latest=1 AND {scope}", args
        ).fetchone()[0]
    else:
        papers = store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
        chunks = store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        claims = store.conn.execute("SELECT COUNT(*) FROM claims WHERE is_latest=1").fetchone()[0]
    cite_sql = "SELECT cite_state, COUNT(*) FROM papers p"
    cite_args: list[Any] = []
    if project:
        cite_sql += " WHERE EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)"
        cite_args = [project]
    cite_sql += " GROUP BY cite_state"
    cite_state = {row[0]: row[1] for row in store.conn.execute(cite_sql, cite_args).fetchall()}
    cov_sql = """SELECT COUNT(*), SUM(cov.capped) FROM coverage cov
                 JOIN raw_documents d ON d.id=cov.doc_id JOIN papers p ON p.id=d.paper_id
                 WHERE d.is_current=1"""
    cov_args: list[Any] = []
    if project:
        cov_sql += " AND EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)"
        cov_args = [project]
    docs, capped = store.conn.execute(cov_sql, cov_args).fetchone()
    return {
        "papers": papers,
        "claims": claims,
        "chunks": chunks,
        "cite_state": cite_state,
        "coverage": {"docs": docs or 0, "capped_docs": capped or 0},
    }


def _degrade(payload: dict[str, Any], max_chars: int) -> dict[str, Any]:
    def size() -> int:
        return len(json.dumps(payload, default=str, ensure_ascii=False))

    if size() <= max_chars:
        return payload
    payload["truncated"] = {"budget_chars": max_chars}
    steps = [
        ("cite_check", "volatile"),
        ("recent_papers", "volatile"),
        ("open_reviewer_comments", "stable"),
        ("contributions", "stable"),
        ("terminology", "stable"),
        ("observations", "volatile"),
        ("lessons", "volatile"),
        ("claims", "volatile"),
        ("sections", "stable"),
    ]
    for name, block in steps:
        if size() <= max_chars:
            break
        target = payload.get(block, {})
        if isinstance(target, dict) and name in target:
            target.pop(name, None)
            payload.pop(name, None)
            payload["truncated"].setdefault("dropped", []).append(name)
    for limit_chars in (240, 120):
        if size() <= max_chars:
            break
        for name in ("observations", "lessons", "claims", "sections", "contributions", "terminology"):
            for item in payload.get(name) or []:
                for key in ("content", "claim_text", "text", "name", "canonical"):
                    if isinstance(item.get(key), str) and len(item[key]) > limit_chars:
                        item[key] = item[key][:limit_chars] + " …"
            if payload.get(name):
                payload["truncated"].setdefault("shortened", [])
                if name not in payload["truncated"]["shortened"]:
                    payload["truncated"]["shortened"].append(name)
    payload.setdefault("hint", "Call papermemory_list (kind=claims|lessons|coverage) for the full rows.")
    while size() > max_chars and payload.get("lessons"):
        payload["lessons"] = payload["lessons"][: max(1, len(payload["lessons"]) - 1)]
        payload["volatile"]["lessons"] = payload["lessons"]
        payload["truncated"].setdefault("dropped", []).append("lessons-tail")
    return payload


def recap(store: Store, project: str | None = None, limit: int = 8, max_chars: int = 6000) -> dict[str, Any]:
    global_stats = store.stats()
    if project:
        ms = store.get_manuscript(project)
        project_row = store.conn.execute("SELECT key FROM projects WHERE key=?", (project,)).fetchone()
        if not ms and not project_row:
            return {
                "project": project,
                "empty_reason": "project-not-found",
                "known_projects": [row["key"] for row in store.conn.execute("SELECT key FROM projects ORDER BY key")],
                "stats": global_stats,
                "global_stats": global_stats,
            }
    else:
        ms = None
    scope_stats = _scope_stats(store, project)
    empty_reasons: dict[str, str] = {}
    stable: dict[str, Any] = {}
    volatile: dict[str, Any] = {}
    if ms:
        stable["manuscript"] = {
            key: ms.get(key) for key in ("id", "slug", "title", "target_venue", "citation_style", "status", "root_path")
        }
        stable["sections"] = [
            dict(row)
            for row in store.conn.execute(
                "SELECT name, path, word_target, word_count, status FROM manuscript_sections WHERE manuscript_id=? ORDER BY name LIMIT 12",
                (ms["id"],),
            ).fetchall()
        ]
        stable["contributions"] = [
            _short(row["text"], 400)[0]
            for row in store.conn.execute(
                "SELECT text FROM contributions WHERE manuscript_id=? ORDER BY order_index LIMIT 6",
                (ms["id"],),
            ).fetchall()
        ]
        stable["terminology"] = [
            {"canonical": row["canonical"], "avoid": loads(row["avoid_json"], [])}
            for row in store.conn.execute(
                "SELECT canonical, avoid_json FROM terminology WHERE manuscript_id=? ORDER BY canonical LIMIT 12", (ms["id"],)
            ).fetchall()
        ]
        comments = [
            {"id": row["id"], "reviewer": row["reviewer"], "comment": _short(row["comment"], 400)[0], "status": row["status"]}
            for row in store.conn.execute(
                "SELECT id, reviewer, comment, status FROM reviewer_comments WHERE manuscript_id=? AND status='open' ORDER BY created_at DESC LIMIT 5",
                (ms["id"],),
            ).fetchall()
        ]
        stable["open_reviewer_comments"] = comments
        if not comments:
            empty_reasons["open_reviewer_comments"] = "no-open-comments"
    # volatile windows
    claim_rows = []
    if project:
        claim_rows = [
            dict(row)
            for row in store.conn.execute(
                """SELECT c.id, c.paper_id, c.claim_text, c.claim_type, c.status, c.status_reason, c.quote_sha256,
                          c.updated_at, p.title AS paper_title
                   FROM claims c JOIN papers p ON p.id=c.paper_id
                   WHERE c.is_latest=1 AND c.status IN ('extracted','verified')
                     AND EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=c.paper_id AND pp.project_key=?)
                   ORDER BY c.updated_at DESC LIMIT ?""",
                (project, limit),
            ).fetchall()
        ]
    for item in claim_rows:
        item["claim_text"], item["truncated"] = _short(item.get("claim_text"), 400)
    volatile["claims"] = claim_rows
    if not claim_rows:
        empty_reasons["claims"] = "no-claims-in-project"
    obs_sql = """SELECT * FROM observations WHERE superseded_by IS NULL"""
    obs_args: list[Any] = []
    if project:
        obs_sql += " AND (project_id=? OR project_id IS NULL)"
        obs_args.append(project)
    obs_sql += " ORDER BY CASE tier WHEN 'semantic' THEN 0 ELSE 1 END, created_at DESC LIMIT ?"
    obs_args.append(limit)
    observations = []
    for row in store.conn.execute(obs_sql, obs_args).fetchall():
        content, was_truncated = _short(row["content"], 600)
        observations.append(
            {
                "id": row["id"], "tier": row["tier"], "content": content,
                "truncated": was_truncated, "created_at": row["created_at"],
                "project_id": row["project_id"],
                "concepts": loads(row["concepts_json"], []),
            }
        )
    volatile["observations"] = observations
    if not observations:
        empty_reasons["observations"] = "no-observations"
    lesson_sql = "SELECT * FROM lessons WHERE superseded_by IS NULL"
    lesson_args: list[Any] = []
    if project:
        lesson_sql += " AND (project_id=? OR project_id='unassigned' OR project_id IS NULL)"
        lesson_args.append(project)
    lesson_sql += " ORDER BY created_at DESC LIMIT 20"
    lessons = []
    for row in store.conn.execute(lesson_sql, lesson_args).fetchall():
        content, was_truncated = _short(row["content"], 400)
        lessons.append(
            {
                "id": row["id"], "content": content, "truncated": was_truncated,
                "status": row["status"], "project_id": row["project_id"],
                "created_at": row["created_at"],
            }
        )
    volatile["lessons"] = lessons
    if not lessons:
        empty_reasons["lessons"] = "no-lessons"
    paper_sql = """SELECT p.id, p.title, p.year, p.bibtex_key, p.verified, p.venue, p.cite_state
                   FROM papers p"""
    paper_args: list[Any] = []
    if project:
        paper_sql += " WHERE EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)"
        paper_args.append(project)
    paper_sql += " ORDER BY p.updated_at DESC LIMIT ?"
    paper_args.append(limit)
    recent = [dict(row) for row in store.conn.execute(paper_sql, paper_args).fetchall()]
    volatile["recent_papers"] = recent
    if not recent:
        empty_reasons["recent_papers"] = "no-papers-in-project"
    if ms:
        try:
            volatile["cite_check"] = cite_check(store, ms["slug"])
        except Exception as exc:
            volatile["cite_check_error"] = str(exc)
    volatile["window_counts"] = {
        "claims": scope_stats["claims"],
        "observations": len(observations),
        "lessons": len(lessons),
        "papers": scope_stats["papers"],
    }
    payload: dict[str, Any] = {
        "project": project,
        "stats": global_stats,
        "scope_stats": scope_stats,
        "global_stats": global_stats,
        "stable": stable,
        "volatile": volatile,
        "empty_reasons": empty_reasons,
        "truncated": {},
    }
    for key, value in stable.items():
        payload[key] = value
    for key, value in volatile.items():
        if key != "window_counts":
            payload[key] = value
    if scope_stats["papers"] > len(recent) or scope_stats["claims"] > len(claim_rows):
        payload["hint"] = "Call papermemory_list (kind=claims|lessons|coverage) for the full rows."
    if not empty_reasons:
        payload.pop("empty_reasons")
    if not payload["truncated"]:
        payload.pop("truncated")
    return _degrade(payload, max_chars)
