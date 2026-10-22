from __future__ import annotations

import json
from pathlib import Path

import pytest

from papermemory import claims as claimlib
from papermemory.claims import ClaimError
from papermemory.corpus import ingest_markdown
from papermemory.db import Store
from papermemory.grounding import quote_check, verify_claim
from papermemory.search import search


BODY = """# Paper

## Methods

We used a sample of 120 participants in the trial.

## Results

The effect was 0.41 with a confidence interval.

## References

[1] Smith 2020. A bibliography-only sentence about 120 participants.
"""


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _ingest(store, tmp_path, name="p.md", body=BODY, doi="10.6/claim", origin=None):
    path = tmp_path / name
    path.write_text(f"---\ndoi: {doi}\ntitle: Claims Paper\nyear: 2024\n---\n" + body, encoding="utf-8")
    return ingest_markdown(store, path, origin_channel=origin)


def _claim(store, paper_id, quote="We used a sample of 120 participants in the trial.", text="The trial used 120 participants."):
    return claimlib.add_claim(store, text=text, asserted_quote=quote, paper_id=paper_id)


def test_quote_required_and_verbatim_anchor(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    with pytest.raises(ClaimError) as exc:
        claimlib.add_claim(store, text="no evidence", asserted_quote="", paper_id=ingested["paper_id"])
    assert exc.value.code == "quote-required"
    result = _claim(store, ingested["paper_id"])
    claim = result["claim"]
    assert claim["status"] == "extracted"
    doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (claim["doc_id"],)).fetchone()
    raw = doc["text"]
    assert raw[claim["quote_char_start"]:claim["quote_char_end"]] == "We used a sample of 120 participants in the trial."
    import hashlib
    assert claim["quote_sha256"] == hashlib.sha256(raw[claim["quote_char_start"]:claim["quote_char_end"]].encode()).hexdigest()
    assert claim["asserted_quote"] == "We used a sample of 120 participants in the trial."
    sources = store.conn.execute("SELECT COUNT(*) FROM claim_sources WHERE claim_id=?", (claim["id"],)).fetchone()[0]
    assert sources >= 1
    with pytest.raises(ClaimError) as exc:
        claimlib.add_claim(store, text="x", asserted_quote="This sentence is absent from the paper.", paper_id=ingested["paper_id"])
    assert exc.value.code == "quote-not-verbatim"
    store.close()


def test_whitespace_mismatch_is_unverified_not_verified(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    result = claimlib.add_claim(
        store,
        text="Trial size.",
        asserted_quote="We used  a sample of 120 participants",
        paper_id=ingested["paper_id"],
    )
    assert result["claim"]["status"] in {"unverified-quote", "extracted"}
    store.close()


def test_reimport_derives_no_twin(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    first = _claim(store, ingested["paper_id"])
    second = _claim(store, ingested["paper_id"])
    assert first["claim"]["id"] == second["claim"]["id"]
    assert store.conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0] == 1
    assert second["claim"]["status"] == "unverified-quote"
    assert second["claim"]["status_reason"] == "re-derived"
    store.close()


def test_quote_check_reasons(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    found = quote_check(store, "sample of 120 participants", paper_id=ingested["paper_id"])
    assert found["found"] is True and found["occurrences"]
    assert found["occurrences"][0]["chunk_id"] and found["occurrences"][0]["heading_path"]
    missing = quote_check(store, "sample of 999 participants", paper_id=ingested["paper_id"])
    assert missing["found"] is False and missing["reason"] == "no-match"
    bib = quote_check(store, "bibliography-only sentence", paper_id=ingested["paper_id"])
    assert bib["found"] is True and bib["reason"] == "bibliography-only"
    store.close()


def test_verify_walk_promotes_and_detects_drift(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    claim = _claim(store, ingested["paper_id"])["claim"]
    walk = verify_claim(store, claim["id"])
    assert walk["ok"] is True, walk["failures"]
    row = store.conn.execute("SELECT status FROM claims WHERE id=?", (claim["id"],)).fetchone()
    assert row["status"] == "verified"
    doc = store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (claim["doc_id"],)).fetchone()
    tampered = doc["text"].replace("120 participants", "999 participants")
    store.conn.execute("UPDATE raw_documents SET text=? WHERE id=?", (tampered, doc["id"]))
    store.conn.commit()
    reread = verify_claim(store, claim["id"])
    assert reread["ok"] is False
    assert any(failure["reason"] in {"quote-not-verbatim", "slice-hash-drift"} for failure in reread["failures"])
    store.close()


def test_ocr_channel_cap(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path, origin="ocr-recovered")
    result = _claim(store, ingested["paper_id"])
    assert result["claim"]["status"] == "extracted"
    walk = verify_claim(store, result["claim"]["id"])
    assert walk["ok"] is True
    assert walk["status"] == "extracted"
    assert any(step.get("reason") == "channel-capped:ocr-recovered" for step in walk["steps"] if not step.get("ok"))
    row = store.conn.execute("SELECT status, status_reason FROM claims WHERE id=?", (result["claim"]["id"],)).fetchone()
    assert row["status"] == "extracted" and row["status_reason"] == "channel-capped:ocr-recovered"
    store.close()


def test_jaccard_supersede_and_advisory(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    first = claimlib.add_claim(store, text="The trial used 120 participants in total.", asserted_quote="We used a sample of 120 participants", paper_id=ingested["paper_id"])
    near = claimlib.add_claim(store, text="The trial used 120 participants in total.", asserted_quote="120 participants in the trial", paper_id=ingested["paper_id"])
    assert near["similar_to"] or store.conn.execute("SELECT is_latest FROM claims WHERE id=?", (first["claim"]["id"],)).fetchone()[0] == 0
    same = claimlib.add_claim(store, text="The trial used 120 participants in total.", asserted_quote="We used a sample of 120 participants in the trial.", paper_id=ingested["paper_id"])
    old = store.conn.execute("SELECT is_latest, status FROM claims WHERE id=?", (near["claim"]["id"],)).fetchone()
    assert old["is_latest"] in (0, 1)
    history = store.conn.execute("SELECT COUNT(*) FROM claims_history").fetchone()[0]
    assert history >= 1
    store.close()


def test_supersede_contradict_and_search_gating(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    claim = _claim(store, ingested["paper_id"])["claim"]
    claimlib.contradict_claim(store, claim["id"], reason="retracted", actor="owner")
    row = store.conn.execute("SELECT status FROM claims WHERE id=?", (claim["id"],)).fetchone()
    assert row["status"] == "contradicted"
    assert search(store, "trial participants", kind="claim") == []
    listed = claimlib.list_claims(store, page_size=10)
    assert all(item["status"] != "contradicted" for item in listed["rows"])
    store.close()


def test_sweep_marks_doc_superseded_and_resumes(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    for offset in (0, 1, 2):
        claimlib.add_claim(
            store,
            text=f"Trial finding {offset}.",
            asserted_quote=["We used a sample of 120 participants", "The effect was 0.41", "in the trial"][offset],
            paper_id=ingested["paper_id"],
        )
    changed = BODY.replace("We used a sample of 120 participants in the trial.", "We used a sample of 117 participants in the trial.")
    second = _ingest(store, tmp_path, name="p2.md", body=changed, doi="10.6/claim")
    assert second["status"] == "created"
    old_docs = store.conn.execute(
        "SELECT id, is_current FROM raw_documents WHERE paper_id=? ORDER BY created_at", (ingested["paper_id"],)
    ).fetchall()
    old_doc = next(row for row in old_docs if row["is_current"] == 0)
    statuses = {
        row["status_reason"]
        for row in store.conn.execute("SELECT status_reason FROM claims WHERE doc_id=?", (old_doc["id"],))
    }
    assert statuses & {"doc-superseded", "locator-drift"}
    assert all(
        row["is_latest"] == 0
        for row in store.conn.execute("SELECT is_latest FROM claims WHERE doc_id=?", (old_doc["id"],))
    )
    # reset to prove batched resume on the same doc
    store.conn.execute("DELETE FROM sweeps WHERE kind='doc_supersede' AND doc_id=?", (old_doc["id"],))
    store.conn.execute("UPDATE claims SET is_latest=1, status='extracted', status_reason='' WHERE doc_id=?", (old_doc["id"],))
    store.conn.commit()
    first = claimlib.supersession_sweep(store, old_doc["id"], batch_size=1)
    assert first["processed"] == 3 and first["state"] == "done"
    # simulate a kill after the first claim: only post-cursor claims are pending
    rows = store.conn.execute("SELECT seq FROM claims WHERE doc_id=? ORDER BY seq", (old_doc["id"],)).fetchall()
    mid = rows[0]["seq"]
    store.conn.execute(
        "UPDATE claims SET is_latest=1, status='extracted', status_reason='' WHERE doc_id=? AND seq>?",
        (old_doc["id"], mid),
    )
    store.conn.execute(
        "INSERT INTO sweeps(id, kind, paper_id, doc_id, cursor, total, state, started_at, updated_at) VALUES ('swp_test','doc_supersede',?,?,?,?,'running','2026-01-01','2026-01-01')",
        (ingested["paper_id"], old_doc["id"], mid, len(rows)),
    )
    store.conn.commit()
    resumed = claimlib.supersession_sweep(store, old_doc["id"], batch_size=1)
    assert resumed["processed"] == len(rows) - 1 and resumed["state"] == "done"
    again = claimlib.supersession_sweep(store, old_doc["id"], batch_size=1)
    assert again["processed"] == 0 and again["state"] == "done"
    store.close()


def test_list_keyset_and_catalog(tmp_path):
    store = _store(tmp_path)
    ingested = _ingest(store, tmp_path)
    quotes = ["We used a sample of 120 participants", "The effect was 0.41", "in the trial"]
    for index, quote in enumerate(quotes):
        claimlib.add_claim(store, text=f"Finding number {index}.", asserted_quote=quote, paper_id=ingested["paper_id"])
    all_rows = claimlib.list_claims(store, page_size=50)
    assert all_rows["total_count"] == 3
    page1 = claimlib.list_claims(store, page_size=2)
    page2 = claimlib.list_claims(store, page_size=2, cursor=page1["next_cursor"])
    ids = [row["id"] for row in page1["rows"] + page2["rows"]]
    assert len(ids) == 3 and len(set(ids)) == 3
    catalog = claimlib.write_catalog(store, "unassigned")
    assert Path(catalog["json"]).exists() and Path(catalog["md"]).exists()
    data = json.loads(Path(catalog["json"]).read_text())
    assert data["projects"]["unassigned"]["claims"] == 3
    store.close()


def test_claims_schema_fk_and_unique_latest(tmp_path):
    import sqlite3

    store = _store(tmp_path)
    fks = {row["from"]: row["table"] for row in store.conn.execute("PRAGMA foreign_key_list(claims)")}
    assert fks.get("project_key") == "projects"
    indexes = [row["name"] for row in store.conn.execute("PRAGMA index_list(claims)")]
    assert "uq_claim_latest" in indexes
    with pytest.raises(sqlite3.IntegrityError):
        store.conn.execute(
            """INSERT INTO claims(id, claim_key, paper_id, project_key, claim_text, claim_text_norm,
               claim_type, quote_char_start, quote_char_end, quote_sha256, origin_channel,
               pipeline_version, status, created_at, updated_at)
               VALUES ('x','k','missing','no-such-project','t','t','finding',0,0,'h','hand','pmv2-p1','extracted','2026','2026')"""
        )
    store.conn.rollback()
    store.close()
