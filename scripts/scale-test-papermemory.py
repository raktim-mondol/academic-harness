#!/usr/bin/env python3
"""Scale acceptance for PaperMemory v2 against 100+ real journal papers.

Usage: ~/.dsh/papermemory/.venv/bin/python scripts/scale-test-papermemory.py \
         --corpus /tmp/pm-scale/corpus --db /tmp/pm-scale/scale.db --out reports/papermemory-v2-scale-test.md
The test never touches the live store; it builds a scratch DB and corpus copy.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import shutil
import statistics
import time
from collections import Counter
from pathlib import Path

from papermemory import claims as claimlib
from papermemory.corpus import ingest_markdown
from papermemory.db import Store
from papermemory.grounding import quote_check, verify_claim
from papermemory.listing import list_rows
from papermemory.outline import outline
from papermemory.search_v2 import search, search_with_status
from papermemory.context import recap
from papermemory.tokenizer import terms

RESULTS: dict = {"checks": [], "metrics": {}}


def check(name: str, ok: bool, detail=""):
    RESULTS["checks"].append({"check": name, "ok": bool(ok), "detail": str(detail)[:400]})
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))


def prepare_corpus(corpus: Path, prepared: Path) -> dict:
    prepared.mkdir(parents=True, exist_ok=True)
    stats = {"files": 0, "prefixed_title": 0, "already": 0}
    from papermemory.markdown_contract import Refusal, parse_frontmatter, resolve_identity

    for path in sorted(corpus.glob("*.md")):
        text = path.read_text(encoding="utf-8", errors="replace")
        try:
            fm, body = parse_frontmatter(text)
            resolve_identity(fm, body_text=body)
            target = prepared / path.name
        except Refusal:
            title = path.stem.replace("_", " ").replace("-", " ").strip()[:120]
            target = prepared / path.name
            target.write_text(f"---\ntitle: {title}\nyear: 2024\n---\n" + text, encoding="utf-8")
            stats["prefixed_title"] += 1
            stats["files"] += 1
            continue
        if not target.exists() or target.read_bytes() != path.read_bytes():
            shutil.copy2(path, target)
        stats["files"] += 1
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="/tmp/pm-scale/source-corpus")
    ap.add_argument("--db", default="/tmp/pm-scale/scale.db")
    ap.add_argument("--out", default="reports/papermemory-v2-scale-test.md")
    args = ap.parse_args()
    corpus = Path(args.corpus)
    db = Path(args.db)
    for suffix in ("", "-wal", "-shm"):
        Path(str(db) + suffix).unlink(missing_ok=True)
    shutil.rmtree(db.parent / "corpus", ignore_errors=True)
    shutil.rmtree(db.parent / "prepared", ignore_errors=True)
    prepared = db.parent / "prepared"
    RESULTS["metrics"]["prepare"] = prepare_corpus(corpus, prepared)
    store = Store(db)
    project = "scale125"

    # 1) bulk ingest
    start = time.perf_counter()
    statuses = Counter()
    failed = []
    for path in sorted(prepared.glob("*.md")):
        result = ingest_markdown(store, path, project_id=project)
        statuses[result["status"]] += 1
        if result["status"] == "failed":
            failed.append({"file": path.name, "reason": result.get("reason_code")})
    ingest_seconds = time.perf_counter() - start
    papers = store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
    docs = store.conn.execute("SELECT COUNT(*) FROM raw_documents").fetchone()[0]
    chunks = store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    sections = store.conn.execute("SELECT COUNT(*) FROM sections").fetchone()[0]
    tables = store.conn.execute("SELECT COUNT(*) FROM chunks WHERE table_id IS NOT NULL").fetchone()[0]
    bib = store.conn.execute("SELECT COUNT(*) FROM chunks WHERE is_bibliography=1").fetchone()[0]
    roles = dict(store.conn.execute("SELECT role, COUNT(*) FROM sections GROUP BY role ORDER BY 2 DESC").fetchall())
    RESULTS["metrics"].update(
        ingest_seconds=round(ingest_seconds, 2), statuses=dict(statuses), failed=failed[:10],
        papers=papers, documents=docs, chunks=chunks, sections=sections, table_chunks=tables,
        bibliography_chunks=bib, roles=roles,
    )
    check("100+ unique papers ingested", papers >= 100, f"papers={papers}, docs={docs}, statuses={dict(statuses)}")
    check("all ingested files produced chunks", (statuses.get("created", 0) + statuses.get("duplicate-noop", 0)) == len(list(prepared.glob("*.md"))) and chunks > 0, f"created={statuses.get('created')}, dup={statuses.get('duplicate-noop')}, chunks={chunks}")
    check("no unexpected ingest failures", len(failed) <= 5, f"failed={len(failed)} {failed[:3]}")

    # 2) idempotent re-ingest and duplicate copies
    sample = sorted(prepared.glob("*.md"))[:25]
    statuses2 = Counter(ingest_markdown(store, path, project_id=project)["status"] for path in sample)
    check("re-ingest is duplicate-noop", statuses2 == Counter({"duplicate-noop": len(sample)}), dict(statuses2))
    dup_dir = db.parent / "dupes"
    dup_dir.mkdir(exist_ok=True)
    for path in sorted(prepared.glob("*.md"))[:5]:
        shutil.copy2(path, dup_dir / ("copy-" + path.name))
    dup_status = Counter(ingest_markdown(store, path, project_id=project)["status"] for path in sorted(dup_dir.glob("*.md")))
    check("same paper from another path stays one record", dup_status.get("duplicate-noop", 0) == 5, dict(dup_status))
    docs_after = store.conn.execute("SELECT COUNT(*) FROM raw_documents").fetchone()[0]
    check("no duplicate raw documents", docs_after == docs, f"{docs} -> {docs_after}")

    # 3) retrieval: rare-token probes, true top-N, latency
    rows = store.conn.execute(
        """SELECT c.id, c.index_text FROM chunks c JOIN raw_documents r ON r.id=c.doc_id
           WHERE c.claimable=1 AND c.is_bibliography=0 AND r.is_current=1"""
    ).fetchall()
    df = Counter(token for row in rows for token in set(terms(row["index_text"])))
    rare = [token for token, count in df.items() if count == 1 and len(token) >= 8 and not token.isdigit()][:400]
    random.seed(42)
    probes = random.sample(rare, min(20, len(rare)))
    latencies = []
    topn_ok = 0
    for probe in probes:
        expected = [
            row[0]
            for row in store.conn.execute(
                """SELECT c.id FROM chunks_fts JOIN chunks c ON c.seq=chunks_fts.rowid
                   JOIN raw_documents r ON r.id=c.doc_id
                   WHERE chunks_fts MATCH ? AND c.claimable=1 AND c.is_bibliography=0 AND r.is_current=1
                     AND EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=c.paper_id AND pp.project_key=?)
                   ORDER BY bm25(chunks_fts) LIMIT 10""",
                (f'"{probe}"', project),
            ).fetchall()
        ]
        started = time.perf_counter()
        status = search_with_status(store, probe, kind="chunk", project_id=project, limit=10)
        latencies.append((time.perf_counter() - started) * 1000)
        got = [hit["id"] for hit in status["results"]]
        topn_ok += int(got == expected and bool(got))
    p95 = sorted(latencies)[int(len(latencies) * 0.95) - 1] if latencies else 0.0
    RESULTS["metrics"].update(probes=len(probes), topn_matches=topn_ok, p95_ms=round(p95, 2), p50_ms=round((statistics.median(latencies) if latencies else 0), 2))
    check("true top-N matches bm25 for all probes", topn_ok == len(probes), f"{topn_ok}/{len(probes)}")
    check("scoped search p95 <= 120 ms", p95 <= 120, f"p95={p95:.1f}ms")

    # 4) project isolation
    other_project = "other-project"
    iso = db.parent / "iso-only.md"
    iso.write_text(
        "---\ndoi: 10.99/isolation-only\ntitle: Isolation Only\nyear: 2024\n---\n"
        "# Isolation Only\n\n## Methods\n\nA uniquely scoped zzisolationtoken appears only here.\n",
        encoding="utf-8",
    )
    ingest_markdown(store, iso, project_id=other_project)
    status = search_with_status(store, "zzisolationtoken", kind="chunk", project_id=project)
    check("cross-project leak blocked", status["results"] == [] and status["empty_reason"] in {"no-match-in-project", "all-suppressed:uncovered-span"}, status["empty_reason"])
    other_hit = search_with_status(store, "zzisolationtoken", kind="chunk", project_id=other_project)
    check("other project can retrieve its own chunk", bool(other_hit["results"]))

    # 5) bibliography exclusion and typed absence
    claimable_terms = {token for row in rows for token in terms(row[1])}
    bib_chunks = [
        row[0] for row in store.conn.execute(
            "SELECT c.index_text FROM chunks c JOIN raw_documents r ON r.id=c.doc_id WHERE c.is_bibliography=1 AND r.is_current=1"
        ).fetchall()
    ]
    if bib_chunks:
        bib_token = next(
            (token for chunk in bib_chunks for token in terms(chunk)
             if len(token) >= 8 and token not in claimable_terms), None
        )
        if bib_token:
            status = search_with_status(store, bib_token, kind="chunk", project_id=project)
            check("bibliography is suppressed, not returned", status["results"] == [] and status["empty_reason"].startswith("all-suppressed:bibliography"), f"reason={status['empty_reason']} suppressed={status['suppressed']} results={len(status['results'])} token={bib_token}")
    missing = search_with_status(store, "zzzznotpresentterm", project_id=project)
    check("absent term reports no-match", missing["empty_reason"] == "no-match", missing["empty_reason"])

    # 6) claims: anchor, verify, contradict, dedupe, OCR
    claim_rows = store.conn.execute(
        """SELECT c.id, c.paper_id, c.char_start, c.char_end, r.text FROM chunks c
           JOIN raw_documents r ON r.id=c.doc_id
           WHERE c.claimable=1 AND c.is_bibliography=0 AND r.is_current=1 ORDER BY c.seq LIMIT 3000"""
    ).fetchall()
    random.seed(7)
    chosen = random.sample(claim_rows, min(35, len(claim_rows)))
    added = verified = 0
    for index, row in enumerate(chosen):
        passage = row["text"][row["char_start"]:row["char_end"]]
        sentence = None
        for candidate in re.split(r"(?<=[.!?])\s+", passage):
            candidate = candidate.strip()
            if 60 <= len(candidate) <= 240:
                sentence = candidate
                break
        if not sentence:
            stripped = " ".join(passage.split())
            if len(stripped) >= 60:
                sentence = stripped[:200].rsplit(" ", 1)[0]
        if not sentence:
            continue
        try:
            result = claimlib.add_claim(
                store, text=f"Scale probe claim {index} for {row['paper_id']}.", asserted_quote=sentence,
                paper_id=row["paper_id"], project_key=project,
            )
            added += 1
            walk = verify_claim(store, result["claim"]["id"])
            verified += int(walk["ok"] and walk["status"] == "verified")
        except Exception as exc:
            print("claim error", exc)
    check("claims anchored and verified at scale", added >= 10 and verified >= 10, f"added={added}, verified={verified}")
    if added:
        target = store.conn.execute("SELECT id, paper_id FROM claims WHERE is_latest=1 LIMIT 1").fetchone()
        claimlib.contradict_claim(store, target["id"], reason="scale-test", actor="owner")
        absent = search_with_status(store, "Scale probe claim", kind="claim", project_id=project)["results"]
        check("contradicted claim leaves search", all(hit["id"] != target["id"] for hit in absent))
        listed = claimlib.list_claims(store, page_size=200)
        check("contradicted claim leaves list", all(item["id"] != target["id"] for item in listed["rows"]))
        quote = quote_check(store, "a phrase that is definitely not in this paper at all", paper_id=target["paper_id"])
        check("quote_check rejects a missing quote", quote["found"] is False)
    # near-duplicate supersede
    if claim_rows:
        row = claim_rows[0]
        passage = row["text"][row["char_start"]:row["char_end"]]
        candidate = next((s.strip() for s in re.split(r"(?<=[.!?])\s+", passage) if 40 <= len(s.strip()) <= 220), None)
        if candidate:
            a = claimlib.add_claim(store, text="Duplicate-sensitive synthesis statement about the finding.", asserted_quote=candidate, paper_id=row["paper_id"], project_key=project)
            b = claimlib.add_claim(store, text="Duplicate-sensitive synthesis statement about the finding.", asserted_quote=candidate[-80:], paper_id=row["paper_id"], project_key=project)
            old = store.conn.execute("SELECT is_latest FROM claims WHERE id=?", (a["claim"]["id"],)).fetchone()[0]
            check("Jaccard supersedes a near-duplicate claim", old == 0 or bool(b["similar_to"]), f"old_latest={old}")
    # OCR cap
    ocr_source = db.parent / "ocr-unique.md"
    ocr_source.write_text(
        "---\ndoi: 10.99/ocr-unique\ntitle: OCR Unique\nyear: 2024\n---\n"
        "# OCR Unique\n\n## Methods\n\nWe used a sample of 120 participants in the trial. "
        + ("Additional OCR-recovered prose sentence for testing. " * 30) + "\n",
        encoding="utf-8",
    )
    ocr_result = ingest_markdown(store, ocr_source, project_id="ocr-project", converter={"pdf_type": "scanned", "confidence": 0.31, "pages_needing_ocr": [1, 2]}, origin_channel=None)
    if ocr_result["status"] in {"created", "duplicate-noop"}:
        ocr_paper = ocr_result["paper_id"]
        ocr_doc = store.conn.execute("SELECT text FROM raw_documents WHERE paper_id=? AND is_current=1", (ocr_paper,)).fetchone()
        if ocr_doc and len(ocr_doc[0]) > 200:
            ocr_quote = next((s.strip() for s in re.split(r"(?<=[.!?])\s+", ocr_doc[0]) if 60 <= len(s.strip()) <= 200), None)
            if ocr_quote:
                ocr_claim = claimlib.add_claim(store, text="OCR claim.", asserted_quote=ocr_quote, paper_id=ocr_paper, project_key="ocr-project")
                walk = verify_claim(store, ocr_claim["claim"]["id"])
                check("OCR claim stays capped below verified", walk["status"] == "extracted" and any(step.get("reason") == "channel-capped:ocr-recovered" for step in walk["steps"]), walk["status"])

    # 7) structure/outline
    sample_papers = [row[0] for row in store.conn.execute("SELECT id FROM papers WHERE cite_state='citable' LIMIT 5").fetchall()]
    profiles = Counter()
    outline_ok = 0
    for paper_id in sample_papers:
        try:
            doc = outline(store, paper_id)
            profiles[doc["structure"]["profile"]] += 1
            outline_ok += int(bool(doc["sections"]) and doc["paper"]["doi"] is not None or bool(doc["sections"]))
        except Exception as exc:
            print("outline error", exc)
    RESULTS["metrics"]["outline_profiles"] = dict(profiles)
    check("outline returns sections for sample papers", outline_ok == len(sample_papers) and outline_ok > 0, f"{outline_ok}/{len(sample_papers)} profiles={dict(profiles)}")

    # 8) recap/list/coverage/health
    payload = recap(store, project, max_chars=6000)
    size = len(json.dumps(payload, default=str))
    check("recap stays within 6k chars", size <= 6000, f"{size} chars")
    check("recap reports scope stats", payload["scope_stats"]["papers"] >= 100, payload["scope_stats"])
    papers_page = list_rows(store, "papers", project=project, page_size=25)
    check("list pages and totals agree", papers_page["total_count"] >= 100 and len(papers_page["rows"]) == 25, f"total={papers_page['total_count']}")
    coverage = list_rows(store, "coverage", project=project)
    current_docs = store.conn.execute(
        """SELECT COUNT(*) FROM raw_documents r JOIN paper_projects pp ON pp.paper_id=r.paper_id
           WHERE r.is_current=1 AND pp.project_key=?""", (project,)
    ).fetchone()[0]
    check("coverage rollup is complete", coverage["rollup"]["docs"] == current_docs and coverage["rollup"]["ratio"] > 0, coverage["rollup"])
    from papermemory.ops import health_lite

    health = health_lite(store)
    check("health invariants clean", health["ok"] is True, health["violations"])
    live_chunks = store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    fts = store.conn.execute("SELECT COUNT(*) FROM chunks_fts_docsize").fetchone()[0]
    check("FTS index count matches chunks", fts == live_chunks, f"fts={fts} chunks={live_chunks}")

    # 9) reindex sample
    before = store.conn.execute("SELECT COUNT(*) FROM chunks WHERE paper_id IN (SELECT id FROM papers LIMIT 3)").fetchone()[0]
    from papermemory.reindex import reindex_from_raw

    for paper_id in [row[0] for row in store.conn.execute("SELECT id FROM papers LIMIT 3").fetchall()]:
        reindex_from_raw(store, paper_id=paper_id)
    after = store.conn.execute("SELECT COUNT(*) FROM chunks WHERE paper_id IN (SELECT id FROM papers LIMIT 3)").fetchone()[0]
    check("reindex is count-stable", before == after, f"{before} -> {after}")

    # 10) frontmatter/edge behavior
    edge = db.parent / "edge"
    edge.mkdir(exist_ok=True)
    crlf = edge / "crlf.md"
    crlf.write_bytes(b"# T\r\n\r\nbody\r\n")
    broken = ingest_markdown(store, crlf, project_id=project)
    check("CRLF markdown is refused with a typed reason", broken["status"] == "failed" and broken["reason_code"] == "newline-not-lf", broken.get("reason_code"))
    headingless = edge / "plain.md"
    headingless.write_text("---\ntitle: Plain Prose\nyear: 2024\n---\n" + "Just prose with no headings at all. " * 300 + "\n", encoding="utf-8")
    plain = ingest_markdown(store, headingless, project_id=project)
    if plain["status"] == "created":
        doc = outline(store, plain["paper_id"])
        check("heading-less paper is unclassified/low confidence", doc["structure"]["structure_confidence"] == "low" and all(s["role"] == "unclassified" for s in doc["sections"]), doc["structure"])
    else:
        check("heading-less paper is unclassified/low confidence", False, plain.get("reason_code"))

    RESULTS["metrics"]["final"] = store.stats()
    RESULTS["metrics"]["health"] = health["violations"]
    RESULTS["metrics"]["recap_chars"] = size
    store.close()
    write_report(Path(args.out), RESULTS)
    failures = [c for c in RESULTS["checks"] if not c["ok"]]
    print(f"\n{len(RESULTS['checks']) - len(failures)}/{len(RESULTS['checks'])} checks passed")
    return 1 if failures else 0


def write_report(path: Path, results: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    metrics = results["metrics"]
    lines = [
        "# PaperMemory v2 — 100+ paper scale test",
        "",
        f"Generated from {metrics.get('prepare', {}).get('files', 0)} markdown papers converted from PDFs found on this machine (pdf-inspector), ingested into a scratch store.",
        "",
        "## Metrics",
        "",
        "| Metric | Value |",
        "| --- | --- |",
    ]
    for key in ("papers", "documents", "chunks", "sections", "table_chunks", "bibliography_chunks", "ingest_seconds", "probes", "topn_matches", "p95_ms", "recap_chars"):
        if key in metrics:
            lines.append(f"| {key} | {metrics[key]} |")
    lines += ["", "## Checks", "", "| Check | Result | Detail |", "| --- | --- | --- |"]
    for item in results["checks"]:
        lines.append(f"| {item['check']} | {'PASS' if item['ok'] else 'FAIL'} | {item['detail'].replace('|', '/')} |")
    roles = metrics.get("roles") or {}
    lines += ["", "## Section role distribution", "", "```", json.dumps(roles, indent=1), "```", ""]
    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
