#!/usr/bin/env python3
"""List, add and remove comments in a .docx.

    docx_comments.py list   paper.docx [--json]
    docx_comments.py add    paper.docx -o reviewed.docx --find "exact phrase" \
                            --text "Please cite a source." [--author NAME] \
                            [--initials AB] [--occurrence 1]
    docx_comments.py remove paper.docx -o clean.docx --id 3

`add` anchors the comment to the phrase: it splits runs at the edges of the
match, wraps the matched runs in comment-range markers, and adds the reference
run Word expects. If the file has no comments part yet, the part, its
relationship and its content type are created. Matching rules are in
docx_runs.py (a phrase that crosses a tab, field or hyperlink edge is not
matched).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docx_runs as R  # noqa: E402
from docx_runs import w  # noqa: E402

DOC = "word/document.xml"
COMMENTS = "word/comments.xml"
DOC_RELS = "word/_rels/document.xml.rels"
CONTENT_TYPES = "[Content_Types].xml"
REL_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
CT_COMMENTS = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"
NS_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"


def _new_comments_root():
    return etree.Element(w("comments"), nsmap={"w": R.NS_W})


def ensure_comments_part(parts: dict[str, bytes]):
    """Return the comments root, creating the part, relationship and content type if absent."""
    if COMMENTS in parts:
        return R.parse(parts[COMMENTS])
    root = _new_comments_root()
    rels = R.parse(parts[DOC_RELS])
    used = {r.get("Id") for r in rels}
    n = 1
    while f"rId{n}" in used:
        n += 1
    rel = etree.SubElement(rels, f"{{{NS_REL}}}Relationship")
    rel.set("Id", f"rId{n}")
    rel.set("Type", REL_COMMENTS)
    rel.set("Target", "comments.xml")
    parts[DOC_RELS] = R.serialize(rels)
    ct = R.parse(parts[CONTENT_TYPES])
    override = etree.SubElement(ct, f"{{{NS_CT}}}Override")
    override.set("PartName", "/word/comments.xml")
    override.set("ContentType", CT_COMMENTS)
    parts[CONTENT_TYPES] = R.serialize(ct)
    return root


def list_comments(doc_root, comments_root) -> list[dict]:
    if comments_root is None:
        return []
    anchors: dict[str, str] = {}
    for start in doc_root.iter(w("commentRangeStart")):
        cid = start.get(w("id"))
        pieces, node = [], start.getnext()
        while node is not None and not (node.tag == w("commentRangeEnd") and node.get(w("id")) == cid):
            pieces.append("".join(t.text or "" for t in node.iter(w("t"))))
            node = node.getnext()
        anchors[cid] = "".join(pieces)
    out = []
    for c in comments_root.iter(w("comment")):
        cid = c.get(w("id"))
        out.append({
            "id": cid,
            "author": c.get(w("author")),
            "initials": c.get(w("initials")),
            "date": c.get(w("date")),
            "text": "\n".join("".join(t.text or "" for t in p.iter(w("t"))) for p in c.iter(w("p"))),
            "anchored_text": anchors.get(cid, ""),
        })
    return out


def add_comment(parts, doc_root, find: str, text: str, author: str, initials: str, occurrence: int = 1) -> str:
    comments_root = ensure_comments_part(parts)
    seen = 0
    target = None
    for paragraph in doc_root.iter(w("p")):
        for container in R.containers(paragraph):
            for start, end in R.find_all(container, find):
                seen += 1
                if seen == occurrence:
                    runs = R.isolate(container, start, end)
                    if runs is None:
                        raise ValueError("that phrase touches a tab, field or drawing and cannot be anchored")
                    target = runs
                    break
            if target:
                break
        if target:
            break
    if not target:
        raise ValueError(f"phrase not found (occurrence {occurrence}): {find!r}")

    cid = str(R.next_annotation_id(doc_root, comments_root))
    comment = etree.SubElement(comments_root, w("comment"))
    comment.set(w("id"), cid)
    comment.set(w("author"), author)
    comment.set(w("date"), R.now_iso())
    comment.set(w("initials"), initials)
    para = etree.SubElement(comment, w("p"))
    ref_run = etree.SubElement(para, w("r"))
    etree.SubElement(ref_run, w("annotationRef"))
    body_run = etree.SubElement(para, w("r"))
    body = etree.SubElement(body_run, w("t"))
    body.text = text
    body.set(f"{{{R.NS_XML}}}space", "preserve")

    first, last = target[0], target[-1]
    start_marker = etree.Element(w("commentRangeStart"))
    start_marker.set(w("id"), cid)
    end_marker = etree.Element(w("commentRangeEnd"))
    end_marker.set(w("id"), cid)
    first.addprevious(start_marker)
    last.addnext(end_marker)
    reference = etree.Element(w("r"))
    etree.SubElement(reference, w("commentReference")).set(w("id"), cid)
    end_marker.addnext(reference)

    parts[COMMENTS] = R.serialize(comments_root)
    return cid


def remove_comment(parts, doc_root, comment_id: str) -> bool:
    if COMMENTS not in parts:
        return False
    comments_root = R.parse(parts[COMMENTS])
    found = [c for c in comments_root.iter(w("comment")) if c.get(w("id")) == comment_id]
    if not found:
        return False
    for c in found:
        comments_root.remove(c)
    for tag in ("commentRangeStart", "commentRangeEnd"):
        for el in list(doc_root.iter(w(tag))):
            if el.get(w("id")) == comment_id:
                el.getparent().remove(el)
    for ref in list(doc_root.iter(w("commentReference"))):
        if ref.get(w("id")) == comment_id:
            run = ref.getparent()
            run.getparent().remove(run)
    parts[COMMENTS] = R.serialize(comments_root)
    return True


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list")
    p.add_argument("docx")
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("add")
    p.add_argument("docx")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--find", required=True)
    p.add_argument("--text", required=True)
    p.add_argument("--author", default="Claude")
    p.add_argument("--initials", default="C")
    p.add_argument("--occurrence", type=int, default=1)
    p = sub.add_parser("remove")
    p.add_argument("docx")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--id", required=True)
    args = ap.parse_args(argv)

    parts = R.read_parts(args.docx)
    if DOC not in parts:
        print(f"error: {args.docx} has no {DOC}", file=sys.stderr)
        return 2
    doc_root = R.parse(parts[DOC])

    if args.cmd == "list":
        comments_root = R.parse(parts[COMMENTS]) if COMMENTS in parts else None
        items = list_comments(doc_root, comments_root)
        if args.json:
            print(json.dumps(items, indent=2))
        else:
            for c in items:
                print(f"#{c['id']} {c['author']} {c['date'] or ''}\n  on: {c['anchored_text']!r}\n  {c['text']}")
            print(f"{len(items)} comment(s)")
        return 0

    try:
        if args.cmd == "add":
            cid = add_comment(parts, doc_root, args.find, args.text, args.author, args.initials, args.occurrence)
            parts[DOC] = R.serialize(doc_root)
            R.write_parts(parts, args.output)
            print(f"added comment #{cid} -> {args.output}")
            return 0
        if not remove_comment(parts, doc_root, args.id):
            print(f"error: no comment with id {args.id}", file=sys.stderr)
            return 1
        parts[DOC] = R.serialize(doc_root)
        R.write_parts(parts, args.output)
        print(f"removed comment #{args.id} -> {args.output}")
        return 0
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
