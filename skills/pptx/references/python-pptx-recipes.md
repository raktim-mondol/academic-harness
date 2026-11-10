# python-pptx recipes

Tested patterns, python-pptx 1.0. Install with `pip install python-pptx`.

## A deck from the default template

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

prs = Presentation()                       # 10 x 7.5 in, 4:3; see "Widescreen" below
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)   # 16:9

title_slide = prs.slides.add_slide(prs.slide_layouts[0])
title_slide.shapes.title.text = "Interim analysis"
title_slide.placeholders[1].text = "Research group, November 2026"

slide = prs.slides.add_slide(prs.slide_layouts[1])      # Title and Content
slide.shapes.title.text = "Treatment B halves relapse"
body = slide.placeholders[1].text_frame
body.text = "Relapse at 12 months: 11% vs 23%"
point = body.add_paragraph()
point.text = "Hazard ratio 0.47 (95% CI 0.30 to 0.74)"
point.level = 1
for paragraph in body.paragraphs:
    for run in paragraph.runs:
        run.font.size = Pt(24)

slide.notes_slide.notes_text_frame.text = "Say that the trial was open label."
prs.save("talk.pptx")
```

Layout numbers in the default template: 0 title, 1 title and content, 2 section
header, 3 two content, 4 comparison, 5 title only, 6 blank. A custom template has
its own list: print `[l.name for l in prs.slide_layouts]` and choose by name.

## Widescreen and placeholder positions

Changing `slide_width` does not move placeholders already defined by the layouts.
When a template matters, start from a 16:9 template file instead of resizing the
default. For a slide you build, position shapes explicitly in inches.

## Text boxes, runs and formatting

```python
from pptx.enum.text import MSO_ANCHOR

blank = prs.slides.add_slide(prs.slide_layouts[5])
blank.shapes.title.text = "Method"
box = blank.shapes.add_textbox(Inches(0.8), Inches(1.8), Inches(6), Inches(1.5))
frame = box.text_frame
frame.word_wrap = True
frame.vertical_anchor = MSO_ANCHOR.TOP
p = frame.paragraphs[0]
r1 = p.add_run()
r1.text = "Samples were "
r2 = p.add_run()
r2.text = "sequenced"
r2.font.bold = True
r2.font.color.rgb = RGBColor(0x1F, 0x4E, 0x79)
for run in p.runs:
    run.font.size = Pt(20)
p.alignment = PP_ALIGN.LEFT
```

To change wording in an existing deck without losing formatting, edit
`run.text` on the existing runs rather than replacing `text_frame.text`, which
collapses a paragraph to one run with the first run's formatting.

## Pictures with alt text

```python
from PIL import Image
Image.new("RGB", (400, 240), (70, 130, 180)).save("fig.png")        # stand-in for a real figure

pic = blank.shapes.add_picture("fig.png", Inches(7), Inches(1.8), width=Inches(5))
pic._element.xpath(".//p:cNvPr")[0].set("descr", "Bar chart of relapse rate by treatment arm")
pic._element.xpath(".//p:cNvPr")[0].set("title", "Relapse by arm")
prs.save("talk.pptx")
```

`add_picture` stores the file name as the alt text; always overwrite it.

## Tables

```python
table_slide = prs.slides.add_slide(prs.slide_layouts[5])
table_slide.shapes.title.text = "Baseline characteristics"
rows, cols = 3, 3
shape = table_slide.shapes.add_table(rows, cols, Inches(0.8), Inches(1.8), Inches(8), Inches(1.5))
table = shape.table
for c, head in enumerate(["Arm", "n", "Mean age"]):
    table.cell(0, c).text = head
for r, row in enumerate([("A", "120", "54.2"), ("B", "118", "53.8")], start=1):
    for c, value in enumerate(row):
        table.cell(r, c).text = value
        table.cell(r, c).text_frame.paragraphs[0].runs[0].font.size = Pt(18)
table.columns[0].width = Inches(3)
```

## Native charts

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION

chart_slide = prs.slides.add_slide(prs.slide_layouts[5])
chart_slide.shapes.title.text = "Relapse rate"
data = CategoryChartData()
data.categories = ["Arm A", "Arm B"]
data.add_series("12-month relapse (%)", (23, 11))
graphic = chart_slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1.8), Inches(7), Inches(4.5), data)
chart = graphic.chart
chart.has_legend = False
chart.plots[0].has_data_labels = True
chart.value_axis.has_title = True
chart.value_axis.axis_title.text_frame.text = "Relapse (%)"
prs.save("talk.pptx")
```

## Reusing and rearranging slides

python-pptx has no public API for duplicating or reordering slides. Reordering
works through the slide id list:

```python
ids = prs.slides._sldIdLst
items = list(ids)
ids.remove(items[-1])
ids.insert(1, items[-1])                  # move the last slide to position 2
prs.save("reordered.pptx")
```

To duplicate a slide, build it again from the same function that created it, or
use a template with the slide you want as a layout. Deleting a slide the same way
(`ids.remove(item)`) leaves its part in the package; run
`scripts/ooxml_tools.py check` after structural edits.

## Check what you made

```
python scripts/pptx_check.py talk.pptx --min-font 14
python scripts/pptx_outline.py talk.pptx --notes
python scripts/pptx_thumbs.py talk.pptx -o sheet.png     # needs LibreOffice and poppler
```

## pptxgenjs (Node) in one paragraph

`pptxgenjs` builds decks from JavaScript: `const pptx = new PptxGenJS();
const slide = pptx.addSlide(); slide.addText("Title", {x: 0.5, y: 0.4, w: 9,
fontSize: 28}); pptx.writeFile({fileName: "talk.pptx"})`. It is a good fit when
the rest of a pipeline is Node. This skill's tests do not run it; check its
output with the scripts above like any other deck.
