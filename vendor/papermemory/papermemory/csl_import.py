"""CSL-JSON reader (stdlib only)."""
from __future__ import annotations

import json
from typing import Any

from papermemory.bibrecord import BIB_TO_CSL_TYPE, Record
from papermemory.util import normalize_arxiv, normalize_doi

_CSL_TO_BIB = {
    "article-journal": "article", "paper-conference": "inproceedings", "book": "book",
    "chapter": "incollection", "thesis": "phdthesis", "report": "techreport",
    "webpage": "online", "manuscript": "unpublished", "patent": "patent",
    "dataset": "dataset", "software": "software", "article-magazine": "article",
    "article-newspaper": "article",
}
assert set(_CSL_TO_BIB.values()) <= set(BIB_TO_CSL_TYPE) | {"misc"}


def _items(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for name in ("items", "references", "data"):
            if isinstance(data.get(name), list):
                return data[name]
        return [data]
    return []


def parse_csl_json(text: str) -> tuple[list[Record], list[dict[str, Any]]]:
    errors: list[dict[str, Any]] = []
    try:
        data = json.loads(text.lstrip("﻿"))
    except ValueError as exc:
        return [], [{"line": getattr(exc, "lineno", None), "key": None, "message": f"invalid JSON: {exc}"}]
    records: list[Record] = []
    for index, item in enumerate(_items(data), 1):
        if not isinstance(item, dict):
            errors.append({"line": None, "key": None, "message": f"item {index} is not an object"})
            continue
        csl = dict(item)
        key = csl.get("citation-key") or csl.get("citationKey") or csl.get("id")
        key = str(key) if key not in (None, "") else None
        if csl.get("DOI"):
            csl["DOI"] = normalize_doi(str(csl["DOI"])) or csl["DOI"]
        csl_type = csl.get("type") or "document"
        extra: dict[str, Any] = {}
        arxiv = csl.pop("arxiv_id", None) or (csl.get("number") if str(csl.get("archive", "")).lower() == "arxiv" else None)
        if arxiv and normalize_arxiv(str(arxiv)):
            extra["arxiv_id"] = normalize_arxiv(str(arxiv))
        records.append(Record(
            entry_type=_CSL_TO_BIB.get(csl_type, "misc"), source_key=key, csl=csl, extra=extra,
            raw=None, line=None, warnings=[], fmt="csl-json",
        ))
    return records, errors
