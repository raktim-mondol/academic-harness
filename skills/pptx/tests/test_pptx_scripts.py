"""Tests for the pptx skill scripts. Run: python -m unittest discover -s skills/pptx/tests

Needs python-pptx. The thumbnail tests also need Pillow, reportlab and poppler's
pdftoppm; LibreOffice is replaced by a stand-in that returns a prepared PDF, so
those tests prove the plumbing and not LibreOffice's rendering.
"""
import json
import os
import re
import shutil
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
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Inches, Pt
    HAVE_PPTX = True
except ImportError:  # pragma: no cover
    HAVE_PPTX = False

try:
    from PIL import Image
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

try:
    from reportlab.lib.pagesizes import landscape, A4
    from reportlab.pdfgen import canvas
    HAVE_REPORTLAB = True
except ImportError:
    HAVE_REPORTLAB = False

import ooxml_tools as O  # noqa: E402


def run(name, *args, env=None):
    return subprocess.run([sys.executable, str(SCRIPTS / name), *map(str, args)], capture_output=True, text=True, env=env)


def png(path, color="red"):
    Image.new("RGB", (60, 40), color).save(path)
    return path


def make_deck(path, image):
    prs = Presentation()
    # 1: clean slide with a title, a body, notes and a chart
    s1 = prs.slides.add_slide(prs.slide_layouts[1])
    s1.shapes.title.text = "Results"
    body = s1.placeholders[1].text_frame
    body.text = "Primary outcome improved"
    p = body.add_paragraph()
    p.text = "Effect size 0.42"
    p.level = 1
    s1.notes_slide.notes_text_frame.text = "Mention the CI."
    # 2: title only, a small-font box, an off-slide box, a picture without alt text
    s2 = prs.slides.add_slide(prs.slide_layouts[5])
    s2.shapes.title.text = "Problems"
    small = s2.shapes.add_textbox(Inches(1), Inches(2), Inches(3), Inches(1))
    small.text_frame.text = "tiny print"
    small.text_frame.paragraphs[0].runs[0].font.size = Pt(9)
    s2.shapes.add_textbox(Inches(9), Inches(1), Inches(3), Inches(1)).text_frame.text = "off the edge"
    s2.shapes.add_picture(str(image), Inches(1), Inches(4), Inches(1.5), Inches(1))
    # 3: blank layout, no title; too much text; an overflowing box; two overlapping boxes
    s3 = prs.slides.add_slide(prs.slide_layouts[6])
    wall = s3.shapes.add_textbox(Inches(0.5), Inches(0.5), Inches(2), Inches(0.5))
    wall.text_frame.text = " ".join(["word"] * 120)
    wall.text_frame.paragraphs[0].runs[0].font.size = Pt(18)
    a = s3.shapes.add_textbox(Inches(5), Inches(3), Inches(3), Inches(2))
    a.text_frame.text = "box a"
    b = s3.shapes.add_textbox(Inches(5.5), Inches(3.2), Inches(3), Inches(2))
    b.text_frame.text = "box b"
    # 4: layout with a body placeholder left empty
    s4 = prs.slides.add_slide(prs.slide_layouts[1])
    s4.shapes.title.text = "Empty body"
    # table + chart on slide 5
    s5 = prs.slides.add_slide(prs.slide_layouts[5])
    s5.shapes.title.text = "Data"
    table = s5.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(4), Inches(1)).table
    table.cell(0, 0).text = "Group"
    table.cell(0, 1).text = "Mean"
    table.cell(1, 0).text = "A"
    table.cell(1, 1).text = "3.1"
    data = CategoryChartData()
    data.categories = ["A", "B"]
    data.add_series("Mean", (3.1, 2.7))
    s5.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(5.5), Inches(2), Inches(4), Inches(3), data)
    prs.save(str(path))
    return path


def make_clean_deck(path):
    prs = Presentation()
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = "One clear point"
    s.placeholders[1].text_frame.text = "Supporting evidence"
    prs.save(str(path))
    return path


@unittest.skipUnless(HAVE_PPTX and HAVE_PIL, "python-pptx and Pillow are required")
class OutlineAndCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.deck = make_deck(self.dir / "deck.pptx", png(self.dir / "pic.png"))

    def tearDown(self):
        self.tmp.cleanup()

    def findings(self, *extra):
        r = run("pptx_check.py", self.deck, "--json", *extra)
        return json.loads(r.stdout)["findings"], r

    def kinds(self, slide, *extra):
        findings, _ = self.findings(*extra)
        return sorted(f["kind"] for f in findings if f["slide"] == slide)

    def test_outline_reads_titles_levels_notes_tables_and_charts(self):
        data = json.loads(run("pptx_outline.py", self.deck, "--json", "--notes").stdout)
        slides = {s["slide"]: s for s in data["slides"]}
        self.assertEqual(len(slides), 5)
        self.assertEqual(slides[1]["title"], "Results")
        lines = [(l["level"], l["text"]) for b in slides[1]["text"] for l in b["lines"]]
        self.assertEqual(lines, [(0, "Primary outcome improved"), (1, "Effect size 0.42")])
        self.assertEqual(slides[1]["notes"], "Mention the CI.")
        self.assertEqual(slides[3]["title"], "")
        self.assertEqual(slides[5]["tables"], [[["Group", "Mean"], ["A", "3.1"]]])
        self.assertEqual(slides[5]["charts"], 1)
        self.assertEqual(len(slides[2]["pictures"]), 1)
        self.assertEqual(slides[2]["pictures"][0]["alt"], "pic.png")  # python-pptx fills in the file name

    def test_outline_text_form_is_readable(self):
        out = run("pptx_outline.py", self.deck).stdout
        self.assertIn("[1] Results", out)
        self.assertIn("  - Effect size 0.42", out)
        self.assertIn("[3] (no title)", out)

    def test_notes_are_only_included_when_asked(self):
        data = json.loads(run("pptx_outline.py", self.deck, "--json").stdout)
        self.assertNotIn("notes", data["slides"][0])

    def test_check_flags_each_problem_on_the_right_slide(self):
        self.assertEqual(self.kinds(1), [])
        self.assertEqual(self.kinds(2), ["alt-text", "off-slide", "small-font"])
        kinds3 = self.kinds(3)
        for expected in ("no-title", "too-much-text", "may-overflow", "overlap"):
            self.assertIn(expected, kinds3)
        self.assertEqual(self.kinds(4), ["empty-placeholder"])
        self.assertEqual(self.kinds(5), [])

    def test_a_real_alt_text_clears_the_warning_but_a_file_name_does_not(self):
        prs = Presentation(str(self.deck))
        pic = next(sh for sh in prs.slides[1].shapes if sh.shape_type == 13)
        pic._element.xpath(".//p:cNvPr")[0].set("descr", "Bar chart of read depth by sample")
        fixed = self.dir / "alt.pptx"
        prs.save(str(fixed))
        out = json.loads(run("pptx_check.py", fixed, "--json").stdout)["findings"]
        self.assertFalse([f for f in out if f["kind"] == "alt-text"])

    def test_min_font_and_max_words_are_adjustable(self):
        self.assertNotIn("small-font", self.kinds(2, "--min-font", "8"))
        self.assertNotIn("too-much-text", self.kinds(3, "--max-words", "500"))

    def test_exit_codes_errors_always_fail_warnings_only_when_strict(self):
        self.assertEqual(run("pptx_check.py", self.deck).returncode, 1)  # off-slide is an error
        clean = make_clean_deck(self.dir / "clean.pptx")
        self.assertEqual(run("pptx_check.py", clean).returncode, 0)
        # a deck with warnings but no errors
        prs = Presentation()
        s = prs.slides.add_slide(prs.slide_layouts[6])
        s.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(1)).text_frame.text = "untitled"
        warn_only = self.dir / "warn.pptx"
        prs.save(str(warn_only))
        self.assertEqual(run("pptx_check.py", warn_only).returncode, 0)
        self.assertEqual(run("pptx_check.py", warn_only, "--strict").returncode, 1)

    def test_unreadable_file_is_exit_2(self):
        bad = self.dir / "bad.pptx"
        bad.write_bytes(b"nope")
        self.assertEqual(run("pptx_check.py", bad).returncode, 2)
        self.assertEqual(run("pptx_outline.py", bad).returncode, 2)

    def test_scripts_do_not_modify_the_deck(self):
        before = self.deck.read_bytes()
        run("pptx_check.py", self.deck)
        run("pptx_outline.py", self.deck, "--notes")
        self.assertEqual(self.deck.read_bytes(), before)

    def test_generated_deck_passes_the_package_check(self):
        report = O.check_package(self.deck)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["kind"], "pptx")

    def test_a_slide_pointing_at_a_missing_relationship_is_caught(self):
        broken = self.dir / "broken.pptx"
        with zipfile.ZipFile(self.deck) as zin, zipfile.ZipFile(broken, "w") as zout:
            for item in zin.infolist():
                data = zin.read(item)
                if item.filename == "ppt/presentation.xml":
                    data = re.sub(rb'(<p:sldId [^>]*r:id=")rId\d+(")', rb"\1rId99\2", data, count=1)
                zout.writestr(item, data)
        report = O.check_package(broken)
        self.assertFalse(report["ok"])
        self.assertTrue(any("slide references unknown relationship" in e for e in report["errors"]), report)


@unittest.skipUnless(HAVE_PPTX and HAVE_PIL and HAVE_REPORTLAB and shutil.which("pdftoppm"), "needs python-pptx, Pillow, reportlab and pdftoppm")
class Thumbs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.deck = make_clean_deck(self.dir / "deck.pptx")
        self.pdf = self.dir / "result.pdf"
        c = canvas.Canvas(str(self.pdf), pagesize=landscape(A4))
        for n in range(1, 6):
            c.setFont("Helvetica", 40)
            c.drawString(100, 300, f"slide {n}")
            c.showPage()
        c.save()
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.log = self.dir / "args.json"
        fake = self.bin / "soffice"
        fake.write_text(
            "#!{py}\nimport json, shutil, sys\nfrom pathlib import Path\n"
            "a = sys.argv[1:]\nPath({log!r}).write_text(json.dumps(a))\n"
            "out = Path(a[a.index('--outdir') + 1])\nshutil.copyfile({pdf!r}, out / (Path(a[-1]).stem + '.pdf'))\n".format(
                py=sys.executable, log=str(self.log), pdf=str(self.pdf)))
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        self.env = {**os.environ, "SOFFICE": str(fake)}

    def tearDown(self):
        self.tmp.cleanup()

    def test_deck_to_contact_sheet(self):
        out = self.dir / "sheet.png"
        r = run("pptx_thumbs.py", self.deck, "-o", out, "--cols", "3", "--width", "200", env=self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("5 slide(s)", r.stdout)
        with Image.open(out) as sheet:
            # 3 columns of 200px tiles plus gaps, 2 rows
            self.assertEqual(sheet.width, 3 * 200 + 4 * 10)
            self.assertGreater(sheet.height, 2 * 100)
        args = json.loads(self.log.read_text())
        self.assertIn("--headless", args)
        self.assertTrue(any(a.startswith("-env:UserInstallation=file://") for a in args))

    def test_slides_dir_keeps_one_png_per_slide(self):
        out = self.dir / "sheet.png"
        slides = self.dir / "slides"
        r = run("pptx_thumbs.py", self.deck, "-o", out, "--slides-dir", slides, env=self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(p.name for p in slides.glob("*.png")), [f"slide-{i:03d}.png" for i in range(1, 6)])

    def test_a_pdf_input_skips_libreoffice(self):
        out = self.dir / "from-pdf.png"
        env = {"PATH": os.environ["PATH"]}
        env.pop("SOFFICE", None)
        r = run("pptx_thumbs.py", self.pdf, "-o", out, env={**env, "SOFFICE": ""})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(out.exists())
        self.assertFalse(self.log.exists(), "LibreOffice must not run for a PDF input")

    def test_missing_libreoffice_is_exit_3_with_guidance(self):
        r = run("pptx_thumbs.py", self.deck, "-o", self.dir / "x.png", env={"PATH": "/nonexistent"})
        self.assertEqual(r.returncode, 3)
        self.assertIn("LibreOffice not found", r.stderr)

    def test_dry_run_prints_commands_and_runs_nothing(self):
        r = run("pptx_thumbs.py", self.deck, "--dry-run", env=self.env)
        self.assertEqual(r.returncode, 0)
        self.assertIn("pdftoppm", r.stdout)
        self.assertFalse(self.log.exists())

    def test_conversion_failure_is_reported(self):
        failing = self.bin / "soffice"
        failing.write_text("#!/bin/sh\necho boom >&2\nexit 9\n")
        failing.chmod(failing.stat().st_mode | stat.S_IEXEC)
        r = run("pptx_thumbs.py", self.deck, "-o", self.dir / "x.png", env=self.env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("LibreOffice conversion failed", r.stderr)

    def test_missing_input_is_exit_2(self):
        self.assertEqual(run("pptx_thumbs.py", self.dir / "none.pptx", env=self.env).returncode, 2)


@unittest.skipUnless(HAVE_PPTX and HAVE_PIL, "python-pptx and Pillow are required")
class Recipes(unittest.TestCase):
    """Every python block in references/python-pptx-recipes.md must run, and the result must check clean."""

    def test_every_recipe_block_executes(self):
        import re
        text = (HERE.parent / "references" / "python-pptx-recipes.md").read_text()
        blocks = re.findall(r"```python\n(.*?)```", text, re.S)
        self.assertGreaterEqual(len(blocks), 6)
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
                report = O.check_package(Path(tmp) / "talk.pptx")
                self.assertTrue(report["ok"], report)
                self.assertTrue(O.check_package(Path(tmp) / "reordered.pptx")["ok"])
                outline = json.loads(run("pptx_outline.py", Path(tmp) / "talk.pptx", "--json", "--notes").stdout)
                titles = [s["title"] for s in outline["slides"]]
                self.assertIn("Treatment B halves relapse", titles)
                self.assertIn("Relapse rate", titles)
                alts = [p["alt"] for s in outline["slides"] for p in s["pictures"]]
                self.assertIn("Bar chart of relapse rate by treatment arm", alts)
                moved = json.loads(run("pptx_outline.py", Path(tmp) / "reordered.pptx", "--json").stdout)
                self.assertEqual(moved["slides"][1]["title"], "Relapse rate")
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
