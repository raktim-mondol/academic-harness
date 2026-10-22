from __future__ import annotations

import re
from dataclasses import dataclass

from papermemory.util import normalize_arxiv, normalize_doi, normalize_title

FRONTMATTER_WHITELIST = {
    "doi": "str",
    "arxiv_id": "str",
    "pmid": "str",
    "title": "str",
    "authors": "list",
    "year": "int",
    "venue": "str",
    "bibtex_key": "str",
    "language": "str",
    "origin_channel": "str",
    "license": "str",
}

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s)>\]]+")


class Refusal(Exception):
    def __init__(self, code: str, detail: str | None = None):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class Identity:
    kind: str
    value: str
    title: str | None = None
    title_source: str | None = None
    year: int | None = None


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _parse_scalar(raw: str, kind: str, key: str):
    if kind == "int":
        if not re.fullmatch(r"\d{1,4}", raw):
            raise Refusal("frontmatter-type", f"{key}={raw!r}")
        return int(raw)
    if kind == "list":
        if not (raw.startswith("[") and raw.endswith("]")):
            raise Refusal("frontmatter-type", f"{key}={raw!r}")
        inner = raw[1:-1].strip()
        if not inner:
            return []
        return [_unquote(part.strip()) for part in inner.split(",") if part.strip()]
    if raw.startswith("{") or raw.startswith("["):
        raise Refusal("frontmatter-type", f"{key}={raw!r}")
    return _unquote(raw)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---\n"):
        if text.lstrip().startswith("---"):
            raise Refusal("frontmatter-not-at-byte-0")
        return {}, text
    lines = text.split("\n")
    end = None
    for i in range(1, min(len(lines), 81)):
        if lines[i] == "---":
            end = i
            break
    if end is None:
        raise Refusal("frontmatter-unclosed")
    fm: dict = {}
    list_key: str | None = None
    for line in lines[1:end]:
        if not line.strip():
            continue
        if line.startswith("  - "):
            if list_key is None:
                raise Refusal("frontmatter-nested-value")
            fm.setdefault(list_key, []).append(_unquote(line[4:].strip()))
            continue
        if line.startswith((" ", "\t")):
            raise Refusal("frontmatter-nested-value")
        if ":" not in line:
            raise Refusal("frontmatter-type", line)
        key, raw = line.split(":", 1)
        key, raw = key.strip(), raw.strip()
        if key not in FRONTMATTER_WHITELIST:
            raise Refusal("frontmatter-unknown-field", key)
        if raw == "":
            if FRONTMATTER_WHITELIST[key] != "list":
                raise Refusal("frontmatter-type", key)
            list_key = key
            fm[key] = []
            continue
        list_key = None
        fm[key] = _parse_scalar(raw, FRONTMATTER_WHITELIST[key], key)
    return fm, "\n".join(lines[end + 1:]).lstrip("\n")


def _h1_and_leading_doi(body: str) -> tuple[str | None, str | None]:
    lines = body.split("\n")
    title = None
    start = 0
    while start < len(lines) and not lines[start].strip():
        start += 1
    if start < len(lines) and re.match(r"^#\s+\S", lines[start]):
        title = lines[start][1:].strip()
        start += 1
    for line in lines[start:]:
        if re.match(r"^#{1,6}\s", line):
            break
        match = DOI_RE.search(line)
        if match:
            return title, match.group(0).rstrip(".,;")
    return title, None


def resolve_identity(
    fm: dict,
    *,
    doi: str | None = None,
    arxiv_id: str | None = None,
    title: str | None = None,
    year: int | None = None,
    body_text: str = "",
) -> Identity:
    doi_value = normalize_doi(doi) or normalize_doi(fm.get("doi"))
    if doi_value:
        return Identity("doi", doi_value, fm.get("title") or title, "frontmatter" if fm.get("doi") else "caller", fm.get("year") or year)
    arxiv_value = normalize_arxiv(arxiv_id) or normalize_arxiv(fm.get("arxiv_id"))
    if arxiv_value:
        return Identity("arxiv_id", arxiv_value, fm.get("title") or title, "frontmatter" if fm.get("arxiv_id") else "caller", fm.get("year") or year)
    pmid = (fm.get("pmid") or "").strip()
    if pmid:
        return Identity("pmid", pmid, fm.get("title") or title, "frontmatter", fm.get("year") or year)
    h1, body_doi = _h1_and_leading_doi(body_text)
    if body_doi:
        return Identity("doi", normalize_doi(body_doi), fm.get("title") or h1, "h1", fm.get("year") or year)
    resolved_title = (fm.get("title") or title or h1 or "").strip()
    if not resolved_title:
        raise Refusal("identity-unresolved")
    resolved_year = fm.get("year") or year
    source = "frontmatter" if fm.get("title") else ("h1" if h1 else "caller")
    return Identity(
        "title_year",
        f"{normalize_title(resolved_title)}|{resolved_year or ''}",
        resolved_title,
        source,
        resolved_year,
    )
