from __future__ import annotations

import hashlib
import json
import re
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def fingerprint(*parts: str) -> str:
    blob = "\n".join((p or "").strip().lower() for p in parts)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def loads(value: str | None, default: Any = None) -> Any:
    if not value:
        return default if default is not None else []
    return json.loads(value)


def normalize_title(title: str) -> str:
    text = unicodedata.normalize("NFKC", title or "")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_doi(doi: str | None) -> str | None:
    if not doi:
        return None
    text = doi.strip()
    text = re.sub(r"^https?://(dx\.)?doi\.org/", "", text, flags=re.I)
    text = re.sub(r"^doi:\s*", "", text, flags=re.I)
    text = text.strip().rstrip(".")
    return text.lower() or None


def normalize_arxiv(arxiv_id: str | None) -> str | None:
    if not arxiv_id:
        return None
    text = arxiv_id.strip()
    text = re.sub(r"^https?://arxiv\.org/(abs|pdf)/", "", text, flags=re.I)
    text = re.sub(r"^arxiv:", "", text, flags=re.I)
    text = text.replace(".pdf", "")
    text = re.sub(r"v\d+$", "", text)
    return text.strip() or None


def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")[:80] or "item"


def word_count(text: str) -> int:
    cleaned = re.sub(r"%.*", " ", text or "")
    cleaned = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?", " ", cleaned)
    return len(re.findall(r"[A-Za-z0-9]+", cleaned))


def strip_tex_comments(text: str) -> str:
    return re.sub(r"(?<!\\)%.*", "", text)


def unique(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out
