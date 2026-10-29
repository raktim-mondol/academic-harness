#!/usr/bin/env python3
"""Read a manuscript as plain text for the local audit tools.

One parser for `.tex`, `.md`, `.txt`, and `.docx`, shared by `stat_audit.py`
and `reporting_text.py`. DOCX parsing uses defusedxml when available and caps
the XML size; the standard library fallback keeps the tool usable on a minimal
Python install.
"""
import re
import zipfile

try:
    from defusedxml import ElementTree
except Exception:  # defusedxml is optional; the fallback rejects DTDs and entities
    from xml.etree import ElementTree

    def _stdlib_parse(xml):
        if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
            raise ValueError("docx XML contains a DTD or entity declaration")
        return ElementTree.fromstring(xml)

    class _HardenedTree:
        fromstring = staticmethod(_stdlib_parse)

    ElementTree = _HardenedTree

MAX_DOCX_XML_BYTES = 50 * 1024 * 1024
WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_text(path):
    with zipfile.ZipFile(path) as archive:
        info = archive.getinfo("word/document.xml")
        if info.file_size > MAX_DOCX_XML_BYTES:
            raise ValueError("docx document.xml is too large to read safely")
        xml = archive.read(info)
    root = ElementTree.fromstring(xml)
    paragraphs = []
    for paragraph in root.iter(f"{WORD_NS}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{WORD_NS}t")).strip()
        level = _heading_level(paragraph)
        if text and level:
            paragraphs.append(f"{'#' * level} {text}")
        elif text:
            paragraphs.append(text)
    return "\n\n".join(paragraphs)


def _heading_level(paragraph):
    props = paragraph.find(f"{WORD_NS}pPr")
    if props is None:
        return 0
    style = props.find(f"{WORD_NS}pStyle")
    if style is not None:
        value = style.get(f"{WORD_NS}val", "")
        match = re.search(r"heading\s*([1-9])", value, re.I) or re.fullmatch(r"([1-9])", value)
        if match:
            return int(match.group(1))
    outline = props.find(f"{WORD_NS}outlineLvl")
    if outline is not None:
        try:
            return min(6, int(outline.get(f"{WORD_NS}val", "0")) + 1)
        except ValueError:
            return 0
    return 0


def read_source(request):
    text = request.get("text")
    path = request.get("path")
    if text:
        return None, str(text)
    if not path:
        raise ValueError("give a path or text")
    lower = path.lower()
    if lower.endswith(".docx"):
        return path, docx_text(path)
    if not lower.endswith((".tex", ".md", ".markdown", ".txt", ".text")):
        raise ValueError("path must end in .tex, .md, .txt, or .docx")
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return path, handle.read()
