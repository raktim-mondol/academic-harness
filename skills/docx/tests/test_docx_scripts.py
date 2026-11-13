"""Tests for the docx skill scripts. Run: python -m unittest discover -s skills/docx/tests

Needs python-docx and lxml. Skips cleanly when python-docx is absent.
"""
import copy
import json
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
    import docx
    from docx.shared import Pt
    HAVE_DOCX = True
except ImportError:  # pragma: no cover
    HAVE_DOCX = False

import docx_comments as C  # noqa: E402
import docx_runs as R  # noqa: E402
import docx_track as T  # noqa: E402
import ooxml_tools as O  # noqa: E402
from docx_runs import w  # noqa: E402


def run_script(name, *args):
    return subprocess.run([sys.executable, str(SCRIPTS / name), *map(str, args)], capture_output=True, text=True)


def make_doc(path):
    d = docx.Document()
    p = d.add_paragraph()
    a = p.add_run("The quick ")
    a.bold = True
    b = p.add_run("brown fox")
    b.italic = True
    p.add_run(" jumps over the lazy dog. The quick brown fox again.")
    tabbed = d.add_paragraph()
    tabbed.add_run("alpha")
    tabbed.add_run().add_tab()
    tabbed.add_run("beta")
    d.save(str(path))
    return path


def body_text(path):
    return [p.text for p in docx.Document(str(path)).paragraphs]


@unittest.skipUnless(HAVE_DOCX, "python-docx not installed")
class TrackedChanges(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.src = make_doc(self.dir / "src.docx")

    def tearDown(self):
        self.tmp.cleanup()

    def test_tracked_replace_across_runs_then_accept_and_reject(self):
        out = self.dir / "edited.docx"
        r = run_script("docx_track.py", "replace", self.src, "-o", out, "--find", "quick brown", "--replace", "slow red", "--first", "--author", "Tester")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(O.check_package(out)["ok"], O.check_package(out))

        changes = T.list_changes(R.parse(R.read_parts(out)["word/document.xml"]))
        kinds = sorted(c["type"] for c in changes)
        self.assertEqual(kinds, ["del", "ins"])
        self.assertEqual({c["author"] for c in changes}, {"Tester"})
        deleted = next(c for c in changes if c["type"] == "del")
        inserted = next(c for c in changes if c["type"] == "ins")
        self.assertEqual(deleted["text"], "quick brown")
        self.assertEqual(inserted["text"], "slow red")
        self.assertEqual(len({c["id"] for c in changes}), 2)

        accepted = self.dir / "accepted.docx"
        self.assertEqual(run_script("docx_track.py", "accept", out, "-o", accepted).returncode, 0)
        self.assertEqual(body_text(accepted)[0], "The slow red fox jumps over the lazy dog. The quick brown fox again.")
        self.assertTrue(O.check_package(accepted)["ok"])

        rejected = self.dir / "rejected.docx"
        self.assertEqual(run_script("docx_track.py", "reject", out, "-o", rejected).returncode, 0)
        self.assertEqual(body_text(rejected), body_text(self.src))

    def test_inserted_text_copies_first_run_formatting(self):
        out = self.dir / "fmt.docx"
        run_script("docx_track.py", "replace", self.src, "-o", out, "--find", "quick brown", "--replace", "slow red", "--first")
        accepted = self.dir / "fmt-accepted.docx"
        run_script("docx_track.py", "accept", out, "-o", accepted)
        runs = docx.Document(str(accepted)).paragraphs[0].runs
        inserted = next(r for r in runs if r.text == "slow red")
        self.assertTrue(inserted.bold, "inserted text should inherit the first matched run's bold")
        # neighbouring text keeps its own formatting
        self.assertTrue(next(r for r in runs if r.text == "The ").bold)
        self.assertTrue(next(r for r in runs if r.text == " fox").italic)

    def test_replace_all_and_ignore_case_and_untracked(self):
        out = self.dir / "all.docx"
        r = run_script("docx_track.py", "replace", self.src, "-o", out, "--find", "QUICK", "--replace", "fast", "--ignore-case", "--untracked")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("replaced 2 occurrence(s)", r.stdout)
        self.assertEqual(body_text(out)[0].count("fast"), 2)
        self.assertEqual(T.list_changes(R.parse(R.read_parts(out)["word/document.xml"])), [])

    def test_untracked_replacement_containing_the_search_text_terminates(self):
        out = self.dir / "grow.docx"
        r = run_script("docx_track.py", "replace", self.src, "-o", out, "--find", "fox", "--replace", "fox fox", "--untracked")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(body_text(out)[0].count("fox fox"), 2)

    def test_phrase_across_a_tab_is_not_matched(self):
        out = self.dir / "none.docx"
        r = run_script("docx_track.py", "replace", self.src, "-o", out, "--find", "alphabeta", "--replace", "x")
        self.assertEqual(r.returncode, 1)
        self.assertFalse(out.exists())

    def test_no_match_returns_nonzero(self):
        r = run_script("docx_track.py", "replace", self.src, "-o", self.dir / "x.docx", "--find", "absent phrase", "--replace", "y")
        self.assertEqual(r.returncode, 1)

    def test_author_filter_only_resolves_that_author(self):
        a = self.dir / "a.docx"
        b = self.dir / "b.docx"
        run_script("docx_track.py", "replace", self.src, "-o", a, "--find", "lazy", "--replace", "sleepy", "--author", "Ann")
        run_script("docx_track.py", "replace", a, "-o", b, "--find", "dog", "--replace", "cat", "--author", "Bob")
        only_ann = self.dir / "ann.docx"
        run_script("docx_track.py", "accept", b, "-o", only_ann, "--author", "Ann")
        left = T.list_changes(R.parse(R.read_parts(only_ann)["word/document.xml"]))
        self.assertEqual({c["author"] for c in left}, {"Bob"})
        self.assertIn("sleepy", body_text(only_ann)[0])

    def test_formatting_change_record_is_restored_on_reject(self):
        parts = R.read_parts(self.src)
        root = R.parse(parts["word/document.xml"])
        run = next(root.iter(w("r")))
        props = run.find(w("rPr"))
        change = R.etree.SubElement(props, w("rPrChange"))
        change.set(w("id"), "900")
        change.set(w("author"), "Fmt")
        change.set(w("date"), "2026-01-01T00:00:00Z")
        R.etree.SubElement(change, w("rPr"))  # the old properties: none (not bold)
        parts["word/document.xml"] = R.serialize(root)
        tracked = self.dir / "fmt-change.docx"
        R.write_parts(parts, tracked)

        listed = T.list_changes(R.parse(R.read_parts(tracked)["word/document.xml"]))
        self.assertEqual([c["type"] for c in listed], ["rPrChange"])

        rejected = self.dir / "fmt-rejected.docx"
        run_script("docx_track.py", "reject", tracked, "-o", rejected)
        self.assertFalse(docx.Document(str(rejected)).paragraphs[0].runs[0].bold)
        accepted = self.dir / "fmt-accepted2.docx"
        run_script("docx_track.py", "accept", tracked, "-o", accepted)
        self.assertTrue(docx.Document(str(accepted)).paragraphs[0].runs[0].bold)

    def test_inserted_table_row_is_removed_on_reject(self):
        d = docx.Document()
        table = d.add_table(rows=2, cols=1)
        table.rows[0].cells[0].text = "keep"
        table.rows[1].cells[0].text = "added"
        path = self.dir / "rows.docx"
        d.save(str(path))
        parts = R.read_parts(path)
        root = R.parse(parts["word/document.xml"])
        row = list(root.iter(w("tr")))[1]
        trpr = row.find(w("trPr"))
        if trpr is None:
            trpr = R.etree.Element(w("trPr"))
            row.insert(0, trpr)
        mark = R.etree.SubElement(trpr, w("ins"))
        mark.set(w("id"), "50")
        mark.set(w("author"), "Rowie")
        mark.set(w("date"), "2026-01-01T00:00:00Z")
        parts["word/document.xml"] = R.serialize(root)
        tracked = self.dir / "rows-tracked.docx"
        R.write_parts(parts, tracked)
        rejected = self.dir / "rows-rejected.docx"
        run_script("docx_track.py", "reject", tracked, "-o", rejected)
        self.assertEqual(len(docx.Document(str(rejected)).tables[0].rows), 1)
        accepted = self.dir / "rows-accepted.docx"
        run_script("docx_track.py", "accept", tracked, "-o", accepted)
        self.assertEqual(len(docx.Document(str(accepted)).tables[0].rows), 2)


@unittest.skipUnless(HAVE_DOCX, "python-docx not installed")
class Comments(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.src = make_doc(self.dir / "src.docx")

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_list_and_remove_a_comment_anchored_across_runs(self):
        out = self.dir / "commented.docx"
        r = run_script("docx_comments.py", "add", self.src, "-o", out, "--find", "quick brown", "--text", "Cite a source.", "--author", "Rev", "--initials", "RV")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(O.check_package(out)["ok"], O.check_package(out))

        listed = json.loads(run_script("docx_comments.py", "list", out, "--json").stdout)
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["text"], "Cite a source.")
        self.assertEqual(listed[0]["anchored_text"], "quick brown")
        self.assertEqual(listed[0]["author"], "Rev")

        self.assertEqual(body_text(out), body_text(self.src), "commenting must not change the text")
        cid = listed[0]["id"]
        cleared = self.dir / "cleared.docx"
        self.assertEqual(run_script("docx_comments.py", "remove", out, "-o", cleared, "--id", cid).returncode, 0)
        self.assertEqual(json.loads(run_script("docx_comments.py", "list", cleared, "--json").stdout), [])
        self.assertTrue(O.check_package(cleared)["ok"])

    def test_python_docx_reads_the_comment_we_wrote(self):
        out = self.dir / "readable.docx"
        run_script("docx_comments.py", "add", self.src, "-o", out, "--find", "lazy dog", "--text", "Why lazy?")
        comments = list(docx.Document(str(out)).comments)
        self.assertEqual([c.text for c in comments], ["Why lazy?"])

    def test_second_comment_gets_a_new_id_and_occurrence_selects_the_match(self):
        one = self.dir / "one.docx"
        two = self.dir / "two.docx"
        run_script("docx_comments.py", "add", self.src, "-o", one, "--find", "fox", "--text", "first")
        run_script("docx_comments.py", "add", one, "-o", two, "--find", "fox", "--text", "second fox", "--occurrence", "2")
        listed = json.loads(run_script("docx_comments.py", "list", two, "--json").stdout)
        self.assertEqual(len({c["id"] for c in listed}), 2)
        self.assertTrue(O.check_package(two)["ok"])

    def test_missing_phrase_is_an_error(self):
        r = run_script("docx_comments.py", "add", self.src, "-o", self.dir / "x.docx", "--find", "no such phrase", "--text", "t")
        self.assertEqual(r.returncode, 1)
        self.assertIn("not found", r.stderr)

    def test_comment_ids_do_not_collide_with_tracked_change_ids(self):
        tracked = self.dir / "tracked.docx"
        run_script("docx_track.py", "replace", self.src, "-o", tracked, "--find", "lazy", "--replace", "idle")
        both = self.dir / "both.docx"
        run_script("docx_comments.py", "add", tracked, "-o", both, "--find", "jumps", "--text", "note")
        report = O.check_package(both)
        self.assertTrue(report["ok"], report)
        ids = [c["id"] for c in T.list_changes(R.parse(R.read_parts(both)["word/document.xml"]))]
        comment_id = json.loads(run_script("docx_comments.py", "list", both, "--json").stdout)[0]["id"]
        self.assertNotIn(comment_id, ids)


@unittest.skipUnless(HAVE_DOCX, "python-docx not installed")
class PackageChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.src = make_doc(self.dir / "src.docx")

    def tearDown(self):
        self.tmp.cleanup()

    def rewrite(self, name, mutate):
        parts = R.read_parts(self.src)
        mutate(parts)
        out = self.dir / name
        R.write_parts(parts, out)
        return out

    def test_a_good_document_passes_and_reports_its_kind(self):
        report = O.check_package(self.src)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["kind"], "docx")

    def test_not_a_zip(self):
        bad = self.dir / "bad.docx"
        bad.write_bytes(b"this is not a zip")
        self.assertFalse(O.check_package(bad)["ok"])
        self.assertEqual(run_script("ooxml_tools.py", "check", bad).returncode, 1)

    def test_malformed_xml_is_reported_with_the_part_name(self):
        out = self.rewrite("malformed.docx", lambda p: p.update({"word/document.xml": b"<w:document><oops>"}))
        report = O.check_package(out)
        self.assertFalse(report["ok"])
        self.assertTrue(any("word/document.xml" in e for e in report["errors"]))

    def test_doctype_is_rejected(self):
        evil = b'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x "y">]><w:document xmlns:w="%s"/>' % R.NS_W.encode()
        out = self.rewrite("doctype.docx", lambda p: p.update({"word/document.xml": evil}))
        self.assertFalse(O.check_package(out)["ok"])

    def test_utf16_doctype_is_rejected_too(self):
        evil = ('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE d [<!ENTITY x "y">]><w:document xmlns:w="%s"/>' % R.NS_W).encode("utf-16")
        out = self.rewrite("doctype16.docx", lambda p: p.update({"word/document.xml": evil}))
        self.assertFalse(O.check_package(out)["ok"])

    def test_part_without_a_content_type(self):
        out = self.rewrite("untyped.docx", lambda p: p.update({"word/extra.zzz": b"data"}))
        report = O.check_package(out)
        self.assertTrue(any("no content type" in e for e in report["errors"]))

    def test_relationship_to_a_missing_part(self):
        def mutate(parts):
            rels = R.parse(parts["word/_rels/document.xml.rels"])
            extra = R.etree.SubElement(rels, f"{{{O.NS_REL}}}Relationship")
            extra.set("Id", "rId999")
            extra.set("Type", "http://example.test/rel")
            extra.set("Target", "media/missing.png")
            parts["word/_rels/document.xml.rels"] = R.serialize(rels)
        report = O.check_package(self.rewrite("dangling.docx", mutate))
        self.assertTrue(any("missing part" in e for e in report["errors"]))

    def test_external_relationships_are_not_followed(self):
        def mutate(parts):
            rels = R.parse(parts["word/_rels/document.xml.rels"])
            extra = R.etree.SubElement(rels, f"{{{O.NS_REL}}}Relationship")
            extra.set("Id", "rId998")
            extra.set("Type", "http://example.test/hyperlink")
            extra.set("Target", "https://example.org/")
            extra.set("TargetMode", "External")
            parts["word/_rels/document.xml.rels"] = R.serialize(rels)
        self.assertTrue(O.check_package(self.rewrite("external.docx", mutate))["ok"])

    def test_comment_reference_without_a_comment(self):
        commented = self.dir / "c.docx"
        run_script("docx_comments.py", "add", self.src, "-o", commented, "--find", "lazy", "--text", "x")
        parts = R.read_parts(commented)
        root = R.parse(parts["word/comments.xml"])
        for c in list(root):
            root.remove(c)
        parts["word/comments.xml"] = R.serialize(root)
        broken = self.dir / "broken.docx"
        R.write_parts(parts, broken)
        report = O.check_package(broken)
        self.assertTrue(any("no matching comment" in e for e in report["errors"]))

    def test_duplicate_tracked_change_ids(self):
        tracked = self.dir / "t.docx"
        run_script("docx_track.py", "replace", self.src, "-o", tracked, "--find", "lazy", "--replace", "idle")
        parts = R.read_parts(tracked)
        root = R.parse(parts["word/document.xml"])
        for el in list(root.iter(w("ins"))) + list(root.iter(w("del"))):
            el.set(w("id"), "7")
        parts["word/document.xml"] = R.serialize(root)
        out = self.dir / "dup.docx"
        R.write_parts(parts, out)
        self.assertTrue(any("duplicate tracked-change id" in e for e in O.check_package(out)["errors"]))

    def test_unreachable_part_is_only_a_warning(self):
        def mutate(parts):
            parts["word/orphan.xml"] = b"<x/>"
            ct = R.parse(parts["[Content_Types].xml"])
            o = R.etree.SubElement(ct, f"{{{O.NS_CT}}}Override")
            o.set("PartName", "/word/orphan.xml")
            o.set("ContentType", "application/xml")
            parts["[Content_Types].xml"] = R.serialize(ct)
        report = O.check_package(self.rewrite("orphan.docx", mutate))
        self.assertTrue(report["ok"], report)
        self.assertTrue(any("not reachable" in x for x in report["warnings"]))


@unittest.skipUnless(HAVE_DOCX, "python-docx not installed")
class UnpackPack(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.src = make_doc(self.dir / "src.docx")

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip_keeps_text_and_whitespace_only_runs(self):
        d = docx.Document()
        p = d.add_paragraph()
        p.add_run("a")
        p.add_run(" ")  # a whitespace-only run must survive indentation
        p.add_run("b")
        spaced = self.dir / "spaced.docx"
        d.save(str(spaced))
        work = self.dir / "work"
        O.unpack(spaced, work, pretty=True)
        out = self.dir / "back.docx"
        report = O.pack(work, out)
        self.assertTrue(report["ok"], report)
        self.assertEqual(docx.Document(str(out)).paragraphs[0].text, "a b")

    def test_cli_round_trip(self):
        work = self.dir / "w"
        self.assertEqual(run_script("ooxml_tools.py", "unpack", self.src, work, "--pretty").returncode, 0)
        out = self.dir / "o.docx"
        self.assertEqual(run_script("ooxml_tools.py", "pack", work, out).returncode, 0)
        self.assertEqual(body_text(out), body_text(self.src))
        with zipfile.ZipFile(out) as zf:
            self.assertEqual(zf.namelist()[0], "[Content_Types].xml")

    def test_pack_refuses_a_directory_that_is_not_a_package(self):
        (self.dir / "empty").mkdir()
        r = run_script("ooxml_tools.py", "pack", self.dir / "empty", self.dir / "x.docx")
        self.assertEqual(r.returncode, 2)

    def test_pack_does_not_leave_a_broken_output_behind(self):
        work = self.dir / "w2"
        O.unpack(self.src, work)
        (work / "word" / "document.xml").write_bytes(b"<broken")
        out = self.dir / "broken-out.docx"
        report = O.pack(work, out)
        self.assertFalse(report["ok"])
        self.assertFalse(out.exists())
        self.assertEqual([p.name for p in self.dir.glob("*.tmp")], [])

    def test_unpack_refuses_path_traversal(self):
        evil = self.dir / "evil.docx"
        with zipfile.ZipFile(evil, "w") as zf:
            zf.writestr("../escaped.txt", "x")
        with self.assertRaises(O.PackageError):
            O.unpack(evil, self.dir / "out")
        self.assertFalse((self.dir / "escaped.txt").exists())


@unittest.skipUnless(HAVE_DOCX, "python-docx not installed")
class Recipes(unittest.TestCase):
    """Every python block in the recipes reference must run against the installed python-docx."""

    def test_every_recipe_block_executes(self):
        import os
        import re
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("Pillow not installed (the picture recipe needs an image)")
        text = (HERE.parent / "references" / "python-docx-recipes.md").read_text()
        blocks = re.findall(r"```python\n(.*?)```", text, re.S)
        self.assertGreaterEqual(len(blocks), 8)
        with tempfile.TemporaryDirectory() as tmp:
            cwd = os.getcwd()
            os.chdir(tmp)
            try:
                Image.new("RGB", (40, 20), "red").save("figure1.png")
                ns = {}
                for i, block in enumerate(blocks):
                    if 'Document("input.docx")' in block:
                        ns["doc"].save("input.docx")
                    try:
                        exec(compile(block, f"recipe-block-{i}", "exec"), ns)
                    except Exception as exc:  # noqa: BLE001
                        self.fail(f"recipe block {i} failed: {type(exc).__name__}: {exc}\n{block[:200]}")
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
