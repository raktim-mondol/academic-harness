"""Small helpers shared by the pdf scripts (page ranges, opening, field walking)."""
from __future__ import annotations

import sys

try:
    from pypdf import PdfReader
except ImportError:  # pragma: no cover - environment dependent
    sys.exit("these scripts need pypdf (pip install pypdf)")


def parse_pages(spec: str | None, count: int) -> list[int]:
    """'1-3,7,9-' -> zero-based page indexes. Pages are 1-based on the command line."""
    if not spec:
        return list(range(count))
    out: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            lo, _, hi = chunk.partition("-")
            first = int(lo) if lo else 1
            last = int(hi) if hi else count
        else:
            first = last = int(chunk)
        if first < 1 or last > count or first > last:
            raise ValueError(f"page range {chunk!r} is outside 1-{count}")
        out.extend(range(first - 1, last))
    return out


def open_reader(path: str, password: str | None = None) -> "PdfReader":
    reader = PdfReader(path)
    if reader.is_encrypted:
        # An empty user password opens many "protected" files.
        if not reader.decrypt(password or ""):
            raise ValueError(f"{path} is encrypted; pass --password")
    return reader


def qualified_name(annot) -> str:
    parts = []
    node = annot
    while node is not None:
        title = node.get("/T")
        if title is not None:
            parts.append(str(title))
        node = node.get("/Parent")
        node = node.get_object() if node is not None else None
    return ".".join(reversed(parts))


def inherited(annot, key):
    node = annot
    while node is not None:
        if key in node:
            return node[key]
        node = node.get("/Parent")
        node = node.get_object() if node is not None else None
    return None


def field_kind(annot) -> str:
    ft = inherited(annot, "/FT")
    flags = int(inherited(annot, "/Ff") or 0)
    if ft == "/Tx":
        return "text"
    if ft == "/Btn":
        if flags & (1 << 16):
            return "pushbutton"
        if flags & (1 << 15):
            return "radio"
        return "checkbox"
    if ft == "/Ch":
        return "dropdown" if flags & (1 << 17) else "list"
    if ft == "/Sig":
        return "signature"
    return "unknown"


def on_state(annot) -> str | None:
    """The non-Off appearance state of a checkbox or radio widget, e.g. '/Yes'."""
    ap = annot.get("/AP")
    if ap is None:
        return None
    normal = ap.get_object().get("/N")
    if normal is None:
        return None
    states = [str(k) for k in normal.get_object().keys() if str(k) != "/Off"]
    return states[0] if states else None
