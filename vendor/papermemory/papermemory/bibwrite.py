"""Writers: BibTeX / BibLaTeX, RIS, CSV, CSL-JSON from a stored reference record.

Values come from the original BibTeX entry when the record was imported from
BibTeX (so the author's LaTeX accents and case-protection braces survive) and
from the CSL record otherwise (escaped for BibTeX). Output is deterministic:
fixed field order, entries sorted by key, so exports diff cleanly in git.
"""
from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

from papermemory.bibparse import parse_bib

DIALECTS = ("bibtex", "biblatex")
MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

# Fields that are never written to a bibliography unless the caller asks for everything.
INTERNAL_EXTRA = {
    "title_raw", "et_al", "arxiv_id", "year_raw", "month_raw", "date_raw", "ris_type", "ris_id", "accession",
    "pdf", "file",  # local file paths: stored, but not exported by default
}
LOCAL_PATH_FIELDS = {"pdf", "file"}

_CLASSIC_TYPE = {
    "conference": "inproceedings", "mvbook": "book", "bookinbook": "inbook", "suppbook": "inbook",
    "collection": "book", "mvcollection": "book", "reference": "book", "inreference": "incollection",
    "mvproceedings": "proceedings", "suppperiodical": "article", "suppcollection": "incollection",
    "report": "techreport", "online": "misc", "electronic": "misc", "www": "misc", "dataset": "misc",
    "software": "misc", "patent": "misc", "periodical": "misc", "thesis": "phdthesis",
}
_CLASSIC_KNOWN = {
    "article", "book", "booklet", "inbook", "incollection", "inproceedings", "manual", "mastersthesis",
    "misc", "phdthesis", "proceedings", "techreport", "unpublished",
}
_BIBLATEX_KNOWN = _CLASSIC_KNOWN | {
    "online", "report", "thesis", "dataset", "software", "patent", "periodical", "collection", "reference",
    "inreference", "mvbook", "mvcollection", "mvproceedings", "mvreference", "bookinbook", "suppbook",
    "suppcollection", "suppperiodical",
}
_BIBLATEX_ALIAS = {"conference": "inproceedings", "electronic": "online", "www": "online"}

FIELD_ORDER = [
    "author", "editor", "translator", "title", "journal", "journaltitle", "booktitle", "series", "school",
    "institution", "publisher", "organization", "address", "location", "edition", "volume", "number", "pages",
    "year", "month", "date", "type", "isbn", "issn", "doi", "eprint", "archiveprefix", "eprinttype",
    "primaryclass", "eprintclass", "url", "language", "keywords", "abstract", "note", "howpublished",
]
_RAW_TO_CLASSIC = {"journaltitle": "journal", "location": "address", "eprinttype": "archiveprefix", "eprintclass": "primaryclass"}
_RAW_TO_BIBLATEX = {"journal": "journaltitle", "address": "location", "archiveprefix": "eprinttype", "primaryclass": "eprintclass"}
_TEXT_FIELDS = (
    "title", "journal", "journaltitle", "booktitle", "series", "school", "institution", "publisher",
    "organization", "address", "location", "edition", "volume", "number", "type", "isbn", "issn", "language",
    "keywords", "abstract", "note", "howpublished", "pages", "author", "editor", "translator",
)


# ---------- text helpers ----------


def escape_bibtex(value: str) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    text = re.sub(r"([&%$#_])", r"\\\1", text)
    return text.replace("{", "\\{").replace("}", "\\}")


def _balanced(value: str) -> bool:
    depth = 0
    escaped = False
    for ch in value:
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


def format_name(name: dict[str, str]) -> str:
    if name.get("literal"):
        return "{" + escape_bibtex(name["literal"]) + "}"
    family = " ".join(p for p in (name.get("non-dropping-particle"), name.get("family")) if p)
    family = escape_bibtex(family)
    given = escape_bibtex(name.get("given", ""))
    suffix = escape_bibtex(name.get("suffix", ""))
    if not family:
        return given
    if suffix:
        return f"{family}, {suffix}, {given}" if given else f"{family}, {suffix}"
    return f"{family}, {given}" if given else family


def format_names(names: list[dict[str, str]], et_al: bool = False) -> str:
    parts = [format_name(n) for n in names]
    if et_al:
        parts.append("others")
    return " and ".join(p for p in parts if p)


def _date_parts(csl: dict[str, Any]) -> list[int]:
    parts = (csl.get("issued") or {}).get("date-parts") or []
    return [int(x) for x in parts[0]] if parts and parts[0] else []


def export_type(entry_type: str, csl: dict[str, Any], dialect: str) -> tuple[str, dict[str, str]]:
    """The entry type to write, and any field it implies (a thesis type)."""
    et = (entry_type or "misc").lower()
    genre = str(csl.get("genre") or "")
    if dialect == "bibtex":
        if et == "thesis":
            et = "mastersthesis" if re.search(r"master", genre, re.I) else "phdthesis"
        et = _CLASSIC_TYPE.get(et, et)
        return (et if et in _CLASSIC_KNOWN else "misc"), {}
    et = _BIBLATEX_ALIAS.get(et, et)
    implied: dict[str, str] = {}
    if et in {"phdthesis", "mastersthesis"}:
        implied["type"] = "mathesis" if et == "mastersthesis" else "phdthesis"
        et = "thesis"
    elif et == "techreport":
        et = "report"
        implied["type"] = "techreport"
    return (et if et in _BIBLATEX_KNOWN else "misc"), implied


def _raw_fields(raw: str | None) -> dict[str, str]:
    if not raw:
        return {}
    parsed = parse_bib(raw).entries
    if not parsed:
        return {}
    return {name: re.sub(r"\s+", " ", value).strip() for name, value in parsed[0].fields.items() if _balanced(value)}


def build_fields(
    *, entry_type: str, csl: dict[str, Any], extra: dict[str, Any], raw_bibtex: str | None,
    dialect: str, all_fields: bool = False, original_values: bool = True,
) -> tuple[str, dict[str, str]]:
    """(entry type, ordered field map) ready to print, for ``dialect``."""
    et, implied = export_type(entry_type, csl, dialect)
    rename = _RAW_TO_CLASSIC if dialect == "bibtex" else _RAW_TO_BIBLATEX
    raw = _raw_fields(raw_bibtex) if original_values else {}
    out: dict[str, str] = {}

    def from_raw(*names: str) -> str | None:
        for name in names:
            if raw.get(name):
                return raw[name]
        return None

    def put(name: str, value: str | None) -> None:
        if value:
            out[name] = value

    # names
    for role, raw_names in (("author", ("author",)), ("editor", ("editor",)), ("translator", ("translator",))):
        value = from_raw(*raw_names)
        if value is None and csl.get(role):
            value = format_names(csl[role], role in (extra.get("et_al") or []))
        put(role, value)
    # title: keep the author's case protection when we have it
    title = from_raw("title") or extra.get("title_raw") or (escape_bibtex(csl["title"]) if csl.get("title") else None)
    put("title", title if title and _balanced(title) else (escape_bibtex(csl.get("title", "")) or None))
    # container
    container = from_raw("journal", "journaltitle", "booktitle")
    csl_container = csl.get("container-title")
    is_book_part = et in {"inproceedings", "incollection", "inbook", "proceedings", "conference"}
    container_name = "booktitle" if is_book_part else ("journal" if et == "article" else "howpublished")
    if dialect == "biblatex" and container_name == "journal":
        container_name = "journaltitle"
    if raw:
        for name in ("journal", "journaltitle", "booktitle", "howpublished"):
            if raw.get(name):
                put(rename.get(name, name), raw[name])
    elif csl_container:
        put(container_name, escape_bibtex(csl_container))
    elif container:
        put(container_name, container)
    # publisher family
    publisher = from_raw("publisher", "institution", "school", "organization") or (
        escape_bibtex(csl["publisher"]) if csl.get("publisher") else None)
    if raw:
        for name in ("publisher", "institution", "school", "organization"):
            if raw.get(name):
                key = name
                if dialect == "biblatex" and name == "school":
                    key = "institution"
                put(key, raw[name])
    elif publisher:
        if et in {"phdthesis", "mastersthesis"}:
            put("school", publisher)
        elif et == "thesis" or et in {"report", "techreport"}:
            put("institution", publisher)
        else:
            put("publisher", publisher)
    place = from_raw("address", "location") or (escape_bibtex(csl["publisher-place"]) if csl.get("publisher-place") else None)
    put("address" if dialect == "bibtex" else "location", place)
    put("series", from_raw("series") or (escape_bibtex(csl["collection-title"]) if csl.get("collection-title") else None))
    put("edition", from_raw("edition") or (escape_bibtex(str(csl["edition"])) if csl.get("edition") else None))
    put("volume", from_raw("volume") or (escape_bibtex(str(csl["volume"])) if csl.get("volume") else None))
    number = from_raw("number") or from_raw("issue")
    if number is None:
        number = csl.get("issue") or csl.get("number")
        number = escape_bibtex(str(number)) if number else None
    put("number", number)
    pages = from_raw("pages") or (csl["page"].replace("–", "--") if csl.get("page") else None)
    put("pages", pages)
    # dates always come from the structured record
    parts = _date_parts(csl)
    if extra.get("year_raw"):
        put("year", re.sub(r"\s+", " ", str(extra["year_raw"])).strip())
    elif parts:
        if dialect == "biblatex" and len(parts) > 1:
            put("date", "-".join(f"{p:02d}" if i else str(p) for i, p in enumerate(parts)))
        else:
            put("year", str(parts[0]))
            if len(parts) > 1 and 1 <= parts[1] <= 12:
                put("month", MONTH_ABBR[parts[1] - 1])
            if len(parts) > 2:
                # classic BibTeX has no day field; an unknown `date` is ignored by it and kept for BibLaTeX and re-import
                put("date", "-".join(f"{p:02d}" if i else str(p) for i, p in enumerate(parts)))
    for name in ("type",):
        if implied.get(name):
            put(name, implied[name])
        elif from_raw(name):
            put(name, from_raw(name))
    put("isbn", from_raw("isbn") or csl.get("ISBN"))
    put("issn", from_raw("issn") or csl.get("ISSN"))
    put("doi", from_raw("doi") or csl.get("DOI"))
    arxiv = extra.get("arxiv_id")
    prefix_name = "archiveprefix" if dialect == "bibtex" else "eprinttype"
    if raw.get("eprint"):
        put("eprint", raw["eprint"])
        put(prefix_name, from_raw("archiveprefix", "eprinttype"))
        put("primaryclass" if dialect == "bibtex" else "eprintclass", from_raw("primaryclass", "eprintclass"))
    elif arxiv:
        put("eprint", arxiv)
        put(prefix_name, "arXiv")
    put("url", from_raw("url") or (csl.get("URL", "").replace("{", "").replace("}", "") or None))
    put("language", from_raw("language") or csl.get("language"))
    put("keywords", from_raw("keywords") or (escape_bibtex(csl["keyword"]) if csl.get("keyword") else None))
    put("abstract", from_raw("abstract") or (escape_bibtex(csl["abstract"]) if csl.get("abstract") else None))
    put("note", from_raw("note") or (escape_bibtex(csl["note"]) if csl.get("note") else None))
    if all_fields:
        used = set(out) | {"journal", "journaltitle", "booktitle", "publisher", "institution", "school", "organization",
                           "address", "location", "year", "month", "date", "eprint", "archiveprefix", "eprinttype",
                           "primaryclass", "eprintclass", "issue", "number"}
        for name, value in raw.items():
            if name not in used and name not in LOCAL_PATH_FIELDS and name not in out:
                out[name] = value
        for name, value in extra.items():
            if (name not in used and name not in INTERNAL_EXTRA and name not in out
                    and not name.startswith("ris_") and isinstance(value, (str, int, float))):
                out[name] = str(value)
    return et, out


def _ordered(fields: dict[str, str]) -> list[tuple[str, str]]:
    rank = {name: i for i, name in enumerate(FIELD_ORDER)}
    return sorted(fields.items(), key=lambda kv: (rank.get(kv[0], len(rank)), kv[0]))


def bib_entry(key: str, entry_type: str, fields: dict[str, str]) -> str:
    lines = [f"@{entry_type}{{{key},"]
    for name, value in _ordered(fields):
        lines.append(f"  {name} = {{{value}}},")
    lines.append("}")
    return "\n".join(lines)


def original_entry(key: str, raw_bibtex: str) -> str:
    """The imported entry as written, with only its key replaced."""
    return re.sub(r"^(@\s*[A-Za-z]+\s*[{(]\s*)[^,\n]*", lambda m: m.group(1) + key, raw_bibtex.strip(), count=1)


# ---------- RIS ----------

_CSL_TO_RIS = {
    "article-journal": "JOUR", "paper-conference": "CONF", "book": "BOOK", "chapter": "CHAP", "thesis": "THES",
    "report": "RPRT", "webpage": "ELEC", "manuscript": "UNPB", "patent": "PAT", "dataset": "DATA",
    "software": "COMP", "article-magazine": "MGZN", "article-newspaper": "NEWS",
}


def _ris_name(name: dict[str, str]) -> str:
    if name.get("literal"):
        return name["literal"]
    family = " ".join(p for p in (name.get("non-dropping-particle"), name.get("family")) if p)
    parts = [family, name.get("suffix", ""), name.get("given", "")]
    parts = [p for p in parts if p]
    return ", ".join(parts)


def ris_entry(key: str, csl: dict[str, Any], extra: dict[str, Any]) -> str:
    lines: list[tuple[str, str]] = [("TY", _CSL_TO_RIS.get(csl.get("type", ""), "GEN"))]
    for n in csl.get("author", []):
        lines.append(("AU", _ris_name(n)))
    for n in csl.get("editor", []):
        lines.append(("A2", _ris_name(n)))
    if csl.get("title"):
        lines.append(("TI", csl["title"]))
    if csl.get("container-title"):
        lines.append(("JO" if csl.get("type") == "article-journal" else "T2", csl["container-title"]))
    if csl.get("container-title-short"):
        lines.append(("JA", csl["container-title-short"]))
    parts = _date_parts(csl)
    if parts:
        lines.append(("PY", str(parts[0])))
        lines.append(("DA", "/".join([str(parts[0])] + [f"{p:02d}" for p in parts[1:]]) + ("/" * (3 - len(parts)) if len(parts) < 3 else "")))
    for tag, name in (("VL", "volume"), ("IS", "issue")):
        if csl.get(name):
            lines.append((tag, str(csl[name])))
    if csl.get("page"):
        start, _, end = str(csl["page"]).partition("–")
        lines.append(("SP", start))
        if end:
            lines.append(("EP", end))
    for tag, name in (("PB", "publisher"), ("CY", "publisher-place"), ("DO", "DOI"), ("UR", "URL"),
                      ("AB", "abstract"), ("N1", "note"), ("LA", "language"), ("T3", "collection-title"),
                      ("ET", "edition")):
        if csl.get(name):
            lines.append((tag, str(csl[name])))
    for name in ("ISSN", "ISBN"):
        if csl.get(name):
            lines.append(("SN", str(csl[name])))
    for kw in [k.strip() for k in str(csl.get("keyword", "")).split(",") if k.strip()]:
        lines.append(("KW", kw))
    if extra.get("arxiv_id") and not csl.get("URL"):
        lines.append(("UR", f"https://arxiv.org/abs/{extra['arxiv_id']}"))
    lines.append(("ID", key))
    lines.append(("ER", ""))
    return "\n".join(f"{tag}  - {value}".rstrip() if tag != "ER" else "ER  - " for tag, value in lines)


# ---------- CSV / JSON ----------

CSV_COLUMNS = ["key", "type", "title", "authors", "year", "venue", "doi", "arxiv", "url", "tags", "collections"]


def csv_text(rows: list[dict[str, Any]]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=CSV_COLUMNS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({c: row.get(c, "") for c in CSV_COLUMNS})
    return buffer.getvalue()


def json_text(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
