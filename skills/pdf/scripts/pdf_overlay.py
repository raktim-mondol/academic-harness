#!/usr/bin/env python3
"""Write text onto a PDF at given coordinates (for forms without fillable fields).

    pdf_overlay.py form.pdf marks.json -o filled.pdf [--origin top-left|bottom-left]

marks.json is a list; each mark has a 1-based page, x, y (points) and text:

    [{"page": 1, "x": 120, "y": 150, "text": "Ada Lovelace", "size": 11},
     {"page": 1, "x": 312, "y": 188, "text": "X"}]

Default origin is the top-left of the page, y growing downward, the same as
pdf_words.py reports, so you can put y a little below a label's `top`. `size`
defaults to 10 pt Helvetica. Text is drawn as new page content on top of the
original; nothing is removed. Render the result (pdf_render.py) and look before
sending: coordinates are easy to be a few points off.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pdfcommon import open_reader  # noqa: E402

from pypdf import PdfReader, PdfWriter  # noqa: E402


def overlay(src, marks, dest, origin="top-left", password=None):
    try:
        from reportlab.pdfgen import canvas
    except ImportError:
        raise RuntimeError("pdf_overlay.py needs reportlab (pip install reportlab)")
    reader = open_reader(src, password)
    by_page: dict[int, list[dict]] = {}
    for m in marks:
        for key in ("page", "x", "y", "text"):
            if key not in m:
                raise ValueError(f"mark is missing {key!r}: {m}")
        page = int(m["page"])
        if not 1 <= page <= len(reader.pages):
            raise ValueError(f"mark names page {page}; the PDF has {len(reader.pages)}")
        by_page.setdefault(page, []).append(m)

    writer = PdfWriter(clone_from=reader)
    for number, items in by_page.items():
        page = writer.pages[number - 1]
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(width, height))
        for m in items:
            y = height - float(m["y"]) if origin == "top-left" else float(m["y"])
            c.setFont(m.get("font", "Helvetica"), float(m.get("size", 10)))
            c.drawString(float(m["x"]), y, str(m["text"]))
        c.save()
        buf.seek(0)
        page.merge_page(PdfReader(buf).pages[0])
    writer.write(dest)
    return sum(len(v) for v in by_page.values())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pdf")
    ap.add_argument("marks")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--origin", choices=["top-left", "bottom-left"], default="top-left")
    ap.add_argument("--password")
    args = ap.parse_args(argv)
    try:
        marks = json.loads(Path(args.marks).read_text())
        if not isinstance(marks, list):
            raise ValueError("marks.json must be a list")
        n = overlay(args.pdf, marks, args.output, args.origin, args.password)
    except (ValueError, OSError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"wrote {n} mark(s) -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
