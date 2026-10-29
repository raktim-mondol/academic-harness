"""Legacy BibTeX entry reader.

Kept for callers that want flat, plain-text fields. It now runs on the
tolerant parser in ``bibparse`` so it no longer mis-reads macros, ``()``
entries, quoted values, or unterminated entries.
"""
from __future__ import annotations

from typing import Any

from papermemory.bibparse import parse_bib
from papermemory.bibrecord import arxiv_from_fields, display_name, parse_names
from papermemory.latex_text import latex_to_text, strip_braces


def _plain(value: str) -> str:
    return latex_to_text(value)


def parse_bibtex(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for entry in parse_bib(text).entries:
        fields = {name: _plain(value) for name, value in entry.fields.items()}
        year = None
        if fields.get("year"):
            import re

            match = re.search(r"\d{4}", fields["year"])
            if match:
                year = int(match.group(0))
        names, _ = parse_names(entry.fields.get("author") or entry.fields.get("editor") or "")
        venue = fields.get("journal") or fields.get("booktitle") or fields.get("institution") or fields.get("publisher")
        entries.append(
            {
                "entry_type": entry.entry_type,
                "bibtex_key": entry.key,
                "title": fields.get("title") or entry.key,
                "authors": [display_name(name) for name in names],
                "year": year,
                "venue": venue,
                "doi": fields.get("doi"),
                "arxiv_id": arxiv_from_fields(entry.fields),
                "pmid": fields.get("pmid"),
                "url": fields.get("url"),
                "abstract": fields.get("abstract"),
                "pages": fields.get("pages"),
                "volume": fields.get("volume"),
                "bibtex": entry.raw,
                "fields": fields,
            }
        )
    return entries
