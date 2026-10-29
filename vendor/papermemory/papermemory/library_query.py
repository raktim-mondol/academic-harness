"""Library queries: filter syntax, keyset-paged listing, tag counts.

Filter syntax (tokens are space separated; quote values with spaces)::

    tag:ml  -tag:review  collection:thesis  project:scandy
    year:2021  year:2020..2024  year:2020..  year:..2019
    author:"van der"  venue:nature  title:attention
    key:smith  doi:10.1/abc  arxiv:2101.00001
    has:pdf|fulltext|doi|abstract|notes|key|tags
    verified:yes|no  integrity:retracted|unchecked|...
    plain words           (all must appear in title, abstract, authors, venue, DOI, key, tags or notes)

A leading ``-`` or ``!`` negates a field filter (use ``!`` on the command line,
where a leading ``-`` is read as an option, and quote it in interactive shells). An unknown field is an error, never a
silent no-op.
"""
from __future__ import annotations

import base64
import json
import re
import shlex
from dataclasses import dataclass, field
from typing import Any

from papermemory.db import Store
from papermemory.util import loads

FIELDS = (
    "tag", "collection", "project", "year", "author", "venue", "title", "key", "doi", "arxiv",
    "has", "verified", "integrity",
)
HAS_VALUES = ("pdf", "fulltext", "doi", "abstract", "notes", "key", "tags")
SORTS = {
    "added": ("p.rowid", None),
    "year": ("COALESCE(p.year, 0)", "year"),
    "title": ("lower(p.title)", "title"),
    "key": ("COALESCE(k.key, '')", "key"),
}
MAX_PAGE = 200
_FIELD_TOKEN = re.compile(r"^([-!]?)([A-Za-z]+):(.*)$")
_YEAR = re.compile(r"^(?:(\d{4})|(\d{4})?(\.\.)(\d{4})?)$")


class QueryError(ValueError):
    code = "bad-query"


@dataclass
class Query:
    terms: list[str] = field(default_factory=list)
    filters: list[tuple[bool, str, str]] = field(default_factory=list)  # (negated, field, value)


def parse_query(tokens: str | list[str] | None) -> Query:
    if tokens is None:
        return Query()
    if isinstance(tokens, str):
        try:
            tokens = shlex.split(tokens)
        except ValueError as exc:
            raise QueryError(f"cannot parse query: {exc}") from exc
    query = Query()
    for token in tokens:
        token = token.strip()
        if not token:
            continue
        match = _FIELD_TOKEN.match(token)
        if match and match.group(2).lower() in FIELDS:
            query.filters.append((bool(match.group(1)), match.group(2).lower(), match.group(3).strip()))
        elif match and match.group(2).isalpha() and not match.group(3).startswith("//"):
            raise QueryError(f"unknown filter field {match.group(2)!r}; use {', '.join(FIELDS)}")
        else:
            query.terms.append(token)
    for negated, name, value in query.filters:
        if not value:
            raise QueryError(f"filter {name}: needs a value")
        if name == "has" and value.lower() not in HAS_VALUES:
            raise QueryError(f"has: expects one of {', '.join(HAS_VALUES)}")
        if name == "verified" and value.lower() not in {"yes", "no", "true", "false", "1", "0"}:
            raise QueryError("verified: expects yes or no")
        if name == "year":
            m = _YEAR.match(value)
            if not m or (m.group(3) and not (m.group(2) or m.group(4))):
                raise QueryError("year: expects 2021, 2020..2024, 2020.. or ..2019")
    return query


def _like(value: str) -> str:
    return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _clause(negated: bool, name: str, value: str, args: list[Any]) -> str:
    v = value.strip()
    low = v.lower()
    if name == "tag":
        sql = "EXISTS(SELECT 1 FROM paper_tags t WHERE t.paper_id=p.id AND t.tag=?)"
        args.append(low)
    elif name == "collection":
        sql = ("EXISTS(SELECT 1 FROM collection_papers cp JOIN collections c ON c.id=cp.collection_id "
               "WHERE cp.paper_id=p.id AND (c.slug=? OR c.parent_id IN (SELECT id FROM collections WHERE slug=?)))")
        args.extend([low, low])
    elif name == "project":
        sql = ("(p.project_id=? OR EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?))")
        args.extend([v, v])
    elif name == "year":
        m = _YEAR.match(v)
        if m.group(1):
            sql = "p.year=?"
            args.append(int(m.group(1)))
        else:
            conds = []
            if m.group(2):
                conds.append("p.year>=?")
                args.append(int(m.group(2)))
            if m.group(4):
                conds.append("p.year<=?")
                args.append(int(m.group(4)))
            sql = "(" + " AND ".join(conds) + ")"
    elif name == "author":
        sql = "p.authors_json LIKE ? ESCAPE '\\'"
        args.append(_like(v))
    elif name == "venue":
        sql = "p.venue LIKE ? ESCAPE '\\'"
        args.append(_like(v))
    elif name == "title":
        sql = "p.title LIKE ? ESCAPE '\\'"
        args.append(_like(v))
    elif name == "key":
        sql = ("(k.key LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM bib_key_aliases a WHERE a.paper_id=p.id AND a.key LIKE ? ESCAPE '\\'))")
        prefix = v.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        args.extend([prefix, prefix])
    elif name == "doi":
        sql = "p.doi=?"
        args.append(low)
    elif name == "arxiv":
        sql = "p.arxiv_id=?"
        args.append(low)
    elif name == "has":
        sql = {
            "pdf": "(p.pdf_path IS NOT NULL AND p.pdf_path != '')",
            "fulltext": "p.current_doc_id IS NOT NULL",
            "doi": "(p.doi IS NOT NULL AND p.doi != '')",
            "abstract": "(p.abstract IS NOT NULL AND p.abstract != '')",
            "notes": ("EXISTS(SELECT 1 FROM observations o WHERE o.paper_id=p.id AND o.tier='note' "
                      "AND o.superseded_by IS NULL)"),
            "key": "k.key IS NOT NULL",
            "tags": "EXISTS(SELECT 1 FROM paper_tags t WHERE t.paper_id=p.id)",
        }[low]
    elif name == "verified":
        sql = "p.verified=1" if low in {"yes", "true", "1"} else "p.verified=0"
    elif name == "integrity":
        if low == "unchecked":
            sql = "NOT EXISTS(SELECT 1 FROM integrity i WHERE i.paper_id=p.id)"
        else:
            sql = "EXISTS(SELECT 1 FROM integrity i WHERE i.paper_id=p.id AND i.status=?)"
            args.append(low)
    else:  # pragma: no cover - guarded by parse_query
        raise QueryError(f"unknown filter field {name!r}")
    return f"NOT ({sql})" if negated else sql


def _where(query: Query) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    args: list[Any] = []
    for negated, name, value in query.filters:
        clauses.append(_clause(negated, name, value, args))
    for term in query.terms:
        like = _like(term)
        clauses.append(
            "(p.title LIKE ? ESCAPE '\\' OR p.abstract LIKE ? ESCAPE '\\' OR p.authors_json LIKE ? ESCAPE '\\' "
            "OR p.venue LIKE ? ESCAPE '\\' OR p.doi LIKE ? ESCAPE '\\' OR k.key LIKE ? ESCAPE '\\' "
            "OR EXISTS(SELECT 1 FROM paper_tags t WHERE t.paper_id=p.id AND t.tag LIKE ? ESCAPE '\\') "
            "OR EXISTS(SELECT 1 FROM observations o WHERE o.paper_id=p.id AND o.tier='note' "
            "AND o.superseded_by IS NULL AND o.content LIKE ? ESCAPE '\\'))"
        )
        args.extend([like] * 8)
    return (" AND ".join(clauses) if clauses else "1=1"), args


def _encode_cursor(sort: str, desc: bool, value: Any, rowid: int) -> str:
    return base64.urlsafe_b64encode(json.dumps([sort, desc, value, rowid]).encode()).decode()


def _decode_cursor(cursor: str, sort: str, desc: bool) -> tuple[Any, int]:
    try:
        got_sort, got_desc, value, rowid = json.loads(base64.urlsafe_b64decode(cursor.encode()))
    except Exception as exc:
        raise QueryError("invalid cursor") from exc
    if got_sort != sort or bool(got_desc) != desc:
        raise QueryError("cursor was made for a different sort order")
    return value, int(rowid)


def _decorate(store: Store, rows: list[Any]) -> list[dict[str, Any]]:
    ids = [r["id"] for r in rows]
    tags: dict[str, list[str]] = {}
    colls: dict[str, list[str]] = {}
    notes: dict[str, int] = {}
    integ: dict[str, str] = {}
    for start in range(0, len(ids), 400):
        chunk = ids[start:start + 400]
        marks = ",".join("?" for _ in chunk)
        for r in store.conn.execute(f"SELECT paper_id, tag FROM paper_tags WHERE paper_id IN ({marks}) ORDER BY tag", chunk):
            tags.setdefault(r["paper_id"], []).append(r["tag"])
        for r in store.conn.execute(
            f"""SELECT cp.paper_id, c.slug FROM collection_papers cp JOIN collections c ON c.id=cp.collection_id
                WHERE cp.paper_id IN ({marks}) ORDER BY c.slug""", chunk):
            colls.setdefault(r["paper_id"], []).append(r["slug"])
        for r in store.conn.execute(
            f"""SELECT paper_id, COUNT(*) n FROM observations WHERE paper_id IN ({marks}) AND tier='note'
                AND superseded_by IS NULL GROUP BY paper_id""", chunk):
            notes[r["paper_id"]] = r["n"]
        for r in store.conn.execute(f"SELECT paper_id, status FROM integrity WHERE paper_id IN ({marks})", chunk):
            integ[r["paper_id"]] = r["status"]
    out = []
    for r in rows:
        out.append({
            "paper_id": r["id"], "key": r["lib_key"], "title": r["title"],
            "authors": loads(r["authors_json"], []), "year": r["year"], "venue": r["venue"], "doi": r["doi"],
            "arxiv_id": r["arxiv_id"], "verified": bool(r["verified"]), "cite_state": r["cite_state"],
            "has_pdf": bool(r["pdf_path"]), "tags": tags.get(r["id"], []), "collections": colls.get(r["id"], []),
            "notes": notes.get(r["id"], 0), "integrity": integ.get(r["id"]),
        })
    return out


def list_papers(
    store: Store, query: str | list[str] | Query | None = None, *, sort: str = "added", desc: bool = False,
    limit: int = 50, cursor: str | None = None,
) -> dict[str, Any]:
    q = query if isinstance(query, Query) else parse_query(query)
    if sort not in SORTS:
        raise QueryError(f"sort must be one of {', '.join(SORTS)}")
    limit = max(1, min(int(limit), MAX_PAGE))
    expr = SORTS[sort][0]
    where, args = _where(q)
    base = "FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id"
    total = store.conn.execute(f"SELECT COUNT(*) {base} WHERE {where}", args).fetchone()[0]
    page_where, page_args = where, list(args)
    if cursor:
        value, rowid = _decode_cursor(cursor, sort, desc)
        op = "<" if desc else ">"
        page_where += f" AND ({expr}, p.rowid) {op} (?, ?)"
        page_args += [value, rowid]
    direction = "DESC" if desc else "ASC"
    rows = store.conn.execute(
        f"SELECT p.rowid AS rid, {expr} AS sortval, k.key AS lib_key, p.* {base} WHERE {page_where} "
        f"ORDER BY {expr} {direction}, p.rowid {direction} LIMIT ?",
        page_args + [limit + 1],
    ).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = _encode_cursor(sort, desc, rows[-1]["sortval"], rows[-1]["rid"]) if more and rows else None
    return {"rows": _decorate(store, rows), "total_count": total, "next_cursor": next_cursor, "sort": sort}


def tag_counts(store: Store, query: str | list[str] | Query | None = None) -> list[dict[str, Any]]:
    q = query if isinstance(query, Query) else parse_query(query)
    where, args = _where(q)
    rows = store.conn.execute(
        f"""SELECT t.tag, COUNT(*) AS papers FROM paper_tags t JOIN papers p ON p.id=t.paper_id
            LEFT JOIN bib_keys k ON k.paper_id=p.id WHERE {where} GROUP BY t.tag ORDER BY papers DESC, t.tag""",
        args,
    ).fetchall()
    return [{"tag": r["tag"], "papers": r["papers"]} for r in rows]


def matching_ids(store: Store, query: str | list[str] | Query | None = None) -> list[str]:
    """Every paper id matching ``query``, in the order they were added."""
    q = query if isinstance(query, Query) else parse_query(query)
    where, args = _where(q)
    rows = store.conn.execute(
        f"SELECT p.id FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id WHERE {where} ORDER BY p.rowid", args
    ).fetchall()
    return [r["id"] for r in rows]


def rows_for_ids(store: Store, ids: list[str]) -> list[dict[str, Any]]:
    """The listing rows (tags, collections, notes, ...) for specific papers."""
    out: list[dict[str, Any]] = []
    for start in range(0, len(ids), 400):
        chunk = ids[start:start + 400]
        marks = ",".join("?" for _ in chunk)
        rows = store.conn.execute(
            f"SELECT k.key AS lib_key, p.* FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id WHERE p.id IN ({marks})",
            chunk,
        ).fetchall()
        out.extend(_decorate(store, rows))
    return out
