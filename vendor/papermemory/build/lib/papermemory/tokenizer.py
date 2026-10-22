from __future__ import annotations

import re
import unicodedata


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text or "").lower().split())


def terms(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", normalize(text))


def unique_terms(text: str, cap: int = 12) -> list[str]:
    return list(dict.fromkeys(terms(text)))[:cap]


def fts_match(query: str, cap: int = 12) -> str | None:
    tokens = unique_terms(query, cap)
    if not tokens:
        return None
    quoted = [f'"{token}"' for token in tokens]
    return quoted[0] if len(quoted) == 1 else " OR ".join(quoted)


def overlap(query: str, text: str) -> float:
    query_terms = set(terms(query))
    if not query_terms:
        return 0.0
    return len(query_terms & set(terms(text))) / len(query_terms)
