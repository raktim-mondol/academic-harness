"""One normalised bibliographic record, whatever format it came from.

``Record`` is the hand-off between the format readers (BibTeX/BibLaTeX, RIS,
CSL-JSON) and the library store. Names, dates, and pages are already in CSL
form; fields CSL has no home for stay in ``extra`` under their original names
so nothing is dropped.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from papermemory.bibparse import BibEntry
from papermemory.latex_text import latex_to_text
from papermemory.util import normalize_arxiv, normalize_doi

# BibTeX/BibLaTeX entry type -> CSL type. Aliases follow the BibLaTeX manual
# (section 2.1.2): conference = inproceedings, mastersthesis/phdthesis = thesis,
# techreport = report, electronic/www = online.
BIB_TO_CSL_TYPE = {
    "article": "article-journal", "inproceedings": "paper-conference", "conference": "paper-conference",
    "book": "book", "mvbook": "book", "booklet": "book", "collection": "book", "mvcollection": "book",
    "proceedings": "book", "mvproceedings": "book", "reference": "book", "mvreference": "book",
    "inbook": "chapter", "incollection": "chapter", "bookinbook": "chapter", "suppbook": "chapter",
    "suppcollection": "chapter", "inreference": "entry-encyclopedia",
    "manual": "report", "techreport": "report", "report": "report",
    "phdthesis": "thesis", "mastersthesis": "thesis", "thesis": "thesis",
    "online": "webpage", "electronic": "webpage", "www": "webpage",
    "unpublished": "manuscript", "patent": "patent", "dataset": "dataset", "software": "software",
    "misc": "document", "periodical": "document", "suppperiodical": "article-journal",
}
THESIS_GENRE = {"phdthesis": "PhD thesis", "mastersthesis": "Master's thesis"}
ARTICLE_LIKE = {"article-journal", "paper-conference", "chapter", "article-magazine", "article-newspaper"}

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_PARTICLES = {
    "von", "van", "de", "der", "den", "del", "della", "di", "da", "dos", "du", "la", "le",
    "ten", "ter", "zu", "zum", "zur", "af", "av", "bin", "ibn", "al", "el",
}
_ARXIV_IN_TEXT = re.compile(r"arxiv[:\s]*((?:\d{4}\.\d{4,5})|(?:[a-z\-]+(?:\.[A-Za-z]{2})?/\d{7}))", re.I)
_ARXIV_NEW = re.compile(r"^\d{4}\.\d{4,5}(?:v\d+)?$")


@dataclass
class Record:
    entry_type: str
    source_key: str | None
    csl: dict[str, Any]
    extra: dict[str, Any] = field(default_factory=dict)
    raw: str | None = None
    line: int | None = None
    warnings: list[str] = field(default_factory=list)
    fmt: str = "bibtex"


# ---------- names ----------


def _split_top(value: str, separator: re.Pattern[str]) -> list[str]:
    """Split on ``separator`` only outside braces."""
    pieces: list[str] = []
    depth = 0
    last = 0
    i = 0
    while i < len(value):
        ch = value[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        elif depth == 0:
            m = separator.match(value, i)
            if m and m.end() > i:
                pieces.append(value[last:i])
                last = m.end()
                i = m.end()
                continue
        i += 1
    pieces.append(value[last:])
    return pieces


def _top_tokens(value: str) -> list[str]:
    return [t for t in _split_top(value, re.compile(r"\s+")) if t]


def _wrapped(value: str) -> bool:
    value = value.strip()
    if not (value.startswith("{") and value.endswith("}")):
        return False
    depth = 0
    for i, ch in enumerate(value):
        if ch == "\\":
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and i < len(value) - 1:
                return False
    return depth == 0


def parse_name(raw: str) -> dict[str, str]:
    raw = raw.strip()
    if not raw:
        return {}
    if _wrapped(raw):
        return {"literal": latex_to_text(raw)}
    commas = _split_top(raw, re.compile(r","))
    if len(commas) == 1:
        tokens = _top_tokens(raw)
        if len(tokens) == 1:
            return {"family": latex_to_text(tokens[0])}
        last = len(tokens) - 1
        first_von = None
        for idx in range(last):
            if tokens[idx][:1].islower() or tokens[idx].lower() in _PARTICLES:
                first_von = idx if first_von is None else first_von
        if first_von is not None:
            given = " ".join(tokens[:first_von])
            particle = " ".join(tokens[first_von:last])
            name = {"family": latex_to_text(tokens[last]), "non-dropping-particle": latex_to_text(particle)}
        else:
            given = " ".join(tokens[:last])
            name = {"family": latex_to_text(tokens[last])}
        if given:
            name["given"] = latex_to_text(given)
        return name
    family_part = commas[0].strip()
    if len(commas) == 2:
        given_part, suffix = commas[1].strip(), ""
    else:
        suffix, given_part = commas[1].strip(), ",".join(commas[2:]).strip()
    tokens = _top_tokens(family_part)
    particle = []
    while len(tokens) > 1 and (tokens[0][:1].islower() or tokens[0].lower() in _PARTICLES):
        particle.append(tokens.pop(0))
    name = {"family": latex_to_text(" ".join(tokens))}
    if particle:
        name["non-dropping-particle"] = latex_to_text(" ".join(particle))
    if given_part:
        name["given"] = latex_to_text(given_part)
    if suffix:
        name["suffix"] = latex_to_text(suffix)
    return name


def parse_names(raw: str) -> tuple[list[dict[str, str]], bool]:
    """BibTeX name list -> (CSL names, truncated-with-'and others')."""
    names: list[dict[str, str]] = []
    et_al = False
    for piece in _split_top(raw or "", re.compile(r"\s+and\s+", re.I)):
        piece = piece.strip()
        if not piece:
            continue
        if piece.lower() == "others":
            et_al = True
            continue
        name = parse_name(piece)
        if name:
            names.append(name)
    return names, et_al


def display_name(name: dict[str, str]) -> str:
    if name.get("literal"):
        return name["literal"]
    parts = [name.get("given", ""), name.get("non-dropping-particle", ""), name.get("family", "")]
    text = " ".join(p for p in parts if p)
    return f"{text}, {name['suffix']}" if name.get("suffix") else text


# ---------- dates, pages ----------


def parse_year_month(fields: dict[str, str]) -> tuple[dict[str, Any] | None, dict[str, str]]:
    """CSL ``issued`` from year/month/day or a biblatex ``date``; leftovers go to extra."""
    leftovers: dict[str, str] = {}
    year = month = day = None
    date = (fields.get("date") or "").strip()
    if date:
        m = re.match(r"^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", date)
        if m:
            year = int(m.group(1))
            month = int(m.group(2)) if m.group(2) else None
            day = int(m.group(3)) if m.group(3) else None
        else:
            leftovers["date"] = date
    raw_year = latex_to_text(fields.get("year") or "")
    if year is None and raw_year:
        m = re.search(r"\b(\d{4})\b", raw_year)
        if m:
            year = int(m.group(1))
            if raw_year != m.group(1):
                leftovers["year_raw"] = fields["year"]
        else:
            leftovers["year_raw"] = fields["year"]
    raw_month = latex_to_text(fields.get("month") or "")
    if month is None and raw_month:
        token = re.split(r"[\s,~\-/.]+", raw_month.strip())[0].lower()
        if token.isdigit() and 1 <= int(token) <= 12:
            month = int(token)
        elif token[:3] in _MONTHS and len(token) >= 3:
            month = _MONTHS[token[:3]]
        else:
            leftovers["month_raw"] = fields["month"]
    raw_day = (fields.get("day") or "").strip()
    if day is None and raw_day.isdigit():
        day = int(raw_day)
    if year is None:
        return None, leftovers
    parts = [year] + ([month] if month else []) + ([day] if month and day else [])
    return {"date-parts": [parts]}, leftovers


def normalize_pages(value: str) -> str:
    text = latex_to_text(value)
    return re.sub(r"\s*(?:-{1,3}|–|—)\s*", "–", text) if re.search(r"\d", text) else text


# ---------- BibTeX entry -> Record ----------

_CONSUMED_ALWAYS = {
    "title", "author", "editor", "translator", "year", "month", "day", "date", "doi", "url", "isbn", "issn",
    "abstract", "note", "language", "edition", "keywords", "pages", "volume", "series", "address", "location",
    "journal", "journaltitle", "booktitle", "publisher", "institution", "school", "organization",
    "number", "issue",
}


def arxiv_from_fields(fields: dict[str, str]) -> str | None:
    prefix = (fields.get("archiveprefix") or fields.get("eprinttype") or "").strip().lower()
    eprint = (fields.get("eprint") or "").strip()
    if eprint and prefix == "arxiv":
        return normalize_arxiv(eprint)
    if fields.get("arxiv"):
        return normalize_arxiv(fields["arxiv"])
    if eprint and _ARXIV_NEW.match(eprint):
        return normalize_arxiv(eprint)
    for name in ("journal", "journaltitle", "howpublished", "note", "url"):
        m = _ARXIV_IN_TEXT.search(fields.get(name) or "")
        if m:
            return normalize_arxiv(m.group(1))
    return None


def record_from_bib(entry: BibEntry) -> Record:
    fields = entry.fields
    entry_type = entry.entry_type
    csl_type = BIB_TO_CSL_TYPE.get(entry_type, "document")
    csl: dict[str, Any] = {"type": csl_type, "id": entry.key, "citation-key": entry.key}
    extra: dict[str, Any] = {}
    used: set[str] = set()

    def text(*names: str) -> str:
        for name in names:
            if fields.get(name):
                used.add(name)
                return latex_to_text(fields[name])
        return ""

    title = text("title")
    if title:
        csl["title"] = title
        if "{" in fields.get("title", ""):
            extra["title_raw"] = fields["title"]
    for role, bib_field in (("author", "author"), ("editor", "editor"), ("translator", "translator")):
        if fields.get(bib_field):
            used.add(bib_field)
            names, et_al = parse_names(fields[bib_field])
            if names:
                csl[role] = names
            if et_al:
                extra.setdefault("et_al", []).append(role)
    if not csl.get("author") and csl.get("editor") and csl_type == "book":
        pass  # an edited book: the editors are the visible authors; kept as editors
    issued, leftovers = parse_year_month(fields)
    for name in ("year", "month", "day", "date"):
        if name in fields:
            used.add(name)
    if issued:
        csl["issued"] = issued
    extra.update(leftovers)

    container = text("journal", "journaltitle") if csl_type in ARTICLE_LIKE and csl_type != "chapter" else ""
    if csl_type in {"paper-conference", "chapter"} or entry_type in {"proceedings", "inproceedings", "incollection", "inbook"}:
        container = text("booktitle") or container or text("journal", "journaltitle")
    elif not container:
        container = text("journal", "journaltitle", "booktitle")
    if container:
        csl["container-title"] = container
    if csl_type == "thesis":
        genre = THESIS_GENRE.get(entry_type) or text("type")
        if genre:
            csl["genre"] = genre
    elif fields.get("type"):
        csl["genre"] = text("type")
    publisher = text("publisher") or text("institution") or text("school") or text("organization")
    if publisher:
        csl["publisher"] = publisher
    place = text("address", "location")
    if place:
        csl["publisher-place"] = place
    volume = text("volume")
    if volume:
        csl["volume"] = volume
    number = fields.get("number")
    issue_field = fields.get("issue")
    if issue_field:
        csl["issue"] = latex_to_text(issue_field)
        used.add("issue")
    if number:
        used.add("number")
        if csl_type in ARTICLE_LIKE and not issue_field:
            csl["issue"] = latex_to_text(number)
        else:
            csl["number"] = latex_to_text(number)
    pages = fields.get("pages")
    if pages:
        used.add("pages")
        csl["page"] = normalize_pages(pages)
    series = text("series")
    if series:
        csl["collection-title"] = series
    for src, dst in (("edition", "edition"), ("language", "language"), ("abstract", "abstract"),
                     ("note", "note"), ("isbn", "ISBN"), ("issn", "ISSN"), ("url", "URL")):
        value = text(src)
        if value:
            csl[dst] = value
    doi = normalize_doi(text("doi"))
    if doi:
        csl["DOI"] = doi
    keywords = text("keywords")
    if keywords:
        csl["keyword"] = keywords
    arxiv = arxiv_from_fields(fields)
    if arxiv:
        extra["arxiv_id"] = arxiv
    for name, value in fields.items():
        if name not in used:
            extra[name] = value
    return Record(
        entry_type=entry_type, source_key=entry.key, csl=csl, extra=extra, raw=entry.raw,
        line=entry.line, warnings=list(entry.warnings), fmt="bibtex",
    )


# ---------- Record -> papers columns ----------


def paper_columns(record: Record) -> dict[str, Any]:
    csl = record.csl
    authors = [display_name(n) for n in csl.get("author", []) or csl.get("editor", [])]
    year = None
    parts = (csl.get("issued") or {}).get("date-parts") or []
    if parts and parts[0]:
        year = int(parts[0][0])
    pmid = None
    if record.fmt == "bibtex":
        pmid = None
    return {
        "title": csl.get("title") or record.source_key or "Untitled",
        "authors": authors,
        "year": year,
        "venue": csl.get("container-title") or csl.get("publisher"),
        "doi": csl.get("DOI"),
        "arxiv_id": record.extra.get("arxiv_id"),
        "pmid": record.extra.get("pmid") or pmid,
        "abstract": csl.get("abstract"),
        "bibtex_key": record.source_key,
    }
