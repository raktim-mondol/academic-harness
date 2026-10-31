---
name: manuscript-revision
description: Produce a real revision diff and response-letter skeleton with `manuscript_diff` — latexdiff or Markdown diffs, changed blocks, DOCX tracked changes/comments, and a letter that only cites recorded changes. Use for revise-and-resubmit work, reviewer responses, or comparing two manuscript versions without editing either.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Manuscript revision

> **In Academic Harness:** the tool diffs and extracts. It never edits either
> source, never invents a change, and never marks an item addressed without a
> recorded hunk behind it.

## Workflow

1. **Snapshot the two versions.** Keep the submitted/first version and the
   revised version as separate files. Do not overwrite the old file.
2. **Diff.** `manuscript_diff` `action: "diff"` with `old` and `new`:
   - `.tex` → `latexdiff` output plus an optional compiled PDF; if `latexdiff`
     is missing the tool returns `not_installed` and writes nothing.
   - `.md`/`.txt` → unified diff.
3. **Extract changed blocks.** `action: "changes"` writes `changes.json` and
   `changes.md` under `.dsh/manuscript-diff/<slug>/`; each block has an id like
   `ch-001`.
4. **Read reviewer comments.** In an `ah.yaml` project, import them with
   `ah_review` and let `manuscript_diff` `action: "letter"` with `review: <id>`
   build the letter through `ah_review_respond`. Outside that project, pass
   `items` with `{id, text, response, status, change_ids}`.
5. **Map, do not assume.** Every `change_id` must exist in `changes.json`. An
   item marked `addressed` without a matching change is flagged in the letter
   and returned in `unresolved`. A response with no change is a rebuttal, not an
   addressed revision; say so.
6. **Let the authors write the responses.** The tool supplies placeholders and
   the real hunks, never the argument or the prose.

## DOCX

`action: "docx"` extracts tracked insertions/deletions, comments, and
Zotero/CSL field text from `word/document.xml`. It reports them; it does not
accept changes or rewrite the document. Pass an optional `old` DOCX to compare
the extracted text of both versions.

## Guardrails

- Never edit either source file; only write the diff, changes, and letter.
- Never claim an addressed item when no hunk supports it.
- Never normalize away comments, tracked changes, or Zotero fields.
- A compiled diff PDF is a convenience, not evidence that the revision is
  complete.
- `latexdiff` missing → report `not_installed`; do not silently fall back to a
  hand-edited "diff".

## Related

- `ah_review`, `ah_review_set`, `ah_review_respond` inside an `ah.yaml` project.
- `manuscript_citations` after the revision.
- `submission_pack` for the resubmission bundle.
