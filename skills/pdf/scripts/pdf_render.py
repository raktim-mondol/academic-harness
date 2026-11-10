#!/usr/bin/env python3
"""Render PDF pages to PNG images, to look at them.

    pdf_render.py doc.pdf --outdir pages/ [--pages 1-3] [--dpi 110]

Uses poppler's pdftoppm when present, otherwise pypdfium2. Prints the files
written. Use a modest dpi (100-150) for reading; raise it only to inspect fine
detail, because large images cost context and time.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pdfcommon import open_reader, parse_pages  # noqa: E402


def render(pdf, outdir, pages=None, dpi=110, password=None):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    reader = open_reader(pdf, password)
    indexes = parse_pages(pages, len(reader.pages))
    written = []
    tool = shutil.which("pdftoppm")
    if tool:
        for i in indexes:
            prefix = outdir / f"page-{i + 1:03d}"
            cmd = [tool, "-r", str(dpi), "-png", "-singlefile", "-f", str(i + 1), "-l", str(i + 1)]
            if password:
                cmd += ["-upw", password]
            subprocess.run(cmd + [str(pdf), str(prefix)], check=True, capture_output=True)
            written.append(prefix.with_suffix(".png"))
        return written
    try:
        import pypdfium2 as pdfium
    except ImportError:
        raise RuntimeError("need poppler (pdftoppm) or pypdfium2 to render pages")
    doc = pdfium.PdfDocument(str(pdf), password=password)
    for i in indexes:
        image = doc[i].render(scale=dpi / 72).to_pil()
        target = outdir / f"page-{i + 1:03d}.png"
        image.save(target)
        written.append(target)
    return written


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pdf")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--pages")
    ap.add_argument("--dpi", type=int, default=110)
    ap.add_argument("--password")
    args = ap.parse_args(argv)
    try:
        files = render(args.pdf, args.outdir, args.pages, args.dpi, args.password)
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    for f in files:
        print(f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
