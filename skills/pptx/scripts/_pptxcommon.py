"""Helpers shared by the pptx scripts: walking shapes, alt text, geometry."""
from __future__ import annotations

import sys

try:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    from pptx.util import Emu
except ImportError:  # pragma: no cover - environment dependent
    sys.exit("these scripts need python-pptx (pip install python-pptx)")

EMU_PER_POINT = 12700


def walk(shapes):
    """Every shape on a slide, descending into groups."""
    for shape in shapes:
        yield shape
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from walk(shape.shapes)


def alt_text(shape) -> str:
    for node in shape._element.iter():
        if node.tag.endswith("}cNvPr"):
            return node.get("descr") or ""
    return ""


def box(shape):
    """(left, top, right, bottom) in points, or None for shapes without geometry."""
    try:
        if shape.left is None or shape.width is None:
            return None
        l, t = shape.left / EMU_PER_POINT, shape.top / EMU_PER_POINT
        return (l, t, l + shape.width / EMU_PER_POINT, t + shape.height / EMU_PER_POINT)
    except (AttributeError, TypeError):
        return None


def is_picture(shape) -> bool:
    return shape.shape_type == MSO_SHAPE_TYPE.PICTURE


def title_text(slide) -> str:
    title = slide.shapes.title
    if title is not None and title.has_text_frame:
        return title.text_frame.text.strip()
    return ""


def slide_size(prs):
    return prs.slide_width / EMU_PER_POINT, prs.slide_height / EMU_PER_POINT
