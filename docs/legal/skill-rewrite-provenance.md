# Provenance of the rewritten docx, pdf, pptx and xlsx skills

Written 2026-11-10 to 2026-11-11 on branch `fix/licence-skills-rewrite`. This note records how the four skills were produced so that a reader, or counsel, can judge them. It is a record of method and checks, not a legal opinion.

## Why

Releases up to and including 0.50.0 bundled third-party versions of `docx`, `pdf`, `pptx` and `xlsx` (186 files, about 3.4 MB) whose `LICENSE.txt` reserves all rights, and which were shipped inside an MIT-licensed package without a `NOTICE` entry (review finding C1, `reports/codebase-review-2026-11-10.md`). The owner decided to replace them with original work rather than keep or merely remove them.

## What was produced

| Skill | Files | What it adds |
|---|---|---|
| `docx` | `SKILL.md`, `references/python-docx-recipes.md`, `scripts/` (`docx_track.py`, `docx_comments.py`, `docx_runs.py`, `ooxml_tools.py`), tests | tracked changes (list, accept, reject, create), comments anchored to a phrase, package unpack/pack/check |
| `pdf` | `SKILL.md`, `references/reference.md`, `scripts/` (`pdf_text`, `pdf_pages`, `pdf_fields`, `pdf_fill`, `pdf_overlay`, `pdf_words`, `pdf_render`), tests | text and table extraction, page operations, fillable-form and overlay filling, rendering |
| `pptx` | `SKILL.md`, `references/python-pptx-recipes.md`, `scripts/` (`pptx_outline`, `pptx_check`, `pptx_thumbs`, `ooxml_tools.py`), tests | outline, slide-quality lint, contact sheet |
| `xlsx` | `SKILL.md`, `references/openpyxl-recipes.md`, `scripts/` (`xlsx_inspect`, `xlsx_recalc`, `ooxml_tools.py`), tests | inspection and formula lint, LibreOffice recalculation check |

All four are labelled MIT. None bundles any ECMA, ISO or Microsoft schema, template or sample file; the docx, pptx and xlsx trees were each about 1.1 MB, almost all of it such schemas.

## Method

1. **Author.** An AI coding assistant (Claude, in a Claude Code session) wrote the text and code at the owner's request. An AI model may have seen the original skills during training, and this note does not claim otherwise. The safeguards below are procedural, not a guarantee.
2. **No copying.** The assistant did not open the old `SKILL.md`, reference or script files while writing. It listed the old directory trees (file names and sizes) to learn the scope, and an automated script read the old files for the overlap check below. That script prints locations in the new files only, never old text.
3. **Sources.** The public, documented behaviour of the libraries and tools the skills drive: python-docx, lxml, pandoc, openpyxl, pandas, pypdf, reportlab, pdfplumber, pypdfium2, python-pptx, PptxGenJS, LibreOffice (headless conversion), poppler (`pdftoppm`), Ghostscript, OCRmyPDF and Tesseract, and the Office Open XML package conventions (zip of XML parts, `[Content_Types].xml`, relationships). Library calls in the recipes were executed against the installed versions, not copied from anywhere.
4. **Different design.** New skill structure, new script names and command-line shapes, new prose. Where the same task needs the same library call, the call is the library's documented API.
5. **Scope kept honest.** Each `SKILL.md` states what its scripts cannot do (for example, tracked-change and comment editing cover the document body only; the thumbnail grid is LibreOffice's rendering, not PowerPoint's).

## Automated overlap check

`node scripts/check-skill-rewrite.mjs` (default base `32ab58f`, the 0.50.0 tree) compares every new `.md` and `.py` file with every old one in the four directories.

| Window | Result |
|---|---|
| 12 consecutive words (prose) / 10 tokens (code, after dropping imports, comments and boilerplate lines) | **0 shared runs** (exit 0). This is the check `npm test` can run. |
| 8 tokens, run once for information | 16 shared runs, all idiomatic library or format constants in the new files: ECMA namespace URIs, `subprocess.run(..., capture_output=True, text=True, timeout=...)`, openpyxl `ws.iter_rows()` loops, `datetime.now(timezone.utc).strftime(...)`. |
| 6 tokens, run once for information | 106 shared runs of the same kind (plus the byte-identical copies of `ooxml_tools.py`). |
| Positive control | Against a throwaway commit containing the new files themselves, the same script reports 26,734 shared runs, so it does detect copying. |

The check finds copied wording. It does not find copied structure or ideas.

## Behavioural checks

`scripts/test-office-skills.mjs` runs each skill's Python unit tests (31 docx, 23 pdf, 19 pptx, 19 xlsx at the time of writing, run with python-docx 1.2.0, openpyxl 3.1.5, pypdf 6.10 and 7.0, reportlab 4.4 and 5.1, python-pptx 1.0.2, pdfplumber 0.11, lxml 6.1). They build real documents, run every script, and check the output with an independent library or the package checker. Every code block in each skill's recipe reference is executed by a test, which already caught one wrong recipe (merging into a page that still belongs to the reader).

Not exercised here: LibreOffice itself (`xlsx_recalc.py`, `pptx_thumbs.py` are tested against a stand-in `soffice` that returns a prepared result, so the argument handling, copy handling and error scan are tested, and LibreOffice's calculation and rendering are not), and PowerPoint or Word opening the results. The `ooxml_tools.py check` command is structural; it is not schema validation.

## What remains true of the old files

- They are still in git history and in the npm tarballs and GitHub releases of 0.50.0 and earlier. This change does not rewrite history or withdraw those releases. That is a question for the owner and counsel (see `skill-licence-brief.md`).
- On a machine that seeded 0.50.0 or earlier, `seed.js` now moves an installed copy of the four old skills (recognised by their `LICENSE.txt`, SHA-256 `79f6d8f5…cfaa`) to `$DSH_HOME/skills-retired/` and installs the rewrite. A user-modified copy without that file is left alone.

## To repeat the checks

```
node scripts/check-skill-rewrite.mjs                       # expect: no shared runs
node scripts/check-skill-rewrite.mjs --prose-n 8 --code-n 8   # informational
AH_OFFICE_PYTHON=/path/to/python-with-the-libraries node scripts/test-office-skills.mjs
```
