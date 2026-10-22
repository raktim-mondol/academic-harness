from pathlib import Path

import pytest

from papermemory.db import Store
from papermemory.ingest import ingest_markdown, ingest_pdf
from papermemory.search import search


pypdf = pytest.importorskip("pypdf")


def _blank_pdf(path: Path, title: str) -> None:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Title": title})
    writer.write(path)


def test_pdf_ingest_keeps_doi_and_merges_markdown(tmp_path: Path):
    store = Store(tmp_path / "t.db")
    pdf = tmp_path / "paper.pdf"
    _blank_pdf(pdf, "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023")
    doi = "10.1234/researchcraft.merge"
    first = ingest_pdf(store, pdf, doi=doi, title="Attention Is All You Need")
    paper = first["paper"]
    assert paper["doi"] == doi
    assert paper["verified"] == 1
    assert paper["title"] == "Attention Is All You Need"
    assert paper["pdf_path"] == str(pdf.resolve())

    md = tmp_path / "paper.md"
    md.write_text("# Attention Is All You Need\n\nTransformers use scaled dot-product attention.\n")
    second = ingest_markdown(store, md, doi=doi, pdf_path=str(pdf))
    merged = second["paper"]
    assert merged["id"] == paper["id"]
    assert merged["doi"] == doi
    assert merged["verified"] == 1
    assert merged["pdf_path"] == str(pdf.resolve())
    hits = search(store, "dot-product attention", kind="chunk", limit=5)
    assert hits
    store.close()


def test_second_pdf_ingest_with_same_doi_does_not_duplicate(tmp_path: Path):
    store = Store(tmp_path / "t.db")
    pdf = tmp_path / "paper.pdf"
    _blank_pdf(pdf, "Local header title")
    doi = "10.1234/dup.check"
    a = ingest_pdf(store, pdf, doi=doi, title="Canonical Title")
    b = ingest_pdf(store, pdf, doi=doi)
    assert a["paper"]["id"] == b["paper"]["id"]
    assert b["paper"]["title"] == "Canonical Title"
    rows = store.conn.execute("SELECT COUNT(*) FROM papers").fetchone()[0]
    assert rows == 1
    store.close()
