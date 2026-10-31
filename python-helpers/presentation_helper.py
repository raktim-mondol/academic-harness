#!/usr/bin/env python3
"""Generate a simple PowerPoint deck from a JSON outline.

Reads {"out": "...", "title": "...", "subtitle": "...", "authors": "...",
"sections": [{"heading": "...", "bullets": [...], "notes": "...",
"figures": ["/abs/path.png"]}]} on stdin.

Requires python-pptx. The deck contains only the supplied outline; no text or
image is generated. A successful file is not a visual QA pass.
"""
import json
import re
import sys

try:
    from pptx import Presentation
    from pptx.util import Inches, Pt
except Exception as error:  # pragma: no cover - surfaced to the caller
    print(json.dumps({"error": f"python-pptx is not installed: {error}", "not_installed": True}))
    sys.exit(0)

try:
    from PIL import Image
except Exception:  # pragma: no cover - optional
    Image = None


def clean(value):
    text = str(value or "")
    text = re.sub(r"\\cite[tp]?\{([^}]*)\}", r"[\1]", text)
    text = re.sub(r"\\(?:textbf|textit|emph|underline|mathrm|text)\{([^{}]*)\}", r"\1", text)
    text = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?", "", text)
    text = text.replace("{", "").replace("}", "").replace("~", " ")
    return re.sub(r"\s+", " ", text).strip()


def image_size(path, max_w, max_h):
    if Image is not None:
        try:
            with Image.open(path) as image:
                width, height = image.size
            ratio = min(max_w / width, max_h / height)
            return int(width * ratio), int(height * ratio)
        except Exception:
            pass
    return int(max_w), int(max_h * 0.6)


def build(request):
    out = request.get("out")
    if not out:
        raise ValueError("out is required")
    sections = request.get("sections") or []
    if not sections:
        raise ValueError("at least one section is required")
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    title_slide = prs.slides.add_slide(prs.slide_layouts[0])
    title_slide.shapes.title.text = clean(request.get("title") or "Presentation")
    subtitle = title_slide.placeholders[1]
    parts = [clean(request.get("subtitle") or ""), clean(request.get("authors") or "")]
    subtitle.text = "\n".join(part for part in parts if part)

    for section in sections:
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = clean(section.get("heading") or "Untitled section")
        body = slide.placeholders[1]
        bullets = [clean(item) for item in (section.get("bullets") or []) if clean(item)]
        if not bullets:
            bullets = ["[Author content required for this section]"]
        body.text = "\n".join(bullets)
        for paragraph in body.text_frame.paragraphs:
            paragraph.level = 0
            paragraph.font.size = Pt(22)

        figures = [path for path in (section.get("figures") or []) if path]
        if figures:
            body.width = Inches(6.1)
            max_w = Inches(5.6)
            max_h = Inches(4.8)
            top = Inches(1.7)
            for index, path in enumerate(figures[:2]):
                width, height = image_size(path, max_w, max_h / min(2, len(figures)))
                slide.shapes.add_picture(path, Inches(7.0), top, width=width, height=height)
                top += height + Inches(0.15)
        notes = clean(section.get("notes") or "")
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    prs.save(out)
    return {"ok": True, "path": out, "slides": len(sections) + 1}


def main():
    try:
        request = json.load(sys.stdin)
        print(json.dumps(build(request), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
