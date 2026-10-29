from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from papermemory import __version__
from papermemory.citations import cite_check, lookup_cite
from papermemory.context import recap
from papermemory.db import Store
from papermemory.ingest import ingest_arxiv, ingest_doi, ingest_path
from papermemory.search import search as hybrid_search
from papermemory.mcp_library import TOOL as LIBRARY_TOOL
from papermemory.util import loads

TOOLS = [
    {
        "name": "papermemory_search",
        "description": "Search academic memory: papers, claims, chunks, notes, lessons.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "kind": {"type": "string", "description": "all|paper|claim|chunk|observation|lesson"},
                "project": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "papermemory_ingest",
        "description": "Ingest a local PDF/BibTeX/markdown/manuscript path, or an arXiv id / DOI.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "arxiv": {"type": "string"},
                "doi": {"type": "string"},
                "title": {"type": "string"},
                "pdf_path": {"type": "string", "description": "Attach markdown ingest to the paper for this PDF path"},
                "project": {"type": "string"},
                "cwd": {"type": "string", "description": "Resolve the project from this directory (ah.yaml ancestor, manuscript root_path) when project is not given"},
                "kind": {"type": "string"},
            },
        },
    },
    {
        "name": "papermemory_get",
        "description": "Get a paper by id or bibtex key, including claims and chunks.",
        "inputSchema": {
            "type": "object",
            "properties": {"key": {"type": "string"}},
            "required": ["key"],
        },
    },
    {
        "name": "papermemory_cite",
        "description": "Find a stored paper to cite for a statement. Never invent citations.",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["query"],
        },
    },
    {
        "name": "papermemory_cite_check",
        "description": "Check a manuscript's in-text citations against memory.",
        "inputSchema": {
            "type": "object",
            "properties": {"manuscript": {"type": "string"}},
            "required": ["manuscript"],
        },
    },
    {
        "name": "papermemory_remember",
        "description": "Save a paper-writing or paper-reading decision, claim, or note.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string"},
                "concepts": {"type": "string", "description": "comma-separated tags"},
                "project": {"type": "string"},
                "tier": {"type": "string"},
                "paper": {"type": "string"},
                "manuscript": {"type": "string"},
                "status": {"type": "string"},
                "superseded_by": {"type": "string"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "papermemory_claim",
        "description": "Store a verbatim-anchored claim (evidence quote required), or supersede/contradict/rebind/bind an existing claim.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "type": {"type": "string"},
                "paper": {"type": "string"},
                "manuscript": {"type": "string"},
                "evidence": {"type": "string", "description": "Exact quote from the stored paper text (required to add)"},
                "project": {"type": "string"},
                "chunk_ids": {"type": "array", "items": {"type": "string"}},
                "action": {"type": "string", "description": "supersede|contradict|rebind|bind"},
                "target_claim_id": {"type": "string"},
                "doc_id": {"type": "string"},
                "ah_binding_ref": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "papermemory_recap",
        "description": "Writing-project briefing: venue, sections, contributions, citation gaps, recent notes.",
        "inputSchema": {
            "type": "object",
            "properties": {"project": {"type": "string"}},
        },
    },
    {
        "name": "papermemory_lesson",
        "description": "Save a durable academic writing/reading rule.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string"},
                "concepts": {"type": "string"},
                "project": {"type": "string"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "papermemory_quote_check",
        "description": "Check whether a quote occurs verbatim in stored paper text (chunk-index-first, exact substring).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "quote": {"type": "string"},
                "paper": {"type": "string"},
                "chunk": {"type": "string"},
                "doc": {"type": "string"},
                "max_matches": {"type": "integer"},
            },
            "required": ["quote"],
        },
    },
    {
        "name": "papermemory_trace",
        "description": "Walk a claim's provenance or a paper's raw-document/claim/citation hops.",
        "inputSchema": {
            "type": "object",
            "properties": {"claim": {"type": "string"}, "paper": {"type": "string"}},
        },
    },
    {
        "name": "papermemory_register_to_ah",
        "description": "Register stored markdown papers into an Academic Harness project (id=paper_id, citation-key aliases).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paper": {"type": "string"},
                "project": {"type": "string"},
                "all_citable": {"type": "boolean"},
                "ah_root": {"type": "string"},
                "dry_run": {"type": "boolean"},
            },
        },
    },
    {
        "name": "papermemory_outline",
        "description": "Derived section outline for a paper (roles, spans, counts, DOI, source filename).",
        "inputSchema": {"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]},
    },
    {
        "name": "papermemory_list",
        "description": "Enumerate papers, claims, lessons, or coverage (keyset paging, total_count).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "description": "papers|claims|lessons|coverage"},
                "project": {"type": "string"},
                "status": {"type": "string"},
                "cite_state": {"type": "string"},
                "cursor": {"type": "string"},
                "page_size": {"type": "integer"},
            },
        },
    },
    LIBRARY_TOOL,
]


def hidden_tools() -> set[str]:
    """Tool names the host asked not to expose (PAPERMEMORY_HIDE_TOOLS, comma separated).

    A host that provides its own front end for part of the surface, such as the Academic Harness plugin
    with its workspace-aware reference-library tool, hides the MCP copy so the model sees one tool, not two.
    """
    raw = os.environ.get("PAPERMEMORY_HIDE_TOOLS", "")
    return {name.strip() for name in raw.split(",") if name.strip()}


def active_tools() -> list[dict[str, Any]]:
    hidden = hidden_tools()
    return [tool for tool in TOOLS if tool["name"] not in hidden]


def _ok(value: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(value, indent=2, default=str, ensure_ascii=False)}]}


def _err(message: str, code: str = "internal") -> dict[str, Any]:
    return {
        "content": [
            {"type": "text", "text": json.dumps({"error": message, "code": code}, ensure_ascii=False)}
        ],
        "isError": True,
    }


def _sandbox(store, raw):
    from papermemory.sandbox import SandboxError, resolve_in_root

    try:
        return resolve_in_root(str(raw), [Path.cwd(), Path.home(), store.path.parent]), None
    except SandboxError as exc:
        return None, _err(str(exc), "path-escape")


def _degradation(doc) -> dict[str, Any] | None:
    if doc is None:
        return None
    try:
        conv = json.loads(doc["converter_json"] or "{}")
    except (json.JSONDecodeError, TypeError):
        conv = {}
    return {
        "pdf_type": conv.get("pdf_type"),
        "confidence": conv.get("confidence"),
        "pages_needing_ocr_count": len(conv.get("pages_needing_ocr") or []),
    }


def _ingest_payload(store, result: dict[str, Any]) -> dict[str, Any]:
    out = dict(result or {})
    paper = result.get("paper") if isinstance(result, dict) else None
    if isinstance(paper, dict) and paper.get("id"):
        row = store.conn.execute(
            "SELECT current_doc_id, cite_state FROM papers WHERE id=?", (paper["id"],)
        ).fetchone()
        doc = (
            store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (row["current_doc_id"],)).fetchone()
            if row and row["current_doc_id"]
            else None
        )
        out.setdefault("status", result.get("status") or ("chunkless" if doc is None else "created"))
        out.setdefault("reason_code", "")
        out["cite_state"] = row["cite_state"] if row else None
        out["doc"] = {"sha256": doc["sha256"], "corpus_path": doc["corpus_path"]} if doc else None
        out["degradation"] = _degradation(doc)
        out.setdefault("coverage", result.get("coverage"))
        out.setdefault("chunks_created", result.get("chunks_created", 0))
        out.setdefault("claims_created", 0)
        out.setdefault("sweep", None)
    return out


def _claim_payload(store, row) -> dict[str, Any]:
    record = dict(row)
    doc = (
        store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (record["doc_id"],)).fetchone()
        if record.get("doc_id")
        else None
    )
    if doc:
        record["evidence_quote"] = doc["text"][record["quote_char_start"]:record["quote_char_end"]]
        record["doc_sha16"] = doc["sha256"][:16]
        record["origin_channel"] = doc["origin_channel"]
    section = (
        store.conn.execute("SELECT heading_path, role FROM sections WHERE id=?", (record["primary_section_id"],)).fetchone()
        if record.get("primary_section_id")
        else None
    )
    record["heading_path"] = section["heading_path"] if section else None
    record["section_role"] = section["role"] if section else None
    return record


def _call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    store = None
    if name in hidden_tools():
        return _err(f"{name} is not exposed by this host", "tool-disabled")
    try:
        store = Store()
        if name == "papermemory_library":
            from papermemory.mcp_library import ToolError, error_code, library_call

            try:
                return _ok(library_call(store, args, lambda raw: _sandbox(store, raw)))
            except Exception as exc:
                if isinstance(exc, (ToolError, ValueError, LookupError)) or hasattr(exc, "code"):
                    return _err(str(exc), error_code(exc))
                raise
        if name == "papermemory_search":
            from papermemory.search_v2 import search_with_status

            limit = int(args.get("limit") or 8)
            roles = args.get("section_role")
            if isinstance(roles, str):
                roles = [roles]
            payload = search_with_status(
                store, args["query"], kind=args.get("kind") or "all", limit=limit,
                project_id=args.get("project"), section_roles=roles,
            )
            payload["truncated"] = bool(payload["results"]) and len(payload["results"]) >= limit
            max_chars = int(args.get("max_payload_chars") or 12000)
            while len(json.dumps(payload, default=str, ensure_ascii=False)) > max_chars and payload["results"]:
                payload["results"].pop()
                payload["truncated"] = True
            return _ok(payload)
        if name == "papermemory_ingest":
            from papermemory.ingest import ingest_arxiv, ingest_doi, ingest_path
            from papermemory.scope import canonical_project_slug

            project = args.get("project")
            cwd = args.get("cwd")
            if project or cwd:
                project = canonical_project_slug(Path(cwd) if cwd else Path.cwd(), project=project, store=store)
            if args.get("arxiv"):
                return _ok(_ingest_payload(store, ingest_arxiv(store, args["arxiv"], project_id=project)))
            if args.get("path"):
                path, error = _sandbox(store, args["path"])
                if error:
                    return error
                pdf_path = None
                if args.get("pdf_path"):
                    pdf_path, error = _sandbox(store, args["pdf_path"])
                    if error:
                        return error
                result = ingest_path(
                    store,
                    Path(path),
                    project_id=project,
                    kind=args.get("kind") or "auto",
                    doi=args.get("doi"),
                    title=args.get("title"),
                    pdf_path=pdf_path,
                    origin_channel=args.get("origin_channel"),
                    converter=args.get("converter"),
                )
                return _ok(_ingest_payload(store, result))
            if args.get("doi"):
                return _ok(_ingest_payload(store, ingest_doi(store, args["doi"], project_id=project)))
            return _err("path, arxiv, or doi is required", "invalid-argument")
        if name == "papermemory_get":
            max_chars = int(args.get("max_chars") or 12000)
            if args.get("chunk_ids"):
                chunks = []
                total = 0
                for chunk_id in args["chunk_ids"][:20]:
                    row = store.conn.execute(
                        """SELECT c.*, r.text AS raw_text, s.heading_path, s.role
                           FROM chunks c JOIN raw_documents r ON r.id=c.doc_id
                           LEFT JOIN sections s ON s.id=c.section_id WHERE c.id=?""",
                        (chunk_id,),
                    ).fetchone()
                    if not row:
                        continue
                    item = dict(row)
                    item["text"] = row["raw_text"][row["char_start"]:row["char_end"]]
                    item.pop("raw_text", None)
                    chunks.append(item)
                    total += len(item["text"])
                return _ok({"chunks": chunks, "totals": {"chunks": len(chunks)}, "truncated": total >= max_chars})
            key = args.get("key")
            if not key:
                return _err("key or chunk_ids is required", "invalid-argument")
            rec = store.get_paper(key)
            if not rec:
                return _err("paper not found", "paper-not-found")
            if args.get("project"):
                member = store.conn.execute(
                    "SELECT 1 FROM paper_projects WHERE paper_id=? AND project_key=?",
                    (rec["id"], args["project"]),
                ).fetchone()
                if not member:
                    return _err("paper is not in the requested project", "out-of-scope")
            claims = [_claim_payload(store, row) for row in store.conn.execute(
                "SELECT * FROM claims WHERE paper_id=? AND is_latest=1 AND status != 'contradicted' ORDER BY created_at DESC",
                (rec["id"],),
            ).fetchall()]
            raw_chunks = store.paper_chunks(rec["id"])
            chunks = []
            chars = 0
            truncated = False
            for row in raw_chunks:
                text = row["text"][row["char_start"]:row["char_end"]]
                if chars + len(text) > max_chars:
                    truncated = True
                    break
                chunks.append(
                    {
                        "id": row["id"], "chunk_index": row["chunk_index"],
                        "heading_path": row["section"], "char_span": [row["char_start"], row["char_end"]],
                        "byte_span": [row["byte_start"], row["byte_end"]], "text": text,
                    }
                )
                chars += len(text)
            doc = (
                store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (rec["current_doc_id"],)).fetchone()
                if rec.get("current_doc_id")
                else None
            )
            return _ok(
                {
                    "paper": rec,
                    "claims": claims,
                    "chunks": chunks,
                    "totals": {"chunks": len(raw_chunks), "claims": len(claims)},
                    "truncated": truncated,
                    "degradation": _degradation(doc),
                }
            )
        if name == "papermemory_cite":
            from papermemory.citations import lookup_cite
            from papermemory.search_v2 import search as search_chunks

            hits = lookup_cite(store, args["query"], limit=int(args.get("limit") or 5), project_id=args.get("project"))
            roles = args.get("section_role")
            if isinstance(roles, str):
                roles = [roles]
            out = []
            for hit in hits:
                claims = [_claim_payload(store, row) for row in store.conn.execute(
                    "SELECT * FROM claims WHERE paper_id=? AND is_latest=1 AND status IN ('extracted','verified') ORDER BY updated_at DESC",
                    (hit["id"],),
                ).fetchall()]
                if len(claims) < int(args.get("min_claims") or 0):
                    continue
                matching = [
                    {
                        "id": chunk["id"], "heading_path": chunk.get("heading_path"),
                        "section_role": chunk.get("role"), "char_span": [chunk["char_start"], chunk["char_end"]],
                        "verbatim": chunk["snippet"],
                    }
                    for chunk in search_chunks(store, args["query"], kind="chunk", limit=20, project_id=args.get("project"), section_roles=roles)
                    if chunk.get("paper_id") == hit["id"]
                ][:3]
                doc = (
                    store.conn.execute("SELECT * FROM raw_documents WHERE id=(SELECT current_doc_id FROM papers WHERE id=?)", (hit["id"],)).fetchone()
                )
                out.append(
                    {
                        **hit,
                        "claims": claims,
                        "matching_chunks": matching,
                        "degradation": _degradation(doc),
                        "supports_statement": any(claim["status"] == "verified" for claim in claims),
                    }
                )
            return _ok(out)
        if name == "papermemory_cite_check":
            from papermemory.citations import cite_check

            return _ok(cite_check(store, args["manuscript"]))
        if name == "papermemory_remember":
            concepts = [c.strip() for c in (args.get("concepts") or "").split(",") if c.strip()]
            rec = store.remember(
                args["content"], concepts=concepts, project_id=args.get("project"),
                tier=args.get("tier") or "semantic", paper_id=args.get("paper"),
                manuscript_id=args.get("manuscript"), status=args.get("status"),
                superseded_by=args.get("superseded_by"),
            )
            rec["concepts"] = loads(rec.get("concepts_json"), [])
            return _ok(rec)
        if name == "papermemory_claim":
            from papermemory import claims as claimlib
            from papermemory.util import now_iso

            action = (args.get("action") or "").strip()
            target = args.get("target_claim_id")
            if action in {"supersede", "contradict", "rebind", "bind"}:
                if not target:
                    return _err("target_claim_id is required for this action", "invalid-argument")
                if action == "supersede":
                    claimlib.supersede_claim(store, target, reason=args.get("reason") or "manual", actor="agent")
                elif action == "contradict":
                    claimlib.contradict_claim(store, target, reason=args.get("reason") or "manual", actor="agent")
                elif action == "rebind":
                    if not args.get("doc_id"):
                        return _err("doc_id is required for rebind", "invalid-argument")
                    return _ok(claimlib.rebind_claim(store, target, new_doc_id=args["doc_id"]))
                else:
                    store.conn.execute(
                        "UPDATE claims SET ah_binding_ref=?, updated_at=? WHERE id=?",
                        (args.get("ah_binding_ref"), now_iso(), target),
                    )
                    store.mut("BIND", claim_id=target, status="ok")
                    store.conn.commit()
                return _ok({"ok": True, "action": action, "claim_id": target})
            result = claimlib.add_claim(
                store, text=args["text"], asserted_quote=args.get("evidence") or "",
                paper_id=args.get("paper"), project_key=args.get("project"),
                chunk_ids=args.get("chunk_ids"), claim_type=args.get("type") or "finding",
                manuscript_id=args.get("manuscript"), actor="agent",
            )
            return _ok(
                {
                    "claim": result["claim"],
                    "quote_check": result["quote_check"],
                    "status": result["status"],
                    "similar_to": result["similar_to"],
                    "deduplicated": result["deduplicated"],
                }
            )
        if name == "papermemory_recap":
            return _ok(recap(store, project=args.get("project")))
        if name == "papermemory_lesson":
            from papermemory.util import now_iso

            if (args.get("action") or "") == "supersede":
                target = args.get("target_lesson_id")
                if not target:
                    return _err("target_lesson_id is required for supersede", "invalid-argument")
                store.conn.execute(
                    "UPDATE lessons SET status='superseded', superseded_by=?, updated_at=? WHERE id=?",
                    (args.get("superseded_by") or "manual", now_iso(), target),
                )
                store.mut("LESSON_WRITE", status="superseded", detail=f"supersede:{target}")
                store.conn.commit()
                return _ok({"ok": True, "lesson_id": target})
            concepts = [c.strip() for c in (args.get("concepts") or "").split(",") if c.strip()]
            return _ok(store.add_lesson(args["content"], concepts=concepts, project_id=args.get("project")))
        if name == "papermemory_quote_check":
            from papermemory.grounding import quote_check

            return _ok(
                quote_check(
                    store, args["quote"], paper_id=args.get("paper"), chunk_id=args.get("chunk"),
                    doc_id=args.get("doc"), max_matches=int(args.get("max_matches") or 20),
                )
            )
        if name == "papermemory_trace":
            from papermemory.grounding import verify_claim

            if args.get("claim"):
                return _ok(verify_claim(store, args["claim"]))
            if args.get("paper"):
                paper = store.get_paper(args["paper"])
                if not paper:
                    return _err("paper not found", "paper-not-found")
                docs = [
                    {"id": row["id"], "sha256": row["sha256"], "is_current": row["is_current"],
                     "corpus_path": row["corpus_path"], "origin_channel": row["origin_channel"]}
                    for row in store.conn.execute("SELECT * FROM raw_documents WHERE paper_id=? ORDER BY created_at", (paper["id"],))
                ]
                claims = [
                    {"id": row["id"], "status": row["status"], "quote_sha256": row["quote_sha256"]}
                    for row in store.conn.execute("SELECT id, status, quote_sha256 FROM claims WHERE paper_id=? ORDER BY created_at", (paper["id"],))
                ]
                citations = [
                    dict(row)
                    for row in store.conn.execute("SELECT tex_file, tex_line, bibtex_key FROM citations WHERE paper_id=?", (paper["id"],))
                ]
                return _ok({"paper": paper["id"], "documents": docs, "claims": claims, "citations": citations})
            return _err("claim or paper is required", "invalid-argument")
        if name == "papermemory_register_to_ah":
            from papermemory.ah_bridge import register_to_ah

            ah_root = args.get("ah_root")
            if ah_root:
                ah_root, error = _sandbox(store, ah_root)
                if error:
                    return error
            return _ok(
                register_to_ah(
                    store, paper=args.get("paper"), project=args.get("project"),
                    all_citable=bool(args.get("all_citable")), ah_root=ah_root,
                    dry_run=bool(args.get("dry_run")),
                )
            )
        if name == "papermemory_outline":
            from papermemory.outline import outline

            return _ok(outline(store, args["key"]))
        if name == "papermemory_list":
            from papermemory.listing import list_rows

            return _ok(
                list_rows(
                    store, args.get("kind") or "papers", project=args.get("project"),
                    status=args.get("status"), cite_state=args.get("cite_state"),
                    cursor=args.get("cursor"), page_size=min(int(args.get("page_size") or 50), 200),
                )
            )
        return _err(f"unknown tool: {name}", "unknown-tool")
    except Exception as exc:
        code = getattr(exc, "code", "internal")
        return _err(str(exc), code)
    finally:
        if store is not None:
            store.close()


# MCP stdio framing: the current TypeScript SDK (DSH, recent Grok) writes
# newline-delimited JSON. Older clients use LSP Content-Length headers.
# Detect from the first inbound message and reply in the same framing.
_framing = "content-length"


def _read_message() -> dict[str, Any] | None:
    global _framing
    line = sys.stdin.buffer.readline()
    if not line:
        return None
    if line.lstrip().startswith(b"{"):
        _framing = "ndjson"
        return json.loads(line.decode("utf-8"))
    _framing = "content-length"
    headers: dict[str, str] = {}
    while True:
        if line in (b"\r\n", b"\n"):
            break
        decoded = line.decode("utf-8")
        if ":" in decoded:
            key, value = decoded.split(":", 1)
            headers[key.strip().lower()] = value.strip()
        line = sys.stdin.buffer.readline()
        if not line:
            return None
    length = int(headers.get("content-length") or 0)
    if length <= 0:
        return None
    body = sys.stdin.buffer.read(length)
    if not body:
        return None
    return json.loads(body.decode("utf-8"))


def _write_message(payload: dict[str, Any]) -> None:
    blob = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if _framing == "ndjson":
        sys.stdout.buffer.write(blob + b"\n")
    else:
        sys.stdout.buffer.write(f"Content-Length: {len(blob)}\r\n\r\n".encode("ascii") + blob)
    sys.stdout.buffer.flush()


def _handle(message: dict[str, Any]) -> None:
    method = message.get("method")
    msg_id = message.get("id")
    if method == "initialize":
        _write_message(
            {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "papermemory", "version": __version__},
                },
            }
        )
        return
    if method == "notifications/initialized":
        return
    if method == "tools/list":
        _write_message({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": active_tools()}})
        return
    if method == "tools/call":
        params = message.get("params") or {}
        result = _call(params.get("name"), params.get("arguments") or {})
        _write_message({"jsonrpc": "2.0", "id": msg_id, "result": result})
        return
    if method == "ping":
        _write_message({"jsonrpc": "2.0", "id": msg_id, "result": {}})
        return
    if msg_id is not None:
        _write_message(
            {
                "jsonrpc": "2.0",
                "id": msg_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            }
        )


def run() -> None:
    while True:
        try:
            message = _read_message()
        except Exception as exc:
            print(f"papermemory: bad message: {exc}", file=sys.stderr)
            continue
        if message is None:
            return
        try:
            _handle(message)
        except Exception as exc:
            msg_id = message.get("id") if isinstance(message, dict) else None
            if msg_id is not None:
                _write_message(
                    {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(exc)}}
                )
            else:
                print(f"papermemory: dispatch error: {exc}", file=sys.stderr)
