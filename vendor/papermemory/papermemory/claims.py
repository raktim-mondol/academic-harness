from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from papermemory.grounding import quote_check
from papermemory.tokenizer import normalize, terms
from papermemory.util import new_id, now_iso


class ClaimError(Exception):
    def __init__(self, code: str, detail: str | None = None):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def claim_key(paper_id: str, norm_text: str, quote_sha256: str) -> str:
    return _sha(f"{paper_id}|{norm_text}|{quote_sha256}")[:16]


def _jaccard(left: str, right: str) -> float:
    a, b = set(terms(left)), set(terms(right))
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _project_for(store, paper: dict, data_project: str | None, manuscript_id: str | None) -> str:
    if data_project:
        return data_project
    if paper.get("project_id"):
        return paper["project_id"]
    if manuscript_id:
        row = store.conn.execute(
            "SELECT slug FROM manuscripts WHERE id=? OR slug=?", (manuscript_id, manuscript_id)
        ).fetchone()
        if row:
            return row["slug"]
    row = store.conn.execute(
        "SELECT project_key FROM paper_projects WHERE paper_id=? ORDER BY first_seen LIMIT 1",
        (paper["id"],),
    ).fetchone()
    return row["project_key"] if row else "unassigned"


def _history(store, claim_id: str, event: str, old_status: str | None, new_status: str | None,
             actor: str, reason: str, old_text: str | None = None, new_text: str | None = None) -> None:
    store.conn.execute(
        """INSERT INTO claims_history(id, claim_id, event, old_status, new_status, old_claim_text,
           new_claim_text, actor, reason, at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (new_id("csh"), claim_id, event, old_status, new_status, old_text, new_text, actor, reason, now_iso()),
    )


def add_claim(
    store,
    *,
    text: str,
    asserted_quote: str,
    paper_id: str,
    project_key: str | None = None,
    chunk_ids: list[str] | None = None,
    claim_type: str = "finding",
    manuscript_id: str | None = None,
    actor: str = "agent",
) -> dict[str, Any]:
    if not text or not text.strip():
        raise ClaimError("claim-text-required")
    if asserted_quote is None or not asserted_quote.strip():
        raise ClaimError("quote-required")
    paper = store.get_paper(paper_id)
    if not paper:
        raise ClaimError("paper-not-found")
    doc_id = paper.get("current_doc_id")
    if not doc_id:
        raise ClaimError("no-source-text")
    doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (doc_id,)).fetchone()
    if not doc:
        raise ClaimError("no-source-text")
    check = quote_check(store, asserted_quote, doc_id=doc_id)
    status = "extracted"
    reason = ""
    if check["reason"] == "bibliography-only":
        raise ClaimError("bibliography-only")
    if not check["found"]:
        pattern = r"\s+".join(re.escape(token) for token in asserted_quote.split())
        match = re.search(pattern, doc["text"])
        if not match:
            raise ClaimError("quote-not-verbatim")
        qcs, qce = match.span()
        span_text = doc["text"][qcs:qce]
        status, reason = "unverified-quote", "asserted-quote-differs"
    else:
        occurrence = next(
            (item for item in check["occurrences"] if item["chunk_id"] and not item["is_bibliography"]),
            check["occurrences"][0],
        )
        qcs, qce = occurrence["char_span"]
        span_text = doc["text"][qcs:qce]
        if span_text != asserted_quote:
            status, reason = "unverified-quote", "asserted-quote-differs"
    if doc["origin_channel"] == "ocr-recovered":
        status, reason = "extracted", "channel-capped:ocr-recovered"
    quote_sha = _sha(span_text)
    norm = normalize(text)
    key = claim_key(paper_id, norm, quote_sha)
    project = _project_for(store, paper, project_key, manuscript_id)
    store.conn.execute(
        "INSERT OR IGNORE INTO projects(key, title, kind, created_at) VALUES (?,?, 'manuscript', ?)",
        (project, project, now_iso()),
    )
    existing = store.conn.execute(
        "SELECT * FROM claims WHERE claim_key=? AND is_latest=1", (key,)
    ).fetchone()
    deduplicated = existing is not None
    section_id = None
    section = store.conn.execute(
        """SELECT id FROM sections WHERE doc_id=? AND char_start<=? AND char_end>=? ORDER BY ord LIMIT 1""",
        (doc_id, qcs, qce),
    ).fetchone()
    if section:
        section_id = section["id"]
    line_start = doc["text"][:qcs].count("\n") + 1
    line_end = doc["text"][:qce].count("\n") + 1
    now = now_iso()
    if existing:
        claim_id = existing["id"]
        store.conn.execute(
            """UPDATE claims SET claim_text=?, claim_text_norm=?, claim_type=?, asserted_quote=?,
               quote_char_start=?, quote_char_end=?, quote_line_start=?, quote_line_end=?,
               quote_sha256=?, doc_id=?, primary_section_id=?, source_sha256=?, origin_channel=?,
               pipeline_version=?, project_key=?, status='unverified-quote', status_reason='re-derived',
               confidence=?, updated_at=? WHERE id=?""",
            (
                text.strip(), norm, claim_type, asserted_quote, qcs, qce, line_start, line_end,
                quote_sha, doc_id, section_id, doc["sha256"], doc["origin_channel"],
                doc["pipeline_version"], project, 0.4, now, claim_id,
            ),
        )
        _history(store, claim_id, "status_change", existing["status"], "unverified-quote", actor, "re-derived")
        status, reason = "unverified-quote", "re-derived"
    else:
        claim_id = "clm_" + _sha(f"{key}|{doc_id}||")[:12]
        store.conn.execute(
            """INSERT INTO claims(id, claim_key, paper_id, manuscript_id, project_key, claim_text,
               claim_text_norm, claim_type, asserted_quote, quote_char_start, quote_char_end,
               quote_line_start, quote_line_end, quote_sha256, doc_id, primary_section_id,
               source_sha256, origin_channel, pipeline_version, status, status_reason,
               confidence, is_latest, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)""",
            (
                claim_id, key, paper_id, manuscript_id, project, text.strip(), norm, claim_type,
                asserted_quote, qcs, qce, line_start, line_end, quote_sha, doc_id, section_id,
                doc["sha256"], doc["origin_channel"], doc["pipeline_version"], status, reason,
                0.4, now, now,
            ),
        )
        _history(store, claim_id, "create", None, status, actor, "created")
    overlapping = store.conn.execute(
        """SELECT id FROM chunks WHERE doc_id=? AND char_start < ? AND char_end > ?
           ORDER BY chunk_index""",
        (doc_id, qce, qcs),
    ).fetchall()
    allowed = {row["id"] for row in overlapping}
    if chunk_ids:
        allowed &= set(chunk_ids)
    store.conn.execute("DELETE FROM claim_sources WHERE claim_id=?", (claim_id,))
    for ord_index, chunk_id in enumerate(sorted(allowed)[:3]):
        store.conn.execute(
            "INSERT OR IGNORE INTO claim_sources(claim_id, chunk_id, ord) VALUES (?,?,?)",
            (claim_id, chunk_id, ord_index),
        )
    if not allowed:
        raise ClaimError("uncovered-span")
    similar: list[dict[str, Any]] = []
    for other in store.conn.execute(
        "SELECT id, claim_text_norm, status FROM claims WHERE paper_id=? AND is_latest=1 AND id != ?",
        (paper_id, claim_id),
    ).fetchall():
        score = _jaccard(norm, other["claim_text_norm"])
        if score > 0.9:
            store.conn.execute(
                "UPDATE claims SET is_latest=0, status='superseded', superseded_by=?, status_reason='similar-claim', updated_at=? WHERE id=?",
                (claim_id, now, other["id"]),
            )
            _history(store, other["id"], "supersede", other["status"], "superseded", actor, "similar-claim")
        elif score >= 0.4:
            similar.append({"id": other["id"], "score": round(score, 3)})
    store.mut("CLAIM_WRITE", paper_id=paper_id, claim_id=claim_id, doc_id=doc_id, status=status, reason_code=reason)
    store.conn.commit()
    row = store.conn.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
    return {
        "claim": dict(row),
        "quote_check": check,
        "status": status,
        "similar_to": similar,
        "deduplicated": deduplicated,
    }


def supersede_claim(store, claim_id: str, *, by_claim_id: str | None = None, reason: str, actor: str) -> None:
    row = store.conn.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
    if not row:
        raise ClaimError("claim-not-found")
    now = now_iso()
    store.conn.execute(
        "UPDATE claims SET is_latest=0, status='superseded', superseded_by=?, status_reason=?, updated_at=? WHERE id=?",
        (by_claim_id, reason, now, claim_id),
    )
    _history(store, claim_id, "supersede", row["status"], "superseded", actor, reason)
    store.mut("CLAIM_TRANSITION", paper_id=row["paper_id"], claim_id=claim_id, status="superseded", reason_code=reason)
    store.conn.commit()


def contradict_claim(store, claim_id: str, *, evidence_claim_id: str | None = None, ah_verdict=None, reason: str, actor: str) -> None:
    row = store.conn.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
    if not row:
        raise ClaimError("claim-not-found")
    now = now_iso()
    store.conn.execute(
        "UPDATE claims SET status='contradicted', status_reason=?, updated_at=? WHERE id=?",
        (reason, now, claim_id),
    )
    _history(store, claim_id, "contradict", row["status"], "contradicted", actor, reason)
    store.mut("CLAIM_TRANSITION", paper_id=row["paper_id"], claim_id=claim_id, status="contradicted", reason_code=reason)
    store.conn.commit()


def rebind_claim(store, claim_id: str, *, new_doc_id: str) -> dict[str, Any]:
    row = store.conn.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
    if not row:
        raise ClaimError("claim-not-found")
    old_doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (row["doc_id"],)).fetchone()
    new_doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (new_doc_id,)).fetchone()
    if not old_doc or not new_doc:
        raise ClaimError("doc-not-found")
    quote_text = old_doc["text"][row["quote_char_start"]:row["quote_char_end"]]
    check = quote_check(store, quote_text, doc_id=new_doc_id)
    now = now_iso()
    if check["found"] and check["reason"] == "":
        occurrence = next(item for item in check["occurrences"] if item["chunk_id"])
        qcs, qce = occurrence["char_span"]
        status = "extracted"
        reason = ""
        if new_doc["origin_channel"] == "ocr-recovered":
            status, reason = "extracted", "channel-capped:ocr-recovered"
        store.conn.execute(
            """UPDATE claims SET doc_id=?, quote_char_start=?, quote_char_end=?, quote_sha256=?,
               source_sha256=?, origin_channel=?, status=?, status_reason=?, updated_at=? WHERE id=?""",
            (
                new_doc_id, qcs, qce, _sha(new_doc["text"][qcs:qce]), new_doc["sha256"],
                new_doc["origin_channel"], status, reason, now, claim_id,
            ),
        )
        _history(store, claim_id, "rebind", row["status"], status, "owner", "rebound")
    else:
        store.conn.execute(
            "UPDATE claims SET status='unverified-quote', status_reason='locator-drift', updated_at=? WHERE id=?",
            (now, claim_id),
        )
        _history(store, claim_id, "rebind", row["status"], "unverified-quote", "owner", "locator-drift")
    store.mut("CLAIM_TRANSITION", paper_id=row["paper_id"], claim_id=claim_id, status="rebind", reason_code=check["reason"] or "rebound")
    store.conn.commit()
    return check


def list_claims(
    store,
    *,
    project: str | None = None,
    status: str | None = None,
    since: str | None = None,
    cursor: int | None = None,
    page_size: int = 50,
) -> dict[str, Any]:
    page_size = max(1, min(int(page_size), 200))
    where = ["c.is_latest=1"]
    args: list[Any] = []
    if project:
        where.append("EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=c.paper_id AND pp.project_key=?)")
        args.append(project)
    if status:
        where.append("c.status=?")
        args.append(status)
    else:
        where.append("c.status != 'contradicted'")
    if since:
        where.append("c.updated_at >= ?")
        args.append(since)
    total = store.conn.execute(
        f"SELECT COUNT(*) FROM claims c WHERE {' AND '.join(where)}", args
    ).fetchone()[0]
    query = f"""SELECT c.*, p.title AS paper_title, s.heading_path, r.text AS raw_text
                FROM claims c JOIN papers p ON p.id=c.paper_id
                LEFT JOIN sections s ON s.id=c.primary_section_id
                LEFT JOIN raw_documents r ON r.id=c.doc_id
                WHERE {' AND '.join(where)}"""
    query_args = list(args)
    if cursor is not None:
        query += " AND c.seq > ?"
        query_args.append(cursor)
    query += " ORDER BY c.seq LIMIT ?"
    query_args.append(page_size + 1)
    rows = store.conn.execute(query, query_args).fetchall()
    more = len(rows) > page_size
    rows = rows[:page_size]
    result = []
    for row in rows:
        record = dict(row)
        if record.get("raw_text") is not None:
            record["evidence_quote"] = record["raw_text"][record["quote_char_start"]:record["quote_char_end"]]
        record.pop("raw_text", None)
        result.append(record)
    next_cursor = rows[-1]["seq"] if more and rows else None
    return {"rows": result, "total_count": total, "next_cursor": next_cursor}


def supersession_sweep(store, doc_id: str, *, batch_size: int = 200) -> dict[str, Any]:
    doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (doc_id,)).fetchone()
    if not doc:
        raise ClaimError("doc-not-found")
    sweep = store.conn.execute(
        "SELECT * FROM sweeps WHERE kind='doc_supersede' AND doc_id=? AND state='running' ORDER BY started_at DESC LIMIT 1",
        (doc_id,),
    ).fetchone()
    pending_filter = "(is_latest=1 OR status NOT IN ('unverified-quote'))"
    if not sweep:
        total = store.conn.execute(
            f"SELECT COUNT(*) FROM claims WHERE doc_id=? AND {pending_filter}", (doc_id,)
        ).fetchone()[0]
        if total == 0:
            return {"processed": 0, "state": "done", "cursor": 0}
        sweep_id = new_id("swp")
        cursor = 0
        store.conn.execute(
            "INSERT INTO sweeps(id, kind, paper_id, doc_id, cursor, total, state, started_at, updated_at) VALUES (?, 'doc_supersede', ?, ?, 0, ?, 'running', ?, ?)",
            (sweep_id, doc["paper_id"], doc_id, total, now_iso(), now_iso()),
        )
        store.conn.commit()
    else:
        sweep_id, cursor = sweep["id"], int(sweep["cursor"])
    paper = store.conn.execute("SELECT current_doc_id FROM papers WHERE id=?", (doc["paper_id"],)).fetchone()
    if paper and paper["current_doc_id"] == doc_id:
        store.conn.execute("UPDATE sweeps SET state='done', updated_at=? WHERE id=?", (now_iso(), sweep_id))
        store.conn.commit()
        return {"processed": 0, "state": "done", "cursor": cursor}
    processed = 0
    while True:
        rows = store.conn.execute(
            f"SELECT * FROM claims WHERE doc_id=? AND seq>? AND {pending_filter} ORDER BY seq LIMIT ?",
            (doc_id, cursor, batch_size),
        ).fetchall()
        if not rows:
            break
        for claim in rows:
            quote_text = doc["text"][claim["quote_char_start"]:claim["quote_char_end"]]
            check = (
                quote_check(store, quote_text, doc_id=paper["current_doc_id"])
                if paper and paper["current_doc_id"]
                else {"found": False}
            )
            reason = "doc-superseded" if check.get("found") and check.get("reason") == "" else "locator-drift"
            now = now_iso()
            store.conn.execute(
                "UPDATE claims SET status='unverified-quote', status_reason=?, is_latest=0, updated_at=? WHERE id=?",
                (reason, now, claim["id"]),
            )
            _history(store, claim["id"], "status_change", claim["status"], "unverified-quote", "sweep", reason)
            cursor = claim["seq"]
        store.conn.execute(
            "UPDATE sweeps SET cursor=?, updated_at=? WHERE id=?", (cursor, now_iso(), sweep_id)
        )
        store.mut("SWEEP", paper_id=doc["paper_id"], doc_id=doc_id, status="ok", reason_code="doc_supersede")
        store.conn.commit()
        processed += len(rows)
    store.conn.execute("UPDATE sweeps SET state='done', updated_at=? WHERE id=?", (now_iso(), sweep_id))
    store.conn.commit()
    return {"processed": processed, "state": "done", "cursor": cursor}


def write_catalog(store, project: str | None = None) -> dict[str, Any]:
    base = store.path.parent / "corpus"
    base.mkdir(parents=True, exist_ok=True)
    projects: dict[str, Any] = {}
    rows = store.conn.execute(
        """SELECT p.id, p.title, p.doi, p.cite_state, p.project_id,
                  (SELECT COUNT(*) FROM chunks c WHERE c.paper_id=p.id) AS chunks,
                  (SELECT COUNT(*) FROM claims cl WHERE cl.paper_id=p.id AND cl.is_latest=1) AS claims
           FROM papers p ORDER BY p.id"""
    ).fetchall()
    for row in rows:
        key = row["project_id"] or "unassigned"
        entry = projects.setdefault(key, {"papers": 0, "chunks": 0, "claims": 0, "chunkless": 0, "items": []})
        entry["papers"] += 1
        entry["chunks"] += row["chunks"]
        entry["claims"] += row["claims"]
        entry["chunkless"] += 1 if row["cite_state"] == "chunkless" else 0
        entry["items"].append(
            {"id": row["id"], "title": row["title"], "doi": row["doi"], "cite_state": row["cite_state"],
             "chunks": row["chunks"], "claims": row["claims"]}
        )
    data = {"generated_at": now_iso(), "projects": projects}
    json_path = base / "CATALOG.json"
    md_path = base / "CATALOG.md"
    json_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    lines = ["# PaperMemory catalog", ""]
    for key, entry in sorted(projects.items()):
        lines.append(f"## {key}")
        lines.append(f"papers={entry['papers']} chunks={entry['chunks']} claims={entry['claims']} chunkless={entry['chunkless']}")
        for item in entry["items"]:
            lines.append(f"- `{item['id']}` [{item['cite_state']}] {item['title']}")
        lines.append("")
    md_path.write_text("\n".join(lines), encoding="utf-8")
    return {"json": str(json_path), "md": str(md_path)}
