#!/usr/bin/env python3
"""Extract text (and optionally tables) from a PDF.

    pdf_text.py paper.pdf                      # all pages, reading order
    pdf_text.py paper.pdf --pages 2-4 --layout # keep column and spacing layout
    pdf_text.py paper.pdf --json               # [{"page": 1, "chars": 1830, "text": "..."}]
    pdf_text.py paper.pdf --tables             # needs pdfplumber; tables as Markdown

A page with almost no extractable text is reported as probably scanned: it has
no text layer and needs OCR (see references/reference.md).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pdfcommon import open_reader, parse_pages  # noqa: E402

SCANNED_BELOW_CHARS = 20


def extract_pages(path, pages=None, layout=False, password=None):
    reader = open_reader(path, password)
    indexes = parse_pages(pages, len(reader.pages))
    out = []
    for i in indexes:
        mode = "layout" if layout else "plain"
        text = reader.pages[i].extract_text(extraction_mode=mode) or ""
        out.append({"page": i + 1, "chars": len(text.strip()), "text": text,
                    "probably_scanned": len(text.strip()) < SCANNED_BELOW_CHARS})
    return out


def extract_tables(path, pages=None, password=None):
    try:
        import pdfplumber
    except ImportError:
        raise SystemExit("--tables needs pdfplumber (pip install pdfplumber)")
    found = []
    with pdfplumber.open(path, password=password) as pdf:
        for i in parse_pages(pages, len(pdf.pages)):
            for n, table in enumerate(pdf.pages[i].extract_tables(), start=1):
                found.append({"page": i + 1, "table": n, "rows": table})
    return found


def to_markdown(rows):
    clean = [[("" if c is None else str(c).replace("\n", " ").strip()) for c in row] for row in rows]
    if not clean:
        return ""
    width = max(len(r) for r in clean)
    clean = [r + [""] * (width - len(r)) for r in clean]
    lines = ["| " + " | ".join(clean[0]) + " |", "|" + "---|" * width]
    lines += ["| " + " | ".join(r) + " |" for r in clean[1:]]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pdf")
    ap.add_argument("--pages", help="e.g. 1-3,7 (1-based)")
    ap.add_argument("--layout", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--tables", action="store_true")
    ap.add_argument("--password")
    args = ap.parse_args(argv)
    try:
        if args.tables:
            tables = extract_tables(args.pdf, args.pages, args.password)
            if args.json:
                print(json.dumps(tables, indent=2))
            else:
                for t in tables:
                    print(f"\n[page {t['page']}, table {t['table']}]\n{to_markdown(t['rows'])}")
                if not tables:
                    print("no tables detected (ruled tables work best; try --layout text instead)")
            return 0
        pages = extract_pages(args.pdf, args.pages, args.layout, args.password)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(pages, indent=2))
        return 0
    for p in pages:
        print(f"\n--- page {p['page']} ---")
        print(p["text"] if not p["probably_scanned"] else "[no text layer: probably a scan; OCR needed]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
