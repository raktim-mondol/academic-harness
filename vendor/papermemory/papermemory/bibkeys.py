"""Citation-key policy.

A key is rendered from a template of ``{token}`` placeholders. The default,
``{family}{year}{titleword}``, matches the Academic Harness ``citation`` tool so
both sides produce the same key for the same record:

- ``{family}``     first author's (or editor's) family name, ASCII, lower case
- ``{year}``       publication year, or ``nd``
- ``{titleword}``  first significant title word (not a stop word, longer than 2)
- ``{doi}``        the DOI with unsafe characters removed
- ``{arxiv}``      the arXiv id with unsafe characters removed

If the rendered key is empty, or the record has neither author nor year, the
fallback chain is DOI, then arXiv id, then (for an empty key) a title slug. ``clean_key`` makes the result safe for BibTeX
(ASCII letters, digits and ``_ - : .``; never starting with a digit).

Uniqueness and stability (library-wide unique keys, letter suffixes, frozen
keys, rekey) live in ``library_store``.
"""
from __future__ import annotations

import os
import re
import unicodedata
from typing import Any

DEFAULT_TEMPLATE = "{family}{year}{titleword}"
KEY_MAX = 64
DEFAULT_CUT = 48
TOKENS = ("family", "year", "titleword", "doi", "arxiv")

_STOP = {"a", "an", "the", "on", "of", "for", "and", "in", "to", "with", "from"}
_USABLE_SOURCE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_:.\-/+]*$")
_TOKEN = re.compile(r"\{([A-Za-z]+)\}")
_SAFE = re.compile(r"[^A-Za-z0-9_:.\-]")


class TemplateError(ValueError):
    pass


def _ascii(value: str) -> str:
    text = unicodedata.normalize("NFKD", value or "")
    return "".join(ch for ch in text if not unicodedata.combining(ch))


def _slug_word(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "", _ascii(value)).lower()


def resolve_template(template: str | None = None) -> str:
    """The template to use: argument, then PAPERMEMORY_KEY_TEMPLATE, then the default."""
    chosen = (template or os.environ.get("PAPERMEMORY_KEY_TEMPLATE") or DEFAULT_TEMPLATE).strip()
    validate_template(chosen)
    return chosen


def validate_template(template: str) -> None:
    if not template.strip():
        raise TemplateError("key template is empty")
    unknown = [t for t in _TOKEN.findall(template) if t not in TOKENS]
    if unknown:
        raise TemplateError(f"unknown key template token(s) {unknown}; use {', '.join(TOKENS)}")
    leftover = _TOKEN.sub("", template)
    if re.search(r"[{}]", leftover):
        raise TemplateError("unbalanced braces in key template")
    if _SAFE.search(leftover):
        raise TemplateError("key template literals may only use letters, digits and _ - : .")


def clean_key(value: str) -> str:
    key = _SAFE.sub("", _ascii(value))
    key = key.strip("-_:.")
    if not key:
        return ""
    key = key[:KEY_MAX]
    return f"ref{key}" if key[0].isdigit() else key


def _family(csl: dict[str, Any]) -> str:
    people = csl.get("author") or csl.get("editor") or []
    first = people[0] if people else {}
    return _slug_word(first.get("family") or first.get("literal") or "")


def _year(csl: dict[str, Any]) -> str:
    parts = (csl.get("issued") or {}).get("date-parts") or []
    return str(parts[0][0]) if parts and parts[0] else ""


def _titleword(csl: dict[str, Any]) -> str:
    words = [w for w in (_slug_word(t) for t in str(csl.get("title") or "").split()) if w]
    return next((w for w in words if len(w) > 2 and w not in _STOP), words[0] if words else "")


def _token_values(csl: dict[str, Any], extra: dict[str, Any]) -> dict[str, str]:
    return {
        "family": _family(csl) or "anon",
        "year": _year(csl) or "nd",
        "titleword": _titleword(csl) or "untitled",
        "doi": re.sub(r"[^a-z0-9]+", "", str(csl.get("DOI") or "").lower()),
        "arxiv": re.sub(r"[^a-z0-9]+", "", str(extra.get("arxiv_id") or "").lower()),
    }


def make_key(csl: dict[str, Any], extra: dict[str, Any] | None = None, template: str | None = None) -> str:
    """Render a key for a record. Deterministic: same record and template, same key."""
    tpl = resolve_template(template)
    values = _token_values(csl, extra or {})
    rendered = _TOKEN.sub(lambda m: values[m.group(1)], tpl)
    if tpl == DEFAULT_TEMPLATE:
        rendered = rendered[:DEFAULT_CUT]
    key = clean_key(rendered)
    # A record with neither author nor year gives a key like "anonndword" that
    # identifies nothing; prefer a DOI or arXiv id when there is one.
    weak = values["family"] == "anon" and values["year"] == "nd" and ("{family}" in tpl or "{year}" in tpl)
    if weak or not key:
        for fallback in (values["doi"], values["arxiv"]):
            candidate = clean_key(fallback)
            if candidate:
                return candidate
    if not key:
        return clean_key(_slug_word(str(csl.get("title") or ""))[:40]) or "untitled"
    return key


def usable_source_key(key: str | None) -> bool:
    """A key from a source file is kept as written when it is a valid cite key.

    Purely numeric ids (common in publisher RIS exports) are not citation keys.
    """
    return bool(key) and bool(_USABLE_SOURCE_KEY.match(key))


def key_problems(key: str) -> list[str]:
    """Reasons ``key`` is unsafe to use as a BibTeX/BibLaTeX citation key."""
    problems: list[str] = []
    if not key:
        return ["empty"]
    if re.search(r"\s", key):
        problems.append("whitespace")
    if "," in key:
        problems.append("comma")
    if re.search(r"[{}()\"#%'~\\=@]", key):
        problems.append("reserved-character")
    if any(ord(ch) > 127 for ch in key):
        problems.append("non-ascii")
    if len(key) > KEY_MAX:
        problems.append("too-long")
    return problems
