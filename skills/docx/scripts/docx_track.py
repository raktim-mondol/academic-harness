#!/usr/bin/env python3
"""List, accept, reject and create tracked changes in a .docx.

    docx_track.py list    paper.docx [--json]
    docx_track.py accept  paper.docx -o clean.docx    [--author NAME]
    docx_track.py reject  paper.docx -o original.docx [--author NAME]
    docx_track.py replace paper.docx -o edited.docx --find OLD --replace NEW \
                          [--author NAME] [--untracked] [--first] [--ignore-case]

`replace` records the edit as a tracked deletion plus insertion, so the author
sees exactly what changed and can accept or reject it in Word. Formatting of
the surrounding text is kept: runs are split at the edges of the match and the
inserted text copies the formatting of the first matched run. `--untracked`
rewrites the text in place instead.

Handled in the document body: insertions, deletions, moves, inserted or deleted
table rows, and formatting-change records (run, paragraph, table, row, cell,
section, grid). Not handled: headers, footers and footnotes, and a deleted
paragraph mark that would merge two non-empty paragraphs (reported as skipped
and left as an ordinary paragraph break). Matching rules are in docx_runs.py.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docx_runs as R  # noqa: E402
from docx_runs import w  # noqa: E402

DOC = "word/document.xml"
FORMAT_RECORDS = ("rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "trPrChange", "tcPrChange", "tblGridChange")
PROPERTY_CONTAINERS = ("rPr", "pPr", "tblPr", "trPr", "tcPr", "sectPr", "tblGrid")
# Children of a properties element that its change record does not store.
KEEP_ON_RESTORE = {
    "pPr": ("rPr", "sectPr"),
    "sectPr": ("headerReference", "footerReference"),
}


def _text_of(el) -> str:
    return "".join((t.text or "") for t in el.iter() if t.tag in (w("t"), w("delText")))


def list_changes(root) -> list[dict]:
    out = []
    for kind in ("ins", "del", "moveFrom", "moveTo", *FORMAT_RECORDS):
        for el in root.iter(w(kind)):
            parent = el.getparent()
            marker = parent is not None and parent.tag in (w("rPr"), w("trPr"))
            out.append({
                "id": el.get(w("id")),
                "type": kind,
                "author": el.get(w("author")),
                "date": el.get(w("date")),
                "text": _text_of(el),
                "paragraph_mark": bool(marker),
            })
    return out


def _wanted(el, author) -> bool:
    return author is None or el.get(w("author")) == author


def _unwrap(el) -> None:
    parent = el.getparent()
    index = parent.index(el)
    for child in list(el):
        parent.insert(index, child)
        index += 1
    parent.remove(el)


def _retag(el, old: str, new: str) -> None:
    for node in el.iter(w(old)):
        node.tag = w(new)


def _restore(record) -> None:
    """Reject a formatting change: put the stored properties back on the owner."""
    owner = record.getparent()
    if owner is None:
        return
    owner_name = etree.QName(owner).localname
    keep = {w(n) for n in KEEP_ON_RESTORE.get(owner_name, ())}
    for child in list(owner):
        if child is not record and child.tag not in keep:
            owner.remove(child)
    for stored in [c for c in record if isinstance(c.tag, str)]:
        if etree.QName(stored).localname in PROPERTY_CONTAINERS:
            for inner in list(stored):
                owner.append(inner)
        else:
            owner.append(stored)
    owner.remove(record)


def resolve(root, accept: bool, author: str | None = None) -> dict:
    """Accept or reject tracked changes in place. Returns counts and notes."""
    resolved = 0
    skipped = 0
    notes: list[str] = []

    for kind in ("ins", "del", "moveFrom", "moveTo"):
        for el in list(root.iter(w(kind))):
            if not _wanted(el, author):
                continue
            keeps = (kind in ("ins", "moveTo")) == accept
            parent = el.getparent()
            if parent is not None and parent.tag in (w("rPr"), w("trPr")):
                # a revision marker on a paragraph mark or a table row
                if keeps:
                    parent.remove(el)
                    resolved += 1
                    continue
                container = parent.getparent()
                if parent.tag == w("trPr") and container is not None and container.tag == w("tr"):
                    container.getparent().remove(container)
                    resolved += 1
                    continue
                paragraph = container.getparent() if container is not None else None
                if paragraph is not None and paragraph.tag == w("p") and all(c.tag == w("pPr") for c in paragraph):
                    paragraph.getparent().remove(paragraph)
                    resolved += 1
                else:
                    parent.remove(el)
                    skipped += 1
                    notes.append(f"paragraph-mark change {el.get(w('id'))} left as an ordinary paragraph break")
                continue
            if keeps:
                if kind in ("del", "moveFrom"):
                    _retag(el, "delText", "t")
                _unwrap(el)
            else:
                parent.remove(el)
            resolved += 1

    for kind in FORMAT_RECORDS:
        for el in list(root.iter(w(kind))):
            if not _wanted(el, author):
                continue
            if accept:
                el.getparent().remove(el)
            else:
                _restore(el)
            resolved += 1
    return {"resolved": resolved, "skipped": skipped, "notes": notes}


def replace_text(root, find: str, replacement: str, author: str, tracked: bool = True,
                 first_only: bool = False, case_sensitive: bool = True) -> int:
    if not find:
        raise ValueError("--find must not be empty")
    next_id = R.next_annotation_id(root)
    stamp = R.now_iso()
    done = 0
    for paragraph in list(root.iter(w("p"))):
        for container in list(R.containers(paragraph)):
            begin = 0
            while True:
                matches = R.find_all(container, find, case_sensitive, begin)
                if not matches:
                    break
                start, end = matches[0]
                runs = R.isolate(container, start, end)
                if runs is None:
                    begin = end  # the match touches an opaque run; skip past it
                    continue
                if tracked:
                    deletion = etree.Element(w("del"))
                    deletion.set(w("id"), str(next_id))
                    deletion.set(w("author"), author)
                    deletion.set(w("date"), stamp)
                    next_id += 1
                    runs[0].addprevious(deletion)
                    for run in runs:
                        deletion.append(run)
                    _retag(deletion, "t", "delText")
                    if replacement:
                        insertion = etree.Element(w("ins"))
                        insertion.set(w("id"), str(next_id))
                        insertion.set(w("author"), author)
                        insertion.set(w("date"), stamp)
                        next_id += 1
                        new_run = etree.SubElement(insertion, w("r"))
                        props = runs[0].find(w("rPr"))
                        if props is not None:
                            new_run.append(copy.deepcopy(props))
                        text = etree.SubElement(new_run, w("t"))
                        text.text = replacement
                        text.set(f"{{{R.NS_XML}}}space", "preserve")
                        deletion.addnext(insertion)
                    begin = start  # matched text left the direct-run text
                else:
                    t = runs[0].find(w("t"))
                    t.text = replacement
                    t.set(f"{{{R.NS_XML}}}space", "preserve")
                    for extra in runs[1:]:
                        extra.getparent().remove(extra)
                    begin = start + len(replacement)
                done += 1
                if first_only:
                    return done
    return done


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list")
    p.add_argument("docx")
    p.add_argument("--json", action="store_true")
    for name in ("accept", "reject"):
        p = sub.add_parser(name)
        p.add_argument("docx")
        p.add_argument("-o", "--output", required=True)
        p.add_argument("--author")
    p = sub.add_parser("replace")
    p.add_argument("docx")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--find", required=True)
    p.add_argument("--replace", dest="replacement", required=True)
    p.add_argument("--author", default="Claude")
    p.add_argument("--untracked", action="store_true")
    p.add_argument("--first", action="store_true", help="only the first match")
    p.add_argument("--ignore-case", action="store_true")
    args = ap.parse_args(argv)

    parts = R.read_parts(args.docx)
    if DOC not in parts:
        print(f"error: {args.docx} has no {DOC}", file=sys.stderr)
        return 2
    root = R.parse(parts[DOC])

    if args.cmd == "list":
        changes = list_changes(root)
        if args.json:
            print(json.dumps(changes, indent=2))
        else:
            for c in changes:
                mark = " (mark)" if c["paragraph_mark"] else ""
                print(f"{str(c['id']):>4} {c['type']:<12} {c['author'] or '-':<16} {c['date'] or '-':<21}{mark} {c['text'][:70]!r}")
            print(f"{len(changes)} tracked change(s)")
        return 0

    if args.cmd in ("accept", "reject"):
        result = resolve(root, accept=args.cmd == "accept", author=args.author)
        parts[DOC] = R.serialize(root)
        R.write_parts(parts, args.output)
        for note in result["notes"]:
            print(f"note: {note}")
        print(f"{args.cmd}ed {result['resolved']} change(s), skipped {result['skipped']} -> {args.output}")
        return 0

    count = replace_text(root, args.find, args.replacement, args.author,
                         tracked=not args.untracked, first_only=args.first,
                         case_sensitive=not args.ignore_case)
    if count == 0:
        print("no matches (text split across a field, tab, hyperlink edge or existing tracked change is not matched)", file=sys.stderr)
        return 1
    parts[DOC] = R.serialize(root)
    R.write_parts(parts, args.output)
    print(f"replaced {count} occurrence(s) -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
