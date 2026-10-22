from __future__ import annotations

import re
from typing import Any

ROLE_RULES: list[tuple[str, re.Pattern]] = [
    ("abstract", re.compile(r"^(abstract|summary)\b")),
    ("introduction", re.compile(r"^(introduction|overview|motivation)\b")),
    ("background", re.compile(r"^background\b")),
    ("related_work", re.compile(r"^(related work|related literature|prior work|prior art|literature review|state of the art)\b")),
    ("materials", re.compile(r"^materials?\b(?!\s+and\s+methods)")),
    ("method", re.compile(r"^(methods?|methodology|approach|materials and methods|experimental (setup|design)|proposed (method|approach))\b")),
    ("results", re.compile(r"^(results?|experiments?|evaluation|findings|performance)\b")),
    ("analysis", re.compile(r"^(analysis|analyses|ablation|robustness|sensitivity)\b")),
    ("conclusion", re.compile(r"^(conclusions?|concluding remarks|summary and conclusions)\b")),
    ("limitations", re.compile(r"^limitations?\b")),
    ("discussion", re.compile(r"^(discussion|implications|interpretation)\b")),
    ("appendix", re.compile(r"^(appendix|appendices|supplementary|supplemental)\b")),
    ("acknowledgements", re.compile(r"^(acknowledg|funding|credits)\b")),
    ("bibliography", re.compile(r"^(references|bibliography|works cited|literature cited)\b")),
]

NUMBER_PREFIX = re.compile(r"^\s*\d+(?:\.\d+)*\.?\s*")


def _normalize_heading(heading: str) -> str:
    text = NUMBER_PREFIX.sub("", heading or "").strip().lower()
    return re.sub(r"[*_`]", "", text)


def _classify_heading(heading: str) -> tuple[str | None, str | None, int]:
    normalized = _normalize_heading(heading)
    if not normalized:
        return None, None, 0
    secondary = None
    results_hit = re.search(r"\b(results?|experiments?|evaluation|findings|performance)\b", normalized)
    discussion_hit = re.search(r"\b(discussion|implications|interpretation)\b", normalized)
    limitations_hit = re.search(r"\blimitations?\b", normalized)
    background_hit = re.search(r"^background\b", normalized)
    related_hit = re.search(r"\b(related work|prior work|literature review)\b", normalized)
    if results_hit and (discussion_hit or limitations_hit):
        return "results", ("discussion" if discussion_hit else "limitations"), 90
    if discussion_hit and limitations_hit:
        return "discussion", "limitations", 90
    if background_hit and related_hit:
        return "related_work", "background", 85
    for role, pattern in ROLE_RULES:
        if pattern.search(normalized):
            return role, secondary, 85
    return None, None, 0


def classify_sections(text: str, sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for section in sections:
        heading = section.get("heading") or ""
        role, secondary, confidence = _classify_heading(heading)
        if role:
            section["role"] = role
            section["role_secondary"] = secondary
            section["role_confidence"] = confidence
            section["role_source"] = "heading_rule"
        else:
            parent_index = section.get("parent_index")
            parent = sections[parent_index] if parent_index is not None and parent_index < len(sections) else None
            if parent and parent.get("role") and parent.get("role") != "unclassified":
                section["role"] = parent["role"]
                section["role_secondary"] = parent.get("role_secondary")
                section["role_confidence"] = max(0, int(parent.get("role_confidence") or 0) - 10)
                section["role_source"] = "inherited_parent"
            else:
                section["role"] = "unclassified"
                section["role_secondary"] = None
                section["role_confidence"] = 0
                section["role_source"] = "none"
    return sections


def structure_confidence(sections: list[dict[str, Any]]) -> str:
    if not sections:
        return "low"
    with_heading = sum(
        1 for section in sections if (section.get("heading") or section.get("heading_path") or "").strip()
    )
    if with_heading == 0 or len(sections) < 2:
        return "low"
    unclassified = sum(1 for section in sections if section.get("role") == "unclassified")
    if unclassified / max(len(sections), 1) > 0.5:
        return "medium"
    return "high"


def paper_profile(sections: list[dict[str, Any]]) -> dict[str, Any]:
    roles = {section.get("role") for section in sections}
    if {"method", "results"} & roles and "method" in roles and ({"results", "analysis"} & roles):
        return {"profile": "empirical", "confidence": 85}
    if "related_work" in roles and "method" not in roles and not ({"results", "analysis"} & roles):
        return {"profile": "review", "confidence": 70}
    if "method" in roles and not ({"results", "analysis"} & roles):
        return {"profile": "methods", "confidence": 65}
    if "introduction" in roles and "conclusion" in roles and not ({"method", "results"} & roles):
        return {"profile": "position", "confidence": 55}
    if {"discussion", "conclusion"} & roles:
        return {"profile": "theory", "confidence": 45}
    return {"profile": "unknown", "confidence": 20}
