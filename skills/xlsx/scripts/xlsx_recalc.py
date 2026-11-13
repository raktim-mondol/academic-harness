#!/usr/bin/env python3
"""Recalculate a workbook with LibreOffice and report formula errors.

    xlsx_recalc.py model.xlsx --check                 # recalculate a copy, report, write nothing
    xlsx_recalc.py model.xlsx -o model-calculated.xlsx
    xlsx_recalc.py model.xlsx --check --json

Why: openpyxl writes formulas but does not compute them, so a file it saves has
no stored results. Excel recalculates on open, but readers such as pandas or a
preview pane show nothing. LibreOffice, run headless, computes every formula.
This script runs it on a COPY, then reads the computed values and lists every
cell that evaluates to an error (#REF!, #DIV/0!, #NAME?, #VALUE!, #N/A ...).

Trade-off for `-o`: the file LibreOffice writes can differ from yours in styling
details, and may drop features it does not support. Use `--check` to find
errors and keep your original as the deliverable; use `-o` when you need stored
values, and compare the two before replacing anything.

Needs LibreOffice (`soffice` on PATH, or set SOFFICE=/path/to/soffice). Without
it the script exits 3 and tells you; xlsx_inspect.py still lints statically.
Exit codes: 0 no errors, 1 formula errors found, 2 bad input, 3 no LibreOffice.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xlsx_inspect import ERROR_VALUES  # noqa: E402

try:
    import openpyxl
except ImportError:  # pragma: no cover
    sys.exit("xlsx_recalc.py needs openpyxl (pip install openpyxl)")


def find_soffice() -> str | None:
    explicit = os.environ.get("SOFFICE")
    if explicit:
        return explicit if Path(explicit).exists() else None
    return shutil.which("soffice") or shutil.which("libreoffice")


def recalculate(src: Path, workdir: Path, soffice: str, timeout: int = 180) -> Path:
    """Convert src to xlsx through LibreOffice; returns the recalculated copy."""
    outdir = workdir / "out"
    profile = workdir / "profile"
    outdir.mkdir()
    cmd = [
        soffice,
        f"-env:UserInstallation={profile.resolve().as_uri()}",  # private profile: no clash with a running instance
        "--headless", "--norestore", "--calc",
        "--convert-to", "xlsx:Calc MS Excel 2007 XML",
        "--outdir", str(outdir),
        str(src),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    produced = outdir / (src.stem + ".xlsx")
    if result.returncode != 0 or not produced.exists():
        raise RuntimeError(f"LibreOffice conversion failed (exit {result.returncode}): {(result.stderr or result.stdout).strip()[:400]}")
    return produced


def scan(path: Path) -> dict:
    formulas = openpyxl.load_workbook(path)
    values = openpyxl.load_workbook(path, data_only=True)
    total = 0
    errors: dict[str, str] = {}
    uncalculated: list[str] = []
    for ws in formulas.worksheets:
        vs = values[ws.title]
        for row in ws.iter_rows():
            for cell in row:
                is_formula = cell.data_type == "f" or (isinstance(cell.value, str) and cell.value.startswith("="))
                stored = vs[cell.coordinate].value
                if is_formula:
                    total += 1
                    if stored is None:
                        uncalculated.append(f"{ws.title}!{cell.coordinate}")
                if isinstance(stored, str) and stored in ERROR_VALUES:
                    errors[f"{ws.title}!{cell.coordinate}"] = stored
    return {"formulas": total, "errors": errors, "uncalculated": uncalculated}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("xlsx")
    ap.add_argument("-o", "--output", help="write the recalculated workbook here")
    ap.add_argument("--check", action="store_true", help="report only; write nothing")
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    if not args.output and not args.check:
        print("error: give -o OUTPUT or --check", file=sys.stderr)
        return 2
    src = Path(args.xlsx)
    if not src.exists():
        print(f"error: {src} not found", file=sys.stderr)
        return 2
    soffice = find_soffice()
    if not soffice:
        print("LibreOffice not found (looked for soffice/libreoffice, and $SOFFICE). Install it, or use xlsx_inspect.py for a static lint.", file=sys.stderr)
        return 3
    with tempfile.TemporaryDirectory(prefix="xlsx-recalc-") as tmp:
        work = Path(tmp)
        try:
            produced = recalculate(src, work, soffice, args.timeout)
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        report = scan(produced)
        report["recalculated_by"] = soffice
        if args.output and not args.check:
            shutil.copyfile(produced, args.output)
            report["output"] = args.output
    report["ok"] = not report["errors"]
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"{report['formulas']} formula(s) recalculated")
        for cell, err in report["errors"].items():
            print(f"ERROR {cell}: {err}")
        if report["uncalculated"]:
            print(f"{len(report['uncalculated'])} formula(s) still have no value (e.g. {report['uncalculated'][0]})")
        if report.get("output"):
            print(f"wrote {report['output']}")
        print("no formula errors" if report["ok"] else f"{len(report['errors'])} formula error(s)")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
