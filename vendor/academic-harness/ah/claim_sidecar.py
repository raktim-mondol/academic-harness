"""Claim sidecars and bindings (design 6.3, 8.2): what each cited clause rests on.

`claims/<unit>.yaml` holds one record per cited clause. A record can be bound to a source passage (a locator plus the
quote it held when bound) or to a fact (a literal number tied to a fact variant), and an author can mark it verified.
If the clause text changes, the record becomes `stale`: its bindings stay but no longer count until re-confirmed.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

from .claims import Claim, extract_claims
from .context import Context
from .project import Project
from .sources.registry import doi_index, load_registry, resolve_all, source_map
from .util import sha1, sha256_file
from .verifier.verify import find_quote, norm_text

STATUSES = ("unbound", "bound", "verified", "stale")


def sidecar_path(p: Project, uid: str) -> Path:
    return p.root / p.cfg["claims_dir"] / f"{uid}.yaml"


def load_sidecar(p: Project, uid: str) -> dict:
    f = sidecar_path(p, uid)
    return (yaml.safe_load(f.read_text()) or {}) if f.exists() else {}


def load_all(p: Project) -> dict[str, dict]:
    d = p.root / p.cfg["claims_dir"]
    out = {}
    for f in sorted(d.glob("*.yaml")) if d.exists() else []:
        data = yaml.safe_load(f.read_text()) or {}
        out[data.get("unit") or f.stem] = data
    return out


def _save(p: Project, uid: str, data: dict) -> None:
    f = sidecar_path(p, uid)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def clause_hash(text: str) -> str:
    return sha1(norm_text(text), 10)


def sync(ctx: Context, write: bool = True) -> dict:
    """Reconcile sidecars with the text. A clause is matched by id, else by position and citations (it was edited)."""
    p = ctx.project
    by_unit: dict[str, list[Claim]] = {}
    for c in extract_claims(ctx, granularity="cite"):
        by_unit.setdefault(c.unit, []).append(c)
    uhash = {(u.uid or f"{u.file}#{u.hash}"): u.hash for u in ctx.units}
    stats = {"units": 0, "new": 0, "stale": 0, "unchanged": 0, "dropped": 0}
    for uid, claims in by_unit.items():
        if "#" in uid:              # un-anchored unit: sidecars need a stable id
            continue
        old = load_sidecar(p, uid)
        olds = old.get("claims") or []
        by_id = {c["id"]: c for c in olds}
        used: set[str] = set()
        new = []
        for i, c in enumerate(claims):
            rec = by_id.get(c.id)
            if rec is None:         # edited: same position and same cited keys
                for cand in olds:
                    if cand["id"] not in used and cand.get("index") == i and sorted(cand.get("cites", [])) == sorted(c.cites):
                        rec = cand
                        break
            if rec is None:
                new.append({"id": c.id, "index": i, "clause": c.sentence, "clause_hash": clause_hash(c.sentence), "cites": c.cites,
                            "numbers": c.numbers, "kind": c.kind, "status": "unbound", "bindings": []})
                stats["new"] += 1
                continue
            used.add(rec["id"])
            changed = rec.get("clause_hash") != clause_hash(c.sentence)
            rec = dict(rec, id=c.id, index=i, clause=c.sentence, cites=c.cites, numbers=c.numbers, kind=c.kind)
            if changed:
                if rec.get("bindings") or rec.get("status") in ("bound", "verified"):
                    rec["status"] = "stale"
                    rec["stale_since"] = clause_hash(c.sentence)
                    stats["stale"] += 1
                rec["clause_hash"] = clause_hash(c.sentence)
                if rec.get("verified_by"):
                    rec.pop("verified_by", None)       # a verification does not survive an edit
            else:
                stats["unchanged"] += 1
            new.append(rec)
        stats["dropped"] += len([o for o in olds if o["id"] not in used and o["id"] not in {c.id for c in claims}
                                 and not any(n["id"] == o["id"] for n in new)])
        stats["units"] += 1
        if write:
            _save(p, uid, {"unit": uid, "hash": uhash.get(uid), "claims": new})
    return stats


def find_claim(p: Project, ref: str) -> tuple[str, dict, dict]:
    """(unit id, sidecar, claim record) for a claim id or unique prefix."""
    hits = [(uid, sc, c) for uid, sc in load_all(p).items() for c in sc.get("claims", []) if c["id"].startswith(ref)]
    if len(hits) != 1:
        raise ValueError(f"{len(hits)} claims match '{ref}'")
    return hits[0]


def bind_passage(ctx: Context, ref: str, source: str, start: int = 0, end: int = 0, file_index: int = 0, *,
                 char_start: int | None = None, char_end: int | None = None,
                 quote_sha256: str | None = None, raw_sha256: str | None = None,
                 memory_claim_id: str | None = None, header_span_json: str | None = None) -> dict:
    """Bind a claim to a source passage: lines (start-end) or exact char offsets.

    Char spans are authoritative when supplied (memory ledger); the verbatim quote is
    re-sliced from the stored file and line numbers are derived. The binding keeps the
    full source sha and quote sha so verdict provenance can be checked later."""
    p = ctx.project
    uid, sc, rec = find_claim(p, ref)
    paths = resolve_all(p, source, load_registry(p), source_map(p), ctx.bib, doi_index(p))
    if not paths:
        raise ValueError(f"no source text for '{source}'")
    path = paths[min(file_index, len(paths) - 1)]
    text_all = path.read_text(errors="replace")
    if char_start is not None and char_end is not None:
        if not (0 <= char_start < char_end <= len(text_all)):
            raise ValueError(f"char span {char_start}-{char_end} is outside {path.name} ({len(text_all)} chars)")
        quote_raw = text_all[char_start:char_end]
        start = text_all[:char_start].count("\n") + 1
        end = text_all[:char_end].count("\n") + 1
    else:
        lines = text_all.split("\n")
        if not (1 <= start <= end <= len(lines)):
            raise ValueError(f"lines {start}-{end} are outside {path.name} ({len(lines)} lines)")
        quote_raw = " ".join(lines[start - 1:end])
        char_start = len("\n".join(lines[: start - 1])) + (1 if start > 1 else 0)
        char_end = char_start + len(quote_raw)
    quote = re.sub(r"\s+", " ", quote_raw).strip()
    if len(quote) < 15:
        raise ValueError("that range holds too little text to be a passage")
    import hashlib as _hashlib
    b = {"type": "passage", "source": source, "file": str(path.relative_to(p.root)) if path.is_relative_to(p.root) else str(path),
         "start": start, "end": end, "sha": sha256_file(path)[:16], "quote": quote[:600], "quote_hash": clause_hash(quote[:600]),
         "raw_sha256": raw_sha256 or sha256_file(path),
         "quote_sha256": quote_sha256 or _hashlib.sha256(quote_raw.encode("utf-8")).hexdigest(),
         "char_start": char_start, "char_end": char_end}
    if header_span_json:
        b["header_span_json"] = header_span_json
    if memory_claim_id:
        b["memory_claim_id"] = memory_claim_id
    rec["bindings"] = [x for x in rec.get("bindings", []) if not (x.get("type") == "passage" and x.get("source") == source and x.get("start") == start)] + [b]
    if rec.get("status") in ("unbound", "stale"):
        rec["status"] = "bound"
        rec.pop("stale_since", None)
    _save(p, uid, sc)
    return b


def bind_fact(ctx: Context, ref: str, token: str, fact: str) -> dict:
    p = ctx.project
    uid, sc, rec = find_claim(p, ref)
    ctx.facts.get(fact)                                 # raises if the fact or variant does not exist
    b = {"type": "fact", "token": token, "fact": fact}
    rec["bindings"] = [x for x in rec.get("bindings", []) if not (x.get("type") == "fact" and x.get("token") == token)] + [b]
    if rec.get("status") in ("unbound", "stale"):
        rec["status"] = "bound"
        rec.pop("stale_since", None)
    _save(p, uid, sc)
    return b


def verify(p: Project, ref: str, by: str) -> dict:
    """The author confirms the clause is supported as written. Human-only (the CLI refuses without confirmation)."""
    uid, sc, rec = find_claim(p, ref)
    if rec.get("status") == "stale":
        raise ValueError("the clause changed after it was bound; re-bind it first")
    rec["status"] = "verified"
    rec["verified_by"] = by
    _save(p, uid, sc)
    return rec


def sidecar_fact_bindings(p: Project) -> list[dict]:
    """Fact bindings from sidecars, in the same shape as bindings.yaml, so NUM-001/NUM-003 treat them alike."""
    out = []
    for uid, sc in load_all(p).items():
        for c in sc.get("claims", []):
            if c.get("status") == "stale":
                continue
            for b in c.get("bindings", []):
                if b.get("type") == "fact":
                    out.append({"unit": uid, "token": b["token"], "fact": b["fact"]})
    return out


def broken_bindings(ctx: Context) -> list[tuple[str, dict, dict, str]]:
    """(unit, claim, binding, why) for passage bindings whose quote can no longer be found in the source text."""
    p = ctx.project
    reg, smap, dois = load_registry(p), source_map(p), doi_index(p)
    out = []
    for uid, sc in load_all(p).items():
        for c in sc.get("claims", []):
            for b in c.get("bindings", []):
                if b.get("type") != "passage":
                    continue
                paths = resolve_all(p, b["source"], reg, smap, ctx.bib, dois)
                if not paths:
                    out.append((uid, c, b, "the source has no text any more"))
                    continue
                from .sources.index import Passage
                found = any(find_quote(b["quote"][:300], [Passage(b["source"], 1, 1, path.read_text(errors="replace"))]) for path in paths)
                if not found:
                    out.append((uid, c, b, "the quoted passage is no longer in the source text"))
    return out
