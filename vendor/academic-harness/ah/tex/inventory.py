"""Inventory of numbers, citations, references and labels per unit (design 6.2).

Number classes (design 4.4, Phase 1 subset):
  fact       written as \\fact{...}; not a literal, so it cannot drift
  trivial-*  year, date, label such as 'Table 3', or 0/1/2
  bound      a literal listed in bindings.yaml against a fact (checked by NUM-003)
  cited      a literal in a sentence that carries a citation (candidate evidence-bound number)
  literal    any other literal number: a candidate derived fact (NUM-001)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .scan import cites, labels, markup_view, refs
from .text import (RE_CITE, RE_FACT, RE_LABEL, RE_REF, sentences)
from .units import Unit

MONTHS = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
RE_NUM = re.compile(r"(?<![\w\\.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s*\\?%)?")
YEAR = re.compile(r"^(19|20)\d{2}$")
LABEL_CTX = re.compile(r"(Section|Table|Figure|Fig|Appendix|Eq|item|Item|step|Step|Stage|Phase|Round|round|PRISMA|CAMELYON|v)\s*$")


@dataclass
class Num:
    text: str            # numeric part as written, e.g. '41.9'
    value: float
    pct: bool
    cls: str
    sent: int
    ctx: str             # short surrounding snippet


@dataclass
class UnitInv:
    unit: Unit
    sentences: list[str]
    nums: list[Num] = field(default_factory=list)
    cites: list[tuple[str, int]] = field(default_factory=list)   # (key, sentence index)
    refs: list[str] = field(default_factory=list)
    labels: list[str] = field(default_factory=list)
    facts_used: list[str] = field(default_factory=list)


def _clean_for_numbers(s: str) -> str:
    s = RE_CITE.sub(" ", s)
    s = RE_REF.sub(" ", s)
    s = RE_LABEL.sub(" ", s)
    s = RE_FACT.sub(" ", s)
    s = re.sub(r"\\(?:url|href|doi)\{[^}]*\}", " ", s)
    s = s.replace("{,}", ",").replace("\\,", "")
    s = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?", lambda m: " " if m.group(0).rstrip("*") not in ("\\%",) else m.group(0), s)
    s = s.replace("~", " ")
    s = re.sub(r"[{}$]", "", s)
    return s


def classify(tok: str, pct: bool, before: str, after: str) -> str:
    if YEAR.match(tok) and not pct:
        return "trivial-year"
    if LABEL_CTX.search(before):
        return "trivial-label"
    if re.match(r"\s*" + MONTHS, after) or re.search(MONTHS + r"\s*$", before):
        return "trivial-date"
    if pct and tok in ("90", "95", "99") and re.match(r"\s*(?:CI|confidence|credible|interval)", after):
        return "trivial-stat"
    if re.search(r"\b[pP]\s*[<>=]\s*$", before):
        return "trivial-stat"
    if tok in ("0", "1", "2") and not pct:
        return "trivial-small"
    return "literal"


def extract_numbers(sentence: str, has_cite: bool, sent_idx: int) -> list[Num]:
    v = _clean_for_numbers(sentence)
    out = []
    for m in RE_NUM.finditer(v):
        tok = m.group(1).replace(",", "")
        pct = bool(m.group(2))
        before, after = v[max(0, m.start() - 16): m.start()], v[m.end(): m.end() + 16]
        cls = classify(m.group(1), pct, before, after)
        if cls == "literal" and has_cite:
            cls = "cited"
        out.append(Num(tok, float(tok), pct, cls, sent_idx, v[max(0, m.start() - 24): m.end() + 24].strip()))
    return out


def inventory_unit(u: Unit, table: dict | None = None) -> UnitInv:
    body = markup_view(u.raw)       # what TeX executes: a number or \\cite inside a code listing or \\verb is not a claim
    inv = UnitInv(u, [])
    inv.sentences = sentences(body)
    for i, s in enumerate(inv.sentences):
        has_cite = bool(RE_CITE.search(s))
        inv.cites += [(k, i) for k, _ in cites(s, table)]
        inv.nums += extract_numbers(s, has_cite, i)
    inv.refs = [k for k, _ in refs(body, table)]
    inv.labels = [k for k, _ in labels(body, table)]
    inv.facts_used = [m.group(1).strip() for m in RE_FACT.finditer(body)]
    return inv


def inventory(units: list[Unit], table: dict | None = None) -> list[UnitInv]:
    return [inventory_unit(u, table) for u in units]
