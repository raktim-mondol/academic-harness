from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path

import pytest

from papermemory import claims as claimlib
from papermemory.ah_bridge import (
    BridgeError, ah_quote_hash, export_evidence, import_verdicts, register_to_ah,
)
from papermemory.corpus import ingest_markdown
from papermemory.db import Store
from papermemory.search import search

STUB = '''#!/usr/bin/env python3
import hashlib, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(args[args.index("--project") + 1]) if "--project" in args else None
if "source" in args and "add" in args:
    i = args.index("add")
    src = Path(args[i + 1])
    def opt(name):
        return args[args.index(name) + 1] if name in args else None
    sid = opt("--id"); keys = opt("--keys")
    dest = root / "sources" / "files" / f"{sid}.txt"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(src.read_bytes())
    reg = root / "sources" / "registry.yaml"
    reg.parent.mkdir(parents=True, exist_ok=True)
    text = reg.read_text() if reg.exists() else "sources:\\n"
    if not text.endswith("\\n"):
        text += "\\n"
    text += f"- id: {sid}\\n  file: sources/files/{sid}.txt\\n  sha256: {hashlib.sha256(dest.read_bytes()).hexdigest()}\\n"
    if keys:
        text += f"  keys: [{keys}]\\n"
    reg.write_text(text)
    print(json.dumps({"id": sid}) if False else '{"id": "%s"}' % sid)
    sys.exit(0)
sys.exit(2)
'''


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _setup(tmp_path, monkeypatch, count=3):
    store = _store(tmp_path)
    ah_root = tmp_path / "ah"
    (ah_root / "sources").mkdir(parents=True)
    (ah_root / "ah.yaml").write_text("project: {}\n", encoding="utf-8")
    stub = tmp_path / "ah-stub"
    stub.write_text(STUB, encoding="utf-8")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("AH_CMD", str(stub))
    monkeypatch.setenv("PAPERMEMORY_EVIDENCE_DIR", str(tmp_path / "evidence"))
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "pm.db"))
    papers = []
    for index in range(count):
        body = (
            f"# Paper {index}\n\n## Methods\n\nCommon sentence for evidence {index}.\n"
            f"\n## Results\n\nWe used a sample of 120 participants in trial {index}.\n"
        )
        path = tmp_path / f"p{index}.md"
        path.write_text(
            f'---\ndoi: 10.7/{index}\ntitle: Bridge {index}\nyear: 2024\nbibtex_key: key{index}\n---\n' + body,
            encoding="utf-8",
        )
        papers.append(ingest_markdown(store, path, project_id="p5"))
    return store, ah_root, papers


def _registry_ids(ah_root: Path) -> dict[str, str]:
    text = (ah_root / "sources" / "registry.yaml").read_text(encoding="utf-8")
    ids = {}
    for line in text.splitlines():
        if line.strip().startswith("- id:"):
            sid = line.split(":", 1)[1].strip()
            ids[sid] = text
    return ids


def test_register_20_papers_byte_identical(tmp_path, monkeypatch):
    store, ah_root, papers = _setup(tmp_path, monkeypatch, count=20)
    result = register_to_ah(store, project="p5", all_citable=True, ah_root=ah_root)
    assert result["registered"] == 20 and result["failed"] == 0
    ids = _registry_ids(ah_root)
    for paper in papers:
        assert paper["paper_id"] in ids
        doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (paper["doc_id"],)).fetchone()
        copy = ah_root / "sources" / "files" / f"{paper['paper_id']}.txt"
        assert copy.read_bytes() == Path(doc["corpus_path"]).read_bytes()
        assert hashlib.sha256(copy.read_bytes()).hexdigest() == doc["sha256"]
    assert all(item["handoff_state"] == "byte-identical" for item in result["results"])
    again = register_to_ah(store, project="p5", all_citable=True, ah_root=ah_root)
    assert again["already_registered"] == 20 and again["registered"] == 0


def test_shared_bibtex_key_registers_two_sources(tmp_path, monkeypatch):
    store = _store(tmp_path)
    ah_root = tmp_path / "ah"
    (ah_root / "sources").mkdir(parents=True)
    (ah_root / "ah.yaml").write_text("project: {}\n", encoding="utf-8")
    stub = tmp_path / "ah-stub"
    stub.write_text(STUB, encoding="utf-8")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("AH_CMD", str(stub))
    papers = []
    for index in range(2):
        path = tmp_path / f"s{index}.md"
        path.write_text(
            f'---\ndoi: 10.8/{index}\ntitle: Shared {index}\nyear: 2024\nbibtex_key: sharedkey\n---\n'
            f'# Shared {index}\n\n## Methods\n\nUnique body {index}.\n',
            encoding="utf-8",
        )
        papers.append(ingest_markdown(store, path, project_id="p5"))
    one = register_to_ah(store, paper=papers[0]["paper_id"], ah_root=ah_root)
    two = register_to_ah(store, paper=papers[1]["paper_id"], ah_root=ah_root)
    assert one["registered"] == 1 and two["registered"] == 1
    ids = _registry_ids(ah_root)
    assert set(ids) == {papers[0]["paper_id"], papers[1]["paper_id"]}
    assert (ah_root / "sources" / "files" / f"{papers[0]['paper_id']}.txt").exists()
    assert (ah_root / "sources" / "files" / f"{papers[1]['paper_id']}.txt").exists()


def test_refuses_legacy_no_raw_file(tmp_path, monkeypatch):
    store = _store(tmp_path)
    ah_root = tmp_path / "ah"
    (ah_root / "sources").mkdir(parents=True)
    (ah_root / "ah.yaml").write_text("project: {}\n", encoding="utf-8")
    stub = tmp_path / "ah-stub"
    stub.write_text(STUB, encoding="utf-8")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("AH_CMD", str(stub))
    paper_id, _ = store.upsert_paper_v2("doi", "10.7/legacy", "Legacy", "caller", fields={"doi": "10.7/legacy"}, metadata_only=True)
    result = register_to_ah(store, paper=paper_id, ah_root=ah_root)
    assert result["refused"] == 1
    assert result["results"][0]["reason"] == "no-raw-file"
    with pytest.raises(BridgeError) as exc:
        register_to_ah(store, paper=paper_id, ah_root=tmp_path / "missing")
    assert exc.value.code.startswith("ah-root-invalid")


def test_quote_hash_boundaries_and_whitespace():
    assert ah_quote_hash("alpha  beta") == ah_quote_hash("alpha beta")
    base = "x" * 599
    assert ah_quote_hash(base) != ah_quote_hash(base + "x")
    assert ah_quote_hash("x" * 600) == ah_quote_hash("x" * 601)
    assert ah_quote_hash("x" * 600) == ah_quote_hash("x" * 5000)
    assert len(ah_quote_hash("anything")) == 10


def _verdict_row(store, claim, verdict, *, raw_sha=None, ledger="L1"):
    doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (claim["doc_id"],)).fetchone()
    return {
        "schema": "pm-verdict-1",
        "claim_id": claim["id"],
        "doc_id": claim["doc_id"],
        "raw_sha256": raw_sha if raw_sha is not None else doc["sha256"],
        "char_start": claim["quote_char_start"],
        "char_end": claim["quote_char_end"],
        "quote_hash": "qh",
        "verdict": verdict,
        "prompt_version": "evp-1",
        "ledger_sha256": ledger,
    }


def test_verdict_import_mapping_and_stale(tmp_path, monkeypatch):
    store, ah_root, papers = _setup(tmp_path, monkeypatch, count=1)
    paper = papers[0]
    first = claimlib.add_claim(store, text="Trial sample size.", asserted_quote="We used a sample of 120 participants", paper_id=paper["paper_id"])
    second = claimlib.add_claim(store, text="Evidence sentence.", asserted_quote="Common sentence for evidence 0.", paper_id=paper["paper_id"])
    ledger = tmp_path / "verdicts.jsonl"
    rows = [
        _verdict_row(store, first["claim"], "NOT_SUPPORTED"),
        _verdict_row(store, second["claim"], "SUPPORTED"),
        _verdict_row(store, second["claim"], "SUPPORTED", raw_sha="0" * 64, ledger="L2"),
    ]
    ledger.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
    result = import_verdicts(store, ledger)
    assert result["imported"] == 2 and result["stale"] == 1 and result["contradicted"] == 1
    first_row = store.conn.execute("SELECT status, status_reason FROM claims WHERE id=?", (first["claim"]["id"],)).fetchone()
    assert first_row["status"] == "contradicted" and first_row["status_reason"] == "ah:NOT_SUPPORTED"
    second_row = store.conn.execute("SELECT status FROM claims WHERE id=?", (second["claim"]["id"],)).fetchone()
    assert second_row["status"] == "extracted"
    assert store.conn.execute("SELECT COUNT(*) FROM ah_verdicts").fetchone()[0] == 2
    assert search(store, "120 participants", kind="claim") == []
    listed = claimlib.list_claims(store, page_size=10)
    assert all(row["status"] != "contradicted" for row in listed["rows"])
    history = store.conn.execute("SELECT COUNT(*) FROM claims_history WHERE event='status_change'").fetchone()[0]
    assert history >= 2
    store.close()


def test_evidence_export_and_reverse_walk(tmp_path, monkeypatch):
    store, ah_root, papers = _setup(tmp_path, monkeypatch, count=1)
    paper = papers[0]
    claim = claimlib.add_claim(store, text="Sample size.", asserted_quote="We used a sample of 120 participants", paper_id=paper["paper_id"])["claim"]
    out = tmp_path / "evidence.jsonl"
    exported = export_evidence(store, out, project="p5")
    assert exported["rows"] == 1 and exported["papers"] == 1
    row = json.loads(out.read_text().splitlines()[0])
    assert row["claim_id"] == claim["id"]
    assert row["quote_sha256"] == claim["quote_sha256"]
    assert row["quote_hash"] == ah_quote_hash("We used a sample of 120 participants")
    assert row["ah_file"] == f"sources/files/{paper['paper_id']}.txt"
    from papermemory import mcp_server

    ms = store.upsert_manuscript({"title": "MS", "slug": "ms-x"})
    store.conn.execute(
        "INSERT INTO citations(id, manuscript_id, bibtex_key, paper_id, tex_file, tex_line, sentence_hash, scanned_at) "
        "VALUES ('cit_x',?,'key0',?, 'sections/results.tex', 42, '', '2026')",
        (ms["id"], paper["paper_id"]),
    )
    store.conn.commit()
    result = mcp_server._call("papermemory_trace", {"paper": paper["paper_id"]})
    payload = json.loads(result["content"][0]["text"])
    assert payload["citations"] == [{"tex_file": "sections/results.tex", "tex_line": 42, "bibtex_key": "key0"}]
    store.close()
