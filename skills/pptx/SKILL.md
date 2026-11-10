---
name: pptx
description: Create, read, edit and check PowerPoint (.pptx) presentations. Use to build a slide deck from code, read the text and structure of an existing deck, change slides while keeping the template, check slides for off-slide shapes, tiny fonts, missing alt text, empty placeholders and text overflow, and render a deck to a contact sheet to look at it. For scientific talk design, posters and visual review workflow, also read the scientific-slides and pptx-posters skills.
license: MIT
metadata:
  version: "2.0"
  skill-author: Academic Harness
  skill-source: original; drives python-pptx, LibreOffice, poppler and Pillow, none of which are bundled
---

# PowerPoint decks (.pptx)

Paths are relative to this skill's directory. Install `pip install python-pptx
pillow`. Looking at slides needs LibreOffice (to convert) and poppler (to
rasterise); without them you can still read, edit and check decks.

## Pick the route

| You want to | Use |
|---|---|
| Read what an existing deck says | `scripts/pptx_outline.py deck.pptx [--notes]` |
| Build a new deck | python-pptx, see [references/python-pptx-recipes.md](references/python-pptx-recipes.md) |
| Keep a template's look | start from `Presentation("template.pptx")` and add slides from its layouts |
| Edit text in an existing deck | python-pptx, changing runs (keeps formatting), then re-check |
| Lint for common slide faults | `scripts/pptx_check.py deck.pptx` |
| Look at every slide | `scripts/pptx_thumbs.py deck.pptx -o sheet.png`, then view the image |
| Repair a package or change XML directly | `scripts/ooxml_tools.py unpack / pack / check` |

## Scripts

- `pptx_outline.py`: layout, title, text with bullet levels, tables, charts,
  pictures with alt text, and speaker notes for each slide. `--json` for tools.
- `pptx_check.py`: errors (shape off the slide) and warnings (no title, picture
  alt text missing or only a file name, text under `--min-font`, empty
  placeholder, probable overflow, too many words, overlapping shapes).
  `--strict` makes warnings fail the run too. It reads sizes that are set on the
  text itself; sizes inherited from a theme are invisible to it, so a clean
  result is not proof, and rendering is the real check.
- `pptx_thumbs.py`: deck (or PDF) to one numbered contact sheet; `--slides-dir`
  also keeps one PNG per slide for a closer look. LibreOffice does
  the rendering, so fonts differ slightly from PowerPoint; use it to spot
  overflow, collisions and empty slides.
- `ooxml_tools.py`: shared unpack/pack/check for the package.

## Workflow for a new deck

1. Write the outline first: one claim per slide, as a sentence the audience could
   repeat. Titles state the claim ("Treatment B halves relapse"), not the topic
   ("Results").
2. Build from layouts, not loose text boxes: use the layout's title and body
   placeholders so outline view, accessibility and re-theming work.
3. Run `pptx_check.py`, fix errors, read the warnings.
4. Run `pptx_thumbs.py` and look at the sheet. Fix what you see. Look again.
5. Report what you checked and how, including that it was rendered by
   LibreOffice rather than PowerPoint.

## Design habits that hold up

- A figure needs a legible message at the back of the room: large labels (axis
  text at least 14 pt on the slide), one idea, direct labels instead of a legend
  where possible.
- Keep to about 40 words of body text; put detail in the notes or a handout.
  `--max-words` is a prompt to cut, not a quality score.
- Contrast and colour: dark text on a light background or the reverse, never
  mid-grey on mid-tone; do not rely on colour alone to separate series.
- Give every picture alt text that says what it shows and why it is there.
  Decorative images can be left to a person to mark as decorative.
- Cite sources on the slide that uses them, small but readable.
- Do not invent data or quotations for a slide. Numbers come from the user's
  results or a cited source.

## Limits

- python-pptx cannot render, play animations or transitions, or edit embedded
  media; it preserves most of what it does not model but can lose some
  extensions. Check a template-based deck by rendering after saving.
- Charts made with python-pptx are native and editable, but their look is plain.
  For publication-grade figures, make the image elsewhere (matplotlib) and place
  it with alt text.
- The text-fit estimate in `pptx_check.py` is rough. Rendering decides.
