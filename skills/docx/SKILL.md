---
name: docx
description: Create, read, edit and review Word (.docx) files. Use for drafting a report or manuscript as .docx, converting Markdown or LaTeX to Word, extracting text and tables, find-and-replace that keeps formatting, tracked changes (create, list, accept, reject), and comments. Not for PDFs, spreadsheets or slides, and not for Google Docs.
license: MIT
metadata:
  version: "2.0"
  skill-author: Academic Harness
  skill-source: original; drives python-docx, lxml and pandoc, none of which are bundled
---

# Word documents (.docx)

A .docx is a zip of XML parts. Most jobs never need to look inside: python-docx
or pandoc does them. The scripts in this skill cover what those cannot do well:
tracked changes, comments, and checking that a hand-edited package is sound.

Paths below are relative to this skill's directory. Run scripts with the Python
that has the libraries installed.

## Pick the route

| You want to | Use |
|---|---|
| Turn Markdown, HTML or LaTeX into Word | `pandoc in.md -o out.docx` (add `--reference-doc=template.docx` to borrow styles) |
| Build a document from data or code | python-docx, see [references/python-docx-recipes.md](references/python-docx-recipes.md) |
| Read text and tables | python-docx, or `pandoc in.docx -t markdown` for a quick look |
| Change wording but keep formatting | `scripts/docx_track.py replace` |
| Propose edits the author can accept or reject | `scripts/docx_track.py replace` (tracked, the default) |
| Accept or reject someone's edits | `scripts/docx_track.py accept` / `reject` |
| Review: add, read or remove comments | `scripts/docx_comments.py` |
| Fix something no library exposes | unpack, edit the XML, `pack` (it checks the result) |
| Check a file Word refuses to open | `scripts/ooxml_tools.py check` |

## Scripts

| Script | Does |
|---|---|
| `docx_track.py list` / `accept` / `reject` / `replace` | tracked changes, optionally filtered with `--author` |
| `docx_comments.py list` / `add` / `remove` | comments anchored to an exact phrase |
| `ooxml_tools.py unpack` / `pack` / `check` | extract, rebuild and sanity-check the package |
| `docx_runs.py` | shared run-splitting code the two scripts import |

All editing scripts write to a new file with `-o`; they never overwrite the
input. Each prints what it did and exits non-zero when nothing matched.

### Tracked replacement

```
python scripts/docx_track.py replace draft.docx -o draft-edited.docx \
    --find "was observed" --replace "we observed" --author "Claude"
```

The old text becomes a tracked deletion and the new text a tracked insertion
that copies the formatting of the first matched run. Use `--first` for one
occurrence, `--ignore-case`, or `--untracked` to rewrite in place when the user
did not ask for a revision trail. Always say which mode you used.

### Comments

```
python scripts/docx_comments.py add draft.docx -o reviewed.docx \
    --find "significantly improved" --text "Report the effect size and CI." --author "Reviewer 2"
python scripts/docx_comments.py list reviewed.docx
```

`--find` must match text that sits in ordinary runs. If it does not match,
choose a shorter phrase that lies inside one paragraph.

## Limits to state to the user

- Matching works on text in plain runs of a paragraph or hyperlink. Text split
  by a tab, a field (page number, cross-reference, citation field), a drawing,
  or an existing tracked change is not matched. The script says "no matches"
  rather than guessing.
- Headers, footers and footnotes are not edited by the tracked-change or
  comment scripts. Use python-docx for those parts.
- A deleted paragraph mark that would merge two non-empty paragraphs is left as
  an ordinary break and reported.
- `check` finds structural faults (bad zip, malformed XML, missing parts,
  dangling relationships, orphaned comment references, repeated revision ids).
  It does not validate against the ECMA/ISO schemas. Opening the file in
  LibreOffice or Word is the real test; if neither is available, say the file
  was checked structurally only.

## Habits that prevent damage

- Work on a copy. Keep the original beside the edited file.
- Preserve fields. Citation-manager fields (Zotero, EndNote, Mendeley) and
  cross-references live in field codes; a text rewrite that touches the
  displayed result can detach them. Prefer tracked edits around them, or use the
  `docx-editor-zotero` skill for Zotero documents.
- Prefer styles over direct formatting: set `Heading 1`, `Title`, `Caption`
  styles rather than bolding and enlarging text, so the table of contents and
  navigation work.
- When you generate a document, open it back with python-docx and read the
  headings and tables to confirm what you wrote is what is there. Render to PDF
  for a visual check when LibreOffice exists (`soffice --headless --convert-to
  pdf`), then view pages as images.
- Do not put secrets or unpublished data in comments or tracked-change author
  names; both travel with the file.

## Unpack, edit, pack

```
python scripts/ooxml_tools.py unpack report.docx work/ --pretty
# edit work/word/document.xml (or styles.xml, numbering.xml, ...)
python scripts/ooxml_tools.py pack work/ report-fixed.docx
```

`--pretty` indents between elements only and leaves text untouched, so
whitespace-only runs survive. `pack` puts `[Content_Types].xml` first, runs the
checker and refuses to write a file that fails it.

## Where the parts are

`word/document.xml` body; `word/styles.xml`; `word/numbering.xml` lists;
`word/comments.xml`; `word/_rels/document.xml.rels` links to media, headers,
footers; `docProps/core.xml` author and dates; `word/media/` images. Revision
markup in the body: `w:ins`, `w:del`, `w:moveFrom`/`w:moveTo`, and the
`...Change` records for formatting.
