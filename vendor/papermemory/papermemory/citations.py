from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from papermemory.db import Store
from papermemory.util import new_id, now_iso, strip_tex_comments

CITE_RE = re.compile(r"\\cite[tpa]?[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}")


def extract_cite_keys(tex: str) -> list[str]:
    keys: list[str] = []
    for match in CITE_RE.finditer(strip_tex_comments(tex)):
        for key in match.group(1).split(","):
            key = key.strip()
            if key:
                keys.append(key)
    return keys


def scan_tex_tree(root: Path) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*.tex")):
        if any(part.startswith(".") for part in path.parts):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for line_number, line in enumerate(text.splitlines(), 1):
            for key in extract_cite_keys(line):
                found.append({"file": str(path), "line": line_number, "key": key})
    return found


def _scoped_papers(store: Store, slug: str) -> dict[str, dict[str, Any]]:
    rows = store.conn.execute(
        """SELECT p.* FROM papers p
           WHERE p.bibtex_key IS NOT NULL AND (
             p.project_id=:slug OR EXISTS(
               SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=:slug))
        """,
        {"slug": slug},
    ).fetchall()
    scoped = {row["bibtex_key"]: dict(row) for row in rows}
    # The keys this project's own .bib used, even when the library stores the
    # paper under another key (two projects may reuse one key for two papers).
    aliases = store.conn.execute(
        """SELECT a.key AS alias, p.* FROM bib_key_aliases a JOIN papers p ON p.id=a.paper_id
           WHERE a.project_key=:slug""",
        {"slug": slug},
    ).fetchall()
    for row in aliases:
        record = dict(row)
        alias = record.pop("alias")
        scoped[alias] = record
    # Keys retired by `library keys rekey` still name their paper, for papers
    # that belong to this project. A current key always beats a retired one.
    retired = store.conn.execute(
        """SELECT a.key AS alias, p.* FROM bib_key_aliases a JOIN papers p ON p.id=a.paper_id
           WHERE a.project_key='' AND a.source='rekey' AND (
             p.project_id=:slug OR EXISTS(
               SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=:slug))""",
        {"slug": slug},
    ).fetchall()
    for row in retired:
        record = dict(row)
        alias = record.pop("alias")
        scoped.setdefault(alias, record)
    return scoped


def cite_check(store: Store, manuscript_slug: str) -> dict[str, Any]:
    ms = store.get_manuscript(manuscript_slug)
    if not ms:
        raise LookupError(f"manuscript not found: {manuscript_slug}")
    root = Path(ms["root_path"]) if ms.get("root_path") else None
    scanned: list[dict[str, Any]] = []
    if root and root.exists():
        scanned = scan_tex_tree(root)
    unique_keys = sorted({entry["key"] for entry in scanned})
    papers = _scoped_papers(store, ms["slug"])
    missing_from_memory = [key for key in unique_keys if key not in papers]
    unverified = [
        {"key": key, "title": papers[key]["title"], "verified": 0}
        for key in unique_keys
        if key in papers and not papers[key]["verified"]
    ]
    now = now_iso()
    for entry in scanned:
        paper = papers.get(entry["key"])
        store.conn.execute(
            """INSERT INTO citations(id, manuscript_id, bibtex_key, paper_id, tex_file, tex_line,
               sentence_hash, scanned_at) VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(manuscript_id, tex_file, tex_line, bibtex_key) DO UPDATE SET
                 paper_id=excluded.paper_id, sentence_hash=excluded.sentence_hash,
                 scanned_at=excluded.scanned_at""",
            (
                new_id("cit"), ms["id"], entry["key"], paper["id"] if paper else None,
                entry["file"], entry["line"], "", now,
            ),
        )
    claim_gaps = []
    for key in unique_keys:
        paper = papers.get(key)
        if not paper:
            continue
        grounded = store.conn.execute(
            "SELECT COUNT(*) FROM claims WHERE paper_id=? AND is_latest=1 AND status IN ('extracted','verified')",
            (paper["id"],),
        ).fetchone()[0]
        if grounded == 0:
            claim_gaps.append({"key": key, "missing": "no-extracted-or-verified-claims"})
    cited = set(unique_keys)
    unused = sorted(
        key for key, paper in papers.items()
        if key not in cited and (paper.get("project_id") == ms["slug"])
    )
    store.mut("CITE_CHECK", project_key=ms["slug"], status="ok", detail=f"keys:{len(unique_keys)}")
    store.conn.commit()
    return {
        "manuscript": ms["slug"],
        "cited_keys": unique_keys,
        "cite_count": len(scanned),
        "files": sorted({entry["file"] for entry in scanned}),
        "missing_from_memory": missing_from_memory,
        "unverified_cited": unverified,
        "in_memory_uncited": unused,
        "claim_gaps": claim_gaps,
        "locators_persisted": len(scanned),
    }


def lookup_cite(store: Store, query: str, limit: int = 8, project_id: str | None = None) -> list[dict[str, Any]]:
    from papermemory.search import search

    hits = search(store, query, kind="paper", limit=limit, project_id=project_id)
    seen = {hit["id"] for hit in hits}
    for kind in ("chunk", "claim"):
        for hit in search(store, query, kind=kind, limit=limit * 2, project_id=project_id):
            paper_id = hit.get("paper_id")
            if paper_id and paper_id not in seen:
                record = store.get_paper(paper_id)
                if record:
                    record["authors"] = record.get("authors") or []
                    record["score"] = hit.get("score", 0)
                    hits.append(record)
                    seen.add(paper_id)
            if len(hits) >= limit * 2:
                break
    out = []
    for hit in hits:
        authors = hit.get("authors") or []
        year = hit.get("year")
        key = hit.get("bibtex_key")
        cite = None
        if authors and year:
            last = authors[0].split()[-1]
            cite = f"{last} et al., {year}" if len(authors) > 2 else f"{last}, {year}"
        out.append(
            {
                "id": hit["id"],
                "bibtex_key": key,
                "title": hit.get("title"),
                "authors": authors,
                "year": year,
                "venue": hit.get("venue"),
                "doi": hit.get("doi"),
                "arxiv_id": hit.get("arxiv_id"),
                "verified": bool(hit.get("verified")),
                "suggested_cite": cite,
                "score": hit.get("score"),
            }
        )
    return out
