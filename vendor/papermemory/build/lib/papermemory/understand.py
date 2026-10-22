from __future__ import annotations

import re
from typing import Any

SECTION_PATTERNS = [
    ("abstract", re.compile(r"^\s*(abstract)\b", re.I)),
    ("introduction", re.compile(r"^\s*(\d+[\.\s]+)?introduction\b", re.I)),
    ("related_work", re.compile(r"^\s*(\d+[\.\s]+)?(related work|background|literature review|prior work)\b", re.I)),
    ("methods", re.compile(r"^\s*(\d+[\.\s]+)?(methods?|methodology|materials and methods|approach)\b", re.I)),
    ("results", re.compile(r"^\s*(\d+[\.\s]+)?results?\b", re.I)),
    ("discussion", re.compile(r"^\s*(\d+[\.\s]+)?discussion\b", re.I)),
    ("conclusion", re.compile(r"^\s*(\d+[\.\s]+)?conclusions?\b", re.I)),
    ("limitations", re.compile(r"^\s*(\d+[\.\s]+)?limitations?\b", re.I)),
    ("references", re.compile(r"^\s*(\d+[\.\s]+)?(references|bibliography)\b", re.I)),
]

CLAIM_CUES = re.compile(
    r"\b(we (propose|present|show|demonstrate|find|introduce|report|achieve)|"
    r"this paper|our (results|method|approach|contribution)|"
    r"significantly|outperforms?|state-of-the-art|limitation|future work)\b",
    re.I,
)


def split_sections(text: str) -> list[dict[str, Any]]:
    lines = (text or "").splitlines()
    markers: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or len(stripped) > 80:
            continue
        for name, pattern in SECTION_PATTERNS:
            if pattern.match(stripped):
                markers.append((i, name))
                break
    if not markers:
        return [{"section": "body", "text": text.strip(), "start_line": 0}]
    sections: list[dict[str, Any]] = []
    if markers[0][0] > 0:
        preamble = "\n".join(lines[: markers[0][0]]).strip()
        if preamble:
            sections.append({"section": "front", "text": preamble, "start_line": 0})
    for idx, (start, name) in enumerate(markers):
        end = markers[idx + 1][0] if idx + 1 < len(markers) else len(lines)
        body = "\n".join(lines[start:end]).strip()
        if body:
            sections.append({"section": name, "text": body, "start_line": start})
    return sections


def chunk_text(text: str, *, section: str | None = None, page: int | None = None, size: int = 1200, overlap: int = 150) -> list[dict[str, Any]]:
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return []
    chunks: list[dict[str, Any]] = []
    i = 0
    n = 0
    while i < len(text):
        piece = text[i : i + size]
        chunks.append({"section": section, "page": page, "chunk_index": n, "text": piece})
        n += 1
        if i + size >= len(text):
            break
        i += size - overlap
    return chunks


def extract_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text or "").strip())
    return [p.strip() for p in parts if 40 <= len(p.strip()) <= 400]


def extract_claims(sections: list[dict[str, Any]], limit: int = 12) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for section in sections:
        name = section["section"]
        if name in {"references"}:
            continue
        claim_type = {
            "abstract": "finding",
            "methods": "method",
            "results": "result",
            "limitations": "limitation",
            "conclusion": "finding",
            "introduction": "contribution",
        }.get(name, "finding")
        sentences = extract_sentences(section["text"])
        picked = [s for s in sentences if CLAIM_CUES.search(s)]
        if name in {"abstract", "limitations"} and not picked:
            picked = sentences[:3]
        for sentence in picked[:4]:
            claims.append(
                {
                    "claim_text": sentence,
                    "claim_type": claim_type,
                    "section": name,
                    "evidence_quote": sentence,
                    "status": "extracted",
                    "confidence": 0.4,
                }
            )
            if len(claims) >= limit:
                return claims
    return claims


def understand_text(text: str) -> dict[str, Any]:
    sections = split_sections(text)
    chunks: list[dict[str, Any]] = []
    for section in sections:
        if section["section"] == "references":
            continue
        chunks.extend(chunk_text(section["text"], section=section["section"]))
    abstract = next((s["text"] for s in sections if s["section"] == "abstract"), None)
    return {
        "sections": [{"name": s["section"], "chars": len(s["text"])} for s in sections],
        "chunks": chunks,
        "claims": extract_claims(sections),
        "abstract": abstract[:2000] if abstract else None,
    }
