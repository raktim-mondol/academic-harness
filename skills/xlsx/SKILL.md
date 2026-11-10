---
name: xlsx
description: Create, read, edit and check Excel (.xlsx) workbooks and tabular files. Use for building spreadsheets with live formulas, reading sheets into pandas, editing an existing workbook without losing formatting, formatting and charts, finding broken formulas (#REF!, #DIV/0!, missing sheets), and recalculating with LibreOffice so stored values exist. Not for Word, PowerPoint, PDF or Google Sheets.
license: MIT
metadata:
  version: "2.0"
  skill-author: Academic Harness
  skill-source: original; drives openpyxl, pandas and LibreOffice, none of which are bundled
---

# Excel workbooks (.xlsx)

Paths are relative to this skill's directory. Install `pip install openpyxl
pandas`; LibreOffice is needed only for recalculation.

## The one fact that shapes everything

openpyxl **writes formulas but does not calculate them**. A workbook it saves has
formulas and no stored results. Excel computes on open, but pandas,
`data_only=True` reads, previews and many viewers show nothing (`None`). So:

- Build with formulas, not pasted numbers, wherever the value is derived, so the
  sheet stays live and auditable.
- Before you hand over or read results back, recalculate (below), or say that the
  numbers appear only when the file is opened in a calculating application.
- Never read computed values from a file you just wrote with openpyxl and treat
  `None` as zero.

## Pick the route

| You want to | Use |
|---|---|
| Load a sheet for analysis | `pandas.read_excel(path, sheet_name=...)` (values only) |
| Write a data table quickly | `DataFrame.to_excel(...)`, then style with openpyxl |
| Build a model with formulas, formats, charts | openpyxl, see [references/openpyxl-recipes.md](references/openpyxl-recipes.md) |
| Edit an existing workbook | `openpyxl.load_workbook(path)` (not `data_only=True`, or formulas are lost on save) |
| See what is in a workbook, lint formulas | `scripts/xlsx_inspect.py model.xlsx` |
| Find formula errors after calculation | `scripts/xlsx_recalc.py model.xlsx --check` |
| Get stored values into the file | `scripts/xlsx_recalc.py model.xlsx -o calculated.xlsx` |
| Fix package-level damage | `scripts/ooxml_tools.py check / unpack / pack` |

## Scripts

`xlsx_inspect.py` reads a workbook and reports sheets, formula counts, defined
names, and problems: cached errors, formulas with no stored value, references to
sheets that do not exist, links to other workbooks, volatile functions (`INDIRECT`,
`OFFSET`, `NOW`, ...) and a literal-zero divisor. Add `--formulas` to list each
formula with its stored value and `--allow-uncalculated` to skip the "no stored
value" finding for a file you just generated.

`xlsx_recalc.py` runs LibreOffice headless on a copy, reads back the computed
values, and lists every error cell. `--check` writes nothing. `-o` writes the
recalculated file; compare it with your original before replacing it, because
LibreOffice may restyle or drop features it does not support. If LibreOffice is
missing it exits 3 and says so; do not claim the workbook was calculated.

`ooxml_tools.py` is the shared package tool (unpack, pack, structural check).

## Working rules

- **Inputs apart from calculations.** Put assumptions in one labelled place and
  have formulas point at them. A constant buried inside a formula
  (`=B7*1.0825`) is a hidden assumption.
- **Mark inputs.** A common convention: blue font for typed inputs, black for
  formulas, green for links to other sheets. Explain whichever you use in a note
  on the sheet.
- **Check the edges.** Divide with a guard (`=IF(B2=0,"",A2/B2)` or
  `IFERROR` only where an error is truly acceptable), anchor ranges with `$`, and
  keep ranges to the data you mean, not whole columns inside heavy formulas.
- **Dates are numbers with a format.** Write real `datetime` objects and set
  `number_format`; text that looks like a date will not sort or calculate.
- **Keep it readable.** Freeze header rows, set column widths, format numbers
  (`'0.0%'`, `'#,##0'`), and avoid merged cells in data regions because they break
  sorting and pandas reads.
- **Totals reconcile.** After building, recalculate and compare a few totals with
  an independent calculation (pandas, or by hand) before reporting numbers.
- **Report plainly.** State which sheets you changed, which formulas you added,
  and whether the workbook was recalculated and by what.

## Limits

- openpyxl does not evaluate formulas, run macros (`.xlsm` macros are kept only
  with `keep_vba=True`), or render charts to images.
- Loading and saving with openpyxl can drop features it does not model: pivot
  tables' cached data, slicers, some conditional-format extensions, form
  controls, and images in certain forms. For a workbook that depends on them,
  edit a copy and open the result in Excel to confirm, or edit the XML
  (`ooxml_tools.py unpack`) for a narrow change.
- Data-only reads (`data_only=True`) return the values stored at the last save by
  a calculating application; stale if nothing recalculated since an edit.
- Large files: use `read_only=True` or `write_only=True` modes and avoid
  per-cell style loops.
