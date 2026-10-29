"""Small LaTeX-to-text helpers for bibliographic fields (stdlib only).

Covers what real ``.bib`` files contain: accent commands, a handful of letter
commands, escaped specials, and case-protection braces. Anything it does not
understand is left in place rather than guessed at.
"""
from __future__ import annotations

import re
import unicodedata

_ACCENT_SYMBOLS = {
    '"': "\u0308", "'": "\u0301", "`": "\u0300", "^": "\u0302", "~": "\u0303",
    "=": "\u0304", ".": "\u0307",
}
_ACCENT_LETTERS = {
    "u": "\u0306", "v": "\u030c", "H": "\u030b", "c": "\u0327", "k": "\u0328",
    "r": "\u030a", "d": "\u0323", "b": "\u0331",
}
_LETTERS = {
    "ss": "\u00df", "o": "\u00f8", "O": "\u00d8", "ae": "\u00e6", "AE": "\u00c6",
    "oe": "\u0153", "OE": "\u0152", "aa": "\u00e5", "AA": "\u00c5", "l": "\u0142",
    "L": "\u0141", "i": "\u0131", "j": "\u0237",
}
_ESCAPES = {"&": "&", "%": "%", "$": "$", "#": "#", "_": "_", "{": "{", "}": "}"}

_SYMBOL_ACCENT = re.compile(r"\\([\"'`^~=.])\s*(?:\{\s*(\\[ij]|[A-Za-z])\s*\}|(\\[ij]|[A-Za-z]))")
_LETTER_ACCENT = re.compile(r"\\([uvHckrdb])(?:\s*\{\s*(\\[ij]|[A-Za-z])\s*\}|\s+(\\[ij]|[A-Za-z]))")
_LETTER_CMD = re.compile(r"\\(ss|oe|OE|ae|AE|aa|AA|o|O|l|L|i|j)(?![A-Za-z])(?:\s*\{\s*\})?\s?")
_ESCAPED = re.compile(r"\\([&%$#_{}])")


def _base(letter: str) -> str:
    return _LETTERS[letter[1:]] if letter.startswith("\\") else letter


def has_latex(value: str) -> bool:
    return "\\" in value or "{" in value or "~" in value


def strip_braces(value: str) -> str:
    """Remove case-protection braces, keeping their contents."""
    out: list[str] = []
    escaped = False
    for ch in value:
        if escaped:
            out.append(ch)
            escaped = False
        elif ch == "\\":
            out.append(ch)
            escaped = True
        elif ch in "{}":
            continue
        else:
            out.append(ch)
    return "".join(out)


def latex_to_text(value: str | None) -> str:
    """Decode accents and escapes, drop protection braces, collapse whitespace."""
    if not value:
        return ""
    text = value
    text = _SYMBOL_ACCENT.sub(
        lambda m: unicodedata.normalize("NFC", _base(m.group(2) or m.group(3)) + _ACCENT_SYMBOLS[m.group(1)]), text
    )
    text = _LETTER_ACCENT.sub(
        lambda m: unicodedata.normalize("NFC", _base(m.group(2) or m.group(3)) + _ACCENT_LETTERS[m.group(1)]), text
    )
    text = _LETTER_CMD.sub(lambda m: _LETTERS[m.group(1)], text)
    text = _ESCAPED.sub(lambda m: _ESCAPES[m.group(1)], text)
    text = text.replace("~", " ")
    text = strip_braces(text)
    return re.sub(r"\s+", " ", text).strip()
