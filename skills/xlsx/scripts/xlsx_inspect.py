#!/usr/bin/env python3
"""Summarise a workbook and lint its formulas.

    xlsx_inspect.py model.xlsx                 # per-sheet summary
    xlsx_inspect.py model.xlsx --formulas      # also list every formula
    xlsx_inspect.py model.xlsx --json

Reports, per sheet: size, visibility, number of formulas, merged ranges, data
validations, charts, tables; and workbook-wide defined names. Then it looks for
problems:

  cached errors     cells whose stored value is #REF!, #DIV/0!, #NAME? ...
  uncalculated      formulas with no stored value (never calculated, or saved
                    by a library that does not compute); readers such as pandas
                    will see None until the file is recalculated
  missing sheet     a formula names a sheet that is not in the workbook
  external link     a formula points into another workbook ([1]Sheet!A1)
  volatile          INDIRECT, OFFSET, TODAY, NOW, RAND, RANDBETWEEN (recalculate
                    on every change; INDIRECT/OFFSET hide dependencies)
  literal zero      a divisor that is the literal 0

Exit code: 0 clean, 1 problems found, 2 could not read the file. It reads the
file only; it never modifies it.
"""
from __future__ import annotations

import argparse
import json
import re
import sys

try:
    import openpyxl
except ImportError:  # pragma: no cover
    sys.exit("xlsx_inspect.py needs openpyxl (pip install openpyxl)")

ERROR_VALUES = {"#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#REF!", "#VALUE!", "#SPILL!", "#CALC!", "#GETTING_DATA"}
VOLATILE = ("INDIRECT", "OFFSET", "TODAY", "NOW", "RAND", "RANDBETWEEN")
SHEET_REF = re.compile(r"(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z0-9_.]*))!")
EXTERNAL_REF = re.compile(r"\[\d+\]")
STRING_LITERAL = re.compile(r'"(?:[^"]|"")*"')


def _strip_strings(formula: str) -> str:
    return STRING_LITERAL.sub('""', formula)


def lint_formula(formula: str, sheet_names: set[str]) -> list[tuple[str, str]]:
    """(kind, detail) problems found in one formula string (leading '=' included)."""
    body = _strip_strings(formula)
    problems: list[tuple[str, str]] = []
    external = bool(EXTERNAL_REF.search(body))
    if external:
        problems.append(("external link", "points into another workbook"))
    if not external:
        for quoted, bare in SHEET_REF.findall(body):
            name = quoted.replace("''", "'") if quoted else bare
            if name and name not in sheet_names:
                problems.append(("missing sheet", f"no sheet named {name!r}"))
    upper = body.upper()
    for fn in VOLATILE:
        if re.search(rf"\b{fn}\s*\(", upper):
            problems.append(("volatile", fn))
    if re.search(r"/\s*0(?![\d.])", body):
        problems.append(("literal zero", "divides by the literal 0"))
    return sorted(set(problems))


def inspect_workbook(path: str, list_formulas: bool = False, allow_uncalculated: bool = False) -> dict:
    wb = openpyxl.load_workbook(path)                    # formulas
    cached = openpyxl.load_workbook(path, data_only=True)  # stored values
    names = set(wb.sheetnames)
    sheets = []
    problems = []
    for ws in wb.worksheets:
        values = cached[ws.title]
        formulas = 0
        listing = []
        for row in ws.iter_rows():
            for cell in row:
                value = cell.value
                is_formula = cell.data_type == "f" or (isinstance(value, str) and value.startswith("="))
                if is_formula:
                    formulas += 1
                    text = value if isinstance(value, str) else getattr(value, "text", str(value))
                    stored = values[cell.coordinate].value
                    if list_formulas:
                        listing.append({"cell": cell.coordinate, "formula": text, "cached": stored})
                    if stored is None and not allow_uncalculated:
                        problems.append({"sheet": ws.title, "cell": cell.coordinate, "kind": "uncalculated", "detail": text})
                    for kind, detail in lint_formula(text, names):
                        problems.append({"sheet": ws.title, "cell": cell.coordinate, "kind": kind, "detail": f"{detail}: {text}"})
                stored_value = values[cell.coordinate].value
                if isinstance(stored_value, str) and stored_value in ERROR_VALUES:
                    problems.append({"sheet": ws.title, "cell": cell.coordinate, "kind": "cached error", "detail": stored_value})
        entry = {
            "name": ws.title,
            "state": ws.sheet_state,
            "dimensions": ws.dimensions,
            "formulas": formulas,
            "merged_ranges": len(ws.merged_cells.ranges),
            "data_validations": len(ws.data_validations.dataValidation) if ws.data_validations else 0,
            "charts": len(getattr(ws, "_charts", [])),
            "tables": list(ws.tables.keys()),
        }
        if list_formulas:
            entry["formula_cells"] = listing
        sheets.append(entry)
    defined = sorted(wb.defined_names.keys()) if hasattr(wb.defined_names, "keys") else []
    return {"file": path, "sheets": sheets, "defined_names": defined, "problems": problems, "ok": not problems}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("xlsx")
    ap.add_argument("--formulas", action="store_true", help="list every formula with its stored value")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--allow-uncalculated", action="store_true",
                    help="do not report formulas that have no stored value (a file just written by openpyxl has none)")
    args = ap.parse_args(argv)
    try:
        report = inspect_workbook(args.xlsx, args.formulas, args.allow_uncalculated)
    except Exception as exc:  # noqa: BLE001 - openpyxl raises many types for bad files
        print(f"error: cannot read {args.xlsx}: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=2, default=str))
        return 0 if report["ok"] else 1
    for s in report["sheets"]:
        flag = "" if s["state"] == "visible" else f" [{s['state']}]"
        print(f"{s['name']}{flag}: {s['dimensions']}, {s['formulas']} formula(s), {s['merged_ranges']} merged, {s['charts']} chart(s)")
        for f in s.get("formula_cells", []):
            print(f"    {f['cell']:<8} {f['formula']}   -> {f['cached']!r}")
    if report["defined_names"]:
        print("defined names:", ", ".join(report["defined_names"]))
    for p in report["problems"]:
        print(f"PROBLEM {p['sheet']}!{p['cell']}: {p['kind']} - {p['detail']}")
    print("clean" if report["ok"] else f"{len(report['problems'])} problem(s)")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
