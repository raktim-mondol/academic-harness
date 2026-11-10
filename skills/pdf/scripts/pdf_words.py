#!/usr/bin/env python3
"""Find where words sit on a page, to place text on a form that has no fields.

    pdf_words.py form.pdf --page 1                  # every word with its box
    pdf_words.py form.pdf --page 1 --grep "Name"    # only words matching (case-insensitive)

Coordinates are in PDF points from the TOP-LEFT of the page (x to the right, y
downward), the same convention pdf_overlay.py uses by default. Uses pdfplumber
when installed (word boxes); otherwise pypdf text chunks (coarser, but enough to
locate a label).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pdfcommon import open_reader  # noqa: E402


def words_pdfplumber(path, page_number, password=None):
    import pdfplumber
    with pdfplumber.open(path, password=password) as pdf:
        page = pdf.pages[page_number - 1]
        return [
            {"text": w["text"], "x0": round(w["x0"], 1), "top": round(w["top"], 1),
             "x1": round(w["x1"], 1), "bottom": round(w["bottom"], 1)}
            for w in page.extract_words()
        ], float(page.width), float(page.height)


def words_pypdf(path, page_number, password=None):
    reader = open_reader(path, password)
    page = reader.pages[page_number - 1]
    height = float(page.mediabox.height)
    width = float(page.mediabox.width)
    chunks = []

    def visit(text, cm, tm, font_dict, font_size):
        if text.strip():
            x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
            y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
            size = font_size or 10
            chunks.append({"text": text.strip(), "x0": round(x, 1), "top": round(height - y - size, 1),
                           "x1": round(x + len(text.strip()) * size * 0.5, 1), "bottom": round(height - y, 1)})

    page.extract_text(visitor_text=visit)
    return chunks, width, height


def find_words(path, page_number, grep=None, password=None):
    try:
        import pdfplumber  # noqa: F401
        words, width, height = words_pdfplumber(path, page_number, password)
        engine = "pdfplumber"
    except ImportError:
        words, width, height = words_pypdf(path, page_number, password)
        engine = "pypdf"
    if grep:
        needle = grep.lower()
        words = [w for w in words if needle in w["text"].lower()]
    return {"engine": engine, "page": page_number, "width": width, "height": height, "words": words}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pdf")
    ap.add_argument("--page", type=int, default=1)
    ap.add_argument("--grep")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--password")
    args = ap.parse_args(argv)
    try:
        result = find_words(args.pdf, args.page, args.grep, args.password)
    except (ValueError, OSError, IndexError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    print(f"page {result['page']}: {result['width']:.0f} x {result['height']:.0f} pt ({result['engine']})")
    for w in result["words"]:
        print(f"x0={w['x0']:<7} top={w['top']:<7} x1={w['x1']:<7} bottom={w['bottom']:<7} {w['text']!r}")
    return 0 if result["words"] else 1


if __name__ == "__main__":
    sys.exit(main())
