#!/usr/bin/env python3
"""List the fillable (AcroForm) fields of a PDF.

    pdf_fields.py form.pdf [--json]

Prints, for each field widget: page, qualified name, kind (text, checkbox,
radio, dropdown, list, pushbutton, signature), current value, the "on" state of
checkboxes and radios, and the options of dropdowns. Use these names as keys in
the JSON passed to pdf_fill.py.

No fields listed does not mean the form cannot be completed: a PDF drawn with
lines and no widgets is not fillable. Use pdf_words.py to find where to place
text and pdf_overlay.py to write it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _pdfcommon import field_kind, inherited, on_state, open_reader, qualified_name  # noqa: E402


def list_fields(path, password=None):
    reader = open_reader(path, password)
    found = []
    for number, page in enumerate(reader.pages, start=1):
        for ref in page.get("/Annots") or []:
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Widget":
                continue
            name = qualified_name(annot)
            if not name:
                continue
            kind = field_kind(annot)
            value = inherited(annot, "/V")
            entry = {
                "page": number,
                "name": name,
                "kind": kind,
                "value": None if value is None else str(value),
                "rect": [round(float(x), 1) for x in annot.get("/Rect", [])],
            }
            if kind in ("checkbox", "radio"):
                entry["on_state"] = on_state(annot)
            if kind in ("dropdown", "list"):
                opts = inherited(annot, "/Opt") or []
                entry["options"] = [str(o[1] if isinstance(o, list) else o) for o in (x.get_object() if hasattr(x, "get_object") else x for x in opts)]
            found.append(entry)
    return found


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pdf")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--password")
    args = ap.parse_args(argv)
    try:
        fields = list_fields(args.pdf, args.password)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(fields, indent=2))
        return 0
    for f in fields:
        extra = f"  on={f['on_state']}" if f.get("on_state") else ""
        extra += f"  options={f['options']}" if f.get("options") else ""
        print(f"p{f['page']:<3} {f['kind']:<10} {f['name']!r:<40} value={f['value']!r}{extra}")
    print(f"{len(fields)} field widget(s)")
    return 0 if fields else 1


if __name__ == "__main__":
    sys.exit(main())
