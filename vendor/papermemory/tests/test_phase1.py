from __future__ import annotations

import hashlib
import json
import sqlite3

import pytest

from papermemory.db import IdentityConflict, MigrationRequired, Store
from papermemory.corpus import ingest_markdown
from papermemory.markdown_contract import Refusal, parse_frontmatter, resolve_identity
from papermemory.ops import doctor_schema, migrate


def _store(tmp_path) -> Store:
    return Store(tmp_path / "pm.db")


def _md(tmp_path, name: str, body: str, fm: str = "") -> object:
    path = tmp_path / name
    path.write_text((fm + "\n" if fm else "") + body, encoding="utf-8")
    return path


def test_fresh_store_is_v2(tmp_path):
    store = _store(tmp_path)
    assert store.conn.execute("PRAGMA user_version").fetchone()[0] == 2000
    columns = {row["name"] for row in store.conn.execute("PRAGMA table_info(chunks)")}
    assert "text" not in columns
    assert {"byte_start", "byte_end", "slice_sha256", "source_sha256"} <= columns
    tables = {
        row["name"]
        for row in store.conn.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
        )
    }
    assert {
        "projects", "papers", "paper_aliases", "paper_projects", "raw_documents",
        "sections", "chunks", "claims", "claim_sources", "claims_history",
        "extractions", "coverage", "sweeps", "citations", "events",
    } <= tables
    assert store.conn.execute("PRAGMA foreign_key_check").fetchall() == []
    store.close()


def test_frontmatter_grammar_and_refusals():
    fm, body = parse_frontmatter('---\ndoi: 10.1000/ABC\ntitle: "A title"\nyear: 2024\nauthors: [Ada Lovelace, Grace Hopper]\n---\n# Heading\n')
    assert fm["doi"] == "10.1000/ABC"
    assert fm["authors"] == ["Ada Lovelace", "Grace Hopper"]
    assert body.startswith("# Heading")
    for text, code in [
        ("---\ndoi: x\n", "frontmatter-unclosed"),
        ("\n---\ndoi: x\n---\n", "frontmatter-not-at-byte-0"),
        ("---\nauthors:\n  x: y\n---\nbody", "frontmatter-nested-value"),
        ("---\nunknown: value\n---\nbody", "frontmatter-unknown-field"),
        ("---\nyear: not-a-year\n---\nbody", "frontmatter-type"),
    ]:
        with pytest.raises(Refusal) as exc:
            parse_frontmatter(text)
        assert exc.value.code == code, text


def test_identity_precedence_and_no_stem():
    doi = resolve_identity({"doi": "https://doi.org/10.1000/ABC"}, body_text="")
    assert (doi.kind, doi.value) == ("doi", "10.1000/abc")
    arxiv = resolve_identity({"arxiv_id": "2401.12345v2"}, body_text="")
    assert (arxiv.kind, arxiv.value) == ("arxiv_id", "2401.12345")
    pmid = resolve_identity({"pmid": "12345"}, body_text="")
    assert (pmid.kind, pmid.value) == ("pmid", "12345")
    title = resolve_identity({"title": "A Study", "year": 2020}, body_text="")
    assert title.kind == "title_year" and title.value.startswith("a study|2020")
    fallback = resolve_identity({}, body_text="# My Paper\n\nIntro mentions 10.5555/x early.\n\n## Methods\n10.9999/never\n")
    assert (fallback.kind, fallback.value) == ("doi", "10.5555/x")
    with pytest.raises(Refusal) as exc:
        resolve_identity({}, body_text="no heading, no doi\n")
    assert exc.value.code == "identity-unresolved"


FULLTEXT = "# A Study of Things\n\n## Abstract\n\nWe report an effect.\n\n## Methods\n\nWe used a sample of 120 participants.\n\n## Results\n| M | Acc |\n| --- | --- |\n| A | 0.91 |\n"


def test_ingest_markdown_creates_raw_and_byte_slices(tmp_path):
    store = _store(tmp_path)
    path = _md(tmp_path, "paper.md", FULLTEXT, "---\ndoi: 10.1000/study\ntitle: A Study of Things\nyear: 2023\n---")
    first = ingest_markdown(store, path, project_id="proj")
    assert first["status"] == "created"
    paper_id = first["paper_id"]
    doc = store.conn.execute("SELECT * FROM raw_documents WHERE paper_id=?", (paper_id,)).fetchone()
    assert doc["sha256"] == hashlib.sha256((path.read_bytes())).hexdigest()
    text = doc["text"]
    assert doc["corpus_path"].endswith(".md")
    from pathlib import Path

    corpus_file = Path(doc["corpus_path"])
    assert corpus_file.exists() and corpus_file.read_bytes() == path.read_bytes()
    chunks = store.conn.execute("SELECT * FROM chunks WHERE paper_id=? ORDER BY chunk_index", (paper_id,)).fetchall()
    assert chunks
    for chunk in chunks:
        raw = doc["text"].encode("utf-8")
        assert hashlib.sha256(raw[chunk["byte_start"]:chunk["byte_end"]]).hexdigest() == chunk["slice_sha256"]
        assert text[chunk["char_start"]:chunk["char_end"]].encode("utf-8") == raw[chunk["byte_start"]:chunk["byte_end"]]
    assert store.conn.execute("SELECT COUNT(*) FROM coverage WHERE doc_id=?", (doc["id"],)).fetchone()[0] == 1

    again = ingest_markdown(store, path, project_id="proj")
    assert again["status"] == "duplicate-noop"
    assert store.conn.execute("SELECT COUNT(*) FROM raw_documents WHERE paper_id=?", (paper_id,)).fetchone()[0] == 1

    path.write_text(path.read_text() + "\nA correction.\n", encoding="utf-8")
    changed = ingest_markdown(store, path, project_id="proj")
    assert changed["status"] == "created"
    docs = store.conn.execute("SELECT * FROM raw_documents WHERE paper_id=? ORDER BY created_at", (paper_id,)).fetchall()
    assert len(docs) == 2 and sum(d["is_current"] for d in docs) == 1
    store.close()


def test_identity_upgrade_and_stem_twins(tmp_path):
    store = _store(tmp_path)
    a = _md(tmp_path, "a.md", "# Paper A\n\nBody A.\n")
    b_dir = tmp_path / "robot_grasping"
    b_dir.mkdir()
    b = _md(b_dir, "main.md", "# Robot Grasping\n\nGripper findings.\n")
    d_dir = tmp_path / "diabetes_trial"
    d_dir.mkdir()
    d = _md(d_dir, "main.md", "# Diabetes Trial\n\nMetformin findings.\n")
    ra = ingest_markdown(store, a)
    rb = ingest_markdown(store, b)
    rd = ingest_markdown(store, d)
    assert len({ra["paper_id"], rb["paper_id"], rd["paper_id"]}) == 3
    # same file via another path: content-addressed doc, one identity
    copy_dir = tmp_path / "copy"
    copy_dir.mkdir()
    copy = copy_dir / "copy.md"
    copy.write_text(a.read_text(), encoding="utf-8")
    again = ingest_markdown(store, copy)
    assert again["paper_id"] == ra["paper_id"]
    assert store.conn.execute("SELECT COUNT(*) FROM raw_documents WHERE paper_id=?", (ra["paper_id"],)).fetchone()[0] == 1
    store.close()


def test_upsert_precedence_conflict_and_promote(tmp_path):
    store = _store(tmp_path)
    paper_id, state = store.upsert_paper_v2(
        kind="title_year", value="a study|2020", title="A Study", title_source="caller",
        fields={"source_type": "markdown", "year": 2020},
    )
    assert state == "created"
    same_id, state2 = store.upsert_paper_v2(
        kind="doi", value="10.1000/x", title="A Study", title_source="frontmatter",
        fields={"doi": "10.1000/x", "abstract": "full abstract"},
    )
    assert same_id == paper_id
    assert store.conn.execute("SELECT identity_kind FROM papers WHERE id=?", (paper_id,)).fetchone()[0] == "doi"
    aliased = store.conn.execute(
        "SELECT * FROM paper_aliases WHERE kind='title_year' AND value='a study|2020'"
    ).fetchone()
    assert aliased and aliased["paper_id"] == paper_id
    # a second paper cannot claim an identity another paper already owns
    other, _ = store.upsert_paper_v2(
        kind="title_year", value="different|2021", title="Different", title_source="caller",
        fields={"year": 2021},
    )
    assert other != paper_id
    with pytest.raises(IdentityConflict):
        store.promote_identity(other, "doi", "10.1000/x")
    # metadata-only never clobbers
    store.upsert_paper_v2(
        kind="doi", value="10.1000/x", title="A Study", title_source="caller",
        fields={"abstract": ""}, metadata_only=True,
    )
    row = store.conn.execute("SELECT abstract FROM papers WHERE id=?", (paper_id,)).fetchone()
    assert row["abstract"] == "full abstract"
    promoted = store.promote_identity(paper_id, "pmid", "999")
    assert promoted["kind"] == "pmid"
    assert store.conn.execute("SELECT identity_value FROM papers WHERE id=?", (paper_id,)).fetchone()[0] == "999"
    store.close()


def test_merge_papers(tmp_path):
    store = _store(tmp_path)
    a, _ = store.upsert_paper_v2(kind="title_year", value="twin a|2020", title="Twin A", title_source="caller", fields={"year": 2020})
    b, _ = store.upsert_paper_v2(kind="doi", value="10.1/twin", title="Twin B", title_source="frontmatter", fields={"doi": "10.1/twin"})
    store.ensure_project("p1")
    store.add_membership(a, "p1")
    store.add_membership(b, "p1")
    path = _md(tmp_path, "twin.md", "# Twin\n\nSame body for merge.\n")
    ingested = ingest_markdown(store, path, project_id="p1", identity_override=("doi", "10.1/twin"))
    # ingested landed on b; merge a into b must keep b's doc and remove a
    result = store.merge_papers(a, b)
    assert result["merged"] is True
    assert store.conn.execute("SELECT COUNT(*) FROM papers WHERE id=?", (a,)).fetchone()[0] == 0
    assert store.conn.execute("SELECT COUNT(*) FROM paper_projects WHERE paper_id=?", (a,)).fetchone()[0] == 0
    members = store.conn.execute("SELECT COUNT(*) FROM paper_projects WHERE paper_id=?", (b,)).fetchone()[0]
    assert members == 1
    store.close()


def test_metadata_only_ingest_is_chunkless(tmp_path):
    store = _store(tmp_path)
    paper_id, _ = store.upsert_paper_v2(
        kind="doi", value="10.1/meta", title="Metadata Only", title_source="caller",
        fields={"doi": "10.1/meta", "source_type": "doi"}, metadata_only=True,
    )
    row = store.conn.execute("SELECT cite_state FROM papers WHERE id=?", (paper_id,)).fetchone()
    assert row["cite_state"] == "chunkless"
    store.conn.execute("UPDATE papers SET verified=1 WHERE id=?", (paper_id,))
    store.conn.commit()
    store.close()


def _make_v1_db(path):
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL, authors_json TEXT NOT NULL DEFAULT '[]',
          year INTEGER, venue TEXT, doi TEXT, arxiv_id TEXT, pmid TEXT, url TEXT, pdf_path TEXT, abstract TEXT,
          bibtex_key TEXT, bibtex TEXT, source_type TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
          verification_note TEXT, project_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          accessed_at TEXT, access_count INTEGER NOT NULL DEFAULT 0, confidence REAL NOT NULL DEFAULT 0.6,
          superseded_by TEXT, fingerprint TEXT NOT NULL UNIQUE);
        CREATE TABLE chunks (id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, section TEXT, page INTEGER,
          chunk_index INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE claims (id TEXT PRIMARY KEY, paper_id TEXT, manuscript_id TEXT, claim_text TEXT NOT NULL,
          claim_type TEXT NOT NULL, evidence_quote TEXT, page INTEGER, section TEXT, confidence REAL NOT NULL DEFAULT 0.5,
          status TEXT NOT NULL DEFAULT 'extracted', superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE manuscripts (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, target_venue TEXT,
          citation_style TEXT, root_path TEXT, status TEXT NOT NULL DEFAULT 'draft', notes TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE manuscript_sections (id TEXT PRIMARY KEY, manuscript_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT,
          word_target INTEGER, word_count INTEGER, status TEXT, notes TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE contributions (id TEXT PRIMARY KEY, manuscript_id TEXT NOT NULL, text TEXT NOT NULL,
          order_index INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE terminology (id TEXT PRIMARY KEY, manuscript_id TEXT NOT NULL, canonical TEXT NOT NULL,
          avoid_json TEXT NOT NULL DEFAULT '[]', notes TEXT);
        CREATE TABLE reviewer_comments (id TEXT PRIMARY KEY, manuscript_id TEXT NOT NULL, reviewer TEXT, comment TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open', response TEXT, created_at TEXT NOT NULL);
        CREATE TABLE observations (id TEXT PRIMARY KEY, tier TEXT NOT NULL, content TEXT NOT NULL,
          concepts_json TEXT NOT NULL DEFAULT '[]', project_id TEXT, manuscript_id TEXT, paper_id TEXT,
          confidence REAL NOT NULL DEFAULT 0.7, created_at TEXT NOT NULL, accessed_at TEXT, access_count INTEGER NOT NULL DEFAULT 0,
          superseded_by TEXT);
        CREATE TABLE lessons (id TEXT PRIMARY KEY, content TEXT NOT NULL, concepts_json TEXT NOT NULL DEFAULT '[]',
          project_id TEXT, created_at TEXT NOT NULL);
        CREATE TABLE audit (id TEXT PRIMARY KEY, operation TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, created_at TEXT NOT NULL);
        CREATE TABLE search_map (rowid INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, UNIQUE(kind, ref_id));
        CREATE VIRTUAL TABLE search_fts USING fts5(title, text, tokenize = 'unicode61 remove_diacritics 2');
        """
    )
    conn.execute("INSERT INTO papers VALUES ('pap_a','Paper A','[]',2020,'V','10.1/a',NULL,NULL,NULL,NULL,'abs','keyA',NULL,'pdf',1,NULL,'proj', '2020','2020',NULL,0,0.6,NULL,'fp_a')")
    conn.execute("INSERT INTO papers VALUES ('pap_b','Paper B','[]',2021,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'keyB',NULL,'bibtex',1,'has identifier',NULL,'2020','2020',NULL,0,0.6,NULL,'fp_b')")
    conn.execute("INSERT INTO chunks VALUES ('chk_a','pap_a','intro',NULL,0,'chunk text a','2020')")
    conn.execute("INSERT INTO claims VALUES ('clm_a','pap_a',NULL,'claim a','finding','q',NULL,'intro',0.5,'extracted',NULL,'2020','2020')")
    conn.execute("INSERT INTO manuscripts VALUES ('ms_1','Manuscript','ms-slug',NULL,NULL,NULL,'draft',NULL,'2020','2020')")
    conn.execute("INSERT INTO audit VALUES ('aud_1','paper_create','paper','pap_a','x','2020')")
    conn.commit()
    conn.close()


def test_migration_2000_quarantines_legacy(tmp_path):
    path = tmp_path / "v1.db"
    _make_v1_db(path)
    store = Store.__new__(Store)  # bypass the migration-required guard for the migrator
    store._connect_raw(path)
    try:
        with pytest.raises(MigrationRequired):
            Store(path)
    finally:
        pass
    result = migrate(store)
    assert result["user_version"] == 2000
    assert store.conn.execute("PRAGMA user_version").fetchone()[0] == 2000
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 2
    assert store.conn.execute("SELECT COUNT(*) FROM paper_projects").fetchone()[0] >= 1
    assert store.conn.execute("SELECT COUNT(*) FROM legacy_chunks").fetchone()[0] == 1
    assert store.conn.execute("SELECT COUNT(*) FROM legacy_claims").fetchone()[0] == 1
    assert store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0
    assert store.conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert store.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] >= 1
    assert migrate(store)["changed"] is False
    store.close()
    reopened = Store(path)
    assert reopened.conn.execute("PRAGMA user_version").fetchone()[0] == 2000
    reopened.close()


def test_migrate_cli_and_doctor(tmp_path):
    path = tmp_path / "v1.db"
    _make_v1_db(path)
    store = Store.__new__(Store)
    store._connect_raw(path)
    migrate(store)
    report = doctor_schema(store)
    assert report["user_version"] == 2000
    store.close()


def test_pdf_then_markdown_single_paper(tmp_path):
    from papermemory.ingest import ingest_pdf

    store = _store(tmp_path)
    pdf = tmp_path / "x.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    first = ingest_pdf(store, pdf, doi="10.1/both", title="Both")
    md = _md(tmp_path, "x.md", FULLTEXT, "---\ndoi: 10.1/both\ntitle: Both\n---")
    second = ingest_markdown(store, md)
    assert first["paper"]["id"] == second["paper_id"]
    assert store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0] == 1
    assert store.conn.execute("SELECT cite_state FROM papers WHERE id=?", (second["paper_id"],)).fetchone()[0] == "citable"
    store.close()


def test_claim_with_null_and_nonnull_manuscript(tmp_path):
    store = _store(tmp_path)
    path = _md(tmp_path, "c.md", FULLTEXT, "---\ndoi: 10.1/claims\ntitle: Claims\n---")
    ingested = ingest_markdown(store, path)
    paper_id = ingested["paper_id"]
    ms = store.upsert_manuscript({"title": "MS", "slug": "ms"})
    loose = store.add_claim_v2({"paper_id": paper_id, "claim_text": "loose claim", "asserted_quote": "We report an effect."})
    bound = store.add_claim_v2({"paper_id": paper_id, "claim_text": "bound claim", "manuscript_id": ms["id"], "asserted_quote": "We used a sample of 120 participants."})
    assert loose["manuscript_id"] is None and loose["status"] == "extracted"
    assert bound["manuscript_id"] == ms["id"]
    anchored = store.add_claim_v2({
        "paper_id": paper_id,
        "claim_text": "sample claim",
        "asserted_quote": "We used a sample of 120 participants.",
    })
    assert anchored["status"] == "extracted"
    assert anchored["quote_char_start"] < anchored["quote_char_end"]
    assert store.conn.execute("SELECT COUNT(*) FROM claim_sources WHERE claim_id=?", (anchored["id"],)).fetchone()[0] >= 1
    store.close()


def test_300_file_ingest_is_deterministic(tmp_path):
    store = _store(tmp_path)
    files = []
    for index in range(300):
        body = f"# Paper {index}\n\n## Abstract\n\nFinding {index}.\n\n## Methods\n\nWe ran experiment {index}.\n"
        files.append(_md(tmp_path, f"p{index}.md", body, f"---\ndoi: 10.9/{index}\ntitle: Paper {index}\nyear: 2024\n---"))
    for path in files:
        assert ingest_markdown(store, path)["status"] == "created"
    count_papers = store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
    count_chunks = store.conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    assert count_papers == 300 and count_chunks > 0
    fingerprint = tuple(store.conn.execute(
        "SELECT COUNT(*), SUM(byte_start), SUM(byte_end), SUM(char_start), SUM(char_end) FROM chunks"
    ).fetchone())
    for path in files:
        assert ingest_markdown(store, path)["status"] == "duplicate-noop"
    assert tuple(store.conn.execute(
        "SELECT COUNT(*), SUM(byte_start), SUM(byte_end), SUM(char_start), SUM(char_end) FROM chunks"
    ).fetchone()) == fingerprint
    store.close()
