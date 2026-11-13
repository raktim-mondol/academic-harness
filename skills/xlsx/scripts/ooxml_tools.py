#!/usr/bin/env python3
"""Unpack, repack and sanity-check Office Open XML packages (.docx, .xlsx, .pptx).

    ooxml_tools.py unpack  report.docx  work/            # extract, optionally --pretty
    ooxml_tools.py pack    work/  report-edited.docx     # zip back up, then check
    ooxml_tools.py check   report-edited.docx [--json]   # structural checks only

An Office file is a zip of XML parts joined by relationships. Editing the XML
by hand is sometimes the only way to reach a feature (comments, tracked
changes, theme details), and the usual failure is a package Word or PowerPoint
refuses to open. `check` catches the structural causes before you hand the
file over: broken zip, malformed XML, DOCTYPE/entity declarations, parts with
no content type, relationships that point nowhere, comment references with no
comment, duplicate tracked-change ids.

It does not validate against the ECMA/ISO schemas and it cannot promise Word
will accept every file. For that, open the result in LibreOffice or Office.
This file is identical in the docx, pptx and xlsx skills; edit all three.

Requires lxml.
"""
from __future__ import annotations

import argparse
import json
import posixpath
import sys
import tempfile
import zipfile
from pathlib import Path

try:
    from lxml import etree
except ImportError:  # pragma: no cover - environment dependent
    sys.exit("ooxml_tools.py needs lxml (pip install lxml)")

CONTENT_TYPES = "[Content_Types].xml"
ROOT_RELS = "_rels/.rels"
MAX_PARTS = 20_000
MAX_UNPACKED_BYTES = 1_000_000_000

NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


class PackageError(Exception):
    pass


# --------------------------------------------------------------------------- xml


def parse_xml(data: bytes):
    """Parse one XML part without resolving entities or touching the network."""
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False)
    root = etree.fromstring(data, parser)
    tree = root.getroottree()
    if tree.docinfo.doctype or tree.docinfo.internalDTD is not None:
        raise PackageError("DOCTYPE/entity declarations are not allowed in Office parts")
    return root


def is_xml_part(name: str) -> bool:
    return name.endswith(".xml") or name.endswith(".rels") or name.endswith(".vml")


# ------------------------------------------------------------------------ package


class Package:
    """Read-only view over a zip file or an unpacked directory."""

    def __init__(self, path: Path):
        self.path = path
        self.names: list[str] = []
        self._zip: zipfile.ZipFile | None = None
        if path.is_dir():
            self.names = sorted(
                p.relative_to(path).as_posix() for p in path.rglob("*") if p.is_file()
            )
        else:
            self._zip = zipfile.ZipFile(path)
            self.names = [i.filename for i in self._zip.infolist() if not i.is_dir()]

    def read(self, name: str) -> bytes:
        if self._zip is not None:
            return self._zip.read(name)
        return (self.path / name).read_bytes()

    def close(self):
        if self._zip is not None:
            self._zip.close()


def _resolve(source_part: str, target: str) -> str:
    """Resolve a relationship Target against the part that owns the .rels file."""
    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    base = posixpath.dirname(source_part)
    return posixpath.normpath(posixpath.join(base, target))


def _owner_of_rels(rels_name: str) -> str:
    """word/_rels/document.xml.rels -> word/document.xml; _rels/.rels -> ''."""
    folder, _, leaf = rels_name.rpartition("/")
    parent = folder[: -len("_rels")].rstrip("/") if folder.endswith("_rels") else folder
    owner_leaf = leaf[: -len(".rels")]
    if rels_name == ROOT_RELS:
        return ""
    return posixpath.join(parent, owner_leaf) if parent else owner_leaf


def check_package(path: str | Path) -> dict:
    """Return {'ok', 'kind', 'errors', 'warnings'} for a file or unpacked directory."""
    path = Path(path)
    errors: list[str] = []
    warnings: list[str] = []
    kind = "unknown"

    try:
        pkg = Package(path)
    except zipfile.BadZipFile:
        return {"ok": False, "kind": kind, "errors": ["not a valid zip file"], "warnings": []}
    except (OSError, ValueError) as exc:
        return {"ok": False, "kind": kind, "errors": [f"cannot open: {exc}"], "warnings": []}

    try:
        names = pkg.names
        if pkg._zip is not None:
            bad = pkg._zip.testzip()
            if bad:
                errors.append(f"corrupt zip member: {bad}")
            if len(set(names)) != len(names):
                errors.append("duplicate zip member names")
        if len(names) > MAX_PARTS:
            errors.append(f"too many parts ({len(names)})")
            return {"ok": False, "kind": kind, "errors": errors, "warnings": warnings}

        for required in (CONTENT_TYPES, ROOT_RELS):
            if required not in names:
                errors.append(f"missing {required}")
        if errors and CONTENT_TYPES not in names:
            return {"ok": False, "kind": kind, "errors": errors, "warnings": warnings}

        roots: dict[str, "etree._Element"] = {}
        for name in names:
            if not is_xml_part(name):
                continue
            try:
                roots[name] = parse_xml(pkg.read(name))
            except (etree.XMLSyntaxError, PackageError) as exc:
                errors.append(f"{name}: {exc}")

        # content types ------------------------------------------------------
        defaults: set[str] = set()
        overrides: dict[str, str] = {}
        ct_root = roots.get(CONTENT_TYPES)
        if ct_root is not None:
            for el in ct_root:
                tag = etree.QName(el).localname
                if tag == "Default":
                    defaults.add((el.get("Extension") or "").lower())
                elif tag == "Override":
                    overrides[(el.get("PartName") or "").lstrip("/")] = el.get("ContentType") or ""
            for part in overrides:
                if part not in names:
                    warnings.append(f"content-type override for missing part: {part}")
            for name in names:
                if name == CONTENT_TYPES:
                    continue
                ext = name.rsplit(".", 1)[-1].lower() if "." in name.rsplit("/", 1)[-1] else ""
                if name not in overrides and ext not in defaults:
                    errors.append(f"no content type for part: {name}")

        # relationships -----------------------------------------------------
        graph: dict[str, set[str]] = {}
        main_part = None
        for name, root in roots.items():
            if not name.endswith(".rels"):
                continue
            owner = _owner_of_rels(name)
            ids: set[str] = set()
            for rel in root:
                if etree.QName(rel).localname != "Relationship":
                    continue
                rid = rel.get("Id")
                if rid in ids:
                    errors.append(f"{name}: duplicate relationship id {rid}")
                ids.add(rid)
                if rel.get("TargetMode") == "External":
                    continue
                target = rel.get("Target") or ""
                resolved = _resolve(owner, target)
                if resolved not in names:
                    errors.append(f"{name}: relationship {rid} points to missing part {resolved}")
                else:
                    graph.setdefault(owner, set()).add(resolved)
                if name == ROOT_RELS and (rel.get("Type") or "").endswith("/officeDocument"):
                    main_part = resolved

        if main_part is None:
            errors.append("no officeDocument relationship in _rels/.rels")
        else:
            if main_part.startswith("word/"):
                kind = "docx"
            elif main_part.startswith("xl/"):
                kind = "xlsx"
            elif main_part.startswith("ppt/"):
                kind = "pptx"

            reachable: set[str] = set()
            stack = [""]
            while stack:
                node = stack.pop()
                for nxt in graph.get(node, ()):
                    if nxt not in reachable:
                        reachable.add(nxt)
                        stack.append(nxt)
            for name in names:
                if name in (CONTENT_TYPES, ROOT_RELS) or name.endswith(".rels"):
                    continue
                if name not in reachable:
                    warnings.append(f"part not reachable from the root relationships: {name}")

        if kind == "docx":
            _check_docx(roots, names, errors)
        elif kind == "pptx":
            _check_pptx(roots, main_part, errors)
        elif kind == "xlsx":
            _check_xlsx(roots, main_part, errors)
    finally:
        pkg.close()

    return {"ok": not errors, "kind": kind, "errors": errors, "warnings": warnings}


def _w(tag: str) -> str:
    return f"{{{NS_W}}}{tag}"


def _check_docx(roots, names, errors):
    doc = roots.get("word/document.xml")
    if doc is None:
        errors.append("word/document.xml missing or unreadable")
        return
    comment_ids: set[str] = set()
    comments = roots.get("word/comments.xml")
    if comments is not None:
        comment_ids = {c.get(_w("id")) for c in comments.iter(_w("comment"))}
    for tag in ("commentReference", "commentRangeStart", "commentRangeEnd"):
        for el in doc.iter(_w(tag)):
            cid = el.get(_w("id"))
            if cid not in comment_ids:
                errors.append(f"word/document.xml: {tag} id {cid} has no matching comment")
    seen: set[str] = set()
    for tag in ("ins", "del"):
        for el in doc.iter(_w(tag)):
            rid = el.get(_w("id"))
            if rid is None:
                continue
            if rid in seen:
                errors.append(f"word/document.xml: duplicate tracked-change id {rid}")
            seen.add(rid)


def _rel_ids(roots, part):
    owner_dir, _, leaf = part.rpartition("/")
    rels = roots.get(posixpath.join(owner_dir, "_rels", leaf + ".rels"))
    if rels is None:
        return None
    return {r.get("Id") for r in rels}


def _check_pptx(roots, main_part, errors):
    pres = roots.get(main_part)
    ids = _rel_ids(roots, main_part)
    if pres is None or ids is None:
        return
    for sld in pres.iter(f"{{{NS_P}}}sldId"):
        rid = sld.get(f"{{{NS_R}}}id")
        if rid not in ids:
            errors.append(f"{main_part}: slide references unknown relationship {rid}")


def _check_xlsx(roots, main_part, errors):
    wb = roots.get(main_part)
    ids = _rel_ids(roots, main_part)
    if wb is None or ids is None:
        return
    for sheet in wb.iter(f"{{{NS_S}}}sheet"):
        rid = sheet.get(f"{{{NS_R}}}id")
        if rid not in ids:
            errors.append(f"{main_part}: sheet {sheet.get('name')!r} references unknown relationship {rid}")


# -------------------------------------------------------------- unpack and pack


def unpack(src: str | Path, dest: str | Path, pretty: bool = False) -> list[str]:
    """Extract a package, refusing path traversal and absurd sizes."""
    src, dest = Path(src), Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    written: list[str] = []
    with zipfile.ZipFile(src) as zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > MAX_PARTS:
            raise PackageError(f"too many parts ({len(infos)})")
        if sum(i.file_size for i in infos) > MAX_UNPACKED_BYTES:
            raise PackageError("unpacked size is implausibly large")
        for info in infos:
            name = info.filename.replace("\\", "/")
            target = (root / name).resolve()
            if name.startswith("/") or not str(target).startswith(str(root) + "/"):
                raise PackageError(f"unsafe path in archive: {info.filename}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(info))
            written.append(name)
    if pretty:
        for name in written:
            if is_xml_part(name):
                _indent_in_place(root / name)
    return written


def _indent_in_place(path: Path) -> None:
    """Indent between elements only. Text nodes (including space-only runs) are untouched."""
    try:
        tree = etree.parse(str(path), etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False))
    except etree.XMLSyntaxError:
        return
    etree.indent(tree, space="  ")
    tree.write(str(path), xml_declaration=True, encoding="UTF-8", standalone=True)


def pack(src_dir: str | Path, out_file: str | Path, check: bool = True) -> dict:
    """Zip a directory back into an Office file, [Content_Types].xml first."""
    src_dir, out_file = Path(src_dir), Path(out_file)
    if not (src_dir / CONTENT_TYPES).exists():
        raise PackageError(f"{src_dir} has no {CONTENT_TYPES}; is it an unpacked Office file?")
    files = sorted(p.relative_to(src_dir).as_posix() for p in src_dir.rglob("*") if p.is_file())
    first = [n for n in (CONTENT_TYPES, ROOT_RELS) if n in files]
    ordered = first + [n for n in files if n not in first]
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=out_file.parent, suffix=".tmp", delete=False) as handle:
        tmp = Path(handle.name)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in ordered:
                zf.write(src_dir / name, name)
        report = check_package(tmp) if check else {"ok": True, "errors": [], "warnings": [], "kind": "unchecked"}
        if report["ok"]:
            tmp.replace(out_file)
        else:
            tmp.unlink(missing_ok=True)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    report["output"] = str(out_file) if report["ok"] else None
    return report


# ---------------------------------------------------------------------------- cli


def _print_report(report: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report, indent=2))
        return
    print(f"kind: {report['kind']}")
    for msg in report["errors"]:
        print(f"ERROR   {msg}")
    for msg in report["warnings"]:
        print(f"warning {msg}")
    print("ok" if report["ok"] else "FAILED")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_unpack = sub.add_parser("unpack", help="extract a package into a directory")
    p_unpack.add_argument("source")
    p_unpack.add_argument("dest")
    p_unpack.add_argument("--pretty", action="store_true", help="indent XML between elements for easier reading")
    p_pack = sub.add_parser("pack", help="zip a directory into an Office file and check it")
    p_pack.add_argument("source_dir")
    p_pack.add_argument("output")
    p_pack.add_argument("--no-check", action="store_true")
    p_check = sub.add_parser("check", help="structural checks on a file or unpacked directory")
    p_check.add_argument("path")
    p_check.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        if args.cmd == "unpack":
            names = unpack(args.source, args.dest, pretty=args.pretty)
            print(f"unpacked {len(names)} parts into {args.dest}")
            return 0
        if args.cmd == "pack":
            report = pack(args.source_dir, args.output, check=not args.no_check)
            _print_report(report, False)
            return 0 if report["ok"] else 1
        report = check_package(args.path)
        _print_report(report, args.json)
        return 0 if report["ok"] else 1
    except (PackageError, zipfile.BadZipFile, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
