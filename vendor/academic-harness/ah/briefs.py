"""Briefs: what a unit must do before the prose exists (design 8.2), checked against the prose once it does.

A brief names the claims a unit makes, the facts and sources behind them, the hedging level, what it must not do, and
its length. Code checks the written text against it. The author approves briefs, not prose: an approved brief raises
its findings to major; a draft brief only warns.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from .claims import extract_claims, plain_claim
from .context import Context, unit_ref
from .project import Project
from .tex.scan import cites as scan_cites
from .tex.text import RE_FACT, word_count

LEXICONS = {
    "causal": r"\b(because|due to|leads? to|led to|causes?|caused|results? in|resulted in|driven by|attributable|explains?|originat\w+|stems? from|mutually reinforcing)\b",
    "recommendation": r"\b(should|must|ought to|recommend\w*|needs? to|it is essential|we urge|are needed|is needed)\b",
    "superlative": r"\b(always|never|clearly|obviously|undoubtedly|unprecedented|the first to|proves?|proved|proven|conclusively)\b",
    "strong-verb": r"\b(proves?|proved|demonstrates?|demonstrated|establishes?|established|confirms?|confirmed)\b",
}
HEDGES = r"\b(may|might|could|suggests?|appears?|seems?|likely|possibly|perhaps|consistent with|tends? to|indicates?)\b"
ALIASES = {"causal language": "causal", "recommendations": "recommendation", "recommendation": "recommendation", "superlatives": "superlative"}


@dataclass
class Brief:
    id: str
    path: Path
    data: dict

    @property
    def approved(self) -> bool:
        return self.data.get("status") == "approved"


def briefs_dir(p: Project) -> Path:
    return p.root / p.cfg["briefs"]


def load_briefs(p: Project) -> list[Brief]:
    d = briefs_dir(p)
    out = []
    for f in sorted(d.glob("*.yaml")) if d.exists() else []:
        data = yaml.safe_load(f.read_text()) or {}
        out.append(Brief(data.get("id") or f.stem, f, data))
    return out


def get_brief(p: Project, bid: str) -> Brief | None:
    return next((b for b in load_briefs(p) if b.id == bid), None)


def new_brief(p: Project, data: dict) -> Brief:
    """Create a DRAFT brief. Approval is the author's act (`ah brief approve`)."""
    bid = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(data.get("id") or "")).strip("-")
    if not bid:
        raise ValueError("a brief needs an id")
    if not (data.get("unit") or data.get("file")):
        raise ValueError("a brief needs a target: `unit` (an anchor id) or `file`")
    d = briefs_dir(p)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{bid}.yaml"
    if path.exists():
        raise ValueError(f"brief '{bid}' already exists")
    data = {**data, "id": bid, "status": "draft"}
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
    return Brief(bid, path, data)


def approve(p: Project, bid: str) -> Brief:
    b = get_brief(p, bid)
    if b is None:
        raise ValueError(f"no brief '{bid}'")
    b.data["status"] = "approved"
    b.path.write_text(yaml.safe_dump(b.data, sort_keys=False, allow_unicode=True))
    return b


def target_units(ctx: Context, b: Brief) -> list:
    t = b.data.get("unit")
    if t:
        return [u for u in ctx.units if unit_ref(u) == t]
    f = str(b.data.get("file", "")).lstrip("./")
    return [u for u in ctx.units if u.file == f or u.file.endswith("/" + f) or f.endswith("/" + u.file)]


def target_text(ctx: Context, units: list) -> str:
    return " ".join(plain_claim(u.raw, ctx) for u in units if u.kind == "para")


def lexicon(p: Project, name: str) -> re.Pattern | None:
    key = ALIASES.get(name, name)
    pat = (p.cfg.get("lexicons") or {}).get(key) or LEXICONS.get(key)
    return re.compile(pat, re.I) if pat else None


def check_brief(ctx: Context, b: Brief) -> list[dict]:
    """Findings as dicts: {check, level, key, message, ref}. The T5 tier turns them into Findings."""
    p, d, out = ctx.project, b.data, []
    sev = "major" if b.approved else "minor"
    units = target_units(ctx, b)
    tgt = d.get("unit") or d.get("file")
    ref = unit_ref(units[0]) if units else None

    def add(check, level, key, msg):
        out.append({"check": check, "level": level, "key": f"{b.id}:{key}", "message": f"[brief {b.id}] {msg}", "ref": ref,
                    "file": units[0].file if units else None})

    if not units:
        add("BRF-06", "info", "not-written", f"nothing written yet for {tgt}")
        return out
    raw = "\n".join(u.raw for u in units)
    text = target_text(ctx, units)
    cites = {k for k, _ in scan_cites(raw)}
    facts_used = {k.strip() for k in RE_FACT.findall(raw)}
    planned_cites: set[str] = set(d.get("extra_cites") or [])
    for c in d.get("claims") or []:
        cid = c.get("id", "?")
        for ev in c.get("evidence") or []:
            key = str(ev).split("#")[0]
            planned_cites.add(key)
            if key not in cites:
                add("BRF-01", sev, f"{cid}:ev:{key}", f"claim {cid} should cite {key}, which the text does not")
            if key not in ctx.bib:
                add("BRF-05", "major", f"{cid}:bib:{key}", f"claim {cid} names evidence '{key}', which is not in the bibliography")
        for fr in c.get("facts") or []:
            fid = str(fr).split(".")[0]
            if fid not in ctx.facts.facts:
                add("BRF-05", "major", f"{cid}:fact:{fr}", f"claim {cid} names fact '{fr}', which does not exist")
            else:
                dv = ctx.facts.facts[fid].default_variant()
                norm = lambda k: k if "." in k else f"{k}.{ctx.facts.facts[k].default_variant()}" if k in ctx.facts.facts else k
                want = fr if "." in str(fr) else f"{fr}.{dv}"
                if want not in {norm(k) for k in facts_used}:
                    add("BRF-01", sev, f"{cid}:fact:{fr}", f"claim {cid} should state fact {fr} (as \\fact{{{fr}}}); the text does not")
    lo_hi = (d.get("length") or {}).get("words")
    if lo_hi:
        n = word_count(text)
        if not (lo_hi[0] <= n <= lo_hi[1]):
            add("BRF-02", "minor", "length", f"{n} words; the brief asks for {lo_hi[0]} to {lo_hi[1]}")
    for term in d.get("terms") or []:
        if term.lower() not in text.lower():
            add("BRF-03", "minor", f"term:{term}", f"the brief asks for the term \"{term}\"; the text does not use it")
    musts = list(d.get("must_not") or [])
    hedging = d.get("hedging")
    for name in musts:
        rx = lexicon(p, name)
        m = rx.search(text) if rx else None
        if m:
            add("STY-01", "minor", f"must_not:{name}:{m.group(0).lower()}", f"must not use {name}: \"{m.group(0)}\"")
    if hedging == "descriptive":
        m = lexicon(p, "strong-verb").search(text)
        if m:
            add("STY-01", "minor", f"descriptive:{m.group(0).lower()}", f"descriptive hedging: \"{m.group(0)}\" claims more than a description")
    if hedging == "tentative" and word_count(text) >= 40 and not re.search(HEDGES, text, re.I):
        add("STY-01", "minor", "tentative:no-hedge", "tentative hedging asked for, but no hedge word appears")
    for k in sorted(cites - planned_cites):
        add("BRF-04", "minor", f"unplanned:{k}", f"cites {k}, which no claim in the brief plans for")
    return out


def pack_query(b: Brief, claim: dict) -> str:
    """Search string for one planned claim: its text, the brief's purpose, and required terms."""
    parts = [claim.get("text") or "", b.data.get("purpose") or ""]
    parts.extend(b.data.get("terms") or [])
    parts.extend(claim.get("terms") or [])
    return " ".join(str(p) for p in parts if p).strip()


def pack(ctx: Context, b: Brief | None, target: str | None = None, per_claim: int = 3) -> str:
    """The evidence pack (design 8.1 step 3): only what the writer needs for this unit."""
    from .order import heading_of, neighbours, summary
    from .sources.index import Index, snippet
    from .sources.registry import doi_index, load_registry, resolve_all, source_map
    p = ctx.project
    lines = []
    units = target_units(ctx, b) if b else [u for u in ctx.units if unit_ref(u) == target]
    if b:
        lines += [f"# Brief {b.id} ({b.data.get('status', 'draft')})", yaml.safe_dump({k: v for k, v in b.data.items() if k not in ("id", "status")}, sort_keys=False, allow_unicode=True)]
    if units:
        u = units[0]
        prev, nxt = neighbours(ctx, unit_ref(u))
        lines.append(f"## Where it sits\nSection: {heading_of(ctx, u) or '(none)'}   file: {u.file}")
        if prev:
            lines.append(f"Before: {summary(prev, ctx)}")
        if nxt:
            lines.append(f"After:  {summary(nxt, ctx)}")
        lines.append("## Current text\n" + target_text(ctx, units)[:1800])
    elif b:
        tgt = b.data.get("file")
        where = (p.tex_root / str(tgt)).relative_to(p.root).as_posix() if tgt else None
        lines.append("## Current text\n(nothing written yet)")
        if where:
            lines.append(f"Write the new file at {where} (project-relative; the brief's `file` is relative to the TeX root), and \\input it from its section's index.")
    if b:
        need_facts = [str(f) for c in b.data.get("claims") or [] for f in c.get("facts") or []]
        if need_facts:
            lines.append("## Facts to use (write \\fact{id.variant}, never the number)")
            for fr in dict.fromkeys(need_facts):
                try:
                    f, v = ctx.facts.get(fr)
                    lines.append(f"- {fr} = {f.variants[v]['plain']}  (variants: {', '.join(sorted(f.variants))})")
                except Exception as e:
                    lines.append(f"- {fr}: {e}")
        reg, smap, dois = load_registry(p), source_map(p), doi_index(p)
        idx = Index(p)
        lines.append("## Evidence (passages with locators; state only what they say, with their conditions)")
        for c in b.data.get("claims") or []:
            for ev in c.get("evidence") or []:
                key = str(ev).split("#")[0]
                paths = resolve_all(p, key, reg, smap, ctx.bib, dois)
                if not paths:
                    lines.append(f"- claim {c.get('id')}: {key}: NO SOURCE TEXT; do not state a finding about it.")
                    continue
                idx.ensure(key, paths)
                q = pack_query(b, c)
                for ps in idx.search([key], q, per_claim):
                    lines.append(f"- claim {c.get('id')} [{ps.locator}] {snippet(ps.text, q)}")
        idx.close()
    return "\n".join(lines) + "\n"
