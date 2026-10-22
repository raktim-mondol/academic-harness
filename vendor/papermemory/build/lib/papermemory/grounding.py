from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from papermemory.util import new_id, now_iso


def _sha_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve_doc(store, *, paper_id=None, chunk_id=None, doc_id=None):
    if doc_id:
        return store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (doc_id,)).fetchone()
    if chunk_id:
        row = store.conn.execute(
            "SELECT doc_id FROM chunks WHERE id=?", (chunk_id,)
        ).fetchone()
        if not row:
            return None
        return store.conn.execute(
            "SELECT * FROM raw_documents WHERE id=?", (row["doc_id"],)
        ).fetchone()
    if paper_id:
        return store.conn.execute(
            """SELECT r.* FROM raw_documents r JOIN papers p ON p.current_doc_id=r.id
               WHERE p.id=?""",
            (paper_id,),
        ).fetchone()
    return None


def quote_check(
    store,
    quote: str,
    *,
    paper_id: str | None = None,
    chunk_id: str | None = None,
    doc_id: str | None = None,
    max_matches: int = 20,
) -> dict[str, Any]:
    doc = resolve_doc(store, paper_id=paper_id, chunk_id=chunk_id, doc_id=doc_id)
    if doc is None or not quote:
        return {
            "found": False,
            "occurrences": [],
            "reason": "no-match",
            "checked_against": {"sha256": None, "doc_id": None},
        }
    text = doc["text"]
    occurrences: list[dict[str, Any]] = []
    start = 0
    while len(occurrences) < max_matches:
        index = text.find(quote, start)
        if index < 0:
            break
        end = index + len(quote)
        chunk = store.conn.execute(
            """SELECT c.id, c.char_start, c.char_end, c.is_bibliography, s.heading_path
               FROM chunks c LEFT JOIN sections s ON s.id=c.section_id
               WHERE c.doc_id=? AND c.char_start<=? AND c.char_end>=?
               ORDER BY c.chunk_index LIMIT 1""",
            (doc["id"], index, end),
        ).fetchone()
        if chunk is None:
            chunk = store.conn.execute(
                """SELECT c.id, c.char_start, c.char_end, c.is_bibliography, s.heading_path
                   FROM chunks c LEFT JOIN sections s ON s.id=c.section_id
                   WHERE c.doc_id=? AND c.char_start < ? AND c.char_end > ?
                   ORDER BY c.chunk_index LIMIT 1""",
                (doc["id"], end, index),
            ).fetchone()
        occurrences.append(
            {
                "chunk_id": chunk["id"] if chunk else None,
                "char_span": [index, end],
                "byte_span": [
                    len(text[:index].encode("utf-8")),
                    len(text[:end].encode("utf-8")),
                ],
                "heading_path": chunk["heading_path"] if chunk else None,
                "is_bibliography": int(chunk["is_bibliography"]) if chunk else 0,
                "snippet": " ".join(text[max(0, index - 80):end + 80].split())[:300],
            }
        )
        start = index + max(1, len(quote))
    if not occurrences:
        reason = "no-match"
    elif all(item["is_bibliography"] for item in occurrences):
        reason = "bibliography-only"
    else:
        reason = ""
    return {
        "found": bool(occurrences),
        "occurrences": occurrences,
        "reason": reason,
        "checked_against": {"sha256": doc["sha256"], "doc_id": doc["id"]},
    }


def verify_claim(store, claim_id: str) -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []

    def step(name: str, ok: bool, reason: str = "", advisory: bool = False, **extra) -> None:
        record = {"step": name, "ok": ok, **({"reason": reason} if reason else {}), **extra}
        steps.append(record)
        if not ok and not advisory:
            failures.append({"step": name, "reason": reason or name})

    claim = store.conn.execute("SELECT * FROM claims WHERE id=?", (claim_id,)).fetchone()
    step("claim-exists", claim is not None, "missing-claim")
    if claim is None:
        return {"ok": False, "status": None, "steps": steps, "failures": failures}
    step("latest", int(claim["is_latest"]) == 1, "superseded")
    sources = store.conn.execute(
        """SELECT c.id, c.doc_id, c.char_start, c.char_end, c.slice_sha256, c.section_id,
                  c.paper_id, s.heading_path, s.is_bibliography
           FROM claim_sources cs JOIN chunks c ON c.id=cs.chunk_id
           LEFT JOIN sections s ON s.id=c.section_id
           WHERE cs.claim_id=? ORDER BY cs.ord""",
        (claim_id,),
    ).fetchall()
    step("sources", bool(sources), "orphan-backlink")
    doc = (
        store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (claim["doc_id"],)).fetchone()
        if claim["doc_id"]
        else None
    )
    step("doc", doc is not None, "doc-mismatch")
    if doc is None:
        return {"ok": False, "status": claim["status"], "steps": steps, "failures": failures}
    raw = doc["text"]
    chunk_doc_ok = all(source["doc_id"] == doc["id"] for source in sources)
    step("chunk-doc", chunk_doc_ok, "doc-mismatch")
    slice_ok = True
    for source in sources:
        raw_slice = raw[source["char_start"]:source["char_end"]]
        if _sha_text(raw_slice) != source["slice_sha256"]:
            slice_ok = False
    step("slice-hash", slice_ok, "slice-hash-drift")
    qcs, qce = int(claim["quote_char_start"]), int(claim["quote_char_end"])
    inside = any(source["char_start"] <= qcs and qce <= source["char_end"] for source in sources)
    step("quote-in-span", inside, "quote-out-of-span")
    materialized = raw[qcs:qce]
    quote_ok = qcs < qce and _sha_text(materialized) == claim["quote_sha256"]
    step("quote-verbatim", quote_ok, "quote-not-verbatim")
    paper = store.conn.execute("SELECT current_doc_id FROM papers WHERE id=?", (claim["paper_id"],)).fetchone()
    step("current-doc", paper is not None and paper["current_doc_id"] == doc["id"], "doc-superseded")
    section = (
        store.conn.execute("SELECT * FROM sections WHERE id=?", (claim["primary_section_id"],)).fetchone()
        if claim["primary_section_id"]
        else None
    )
    step("section", section is not None, "missing-section")
    step("not-bibliography", section is not None and not section["is_bibliography"], "bibliography-evidence")
    path = Path(doc["corpus_path"])
    try:
        root = (store.path.parent / "corpus").resolve()
        resolved = path.resolve()
        contained = str(resolved).startswith(str(root))
    except OSError:
        contained = False
    file_ok = contained and path.exists() and _sha_file(path) == doc["sha256"]
    step("raw-file", file_ok, "raw-file-drift")
    channel = doc["origin_channel"]
    if channel == "ocr-recovered":
        step("channel-cap", False, "channel-capped:ocr-recovered", advisory=True)
    verdict = store.conn.execute(
        "SELECT raw_sha256 FROM ah_verdicts WHERE claim_id=? ORDER BY recorded_at DESC LIMIT 1",
        (claim_id,),
    ).fetchone()
    if verdict is None:
        step("ah-verdict", True, "no-ah-verdict", advisory=True)
    else:
        step("ah-verdict", verdict["raw_sha256"] == doc["sha256"], "stale-verdict-sha")

    status = claim["status"]
    if (
        not failures
        and channel != "ocr-recovered"
        and claim["status_reason"] != "asserted-quote-differs"
        and status in {"unverified-quote", "extracted"}
    ):
        now = now_iso()
        store.conn.execute(
            "UPDATE claims SET status='verified', status_reason='', updated_at=? WHERE id=?",
            (now, claim_id),
        )
        store.conn.execute(
            "INSERT INTO claims_history(id, claim_id, event, old_status, new_status, actor, reason, at) VALUES (?,?,'status_change',?,?,?,?,?)",
            (new_id("csh"), claim_id, status, "verified", "verify", "byte re-slice passed", now),
        )
        store.mut("CLAIM_TRANSITION", claim_id=claim_id, paper_id=claim["paper_id"], status="verified")
        store.conn.commit()
        status = "verified"
    return {"ok": not failures, "status": status, "steps": steps, "failures": failures}
