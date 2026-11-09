"""T1: numeric. Facts, bindings, reconciliation of percentages, intervals and sums (design 4.4, 6.3)."""
from __future__ import annotations

import re

from ..context import Context, unit_ref
from ..facts.model import wilson
from ..facts.render import diff_lock, read_lock, render_macros, to_lock
from ..tex.text import RE_FACT, strip_comments
from ..util import collapse_ws, sha1
from .base import Finding, make

NUM = r"(\d+(?:\.\d+)?)"
PCT_FRAC = re.compile(NUM + r"\s*\\?%\s*\(\s*(\d+)\s*/\s*(\d+)\s*\)")
FRAC_PCT = re.compile(r"(\d+)\s*/\s*(\d+)\s*\(\s*" + NUM + r"\s*\\?%\s*\)")
RANGE = NUM + r"\s*(?:--|-|–|to)\s*" + NUM
CI_DIRECT = re.compile(r"^\s*\[\s*" + RANGE + r"\s*\]")
CI_LABEL = re.compile(r"^[\s\[\(;,]*(?:\d{2}(?:\.\d)?\s*%\s*)?CI\b\s*[:=]?\s*[\[\(]?\s*" + RANGE)
FRAC_CI_INLINE = re.compile(r"(\d+)\s*/\s*(\d+)\s*[;,]\s*(?:\d{2}(?:\.\d)?\s*%\s*)?CI\b\s*[:=]?\s*" + RANGE)
SUM_EQ = re.compile(r"(\d+(?:\s*\+\s*\d+)+)\s*=\s*(\d+)")


def _plain(s: str, fs=None) -> str:
    """Text as a reader sees it. With `fs`, \\fact{key} is replaced by its value so sums and
    percentages built from facts can be reconciled."""
    s = strip_comments(s)
    if fs is not None:
        def val(m):
            try:
                return fs.plain(m.group(1).strip())
            except Exception:
                return "??"
        s = RE_FACT.sub(val, s)
    s = s.replace("\\%", "%").replace("{,}", "").replace("\\,", "").replace("~", " ").replace("$", "")
    s = re.sub(r"\\[a-zA-Z]+\*?", " ", s)
    s = re.sub(r"[{}]", "", s)
    return collapse_ws(s)


def _dec(tok: str) -> int:
    return len(tok.split(".")[1]) if "." in tok else 0


def _round_ok(actual: float, shown: str) -> bool:
    d = _dec(shown)
    return abs(round(actual, d) - float(shown)) <= 0.5 * 10 ** -d + 1e-9 and \
        abs(actual - float(shown)) <= 0.5 * 10 ** -d + 1e-9


def check_t1(ctx: Context) -> list[Finding]:
    cfg, out = ctx.cfg, []

    def add(*a):
        f = make(cfg, *a)
        if f:
            out.append(f)

    fs = ctx.facts
    ubr = ctx.unit_by_ref()
    inv_by = {unit_ref(i.unit): i for i in ctx.inv}

    # ---- NUM-002: facts build errors and stale macro file ----
    for e in ctx.fact_errors:
        add("NUM-002", None, cfg["facts"], None, f"build:{sha1(e, 8)}", f"fact does not build: {e}")
    macros = ctx.project.macros_file()
    if fs.facts:
        want = render_macros(ctx.project, fs)
        have = macros.read_text() if macros.exists() else None
        if have != want and any(i.facts_used for i in ctx.inv):
            add("NUM-002", None, ctx.project.rel(macros), None, "macros-stale",
                "macro file is missing or does not match facts; run `ah facts build`")

    if any(RE_FACT.search(t) for t in ctx.tex_texts.values()):
        mrel = ctx.project.rel(macros)
        stem = mrel[:-4] if mrel.endswith(".tex") else mrel
        loaded = any(re.search(r"\\(?:input|include)\{(?:\./)?" + re.escape(stem) + r"(?:\.tex)?\}", t) for t in ctx.tex_texts.values())
        if not loaded:
            add("NUM-007", None, mrel, None, "macros-not-input",
                f"\\fact is used but no view loads the macro file; add \\input{{{stem}}} to the preamble of a view")

    lock = read_lock(ctx.project)
    if lock is not None and not ctx.fact_errors:
        d = diff_lock(lock, to_lock(fs))
        drift = sorted(set(d["changed"]) | set(d["added"]) | set(d["removed"]))
        if drift:
            add("NUM-002", None, cfg["facts"], None, "lock-drift",
                f"facts changed since the last `ah facts build`: {', '.join(drift[:8])}; run it (it also sweeps the affected units)")

    # ---- NUM-005: macro keys must resolve; facts never used ----
    used: set[str] = set()
    for rel_, text_ in ctx.tex_texts.items():
        for key in RE_FACT.findall(text_):
            used.add(key.strip().partition(".")[0])
    for i in ctx.inv:
        for key in i.facts_used:
            fid = key.partition(".")[0]
            try:
                fs.get(key)
            except Exception as e:  # unknown id or variant
                add("NUM-005", unit_ref(i.unit), i.unit.file, i.unit.start, f"macro:{key}", f"\\fact{{{key}}}: {e}")
    for b in ctx.bindings:
        used.add(str(b.get("fact", "")).partition(".")[0])
    for m in cfg.get("mirrors", []):
        used.add(str(m.get("fact", "")).partition(".")[0])
    for fid in sorted(set(fs.facts) - used):
        add("NUM-006", None, cfg["facts"], None, f"unused:{fid}", f"fact '{fid}' is defined but never used")

    # ---- NUM-003: bindings (legacy prose with literals) ----
    for b in ctx.bindings:
        uid, tok, ref = b.get("unit"), str(b.get("token", "")), b.get("fact", "")
        u = ubr.get(uid)
        if u is None:
            add("NUM-003", None, None, None, f"nounit:{uid}:{tok}", f"binding refers to missing unit {uid}")
            continue
        try:
            expect = fs.number_text(ref)
        except Exception as e:
            add("NUM-003", uid, u.file, u.start, f"badfact:{tok}:{ref}", f"binding to {ref}: {e}")
            continue
        nums = inv_by[uid].nums
        hits = [n for n in nums if n.text == tok]
        if not hits and tok != expect:
            near = [n.text for n in nums if n.pct == ("%" in fs.plain(ref))][:6]
            add("NUM-003", uid, u.file, u.start, f"bound:{tok}:{ref}",
                f"literal {tok} (bound to {ref}) not found; the fact is {fs.plain(ref)}. Numbers near: {near}")
        elif tok != expect:
            add("NUM-003", uid, u.file, u.start, f"bound:{tok}:{ref}",
                f"literal {tok} differs from fact {ref} = {fs.plain(ref)}")
    bound = {(b.get("unit"), str(b.get("token", ""))) for b in ctx.bindings}

    # ---- NUM-001: unclassified literals in prose ----
    for i in ctx.inv:
        u = i.unit
        if u.kind != "para":
            continue
        for n in i.nums:
            if n.cls == "literal" and (unit_ref(u), n.text) not in bound:
                sent = i.sentences[n.sent] if n.sent < len(i.sentences) else ""
                add("NUM-001", unit_ref(u), u.file, u.start, f"{n.text}{'%' if n.pct else ''}:{sha1(collapse_ws(sent), 6)}",
                    f"literal number {n.text}{'%' if n.pct else ''} is not a \\fact or a bound value: ...{n.ctx}...")

    # ---- NUM-004: reconcile percentage, fraction, interval, sums ----
    for i in ctx.inv:
        u = i.unit
        text = _plain(u.raw, fs)
        for m in PCT_FRAC.finditer(text):
            if _signed(text, m.start()):
                continue            # "+10.4% (1/1000)" is a change with a rate beside it, not a share of a total
            pct_s, a, b = m.group(1), int(m.group(2)), int(m.group(3))
            _recon(add, u, text, m, pct_s, a, b)
        for m in FRAC_PCT.finditer(text):
            a, b, pct_s = int(m.group(1)), int(m.group(2)), m.group(3)
            _recon(add, u, text, m, pct_s, a, b)
        for m in FRAC_CI_INLINE.finditer(text):
            _check_ci(add, u, int(m.group(1)), int(m.group(2)), m.group(3), m.group(4))
        for m in SUM_EQ.finditer(text):
            parts = [int(x) for x in re.split(r"\s*\+\s*", m.group(1))]
            if sum(parts) != int(m.group(2)):
                add("NUM-004", unit_ref(u), u.file, u.start, f"sum:{m.group(0)}",
                    f"{m.group(1)} = {sum(parts)}, text says {m.group(2)}")

    # ---- STALE-01: superseded values of facts still present in prose ----
    # Context words are matched in a window around the hit, not a "sentence", because tables and
    # lists have no sentence boundaries. `allow_near` lists contexts where the old value is legitimate
    # (for example "after the main search"); a hit near one of those words is not reported.
    win = int(cfg.get("stale_window", 110))
    for fid, f in sorted(fs.facts.items()):
        for sup in f.superseded:
            t = str(sup["text"])
            near = [w.lower() for w in sup.get("near", [])]
            allow = [w.lower() for w in sup.get("allow_near", [])]
            files = sup.get("files")
            tail = r"(?=\s*(?:%|\\%|percent))" if sup.get("pct") else r"(?![\d.]*\d|/\d)"
            rx = re.compile(r"(?<![\d./])" + re.escape(t) + tail)
            for i in ctx.inv:
                u = i.unit
                if files and not any(re.search(p, u.file) for p in files):
                    continue
                text = _plain(u.raw)
                for m in rx.finditer(text):
                    s0 = text.rfind(". ", 0, m.start())
                    s0 = s0 + 2 if s0 >= 0 else 0
                    s1 = text.find(". ", m.end())
                    s1 = s1 if s1 >= 0 else len(text)
                    if m.start() - s0 <= 2 * win and s1 - m.end() <= 2 * win:
                        around = text[s0:s1].lower()                    # prose: the sentence
                    else:
                        around = text[max(0, m.start() - win): m.end() + win].lower()   # tables and lists: a window
                    if near and not any(w in around for w in near):
                        continue
                    if allow and any(w in around for w in allow):
                        continue
                    ctxkey = sha1(collapse_ws(text[max(0, m.start() - 24): m.end() + 24]), 6)
                    add("STALE-01", unit_ref(u), u.file, u.start, f"{fid}:{t}:{ctxkey}",
                        f"'{t}' is a superseded value of fact '{fid}' (now {fs.facts[fid].variants[f.default_variant()]['plain']})"
                        f"{': ' + sup['note'] if sup.get('note') else ''}")
    return out


def _signed(text: str, pos: int) -> bool:
    """True when the number at `pos` carries a sign (+, -, minus, plus-minus), which makes it a change or an
    error, not a proportion. A hyphen between two digits is a range ("5-10%"), not a sign."""
    i = pos - 1
    while i >= 0 and text[i] == " ":
        i -= 1
    if i < 0 or text[i] not in "+-\u2212\u00b1\u2013":
        return False
    j = i - 1
    while j >= 0 and text[j] == " ":
        j -= 1
    return not (text[i] in "-\u2013" and j >= 0 and text[j].isdigit())


def _recon(add, u, text, m, pct_s, a, b):
    if b == 0:
        return
    actual = 100.0 * a / b
    if not _round_ok(actual, pct_s):
        add("NUM-004", unit_ref(u), u.file, u.start, f"pct:{a}/{b}:{pct_s}",
            f"{a}/{b} = {actual:.{_dec(pct_s)}f}%, text says {pct_s}%")
    tail = text[m.end(): m.end() + 70]
    cm = CI_DIRECT.match(tail) or CI_LABEL.match(tail)
    if cm:
        _check_ci(add, u, a, b, cm.group(1), cm.group(2))


def _check_ci(add, u, a, b, lo_s, hi_s):
    lo, hi = wilson(a, b)
    d = max(_dec(lo_s), _dec(hi_s))
    if abs(lo - float(lo_s)) > 0.5 * 10 ** -d + 1e-6 or abs(hi - float(hi_s)) > 0.5 * 10 ** -d + 1e-6:
        add("NUM-004", unit_ref(u), u.file, u.start, f"ci:{a}/{b}:{lo_s}-{hi_s}",
            f"Wilson 95% CI for {a}/{b} is {lo:.{d}f}--{hi:.{d}f}, text says {lo_s}--{hi_s}")
