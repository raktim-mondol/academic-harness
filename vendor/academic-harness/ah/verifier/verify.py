"""Verify one claim against retrieved passages (design 6.4).

Rules that make a model verdict usable:
  * the quote must occur verbatim in a retrieved passage (checked here, not trusted);
  * a SUPPORTED verdict is downgraded if a number in the claim is absent from the quoted passage;
  * NOT_SUPPORTED / NOT_IN_SOURCE need a second, independently ordered call to agree, else CONTESTED;
  * a reply that cannot be parsed or whose quote is not verbatim is an error, never a pass.
Verdicts are cached on (prompt version, model, claim, passages), so an unchanged claim is not re-asked.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from dataclasses import dataclass, field

from ..project import Project
from ..sources.index import Passage
from ..util import sha1
from .backends import Backend
from .prompt import PROMPT_VERSION, build_prompt, parse_response


def norm_text(s: str) -> str:
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = re.sub(r"[‐-―−]", "-", s)
    s = re.sub(r"[*_`\\]", "", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def find_quote(quote: str, passages: list[Passage]) -> Passage | None:
    parts = [norm_text(x) for x in re.split(r"…|\.\.\.", quote) if len(norm_text(x)) >= 12]
    if not parts:
        return None
    for p in passages:
        t = norm_text(p.text)
        if all(x in t for x in parts):
            return p
    return None


def number_variants(tok: str) -> set[str]:
    t = tok.rstrip("%")
    v = {t}
    if "." in t:
        v.add(t.rstrip("0").rstrip("."))
    if tok.endswith("%"):
        try:
            f = float(t) / 100
            v |= {f"{f:.2f}".rstrip("0").rstrip("."), f"{f:.3f}".rstrip("0").rstrip("."), f"{f:.4f}".rstrip("0").rstrip(".")}
        except ValueError:
            pass
    return {x for x in v if x}


def number_found(tok: str, have: set[str]) -> bool:
    """A claimed number is found if the source has it exactly, in a percent/fraction form, or at higher precision
    (the claim rounded half-up or truncated it: 0.913 for 0.9126, 0.905 for 0.9045, 4.9 for 4.94, 73 for 73.2).
    Decimal arithmetic, not floats: float rounding turns 0.9045 into 0.904."""
    from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal, InvalidOperation
    if number_variants(tok) & have:
        return True
    t = tok.rstrip("%")
    try:
        x = Decimal(t)
    except InvalidOperation:
        return False
    d = len(t.split(".")[1]) if "." in t else 0
    q = Decimal(1).scaleb(-d)
    for y_s in have:
        if "." not in y_s or len(y_s.split(".")[1]) <= d:
            continue
        try:
            y = Decimal(y_s)
        except InvalidOperation:
            continue
        if y.quantize(q, rounding=ROUND_HALF_UP) == x or y.quantize(q, rounding=ROUND_DOWN) == x:
            return True
    return False


def numbers_in(text: str) -> set[str]:
    return set(re.findall(r"\d+(?:\.\d+)?", text.replace(",", "")))


@dataclass
class Result:
    verdict: str                    # SUPPORTED | PARTIAL | NOT_SUPPORTED | NOT_IN_SOURCE | CONTESTED | ERROR
    quote: str = ""
    locator: str = ""
    mismatch: list[str] = field(default_factory=list)
    note: str = ""
    error: str | None = None
    votes: list[str] = field(default_factory=list)
    cached: bool = False
    tokens_in: int = 0
    tokens_out: int = 0
    calls: int = 0

    def to_dict(self) -> dict:
        return self.__dict__.copy()


class Cache:
    def __init__(self, project: Project, readonly: bool = False):
        path = project.state_dir / "verdicts.sqlite"
        self.db = None
        if readonly:
            if path.is_file():
                self.db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
        else:
            project.state_dir.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(path, check_same_thread=False)
            self.db.execute("CREATE TABLE IF NOT EXISTS v (k TEXT PRIMARY KEY, body TEXT)")
        self.lock = threading.Lock()

    def get(self, k: str):
        if self.db is None:
            return None
        with self.lock:
            r = self.db.execute("SELECT body FROM v WHERE k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else None

    def put(self, k: str, body: dict):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO v VALUES (?,?)", (k, json.dumps(body)))
            self.db.commit()

    def close(self):
        if self.db is not None:
            self.db.close()


def _one(claim_text: str, claim_numbers: list[str], passages: list[Passage], backend: Backend, cache: Cache | None,
         variant: int) -> Result:
    prompt = build_prompt(claim_text, passages, reverse=bool(variant))
    key = sha1("|".join(["evidence-v2", PROMPT_VERSION, backend.identity, str(variant), claim_text, *[p.text for p in passages]]))
    if cache is not None:
        hit = cache.get(key)
        if hit:
            r = Result(**hit)
            r.cached, r.calls = True, 0
            r.tokens_in = r.tokens_out = 0
            return r
    usage_in = usage_out = calls = 0
    parsed, bad_quote = None, False
    for attempt in range(2):
        comp = backend.complete(prompt if attempt == 0 else prompt + "\n\nYour previous quote was not copied exactly from a passage. Copy it exactly.")
        calls += 1
        usage_in += comp.usage.get("input", 0)
        usage_out += comp.usage.get("output", 0)
        if comp.error:
            return Result("ERROR", error=comp.error, calls=calls, tokens_in=usage_in, tokens_out=usage_out)
        parsed = parse_response(comp.text)
        if parsed is None:
            continue
        if parsed["verdict"] == "NOT_IN_SOURCE" and not parsed["quote"]:
            break
        if find_quote(parsed["quote"], passages):
            break
        bad_quote, parsed_bad = True, parsed
        parsed = None
    if parsed is None:
        why = "quote-not-verbatim" if bad_quote else "unparseable-reply"
        return Result("ERROR", error=why, calls=calls, tokens_in=usage_in, tokens_out=usage_out)
    src = find_quote(parsed["quote"], passages) if parsed["quote"] else None
    res = Result(parsed["verdict"], parsed["quote"], src.locator if src else "", parsed["mismatch"], str(parsed.get("note", ""))[:300],
                 calls=calls, tokens_in=usage_in, tokens_out=usage_out)
    if res.verdict == "SUPPORTED" and src is not None:        # the model cannot wave numbers through
        have = numbers_in(src.text)
        missing = [n for n in claim_numbers if not number_found(n, have)]
        if missing:
            res.verdict, res.note = "PARTIAL", f"{res.note} [downgraded: {', '.join(missing)} not in the quoted passage]".strip()
            res.mismatch = sorted(set(res.mismatch) | {"value"})
    if cache is not None:
        cache.put(key, res.to_dict())
    return res


def verify(claim_text: str, claim_numbers: list[str], passages: list[Passage], backend: Backend, cache: Cache | None = None,
           confirm: bool = True) -> Result:
    if not passages:
        return Result("NOT_IN_SOURCE", note="no passage in the cited source matches the claim's terms")
    first = _one(claim_text, claim_numbers, passages, backend, cache, 0)
    out = first
    if confirm and first.verdict in ("NOT_SUPPORTED", "NOT_IN_SOURCE"):
        second = _one(claim_text, claim_numbers, passages, backend, cache, 1)
        out = Result(first.verdict, first.quote, first.locator, first.mismatch, first.note, first.error, [first.verdict, second.verdict],
                     first.cached and second.cached, first.tokens_in + second.tokens_in, first.tokens_out + second.tokens_out,
                     first.calls + second.calls)
        if second.verdict != first.verdict:
            out.verdict = "CONTESTED"
            out.note = f"first pass {first.verdict}, second pass {second.verdict}: {second.note}"[:300]
    else:
        out.votes = [first.verdict]
    return out
