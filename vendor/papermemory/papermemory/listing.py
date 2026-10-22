from __future__ import annotations

import json
from typing import Any

from papermemory.db import Store
from papermemory.util import now_iso


def _page_size(value: int) -> int:
    return max(1, min(int(value), 200))


def list_rows(
    store: Store,
    kind: str,
    *,
    project: str | None = None,
    status: str | None = None,
    cite_state: str | None = None,
    cursor: str | int | None = None,
    page_size: int = 50,
) -> dict[str, Any]:
    if kind == "claims":
        from papermemory.claims import list_claims

        return list_claims(store, project=project, status=status, cursor=int(cursor) if cursor not in (None, "") else None, page_size=page_size)
    if kind == "lessons":
        size = _page_size(page_size)
        where = ["1=1"]
        args: list[Any] = []
        if project:
            where.append("(project_id=? OR project_id='unassigned')")
            args.append(project)
        total = store.conn.execute(f"SELECT COUNT(*) FROM lessons WHERE {' AND '.join(where)}", args).fetchone()[0]
        sql = f"SELECT rowid AS seq, * FROM lessons WHERE {' AND '.join(where)}"
        qargs = list(args)
        if cursor not in (None, ""):
            sql += " AND rowid > ?"
            qargs.append(int(cursor))
        sql += " ORDER BY rowid LIMIT ?"
        qargs.append(size + 1)
        rows = store.conn.execute(sql, qargs).fetchall()
        more = len(rows) > size
        rows = rows[:size]
        data = []
        for row in rows:
            record = dict(row)
            record["concepts"] = json.loads(record.get("concepts_json") or "[]")
            data.append(record)
        return {"rows": data, "total_count": total, "next_cursor": rows[-1]["seq"] if more and rows else None}
    if kind == "coverage":
        where = ["d.is_current=1"]
        args: list[Any] = []
        if project:
            where.append("EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)")
            args.append(project)
        docs = [
            dict(row)
            for row in store.conn.execute(
                f"""SELECT cov.*, p.id AS paper_id, p.title, p.doi, p.cite_state, d.origin_path
                    FROM coverage cov JOIN raw_documents d ON d.id=cov.doc_id
                    JOIN papers p ON p.id=d.paper_id
                    WHERE {' AND '.join(where)} ORDER BY cov.ratio ASC, p.id""",
                args,
            ).fetchall()
        ]
        chunkless_sql = "SELECT p.id FROM papers p WHERE p.cite_state='chunkless'"
        chunkless_args: list[Any] = []
        if project:
            chunkless_sql += " AND EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)"
            chunkless_args.append(project)
        chunkless = [row["id"] for row in store.conn.execute(chunkless_sql, chunkless_args).fetchall()]
        rollup = {
            "docs": len(docs),
            "source_chars": sum(row["source_chars"] for row in docs),
            "indexed_chars": sum(row["indexed_chars"] for row in docs),
            "capped": sum(1 for row in docs if row["capped"]),
            "with_uncovered": sum(1 for row in docs if row["uncovered_json"] not in ("[]", "", None)),
        }
        rollup["ratio"] = rollup["indexed_chars"] / max(rollup["source_chars"], 1)
        return {"rows": docs, "rollup": rollup, "chunkless_papers": chunkless}
    # papers
    size = _page_size(page_size)
    where = ["1=1"]
    args: list[Any] = []
    if project:
        where.append("EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)")
        args.append(project)
    if cite_state:
        where.append("p.cite_state=?")
        args.append(cite_state)
    total = store.conn.execute(f"SELECT COUNT(*) FROM papers p WHERE {' AND '.join(where)}", args).fetchone()[0]
    sql = f"""SELECT p.id, p.title, p.year, p.doi, p.cite_state, p.verified,
                     (SELECT group_concat(pp.project_key) FROM paper_projects pp WHERE pp.paper_id=p.id) AS projects
              FROM papers p WHERE {' AND '.join(where)}"""
    qargs = list(args)
    if cursor not in (None, ""):
        sql += " AND p.id > ?"
        qargs.append(str(cursor))
    sql += " ORDER BY p.id LIMIT ?"
    qargs.append(size + 1)
    rows = store.conn.execute(sql, qargs).fetchall()
    more = len(rows) > size
    rows = rows[:size]
    return {"rows": [dict(row) for row in rows], "total_count": total, "next_cursor": rows[-1]["id"] if more and rows else None}
