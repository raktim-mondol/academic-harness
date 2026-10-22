from __future__ import annotations

import json
from typing import Any

from papermemory.chunker import chunk_document
from papermemory.markdown_contract import Refusal, parse_frontmatter
from papermemory.schema_v2 import PIPELINE_VERSION
from papermemory.section_roles import classify_sections
from papermemory.structure import build_section_tree
from papermemory.util import dumps, new_id, now_iso


def _rederive_document(store, doc) -> int:
    for row in store.conn.execute(
        "SELECT seq, index_text FROM chunks WHERE doc_id=?", (doc["id"],)
    ).fetchall():
        store.unindex_chunk(row["seq"], row["index_text"])
    store.conn.execute("DELETE FROM chunks WHERE doc_id=?", (doc["id"],))
    store.conn.execute("DELETE FROM sections WHERE doc_id=?", (doc["id"],))
    store.conn.execute("DELETE FROM coverage WHERE doc_id=?", (doc["id"],))
    store.conn.execute("DELETE FROM extractions WHERE doc_id=?", (doc["id"],))
    text = doc["text"]
    try:
        _fm, body = parse_frontmatter(text)
        base_offset = len(text) - len(body)
        base_line = text[:base_offset].count("\n")
    except Refusal:
        body, base_offset, base_line = text, 0, 0
    sections = build_section_tree(body, base_offset=base_offset, base_line=base_line)
    classify_sections(text, sections)
    chunks, uncovered, dropped = chunk_document(text, sections)
    if not chunks:
        raise RuntimeError(f"reindex-zero-text: {doc['id']}")
    now = now_iso()
    section_ids: list[str] = []
    for section in sections:
        section_id = new_id("sec")
        section_ids.append(section_id)
        store.conn.execute(
            """INSERT INTO sections(id, doc_id, parent_id, level, heading_path, char_start, char_end,
               line_start, line_end, is_bibliography, is_abstract, kind, role, role_confidence,
               role_source, role_secondary, ord, pipeline_version)
               VALUES (?,?,NULL,?,?,?,?,?,?,?,?,'prose',?,?,?,?,?,?)""",
            (
                section_id, doc["id"], section["level"], section["heading_path"],
                section["char_start"], section["char_end"], section["line_start"], section["line_end"],
                section["is_bibliography"], section["is_abstract"], section["role"],
                section["role_confidence"], section["role_source"], section["role_secondary"],
                section["ord"], PIPELINE_VERSION,
            ),
        )
    indexed_chars = 0
    for index, chunk in enumerate(chunks):
        cur = store.conn.execute(
            """INSERT INTO chunks(id, doc_id, paper_id, section_id, byte_start, byte_end,
               char_start, char_end, slice_sha256, source_sha256, index_text, table_id,
               row_start, row_end, header_span_json, is_bibliography, claimable, chunk_index,
               origin_channel, extraction_event_id, pipeline_version)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)""",
            (
                new_id("chk"), doc["id"], doc["paper_id"], section_ids[chunk["section_ord"]],
                chunk["byte_start"], chunk["byte_end"], chunk["char_start"], chunk["char_end"],
                chunk["slice_sha256"], doc["sha256"], chunk["index_text"], chunk.get("table_id"),
                chunk.get("row_start"), chunk.get("row_end"), chunk.get("header_span_json"),
                chunk["is_bibliography"], chunk["claimable"], index, doc["origin_channel"],
                PIPELINE_VERSION,
            ),
        )
        store.index_chunk(cur.lastrowid, chunk["index_text"])
        indexed_chars += chunk["char_end"] - chunk["char_start"]
    store.conn.execute(
        """INSERT INTO extractions(id, doc_id, paper_id, pipeline_version, status, reason_code,
           started_at, finished_at, stats_json) VALUES (?,?,?,?,'done','',?,?,?)""",
        (
            new_id("ext"), doc["id"], doc["paper_id"], PIPELINE_VERSION, now, now,
            dumps({"chunks": len(chunks), "sections": len(sections), "reindex": True}),
        ),
    )
    store.conn.execute(
        """INSERT INTO coverage(doc_id, source_chars, indexed_chars, uncovered_json, chunk_count,
           section_count, dropped_sections_json, capped, truncation_reason, ratio, checked_at)
           VALUES (?,?,?,?,?,?,?,0,'',?,?)""",
        (
            doc["id"], len(text), indexed_chars,
            json.dumps([[start, end] for start, end in uncovered]),
            len(chunks), len(sections), json.dumps({"chars": dropped}),
            indexed_chars / max(len(text), 1), now,
        ),
    )
    store.conn.execute(
        "UPDATE papers SET current_doc_id=COALESCE(current_doc_id, ?), cite_state='citable', updated_at=? WHERE id=?",
        (doc["id"], now, doc["paper_id"]),
    )
    store.mut(
        "DERIVE", paper_id=doc["paper_id"], doc_id=doc["id"], status="ok",
        detail=f"reindex-chunks:{len(chunks)}",
    )
    return len(chunks)


def reindex_from_raw(store, *, paper_id: str | None = None) -> dict[str, Any]:
    sql = "SELECT * FROM raw_documents WHERE pipeline_version LIKE 'pmv2%' AND is_current=1"
    args: list[Any] = []
    if paper_id:
        sql += " AND paper_id=?"
        args.append(paper_id)
    sql += " ORDER BY created_at, id"
    docs = store.conn.execute(sql, args).fetchall()
    total = len(docs)
    sweep = store.conn.execute(
        "SELECT * FROM sweeps WHERE kind='reindex' AND state='running' ORDER BY started_at DESC LIMIT 1"
    ).fetchone()
    if sweep:
        sweep_id = sweep["id"]
        cursor = int(sweep["cursor"])
    else:
        sweep_id = new_id("swp")
        cursor = 0
        store.conn.execute(
            "INSERT INTO sweeps(id, kind, cursor, total, state, started_at, updated_at) VALUES (?, 'reindex', 0, ?, 'running', ?, ?)",
            (sweep_id, total, now_iso(), now_iso()),
        )
        store.conn.commit()
    chunk_total = 0
    completed = 0
    for position in range(cursor, total):
        chunk_total += _rederive_document(store, docs[position])
        completed += 1
        store.conn.execute(
            "UPDATE sweeps SET cursor=?, total=?, updated_at=? WHERE id=?",
            (position + 1, total, now_iso(), sweep_id),
        )
        store.conn.commit()
    store.conn.execute(
        "UPDATE sweeps SET state='done', total=?, updated_at=? WHERE id=?",
        (total, now_iso(), sweep_id),
    )
    store.conn.commit()
    return {
        "documents": completed,
        "total": total,
        "resumed_from": cursor,
        "chunks": chunk_total,
        "sweep_id": sweep_id,
    }
