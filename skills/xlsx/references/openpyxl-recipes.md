# openpyxl recipes

Tested patterns. openpyxl 3.1. Everything here writes formulas as text; none of
it calculates them (see SKILL.md).

## A small model with inputs, formulas and formats

```python
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "Model"

ws["A1"] = "Growth model"
ws["A1"].font = Font(bold=True, size=14)

# Inputs in one place, typed values in blue
ws["A3"], ws["B3"] = "Start value", 1000
ws["A4"], ws["B4"] = "Annual growth", 0.07
for cell in ("B3", "B4"):
    ws[cell].font = Font(color="0000FF")
ws["B4"].number_format = "0.0%"
ws["B3"].number_format = "#,##0"

# Header row
for col, title in enumerate(["Year", "Value", "Change"], start=1):
    c = ws.cell(row=6, column=col, value=title)
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor="305496")
    c.alignment = Alignment(horizontal="center")

# Formulas point at the inputs with absolute references
for i in range(5):
    r = 7 + i
    ws.cell(row=r, column=1, value=2026 + i)
    ws.cell(row=r, column=2, value="=$B$3" if i == 0 else f"=B{r - 1}*(1+$B$4)").number_format = "#,##0.00"
    ws.cell(row=r, column=3, value="" if i == 0 else f"=IF(B{r - 1}=0,\"\",B{r}/B{r - 1}-1)").number_format = "0.0%"

ws["A13"], ws["B13"] = "Total", "=SUM(B7:B11)"
ws["A13"].font = Font(bold=True)
ws["B13"].border = Border(top=Side(style="thin"))

ws.freeze_panes = "A7"
for col in range(1, 4):
    ws.column_dimensions[get_column_letter(col)].width = 16
wb.save("model.xlsx")
```

## Write a DataFrame, then style it

```python
import pandas as pd

df = pd.DataFrame({"sample": ["A1", "A2", "B1"], "reads": [12.4e6, 11.8e6, 9.9e6], "mapped": [0.971, 0.964, 0.953]})
with pd.ExcelWriter("table.xlsx", engine="openpyxl") as writer:
    df.to_excel(writer, sheet_name="QC", index=False)
    sheet = writer.sheets["QC"]
    sheet.freeze_panes = "A2"
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for row in sheet.iter_rows(min_row=2, min_col=3, max_col=3):
        for cell in row:
            cell.number_format = "0.0%"
    sheet.auto_filter.ref = sheet.dimensions
```

## Read it back

```python
import pandas as pd
from openpyxl import load_workbook

frame = pd.read_excel("table.xlsx", sheet_name="QC")          # values only
wb = load_workbook("model.xlsx")                                # formulas (what you want to edit)
print(wb["Model"]["B8"].value)                                  # '=B7*(1+$B$4)'
stored = load_workbook("model.xlsx", data_only=True)["Model"]["B8"].value
print(stored)                                                   # None: nothing has calculated this file
```

## Edit an existing workbook without losing its formulas

```python
wb = load_workbook("model.xlsx")            # NOT data_only=True: saving that version replaces formulas with values
wb["Model"]["B4"] = 0.05
wb.save("model-v2.xlsx")                    # save under a new name
```

## Conditional formatting, validation, a defined name

```python
from openpyxl.formatting.rule import CellIsRule
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

ws = wb["Model"]
ws.conditional_formatting.add("C8:C11", CellIsRule(operator="lessThan", formula=["0"], font=Font(color="C00000")))

choices = DataValidation(type="list", formula1='"low,base,high"', allow_blank=False)
ws.add_data_validation(choices)
ws["E3"] = "base"
choices.add("E3")

wb.defined_names["GrowthRate"] = DefinedName("GrowthRate", attr_text="Model!$B$4")
wb.save("model-v3.xlsx")
```

## A chart

```python
from openpyxl.chart import LineChart, Reference

chart = LineChart()
chart.title = "Projected value"
chart.y_axis.title = "Value"
chart.x_axis.title = "Year"
data = Reference(ws, min_col=2, min_row=6, max_row=11)       # header row included
years = Reference(ws, min_col=1, min_row=7, max_row=11)
chart.add_data(data, titles_from_data=True)
chart.set_categories(years)
ws.add_chart(chart, "F3")
wb.save("model-chart.xlsx")
```

openpyxl cannot render the chart. To look at it, convert with LibreOffice
(`soffice --headless --convert-to pdf model-chart.xlsx`) and view the page.

## Several sheets and cross-sheet references

```python
summary = wb.create_sheet("Summary")
summary["A1"] = "Final-year value"
summary["B1"] = "=Model!B11"                    # quote names with spaces: ='Raw data'!A1
summary["B1"].font = Font(color="008000")        # green: link to another sheet
wb.save("model-linked.xlsx")
```

## Large files

```python
from openpyxl import Workbook, load_workbook

out = Workbook(write_only=True)
sheet = out.create_sheet("big")
for i in range(100_000):
    sheet.append([i, i * 2])
out.save("big.xlsx")

for row in load_workbook("big.xlsx", read_only=True)["big"].iter_rows(min_row=1, max_row=3, values_only=True):
    print(row)
```

Write-only and read-only modes stream rows and cannot style individual cells
after the fact or look cells up randomly.
