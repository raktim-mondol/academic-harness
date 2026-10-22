from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from papermemory.chunker import chunk_document
from papermemory.markdown_contract import Identity, Refusal, parse_frontmatter, resolve_identity
from papermemory.schema_v2 import PIPELINE_VERSION
from papermemory.section_roles import classify_sections
from papermemory.structure import build_section_tree
from papermemory.util import dumps, new_id, normalize_doi, normalize_arxiv, now_iso


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def ingest_markdown(
    store,
    path: Path,
    *,
    project_id: str | None = None,
    identity_override: tuple[str, str] | None = None,
    origin_channel: str | None = None,
    converter: dict | None = None,
    pdf_path: str | None = None,
    title_hint: str | None = None,
) -> dict:
    path = Path(path)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return {"status": "failed", "reason_code": "read-error", "detail": str(exc), "paper_id": None}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"status": "failed", "reason_code": "decode-not-utf8", "paper_id": None}
    if "\r" in text:
        return {"status": "failed", "reason_code": "newline-not-lf", "paper_id": None}
    if not text.strip():
        return {"status": "failed", "reason_code": "zero-text", "paper_id": None}
    try:
        fm, body = parse_frontmatter(text)
        identity: Identity = (
            Identity(kind=identity_override[0], value=identity_override[1])
            if identity_override
            else resolve_identity(fm, body_text=body)
        )
    except Refusal as exc:
        return {"status": "failed", "reason_code": exc.code, "paper_id": None}

    title = (title_hint or identity.title or fm.get("title") or path.stem).strip() or path.stem
    title_source = identity.title_source or ("caller" if title_hint else "filename")
    channel = origin_channel or fm.get("origin_channel") or "author-supplied"
    signals = converter or {}
    if (signals.get("pdf_type") in {"scanned", "image-based", "scanned-only"}
            or signals.get("pages_needing_ocr")):
        channel = "ocr-recovered"
    fields = {
        "doi": normalize_doi(fm.get("doi")),
        "arxiv_id": normalize_arxiv(fm.get("arxiv_id")),
        "pmid": fm.get("pmid"),
        "authors_json": dumps(fm.get("authors") or []),
        "year": identity.year if identity.year is not None else fm.get("year"),
        "venue": fm.get("venue"),
        "bibtex_key": fm.get("bibtex_key"),
        "source_type": "markdown",
        "origin_channel": channel,
        "pdf_path": pdf_path,
    }
    paper_id, state = store.upsert_paper_v2(
        identity.kind,
        identity.value,
        title,
        title_source,
        fields=fields,
        project_key=project_id,
    )
    content_sha = _sha(raw)
    existing = store.conn.execute(
        "SELECT * FROM raw_documents WHERE paper_id=? AND sha256=? AND pipeline_version=?",
        (paper_id, content_sha, PIPELINE_VERSION),
    ).fetchone()
    if existing:
        store.mut("INGEST", paper_id=paper_id, doc_id=existing["id"], status="duplicate-noop", reason_code="duplicate-noop", detail=str(path))
        return {"status": "duplicate-noop", "paper_id": paper_id, "doc_id": existing["id"], "chunks_created": 0}

    body_offset = len(text) - len(body)
    sections = build_section_tree(
        body,
        base_offset=body_offset,
        base_line=text[:body_offset].count("\n"),
    )
    classify_sections(text, sections)
    chunks, uncovered, dropped = chunk_document(text, sections)
    if not chunks:
        return {"status": "failed", "reason_code": "zero-text", "paper_id": paper_id}

    doc_id = new_id("doc")
    corpus_dir = store.path.parent / "corpus" / paper_id
    corpus_path = corpus_dir / f"{content_sha[:16]}.md"
    _write_atomic(corpus_path, raw)
    _write_atomic(store.path.parent / "corpus" / f"{paper_id}.md", raw)

    now = now_iso()
    previous = store.conn.execute(
        "SELECT id FROM raw_documents WHERE paper_id=? AND is_current=1", (paper_id,)
    ).fetchone()
    store.conn.execute(
        "UPDATE raw_documents SET is_current=0 WHERE paper_id=? AND is_current=1", (paper_id,)
    )
    store.conn.execute("UPDATE papers SET current_doc_id=NULL WHERE id=?", (paper_id,))
    store.conn.execute(
        """INSERT INTO raw_documents(id, paper_id, sha256, bytes, chars, text, corpus_path,
           origin_path, origin_channel, converter_json, kind, provenance_basis, pipeline_version,
           is_current, supersedes_doc_id, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)""",
        (
            doc_id, paper_id, content_sha, len(raw), len(text), text, str(corpus_path),
            str(path.resolve()), channel, dumps(converter or {}), "paper", "verbatim",
            PIPELINE_VERSION, None, now,
        ),
    )
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
                section_id, doc_id, section["level"], section["heading_path"],
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
                new_id("chk"), doc_id, paper_id, section_ids[chunk["section_ord"]],
                chunk["byte_start"], chunk["byte_end"], chunk["char_start"], chunk["char_end"],
                chunk["slice_sha256"], content_sha, chunk["index_text"], chunk.get("table_id"),
                chunk.get("row_start"), chunk.get("row_end"), chunk.get("header_span_json"),
                chunk["is_bibliography"], chunk["claimable"], index, channel, PIPELINE_VERSION,
            ),
        )
        store.index_chunk(cur.lastrowid, chunk["index_text"])
        indexed_chars += chunk["char_end"] - chunk["char_start"]
    extraction_id = new_id("ext")
    store.conn.execute(
        """INSERT INTO extractions(id, doc_id, paper_id, pipeline_version, status, reason_code,
           started_at, finished_at, stats_json) VALUES (?,?,?,?,'done','',?,?,?)""",
        (
            extraction_id, doc_id, paper_id, PIPELINE_VERSION, now, now,
            dumps({"chunks": len(chunks), "sections": len(sections)}),
        ),
    )
    store.conn.execute(
        """INSERT INTO coverage(doc_id, source_chars, indexed_chars, uncovered_json, chunk_count,
           section_count, dropped_sections_json, capped, truncation_reason, ratio, checked_at)
           VALUES (?,?,?,?,?,?,?,0,'',?,?)""",
        (
            doc_id, len(text), indexed_chars,
            json.dumps([[start, end] for start, end in uncovered]),
            len(chunks), len(sections), json.dumps({"chars": dropped}),
            indexed_chars / max(len(text), 1), now,
        ),
    )
    store.conn.execute(
        "UPDATE papers SET current_doc_id=?, cite_state='citable', updated_at=? WHERE id=?",
        (doc_id, now, paper_id),
    )
    store.mut("DERIVE", paper_id=paper_id, doc_id=doc_id, status="ok", detail=f"chunks:{len(chunks)}")
    store.conn.commit()
    if previous:
        from papermemory.claims import supersession_sweep

        try:
            supersession_sweep(store, previous["id"])
        except Exception:
            pass
    return {
        "status": "created",
        "paper_id": paper_id,
        "doc_id": doc_id,
        "chunks_created": len(chunks),
        "paper": store.get_paper(paper_id),
        "coverage": {
            "source_chars": len(text),
            "indexed_chars": indexed_chars,
            "uncovered": uncovered,
            "ratio": indexed_chars / max(len(text), 1),
        },
    }
