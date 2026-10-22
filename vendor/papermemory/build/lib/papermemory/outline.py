from __future__ import annotations

from pathlib import Path
from typing import Any

from papermemory.db import Store
from papermemory.section_roles import paper_profile, structure_confidence


def outline(store: Store, key: str) -> dict[str, Any]:
    paper = store.get_paper(key)
    if not paper:
        raise LookupError(f"paper not found: {key}")
    doc = None
    if paper.get("current_doc_id"):
        doc = store.conn.execute(
            "SELECT * FROM raw_documents WHERE id=?", (paper["current_doc_id"],)
        ).fetchone()
    if doc is None:
        doc = store.conn.execute(
            "SELECT * FROM raw_documents WHERE paper_id=? ORDER BY created_at DESC LIMIT 1",
            (paper["id"],),
        ).fetchone()
    if doc is None:
        return {
            "paper": {
                "id": paper["id"], "doi": paper.get("doi"), "title": paper["title"],
                "year": paper.get("year"), "source_filename": None, "corpus_path": None,
                "origin_channel": paper.get("origin_channel"), "cite_state": paper.get("cite_state"),
            },
            "doc": None,
            "structure": {
                "headings": 0, "structure_confidence": "low",
                "profile": "unknown", "profile_confidence": 0,
            },
            "sections": [],
            "coverage": None,
        }
    sections = [
        dict(row)
        for row in store.conn.execute(
            """SELECT s.*,
                      (SELECT COUNT(*) FROM chunks c WHERE c.section_id=s.id) AS chunk_count,
                      (SELECT COUNT(*) FROM claims cl WHERE cl.primary_section_id=s.id AND cl.is_latest=1) AS claim_count
               FROM sections s WHERE s.doc_id=? ORDER BY s.ord""",
            (doc["id"],),
        )
    ]
    profile = paper_profile(sections)
    coverage = store.conn.execute(
        "SELECT source_chars, indexed_chars, chunk_count, section_count, capped, ratio FROM coverage WHERE doc_id=?",
        (doc["id"],),
    ).fetchone()
    return {
        "paper": {
            "id": paper["id"],
            "doi": paper.get("doi"),
            "title": paper["title"],
            "year": paper.get("year"),
            "source_filename": Path(doc["origin_path"]).name,
            "corpus_path": doc["corpus_path"],
            "origin_channel": doc["origin_channel"],
            "cite_state": paper.get("cite_state"),
        },
        "doc": {
            "sha256": doc["sha256"],
            "sha16": doc["sha256"][:16],
            "pipeline_version": doc["pipeline_version"],
            "provenance_basis": doc["provenance_basis"],
        },
        "structure": {
            "headings": sum(1 for section in sections if section["heading_path"]),
            "structure_confidence": structure_confidence(sections),
            "profile": profile["profile"],
            "profile_confidence": profile["confidence"],
        },
        "sections": [
            {
                "id": section["id"],
                "ord": section["ord"],
                "level": section["level"],
                "heading_path": section["heading_path"],
                "role": section["role"],
                "role_secondary": section["role_secondary"],
                "role_source": section["role_source"],
                "role_confidence": section["role_confidence"],
                "char_span": [section["char_start"], section["char_end"]],
                "line_span": [section["line_start"], section["line_end"]],
                "is_bibliography": section["is_bibliography"],
                "is_abstract": section["is_abstract"],
                "chunk_count": section["chunk_count"],
                "claim_count": section["claim_count"],
                "claimable": 0 if section["is_bibliography"] else 1,
            }
            for section in sections
        ],
        "coverage": dict(coverage) if coverage else None,
    }
