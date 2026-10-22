from __future__ import annotations

import re

ATX_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)\s*#*\s*$")
SETEXT_RE = re.compile(r"^[ \t]*(=+|-+)[ \t]*$")
NUMBERED_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+([^\n]{1,90})$")
FENCE_RE = re.compile(r"^[ \t]*(```|~~~)")
BIBLIOGRAPHY_RE = re.compile(r"^\s*(?:\d+(?:\.\d+)*\.?\s*)?(references|bibliography|works cited|literature cited)\s*$", re.I)
ABSTRACT_RE = re.compile(r"^\s*(?:\d+(?:\.\d+)*\.?\s*)?(abstract|summary)\s*$", re.I)


def _heading_text(line: str) -> str:
    return line.strip().strip("#").strip()


def _collect_headings(text: str) -> list[dict]:
    lines = text.splitlines(keepends=True)
    offsets: list[int] = []
    cursor = 0
    for line in lines:
        offsets.append(cursor)
        cursor += len(line)
    headings: list[dict] = []
    in_fence = False
    index = 0
    while index < len(lines):
        raw = lines[index]
        stripped = raw.strip()
        if FENCE_RE.match(raw):
            in_fence = not in_fence
            index += 1
            continue
        if in_fence:
            index += 1
            continue
        if not stripped:
            index += 1
            continue
        atx = ATX_RE.match(raw.rstrip("\n"))
        if atx:
            headings.append(
                {
                    "level": len(atx.group(1)),
                    "title": atx.group(2).strip().rstrip("#").strip(),
                    "char_start": offsets[index],
                    "line_start": index + 1,
                    "heading_end_line": index,
                }
            )
            index += 1
            continue
        if index + 1 < len(lines) and SETEXT_RE.match(lines[index + 1]) and not stripped.startswith(("|", "-", "*", ">")):
            level = 1 if lines[index + 1].strip().startswith("=") else 2
            headings.append(
                {
                    "level": level,
                    "title": _heading_text(stripped),
                    "char_start": offsets[index],
                    "line_start": index + 1,
                    "heading_end_line": index + 1,
                }
            )
            index += 2
            continue
        numbered = NUMBERED_RE.match(stripped)
        if numbered and not stripped.endswith("."):
            level = min(6, 2 + numbered.group(1).count("."))
            headings.append(
                {
                    "level": level,
                    "title": f"{numbered.group(1)} {numbered.group(2).strip()}",
                    "char_start": offsets[index],
                    "line_start": index + 1,
                    "heading_end_line": index,
                }
            )
            index += 1
            continue
        index += 1
    return headings


def build_section_tree(text: str, *, base_offset: int = 0, base_line: int = 0) -> list[dict]:
    headings = _collect_headings(text)
    line_count = text.count("\n") + (1 if text and not text.endswith("\n") else 0)
    if not headings:
        sections = [
            {
                "heading": "",
                "level": 1,
                "heading_path": "",
                "parent_index": None,
                "char_start": base_offset,
                "char_end": base_offset + len(text),
                "line_start": base_line + 1,
                "line_end": base_line + max(line_count, 1),
                "is_bibliography": 0,
                "is_abstract": 0,
                "kind": "prose",
                "ord": 0,
            }
        ]
        return sections
    sections: list[dict] = []
    stack: list[dict] = []
    if headings[0]["char_start"] > 0:
        preamble = text[: headings[0]["char_start"]]
        if preamble.strip():
            sections.append(
                {
                    "heading": "",
                    "level": 1,
                    "heading_path": "",
                    "parent_index": None,
                    "char_start": base_offset,
                    "char_end": base_offset + headings[0]["char_start"],
                    "line_start": base_line + 1,
                    "line_end": base_line + headings[0]["line_start"] - 1,
                    "is_bibliography": 0,
                    "is_abstract": 0,
                    "kind": "prose",
                    "ord": 0,
                }
            )
    for position, heading in enumerate(headings):
        while stack and stack[-1]["level"] >= heading["level"]:
            stack.pop()
        parent_index = stack[-1]["ord"] if stack else None
        heading_path = " > ".join([entry["title"] for entry in stack] + [heading["title"]])
        end = headings[position + 1]["char_start"] if position + 1 < len(headings) else len(text)
        section = {
            "heading": heading["title"],
            "level": heading["level"],
            "heading_path": heading_path,
            "parent_index": parent_index,
            "char_start": base_offset + heading["char_start"],
            "char_end": base_offset + end,
            "line_start": base_line + heading["line_start"],
            "line_end": base_line + (text[:end].count("\n") + 1),
            "is_bibliography": 1 if BIBLIOGRAPHY_RE.match(heading["title"]) else 0,
            "is_abstract": 1 if ABSTRACT_RE.match(heading["title"]) else 0,
            "kind": "prose",
            "ord": len(sections),
        }
        sections.append(section)
        stack.append({"level": heading["level"], "title": heading["title"], "ord": section["ord"]})
    return sections
