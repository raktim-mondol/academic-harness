#!/usr/bin/env python3
"""Print the structure and text of a .pptx, slide by slide.

    pptx_outline.py talk.pptx              # readable outline
    pptx_outline.py talk.pptx --notes      # include speaker notes
    pptx_outline.py talk.pptx --json       # machine-readable

Per slide: layout name, title, text with bullet levels, tables (as rows),
charts, pictures (with their alt text), and optionally speaker notes. Use it to
read an existing deck, to find what to change, and to confirm after an edit that
the deck says what you meant. It reads the file and never modifies it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pptxcommon import Presentation, alt_text, is_picture, title_text, walk  # noqa: E402


def outline(path, notes=False):
    prs = Presentation(path)
    slides = []
    for number, slide in enumerate(prs.slides, start=1):
        entry = {"slide": number, "layout": slide.slide_layout.name, "title": title_text(slide),
                 "text": [], "tables": [], "charts": 0, "pictures": []}
        title_shape = slide.shapes.title
        for shape in walk(slide.shapes):
            if title_shape is not None and shape.shape_id == title_shape.shape_id:
                continue
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                lines = [(p.level, "".join(r.text for r in p.runs).strip()) for p in shape.text_frame.paragraphs]
                lines = [{"level": lvl, "text": txt} for lvl, txt in lines if txt]
                if lines:
                    entry["text"].append({"shape": shape.name, "lines": lines})
            if getattr(shape, "has_table", False) and shape.has_table:
                entry["tables"].append([[cell.text.strip() for cell in row.cells] for row in shape.table.rows])
            if getattr(shape, "has_chart", False) and shape.has_chart:
                entry["charts"] += 1
            if is_picture(shape):
                entry["pictures"].append({"shape": shape.name, "alt": alt_text(shape)})
        if notes and slide.has_notes_slide:
            entry["notes"] = slide.notes_slide.notes_text_frame.text.strip()
        slides.append(entry)
    return {"file": str(path), "slides": slides}


def render(data):
    out = []
    for s in data["slides"]:
        out.append(f"\n[{s['slide']}] {s['title'] or '(no title)'}   <{s['layout']}>")
        for block in s["text"]:
            for line in block["lines"]:
                out.append(f"    {'  ' * line['level']}- {line['text']}")
        for t in s["tables"]:
            if t:
                out.append(f"    table {len(t)}x{len(t[0])}, header: " + " | ".join(t[0]))
            else:
                out.append("    table (empty)")
        if s["charts"]:
            out.append(f"    {s['charts']} chart(s)")
        for p in s["pictures"]:
            out.append(f"    picture {p['shape']!r} alt={p['alt']!r}")
        if s.get("notes"):
            out.append(f"    notes: {s['notes'][:200]}")
    return "\n".join(out).lstrip("\n")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pptx")
    ap.add_argument("--notes", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    try:
        data = outline(args.pptx, args.notes)
    except Exception as exc:  # noqa: BLE001 - python-pptx raises several types for bad packages
        print(f"error: cannot read {args.pptx}: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(data, indent=2) if args.json else render(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
