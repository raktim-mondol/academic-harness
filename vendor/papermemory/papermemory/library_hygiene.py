"""Library hygiene: duplicate candidates, a field-level merge preview, and ``doctor``.

Everything here reports evidence. Nothing merges, deletes, or "fixes" a record
by itself, and a check that could not run is reported as unknown, never clean.
"""
from __future__ import annotations

import difflib
import json
import re
from typing import Any

from papermemory import library_keys
from papermemory.db import IdentityConflict, Store, TITLE_PRECEDENCE
from papermemory.library import resolve_paper_id
from papermemory.util import loads, normalize_title, now_iso

MAX_GROUPS = 200
SAMPLE = 50
FLAGGED_INTEGRITY = {"retracted", "withdrawn", "corrected", "concern", "expression-of-concern"}
MERGE_COLUMNS = ("title", "authors_json", "year", "venue", "doi", "arxiv_id", "abstract", "pdf_path")


class HygieneError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---------- duplicates ----------


def _family(authors_json: str | None) -> str:
    authors = loads(authors_json, [])
    if not authors:
        return ""
    return re.sub(r"[^a-z]", "", authors[0].split()[-1].lower()) if authors[0].split() else ""


_ORDINALS = {
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "first", "second", "third",
    "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "i", "ii", "iii", "iv", "v", "vi", "vii",
    "viii", "ix", "x", "a", "b", "c", "d", "part", "volume", "vol", "chapter", "paper", "study", "report",
    # a notice about a paper is a different record from the paper
    "addendum", "erratum", "errata", "corrigendum", "correction", "retraction", "reply", "response", "comment",
    "comments", "supplement", "supplementary", "rebuttal",
}


def _is_series_pair(wa: set[str], wb: set[str]) -> bool:
    """Titles that differ only by a number, part, or notice marker are different records, not duplicates."""
    diff = wa ^ wb
    return bool(diff) and all(word.isdigit() or word in _ORDINALS for word in diff)


def _signals(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any] | None:
    ta, tb = a["_title"], b["_title"]
    if not ta or not tb:
        return None
    wa, wb = set(ta.split()), set(tb.split())
    if not wa or not wb:
        return None
    jaccard = len(wa & wb) / len(wa | wb)
    if jaccard < 0.6:
        return None
    if _is_series_pair(wa, wb):
        return None
    ratio = 1.0 if ta == tb else difflib.SequenceMatcher(None, ta, tb).ratio()
    ya, yb = a["year"], b["year"]
    year_gap = abs(ya - yb) if ya and yb else None
    same_author = bool(a["_family"]) and a["_family"] == b["_family"]
    authors_unknown = not a["_family"] or not b["_family"]
    pre_pub = bool((a["arxiv_id"] and b["doi"] and not b["arxiv_id"]) or (b["arxiv_id"] and a["doi"] and not a["arxiv_id"]))
    reasons = []
    # Same year: identical authors, or no author information to contradict it. One year apart (online-first
    # versus print) needs a known matching first author, so annual items such as "News from X" do not chain.
    if ta == tb and (year_gap in (None, 0)) and (same_author or authors_unknown):
        reasons.append("same-title-year")
    elif ratio >= 0.92 and (
        (year_gap in (None, 0) and (same_author or authors_unknown)) or (year_gap == 1 and same_author)
    ):
        reasons.append("near-identical-title")
    if ratio >= 0.92 and (year_gap is None or year_gap <= 2) and same_author and pre_pub:
        reasons.append("preprint-vs-published")
    if not reasons:
        return None
    return {
        "reasons": reasons, "title_similarity": round(ratio, 3), "year_gap": year_gap,
        "same_first_author": same_author, "different_dois": bool(a["doi"] and b["doi"] and a["doi"] != b["doi"]),
    }


def find_duplicates(store: Store, *, limit: int = MAX_GROUPS) -> dict[str, Any]:
    """Groups of papers that may be the same work. Evidence only; nothing is merged."""
    rows = [dict(r) for r in store.conn.execute(
        """SELECT p.id, p.title, p.year, p.doi, p.arxiv_id, p.authors_json, p.pdf_path, p.current_doc_id, k.key
           FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id ORDER BY p.rowid""")]
    for r in rows:
        r["_title"] = normalize_title(r["title"] or "")
        r["_family"] = _family(r["authors_json"])
    blocks: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        words = r["_title"].split()
        if words:
            blocks.setdefault("t:" + " ".join(words[:4]), []).append(i)
            blocks.setdefault("t2:" + " ".join(sorted(words)[:4]), []).append(i)
        if r["_family"] and r["year"]:
            blocks.setdefault(f"a:{r['_family']}:{r['year']}", []).append(i)
    pairs: dict[tuple[int, int], dict[str, Any]] = {}
    for members in blocks.values():
        if len(members) < 2 or len(members) > 400:
            continue
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                i, j = members[x], members[y]
                if (i, j) in pairs:
                    continue
                sig = _signals(rows[i], rows[j])
                if sig:
                    pairs[(i, j)] = sig
    parent = list(range(len(rows)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, j in pairs:
        parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i, j in pairs:
        for n in (i, j):
            groups.setdefault(find(n), [])
            if n not in groups[find(n)]:
                groups[find(n)].append(n)
    out = []
    for members in groups.values():
        members.sort()
        evidence = [
            {"between": [rows[i]["key"] or rows[i]["id"], rows[j]["key"] or rows[j]["id"]], **sig}
            for (i, j), sig in pairs.items() if i in members and j in members
        ]
        out.append({
            "papers": [
                {"paper_id": rows[i]["id"], "key": rows[i]["key"], "title": rows[i]["title"], "year": rows[i]["year"],
                 "doi": rows[i]["doi"], "arxiv_id": rows[i]["arxiv_id"], "has_fulltext": bool(rows[i]["current_doc_id"])}
                for i in members
            ],
            "evidence": evidence[:10],
            "strongest": max((e["title_similarity"] for e in evidence), default=0),
        })
    # Three or more identical titles in different years (annual newsletters, yearly reports) are a
    # series, not duplicates of one work. Report them apart so they are not merged by mistake.
    series: list[dict[str, Any]] = []
    candidates = []
    for group in out:
        years = [p["year"] for p in group["papers"]]
        if len(group["papers"]) >= 3 and all(years) and len(set(years)) == len(years):
            series.append({"title": group["papers"][0]["title"], "years": sorted(years),
                           "keys": [p["key"] or p["paper_id"] for p in group["papers"]]})
        else:
            candidates.append(group)
    candidates.sort(key=lambda g: (-g["strongest"], -len(g["papers"]), g["papers"][0]["key"] or ""))
    return {"groups": candidates[:limit], "total_groups": len(candidates), "papers_considered": len(rows),
            "series_like": series[:SAMPLE], "series_like_count": len(series),
            "note": "candidates only; review each group and merge with `library merge`"}


# ---------- merge preview and apply ----------


def _paper(store: Store, ref: str, project_id: str | None) -> Any:
    paper_id = resolve_paper_id(store, ref, project_id=project_id)
    if paper_id is None:
        raise HygieneError("not-found", f"nothing found for {ref!r}")
    return store.conn.execute("SELECT p.*, k.key AS lib_key FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id WHERE p.id=?", (paper_id,)).fetchone()


def _blank(value: Any) -> bool:
    return value in (None, "", "[]", "{}")


def _meta(store: Store, paper_id: str) -> dict[str, Any]:
    row = store.conn.execute("SELECT * FROM reference_meta WHERE paper_id=?", (paper_id,)).fetchone()
    return {"csl": loads(row["csl_json"], {}), "extra": loads(row["extra_json"], {}), "entry_type": row["entry_type"],
            "raw": row["raw_bibtex"], "source": row["source"]} if row else {"csl": {}, "extra": {}, "entry_type": "misc", "raw": None, "source": None}


def merge_plan(store: Store, keep_ref: str, drop_ref: str, *, project_id: str | None = None, prefer: str = "keep") -> dict[str, Any]:
    """What merging ``drop`` into ``keep`` would do, field by field. Writes nothing."""
    if prefer not in ("keep", "drop"):
        raise HygieneError("bad-option", "prefer must be keep or drop")
    keep, drop = _paper(store, keep_ref, project_id), _paper(store, drop_ref, project_id)
    if keep["id"] == drop["id"]:
        raise HygieneError("same-paper", "both references name the same paper")
    fields = []
    for column in MERGE_COLUMNS:
        kv, dv = keep[column], drop[column]
        if _blank(kv) and _blank(dv):
            continue
        if kv == dv:
            status, winner = "same", "keep"
        elif _blank(dv):
            status, winner = "keep_only", "keep"
        elif _blank(kv):
            status, winner = "drop_only", "drop"
        else:
            status = "conflict"
            winner = prefer
            if column == "title":
                kp, dp = TITLE_PRECEDENCE.get(keep["title_source"], 0), TITLE_PRECEDENCE.get(drop["title_source"], 0)
                winner = "keep" if kp > dp else "drop" if dp > kp else prefer
        fields.append({"field": column, "keep": kv, "drop": dv, "status": status, "winner": winner})
    mk, md = _meta(store, keep["id"]), _meta(store, drop["id"])
    csl_fields = []
    for name in sorted(set(mk["csl"]) | set(md["csl"])):
        kv, dv = mk["csl"].get(name), md["csl"].get(name)
        if kv == dv or name in ("id", "citation-key"):
            continue
        status = "drop_only" if _blank(kv) else "keep_only" if _blank(dv) else "conflict"
        csl_fields.append({"field": name, "keep": kv, "drop": dv, "status": status,
                           "winner": "drop" if status == "drop_only" else "keep" if status == "keep_only" else prefer})
    counts = {name: store.conn.execute(sql, (drop["id"],)).fetchone()[0] for name, sql in {
        "claims": "SELECT COUNT(*) FROM claims WHERE paper_id=?", "documents": "SELECT COUNT(*) FROM raw_documents WHERE paper_id=?",
        "tags": "SELECT COUNT(*) FROM paper_tags WHERE paper_id=?", "collections": "SELECT COUNT(*) FROM collection_papers WHERE paper_id=?",
        "notes": "SELECT COUNT(*) FROM observations WHERE paper_id=? AND tier='note' AND superseded_by IS NULL"}.items()}
    return {
        "keep": {"paper_id": keep["id"], "key": keep["lib_key"], "title": keep["title"]},
        "drop": {"paper_id": drop["id"], "key": drop["lib_key"], "title": drop["title"]},
        "fields": fields, "reference_fields": csl_fields,
        "conflicts": [f["field"] for f in fields + csl_fields if f["status"] == "conflict"],
        "moves": counts, "drop_key_becomes_alias": drop["lib_key"],
        "applied": False, "prefer": prefer,
    }


def merge_apply(
    store: Store, keep_ref: str, drop_ref: str, *, reason: str, prefer: str = "keep", project_id: str | None = None,
) -> dict[str, Any]:
    if not (reason or "").strip():
        raise HygieneError("reason-required", "merge needs a reason")
    plan = merge_plan(store, keep_ref, drop_ref, project_id=project_id, prefer=prefer)
    keep_id, drop_id = plan["keep"]["paper_id"], plan["drop"]["paper_id"]
    meta_keep, meta_drop = _meta(store, keep_id), _meta(store, drop_id)
    store.conn.commit()
    store.merge_papers(drop_id, keep_id)  # moves documents, claims, keys, aliases, tags, collections, notes
    conn = store.conn
    updates: dict[str, Any] = {}
    for item in plan["fields"]:
        if item["winner"] == "drop" and item["status"] in ("drop_only", "conflict"):
            updates[item["field"]] = item["drop"]
    warnings: list[str] = []
    for column in ("doi", "arxiv_id"):
        if column in updates:
            value = updates.pop(column)
            try:
                kind = "doi" if column == "doi" else "arxiv_id"
                row = conn.execute("SELECT identity_kind FROM papers WHERE id=?", (keep_id,)).fetchone()
                if row["identity_kind"] in ("title_year", "legacy_id"):
                    store.promote_identity(keep_id, kind, value)
            except IdentityConflict as exc:
                warnings.append(f"{column} not copied: {exc}")
                continue
            conn.execute(f"UPDATE papers SET {column}=?, updated_at=? WHERE id=?", (value, now_iso(), keep_id))
    if updates:
        sets = ", ".join(f"{col}=?" for col in updates)
        conn.execute(f"UPDATE papers SET {sets}, updated_at=? WHERE id=?", (*updates.values(), now_iso(), keep_id))
    # reference record: fill gaps and apply the chosen side for conflicts
    csl, extra = dict(meta_keep["csl"]), dict(meta_keep["extra"])
    for item in plan["reference_fields"]:
        if item["winner"] == "drop":
            csl[item["field"]] = item["drop"]
    for name, value in meta_drop["extra"].items():
        extra.setdefault(name, value)
    if meta_keep["source"] is not None or meta_drop["source"] is not None:
        from papermemory.library_store import upsert_reference_meta

        base = meta_keep if meta_keep["source"] is not None else meta_drop
        upsert_reference_meta(conn, keep_id, csl, extra, base["entry_type"], raw_bibtex=base["raw"],
                              source=base["source"] or "merge", replace=True)
    store.mut("LIBRARY_WRITE", paper_id=keep_id, detail=json.dumps({"merged": drop_id, "reason": reason.strip()}))
    conn.commit()
    return {**plan, "applied": True, "reason": reason.strip(), "warnings": warnings}


# ---------- doctor ----------

_REQUIRED = {
    "article": ("author", "title", "container-title", "issued"),
    "inproceedings": ("author", "title", "container-title", "issued"),
    "conference": ("author", "title", "container-title", "issued"),
    "book": ("author|editor", "title", "publisher", "issued"),
    "incollection": ("author", "title", "container-title", "publisher", "issued"),
    "inbook": ("author|editor", "title", "container-title", "publisher", "issued"),
    "phdthesis": ("author", "title", "publisher", "issued"),
    "mastersthesis": ("author", "title", "publisher", "issued"),
    "thesis": ("author", "title", "publisher", "issued"),
    "techreport": ("author", "title", "publisher", "issued"),
    "report": ("author", "title", "publisher", "issued"),
    "unpublished": ("author", "title"),
    "proceedings": ("title", "issued"),
}


def _missing(entry_type: str, csl: dict[str, Any]) -> list[str]:
    missing = []
    for need in _REQUIRED.get(entry_type, ("title",)):
        if not any(csl.get(name) for name in need.split("|")):
            missing.append(need)
    return missing


def doctor(store: Store, *, template: str | None = None, cwd: str | None = None) -> dict[str, Any]:
    """Library health report: evidence, never a verdict. Unavailable checks are 'unknown'."""
    conn = store.conn
    problems: dict[str, list[dict[str, Any]]] = {}
    totals: dict[str, int] = {}

    def add(name: str, items: list[dict[str, Any]]) -> None:
        totals[name] = len(items)
        if items:
            problems[name] = items[:SAMPLE]

    rows = conn.execute(
        """SELECT p.id, p.verified, p.doi, k.key, m.entry_type, m.csl_json
           FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id LEFT JOIN reference_meta m ON m.paper_id=p.id ORDER BY p.rowid"""
    ).fetchall()
    missing_fields, unverified = [], []
    for r in rows:
        csl = loads(r["csl_json"], {})
        miss = _missing(r["entry_type"] or "misc", csl)
        if miss:
            missing_fields.append({"paper_id": r["id"], "key": r["key"], "type": r["entry_type"], "missing": miss})
        if r["doi"] and not r["verified"]:
            unverified.append({"paper_id": r["id"], "key": r["key"], "doi": r["doi"]})
    add("missing_required_fields", missing_fields)
    add("doi_not_verified", unverified)

    keys = library_keys.check(store, template=template)
    key_errors = sum(keys["summary"]["problems"][n] for n in ("missing_key", "unsafe_key", "papers_column_mismatch"))
    totals["key_problems"] = key_errors
    if key_errors:
        problems["key_problems"] = [{"see": "library keys check", **keys["summary"]["problems"]}]

    flagged = conn.execute(
        f"""SELECT i.paper_id, k.key, i.status, i.notice_doi, i.checked_at FROM integrity i
            LEFT JOIN bib_keys k ON k.paper_id=i.paper_id WHERE i.status IN ({','.join('?' for _ in FLAGGED_INTEGRITY)})""",
        sorted(FLAGGED_INTEGRITY)).fetchall()
    add("integrity_flagged", [dict(r) for r in flagged])
    cited = conn.execute(
        f"""SELECT DISTINCT m.slug AS manuscript, c.bibtex_key AS key, i.status FROM citations c
            JOIN manuscripts m ON m.id=c.manuscript_id JOIN integrity i ON i.paper_id=c.paper_id
            WHERE i.status IN ({','.join('?' for _ in FLAGGED_INTEGRITY)})""", sorted(FLAGGED_INTEGRITY)).fetchall()
    add("flagged_papers_still_cited", [dict(r) for r in cited])
    unchecked = conn.execute("SELECT COUNT(*) FROM papers p WHERE NOT EXISTS(SELECT 1 FROM integrity i WHERE i.paper_id=p.id)").fetchone()[0]

    dupes = find_duplicates(store, limit=MAX_GROUPS)
    totals["duplicate_groups"] = dupes["total_groups"]
    if dupes["groups"]:
        problems["duplicate_groups"] = [
            {"keys": [p["key"] or p["paper_id"] for p in g["papers"]], "strongest": g["strongest"]} for g in dupes["groups"][:SAMPLE]
        ]

    bound = []
    if cwd:
        from papermemory.library_export import ExportError, export_library

        for col in conn.execute("SELECT slug, project_key, bib_path FROM collections WHERE bib_path IS NOT NULL AND project_key IS NOT NULL"):
            try:
                res = export_library(store, collection=col["slug"], cwd=cwd, check=True)
                bound.append({"collection": col["slug"], "path": col["bib_path"], "status": res.get("status"),
                              **{k: v for k, v in (res.get("diff") or {}).items() if v}})
            except ExportError as exc:
                bound.append({"collection": col["slug"], "path": col["bib_path"], "status": exc.code, "message": str(exc)})
        out_of_sync = [b for b in bound if b["status"] not in ("in_sync",)]
        add("bound_bib_not_in_sync", out_of_sync)

    errors = key_errors + totals["integrity_flagged"] + totals["flagged_papers_still_cited"]
    warnings = totals["missing_required_fields"] + totals["doi_not_verified"] + totals["duplicate_groups"] + totals.get("bound_bib_not_in_sync", 0)
    summary = {
        "papers": len(rows), "errors": errors, "warnings": warnings, "ok": errors == 0,
        "problems": totals,
        "unknown": {"integrity_unchecked": unchecked,
                    "bound_bibs": "not checked (pass a workspace to check them)" if not cwd else "checked"},
    }
    return {"summary": summary, "problems": problems}


# ---------- integrity results written by the harness, and batch key resolution ----------

INTEGRITY_STATUSES = ("ok", "retracted", "withdrawn", "corrected", "concern", "expression-of-concern", "unknown")


def set_integrity(store: Store, items: list[dict[str, Any]], *, project_id: str | None = None) -> dict[str, Any]:
    """Record retraction / correction status found by an external check.

    ``status`` must be one of ``INTEGRITY_STATUSES``; ``unknown`` means the check could not run and is
    never treated as clean. Unresolvable references are reported, not guessed at.
    """
    written, unresolved, rejected = 0, [], []
    now = now_iso()
    for item in items:
        ref = str(item.get("ref") or "").strip()
        status = str(item.get("status") or "").strip().lower()
        if status not in INTEGRITY_STATUSES:
            rejected.append({"ref": ref, "reason": f"status must be one of {', '.join(INTEGRITY_STATUSES)}"})
            continue
        paper_id = resolve_paper_id(store, ref, project_id=project_id) if ref else None
        if paper_id is None:
            unresolved.append(ref)
            continue
        store.conn.execute(
            """INSERT INTO integrity(paper_id, status, source, notice_doi, checked_at) VALUES (?,?,?,?,?)
               ON CONFLICT(paper_id) DO UPDATE SET status=excluded.status, source=excluded.source,
               notice_doi=excluded.notice_doi, checked_at=excluded.checked_at""",
            (paper_id, status, (item.get("source") or None), (item.get("notice_doi") or None), now),
        )
        written += 1
    if written:
        store.mut("LIBRARY_WRITE", detail=f"integrity x{written}")
    store.conn.commit()
    return {"written": written, "unresolved": unresolved, "rejected": rejected}


def resolve_refs(
    store: Store, refs: list[str], *, project_id: str | None = None, include_project_keys: bool = False,
) -> dict[str, Any]:
    """Which of these keys / DOIs / ids are in the library? ``project_id`` makes a project's own keys win."""
    out = []
    for ref in refs:
        paper_id = resolve_paper_id(store, ref, project_id=project_id) if str(ref).strip() else None
        if paper_id is None:
            out.append({"ref": ref, "found": False})
            continue
        row = store.conn.execute(
            "SELECT p.title, p.year, p.doi, k.key FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id WHERE p.id=?",
            (paper_id,),
        ).fetchone()
        out.append({"ref": ref, "found": True, "paper_id": paper_id, "key": row["key"], "title": row["title"],
                    "year": row["year"], "doi": row["doi"]})
    result: dict[str, Any] = {"results": out, "found": sum(1 for r in out if r["found"]), "total": len(out)}
    if include_project_keys:
        if not project_id:
            raise HygieneError("project-required", "project keys need a project")
        keys = {}
        for r in store.conn.execute(
            """SELECT p.id, COALESCE((SELECT a.key FROM bib_key_aliases a WHERE a.paper_id=p.id AND a.project_key=?
                       AND a.source LIKE 'import:%' ORDER BY a.first_seen LIMIT 1), k.key) AS key
               FROM papers p LEFT JOIN bib_keys k ON k.paper_id=p.id
               WHERE p.project_id=? OR EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)""",
            (project_id, project_id, project_id),
        ):
            if r["key"]:
                keys[r["key"]] = r["id"]
        result["project_keys"] = sorted(keys)
    return result
