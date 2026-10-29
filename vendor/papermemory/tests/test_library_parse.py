from __future__ import annotations

from papermemory.bibparse import parse_bib
from papermemory.bibrecord import parse_names, parse_year_month, normalize_pages, record_from_bib
from papermemory.bibtex import parse_bibtex
from papermemory.latex_text import latex_to_text
from papermemory.ris import parse_ris


def _one(text: str):
    result = parse_bib(text)
    assert len(result.entries) == 1, result
    return result.entries[0], result


def test_string_macro_and_concatenation():
    entry, _ = _one('@string{jn = "Nature"}\n@article{a1, title={T}, journal = jn # " Methods", year=2020}')
    assert entry.fields["journal"] == "Nature Methods"


def test_paren_delimiters():
    entry, _ = _one("@article(a2, title={T}, year={2020})")
    assert entry.key == "a2" and entry.fields["year"] == "2020"


def test_quoted_value_with_escaped_quote_and_braces():
    entry, _ = _one('@article{a3, title="A {B} \\"C\\" d", year=2020}')
    assert entry.fields["title"] == 'A {B} \\"C\\" d'


def test_unterminated_entry_does_not_swallow_next():
    result = parse_bib("@article{a4, title={Lost}, year=2020\n\n@article{a5, title={Next}, year=2021}\n")
    assert [e.key for e in result.entries] == ["a4", "a5"]
    assert result.entries[0].fields["title"] == "Lost"
    assert result.entries[1].fields["title"] == "Next"
    assert "unterminated-entry" in result.entries[0].warnings
    assert any(err["key"] == "a4" for err in result.errors)


def test_unterminated_value_resyncs_at_next_entry():
    result = parse_bib("@article{u1, title={Never closed, year=2020\n\n@article{u2, title={Next}, year=2021}\n")
    assert [e.key for e in result.entries] == ["u1", "u2"]
    assert "title" not in result.entries[0].fields
    assert result.entries[1].fields["title"] == "Next"


def test_duplicate_field_first_wins_and_is_reported():
    entry, result = _one("@article{a6, title={One}, title={Two}, year=2020}")
    assert entry.fields["title"] == "One"
    assert any("duplicate-field" in err["message"] for err in result.errors)


def test_month_macro_adjacent_entries_comment_preamble():
    result = parse_bib(
        '@comment{x {y} z}\n@preamble{"\\\\newcommand"}\n'
        "@article{c1, title={T}, month=jan, year=2020}@article{c2,title={B}}"
    )
    assert [e.key for e in result.entries] == ["c1", "c2"]
    assert result.entries[0].fields["month"] == "January"


def test_names_particles_corporate_others():
    names, et_al = parse_names("He, Kaiming and van der Berg, Jan and {World Health Organization} and Ludwig van Beethoven and others")
    assert et_al
    assert names[0] == {"family": "He", "given": "Kaiming"}
    assert names[1] == {"family": "Berg", "non-dropping-particle": "van der", "given": "Jan"}
    assert names[2] == {"literal": "World Health Organization"}
    assert names[3]["family"] == "Beethoven" and names[3]["non-dropping-particle"] == "van"


def test_name_with_suffix():
    (name,), _ = parse_names("Smith, Jr., John")
    assert name == {"family": "Smith", "suffix": "Jr.", "given": "John"}


def test_dates_and_pages():
    issued, left = parse_year_month({"year": "2020", "month": "mar"})
    assert issued == {"date-parts": [[2020, 3]]} and not left
    issued, left = parse_year_month({"date": "2021-05-17"})
    assert issued == {"date-parts": [[2021, 5, 17]]}
    issued, left = parse_year_month({"year": "in press"})
    assert issued is None and left["year_raw"] == "in press"
    assert normalize_pages("981--991") == "981–991"
    assert normalize_pages("e1234") == "e1234"


def test_latex_decoding():
    assert latex_to_text(r"M{\"u}ller and Schr\"{o}dinger") == "Müller and Schrödinger"
    assert latex_to_text(r"Erd\H{o}s \& R\'enyi, {\ss}, \c{c}, \v{S}koda") == "Erdős & Rényi, ß, ç, Škoda"
    assert latex_to_text("{Deep} {L}earning~now") == "Deep Learning now"


def test_every_source_field_is_kept_somewhere():
    text = """@article{k1, title={T}, author={A, B}, journal={J}, year=2020, volume=3, number=4,
      pages={1--2}, doi={10.1/ABC}, mrnumber={99}, fjournal={Full J}, biburl={http://x}, pdf={/tmp/a.pdf}}"""
    entry, _ = _one(text)
    record = record_from_bib(entry)
    csl_sources = {"title", "author", "journal", "year", "volume", "number", "pages", "doi"}
    assert set(entry.fields) - csl_sources <= set(record.extra)
    assert record.extra["mrnumber"] == "99" and record.extra["pdf"] == "/tmp/a.pdf"
    assert record.csl["DOI"] == "10.1/abc" and record.csl["issue"] == "4" and record.csl["page"] == "1–2"
    assert record.raw.startswith("@article{k1")


def test_arxiv_detected_from_eprint_and_journal_text():
    entry, _ = _one("@article{x1, title={T}, eprint={2101.00001}, archiveprefix={arXiv}}")
    assert record_from_bib(entry).extra["arxiv_id"] == "2101.00001"
    entry, _ = _one("@article{x2, title={T}, journal={arXiv preprint arXiv:1512.03385}}")
    assert record_from_bib(entry).extra["arxiv_id"] == "1512.03385"


def test_legacy_parse_bibtex_shape_is_preserved():
    entries = parse_bibtex("@inproceedings{k, title={Shear}, author={Simmons, John V and McManus, Dennis A}, booktitle={B}, year={2004}, publisher={P}}")
    assert entries[0]["authors"] == ["John V Simmons", "Dennis A McManus"]
    assert entries[0]["venue"] == "B" and entries[0]["year"] == 2004 and entries[0]["bibtex_key"] == "k"


RIS_ZOTERO = """﻿TY  - JOUR\r\nAU  - Dawood, Muhammad\r\nAU  - Rajpoot, Nasir\r\nPY  - 2026\r\nDA  - 2026/03/02\r\nTI  - Confounding factors\r\nJO  - Nature Biomedical Engineering\r\nAB  - First line\r\n    continued line\r\nSN  - 2157-846X\r\nUR  - https://doi.org/10.1038/s41551-026-01616-8\r\nID  - Dawood2026\r\nER  - \r\n"""

# Synthetic publisher-style exports written from the RIS tag set (not copies of any vendor's file).
RIS_PUBLISHER = """TY  - JOUR
AU  - Smith, J.
AU  - Lee, K.
TI  - Deep learning for X
T2  - Journal of Y
PY  - 2021
VL  - 12
IS  - 3
SP  - 100
EP  - 110
DO  - 10.1000/xyz123
UR  - https://publisher.example/record/1
AB  - Abstract text.
KW  - alpha
KW  - beta
N1  - Cited By: 4
ER  -
"""
RIS_CONFERENCE = """TY  - CONF
TI  - A conference paper
T2  - Proc. of Z
AU  - Wu, H
PY  - 2019
DA  - 2019
SN  - 978-1-4503-1234-5
AN  - WOS:000123456700001
DO  - 10.1145/abc
ER  -
"""


def test_ris_zotero_style():
    (record,), errors = parse_ris(RIS_ZOTERO)
    assert not errors
    assert record.source_key == "Dawood2026"
    assert record.csl["author"][0] == {"family": "Dawood", "given": "Muhammad"}
    assert record.csl["issued"] == {"date-parts": [[2026, 3, 2]]}
    assert record.csl["DOI"] == "10.1038/s41551-026-01616-8" and "URL" not in record.csl
    assert record.csl["ISSN"] == "2157-846X"
    assert record.csl["abstract"] == "First line continued line"
    assert record.entry_type == "article"


def test_ris_publisher_style_pages_keywords_and_no_usable_id():
    (record,), _ = parse_ris(RIS_PUBLISHER)
    assert record.csl["page"] == "100–110" and record.csl["issue"] == "3" and record.csl["volume"] == "12"
    assert record.csl["container-title"] == "Journal of Y"
    assert record.csl["keyword"] == "alpha, beta"
    assert record.csl["URL"].startswith("https://publisher.example")
    assert record.source_key is None


def test_ris_conference_isbn_and_accession():
    (record,), _ = parse_ris(RIS_CONFERENCE)
    assert record.entry_type == "inproceedings" and record.csl["type"] == "paper-conference"
    assert record.csl["ISBN"] == "978-1-4503-1234-5"
    assert record.extra["accession"] == "WOS:000123456700001"


def test_ris_multiple_records_and_missing_er():
    records, errors = parse_ris(RIS_PUBLISHER + RIS_CONFERENCE.replace("ER  -\n", ""))
    assert len(records) == 2 and not errors
