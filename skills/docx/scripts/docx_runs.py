"""Shared helpers for docx_track.py and docx_comments.py.

Word stores text in "runs" (`w:r`) inside paragraphs (`w:p`). A phrase you can
see in one piece is often several runs, because formatting or editing history
split it. To change part of it without disturbing the formatting around it, a
run is split at the edge of the match so the matched text sits in whole runs of
its own.

Scope, stated plainly: matching looks at runs that are direct children of a
paragraph or of a hyperlink, and at text held in a single `w:t`. A run that
holds a tab, break, field or drawing is opaque (it counts as one character no
match can cover). Text already inside a tracked insertion or deletion is not
matched. A phrase split across a hyperlink boundary is not matched.
"""
from __future__ import annotations

import copy
import datetime as _dt
import zipfile
from pathlib import Path

from lxml import etree

NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS_XML = "http://www.w3.org/XML/1998/namespace"
OPAQUE = "￼"


def w(tag: str) -> str:
    return f"{{{NS_W}}}{tag}"


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ----------------------------------------------------------------------- file io


def read_parts(path: str | Path) -> dict[str, bytes]:
    """All members of a docx as an ordered {name: bytes} dict."""
    with zipfile.ZipFile(path) as zf:
        return {i.filename: zf.read(i) for i in zf.infolist() if not i.is_dir()}


def parse(data: bytes):
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False)
    root = etree.fromstring(data, parser)
    if root.getroottree().docinfo.doctype:
        raise ValueError("DOCTYPE declarations are not allowed")
    return root


def serialize(root) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def write_parts(parts: dict[str, bytes], out_path: str | Path) -> None:
    """Write parts back with [Content_Types].xml first. Atomic via a temp file."""
    out_path = Path(out_path)
    order = [n for n in ("[Content_Types].xml", "_rels/.rels") if n in parts]
    order += [n for n in parts if n not in order]
    tmp = out_path.with_name(out_path.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in order:
            zf.writestr(name, parts[name])
    tmp.replace(out_path)


def next_annotation_id(*roots) -> int:
    """One more than the largest w:id on any annotation element in the given parts."""
    highest = -1
    for root in roots:
        if root is None:
            continue
        for el in root.iter():
            raw = el.get(w("id"))
            if raw is not None and raw.lstrip("-").isdigit():
                highest = max(highest, int(raw))
    return highest + 1


# ------------------------------------------------------------------- run handling


def run_text(run) -> str | None:
    """Text of a plain run, or None when the run holds anything but rPr and one w:t."""
    kids = [k for k in run if k.tag != w("rPr")]
    if len(kids) == 1 and kids[0].tag == w("t"):
        return kids[0].text or ""
    return None


def containers(paragraph):
    yield paragraph
    yield from paragraph.findall(w("hyperlink"))


def container_runs(container):
    return [child for child in container if child.tag == w("r")]


def flatten(container):
    """(text, spans) where spans[i] = (run, start, end) over the joined text."""
    parts: list[str] = []
    spans = []
    pos = 0
    for run in container_runs(container):
        text = run_text(run)
        piece = OPAQUE if text is None else text
        spans.append((run, pos, pos + len(piece), text is not None))
        parts.append(piece)
        pos += len(piece)
    return "".join(parts), spans


def _set_text(run, text: str) -> None:
    t = run.find(w("t"))
    t.text = text
    t.set(f"{{{NS_XML}}}space", "preserve")


def split_run(run, offset: int):
    """Split a plain run at `offset` characters; returns (left, right)."""
    right = copy.deepcopy(run)
    text = run.find(w("t")).text or ""
    _set_text(run, text[:offset])
    _set_text(right, text[offset:])
    run.addnext(right)
    return run, right


def isolate(container, start: int, end: int):
    """Split runs so [start, end) of the container's text is covered by whole runs.

    Returns the list of those runs, or None when the range touches an opaque run.
    """
    for boundary in (start, end):
        _, spans = flatten(container)
        for run, s, e, plain in spans:
            if s < boundary < e:
                if not plain:
                    return None
                split_run(run, boundary - s)
                break
    _, spans = flatten(container)
    chosen = [run for run, s, e, plain in spans if s >= start and e <= end and e > s]
    if any(not plain for run, s, e, plain in spans if s >= start and e <= end):
        return None
    return chosen or None


def find_all(container, needle: str, case_sensitive: bool = True, begin: int = 0):
    """Non-overlapping (start, end) matches in the container's text from `begin`."""
    text, _ = flatten(container)
    hay = text if case_sensitive else text.lower()
    pin = needle if case_sensitive else needle.lower()
    out = []
    i = hay.find(pin, begin)
    while i != -1:
        out.append((i, i + len(pin)))
        i = hay.find(pin, i + len(pin))
    return out


def paragraph_text(paragraph) -> str:
    return "".join(t.text or "" for t in paragraph.iter(w("t")))
