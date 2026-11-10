#!/usr/bin/env python3
"""Check a .pptx against common slide-quality rules.

    pptx_check.py talk.pptx [--min-font 14] [--max-words 90] [--strict] [--json]

Errors (exit 1):
  off-slide      a shape extends beyond the slide edge
Warnings (exit 1 only with --strict):
  no-title       slide has no title text (breaks navigation and screen readers)
  alt-text       a picture has no alt text, or only a file name (python-pptx and
                 PowerPoint insert the file name by default)
  small-font     an explicitly sized run is below --min-font points (default 14)
  empty-placeholder   a placeholder left empty (shows "Click to add text" when editing)
  may-overflow   estimated text height exceeds its box (a rough estimate: it
                 assumes an average character width, so confirm by rendering)
  too-much-text  more than --max-words words on one slide (default 90)
  overlap        two shapes cover much of the same area (title/background
                 placeholders and full-slide pictures are ignored)

Reads only. Sizes inherited from a layout or theme are not visible to this
script, so a clean result does not prove the text is large enough: render the
slides (pptx_thumbs.py) and look.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pptxcommon import Presentation, alt_text, box, is_picture, slide_size, title_text, walk  # noqa: E402

FILENAME_ALT = re.compile(r"^[\w\-. ]+\.(png|jpe?g|gif|bmp|tiff?|svg|emf|wmf|webp)$", re.I)
AVG_CHAR_WIDTH = 0.5   # of the font size; a typical sans-serif average
LINE_HEIGHT = 1.2
OVERLAP_SHARE = 0.4


def _explicit_sizes(shape):
    sizes = []
    for p in shape.text_frame.paragraphs:
        for r in p.runs:
            if r.font.size is not None and r.text.strip():
                sizes.append(r.font.size.pt)
    return sizes


def _estimate_overflow(shape, b):
    sizes = _explicit_sizes(shape)
    if not sizes:
        return False
    size = max(sizes)
    width = (b[2] - b[0]) - 14.4   # default left+right inset
    if width <= size:
        return False
    per_line = max(1, int(width / (size * AVG_CHAR_WIDTH)))
    lines = 0
    for p in shape.text_frame.paragraphs:
        text = "".join(r.text for r in p.runs)
        lines += max(1, -(-len(text) // per_line)) if text else 1
    return lines * size * LINE_HEIGHT > (b[3] - b[1]) - 7.2 + 0.5


def _overlap(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) or 1
    return (w * h) / smaller


def check(path, min_font=14, max_words=90):
    prs = Presentation(path)
    sw, sh = slide_size(prs)
    findings = []

    def add(slide_no, shape, kind, level, detail):
        findings.append({"slide": slide_no, "shape": getattr(shape, "name", None), "kind": kind, "level": level, "detail": detail})

    for number, slide in enumerate(prs.slides, start=1):
        if not title_text(slide):
            add(number, None, "no-title", "warning", "slide has no title text")
        words = 0
        placed = []
        for shape in walk(slide.shapes):
            b = box(shape)
            is_ph = shape.is_placeholder
            if b is not None and (b[0] < -1 or b[1] < -1 or b[2] > sw + 1 or b[3] > sh + 1):
                add(number, shape, "off-slide", "error",
                    f"extends beyond the {sw:.0f}x{sh:.0f} pt slide (box {b[0]:.0f},{b[1]:.0f} to {b[2]:.0f},{b[3]:.0f})")
            if is_picture(shape):
                alt = alt_text(shape).strip()
                if not alt:
                    add(number, shape, "alt-text", "warning", "picture has no alt text")
                elif FILENAME_ALT.match(alt):
                    add(number, shape, "alt-text", "warning", f"alt text is just a file name ({alt!r}); describe what the picture shows")
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                text = shape.text_frame.text.strip()
                if is_ph and not text and shape.placeholder_format.type is not None:
                    add(number, shape, "empty-placeholder", "warning", "placeholder is empty")
                words += len(text.split())
                small = [s for s in _explicit_sizes(shape) if s < min_font]
                if small:
                    add(number, shape, "small-font", "warning", f"{min(small):g} pt is below {min_font} pt")
                if b is not None and text and _estimate_overflow(shape, b):
                    add(number, shape, "may-overflow", "warning", "estimated text height exceeds the box")
            if b is not None and not is_ph and not (b[2] - b[0] >= sw * 0.95 and b[3] - b[1] >= sh * 0.95):
                placed.append((shape, b))
        if words > max_words:
            add(number, None, "too-much-text", "warning", f"{words} words (limit {max_words})")
        for i in range(len(placed)):
            for j in range(i + 1, len(placed)):
                share = _overlap(placed[i][1], placed[j][1])
                if share > OVERLAP_SHARE:
                    add(number, placed[i][0], "overlap", "warning", f"overlaps {placed[j][0].name!r} by {share:.0%} of the smaller shape")
    return findings


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pptx")
    ap.add_argument("--min-font", type=float, default=14)
    ap.add_argument("--max-words", type=int, default=90)
    ap.add_argument("--strict", action="store_true", help="warnings also fail the run")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    try:
        findings = check(args.pptx, args.min_font, args.max_words)
    except Exception as exc:  # noqa: BLE001
        print(f"error: cannot read {args.pptx}: {exc}", file=sys.stderr)
        return 2
    errors = [f for f in findings if f["level"] == "error"]
    failed = bool(errors) or (args.strict and bool(findings))
    if args.json:
        print(json.dumps({"findings": findings, "ok": not failed}, indent=2))
    else:
        for f in findings:
            where = f"slide {f['slide']}" + (f" / {f['shape']}" if f["shape"] else "")
            print(f"{f['level'].upper():<8} {where}: {f['kind']} - {f['detail']}")
        print(f"{len(errors)} error(s), {len(findings) - len(errors)} warning(s)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
