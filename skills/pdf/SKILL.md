---
name: pdf
description: Read, split, merge, rotate, fill and create PDF files. Use to extract text or tables, find where a page is scanned, combine or cut pages, fill a fillable form, write text onto a form that has no fields, render pages to images to look at them, or build a simple PDF from code. For turning a PDF into clean Markdown for reading or RAG, or heavy OCR, see the liteparse skill.
license: MIT
metadata:
  version: "2.0"
  skill-author: Academic Harness
  skill-source: original; drives pypdf, reportlab, pdfplumber and poppler, none of which are bundled
---

# PDF files

Paths are relative to this skill's directory. Install what you use:
`pip install pypdf reportlab pdfplumber` (pdfplumber is optional) and poppler
for `pdftoppm`.

## Pick the route

| You want to | Use |
|---|---|
| Read the text | `scripts/pdf_text.py file.pdf [--pages 2-4] [--layout]` |
| Pull a table | `scripts/pdf_text.py file.pdf --tables` (pdfplumber; works best on ruled tables) |
| Know whether it is a scan | `pdf_text.py` flags pages with no text layer; those need OCR |
| Count pages, see metadata | `scripts/pdf_pages.py info file.pdf` |
| Combine, cut, reorder, split | `scripts/pdf_pages.py merge / select / split` |
| Rotate pages | `scripts/pdf_pages.py rotate --degrees 90 --pages 2` |
| Fill a fillable form | `pdf_fields.py` to list, then `pdf_fill.py values.json` |
| Fill a form with no fields | `pdf_words.py` to find labels, then `pdf_overlay.py marks.json` |
| Look at pages | `scripts/pdf_render.py file.pdf --outdir pages/ --pages 1-2` |
| Create a PDF | reportlab, see [references/reference.md](references/reference.md) |
| OCR a scan, redact, compress | [references/reference.md](references/reference.md) |

Every script that writes takes `-o` and produces a new file. None edits the
input. Errors go to stderr with exit code 2; "found nothing" is exit code 1.

## Reading

```
python scripts/pdf_text.py paper.pdf --pages 1-2
python scripts/pdf_text.py paper.pdf --json        # per-page text, character counts, scan flag
```

Text comes out in the order the PDF stores it, which for two-column papers can
interleave columns. Try `--layout` for a spatial rendering, and look at the page
image (`pdf_render.py`) before trusting numbers from a table or figure. A scanned
page reports `probably_scanned`; do not quote text from it.

## Forms

Fillable form:

```
python scripts/pdf_fields.py form.pdf              # names, kinds, current values, checkbox "on" states
echo '{"full_name": "Ada Lovelace", "agree": true, "country": "UK"}' > values.json
python scripts/pdf_fill.py form.pdf values.json -o filled.pdf
python scripts/pdf_render.py filled.pdf --outdir check/   # look at it
```

An unknown field name stops the run and lists the real names, so a typo cannot
leave a blank. `--flatten` bakes values into the page and removes the widgets;
only do that when the user wants a final, uneditable copy.

No fields (the page just has lines and labels):

```
python scripts/pdf_words.py form.pdf --page 1 --grep "Surname"
# note x1 and bottom of the label, then write below/right of it
echo '[{"page":1,"x":150,"y":82,"text":"Lovelace","size":11}]' > marks.json
python scripts/pdf_overlay.py form.pdf marks.json -o filled.pdf
python scripts/pdf_render.py filled.pdf --outdir check/ --dpi 130
```

Coordinates are points from the top-left (`y` grows downward). Overlay text is
added on top; it does not replace existing content. Always render and look.

Never invent form content. Fill only values the user supplied or documents
confirm; leave the rest blank and say so.

## Limits to state

- Signatures: this skill does not sign or validate digital signatures, and
  filling or flattening a signed PDF invalidates the signature.
- Redaction: drawing a black box over text does not remove it. Use a tool built
  for redaction and verify by extracting text afterwards.
- Encrypted files: pass `--password`. `decrypt` writes an unlocked copy only for
  a file the user is entitled to open.
- Extraction quality depends on how the PDF was made. Treat extracted numbers
  as leads to check against the rendered page.
- Rendering needs poppler (`pdftoppm`) or pypdfium2; without either,
  `pdf_render.py` says so.
