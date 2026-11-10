---
name: presentation-build
description: Build conference posters and slide decks from a manuscript or outline with `presentation_build`, then run its visual-QA checklist with `read_image` on an image-capable model. Use for talks, posters, defense decks, and lab-meeting slides. Routes design detail to `latex-posters` and `scientific-slides`; the tool never invents results and a compile is not a visual pass.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Presentation build

> **In Academic Harness:** `presentation_build` fills known sections and figure
> files into a chosen template. It never generates a result, a figure, or a
> claim. A successful compile only means the file compiled.

## Workflow

1. **Choose the artifact.** `action: "poster"` with `tikzposter`,
   `beamerposter`, or `baposter`; `action: "slides"` with Beamer or PowerPoint
   (`engine: "pptx"`, needs `python-pptx`).
2. **Choose the content source.** Pass explicit `sections`
   (`{heading, bullets, figures, notes}`) when the talk has its own narrative, or
   pass a manuscript and let the tool read existing headings, bullets, and
   figure references. Empty sections become explicit placeholders.
3. **Load the design skill.**
   - `latex-posters` for poster layout, block hierarchy, and print sizes.
   - `scientific-slides` for talk structure, slide density, and speaker notes.
   - `scientific-figure-making` / `figure-designer` if a figure must be rebuilt;
     the presentation tool only copies existing files.
4. **Build.** The tool writes the source, compiles to PDF, and writes a PNG
   preview when `pdftoppm` is available. `status` lists builds, missing figures,
   and compile failures.
5. **Run QA.** Call `action: "qa"`, render every PDF page at 150 DPI, and
   inspect the images with `read_image` on an image-capable model. The tool never
   claims the visual check passed.
6. **Fix and rebuild.** Re-run after edits; a new build id is created.

## Guardrails

- No invented results, figures, or claims: copy only supplied content.
- A compile error is not `not_installed`; report the log.
- Missing PowerPoint dependency → `not_installed`; do not fake a `.pptx`.
- Keep dates, author lists, funding, and affiliations exactly as supplied.
- Do not present a placeholder as final; the QA checklist looks for them.

## Related

- `latex-posters`, `scientific-slides`, `scientific-figure-making`.
- `read_image` (image-capable model) or an explicitly configured `subagent_vision` route for the visual inspection.
- `manuscript_diff` / `submission_pack` for the text side.
