"""Tests for the xlsx skill scripts. Run: python -m unittest discover -s skills/xlsx/tests

Needs openpyxl and lxml. LibreOffice is not required: the recalculation tests
use a stand-in `soffice` that returns a prepared result, so they prove the
plumbing (arguments, copy handling, error scan, exit codes) and not LibreOffice
itself.
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

try:
    import openpyxl
    from lxml import etree
    HAVE_LIBS = True
except ImportError:  # pragma: no cover
    HAVE_LIBS = False

import ooxml_tools as O  # noqa: E402

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def run(name, *args, env=None):
    return subprocess.run([sys.executable, str(SCRIPTS / name), *map(str, args)], capture_output=True, text=True, env=env)


def make_workbook(path):
    wb = openpyxl.Workbook()
    data = wb.active
    data.title = "Data"
    for i, v in enumerate([3, 5, 8], start=1):
        data.cell(row=i, column=1, value=v)
    summary = wb.create_sheet("Summary")
    summary["B1"] = "=SUM(Data!A1:A3)"
    summary["B2"] = "=B1/0"
    summary["B3"] = "=Missing!A1"
    summary["B4"] = "=NOW()"
    summary["B5"] = "=INDIRECT(\"Data!A1\")"
    summary["B6"] = '=IF(A1="=Missing!X1","ok","no")'      # sheet name inside a string is not a reference
    summary["B7"] = "='Data'!A2*2"
    wb.save(path)
    return path


def add_cached_values(src, dest, values):
    """Write stored results into formula cells, as a calculating application would."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item)
            if item.filename == "xl/worksheets/sheet2.xml":
                root = etree.fromstring(data)
                for c in root.iter(f"{{{NS}}}c"):
                    ref = c.get("r")
                    if ref in values and c.find(f"{{{NS}}}f") is not None:
                        v = c.find(f"{{{NS}}}v")
                        if v is None:
                            v = etree.SubElement(c, f"{{{NS}}}v")
                        value = values[ref]
                        v.text = str(value)
                        if isinstance(value, str) and value.startswith("#"):
                            c.set("t", "e")
                        elif isinstance(value, str):
                            c.set("t", "str")
                        elif "t" in c.attrib:
                            del c.attrib["t"]
                data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            zout.writestr(item, data)


def write_fake_soffice(directory, result_file, log_file):
    script = directory / "soffice"
    script.write_text(
        "#!{py}\n"
        "import json, shutil, sys\n"
        "from pathlib import Path\n"
        "args = sys.argv[1:]\n"
        "Path({log!r}).write_text(json.dumps(args))\n"
        "outdir = Path(args[args.index('--outdir') + 1])\n"
        "src = Path(args[-1])\n"
        "shutil.copyfile({result!r}, outdir / (src.stem + '.xlsx'))\n".format(py=sys.executable, log=str(log_file), result=str(result_file))
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


@unittest.skipUnless(HAVE_LIBS, "openpyxl and lxml are required")
class Inspect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.book = make_workbook(self.dir / "m.xlsx")

    def tearDown(self):
        self.tmp.cleanup()

    def problems(self, **kwargs):
        sys.path.insert(0, str(SCRIPTS))
        import xlsx_inspect as X
        return X.inspect_workbook(str(self.book), **kwargs)["problems"]

    def kinds(self, cell, **kwargs):
        return sorted(p["kind"] for p in self.problems(**kwargs) if p["cell"] == cell)

    def test_summary_lists_sheets_and_formula_counts(self):
        out = run("xlsx_inspect.py", self.book, "--json", "--allow-uncalculated")
        report = json.loads(out.stdout)
        sheets = {s["name"]: s for s in report["sheets"]}
        self.assertEqual(set(sheets), {"Data", "Summary"})
        self.assertEqual(sheets["Summary"]["formulas"], 7)
        self.assertEqual(sheets["Data"]["formulas"], 0)

    def test_lint_findings_per_cell(self):
        self.assertEqual(self.kinds("B3", allow_uncalculated=True), ["missing sheet"])
        self.assertEqual(self.kinds("B2", allow_uncalculated=True), ["literal zero"])
        self.assertEqual(self.kinds("B4", allow_uncalculated=True), ["volatile"])
        self.assertEqual(self.kinds("B5", allow_uncalculated=True), ["volatile"])

    def test_clean_formulas_are_not_flagged(self):
        for cell in ("B1", "B6", "B7"):
            self.assertEqual(self.kinds(cell, allow_uncalculated=True), [], cell)

    def test_uncalculated_formulas_are_reported_unless_allowed(self):
        self.assertIn("uncalculated", self.kinds("B1"))
        self.assertNotIn("uncalculated", self.kinds("B1", allow_uncalculated=True))

    def test_cached_errors_are_found(self):
        calculated = self.dir / "calc.xlsx"
        add_cached_values(self.book, calculated, {"B1": 16, "B2": "#DIV/0!", "B3": "#REF!", "B4": 46000, "B5": 3, "B6": "no", "B7": 10})
        self.book = calculated
        found = {p["cell"]: p["detail"] for p in self.problems() if p["kind"] == "cached error"}
        self.assertEqual(found, {"B2": "#DIV/0!", "B3": "#REF!"})

    def test_external_link_is_flagged_not_called_a_missing_sheet(self):
        wb = openpyxl.load_workbook(self.book)
        wb["Summary"]["C1"] = "=[1]Other!A1"
        wb.save(self.book)
        self.assertEqual(self.kinds("C1", allow_uncalculated=True), ["external link"])

    def test_exit_codes_and_unreadable_file(self):
        self.assertEqual(run("xlsx_inspect.py", self.book).returncode, 1)
        bad = self.dir / "bad.xlsx"
        bad.write_bytes(b"not a workbook")
        r = run("xlsx_inspect.py", bad)
        self.assertEqual(r.returncode, 2)
        self.assertIn("cannot read", r.stderr)

    def test_formula_listing_shows_cached_value(self):
        out = run("xlsx_inspect.py", self.book, "--formulas", "--allow-uncalculated").stdout
        self.assertIn("B1", out)
        self.assertIn("=SUM(Data!A1:A3)", out)

    def test_the_inspector_does_not_modify_the_file(self):
        before = self.book.read_bytes()
        run("xlsx_inspect.py", self.book, "--formulas")
        self.assertEqual(self.book.read_bytes(), before)


@unittest.skipUnless(HAVE_LIBS, "openpyxl and lxml are required")
class Recalc(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.book = make_workbook(self.dir / "m.xlsx")
        self.result = self.dir / "result.xlsx"
        add_cached_values(self.book, self.result, {"B1": 16, "B2": "#DIV/0!", "B3": "#REF!", "B4": 46000, "B5": 3, "B6": "no", "B7": 10})
        self.log = self.dir / "args.json"
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        write_fake_soffice(self.bin, self.result, self.log)
        self.env = {**os.environ, "SOFFICE": str(self.bin / "soffice")}

    def tearDown(self):
        self.tmp.cleanup()

    def test_check_reports_errors_and_writes_nothing(self):
        r = run("xlsx_recalc.py", self.book, "--check", "--json", env=self.env)
        self.assertEqual(r.returncode, 1, r.stderr)
        report = json.loads(r.stdout)
        self.assertEqual(report["errors"], {"Summary!B2": "#DIV/0!", "Summary!B3": "#REF!"})
        self.assertEqual(report["formulas"], 7)
        self.assertEqual(report["uncalculated"], [])
        self.assertFalse(report["ok"])
        self.assertEqual(sorted(p.name for p in self.dir.glob("*.xlsx")), ["m.xlsx", "result.xlsx"])

    def test_libreoffice_is_invoked_headless_on_a_copy_with_a_private_profile(self):
        before = self.book.read_bytes()
        run("xlsx_recalc.py", self.book, "--check", env=self.env)
        args = json.loads(self.log.read_text())
        self.assertIn("--headless", args)
        self.assertIn("--convert-to", args)
        self.assertTrue(any(a.startswith("-env:UserInstallation=file://") for a in args))
        self.assertEqual(self.book.read_bytes(), before, "the input must not be modified")

    def test_output_is_written_when_asked(self):
        out = self.dir / "calculated.xlsx"
        r = run("xlsx_recalc.py", self.book, "-o", out, env=self.env)
        self.assertEqual(r.returncode, 1)  # errors exist, but the file is still written
        self.assertTrue(out.exists())
        self.assertEqual(openpyxl.load_workbook(out, data_only=True)["Summary"]["B1"].value, 16)

    def test_clean_workbook_exits_zero(self):
        wb = openpyxl.Workbook()
        wb.active["A1"] = 2
        wb.active["B1"] = "=A1*2"
        clean = self.dir / "clean.xlsx"
        wb.save(clean)
        # stand-in result for a one-sheet workbook: patch sheet1
        calc = self.dir / "clean-calc.xlsx"
        with zipfile.ZipFile(clean) as zin, zipfile.ZipFile(calc, "w") as zout:
            for item in zin.infolist():
                data = zin.read(item)
                if item.filename == "xl/worksheets/sheet1.xml":
                    root = etree.fromstring(data)
                    for c in root.iter(f"{{{NS}}}c"):
                        if c.find(f"{{{NS}}}f") is not None:
                            v = c.find(f"{{{NS}}}v")
                            if v is None:
                                v = etree.SubElement(c, f"{{{NS}}}v")
                            v.text = "4"
                    data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
                zout.writestr(item, data)
        write_fake_soffice(self.bin, calc, self.log)
        r = run("xlsx_recalc.py", clean, "--check", env=self.env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("no formula errors", r.stdout)

    def test_missing_libreoffice_is_exit_3_with_guidance(self):
        env = {"PATH": "/nonexistent"}
        r = run("xlsx_recalc.py", self.book, "--check", env=env)
        self.assertEqual(r.returncode, 3)
        self.assertIn("LibreOffice not found", r.stderr)
        self.assertIn("xlsx_inspect.py", r.stderr)

    def test_usage_errors(self):
        self.assertEqual(run("xlsx_recalc.py", self.book, env=self.env).returncode, 2)
        self.assertEqual(run("xlsx_recalc.py", self.dir / "none.xlsx", "--check", env=self.env).returncode, 2)

    def test_conversion_failure_is_reported(self):
        failing = self.bin / "soffice"
        failing.write_text("#!/bin/sh\necho boom >&2\nexit 7\n")
        failing.chmod(failing.stat().st_mode | stat.S_IEXEC)
        r = run("xlsx_recalc.py", self.book, "--check", env=self.env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("LibreOffice conversion failed", r.stderr)


@unittest.skipUnless(HAVE_LIBS, "openpyxl and lxml are required")
class Package(unittest.TestCase):
    def test_an_openpyxl_workbook_passes_the_package_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = make_workbook(Path(tmp) / "m.xlsx")
            report = O.check_package(path)
            self.assertTrue(report["ok"], report)
            self.assertEqual(report["kind"], "xlsx")

    def test_a_sheet_with_a_broken_relationship_is_caught(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = make_workbook(Path(tmp) / "m.xlsx")
            broken = Path(tmp) / "broken.xlsx"
            with zipfile.ZipFile(path) as zin, zipfile.ZipFile(broken, "w") as zout:
                for item in zin.infolist():
                    data = zin.read(item)
                    if item.filename == "xl/workbook.xml":
                        data = data.replace(b'r:id="rId1"', b'r:id="rId77"')
                    zout.writestr(item, data)
            report = O.check_package(broken)
            self.assertFalse(report["ok"])
            self.assertTrue(any("unknown relationship rId77" in e for e in report["errors"]), report)


@unittest.skipUnless(HAVE_LIBS, "openpyxl and lxml are required")
class Recipes(unittest.TestCase):
    """Every python block in references/openpyxl-recipes.md must run against the installed openpyxl."""

    def test_every_recipe_block_executes_and_the_model_lints_clean(self):
        import re
        try:
            import pandas  # noqa: F401
        except ImportError:
            self.skipTest("pandas not installed")
        text = (HERE.parent / "references" / "openpyxl-recipes.md").read_text()
        blocks = re.findall(r"```python\n(.*?)```", text, re.S)
        self.assertGreaterEqual(len(blocks), 7)
        with tempfile.TemporaryDirectory() as tmp:
            cwd = os.getcwd()
            os.chdir(tmp)
            try:
                ns = {}
                for i, block in enumerate(blocks):
                    try:
                        exec(compile(block, f"recipe-block-{i}", "exec"), ns)
                    except Exception as exc:  # noqa: BLE001
                        self.fail(f"recipe block {i} failed: {type(exc).__name__}: {exc}\n{block[:200]}")
                import xlsx_inspect as X
                report = X.inspect_workbook(str(Path(tmp) / "model-linked.xlsx"), allow_uncalculated=True)
                self.assertTrue(report["ok"], report["problems"])
                self.assertEqual({s["name"] for s in report["sheets"]}, {"Model", "Summary"})
                self.assertTrue(O.check_package(Path(tmp) / "model-chart.xlsx")["ok"])
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
