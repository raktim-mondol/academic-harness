from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from papermemory.config import VERSION, db_path
from papermemory.db import Store
from papermemory.util import loads


def _store() -> Store:
    return Store()


def _emit(data: Any, as_json: bool, text: str | None = None) -> int:
    if as_json:
        print(json.dumps(data, indent=2, default=str, ensure_ascii=False))
    elif text is not None:
        print(text)
    else:
        print(json.dumps(data, indent=2, default=str, ensure_ascii=False))
    return 0


def _fmt_paper(p: dict[str, Any]) -> str:
    authors = p.get("authors") or loads(p.get("authors_json"), [])
    who = ", ".join(authors[:3])
    if len(authors) > 3:
        who += " et al."
    flag = "verified" if p.get("verified") else "UNVERIFIED"
    key = p.get("bibtex_key") or p.get("id")
    year = p.get("year") or "?"
    return f"[{key}] {p.get('title')} ({year}; {who}) [{flag}]"


def cmd_init(args: argparse.Namespace) -> int:
    store = _store()
    stats = store.stats()
    return _emit(
        {"db": str(store.path), "stats": stats, "version": VERSION},
        args.json,
        f"PaperMemory {VERSION}\nDB: {store.path}\n{json.dumps(stats, indent=2)}",
    )


def cmd_ingest(args: argparse.Namespace) -> int:
    from papermemory.ingest import ingest_arxiv, ingest_doi, ingest_path
    from papermemory.scope import canonical_project_slug

    store = _store()
    project = None
    cwd = getattr(args, "cwd", None)
    if args.project or cwd:
        anchor = Path(cwd) if cwd else Path.cwd()
        project = canonical_project_slug(anchor, project=args.project, store=store)
    if args.arxiv:
        rec = ingest_arxiv(store, args.arxiv, project_id=project)
        return _emit(rec, args.json, _fmt_paper(rec))
    if args.path:
        import json as _json

        converter = _json.loads(args.converter_json) if getattr(args, "converter_json", None) else None
        result = ingest_path(
            store,
            Path(args.path),
            project_id=project,
            kind=args.kind,
            doi=args.doi,
            title=args.title,
            pdf_path=args.pdf_path,
            origin_channel=getattr(args, "origin_channel", None),
            converter=converter,
        )
        return _emit(result, args.json)
    if args.doi:
        rec = ingest_doi(store, args.doi, project_id=project)
        return _emit(rec, args.json, _fmt_paper(rec))
    print("ingest requires PATH, --arxiv, or --doi", file=sys.stderr)
    return 2


def cmd_search(args: argparse.Namespace) -> int:
    from papermemory.search import search

    hits = search(_store(), args.query, kind=args.kind, limit=args.limit, project_id=args.project, section_roles=args.section_role or None)
    if args.json:
        return _emit(hits, True)
    if not hits:
        print("No matches.")
        return 0
    lines = []
    for i, hit in enumerate(hits, 1):
        flag = ""
        if hit.get("kind") == "paper":
            flag = " VERIFIED" if hit.get("verified") else " UNVERIFIED"
        lines.append(f"{i}. ({hit['kind']}{flag}, {hit['score']:.3f}) {hit.get('label')}\n   {hit.get('snippet')}")
    print("\n".join(lines))
    return 0


def cmd_paper(args: argparse.Namespace) -> int:
    store = _store()
    rec = store.get_paper(args.key)
    if not rec:
        print(f"paper not found: {args.key}", file=sys.stderr)
        return 1
    rec["chunks"] = [
        {
            "id": row["id"],
            "section": row["section"],
            "chunk_index": row["chunk_index"],
            "char_start": row["char_start"],
            "char_end": row["char_end"],
            "preview": " ".join((row["text"][row["char_start"]:row["char_end"]] or "").split())[:240],
        }
        for row in store.paper_chunks(rec["id"])
    ]
    rec["claims"] = store.list_claims(paper_id=rec["id"])
    rec["relations"] = store.neighbors("paper", rec["id"])
    if args.json:
        return _emit(rec, True)
    print(_fmt_paper(rec))
    if rec.get("doi"):
        print(f"DOI: {rec['doi']}")
    if rec.get("arxiv_id"):
        print(f"arXiv: {rec['arxiv_id']}")
    if rec.get("abstract"):
        print("\nAbstract:\n" + rec["abstract"][:1200])
    if rec["claims"]:
        print("\nClaims:")
        for claim in rec["claims"][:12]:
            print(f"- [{claim['status']}/{claim['claim_type']}] {claim['claim_text']}")
    return 0


def cmd_cite(args: argparse.Namespace) -> int:
    from papermemory.citations import lookup_cite

    hits = lookup_cite(_store(), args.query, limit=args.limit)
    if args.json:
        return _emit(hits, True)
    if not hits:
        print("No citable papers. Do not invent a citation.")
        return 0
    for hit in hits:
        flag = "verified" if hit["verified"] else "UNVERIFIED — do not cite until verified"
        print(f"- {hit.get('suggested_cite') or hit['title']}  key={hit.get('bibtex_key')}  [{flag}]")
        print(f"  {hit['title']}")
    return 0


def cmd_cite_check(args: argparse.Namespace) -> int:
    from papermemory.citations import cite_check

    report = cite_check(_store(), args.manuscript)
    if args.json:
        return _emit(report, True)
    print(f"Manuscript: {report['manuscript']}")
    print(f"Cited keys: {len(report['cited_keys'])} ({report['cite_count']} in-text cites)")
    if report["missing_from_memory"]:
        print("Missing from memory:")
        for key in report["missing_from_memory"]:
            print(f"  - {key}")
    if report["unverified_cited"]:
        print("Cited but UNVERIFIED:")
        for item in report["unverified_cited"]:
            print(f"  - {item['key']}: {item['title']}")
    if not report["missing_from_memory"] and not report["unverified_cited"]:
        print("All in-text citations are in memory.")
    return 0


def cmd_lookup(args: argparse.Namespace) -> int:
    from papermemory.scholar import fetch_arxiv, fetch_crossref

    store = _store()
    if args.all:
        rows = store.conn.execute("SELECT * FROM papers WHERE verified=0").fetchall()
    elif args.key:
        rec = store.get_paper(args.key)
        rows = [rec] if rec else []
    else:
        print("verify requires a paper key or --all", file=sys.stderr)
        return 2
    results = []
    for row in rows:
        rec = dict(row) if not isinstance(row, dict) else row
        try:
            if rec.get("doi"):
                meta = fetch_crossref(rec["doi"])
            elif rec.get("arxiv_id"):
                meta = fetch_arxiv(rec["arxiv_id"])
            else:
                results.append({"id": rec["id"], "ok": False, "reason": "no doi/arxiv"})
                continue
            updated = store.upsert_paper({**rec, **meta, "authors": meta.get("authors") or rec.get("authors")})
            results.append({"id": rec["id"], "ok": True, "title": updated["title"]})
        except Exception as exc:
            results.append({"id": rec.get("id"), "ok": False, "reason": str(exc)})
    return _emit(results, args.json)


def cmd_remember(args: argparse.Namespace) -> int:
    concepts = [c.strip() for c in (args.concepts or "").split(",") if c.strip()]
    rec = _store().remember(args.text, concepts=concepts, project_id=args.project, tier=args.tier)
    return _emit(rec, args.json, f"Saved {rec['id']} concepts={loads(rec['concepts_json'])}")


def cmd_recall(args: argparse.Namespace) -> int:
    from papermemory.search import search

    hits = search(_store(), args.query, kind=args.kind, limit=args.limit, project_id=args.project, section_roles=args.section_role or None)
    return _emit(hits, args.json) if args.json else cmd_search(args)


def cmd_lesson(args: argparse.Namespace) -> int:
    concepts = [c.strip() for c in (args.concepts or "").split(",") if c.strip()]
    rec = _store().add_lesson(args.text, concepts=concepts, project_id=args.project)
    return _emit(rec, args.json, f"Lesson {rec['id']} saved.")


def cmd_recap(args: argparse.Namespace) -> int:
    from papermemory.context import recap

    data = recap(_store(), project=args.project)
    if args.json:
        return _emit(data, True)
    stats = data["stats"]
    print(f"PaperMemory  papers={stats['papers']} (verified {stats['verified_papers']}/{stats['papers']})  claims={stats['claims']}  observations={stats['observations']}")
    if data.get("manuscript"):
        ms = data["manuscript"]
        print(f"\nManuscript: {ms['title']}")
        print(f"  slug={ms['slug']}  venue={ms.get('target_venue')}  style={ms.get('citation_style')}  status={ms['status']}")
        for sec in data.get("sections") or []:
            print(f"  section {sec['name']}: {sec.get('word_count') or 0} words ({sec.get('status')})")
        if data.get("contributions"):
            print("  contributions:")
            for item in data["contributions"]:
                print(f"    - {item}")
        cc = data.get("cite_check") or {}
        if cc:
            print(f"  citations: {len(cc.get('cited_keys') or [])} keys, missing={cc.get('missing_from_memory')}, unverified={len(cc.get('unverified_cited') or [])}")
    if data.get("lessons"):
        print("\nLessons:")
        for les in data["lessons"]:
            print(f"- {les['content']}")
    if data.get("observations"):
        print("\nRecent memory:")
        for obs in data["observations"][:5]:
            print(f"- {obs['content'][:240]}")
    return 0


def cmd_context(args: argparse.Namespace) -> int:
    return cmd_recap(args)


def cmd_manuscript(args: argparse.Namespace) -> int:
    store = _store()
    if args.ms_cmd == "init":
        from papermemory.util import slugify

        slug = args.slug or slugify(args.title)
        rec = store.upsert_manuscript(
            {
                "title": args.title,
                "slug": slug,
                "target_venue": args.venue,
                "citation_style": args.style,
                "root_path": str(Path(args.path).resolve()) if args.path else None,
            }
        )
        return _emit(rec, args.json)
    if args.ms_cmd == "status":
        args.project = args.slug
        return cmd_recap(args)
    if args.ms_cmd == "comment":
        ms = store.get_manuscript(args.slug)
        if not ms:
            print("manuscript not found", file=sys.stderr)
            return 1
        rec = store.add_reviewer_comment(ms["id"], args.text, reviewer=args.reviewer)
        return _emit(rec, args.json)
    if args.ms_cmd == "term":
        ms = store.get_manuscript(args.slug)
        if not ms:
            print("manuscript not found", file=sys.stderr)
            return 1
        avoid = [x.strip() for x in (args.avoid or "").split(",") if x.strip()]
        store.add_term(ms["id"], args.canonical, avoid=avoid, notes=args.notes)
        return _emit({"ok": True}, args.json, f"term {args.canonical}")
    print("unknown manuscript subcommand", file=sys.stderr)
    return 2


def cmd_claim(args: argparse.Namespace) -> int:
    store = _store()
    rec = store.add_claim(
        {
            "claim_text": args.text,
            "claim_type": args.type,
            "paper_id": args.paper,
            "manuscript_id": args.manuscript,
            "evidence_quote": args.evidence,
            "section": args.section,
            "status": args.status,
            "confidence": args.confidence,
        }
    )
    return _emit(rec, args.json, f"Claim {rec['id']} [{rec['status']}] {rec['claim_text']}")


def cmd_doctor(args: argparse.Namespace) -> int:
    store = _store()
    if getattr(args, "schema", False):
        from papermemory.ops import doctor_schema

        report = doctor_schema(store)
        return _emit(report, args.json, json.dumps(report, indent=2))
    stats = store.stats()
    issues = []
    if stats["unverified_papers"]:
        issues.append(f"{stats['unverified_papers']} papers have no DOI/arXiv verification")
    empty_abs = store.conn.execute("SELECT COUNT(*) FROM papers WHERE abstract IS NULL OR abstract=''").fetchone()[0]
    if empty_abs:
        issues.append(f"{empty_abs} papers have no abstract")
    report = {"db": str(store.path), "stats": stats, "issues": issues, "ok": not issues}
    return _emit(report, args.json, json.dumps(report, indent=2))


def cmd_migrate(args: argparse.Namespace) -> int:
    from papermemory.db import Store
    from papermemory.ops import migrate

    store = Store.connect_for_migration(db_path())
    try:
        result = migrate(store)
    finally:
        store.close()
    return _emit(result, args.json, f"migrate: {result}")


def cmd_backup(args: argparse.Namespace) -> int:
    from papermemory.ops import backup

    result = backup(_store(), Path(args.out) if args.out else None)
    return _emit(result, args.json, f"backup: {result['path']} ({result['papers']} papers)")


def cmd_export(args: argparse.Namespace) -> int:
    import time as _time

    from papermemory.ops import export_store

    store = _store()
    out = Path(args.out) if args.out else store.path.parent / "exports" / f"papermemory-{_time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    result = export_store(store, out)
    return _emit(result, args.json, f"export: {result['path']} {result['tables']}")


def cmd_restore(args: argparse.Namespace) -> int:
    from papermemory.ops import restore_store

    result = restore_store(_store(), Path(args.path), force=args.force)
    return _emit(result, args.json, f"restore: {result['papers']} papers from {args.path}")


def cmd_vacuum(args: argparse.Namespace) -> int:
    from papermemory.ops import vacuum

    result = vacuum(_store())
    return _emit(result, args.json, f"vacuum: {result['before_bytes']} -> {result['after_bytes']} bytes")


def cmd_health(args: argparse.Namespace) -> int:
    from papermemory.ops import health_lite

    result = health_lite(_store())
    return _emit(result, args.json, json.dumps(result, indent=2))


def cmd_events_export(args: argparse.Namespace) -> int:
    from papermemory.ops import export_events_jsonl

    result = export_events_jsonl(_store(), Path(args.out))
    return _emit(result, args.json, f"events: {result['files']}")


def cmd_merge(args: argparse.Namespace) -> int:
    result = _store().merge_papers(args.source, args.into)
    return _emit(result, args.json, f"merge: {result}")


def cmd_promote(args: argparse.Namespace) -> int:
    result = _store().promote_identity(args.paper, args.kind, args.value)
    return _emit(result, args.json, f"promote: {result}")


def cmd_outline(args: argparse.Namespace) -> int:
    from papermemory.outline import outline

    result = outline(_store(), args.key)
    return _emit(result, args.json, json.dumps(result, indent=2, default=str))


def cmd_reindex(args: argparse.Namespace) -> int:
    from papermemory.reindex import reindex_from_raw

    if not args.from_raw:
        print("reindex requires --from-raw", file=sys.stderr)
        return 2
    result = reindex_from_raw(_store(), paper_id=args.paper)
    return _emit(result, args.json, f"reindex: {result}")


def cmd_list(args: argparse.Namespace) -> int:
    from papermemory.listing import list_rows

    kind = getattr(args, "kind", "papers") or "papers"
    page_size = getattr(args, "page_size", None) or getattr(args, "limit", 50) or 50
    result = list_rows(
        _store(), kind, project=args.project, status=getattr(args, "status", None),
        cite_state=getattr(args, "cite_state", None), cursor=getattr(args, "cursor", None),
        page_size=page_size,
    )
    return _emit(result, args.json, json.dumps(result, indent=2, default=str))


def cmd_coverage(args: argparse.Namespace) -> int:
    store = _store()
    sql = """SELECT cov.*, p.id AS paper_id, p.title, p.doi, d.origin_path
             FROM coverage cov JOIN raw_documents d ON d.id=cov.doc_id
             JOIN papers p ON p.id=d.paper_id"""
    values: list[Any] = []
    if args.project:
        sql += " WHERE EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)"
        values.append(args.project)
    sql += " ORDER BY cov.ratio ASC, p.id"
    rows = [dict(row) for row in store.conn.execute(sql, values).fetchall()]
    totals = {
        "docs": len(rows),
        "source_chars": sum(row["source_chars"] for row in rows),
        "indexed_chars": sum(row["indexed_chars"] for row in rows),
        "capped": sum(1 for row in rows if row["capped"]),
        "with_uncovered": sum(1 for row in rows if row["uncovered_json"] not in ("[]", "", None)),
    }
    totals["ratio"] = totals["indexed_chars"] / max(totals["source_chars"], 1)
    return _emit({"totals": totals, "docs": rows}, args.json, json.dumps(totals, indent=2))


def cmd_verify_claim(args: argparse.Namespace) -> int:
    from papermemory.grounding import verify_claim

    walk = verify_claim(_store(), args.claim)
    _emit(walk, args.json, json.dumps(walk, indent=2, default=str))
    return 0 if walk["ok"] else 1


def cmd_quote_check(args: argparse.Namespace) -> int:
    from papermemory.grounding import quote_check

    result = quote_check(
        _store(), args.quote, paper_id=args.paper, chunk_id=args.chunk,
        doc_id=args.doc, max_matches=args.max_matches,
    )
    return _emit(result, args.json, json.dumps(result, indent=2, default=str))


def cmd_trace(args: argparse.Namespace) -> int:
    from papermemory.grounding import verify_claim

    store = _store()
    if args.claim:
        return _emit(verify_claim(store, args.claim), args.json)
    if args.paper:
        paper = store.get_paper(args.paper)
        if not paper:
            print("paper not found", file=sys.stderr)
            return 1
        docs = [dict(row) for row in store.conn.execute("SELECT id, sha256, is_current, corpus_path, origin_channel FROM raw_documents WHERE paper_id=? ORDER BY created_at", (paper["id"],))]
        claims = [dict(row) for row in store.conn.execute("SELECT id, status, quote_sha256 FROM claims WHERE paper_id=?", (paper["id"],))]
        citations = [dict(row) for row in store.conn.execute("SELECT tex_file, tex_line, bibtex_key FROM citations WHERE paper_id=?", (paper["id"],))]
        return _emit({"paper": paper["id"], "documents": docs, "claims": claims, "citations": citations}, args.json)
    print("trace requires --claim or --paper", file=sys.stderr)
    return 2


def cmd_claims(args: argparse.Namespace) -> int:
    from papermemory.claims import list_claims

    result = list_claims(
        _store(), project=args.project, status=args.status, since=args.since,
        cursor=args.cursor, page_size=args.page_size,
    )
    return _emit(result, args.json, json.dumps(result, indent=2, default=str))


def cmd_sweep(args: argparse.Namespace) -> int:
    from papermemory.claims import supersession_sweep

    result = supersession_sweep(_store(), args.doc, batch_size=args.batch_size)
    return _emit(result, args.json, f"sweep: {result}")


def cmd_catalog(args: argparse.Namespace) -> int:
    from papermemory.claims import write_catalog

    result = write_catalog(_store(), args.project)
    return _emit(result, args.json, f"catalog: {result}")


def cmd_register_ah(args: argparse.Namespace) -> int:
    from papermemory.ah_bridge import register_to_ah

    result = register_to_ah(
        _store(), paper=args.paper, project=args.project,
        all_citable=args.all_citable, ah_root=args.ah_root, dry_run=args.dry_run,
    )
    return _emit(result, args.json, f"register-ah: {result}")


def cmd_evidence_export(args: argparse.Namespace) -> int:
    from papermemory.ah_bridge import export_evidence

    result = export_evidence(_store(), args.out, project=args.project)
    return _emit(result, args.json, f"evidence: {result}")


def cmd_import_verdicts(args: argparse.Namespace) -> int:
    from papermemory.ah_bridge import import_verdicts

    result = import_verdicts(_store(), args.path)
    return _emit(result, args.json, f"verdicts: {result}")


def cmd_log(args: argparse.Namespace) -> int:
    from papermemory.ops import log_tail, prune_events

    store = _store()
    if args.prune:
        removed = prune_events(store, keep_days=args.keep_days)
        return _emit({"pruned": removed, "keep_days": args.keep_days}, args.json, f"pruned {removed} events")
    rows = log_tail(store, limit=args.tail)
    if args.json:
        return _emit(rows, True)
    for row in rows:
        print(f"{row['ts']} {row['op']} | paper={row.get('paper_id') or '-'} status={row['status']} reason={row.get('reason_code') or '-'} {row.get('detail') or ''}")
    return 0


def cmd_tools(args: argparse.Namespace) -> int:
    from papermemory.mcp_server import TOOLS

    names = [tool["name"] for tool in TOOLS]
    return _emit(names, args.json, "\n".join(names))


def cmd_mcp(_args: argparse.Namespace) -> int:
    from papermemory.mcp_server import run

    run()
    return 0


def build_parser() -> argparse.ArgumentParser:
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--json", action="store_true", help="machine-readable output")
    p = argparse.ArgumentParser(
        prog="papermemory",
        description="Academic paper memory for understanding and writing",
        parents=[shared],
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="create the local database", parents=[shared])
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("ingest", help="ingest a paper, bibliography, PDF, or manuscript tree", parents=[shared])
    s.add_argument("path", nargs="?")
    s.add_argument("--arxiv")
    s.add_argument("--doi")
    s.add_argument("--title")
    s.add_argument("--pdf-path", dest="pdf_path", help="attach markdown/tex ingest to an existing PDF record")
    s.add_argument("--project")
    s.add_argument("--cwd", help="Resolve the project from this directory (ah.yaml ancestor, manuscript root_path) when --project is not given")
    s.add_argument("--kind", default="auto", choices=["auto", "pdf", "bibtex", "markdown", "tex", "dir", "manuscript"])
    s.add_argument("--origin-channel", dest="origin_channel")
    s.add_argument("--converter-json", dest="converter_json")
    s.set_defaults(func=cmd_ingest)

    s = sub.add_parser("search", help="hybrid search across papers, claims, chunks, notes", parents=[shared])
    s.add_argument("query")
    s.add_argument("--kind", default="all")
    s.add_argument("--project")
    s.add_argument("--limit", type=int, default=8)
    s.add_argument("--section-role", action="append", dest="section_role", default=[])
    s.set_defaults(func=cmd_search)

    s = sub.add_parser("paper", help="show a paper by id or bibtex key", parents=[shared])
    s.add_argument("key")
    s.set_defaults(func=cmd_paper)

    s = sub.add_parser("cite", help="find a citable paper for a statement", parents=[shared])
    s.add_argument("query")
    s.add_argument("--limit", type=int, default=5)
    s.set_defaults(func=cmd_cite)

    s = sub.add_parser("cite-check", help="compare manuscript in-text cites to memory", parents=[shared])
    s.add_argument("manuscript")
    s.set_defaults(func=cmd_cite_check)

    s = sub.add_parser("lookup", help="look up DOI/arXiv metadata", parents=[shared])
    s.add_argument("key", nargs="?")
    s.add_argument("--all", action="store_true")
    s.set_defaults(func=cmd_lookup)

    s = sub.add_parser("remember", help="save a writing or reading decision", parents=[shared])
    s.add_argument("text")
    s.add_argument("--concepts", default="")
    s.add_argument("--project")
    s.add_argument("--tier", default="semantic")
    s.set_defaults(func=cmd_remember)

    s = sub.add_parser("recall", help="retrieve notes and papers", parents=[shared])
    s.add_argument("query")
    s.add_argument("--kind", default="all")
    s.add_argument("--project")
    s.add_argument("--limit", type=int, default=8)
    s.add_argument("--section-role", action="append", dest="section_role", default=[])
    s.set_defaults(func=cmd_recall)

    s = sub.add_parser("lesson", help="save a durable writing/reading rule", parents=[shared])
    s.add_argument("text")
    s.add_argument("--concepts", default="")
    s.add_argument("--project")
    s.set_defaults(func=cmd_lesson)

    s = sub.add_parser("recap", help="briefing for a writing project", parents=[shared])
    s.add_argument("--project")
    s.set_defaults(func=cmd_recap)

    s = sub.add_parser("context", help="alias for recap", parents=[shared])
    s.add_argument("--project")
    s.set_defaults(func=cmd_context)

    s = sub.add_parser("claim", help="store a claim with optional evidence", parents=[shared])
    s.add_argument("text")
    s.add_argument("--type", default="finding")
    s.add_argument("--paper")
    s.add_argument("--manuscript")
    s.add_argument("--evidence")
    s.add_argument("--section")
    s.add_argument("--status", default="extracted")
    s.add_argument("--confidence", type=float, default=0.5)
    s.set_defaults(func=cmd_claim)

    ms = sub.add_parser("manuscript", help="writing-project commands", parents=[shared])
    ms_sub = ms.add_subparsers(dest="ms_cmd", required=True)
    m = ms_sub.add_parser("init", parents=[shared])
    m.add_argument("--title", required=True)
    m.add_argument("--slug")
    m.add_argument("--venue")
    m.add_argument("--style")
    m.add_argument("--path")
    m.set_defaults(func=cmd_manuscript)
    m = ms_sub.add_parser("status", parents=[shared])
    m.add_argument("slug")
    m.set_defaults(func=cmd_manuscript)
    m = ms_sub.add_parser("comment", parents=[shared])
    m.add_argument("slug")
    m.add_argument("text")
    m.add_argument("--reviewer")
    m.set_defaults(func=cmd_manuscript)
    m = ms_sub.add_parser("term", parents=[shared])
    m.add_argument("slug")
    m.add_argument("canonical")
    m.add_argument("--avoid", default="")
    m.add_argument("--notes")
    m.set_defaults(func=cmd_manuscript)

    s = sub.add_parser("merge", help="merge one paper into another", parents=[shared])
    s.add_argument("source")
    s.add_argument("--into", required=True)
    s.set_defaults(func=cmd_merge)

    s = sub.add_parser("promote", help="promote a paper identity", parents=[shared])
    s.add_argument("paper")
    s.add_argument("kind", choices=["doi", "arxiv_id", "pmid", "title_year", "legacy_id"])
    s.add_argument("value")
    s.set_defaults(func=cmd_promote)

    s = sub.add_parser("list", help="list papers, claims, lessons, or coverage", parents=[shared])
    s.add_argument("--kind", default="papers", choices=["papers", "claims", "lessons", "coverage"])
    s.add_argument("--project")
    s.add_argument("--status")
    s.add_argument("--cite-state")
    s.add_argument("--cursor")
    s.add_argument("--page-size", type=int, default=50, dest="page_size")
    s.add_argument("--limit", type=int, default=50)
    s.set_defaults(func=cmd_list)

    s = sub.add_parser("coverage", help="chunk coverage per document", parents=[shared])
    s.add_argument("--project")
    s.set_defaults(func=cmd_coverage)

    s = sub.add_parser("outline", help="derived section outline for a paper", parents=[shared])
    s.add_argument("key")
    s.set_defaults(func=cmd_outline)

    s = sub.add_parser("reindex", help="re-derive sections/chunks/FTS from stored raw markdown", parents=[shared])
    s.add_argument("--from-raw", action="store_true", dest="from_raw")
    s.add_argument("--paper")
    s.set_defaults(func=cmd_reindex)

    s = sub.add_parser("verify", help="walk a claim's provenance", parents=[shared])
    s.add_argument("claim")
    s.set_defaults(func=cmd_verify_claim)

    s = sub.add_parser("quote-check", help="exact-substring quote check", parents=[shared])
    s.add_argument("quote")
    s.add_argument("--paper")
    s.add_argument("--chunk")
    s.add_argument("--doc")
    s.add_argument("--max-matches", type=int, default=20, dest="max_matches")
    s.set_defaults(func=cmd_quote_check)

    s = sub.add_parser("trace", help="walk claim or paper provenance", parents=[shared])
    s.add_argument("--claim")
    s.add_argument("--paper")
    s.set_defaults(func=cmd_trace)

    s = sub.add_parser("claims", help="list claims (keyset paging)", parents=[shared])
    s.add_argument("--project")
    s.add_argument("--status")
    s.add_argument("--since")
    s.add_argument("--cursor", type=int)
    s.add_argument("--page-size", type=int, default=50, dest="page_size")
    s.set_defaults(func=cmd_claims)

    s = sub.add_parser("sweep", help="mark claims on a superseded document", parents=[shared])
    s.add_argument("--doc", required=True)
    s.add_argument("--batch-size", type=int, default=200, dest="batch_size")
    s.set_defaults(func=cmd_sweep)

    s = sub.add_parser("catalog", help="write corpus/CATALOG.json|.md from rows", parents=[shared])
    s.add_argument("--project")
    s.set_defaults(func=cmd_catalog)

    s = sub.add_parser("register-ah", help="register markdown papers into an Academic Harness project", parents=[shared])
    s.add_argument("--paper")
    s.add_argument("--project")
    s.add_argument("--all-citable", action="store_true", dest="all_citable")
    s.add_argument("--ah-root", dest="ah_root")
    s.add_argument("--dry-run", action="store_true", dest="dry_run")
    s.set_defaults(func=cmd_register_ah)

    s = sub.add_parser("evidence-export", help="write pm-evidence-1 rows for AH", parents=[shared])
    s.add_argument("out")
    s.add_argument("--project")
    s.set_defaults(func=cmd_evidence_export)

    s = sub.add_parser("import-verdicts", help="import AH verdict ledger rows", parents=[shared])
    s.add_argument("path")
    s.set_defaults(func=cmd_import_verdicts)

    s = sub.add_parser("log", help="tail or prune the event ledger", parents=[shared])
    s.add_argument("--tail", type=int, default=20)
    s.add_argument("--prune", action="store_true")
    s.add_argument("--keep-days", type=int, default=90, dest="keep_days")
    s.set_defaults(func=cmd_log)

    s = sub.add_parser("tools", help="print the MCP tool surface", parents=[shared])
    s.set_defaults(func=cmd_tools)

    s = sub.add_parser("doctor", help="health check", parents=[shared])
    s.add_argument("--schema", action="store_true", help="schema/version/runtime report")
    s.set_defaults(func=cmd_doctor)

    s = sub.add_parser("migrate", help="run explicit single-writer migrations", parents=[shared])
    s.set_defaults(func=cmd_migrate)

    s = sub.add_parser("backup", help="copy the database with sha256", parents=[shared])
    s.add_argument("--out")
    s.set_defaults(func=cmd_backup)

    s = sub.add_parser("export", help="export all tables as JSONL", parents=[shared])
    s.add_argument("--out")
    s.set_defaults(func=cmd_export)

    s = sub.add_parser("restore", help="restore a JSONL export", parents=[shared])
    s.add_argument("path")
    s.add_argument("--force", action="store_true")
    s.set_defaults(func=cmd_restore)

    s = sub.add_parser("vacuum", help="compact the database", parents=[shared])
    s.set_defaults(func=cmd_vacuum)

    s = sub.add_parser("health", help="lightweight integrity and count report", parents=[shared])
    s.set_defaults(func=cmd_health)

    s = sub.add_parser("events-export", help="write events-YYYYMM.jsonl files", parents=[shared])
    s.add_argument("out")
    s.set_defaults(func=cmd_events_export)

    s = sub.add_parser("mcp", help="run the MCP stdio server", parents=[shared])
    s.set_defaults(func=cmd_mcp)

    s = sub.add_parser("version", parents=[shared])
    s.set_defaults(func=lambda a: _emit({"version": VERSION, "db": str(db_path())}, a.json, f"papermemory {VERSION}"))
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except BrokenPipeError:
        return 0
    except Exception as exc:
        code = getattr(exc, "code", None)
        payload = {"error": str(exc)}
        if code:
            payload["code"] = code
        if getattr(args, "json", False):
            print(json.dumps(payload), file=sys.stderr)
        else:
            prefix = f"[{code}] " if code else ""
            print(f"error: {prefix}{exc}", file=sys.stderr)
        return 1
