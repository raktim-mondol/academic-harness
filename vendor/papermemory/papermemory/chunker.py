from __future__ import annotations

import hashlib
import json
import re
from typing import Any

FENCE_RE = re.compile(r"^[ \t]*(```|~~~)")
TABLE_RE = re.compile(r"^[ \t]*\|")
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+")


def _normalize(text: str) -> str:
    return " ".join(text.split())


def _byte_prefix(text: str) -> list[int]:
    prefix = [0] * (len(text) + 1)
    for index, char in enumerate(text):
        prefix[index + 1] = prefix[index] + len(char.encode("utf-8"))
    return prefix


def _line_spans(text: str, start: int, end: int) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    cursor = start
    while cursor < end:
        newline = text.find("\n", cursor, end)
        line_end = end if newline < 0 else newline + 1
        spans.append((cursor, line_end))
        cursor = line_end
    return spans


def _split_long(start: int, end: int, text: str, target: int, hard_max: int) -> list[tuple[int, int]]:
    piece = text[start:end]
    if len(piece) <= hard_max:
        return [(start, end)]
    pieces: list[tuple[int, int]] = []
    cursor = start
    while cursor < end:
        limit = min(cursor + target, end)
        if limit == end:
            pieces.append((cursor, end))
            break
        window = text[cursor:min(cursor + hard_max, end)]
        cuts = [match.end() for match in SENTENCE_RE.finditer(window)]
        cut = max((value for value in cuts if value >= target * 0.4), default=0)
        if cut == 0:
            space = window.rfind(" ", int(target * 0.6), hard_max)
            cut = space if space > 0 else 0
        if cut == 0:
            cut = min(hard_max, end - cursor)
        pieces.append((cursor, cursor + cut))
        cursor += cut
    return pieces


def _table_units(text: str, section, spans, target: int) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    header_span = (spans[0][0], spans[0][1])
    header_text = _normalize(text[header_span[0]:header_span[1]])
    separator_text = ""
    data_rows = []
    for span in spans[1:]:
        line = text[span[0]:span[1]].strip()
        if re.fullmatch(r"\|[\s|:-]+\|?", line):
            separator_text = _normalize(line)
            continue
        data_rows.append(span)
    table_id = f"tbl_{section['ord']}_{header_span[0]}"
    group: list[tuple[int, int]] = []
    group_chars = 0

    def emit(rows, first: bool):
        if not rows:
            return
        start = header_span[0] if first else rows[0][0]
        end = rows[-1][1]
        index_text = " ".join(
            filter(None, [header_text, separator_text if first else "", _normalize(text[rows[0][0]:end])])
        )
        units.append(
            {
                "kind": "table",
                "char_start": start,
                "char_end": end,
                "index_text": index_text,
                "table_id": table_id,
                "row_start": rows[0][2],
                "row_end": rows[-1][2] + 1,
                "header_span_json": json.dumps(
                    {"char_start": header_span[0], "char_end": header_span[1]}
                ),
            }
        )

    for row_index, span in enumerate(data_rows):
        row_chars = span[1] - span[0]
        if group and group_chars + row_chars > target:
            emit(group, first=group[0][2] == 0)
            group = []
            group_chars = 0
        group.append((span[0], span[1], row_index))
        group_chars += row_chars
    if group:
        emit(group, first=group[0][2] == 0)
    if not data_rows:
        units.append(
            {
                "kind": "table",
                "char_start": header_span[0],
                "char_end": header_span[1],
                "index_text": header_text,
                "table_id": table_id,
                "row_start": 0,
                "row_end": 0,
                "header_span_json": json.dumps({"char_start": header_span[0], "char_end": header_span[1]}),
            }
        )
    return units


def _section_units(text: str, section, target_chars: int) -> list[dict[str, Any]]:
    start, end = section["char_start"], section["char_end"]
    spans = _line_spans(text, start, end)
    units: list[dict[str, Any]] = []
    index = 0
    while index < len(spans):
        line_start, line_end = spans[index]
        line = text[line_start:line_end]
        if not line.strip():
            index += 1
            continue
        if FENCE_RE.match(line):
            marker = FENCE_RE.match(line).group(1)
            block = [spans[index]]
            index += 1
            while index < len(spans):
                block.append(spans[index])
                if FENCE_RE.match(text[spans[index][0]:spans[index][1]]) and marker in text[spans[index][0]:spans[index][1]]:
                    index += 1
                    break
                index += 1
            block_start, block_end = block[0][0], block[-1][1]
            units.append(
                {
                    "kind": "fence",
                    "char_start": block_start,
                    "char_end": block_end,
                    "index_text": _normalize(text[block_start:block_end]),
                }
            )
            continue
        if TABLE_RE.match(line):
            table_spans: list[tuple[int, int]] = []
            while index < len(spans) and TABLE_RE.match(text[spans[index][0]:spans[index][1]]):
                table_spans.append(spans[index])
                index += 1
            units.extend(_table_units(text, section, table_spans, max(200, target_chars)))
            continue
        paragraph = [spans[index]]
        index += 1
        while index < len(spans):
            candidate = text[spans[index][0]:spans[index][1]]
            if not candidate.strip() or FENCE_RE.match(candidate) or TABLE_RE.match(candidate):
                break
            paragraph.append(spans[index])
            index += 1
        paragraph_start, paragraph_end = paragraph[0][0], paragraph[-1][1]
        while paragraph_start < paragraph_end and text[paragraph_start].isspace():
            paragraph_start += 1
        while paragraph_end > paragraph_start and text[paragraph_end - 1].isspace():
            paragraph_end -= 1
        if paragraph_start >= paragraph_end:
            continue
        for piece_start, piece_end in _split_long(paragraph_start, paragraph_end, text, 2400, 6000):
            units.append(
                {
                    "kind": "prose",
                    "char_start": piece_start,
                    "char_end": piece_end,
                    "index_text": _normalize(text[piece_start:piece_end]),
                }
            )
    return units


def chunk_document(
    text: str,
    sections: list[dict[str, Any]],
    *,
    target_chars: int = 2400,
    min_chars: int = 400,
    hard_max_chars: int = 6000,
) -> tuple[list[dict[str, Any]], list[tuple[int, int]], int]:
    prefix = _byte_prefix(text)
    chunks: list[dict[str, Any]] = []
    covered: list[tuple[int, int]] = []
    dropped = 0

    def make_chunk(unit: dict[str, Any], section: dict[str, Any]) -> dict[str, Any]:
        cs, ce = unit["char_start"], unit["char_end"]
        slice_bytes = text[cs:ce].encode("utf-8")
        return {
            "char_start": cs,
            "char_end": ce,
            "byte_start": prefix[cs],
            "byte_end": prefix[ce],
            "slice_sha256": hashlib.sha256(slice_bytes).hexdigest(),
            "index_text": unit["index_text"],
            "table_id": unit.get("table_id"),
            "row_start": unit.get("row_start"),
            "row_end": unit.get("row_end"),
            "header_span_json": unit.get("header_span_json"),
            "is_bibliography": int(section.get("is_bibliography") or 0),
            "claimable": 0 if section.get("is_bibliography") else 1,
            "section_ord": section["ord"],
        }

    for section in sections:
        units = _section_units(text, section, target_chars)
        if not units:
            continue
        current: dict[str, Any] | None = None
        for unit in units:
            if unit["kind"] in {"table", "fence"}:
                if current:
                    chunks.append(make_chunk(current, section))
                    covered.append((current["char_start"], current["char_end"]))
                    current = None
                chunks.append(make_chunk(unit, section))
                covered.append((unit["char_start"], unit["char_end"]))
                continue
            if current is None:
                current = dict(unit)
                continue
            merged_end = unit["char_end"]
            if merged_end - current["char_start"] <= target_chars:
                current["char_end"] = merged_end
                current["index_text"] = _normalize(text[current["char_start"]:merged_end])
            else:
                chunks.append(make_chunk(current, section))
                covered.append((current["char_start"], current["char_end"]))
                current = dict(unit)
        if current:
            chunks.append(make_chunk(current, section))
            covered.append((current["char_start"], current["char_end"]))

    uncovered: list[tuple[int, int]] = []
    for section in sections:
        cursor = section["char_start"]
        for start, end in sorted(span for span in covered if span[0] >= section["char_start"] and span[1] <= section["char_end"]):
            if start > cursor:
                uncovered.append((cursor, start))
            cursor = max(cursor, end)
        if cursor < section["char_end"]:
            uncovered.append((cursor, section["char_end"]))
    uncovered = [(start, end) for start, end in uncovered if start < end]
    return chunks, uncovered, dropped
