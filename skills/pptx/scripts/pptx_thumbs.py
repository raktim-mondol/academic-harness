#!/usr/bin/env python3
"""Render a deck to one contact-sheet image so you can look at every slide.

    pptx_thumbs.py talk.pptx -o sheet.png [--cols 4] [--width 360] [--dpi 80]
    pptx_thumbs.py talk.pdf  -o sheet.png            # already a PDF: skips LibreOffice
    pptx_thumbs.py talk.pptx -o sheet.png --slides-dir slides/   # also keep one PNG per slide
    pptx_thumbs.py talk.pptx --dry-run               # print the commands, run nothing

Steps: LibreOffice converts the deck to PDF (headless, private profile),
pdftoppm renders each page, Pillow tiles them with slide numbers. Needs
LibreOffice (or $SOFFICE) for .pptx input, poppler's pdftoppm, and Pillow.
Rendering is LibreOffice's, so fonts and spacing can differ slightly from
PowerPoint; use it to spot overflow, overlap and empty slides, not to judge
fine typography. Exit 3 when a required tool is missing.
"""
from __future__ import annotations

import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def find_soffice():
    explicit = os.environ.get("SOFFICE")
    if explicit:
        return explicit if Path(explicit).exists() else None
    return shutil.which("soffice") or shutil.which("libreoffice")


def to_pdf(src: Path, workdir: Path, soffice: str, timeout=240) -> Path:
    outdir = workdir / "pdf"
    outdir.mkdir()
    cmd = [soffice, f"-env:UserInstallation={(workdir / 'profile').resolve().as_uri()}",
           "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(outdir), str(src)]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    pdf = outdir / (src.stem + ".pdf")
    if result.returncode != 0 or not pdf.exists():
        raise RuntimeError(f"LibreOffice conversion failed (exit {result.returncode}): {(result.stderr or result.stdout).strip()[:400]}")
    return pdf


def rasterise(pdf: Path, workdir: Path, dpi: int) -> list[Path]:
    tool = shutil.which("pdftoppm")
    if not tool:
        raise FileNotFoundError("pdftoppm (poppler) not found")
    prefix = workdir / "slide"
    subprocess.run([tool, "-r", str(dpi), "-png", str(pdf), str(prefix)], check=True, capture_output=True)
    return sorted(workdir.glob("slide-*.png"))


def contact_sheet(images: list[Path], out: Path, cols: int, width: int) -> None:
    from PIL import Image, ImageDraw
    tiles = []
    for index, path in enumerate(images, start=1):
        img = Image.open(path).convert("RGB")
        height = round(img.height * width / img.width)
        img = img.resize((width, height))
        draw = ImageDraw.Draw(img)
        draw.rectangle((0, 0, 34, 20), fill=(0, 0, 0))
        draw.text((6, 4), str(index), fill=(255, 255, 255))
        tiles.append(img)
    cols = max(1, min(cols, len(tiles)))
    rows = math.ceil(len(tiles) / cols)
    cell_h = max(t.height for t in tiles)
    gap = 10
    sheet = Image.new("RGB", (cols * width + (cols + 1) * gap, rows * cell_h + (rows + 1) * gap), (225, 225, 225))
    for i, tile in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet.paste(tile, (gap + c * (width + gap), gap + r * (cell_h + gap)))
    sheet.save(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("deck")
    ap.add_argument("-o", "--output", default="slides.png")
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--width", type=int, default=360, help="tile width in pixels")
    ap.add_argument("--dpi", type=int, default=80)
    ap.add_argument("--slides-dir", help="also save each slide as slide-001.png, slide-002.png ... in this directory")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    src = Path(args.deck)
    if not src.exists():
        print(f"error: {src} not found", file=sys.stderr)
        return 2
    is_pdf = src.suffix.lower() == ".pdf"
    soffice = None if is_pdf else find_soffice()
    if args.dry_run:
        if not is_pdf:
            print(f"{soffice or 'soffice'} --headless --convert-to pdf --outdir <tmp> {src}")
        print(f"pdftoppm -r {args.dpi} -png <pdf> <tmp>/slide")
        print(f"tile into {args.output}: {args.cols} columns, {args.width}px wide")
        return 0
    if not is_pdf and not soffice:
        print("LibreOffice not found (looked for soffice/libreoffice, and $SOFFICE). Install it, or convert the deck to PDF yourself and pass the PDF.", file=sys.stderr)
        return 3
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow is required (pip install pillow)", file=sys.stderr)
        return 3
    with tempfile.TemporaryDirectory(prefix="pptx-thumbs-") as tmp:
        work = Path(tmp)
        try:
            pdf = src if is_pdf else to_pdf(src, work, soffice)
            images = rasterise(pdf, work, args.dpi)
        except FileNotFoundError as exc:
            print(f"{exc}", file=sys.stderr)
            return 3
        except (RuntimeError, subprocess.SubprocessError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        if not images:
            print("error: no pages were rendered", file=sys.stderr)
            return 2
        contact_sheet(images, Path(args.output), args.cols, args.width)
        if args.slides_dir:
            target = Path(args.slides_dir)
            target.mkdir(parents=True, exist_ok=True)
            for i, image in enumerate(images, start=1):
                shutil.copyfile(image, target / f"slide-{i:03d}.png")
    print(f"{len(images)} slide(s) -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
