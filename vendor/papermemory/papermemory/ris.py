"""RIS reader (stdlib only).

Handles the common RIS variants: Zotero/EndNote-style and generic publisher exports.
Repeated tags, wrapped continuation lines,
CRLF line endings, a leading BOM, tag aliases (``T1``/``TI``, ``A1``/``AU``,
``JO``/``JF``/``JA``/``J2``), and ``DA``/``PY`` dates are all accepted. Tags
with no CSL home are kept under their RIS names in ``extra``.
"""
from __future__ import annotations

import re
from typing import Any

from papermemory.bibrecord import Record, normalize_pages
from papermemory.util import normalize_arxiv, normalize_doi

_LINE = re.compile(r"^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$")

# RIS reference type -> (CSL type, BibTeX-style entry type)
RIS_TYPES = {
    "JOUR": ("article-journal", "article"), "JFULL": ("article-journal", "article"),
    "EJOUR": ("article-journal", "article"), "ABST": ("article-journal", "article"),
    "CONF": ("paper-conference", "inproceedings"), "CPAPER": ("paper-conference", "inproceedings"),
    "BOOK": ("book", "book"), "EBOOK": ("book", "book"), "EDBOOK": ("book", "book"),
    "CHAP": ("chapter", "incollection"), "ECHAP": ("chapter", "incollection"),
    "THES": ("thesis", "phdthesis"), "RPRT": ("report", "techreport"),
    "ELEC": ("webpage", "online"), "WEB": ("webpage", "online"), "BLOG": ("webpage", "online"),
    "UNPB": ("manuscript", "unpublished"), "PAT": ("patent", "patent"),
    "DATA": ("dataset", "dataset"), "COMP": ("software", "software"),
    "MGZN": ("article-magazine", "article"), "NEWS": ("article-newspaper", "article"),
    "GEN": ("document", "misc"), "STAND": ("standard", "misc"),
}
_AUTHOR = ("AU", "A1")
_EDITOR = ("A2", "ED")
_TITLE = ("TI", "T1")
_CONTAINER = ("T2", "JO", "JF", "BT")
_SHORT_CONTAINER = ("JA", "J2")
_ABSTRACT = ("AB", "N2")
_CONSUMED = {
    "TY", "ER", "ID", *_AUTHOR, *_EDITOR, *_TITLE, *_CONTAINER, *_SHORT_CONTAINER, *_ABSTRACT,
    "PY", "Y1", "DA", "VL", "IS", "SP", "EP", "PB", "CY", "DO", "UR", "SN", "KW", "N1", "LA",
    "T3", "ET", "M3", "AN",
}


def _name(value: str) -> dict[str, str]:
    value = value.strip()
    if not value:
        return {}
    if "," in value:
        parts = [p.strip() for p in value.split(",")]
        family = parts[0]
        if len(parts) == 2:
            given, suffix = parts[1], ""
        else:
            suffix, given = parts[1], ", ".join(parts[2:])
        name = {"family": family}
        if given:
            name["given"] = given
        if suffix:
            name["suffix"] = suffix
        return name
    return {"literal": value}


def _date(py: str | None, da: str | None) -> dict[str, Any] | None:
    for value in (da, py):
        if not value:
            continue
        m = re.match(r"^\s*(\d{4})(?:[/\-.](\d{1,2})?(?:[/\-.](\d{1,2})?)?)?", value)
        if m:
            parts = [int(m.group(1))]
            if m.group(2) and 1 <= int(m.group(2)) <= 12:
                parts.append(int(m.group(2)))
                if m.group(3):
                    parts.append(int(m.group(3)))
            return {"date-parts": [parts]}
    return None


def _split_sn(value: str) -> tuple[str | None, str | None]:
    """Return (ISBN, ISSN) for an ``SN`` value, which RIS uses for both."""
    compact = re.sub(r"[\s\-]", "", value)
    if re.fullmatch(r"\d{7}[\dXx]", compact):
        return None, value.strip()
    if re.fullmatch(r"(?:\d{9}[\dXx]|\d{13})", compact):
        return value.strip(), None
    return None, value.strip()


def _records(text: str) -> list[tuple[list[tuple[str, str]], int]]:
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    entries: list[tuple[list[tuple[str, str]], int]] = []
    current: list[tuple[str, str]] = []
    started = 0
    for number, line in enumerate(text.split("\n"), 1):
        m = _LINE.match(line)
        if m:
            tag, value = m.group(1), m.group(2).strip()
            if tag == "TY" and current:
                entries.append((current, started))  # tolerate a missing ER
                current = []
            if tag == "TY":
                started = number
            if tag == "ER":
                if current:
                    entries.append((current, started))
                current = []
                continue
            current.append((tag, value))
        elif line.strip() and current:
            tag, value = current[-1]
            current[-1] = (tag, f"{value} {line.strip()}".strip())
    if current:
        entries.append((current, started))
    return entries


def parse_ris(text: str) -> tuple[list[Record], list[dict[str, Any]]]:
    records: list[Record] = []
    errors: list[dict[str, Any]] = []
    for tags, line in _records(text):
        by: dict[str, list[str]] = {}
        for tag, value in tags:
            by.setdefault(tag, []).append(value)
        if "TY" not in by:
            errors.append({"line": line, "key": None, "message": "record without TY"})
            continue
        ris_type = by["TY"][0].upper()
        csl_type, entry_type = RIS_TYPES.get(ris_type, ("document", "misc"))
        csl: dict[str, Any] = {"type": csl_type}
        extra: dict[str, Any] = {"ris_type": ris_type}
        first = lambda *names: next((by[n][0] for n in names if by.get(n)), "")  # noqa: E731

        authors = [n for tag in _AUTHOR for v in by.get(tag, []) if (n := _name(v))]
        editors = [n for tag in _EDITOR for v in by.get(tag, []) if (n := _name(v))]
        if authors:
            csl["author"] = authors
        if editors:
            csl["editor"] = editors
        title = first(*_TITLE)
        if title:
            csl["title"] = title
        # In book/chapter/conference records T2 is the container; JO/JF the journal.
        container = first("JO", "JF", "T2", "BT")
        if container:
            csl["container-title"] = container
        short = first(*_SHORT_CONTAINER)
        if short:
            csl["container-title-short"] = short
        issued = _date(first("PY", "Y1"), first("DA"))
        if issued:
            csl["issued"] = issued
        elif first("PY", "Y1", "DA"):
            extra["date_raw"] = first("PY", "Y1", "DA")
        if by.get("VL"):
            csl["volume"] = by["VL"][0]
        if by.get("IS"):
            csl["issue"] = by["IS"][0]
        sp, ep = first("SP"), first("EP")
        if sp and ep:
            csl["page"] = normalize_pages(f"{sp}-{ep}")
        elif sp:
            csl["page"] = sp
        if by.get("PB"):
            csl["publisher"] = by["PB"][0]
        if by.get("CY"):
            csl["publisher-place"] = by["CY"][0]
        abstract = first(*_ABSTRACT)
        if abstract:
            csl["abstract"] = abstract
        if by.get("KW"):
            csl["keyword"] = ", ".join(by["KW"])
        if by.get("N1"):
            csl["note"] = " ".join(by["N1"])
        if by.get("LA"):
            csl["language"] = by["LA"][0]
        if by.get("T3"):
            csl["collection-title"] = by["T3"][0]
        if by.get("ET"):
            csl["edition"] = by["ET"][0]
        if by.get("M3"):
            csl["genre"] = by["M3"][0]
        if by.get("AN"):
            extra["accession"] = by["AN"][0]
        for value in by.get("SN", []):
            isbn, issn = _split_sn(value)
            if isbn:
                csl.setdefault("ISBN", isbn)
            elif issn:
                csl.setdefault("ISSN", issn)
        urls = by.get("UR", [])
        doi = normalize_doi(first("DO"))
        for url in urls:
            m = re.match(r"^https?://(?:dx\.)?doi\.org/(10\..+)$", url.strip(), re.I)
            if m and not doi:
                doi = normalize_doi(m.group(1))
        if doi:
            csl["DOI"] = doi
        plain_urls = [u for u in urls if not re.match(r"^https?://(?:dx\.)?doi\.org/", u.strip(), re.I)]
        if plain_urls:
            csl["URL"] = plain_urls[0]
            for url in plain_urls:
                m = re.search(r"arxiv\.org/(?:abs|pdf)/([^\s?#]+)", url, re.I)
                if m and normalize_arxiv(m.group(1)):
                    extra["arxiv_id"] = normalize_arxiv(m.group(1))
                    break
        ident = first("ID")
        if ident:
            extra["ris_id"] = ident
        for tag, values in by.items():
            if tag not in _CONSUMED:
                extra[f"ris_{tag}"] = values if len(values) > 1 else values[0]
        if "UR" in by and len(plain_urls) > 1:
            extra["ris_extra_urls"] = plain_urls[1:]
        records.append(Record(
            entry_type=entry_type, source_key=ident or None, csl=csl, extra=extra,
            raw=None, line=line, warnings=[], fmt="ris",
        ))
    return records, errors
