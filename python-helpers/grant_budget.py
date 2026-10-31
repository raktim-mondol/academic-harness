#!/usr/bin/env python3
"""Write a grant-budget workbook from the JSON request on stdin.

The JS ledger owns the arithmetic; this helper only renders already-computed
rows into an .xlsx workbook. It never re-computes or interprets a budget.
"""
import json
import sys

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font
except Exception as exc:  # pragma: no cover - dependency probe
    print(json.dumps({"error": f"openpyxl is not available: {exc}"}))
    sys.exit(0)


def main() -> None:
    try:
        request = json.load(sys.stdin)
        path = request["path"]
        workbook = Workbook()
        workbook.remove(workbook.active)
        for sheet in request.get("sheets", []):
            worksheet = workbook.create_sheet(title=str(sheet.get("name", "Sheet"))[:31])
            for row in sheet.get("rows", []):
                worksheet.append(list(row))
            if worksheet.max_row:
                for cell in worksheet[1]:
                    cell.font = Font(bold=True)
            for column_cells in worksheet.columns:
                length = max((len(str(cell.value)) if cell.value is not None else 0) for cell in column_cells)
                worksheet.column_dimensions[column_cells[0].column_letter].width = min(80, max(10, length + 2))
        workbook.save(path)
        print(json.dumps({"ok": True, "path": path}))
    except Exception as exc:  # noqa: BLE001 - one JSON error channel is the contract
        print(json.dumps({"error": str(exc)}))


if __name__ == "__main__":
    main()
