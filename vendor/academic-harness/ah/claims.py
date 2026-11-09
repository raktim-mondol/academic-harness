"""Claim candidates: sentences that cite a source and say something checkable (design 6.3).

Rules, not a model: a claim is a sentence with at least one citation. Its kind decides how it is
checked. Numbers come from the inventory so they follow the same classification as NUM-001.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .context import Context, unit_ref
from .tex.inventory import extract_numbers
from .tex.scan import cite_keys
from .tex.text import RE_CITE, RE_FACT, RE_LABEL, RE_REF
from .util import collapse_ws, sha1

COMPARATIVE = re.compile(r"\b(higher|lower|than|outperform\w*|improv\w*|reduc\w*|increas\w*|decreas\w*|exceed\w*|better|worse|larger|smaller|more|less|fewer|gap|difference)\b", re.I)
CAUSAL = re.compile(r"\b(because|due to|leads? to|led to|causes?|caused|results? in|resulted in|driven by|attributable|explains?|originat\w+|stems? from)\b", re.I)
ATTRIB = re.compile(r"\b(shows?|showed|reports?|reported|finds?|found|demonstrat\w+|reveals?|revealed|observ\w+|identif\w+|notes?|state[sd]?|achiev\w+|obtain\w+|reach\w+)\b", re.I)


@dataclass
class Claim:
    id: str
    unit: str
    file: str
    line: int
    sentence: str            # plain text, citations removed
    cites: list[str]
    numbers: list[str]       # numbers that must be traceable to the cited sources
    kind: str                # numeric-cited | comparative | causal | attributive | other
    sources: list[str] = field(default_factory=list)   # filled by the evidence check


def plain_claim(sentence: str, ctx: Context | None = None) -> str:
    s = RE_CITE.sub(" ", sentence)
    s = RE_REF.sub(" ", s)
    s = RE_LABEL.sub(" ", s)
    if ctx is not None:
        def val(m):
            try:
                return ctx.facts.plain(m.group(1).strip())
            except Exception:
                return ""
        s = RE_FACT.sub(val, s)
    s = s.replace("\\%", "%").replace("{,}", ",").replace("\\,", "").replace("~", " ")
    s = re.sub(r"\\(?:textit|textbf|emph|text|mathrm)\{([^}]*)\}", r"\1", s)
    s = re.sub(r"\\[a-zA-Z]+\*?", " ", s)
    s = re.sub(r"[{}$]", "", s)
    return re.sub(r"\s+([.,;:])", r"\1", collapse_ws(s))


def split_by_cites(sentence: str) -> list[tuple[str, list[str]]]:
    """One clause per citation group: the text since the previous citation up to this one, with only the
    keys of that citation. A sentence that chains several cited findings is otherwise checked against all
    their sources at once, and 'partial' is the only honest answer. A clause too short to carry a claim is
    merged with the next one (and keeps its keys, since they cite the merged text)."""
    out: list[tuple[str, list[str]]] = []
    pos, carry, carry_keys = 0, "", []
    ms = list(RE_CITE.finditer(sentence))
    for i, m in enumerate(ms):
        clause = carry + sentence[pos:m.start()]
        keys = carry_keys + cite_keys(m.group(0))
        pos = m.end()
        words = len(re.findall(r"[A-Za-z]{3,}", re.sub(r"\\[a-zA-Z]+", " ", clause)))
        if words < 5 and i + 1 < len(ms):
            carry, carry_keys = clause + " ", keys
            continue
        out.append((clause, keys))
        carry, carry_keys = "", []
    return out


def extract_claims(ctx: Context, kinds: set[str] | None = None, granularity: str | None = None) -> list[Claim]:
    gran = granularity or (ctx.cfg.get("verifier") or {}).get("granularity", "cite")
    out = []
    for inv in ctx.inv:
        u = inv.unit
        if u.kind != "para":
            continue
        for si, sent in enumerate(inv.sentences):
            pieces: list[tuple[str, list[str]]]
            if gran == "cite":
                pieces = split_by_cites(sent)
            else:
                keys = []
                for m in RE_CITE.finditer(sent):
                    keys += cite_keys(m.group(0))
                pieces = [(sent, keys)] if keys else []
            for pi, (clause, keys) in enumerate(pieces):
                if not keys:
                    continue
                text = plain_claim(clause, ctx)
                nums = [n.text + ("%" if n.pct else "") for n in extract_numbers(clause, True, si)
                        if n.cls == "cited" and (len(n.text.replace(".", "")) >= 2 or "." in n.text)]
                if nums:
                    kind = "numeric-cited"
                elif COMPARATIVE.search(text):
                    kind = "comparative"
                elif CAUSAL.search(text):
                    kind = "causal"
                elif ATTRIB.search(text):
                    kind = "attributive"
                else:
                    kind = "other"
                if kinds and kind not in kinds:
                    continue
                cid = sha1(f"{unit_ref(u)}|{collapse_ws(clause)}|{','.join(keys)}", 12)
                out.append(Claim(cid, unit_ref(u), u.file, u.start, text, list(dict.fromkeys(keys)), nums, kind))
    return out
