# PDF reference: creating, stamping, OCR, redaction, tidy-up

Library notes for jobs the scripts do not cover. All code uses public APIs of
reportlab, pypdf and standard command-line tools.

## Create a PDF with reportlab

Low level, exact placement:

```python
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

c = canvas.Canvas("note.pdf", pagesize=A4)
c.setTitle("Lab note")
c.setFont("Helvetica-Bold", 16)
c.drawString(72, 780, "Lab note")
c.setFont("Helvetica", 11)
c.drawString(72, 756, "Prepared 2026-11-10")
c.showPage()
c.save()
```

Flowing text, tables and images (Platypus):

```python
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

styles = getSampleStyleSheet()
doc = SimpleDocTemplate("summary.pdf", pagesize=A4, leftMargin=2.5 * cm, rightMargin=2.5 * cm,
                        title="Summary", author="Research group")
story = [Paragraph("Summary", styles["Title"]),
         Paragraph("Two cohorts were compared on the primary outcome.", styles["BodyText"]),
         Spacer(1, 12)]
table = Table([["Cohort", "n", "Mean"], ["A", "42", "3.1"], ["B", "39", "2.7"]], repeatRows=1)
table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                           ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                           ("ALIGN", (1, 1), (-1, -1), "RIGHT")]))
story.append(table)
doc.build(story)
```

Notes:
- Subscripts and superscripts in a `Paragraph`: `H<sub>2</sub>O`, `m<super>2</super>`.
- Built-in fonts (Helvetica, Times, Courier) cover Latin text only. For other
  scripts register a TrueType font with `pdfmetrics.registerFont(TTFont(...))`.
- Never put raw `<` or `&` from data into a `Paragraph`; escape with
  `xml.sax.saxutils.escape`.
- For a figure, save it as PNG or PDF from matplotlib and add
  `Image("fig.png", width=12 * cm, height=8 * cm)` (keep the aspect ratio).

## Stamp a watermark or page numbers

```python
import io
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

reader = PdfReader("in.pdf")
writer = PdfWriter()
for number, source in enumerate(reader.pages, start=1):
    page = writer.add_page(source)           # merge into the writer's copy, not the reader's page
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(w, h))
    c.setFont("Helvetica", 9)
    c.drawRightString(w - 36, 24, f"Page {number} of {len(reader.pages)}")
    c.setFont("Helvetica-Bold", 60)
    c.setFillGray(0.85)
    c.saveState(); c.translate(w / 2, h / 2); c.rotate(45)
    c.drawCentredString(0, 0, "DRAFT")
    c.restoreState()
    c.save(); buf.seek(0)
    page.merge_page(PdfReader(buf).pages[0])      # stamp over the page
writer.write("stamped.pdf")
```

Use `merge_page(stamp, over=False)` to put the stamp underneath.

## Bookmarks, labels, attachments

```python
from pypdf import PdfReader, PdfWriter
writer = PdfWriter(clone_from=PdfReader("in.pdf"))
chapter = writer.add_outline_item("Methods", 2)            # zero-based page index
writer.add_outline_item("Sampling", 3, parent=chapter)
writer.add_attachment("data.csv", open("data.csv", "rb").read())
writer.write("out.pdf")
```

## OCR a scanned PDF

`pdf_text.py` flags pages with no text layer. For those:

```
ocrmypdf --deskew --language eng in.pdf out.pdf     # adds an invisible text layer, keeps the images
```

or `pdftoppm -r 300 -png in.pdf page` followed by `tesseract page-1.png out -l eng pdf`.
Both need tesseract installed. Check a sample of the recognised text against the
page image; OCR misreads digits, units and symbols. Say a document was OCR'd when
you quote from it.

## Redaction

Covering text with a filled rectangle leaves the text underneath selectable and
extractable. Real redaction removes the content. Use a tool that does (for
example PyMuPDF's `add_redact_annot` plus `apply_redactions`, or Acrobat), then
verify:

```
python scripts/pdf_text.py redacted.pdf | grep -i "the secret term"     # must print nothing
```

Also clear metadata (`pdf_pages.py meta` with empty values) and check
attachments and bookmarks for the same terms.

## Reduce size

```
gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dNOPAUSE -dBATCH -sOutputFile=small.pdf in.pdf
```

`/screen` is smallest, `/printer` keeps more quality. Images dominate size, so
downsampling them is what helps. Compare page renders before and after.

## Accessibility basics when creating PDFs

Prefer producing the PDF from a structured source (Word with real headings,
LaTeX with `hyperref`, or HTML printed to PDF) instead of drawing text by hand,
because tagging and reading order come from the structure. Set the document
title and language, give figures alt text in the source, and avoid text in
images.
