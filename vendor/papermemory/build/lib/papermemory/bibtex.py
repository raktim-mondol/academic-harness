from __future__ import annotations

import re
from typing import Any


def _unbrace(value: str) -> str:
    value = value.strip()
    if (value.startswith("{") and value.endswith("}")) or (value.startswith('"') and value.endswith('"')):
        value = value[1:-1]
    value = value.replace("\\&", "&")
    value = re.sub(r"\{([^{}]*)\}", r"\1", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def _split_authors(raw: str) -> list[str]:
    if not raw:
        return []
    parts = re.split(r"\s+and\s+", raw, flags=re.I)
    names: list[str] = []
    for part in parts:
        part = part.strip()
        if not part or part.lower() == "others":
            continue
        if "," in part:
            last, first = part.split(",", 1)
            names.append(f"{first.strip()} {last.strip()}".strip())
        else:
            names.append(part)
    return names


def parse_bibtex(text: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    i = 0
    n = len(text)
    while i < n:
        at = text.find("@", i)
        if at < 0:
            break
        m = re.match(r"@(\w+)\s*\{", text[at:], re.I)
        if not m:
            i = at + 1
            continue
        entry_type = m.group(1).lower()
        if entry_type in {"comment", "preamble", "string"}:
            i = at + m.end()
            continue
        start = at + m.end()
        depth = 1
        j = start
        while j < n and depth:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1
        body = text[start : j - 1]
        i = j
        comma = body.find(",")
        if comma < 0:
            continue
        key = body[:comma].strip()
        fields_blob = body[comma + 1 :]
        fields: dict[str, str] = {}
        for field_match in re.finditer(
            r"(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|\"[^\"]*\"|[^\s,]+)\s*,?",
            fields_blob,
            re.S,
        ):
            fields[field_match.group(1).lower()] = _unbrace(field_match.group(2))
        year = None
        if fields.get("year"):
            ym = re.search(r"\d{4}", fields["year"])
            if ym:
                year = int(ym.group(0))
        venue = fields.get("journal") or fields.get("booktitle") or fields.get("institution") or fields.get("publisher")
        doi = fields.get("doi")
        url = fields.get("url")
        arxiv_id = None
        eprint = fields.get("eprint") or fields.get("arxiv")
        if (fields.get("archiveprefix") or "").lower() == "arxiv" and eprint:
            arxiv_id = eprint
        elif eprint and re.match(r"\d{4}\.\d{4,5}", eprint):
            arxiv_id = eprint
        entries.append(
            {
                "entry_type": entry_type,
                "bibtex_key": key,
                "title": fields.get("title") or key,
                "authors": _split_authors(fields.get("author") or fields.get("editor") or ""),
                "year": year,
                "venue": venue,
                "doi": doi,
                "arxiv_id": arxiv_id,
                "pmid": fields.get("pmid"),
                "url": url,
                "abstract": fields.get("abstract"),
                "pages": fields.get("pages"),
                "volume": fields.get("volume"),
                "bibtex": "@" + entry_type + "{" + key + "," + fields_blob.rstrip() + "\n}",
                "fields": fields,
            }
        )
    return entries
