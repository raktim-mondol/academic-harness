"""A tolerant BibTeX/BibLaTeX parser (stdlib only).

Unlike a regex scan it tracks delimiters, so it handles ``{}`` and ``()``
entries, quoted and braced values, ``#`` concatenation, ``@string`` macros and
month macros. It never lets one malformed entry swallow the next: when an
entry is missing its closing delimiter the parser resynchronises at the next
line-leading ``@type{`` and reports the problem.

Values keep their inner braces (case protection) and their LaTeX escapes; use
``latex_text.latex_to_text`` to read them as plain text.
"""
from __future__ import annotations

import bisect
import re
from dataclasses import dataclass, field
from typing import Any

MONTH_MACROS = {
    "jan": "January", "feb": "February", "mar": "March", "apr": "April", "may": "May",
    "jun": "June", "jul": "July", "aug": "August", "sep": "September", "oct": "October",
    "nov": "November", "dec": "December",
}
_ENTRY_START = re.compile(r"(?:(?m:^[ \t]*)|(?<=[})]))@\s*([A-Za-z]+)\s*([{(])")
_LINE_ENTRY = re.compile(r"[ \t]*@\s*[A-Za-z]+\s*[{(]")
_FIELD_NAME = re.compile(r"[^\s=,{}()\"#%@]+")
_IDENT = re.compile(r"[A-Za-z][A-Za-z0-9_:.\-]*")
_NUMBER = re.compile(r"\d+")
_SKIPPED = {"comment", "preamble"}


@dataclass
class BibEntry:
    entry_type: str
    key: str
    fields: dict[str, str] = field(default_factory=dict)
    raw: str = ""
    line: int = 0
    warnings: list[str] = field(default_factory=list)


@dataclass
class BibParse:
    entries: list[BibEntry] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)
    strings: dict[str, str] = field(default_factory=dict)


class _Unterminated(Exception):
    def __init__(self, pos: int):
        self.pos = pos


def _at_line_entry(text: str, pos: int) -> bool:
    """True when ``pos`` begins a line that looks like ``  @type{``."""
    line_start = text.rfind("\n", 0, pos) + 1
    return text[line_start:pos].strip() == "" and bool(_LINE_ENTRY.match(text, line_start))


def parse_bib(text: str) -> BibParse:
    result = BibParse()
    newlines = [i for i, ch in enumerate(text) if ch == "\n"]

    def line_of(pos: int) -> int:
        return bisect.bisect_right(newlines, pos - 1) + 1

    def skip_ws(i: int) -> int:
        n = len(text)
        while i < n and text[i] in " \t\r\n":
            i += 1
        return i

    def scan_braced(i: int) -> tuple[str, int]:
        """``text[i] == '{'``; returns (inner, index after the closing brace)."""
        depth = 0
        j = i
        n = len(text)
        while j < n:
            ch = text[j]
            if ch == "\\":
                j += 2
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[i + 1:j], j + 1
            elif ch == "\n" and depth >= 1 and _at_line_entry(text, j + 1):
                raise _Unterminated(j + 1)
            j += 1
        raise _Unterminated(n)

    def scan_quoted(i: int) -> tuple[str, int]:
        depth = 0
        j = i + 1
        n = len(text)
        while j < n:
            ch = text[j]
            if ch == "\\":
                j += 2
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth = max(0, depth - 1)
            elif ch == '"' and depth == 0:
                return text[i + 1:j], j + 1
            elif ch == "\n" and _at_line_entry(text, j + 1):
                raise _Unterminated(j + 1)
            j += 1
        raise _Unterminated(n)

    def parse_value(i: int, warnings: list[str]) -> tuple[str, int]:
        parts: list[str] = []
        while True:
            i = skip_ws(i)
            if i >= len(text):
                raise _Unterminated(i)
            ch = text[i]
            if ch == "{":
                inner, i = scan_braced(i)
                parts.append(inner)
            elif ch == '"':
                inner, i = scan_quoted(i)
                parts.append(inner)
            else:
                number = _NUMBER.match(text, i)
                if number:
                    parts.append(number.group(0))
                    i = number.end()
                else:
                    ident = _IDENT.match(text, i)
                    if not ident:
                        raise _Unterminated(i)
                    name = ident.group(0).lower()
                    i = ident.end()
                    if name in result.strings:
                        parts.append(result.strings[name])
                    elif name in MONTH_MACROS:
                        parts.append(MONTH_MACROS[name])
                    else:
                        warnings.append(f"unknown-macro:{name}")
                        parts.append(ident.group(0))
            i = skip_ws(i)
            if i < len(text) and text[i] == "#":
                i += 1
                continue
            return "".join(parts), i

    def resync(pos: int) -> int:
        nxt = _ENTRY_START.search(text, pos)
        return nxt.start() if nxt else len(text)

    pos = 0
    while True:
        match = _ENTRY_START.search(text, pos)
        if not match:
            break
        start = match.start()
        entry_type = match.group(1).lower()
        opener = match.group(2)
        closer = "}" if opener == "{" else ")"
        i = match.end()

        if entry_type in _SKIPPED:
            try:
                if opener == "{":
                    _, pos = scan_braced(i - 1)
                else:
                    close = text.find(")", i)
                    pos = close + 1 if close >= 0 else len(text)
            except _Unterminated as exc:
                result.errors.append({"line": line_of(start), "key": None, "message": f"unterminated @{entry_type}"})
                pos = max(exc.pos, i)
            continue

        warnings: list[str] = []
        if entry_type == "string":
            try:
                i = skip_ws(i)
                name_match = _FIELD_NAME.match(text, i)
                if not name_match:
                    raise _Unterminated(i)
                name = name_match.group(0).lower()
                i = skip_ws(name_match.end())
                if i >= len(text) or text[i] != "=":
                    raise _Unterminated(i)
                value, i = parse_value(i + 1, warnings)
                result.strings[name] = value
                i = skip_ws(i)
                pos = i + 1 if i < len(text) and text[i] == closer else i
            except _Unterminated as exc:
                result.errors.append({"line": line_of(start), "key": None, "message": "malformed @string"})
                pos = resync(max(exc.pos, i))
            continue

        # Regular entry: key, then fields.
        key_end = i
        n = len(text)
        while key_end < n and text[key_end] not in ",{}()\n":
            key_end += 1
        key = text[i:key_end].strip()
        if key_end >= n or text[key_end] == "\n" or not key:
            # no key/comma on this line: not a usable entry
            result.errors.append({"line": line_of(start), "key": key or None, "message": "entry has no key"})
            pos = resync(key_end if key_end > start else start + 1) if key_end < n and text[key_end] != "\n" else resync(start + 1)
            if pos <= start:
                pos = start + 1
            continue
        entry = BibEntry(entry_type=entry_type, key=key, line=line_of(start))
        i = key_end
        end = None
        try:
            while True:
                i = skip_ws(i)
                while i < n and text[i] == ",":
                    i = skip_ws(i + 1)
                if i >= n:
                    entry.warnings.append("unterminated-entry")
                    end = n
                    break
                if text[i] == closer:
                    end = i + 1
                    break
                if text[i] == "@" and _at_line_entry(text, i):
                    entry.warnings.append("unterminated-entry")
                    end = i
                    break
                name_match = _FIELD_NAME.match(text, i)
                if not name_match:
                    entry.warnings.append(f"skipped-character:{text[i]!r}")
                    i += 1
                    continue
                name = name_match.group(0).lower()
                j = skip_ws(name_match.end())
                if j >= n or text[j] != "=":
                    entry.warnings.append(f"field-without-value:{name}")
                    i = name_match.end()
                    continue
                try:
                    value, i = parse_value(j + 1, entry.warnings)
                except _Unterminated as exc:
                    entry.warnings.append(f"unterminated-value:{name}")
                    end = exc.pos
                    break
                if name in entry.fields:
                    entry.warnings.append(f"duplicate-field:{name}")
                else:
                    entry.fields[name] = value
        except _Unterminated as exc:  # pragma: no cover - defensive
            end = exc.pos
        entry.raw = text[start:end].rstrip()
        result.entries.append(entry)
        for warning in entry.warnings:
            if warning.startswith(("unterminated", "duplicate-field")):
                result.errors.append({"line": entry.line, "key": key, "message": warning})
        pos = max(end, start + 1)
    return result
