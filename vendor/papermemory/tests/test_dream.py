from __future__ import annotations

import json

from papermemory.cli import main as cli_main
from papermemory.context import recap
from papermemory.corpus import ingest_markdown
from papermemory.db import Store
from papermemory.dream import dream, restore
from papermemory.ingest import ingest_manuscript
from papermemory.search_v2 import search_with_status
from papermemory.util import new_id, now_iso

LONG = ("We decided that the related work section is organised by method family rather than by year, "
        "because reviewers of the earlier submission found the chronological ordering hid which approaches "
        "actually compete with ours on the coal spoil benchmark.")


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _status(store, table, row_id):
    return dict(store.conn.execute(f"SELECT status, superseded_by FROM {table} WHERE id=?", (row_id,)).fetchone())


def _legacy(store, paper_id, text, quote):
    lid = new_id("lgc")
    store.conn.execute(
        "INSERT INTO legacy_claims(id, paper_id, claim_text, claim_type, evidence_quote, status, created_at, updated_at) "
        "VALUES (?,?,?,?,?,'extracted',?,?)",
        (lid, paper_id, text, "finding", quote, now_iso(), now_iso()),
    )
    store.conn.commit()
    return lid


def test_dedupe_is_a_dry_run_until_applied_and_keeps_the_newest(tmp_path):
    store = _store(tmp_path)
    a = store.remember(LONG, project_id="p", tier="episodic")
    b = store.remember(LONG + "  ", project_id="p", tier="episodic")  # whitespace-only difference
    c = store.remember(LONG.replace("organised", "arranged"), project_id="p", tier="episodic")  # near duplicate
    other = store.remember("Use British spelling throughout.", project_id="p", tier="episodic")
    elsewhere = store.remember(LONG, project_id="q", tier="episodic")  # same text, another project

    preview = dream(store, "p")
    assert preview["applied"] is False
    assert preview["summary"]["duplicates"] == 2
    assert _status(store, "observations", a["id"])["status"] == "active"  # nothing changed

    dream(store, "p", apply=True)
    states = {k: _status(store, "observations", v["id"]) for k, v in dict(a=a, b=b, c=c, other=other, elsewhere=elsewhere).items()}
    survivors = [k for k, v in states.items() if v["status"] == "active" and k in ("a", "b", "c")]
    assert len(survivors) == 1
    assert states["other"]["status"] == "active"
    assert states["elsewhere"]["status"] == "active"  # never merged across projects
    superseded = [v for k, v in states.items() if k in ("a", "b", "c") and v["status"] == "superseded"]
    assert len(superseded) == 2 and all(v["superseded_by"] for v in superseded)
    # nothing was deleted
    assert store.conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0] == 5
    # and it left an audit trail
    assert store.conn.execute("SELECT COUNT(*) FROM events WHERE op='SWEEP' AND reason_code='note-duplicate'").fetchone()[0] == 2


def test_dedupe_applies_to_lessons_and_a_second_run_changes_nothing(tmp_path):
    store = _store(tmp_path)
    store.add_lesson("Never cite a paper that is not in memory.", project_id="p")
    store.add_lesson("never   cite a paper that is not in memory.", project_id="p")
    dream(store, "p", apply=True)
    active = store.conn.execute("SELECT COUNT(*) FROM lessons WHERE status='active' AND superseded_by IS NULL").fetchone()[0]
    assert active == 1
    again = dream(store, "p", apply=True)
    assert again["summary"]["duplicates"] == 0


def test_different_tiers_are_not_merged(tmp_path):
    store = _store(tmp_path)
    store.remember(LONG, project_id="p", tier="episodic")
    store.remember(LONG, project_id="p", tier="semantic")
    assert dream(store, "p")["summary"]["duplicates"] == 0


def test_reingesting_a_manuscript_does_not_stack_notes(tmp_path):
    root = tmp_path / "ms"
    root.mkdir()
    (root / "Journal_Paper_Outline.md").write_text("# Outline\n\nContribution one.\n", encoding="utf-8")
    store = _store(tmp_path)
    ingest_manuscript(store, root, slug="ms")
    ingest_manuscript(store, root, slug="ms")
    ingest_manuscript(store, root, slug="ms")
    live = store.conn.execute(
        "SELECT COUNT(*) FROM observations WHERE tier='episodic' AND superseded_by IS NULL AND status='active'"
    ).fetchone()[0]
    assert live == 1
    assert store.conn.execute("SELECT COUNT(*) FROM observations").fetchone()[0] == 3  # history kept


def test_a_note_derived_from_files_goes_stale_when_the_files_change(tmp_path):
    root = tmp_path / "ms"
    root.mkdir()
    outline = root / "Journal_Paper_Outline.md"
    outline.write_text("# Outline\n\nContribution one.\n", encoding="utf-8")
    store = _store(tmp_path)
    ingest_manuscript(store, root, slug="ms")
    assert dream(store, "ms")["summary"]["stale"] == 0

    outline.write_text("# Outline\n\nContribution one, rewritten.\n", encoding="utf-8")
    report = dream(store, "ms", apply=True)
    assert [s["reason"] for s in report["stale"]] == ["source-files-changed"]

    result = recap(store, "ms")
    assert not [o for o in result["observations"] if o["content"].startswith("Manuscript ms notes")]
    assert result["stale_notes_hidden"] == 1


def test_a_note_is_not_called_stale_when_its_root_is_not_on_this_machine(tmp_path):
    root = tmp_path / "ms"
    root.mkdir()
    (root / "Journal_Paper_Outline.md").write_text("# Outline\n", encoding="utf-8")
    store = _store(tmp_path)
    ingest_manuscript(store, root, slug="ms")
    (root / "Journal_Paper_Outline.md").unlink()
    root.rmdir()
    assert dream(store, "ms")["summary"]["stale"] == 0  # unknown is not stale


def test_legacy_claims_wait_for_markdown_then_come_back_only_if_the_quote_is_verbatim(tmp_path):
    store = _store(tmp_path)
    paper = store.upsert_paper({"title": "Metadata only", "doi": "10.1/legacy", "year": 2023})
    good = _legacy(store, paper["id"], "Sample was 120.", "We used a sample of 120 participants")
    bad = _legacy(store, paper["id"], "Invented.", "This sentence is not in the paper at all")

    waiting = dream(store)
    assert waiting["summary"]["claims_awaiting_markdown"] == 2
    assert waiting["recover"]["awaiting_markdown"][0]["paper_id"] == paper["id"]
    assert store.conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0] == 0

    md = tmp_path / "legacy.md"
    md.write_text("---\ndoi: 10.1/legacy\ntitle: Metadata only\nyear: 2023\n---\n# T\n\n## Methods\n\nWe used a sample of 120 participants.\n",
                  encoding="utf-8")
    ingest_markdown(store, md)

    preview = dream(store)
    assert preview["summary"]["recoverable_claims"] == 1
    assert store.conn.execute("SELECT COUNT(*) FROM claims").fetchone()[0] == 0  # dry run wrote nothing

    done = dream(store, apply=True)
    assert len(done["recover"]["recovered"]) == 1
    claim = store.conn.execute("SELECT claim_text, status FROM claims").fetchone()
    assert claim["claim_text"] == "Sample was 120." and claim["status"] == "extracted"  # still not 'verified'
    legacy = {r["id"]: r["status"] for r in store.conn.execute("SELECT id, status FROM legacy_claims")}
    assert legacy[good] == "recovered"
    assert legacy[bad] == "unrecoverable:quote-not-verbatim"
    assert dream(store, apply=True)["summary"]["recoverable_claims"] == 0  # idempotent


def test_recap_keeps_a_durable_note_that_recent_noise_would_bury(tmp_path):
    store = _store(tmp_path)
    old = store.remember("Terminology: always say 'coal spoil', never 'waste rock'.", project_id="p", tier="episodic")
    store.conn.execute("UPDATE observations SET created_at='2020-01-01T00:00:00+00:00', access_count=9 WHERE id=?", (old["id"],))
    store.conn.commit()
    for i in range(12):
        store.remember(f"scratch note number {i}", project_id="p", tier="episodic")
    notes = recap(store, limit=4)["observations"]
    assert old["id"] in [n["id"] for n in notes]
    assert {n["why"] for n in notes} == {"salient", "recent"}
    assert len(notes) == 4


def test_search_counts_lookups_and_skips_stale_notes(tmp_path):
    store = _store(tmp_path)
    store.ensure_project("p")
    live = store.remember("Reviewers asked for a limitations paragraph about calibration drift.", project_id="p")
    gone = store.remember("Calibration drift paragraph was already removed.", project_id="p")
    store.conn.execute("UPDATE observations SET status='stale' WHERE id=?", (gone["id"],))
    store.conn.commit()
    result = search_with_status(store, "calibration drift", kind="observation", project_id="p")
    ids = [r["id"] for r in result["results"]]
    assert ids == [live["id"]]
    count = store.conn.execute("SELECT access_count FROM observations WHERE id=?", (live["id"],)).fetchone()[0]
    assert count == 1
    assert store.conn.execute("SELECT access_count FROM observations WHERE id=?", (gone["id"],)).fetchone()[0] == 0


def test_cli_dream_reports_then_applies(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "cli.db"))
    store = Store(tmp_path / "cli.db")
    store.remember(LONG, project_id="p", tier="episodic")
    store.remember(LONG, project_id="p", tier="episodic")
    store.conn.close()
    assert cli_main(["dream", "--project", "p", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["summary"]["duplicates"] == 1
    assert cli_main(["dream", "--project", "p", "--apply", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["applied"] is True
    assert cli_main(["dream", "--project", "p", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["summary"]["duplicates"] == 0


def test_restore_undoes_dream_and_later_passes_leave_the_note_alone(tmp_path):
    store = _store(tmp_path)
    old = store.remember(LONG, project_id="p", tier="episodic")
    new = store.remember(LONG, project_id="p", tier="episodic")
    dream(store, "p", apply=True)
    # same-second timestamps: the later insert is the keeper
    assert _status(store, "observations", new["id"])["status"] == "active"
    assert _status(store, "observations", old["id"])["status"] == "superseded"

    assert restore(store, old["id"])["restored"] is True
    assert _status(store, "observations", old["id"]) == {"status": "active", "superseded_by": None}
    assert dream(store, "p", apply=True)["summary"]["duplicates"] == 0  # sticky
    assert _status(store, "observations", old["id"])["status"] == "active"
    assert restore(store, old["id"]) == {"restored": False, "id": old["id"], "reason": "already-active"}
    assert restore(store, "obs_nope")["reason"] == "not-found"


def test_a_legacy_claim_with_a_dangling_manuscript_does_not_abort_the_pass(tmp_path):
    store = _store(tmp_path)
    paper = store.upsert_paper({"title": "P", "doi": "10.1/dang", "year": 2022})
    md = tmp_path / "d.md"
    md.write_text("---\ndoi: 10.1/dang\ntitle: P\nyear: 2022\n---\n# T\n\n## Methods\n\nWe used a sample of 120 participants.\n", encoding="utf-8")
    ingest_markdown(store, md)
    lid = _legacy(store, paper["id"], "Sample was 120.", "We used a sample of 120 participants")
    store.conn.execute("UPDATE legacy_claims SET manuscript_id='ms_gone' WHERE id=?", (lid,))
    store.conn.commit()
    report = dream(store, apply=True)  # must not raise
    assert report["recover"]["recovered"] == [] or report["recover"]["rejected"] == []
    status = store.conn.execute("SELECT status FROM legacy_claims WHERE id=?", (lid,)).fetchone()[0]
    assert status in ("recovered", "extracted")  # recovered, or left pending for a retry; never poisoned
