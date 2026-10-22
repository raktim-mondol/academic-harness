from __future__ import annotations

import json
from typing import Any

from papermemory.db import Store
from papermemory.tokenizer import fts_match, overlap
from papermemory.util import loads

RRF_K = 60
MAX_LIMIT = 50


class BudgetExceeded(Exception):
    code = "budget-exceeded"


def _project_exists(store: Store, project_id: str) -> bool:
    return store.conn.execute("SELECT 1 FROM projects WHERE key=?", (project_id,)).fetchone() is not None


def _scope_clause(paper_expr: str) -> str:
    return f" AND EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id={paper_expr} AND pp.project_key=?)"


def _chunk_leg(store, query, limit, project_id, section_roles):
    match = fts_match(query)
    stats = {"corpus_match_count": 0, "suppressed": {"bibliography": 0, "non_claimable": 0}, "error": None}
    if not match:
        return [], stats
    scope = _scope_clause("c.paper_id") if project_id else ""
    try:
        stats["corpus_match_count"] = store.conn.execute(
            """SELECT COUNT(*) FROM chunks_fts JOIN chunks c ON c.seq=chunks_fts.rowid
               JOIN raw_documents r ON r.id=c.doc_id
               WHERE chunks_fts MATCH ? AND r.is_current=1""",
            (match,),
        ).fetchone()[0]
        for key, predicate in (("bibliography", "c.is_bibliography=1"), ("non_claimable", "c.claimable=0")):
            args: list[Any] = [match] + ([project_id] if project_id else [])
            stats["suppressed"][key] = store.conn.execute(
                f"""SELECT COUNT(*) FROM chunks_fts JOIN chunks c ON c.seq=chunks_fts.rowid
                    JOIN raw_documents r ON r.id=c.doc_id
                    WHERE chunks_fts MATCH ? AND r.is_current=1 AND {predicate}{scope}""",
                args,
            ).fetchone()[0]
        sql = """
            SELECT c.*, bm25(chunks_fts) AS rank, r.text AS raw_text,
                   r.created_at AS doc_created_at, s.heading_path, s.role,
                   p.title AS paper_title, p.bibtex_key, p.year, p.verified, p.cite_state
            FROM chunks_fts
            JOIN chunks c ON c.seq=chunks_fts.rowid
            JOIN raw_documents r ON r.id=c.doc_id
            JOIN sections s ON s.id=c.section_id
            JOIN papers p ON p.id=c.paper_id
            WHERE chunks_fts MATCH ? AND r.is_current=1 AND c.claimable=1 AND c.is_bibliography=0
        """
        args = [match]
        if section_roles:
            sql += f" AND s.role IN ({','.join('?' for _ in section_roles)})"
            args.extend(section_roles)
        if project_id:
            sql += scope
            args.append(project_id)
        sql += " ORDER BY rank LIMIT ?"
        args.append(max(4 * limit, 64) * (2 if project_id else 1))
        rows = store.conn.execute(sql, args).fetchall()
    except Exception as exc:
        stats["error"] = str(exc)
        return [], stats
    hits = []
    for rank, row in enumerate(rows, 1):
        record = dict(row)
        record["kind"] = "chunk"
        record["label"] = record.get("paper_title")
        record["snippet"] = " ".join(
            (record["raw_text"][record["char_start"]:record["char_end"]] or "").split()
        )[:400]
        record.pop("raw_text", None)
        record["created_at"] = record.get("doc_created_at")
        record["overlap"] = overlap(query, record["snippet"])
        record["score"] = (1.0 / (RRF_K + rank)) * (0.15 + record["overlap"])
        hits.append(record)
    return hits, stats


def _claim_leg(store, query, limit, project_id, section_roles):
    from papermemory.tokenizer import terms

    tokens = list(dict.fromkeys(terms(query)))[:12]
    stats = {"suppressed": {"superseded_claim": 0}, "error": None}
    if not tokens:
        return [], stats
    where = "(" + " OR ".join("c.claim_text LIKE ?" for _ in tokens) + ")"
    suppressed_sql = f"SELECT COUNT(*) FROM claims c WHERE c.is_latest=0 AND {where}"
    suppressed_args: list[Any] = [f"%{token}%" for token in tokens]
    if project_id:
        suppressed_sql += " AND c.project_key=?"
        suppressed_args.append(project_id)
    try:
        stats["suppressed"]["superseded_claim"] = store.conn.execute(suppressed_sql, suppressed_args).fetchone()[0]
        sql = f"""
            SELECT c.*, s.heading_path, s.role, p.title AS paper_title, p.bibtex_key, p.year, p.verified
            FROM claims c JOIN papers p ON p.id=c.paper_id
            LEFT JOIN sections s ON s.id=c.primary_section_id
            WHERE c.is_latest=1 AND c.status IN ('extracted','verified') AND {where}
        """
        args: list[Any] = [f"%{token}%" for token in tokens]
        if section_roles:
            sql += f" AND s.role IN ({','.join('?' for _ in section_roles)})"
            args.extend(section_roles)
        if project_id:
            sql += _scope_clause("c.paper_id")
            args.append(project_id)
        rows = store.conn.execute(sql, args).fetchall()
    except Exception as exc:
        stats["error"] = str(exc)
        return [], stats
    scored = []
    for row in rows:
        record = dict(row)
        record["kind"] = "claim"
        record["label"] = record["claim_text"]
        record["snippet"] = (record.get("evidence_quote") or record["claim_text"])[:400]
        record["overlap"] = overlap(query, f"{record['claim_text']} {record.get('evidence_quote') or ''}")
        record["grounded"] = bool(
            store.conn.execute("SELECT 1 FROM claim_sources WHERE claim_id=?", (record["id"],)).fetchone()
        )
        scored.append(record)
    scored.sort(key=lambda item: item["overlap"], reverse=True)
    for rank, record in enumerate(scored, 1):
        record["score"] = (1.0 / (RRF_K + rank)) * (0.15 + record["overlap"])
    return scored[: max(4 * limit, 32)], stats


def _paper_leg(store, query, limit, project_id, *, include_chunkless: bool):
    from papermemory.tokenizer import terms

    tokens = list(dict.fromkeys(terms(query)))[:12]
    stats = {"suppressed": {"chunkless_paper": 0}, "error": None}
    if not tokens:
        return [], stats
    fields = ("title", "abstract", "bibtex_key", "doi", "arxiv_id", "authors_json")
    where = "(" + " OR ".join(f"p.{field} LIKE ?" for field in fields for _ in tokens) + ")"
    args: list[Any] = [f"%{token}%" for field in fields for token in tokens]
    try:
        suppressed_sql = f"SELECT COUNT(*) FROM papers p WHERE p.cite_state='chunkless' AND {where}"
        suppressed_args = list(args)
        if project_id:
            suppressed_sql += _scope_clause("p.id")
            suppressed_args.append(project_id)
        stats["suppressed"]["chunkless_paper"] = store.conn.execute(suppressed_sql, suppressed_args).fetchone()[0]
        sql = f"SELECT p.* FROM papers p WHERE {where}"
        query_args = list(args)
        if project_id:
            sql += _scope_clause("p.id")
            query_args.append(project_id)
        if not include_chunkless:
            sql += " AND p.cite_state != 'chunkless'"
        rows = store.conn.execute(sql, query_args).fetchall()
    except Exception as exc:
        stats["error"] = str(exc)
        return [], stats
    scored = []
    for row in rows:
        record = dict(row)
        record["authors"] = loads(record.get("authors_json"), [])
        record["kind"] = "paper"
        record["label"] = record["title"]
        record["snippet"] = (record.get("abstract") or record["title"])[:400]
        blob = " ".join(
            [record.get("title") or "", record.get("authors_json") or "", record.get("abstract") or "",
             record.get("venue") or "", record.get("bibtex_key") or "", record.get("doi") or ""]
        )
        record["overlap"] = overlap(query, blob)
        scored.append(record)
    scored.sort(key=lambda item: item["overlap"], reverse=True)
    for rank, record in enumerate(scored, 1):
        record["score"] = (1.0 / (RRF_K + rank)) * (0.15 + record["overlap"])
    return scored[: max(4 * limit, 32)], stats


def _note_leg(store, query, kind, limit, project_id):
    from papermemory.tokenizer import terms

    tokens = list(dict.fromkeys(terms(query)))[:12]
    if not tokens:
        return [], {"suppressed": {}, "error": None}
    results = []
    tables = (
        [("observation", "observations")] if kind == "observation"
        else [("lesson", "lessons")] if kind == "lesson"
        else [("observation", "observations"), ("lesson", "lessons")]
    )
    for item_kind, table in tables:
        where = "(" + " OR ".join("content LIKE ?" for _ in tokens) + ")"
        sql = f"SELECT * FROM {table} WHERE {where} AND superseded_by IS NULL"
        args: list[Any] = [f"%{token}%" for token in tokens]
        if project_id:
            sql += " AND (project_id=? OR project_id IS NULL)"
            args.append(project_id)
        for row in store.conn.execute(sql, args).fetchall():
            record = dict(row)
            record["kind"] = item_kind
            record["label"] = record["content"]
            record["snippet"] = record["content"][:400]
            record["concepts"] = loads(record.get("concepts_json"), [])
            record["overlap"] = overlap(query, record["content"])
            results.append(record)
    results.sort(key=lambda item: item["overlap"], reverse=True)
    for rank, record in enumerate(results, 1):
        record["score"] = (1.0 / (RRF_K + rank)) * (0.15 + record["overlap"])
    return results[: max(4 * limit, 32)], {"suppressed": {}, "error": None}


def _uncovered_suppressed(store, query, project_id) -> int:
    from papermemory.tokenizer import terms

    tokens = set(terms(query))
    if not tokens:
        return 0
    sql = """SELECT r.text, cov.uncovered_json, cov.capped FROM raw_documents r
             JOIN papers p ON p.id=r.paper_id
             JOIN coverage cov ON cov.doc_id=r.id
             WHERE r.is_current=1"""
    args: list[Any] = []
    if project_id:
        sql += _scope_clause("p.id")
        args.append(project_id)
    count = 0
    for row in store.conn.execute(sql, args).fetchall():
        try:
            spans = json.loads(row["uncovered_json"] or "[]")
        except json.JSONDecodeError:
            spans = []
        hit = False
        for start, end in spans:
            if tokens & set(terms(row["text"][start:end])):
                hit = True
                break
        if hit:
            count += 1
    return count


def _capped_docs(store, project_id) -> int:
    sql = """SELECT COUNT(*) FROM papers p
             LEFT JOIN raw_documents r ON r.id=p.current_doc_id
             LEFT JOIN coverage cov ON cov.doc_id=r.id
             WHERE p.cite_state='citable' AND (cov.capped=1 OR cov.doc_id IS NULL)"""
    args: list[Any] = []
    if project_id:
        sql += _scope_clause("p.id")
        args.append(project_id)
    return store.conn.execute(sql, args).fetchone()[0]


def search_with_status(
    store: Store,
    query: str,
    kind: str = "all",
    limit: int = 10,
    project_id: str | None = None,
    section_roles: list[str] | None = None,
) -> dict[str, Any]:
    if limit > MAX_LIMIT:
        raise BudgetExceeded(f"limit {limit} exceeds {MAX_LIMIT}")
    limit = max(1, min(limit, MAX_LIMIT))
    if project_id and not _project_exists(store, project_id):
        return {
            "results": [],
            "empty_reason": "project-not-found",
            "legs": {},
            "corpus_match_count": 0,
            "suppressed": {},
            "coverage": {"capped_docs": 0},
            "absence_scope": [],
            "scope": {"project": project_id},
        }
    legs: dict[str, str] = {}
    errors: list[str] = []
    suppressed: dict[str, int] = {}
    corpus_match_count = 0
    results: list[dict[str, Any]] = []

    if kind in ("all", "chunk"):
        hits, stats = _chunk_leg(store, query, limit, project_id, section_roles)
        legs["chunk"] = "error" if stats.get("error") else "ok"
        if stats.get("error"):
            errors.append("chunk")
        corpus_match_count += stats.get("corpus_match_count", 0)
        for key, value in stats["suppressed"].items():
            suppressed[key] = suppressed.get(key, 0) + value
        results.extend(hits)
    if kind in ("all", "claim"):
        hits, stats = _claim_leg(store, query, limit, project_id, section_roles)
        legs["claim"] = "error" if stats.get("error") else "ok"
        if stats.get("error"):
            errors.append("claim")
        for key, value in stats["suppressed"].items():
            suppressed[key] = suppressed.get(key, 0) + value
        results.extend(hits)
    if kind in ("all", "paper"):
        hits, stats = _paper_leg(store, query, limit, project_id, include_chunkless=(kind == "paper"))
        legs["paper"] = "error" if stats.get("error") else "ok"
        if stats.get("error"):
            errors.append("paper")
        for key, value in stats["suppressed"].items():
            suppressed[key] = suppressed.get(key, 0) + value
        results.extend(hits)
    if kind in ("all", "observation", "lesson"):
        hits, stats = _note_leg(store, query, kind, limit, project_id)
        legs["notes"] = "ok"
        results.extend(hits)
    suppressed["uncovered_span"] = _uncovered_suppressed(store, query, project_id)
    capped_docs = _capped_docs(store, project_id)

    if kind == "chunk":
        ordered = results
    else:
        results.sort(key=lambda item: item["score"], reverse=True)
        ordered = []
    per_paper: dict[str, int] = {}
    final: list[dict[str, Any]] = []
    for record in ordered if kind == "chunk" else results:
        if record["kind"] == "chunk":
            paper_id = record.get("paper_id")
            if per_paper.get(paper_id, 0) >= 2:
                continue
            per_paper[paper_id] = per_paper.get(paper_id, 0) + 1
        final.append(record)
        if len(final) >= limit:
            break

    empty_reason = None
    if not final:
        if errors:
            empty_reason = f"leg-error:{errors[0]}"
        else:
            priority = [
                ("bibliography", "all-suppressed:bibliography"),
                ("non_claimable", "all-suppressed:non-claimable"),
                ("chunkless_paper", "all-suppressed:chunkless-paper"),
                ("uncovered_span", "all-suppressed:uncovered-span"),
                ("superseded_claim", "all-suppressed:superseded-claim"),
            ]
            nonzero = [(key, reason) for key, reason in priority if suppressed.get(key, 0) > 0]
            keys = {key for key, _ in nonzero}
            if nonzero and keys <= {"bibliography", "non_claimable"}:
                empty_reason = nonzero[0][1]
            elif len(nonzero) == 1:
                empty_reason = nonzero[0][1]
            elif nonzero or capped_docs > 0:
                empty_reason = "absence-not-licensable"
            elif project_id and corpus_match_count > 0:
                empty_reason = "no-match-in-project"
            else:
                empty_reason = "no-match"
    return {
        "results": final,
        "empty_reason": empty_reason,
        "legs": legs,
        "corpus_match_count": corpus_match_count,
        "suppressed": suppressed,
        "coverage": {"capped_docs": capped_docs},
        "absence_scope": sorted(legs),
        "scope": {"project": project_id},
    }


def search(
    store: Store,
    query: str,
    kind: str = "all",
    limit: int = 10,
    project_id: str | None = None,
    section_roles: list[str] | None = None,
) -> list[dict[str, Any]]:
    return search_with_status(
        store, query, kind=kind, limit=limit, project_id=project_id, section_roles=section_roles
    )["results"]
