"""Tests for the pdf skill scripts. Run: python -m unittest discover -s skills/pdf/tests

Needs pypdf and reportlab. pdfplumber, pdftoppm and pypdfium2 are optional and
their tests skip when absent.
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

try:
    from pypdf import PdfReader
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    HAVE_LIBS = True
except ImportError:  # pragma: no cover
    HAVE_LIBS = False

try:
    import pdfplumber  # noqa: F401
    HAVE_PLUMBER = True
except ImportError:
    HAVE_PLUMBER = False

try:
    import pypdfium2  # noqa: F401
    HAVE_PDFIUM = True
except ImportError:
    HAVE_PDFIUM = False


def run(name, *args):
    return subprocess.run([sys.executable, str(SCRIPTS / name), *map(str, args)], capture_output=True, text=True)


def make_text_pdf(path, pages=3):
    c = canvas.Canvas(str(path), pagesize=A4)
    for n in range(1, pages + 1):
        c.setFont("Helvetica", 14)
        c.drawString(72, 760, f"Page {n} heading")
        c.drawString(72, 730, f"Body text on page {n}: the quick brown fox.")
        c.showPage()
    c.save()
    return path


def make_form_pdf(path):
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 12)
    c.drawString(72, 760, "Full name:")
    c.drawString(72, 720, "I agree:")
    c.drawString(72, 680, "Country:")
    form = c.acroForm
    form.textfield(name="full_name", x=160, y=752, width=200, height=18, borderStyle="inset")
    form.checkbox(name="agree", x=160, y=714, size=16, buttonStyle="check")
    form.choice(name="country", value="UK", options=["UK", "France", "Chile"], x=160, y=672, width=120, height=18, fieldFlags="combo")
    c.showPage()
    c.save()
    return path


def make_flat_pdf(path):
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 12)
    c.drawString(72, 760, "Surname")
    c.line(140, 758, 360, 758)
    c.showPage()
    c.save()
    return path


@unittest.skipUnless(HAVE_LIBS, "pypdf and reportlab are required")
class Pages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.a = make_text_pdf(self.dir / "a.pdf", 3)
        self.b = make_text_pdf(self.dir / "b.pdf", 2)

    def tearDown(self):
        self.tmp.cleanup()

    def pages(self, path):
        return len(PdfReader(str(path)).pages)

    def test_merge_select_split(self):
        merged = self.dir / "m.pdf"
        self.assertEqual(run("pdf_pages.py", "merge", self.a, self.b, "-o", merged).returncode, 0)
        self.assertEqual(self.pages(merged), 5)

        part = self.dir / "part.pdf"
        self.assertEqual(run("pdf_pages.py", "select", merged, "-o", part, "--pages", "5,1-2").returncode, 0)
        reader = PdfReader(str(part))
        self.assertEqual(len(reader.pages), 3)
        self.assertIn("Page 2 heading", reader.pages[0].extract_text())  # page 5 is b.pdf's page 2
        self.assertIn("Page 1 heading", reader.pages[1].extract_text())

        out = self.dir / "parts"
        self.assertEqual(run("pdf_pages.py", "split", merged, "--outdir", out, "--every", "2").returncode, 0)
        sizes = sorted(self.pages(p) for p in out.glob("*.pdf"))
        self.assertEqual(sizes, [1, 2, 2])

    def test_page_range_errors_are_reported_not_raised(self):
        r = run("pdf_pages.py", "select", self.a, "-o", self.dir / "x.pdf", "--pages", "9")
        self.assertEqual(r.returncode, 2)
        self.assertIn("outside 1-3", r.stderr)

    def test_open_ended_ranges(self):
        part = self.dir / "tail.pdf"
        run("pdf_pages.py", "select", self.a, "-o", part, "--pages", "2-")
        self.assertEqual(self.pages(part), 2)

    def test_rotate_only_the_chosen_pages(self):
        out = self.dir / "r.pdf"
        self.assertEqual(run("pdf_pages.py", "rotate", self.a, "-o", out, "--degrees", "90", "--pages", "2").returncode, 0)
        rotations = [p.get("/Rotate", 0) for p in PdfReader(str(out)).pages]
        self.assertEqual(rotations, [0, 90, 0])
        self.assertEqual(run("pdf_pages.py", "rotate", self.a, "-o", out, "--degrees", "45").returncode, 2)

    def test_encrypt_then_decrypt(self):
        locked = self.dir / "locked.pdf"
        self.assertEqual(run("pdf_pages.py", "encrypt", self.a, "-o", locked, "--user-password", "s3cret").returncode, 0)
        self.assertTrue(PdfReader(str(locked)).is_encrypted)
        denied = run("pdf_text.py", locked)
        self.assertEqual(denied.returncode, 2)
        self.assertIn("encrypted", denied.stderr)
        opened = self.dir / "opened.pdf"
        self.assertEqual(run("pdf_pages.py", "decrypt", locked, "-o", opened, "--password", "s3cret").returncode, 0)
        self.assertFalse(PdfReader(str(opened)).is_encrypted)
        self.assertEqual(self.pages(opened), 3)

    def test_metadata_and_info(self):
        out = self.dir / "meta.pdf"
        run("pdf_pages.py", "meta", self.a, "-o", out, "--title", "Annual report", "--author", "Ada")
        meta = PdfReader(str(out)).metadata
        self.assertEqual(meta.title, "Annual report")
        info = run("pdf_pages.py", "info", out).stdout
        self.assertIn("pages:     3", info)
        self.assertIn("Annual report", info)


@unittest.skipUnless(HAVE_LIBS, "pypdf and reportlab are required")
class Text(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_extract_json_and_page_selection(self):
        pdf = make_text_pdf(self.dir / "t.pdf", 3)
        data = json.loads(run("pdf_text.py", pdf, "--json", "--pages", "2-3").stdout)
        self.assertEqual([d["page"] for d in data], [2, 3])
        self.assertIn("quick brown fox", data[0]["text"])
        self.assertFalse(data[0]["probably_scanned"])

    def test_blank_page_is_flagged_as_probably_scanned(self):
        c = canvas.Canvas(str(self.dir / "blank.pdf"), pagesize=A4)
        c.showPage()
        c.save()
        out = run("pdf_text.py", self.dir / "blank.pdf")
        self.assertIn("probably a scan", out.stdout)

    def test_layout_mode_runs(self):
        pdf = make_text_pdf(self.dir / "l.pdf", 1)
        out = run("pdf_text.py", pdf, "--layout")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("Page 1 heading", out.stdout)

    @unittest.skipUnless(HAVE_PLUMBER, "pdfplumber not installed")
    def test_table_extraction(self):
        c = canvas.Canvas(str(self.dir / "tab.pdf"), pagesize=A4)
        x0, y0, cw, ch = 72, 700, 100, 24
        for r in range(3):
            for col in range(3):
                c.rect(x0 + col * cw, y0 - r * ch, cw, ch)
                c.drawString(x0 + col * cw + 6, y0 - r * ch + 8, f"r{r}c{col}")
        c.showPage()
        c.save()
        out = run("pdf_text.py", self.dir / "tab.pdf", "--tables").stdout
        self.assertIn("| r0c0 | r0c1 | r0c2 |", out)
        self.assertIn("| r2c0 | r2c1 | r2c2 |", out)

    def test_tables_without_pdfplumber_is_a_clear_error(self):
        if HAVE_PLUMBER:
            self.skipTest("pdfplumber is installed")
        pdf = make_text_pdf(self.dir / "t.pdf", 1)
        r = run("pdf_text.py", pdf, "--tables")
        self.assertNotEqual(r.returncode, 0)


@unittest.skipUnless(HAVE_LIBS, "pypdf and reportlab are required")
class Forms(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.form = make_form_pdf(self.dir / "form.pdf")

    def tearDown(self):
        self.tmp.cleanup()

    def values(self, path):
        return {k: v.get("/V") for k, v in (PdfReader(str(path)).get_fields() or {}).items()}

    def test_lists_fields_with_kinds_and_states(self):
        fields = {f["name"]: f for f in json.loads(run("pdf_fields.py", self.form, "--json").stdout)}
        self.assertEqual(set(fields), {"full_name", "agree", "country"})
        self.assertEqual(fields["full_name"]["kind"], "text")
        self.assertEqual(fields["agree"]["kind"], "checkbox")
        self.assertTrue(fields["agree"]["on_state"])
        self.assertEqual(fields["country"]["kind"], "dropdown")
        self.assertEqual(fields["country"]["options"], ["UK", "France", "Chile"])
        self.assertEqual(fields["full_name"]["page"], 1)

    def test_fill_text_checkbox_and_dropdown(self):
        (self.dir / "v.json").write_text(json.dumps({"full_name": "Ada Lovelace", "agree": True, "country": "France"}))
        out = self.dir / "filled.pdf"
        r = run("pdf_fill.py", self.form, self.dir / "v.json", "-o", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        got = self.values(out)
        self.assertEqual(str(got["full_name"]), "Ada Lovelace")
        self.assertEqual(str(got["country"]), "France")
        self.assertNotEqual(str(got["agree"]), "/Off")
        self.assertTrue(PdfReader(str(out)).trailer["/Root"]["/AcroForm"].get("/NeedAppearances"))

    def test_unchecking_a_checkbox(self):
        (self.dir / "on.json").write_text(json.dumps({"agree": True}))
        (self.dir / "off.json").write_text(json.dumps({"agree": False}))
        on = self.dir / "on.pdf"
        off = self.dir / "off.pdf"
        run("pdf_fill.py", self.form, self.dir / "on.json", "-o", on)
        run("pdf_fill.py", on, self.dir / "off.json", "-o", off)
        self.assertEqual(str(self.values(off)["agree"]), "/Off")

    def test_unknown_field_writes_nothing_and_lists_known_names(self):
        (self.dir / "bad.json").write_text(json.dumps({"fullname": "typo"}))
        out = self.dir / "never.pdf"
        r = run("pdf_fill.py", self.form, self.dir / "bad.json", "-o", out)
        self.assertEqual(r.returncode, 2)
        self.assertIn("no such field", r.stderr)
        self.assertIn("full_name", r.stderr)
        self.assertFalse(out.exists())

    def test_flatten_removes_the_fields(self):
        (self.dir / "v.json").write_text(json.dumps({"full_name": "Ada Lovelace"}))
        out = self.dir / "flat.pdf"
        r = run("pdf_fill.py", self.form, self.dir / "v.json", "-o", out, "--flatten")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(run("pdf_fields.py", out, "--json").stdout or "[]"), [])
        self.assertIn("Ada Lovelace", PdfReader(str(out)).pages[0].extract_text(), "flattened value must stay visible on the page")
        self.assertNotIn("/AcroForm", PdfReader(str(out)).trailer["/Root"])

    def test_a_pdf_without_fields_points_to_overlay(self):
        flat = make_flat_pdf(self.dir / "flat-src.pdf")
        (self.dir / "v.json").write_text(json.dumps({"x": "y"}))
        r = run("pdf_fill.py", flat, self.dir / "v.json", "-o", self.dir / "o.pdf")
        self.assertEqual(r.returncode, 2)
        self.assertIn("pdf_overlay.py", r.stderr)
        self.assertEqual(run("pdf_fields.py", flat).returncode, 1)


@unittest.skipUnless(HAVE_LIBS, "pypdf and reportlab are required")
class Overlay(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.flat = make_flat_pdf(self.dir / "flat.pdf")

    def tearDown(self):
        self.tmp.cleanup()

    def test_text_lands_on_the_page_and_original_is_kept(self):
        marks = [{"page": 1, "x": 150, "y": 82, "text": "Lovelace", "size": 11}]
        (self.dir / "m.json").write_text(json.dumps(marks))
        out = self.dir / "o.pdf"
        r = run("pdf_overlay.py", self.flat, self.dir / "m.json", "-o", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        text = PdfReader(str(out)).pages[0].extract_text()
        self.assertIn("Surname", text)
        self.assertIn("Lovelace", text)

    def test_top_left_origin_puts_small_y_near_the_top(self):
        marks = [{"page": 1, "x": 100, "y": 20, "text": "TOPMARK"}, {"page": 1, "x": 100, "y": 800, "text": "LOWMARK"}]
        (self.dir / "m.json").write_text(json.dumps(marks))
        out = self.dir / "o.pdf"
        run("pdf_overlay.py", self.flat, self.dir / "m.json", "-o", out)
        positions = {}

        def visit(text, cm, tm, font, size):
            if text.strip() in ("TOPMARK", "LOWMARK"):
                positions[text.strip()] = tm[5]

        PdfReader(str(out)).pages[0].extract_text(visitor_text=visit)
        self.assertGreater(positions["TOPMARK"], positions["LOWMARK"], "TOPMARK should sit higher on the page")

    def test_bad_marks_are_rejected_before_writing(self):
        (self.dir / "m.json").write_text(json.dumps([{"page": 4, "x": 1, "y": 1, "text": "t"}]))
        out = self.dir / "o.pdf"
        r = run("pdf_overlay.py", self.flat, self.dir / "m.json", "-o", out)
        self.assertEqual(r.returncode, 2)
        self.assertFalse(out.exists())
        (self.dir / "m2.json").write_text(json.dumps([{"page": 1, "x": 1, "text": "t"}]))
        self.assertEqual(run("pdf_overlay.py", self.flat, self.dir / "m2.json", "-o", out).returncode, 2)

    def test_words_finds_a_label(self):
        out = run("pdf_words.py", self.flat, "--page", "1", "--grep", "surname", "--json")
        self.assertEqual(out.returncode, 0, out.stderr)
        data = json.loads(out.stdout)
        self.assertEqual(len(data["words"]), 1)
        word = data["words"][0]
        # drawn at baseline y=760 on a 841.9 pt page: about 80 pt from the top
        self.assertAlmostEqual(word["bottom"], 841.9 - 760, delta=14)
        self.assertAlmostEqual(word["x0"], 72, delta=4)


@unittest.skipUnless(HAVE_LIBS, "pypdf and reportlab are required")
class Render(unittest.TestCase):
    @unittest.skipUnless(shutil.which("pdftoppm") or HAVE_PDFIUM, "no renderer available")
    def test_renders_pages_to_png(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = make_text_pdf(Path(tmp) / "r.pdf", 2)
            r = run("pdf_render.py", pdf, "--outdir", Path(tmp) / "img", "--pages", "2", "--dpi", "50")
            self.assertEqual(r.returncode, 0, r.stderr)
            files = r.stdout.split()
            self.assertEqual(len(files), 1)
            self.assertTrue(files[0].endswith("page-002.png"))
            self.assertEqual(Path(files[0]).read_bytes()[:8], b"\x89PNG\r\n\x1a\n")


@unittest.skipUnless(HAVE_LIBS, "pypdf and reportlab are required")
class Recipes(unittest.TestCase):
    """Every python block in references/reference.md must run against the installed libraries."""

    def test_every_recipe_block_executes(self):
        import os
        import re
        text = (HERE.parent / "references" / "reference.md").read_text()
        blocks = re.findall(r"```python\n(.*?)```", text, re.S)
        self.assertGreaterEqual(len(blocks), 4)
        with tempfile.TemporaryDirectory() as tmp:
            cwd = os.getcwd()
            os.chdir(tmp)
            try:
                make_text_pdf(Path(tmp) / "in.pdf", 3)
                (Path(tmp) / "data.csv").write_text("a,b\n1,2\n")
                ns = {}
                for i, block in enumerate(blocks):
                    try:
                        exec(compile(block, f"reference-block-{i}", "exec"), ns)
                    except Exception as exc:  # noqa: BLE001
                        self.fail(f"reference block {i} failed: {type(exc).__name__}: {exc}\n{block[:200]}")
                self.assertEqual(len(PdfReader("stamped.pdf").pages), 3)
                self.assertIn("DRAFT", PdfReader("stamped.pdf").pages[0].extract_text())
                self.assertIn("Page 2 of 3", PdfReader("stamped.pdf").pages[1].extract_text())
                self.assertTrue(PdfReader("out.pdf").outline)
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
