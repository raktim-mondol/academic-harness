# python-docx recipes

Short, tested patterns for building and reading documents. python-docx 1.x.
Install with `pip install python-docx`. These use only its public API plus the
small XML helpers noted where the API stops.

## Start, structure, save

```python
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()                       # or Document("template.docx") to inherit its styles
doc.core_properties.title = "Interim report"
doc.core_properties.author = "Research group"

doc.add_heading("Interim report", level=0)      # level 0 uses the Title style
doc.add_heading("1. Methods", level=1)
p = doc.add_paragraph("Samples were ")
p.add_run("sequenced").bold = True
p.add_run(" on two platforms.")
p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
doc.save("report.docx")
```

Use built-in style names for structure: `Title`, `Heading 1`-`Heading 9`,
`List Bullet`, `List Number`, `Caption`, `Quote`. A style change in a template
then restyles everything.

## Fonts and spacing through styles

```python
normal = doc.styles["Normal"]
normal.font.name = "Calibri"
normal.font.size = Pt(11)
normal.paragraph_format.space_after = Pt(6)
normal.paragraph_format.line_spacing = 1.15
# East Asian text needs the east-asia font set too:
normal.element.rPr.rFonts.set("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia", "Calibri")
```

## Tables

```python
rows = [("Sample", "Reads", "Mapped %"), ("A1", "12.4M", "97.1"), ("A2", "11.8M", "96.4")]
table = doc.add_table(rows=len(rows), cols=3)
table.style = "Table Grid"
for r, row in enumerate(rows):
    for c, value in enumerate(row):
        cell = table.cell(r, c)
        cell.text = value
        if r == 0:
            for run in cell.paragraphs[0].runs:
                run.bold = True
```

Repeat the header row on each page:

```python
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
trPr = table.rows[0]._tr.get_or_add_trPr()
flag = OxmlElement("w:tblHeader"); flag.set(qn("w:val"), "true"); trPr.append(flag)
```

Merge cells with `a.merge(b)`. Set column widths on every cell of the column,
not just the first, because Word reads cell widths.

## Images and captions

```python
doc.add_picture("figure1.png", width=Cm(14))
doc.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_paragraph("Figure 1. Read depth by sample.", style="Caption")
```

Give images alt text: set `descr` on the picture's `wp:docPr` element
(`doc.inline_shapes[-1]._inline.docPr.set("descr", "Bar chart of ...")`).

## Headers, footers, page numbers

```python
section = doc.sections[0]
section.header.paragraphs[0].text = "Confidential draft"
footer = section.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER

def add_field(paragraph, code):
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar"); begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText"); instr.set(qn("xml:space"), "preserve"); instr.text = code
    end = OxmlElement("w:fldChar"); end.set(qn("w:fldCharType"), "end")
    run._r.extend([begin, instr, end])

footer.add_run("Page ")
add_field(footer, "PAGE")
footer.add_run(" of ")
add_field(footer, "NUMPAGES")
```

A table of contents is a field too: `add_field(paragraph, 'TOC \\o "1-3" \\h \\z \\u')`.
It shows empty until Word updates fields (F9 or on open). Say so; do not claim a
populated contents list unless you rendered it.

## Page setup and sections

```python
from docx.enum.section import WD_ORIENT, WD_SECTION
section = doc.sections[0]
section.page_width, section.page_height = Cm(21), Cm(29.7)      # A4
section.left_margin = section.right_margin = Cm(2.5)

landscape = doc.add_section(WD_SECTION.NEW_PAGE)
landscape.orientation = WD_ORIENT.LANDSCAPE
landscape.page_width, landscape.page_height = landscape.page_height, landscape.page_width
```

## Lists

Use the built-in `List Bullet` and `List Number` styles. Restarting numbering
needs a new `w:num` in `numbering.xml`; if you need that, unpack and edit it, or
generate the document through pandoc, which handles it.

## Comments (python-docx 1.2 and later)

```python
runs = doc.paragraphs[0].runs
doc.add_comment(runs=runs[0:2], text="Check this figure.", author="Reviewer", initials="R")
for comment in doc.comments:
    print(comment.author, comment.text)
```

For older python-docx, or to anchor on a phrase, use `scripts/docx_comments.py`.

## Reading

```python
doc = Document("input.docx")
for p in doc.paragraphs:
    print(p.style.name, "|", p.text)
for t in doc.tables:
    for row in t.rows:
        print([c.text for c in row.cells])
```

`doc.paragraphs` skips text in tables, text boxes, headers and footnotes; walk
`doc.element.body.iter()` for everything, or convert with pandoc.

## Markdown and LaTeX to Word with pandoc

```
pandoc paper.md -o paper.docx --reference-doc=journal-template.docx --citeproc --bibliography refs.bib
pandoc paper.tex -o paper.docx --citeproc
```

Make `journal-template.docx` by running `pandoc -o custom-reference.docx
--print-default-data-file reference.docx`, restyling it in Word, and reusing it.

## Things python-docx does not do

Tracked changes, equations (use pandoc from LaTeX or Markdown for OMML math),
footnotes and endnotes (pandoc writes them), content controls, and field
updating. For the first, use `scripts/docx_track.py`.
