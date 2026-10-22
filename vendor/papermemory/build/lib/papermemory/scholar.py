from __future__ import annotations

import json
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Any

from papermemory.util import normalize_arxiv, normalize_doi

USER_AGENT = "papermemory/0.1 (academic-memory; local research tool)"
TIMEOUT = 20


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def fetch_arxiv(arxiv_id: str) -> dict[str, Any]:
    aid = normalize_arxiv(arxiv_id)
    if not aid:
        raise ValueError("invalid arxiv id")
    url = "https://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(aid)
    xml = _get(url)
    root = ET.fromstring(xml)
    ns = {"a": "http://www.w3.org/2005/Atom"}
    entry = root.find("a:entry", ns)
    if entry is None:
        raise LookupError(f"arxiv id not found: {aid}")
    title = (entry.findtext("a:title", default="", namespaces=ns) or "").strip()
    abstract = (entry.findtext("a:summary", default="", namespaces=ns) or "").strip()
    published = entry.findtext("a:published", default="", namespaces=ns) or ""
    year = int(published[:4]) if published[:4].isdigit() else None
    authors = []
    for author in entry.findall("a:author", ns):
        name = author.findtext("a:name", default="", namespaces=ns)
        if name:
            authors.append(name.strip())
    doi = None
    pdf_url = None
    abs_url = None
    for link in entry.findall("a:link", ns):
        href = link.attrib.get("href", "")
        if link.attrib.get("type") == "application/pdf":
            pdf_url = href
        if link.attrib.get("rel") == "alternate":
            abs_url = href
        if "doi" in href.lower():
            doi = normalize_doi(href)
    for extra in entry.findall("{http://arxiv.org/schemas/atom}doi"):
        doi = normalize_doi(extra.text) or doi
    return {
        "title": " ".join(title.split()),
        "authors": authors,
        "year": year,
        "venue": "arXiv",
        "doi": doi,
        "arxiv_id": aid,
        "url": abs_url or f"https://arxiv.org/abs/{aid}",
        "pdf_url": pdf_url or f"https://arxiv.org/pdf/{aid}.pdf",
        "abstract": " ".join(abstract.split()),
        "source_type": "arxiv",
        "verified": 1,
        "verification_note": "arxiv",
    }


def fetch_crossref(doi: str) -> dict[str, Any]:
    doi_n = normalize_doi(doi)
    if not doi_n:
        raise ValueError("invalid doi")
    url = "https://api.crossref.org/works/" + urllib.parse.quote(doi_n)
    payload = json.loads(_get(url).decode("utf-8"))
    msg = payload.get("message") or {}
    title_list = msg.get("title") or ["Untitled"]
    authors = []
    for item in msg.get("author") or []:
        given = (item.get("given") or "").strip()
        family = (item.get("family") or "").strip()
        name = f"{given} {family}".strip() or item.get("name")
        if name:
            authors.append(name)
    year = None
    for date_field in ("published-print", "published-online", "issued"):
        parts = ((msg.get(date_field) or {}).get("date-parts") or [[]])[0]
        if parts:
            year = int(parts[0])
            break
    venue_list = msg.get("container-title") or []
    abstract = msg.get("abstract")
    if abstract:
        abstract = re_strip_xml(abstract)
    return {
        "title": title_list[0],
        "authors": authors,
        "year": year,
        "venue": venue_list[0] if venue_list else None,
        "doi": doi_n,
        "url": msg.get("URL") or f"https://doi.org/{doi_n}",
        "abstract": abstract,
        "source_type": "crossref",
        "verified": 1,
        "verification_note": "crossref",
    }


def re_strip_xml(text: str) -> str:
    import re

    return re.sub(r"<[^>]+>", " ", text).strip()
