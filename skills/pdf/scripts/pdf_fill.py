#!/usr/bin/env python3
"""Fill the fillable fields of a PDF from a JSON file.

    pdf_fill.py form.pdf values.json -o filled.pdf [--flatten]

values.json maps field names (see pdf_fields.py) to values:

    {"full_name": "Ada Lovelace", "agree": true, "country": "UK"}

Text and dropdown fields take strings. A checkbox takes true/false (or its own
"on" state name). A radio group takes the option's state name. A name that is
not a field in the PDF is an error and nothing is written, so a typo cannot
silently leave a field blank. `--flatten` bakes the values into the page so they
can no longer be edited.

Viewers differ in how they draw filled fields. NeedAppearances is set so they
regenerate the look; render the result (pdf_render.py) to check it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pdfcommon import field_kind, on_state, open_reader, qualified_name  # noqa: E402

from pypdf import PdfWriter  # noqa: E402
from pypdf.generic import ArrayObject, NameObject  # noqa: E402


def collect(reader):
    info = {}
    for page in reader.pages:
        for ref in page.get("/Annots") or []:
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Widget":
                continue
            name = qualified_name(annot)
            if name:
                info.setdefault(name, {"kind": field_kind(annot), "on": on_state(annot)})
    return info


def normalise(values, info):
    unknown = [k for k in values if k not in info]
    if unknown:
        raise ValueError("no such field(s): " + ", ".join(sorted(unknown)) + ". Known: " + ", ".join(sorted(info)))
    out = {}
    for name, value in values.items():
        meta = info[name]
        if meta["kind"] == "checkbox" and isinstance(value, bool):
            out[name] = meta["on"] or "/Yes" if value else "/Off"
        elif meta["kind"] in ("checkbox", "radio") and isinstance(value, str) and not value.startswith("/"):
            out[name] = "/" + value
        else:
            out[name] = value if isinstance(value, str) else str(value)
    return out


def _drop_widgets(writer):
    """pypdf's flatten draws values into the page but keeps the widgets; remove them."""
    for page in writer.pages:
        annots = page.get("/Annots")
        if not annots:
            continue
        keep = [a for a in annots if a.get_object().get("/Subtype") != "/Widget"]
        if keep:
            page[NameObject("/Annots")] = ArrayObject(keep)
        else:
            del page["/Annots"]
    root = writer._root_object
    if "/AcroForm" in root:
        del root["/AcroForm"]


def fill(src, values, dest, flatten=False, password=None):
    reader = open_reader(src, password)
    info = collect(reader)
    if not info:
        raise ValueError("this PDF has no fillable fields; use pdf_overlay.py instead")
    prepared = normalise(values, info)
    writer = PdfWriter(clone_from=reader)
    for page in writer.pages:
        writer.update_page_form_field_values(page, prepared, auto_regenerate=False, flatten=flatten)
    if flatten:
        _drop_widgets(writer)
    else:
        writer.set_need_appearances_writer(True)
    writer.write(dest)
    return sorted(prepared)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pdf")
    ap.add_argument("values")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--flatten", action="store_true")
    ap.add_argument("--password")
    args = ap.parse_args(argv)
    try:
        values = json.loads(Path(args.values).read_text())
        if not isinstance(values, dict):
            raise ValueError("values.json must be an object of field name -> value")
        done = fill(args.pdf, values, args.output, args.flatten, args.password)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(f"filled {len(done)} field(s) -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
