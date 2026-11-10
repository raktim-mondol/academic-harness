#!/usr/bin/env python3
"""Page-level operations on PDFs: info, merge, select, split, rotate, encrypt, decrypt, meta.

    pdf_pages.py info    in.pdf
    pdf_pages.py merge   a.pdf b.pdf c.pdf -o all.pdf
    pdf_pages.py select  in.pdf -o part.pdf --pages 1-3,7        # keep and reorder
    pdf_pages.py split   in.pdf --outdir parts/ [--every 5]      # one file per N pages
    pdf_pages.py rotate  in.pdf -o out.pdf --degrees 90 [--pages 2,4]
    pdf_pages.py encrypt in.pdf -o out.pdf --user-password SECRET [--owner-password OWNER]
    pdf_pages.py decrypt in.pdf -o out.pdf --password SECRET
    pdf_pages.py meta    in.pdf -o out.pdf --title "T" --author "A" --subject "S"

Always writes a new file. Bookmarks survive merge and select when pypdf can map
them. Encryption here restricts nothing by itself unless an owner password is set.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pdfcommon import open_reader, parse_pages  # noqa: E402

from pypdf import PdfWriter  # noqa: E402


def cmd_info(args):
    reader = open_reader(args.pdf, args.password)
    first = reader.pages[0]
    box = first.mediabox
    meta = reader.metadata or {}
    fields = reader.get_fields() or {}
    print(f"file:      {args.pdf}")
    print(f"pages:     {len(reader.pages)}")
    print(f"page size: {float(box.width):.0f} x {float(box.height):.0f} pt (first page)")
    print(f"encrypted: {reader.is_encrypted}")
    print(f"form fields: {len(fields)}")
    for key in ("/Title", "/Author", "/Subject", "/Creator", "/Producer", "/CreationDate"):
        if meta.get(key):
            print(f"{key[1:].lower():<10} {meta[key]}")
    return 0


def cmd_merge(args):
    writer = PdfWriter()
    for path in args.inputs:
        reader = open_reader(path, args.password)
        writer.append(reader)
    writer.write(args.output)
    print(f"merged {len(args.inputs)} file(s), {len(writer.pages)} page(s) -> {args.output}")
    return 0


def cmd_select(args):
    reader = open_reader(args.pdf, args.password)
    writer = PdfWriter()
    for i in parse_pages(args.pages, len(reader.pages)):
        writer.add_page(reader.pages[i])
    writer.write(args.output)
    print(f"{len(writer.pages)} page(s) -> {args.output}")
    return 0


def cmd_split(args):
    reader = open_reader(args.pdf, args.password)
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    step = max(1, args.every)
    stem = Path(args.pdf).stem
    written = 0
    for start in range(0, len(reader.pages), step):
        writer = PdfWriter()
        for i in range(start, min(start + step, len(reader.pages))):
            writer.add_page(reader.pages[i])
        target = outdir / f"{stem}-{start + 1:04d}.pdf"
        writer.write(str(target))
        written += 1
    print(f"wrote {written} file(s) into {outdir}")
    return 0


def cmd_rotate(args):
    if args.degrees % 90:
        print("error: --degrees must be a multiple of 90", file=sys.stderr)
        return 2
    reader = open_reader(args.pdf, args.password)
    chosen = set(parse_pages(args.pages, len(reader.pages)))
    writer = PdfWriter()
    for i, page in enumerate(reader.pages):
        if i in chosen:
            page.rotate(args.degrees)
        writer.add_page(page)
    writer.write(args.output)
    print(f"rotated {len(chosen)} page(s) by {args.degrees} -> {args.output}")
    return 0


def cmd_encrypt(args):
    reader = open_reader(args.pdf, args.password)
    writer = PdfWriter(clone_from=reader)
    writer.encrypt(user_password=args.user_password, owner_password=args.owner_password or None, algorithm="AES-256")
    writer.write(args.output)
    print(f"encrypted -> {args.output}")
    return 0


def cmd_decrypt(args):
    reader = open_reader(args.pdf, args.password)
    writer = PdfWriter(clone_from=reader)
    writer.write(args.output)
    print(f"decrypted copy -> {args.output}")
    return 0


def cmd_meta(args):
    reader = open_reader(args.pdf, args.password)
    writer = PdfWriter(clone_from=reader)
    updates = {}
    for key, value in (("/Title", args.title), ("/Author", args.author), ("/Subject", args.subject)):
        if value is not None:
            updates[key] = value
    writer.add_metadata(updates)
    writer.write(args.output)
    print(f"metadata updated ({', '.join(updates) or 'nothing'}) -> {args.output}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, *, out=True, pdf=True):
        p = sub.add_parser(name)
        if pdf:
            p.add_argument("pdf")
        if out:
            p.add_argument("-o", "--output", required=True)
        p.add_argument("--password")
        p.set_defaults(fn=fn)
        return p

    add("info", cmd_info, out=False)
    p = add("merge", cmd_merge, pdf=False)
    p.add_argument("inputs", nargs="+")
    p = add("select", cmd_select)
    p.add_argument("--pages", required=True)
    p = add("split", cmd_split, out=False)
    p.add_argument("--outdir", required=True)
    p.add_argument("--every", type=int, default=1)
    p = add("rotate", cmd_rotate)
    p.add_argument("--degrees", type=int, required=True)
    p.add_argument("--pages")
    p = add("encrypt", cmd_encrypt)
    p.add_argument("--user-password", required=True)
    p.add_argument("--owner-password")
    add("decrypt", cmd_decrypt)
    p = add("meta", cmd_meta)
    p.add_argument("--title")
    p.add_argument("--author")
    p.add_argument("--subject")

    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
