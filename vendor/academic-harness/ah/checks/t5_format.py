"""T5: format and consistency rules. Code only, no model, and every one of them ships at info.

A reviewer who is asked to "check the formatting" notices something different each time. These rules are the part
of that job that has an exact answer: an acronym used before it is defined, a number and its unit that can break
across a line, "colour" in one paragraph and "color" in the next. Each rule has an ID, a fixed meaning and no
randomness, so the same text gives the same findings.

Two kinds of rule:
  * a fact about one place (a repeated word, a long sentence, an undefined acronym);
  * a consistency rule over the whole document (US and UK spelling, "%" and "percent", `e.g.,` with and without the
    comma). Which form is right is the author's choice, so the rule flags the *minority* form: the one that
    disagrees with the rest. If the author declares the form in `style.format`, the rule flags whatever departs from it.

None of them gates until the author decides it should: set `levels: {FMT-08: minor}` in ah.yaml. `ah precision` turns
the author's own decisions (a finding they fixed against one they waived) into a per-rule precision estimate, so that
decision can rest on their text and not on mine.

The text a rule reads is the unit's source with comments gone. Where it needs words, citations, references, labels and
maths are replaced by a placeholder (not deleted) so that removing them can never make two words look adjacent.
"""
from __future__ import annotations

import fnmatch
import re
from collections import Counter, defaultdict

from ..context import Context, unit_ref
from ..tex.text import RE_CITE, RE_LABEL, RE_REF, sentences
from ..util import sha1
from .base import Finding, make

FORMAT_DEFAULTS = {
    "cite": "any",              # natbib | cite | any: which citation commands the document uses
    "percent": "any",           # symbol | word | any
    "spelling": "any",          # us | uk | any
    "heading_case": "any",      # sentence | title | any
    "eg_comma": "any",          # yes | no | any: "e.g.," against "e.g."
    "sentence_max_words": 60,
    "figure_refs_before": False,   # a figure or table must be mentioned before it appears
    "acronyms_known": [],       # extra acronyms that need no definition
    "acronym_redefine_in": ["*abstract*"],   # files where defining an acronym again later is expected
}

# Needed no definition by most readers of any field. A project adds its own in `style.format.acronyms_known`.
KNOWN_ACRONYMS = {
    "US", "UK", "EU", "UN", "USA", "PDF", "URL", "HTML", "HTTP", "HTTPS", "XML", "JSON", "CSV", "SQL", "CPU", "GPU", "RAM", "ROM",
    "DNA", "RNA", "PCR", "MRI", "CT", "ID", "OK", "TV", "PC", "CEO", "PhD", "ISO", "IEEE", "ACM", "NASA", "WHO", "GDP", "USB",
    "ASCII", "UTF", "API", "OS", "IP", "TCP", "UDP", "LAN", "WAN", "GPS", "LED", "LCD", "AC", "DC", "SI", "FAQ", "PIN", "SMS",
    "CLI", "GUI", "SDK", "DOI", "JSONL", "YAML", "TOML", "SSH", "TTL", "CI", "IO", "SSD", "HDD", "BIOS", "KB", "MB", "GB", "TB",
}
ROMAN = {"II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII", "XIII", "XIV", "XV", "XX", "XXI"}
SMALL = {"a", "an", "the", "of", "and", "or", "for", "in", "on", "to", "by", "with", "via", "per", "at", "as", "vs", "from", "into", "over", "under", "nor", "but", "is", "are"}
HOLE = " ¤ "          # maths, references, urls, code: something was here
CITE = " ‡ "          # a citation was here

RE_MATH = re.compile(r"\$\$.*?\$\$|\$[^$]*\$|\\\(.*?\\\)|\\\[.*?\\\]", re.S)
RE_HREF = re.compile(r"\\href\{[^}]*\}\{([^}]*)\}")
RE_URLCMD = re.compile(r"\\(?:url|doi|path)\{[^}]*\}")
RE_FOOTCMD = re.compile(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])*")
RE_CODE = re.compile(r"\\(?:texttt|code|lstinline|verb\*?|path|file)\{[^{}]*\}|\\verb(.).*?\1")
RE_RUNIN = re.compile(r"\\(?:paragraph|subparagraph|subsubsection|subsection|section|chapter)\*?(?:\[[^\]]*\])?\{([^{}]*)\}")


def prose(norm: str) -> str:
    """What a reader reads: commands, citations, references, labels and maths gone (the last four leave a placeholder)."""
    s = RE_HREF.sub(r"\1", norm)
    s = RE_URLCMD.sub(HOLE, s)
    s = RE_CODE.sub(HOLE, s)
    s = RE_MATH.sub(HOLE, s)
    s = RE_CITE.sub(CITE, s)
    s = RE_REF.sub(HOLE, s)
    s = RE_RUNIN.sub(r" \1. ", s)            # a heading is not the start of the sentence that follows it
    s = RE_LABEL.sub(" ", s)
    s = s.replace("\\%", "%").replace("\\&", "&").replace("~", " ").replace("\\,", " ").replace("\\ ", " ").replace("\\-", "")
    s = RE_FOOTCMD.sub(" ", s)
    s = re.sub(r"[{}]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def minority(counts: Counter, first_seen: dict[str, int]) -> set[str]:
    """The forms that disagree with the established one: the commonest, and on a tie the one that appeared first."""
    if len(counts) < 2:
        return set()
    keep = max(counts, key=lambda f: (counts[f], -first_seen.get(f, 0)))
    return set(counts) - {keep}


class Hits:
    def __init__(self, ctx: Context):
        self.ctx = ctx
        self.out: list[Finding] = []

    def add(self, check: str, unit, key: str, message: str, line: int | None = None, file: str | None = None):
        """At a unit; or, with no unit (a heading is not a unit), at a file and line."""
        if unit is not None:
            f = make(self.ctx.cfg, check, unit_ref(unit), unit.file, line if line is not None else unit.start, key, message)
        else:
            f = make(self.ctx.cfg, check, None, file, line, key, message)
        if f:
            self.out.append(f)


def settings(cfg: dict) -> dict:
    s = dict(FORMAT_DEFAULTS)
    s.update((cfg.get("style") or {}).get("format") or {})
    return s


# ---------------------------------------------------------------- acronyms

ACR = re.compile(r"\b([A-Z]{2,8})(s?)\b(?!-\d)")        # PRF-03 is an identifier, not an acronym
DEF_AFTER = re.compile(r"\(([A-Z]{2,8})s?\)")                 # long form (ABC)
DEF_BEFORE = re.compile(r"\b([A-Z]{2,8})s?\s*\(([^()]{3,90})\)")   # ABC (long form)


def initials_match(acr: str, words: list[str]) -> bool:
    """Do the initials of these words spell the acronym? Small words may be skipped; hyphenated words count as parts."""
    parts: list[str] = []
    for w in words:
        parts += [p for p in w.split("-") if p]
    letters = [p[0].upper() for p in parts if p.lower() not in SMALL]
    all_letters = [p[0].upper() for p in parts]
    return "".join(letters) == acr or "".join(all_letters) == acr


def long_form_before(acr: str, text_before: str) -> bool:
    words = [part for w in re.findall(r"[A-Za-z][A-Za-z-]*", text_before) for part in w.split("-") if part]    # "short-term" is two parts
    n = len(acr)
    for take in range(n, n + 4):
        if take <= len(words) and initials_match(acr, words[-take:]):
            return True
    return False


def check_acronyms(ctx: Context, st: dict, hits: Hits, units: list):
    known = KNOWN_ACRONYMS | set(st["acronyms_known"])
    defs: dict[str, list[tuple[int, int]]] = defaultdict(list)      # acronym -> [(unit index, offset)]
    uses: dict[str, list[tuple[int, int]]] = defaultdict(list)
    plain_uses: Counter = Counter()                                   # uses in a sentence that cites nothing
    for i, u in enumerate(units):
        s = prose(u.norm)
        spans: set[tuple[int, int]] = set()
        for m in DEF_AFTER.finditer(s):
            if long_form_before(m.group(1), s[: m.start()]):
                defs[m.group(1)].append((i, m.start()))
                spans.add((m.start(1), m.end(1)))
        for m in DEF_BEFORE.finditer(s):
            inner = re.findall(r"[A-Za-z][A-Za-z-]*", m.group(2))
            if initials_match(m.group(1), inner):
                defs[m.group(1)].append((i, m.start()))
                spans.add((m.start(1), m.end(1)))
        cited = [(m.start(), m.end()) for m in re.finditer(r"[^.!?]*‡[^.!?]*", s)]       # the stretches of text that cite a source
        for m in ACR.finditer(s):
            a = m.group(1)
            if (m.start(1), m.end(1)) in spans or a in ROMAN:
                continue
            uses[a].append((i, m.start()))
            if not any(lo <= m.start() < hi for lo, hi in cited):
                plain_uses[a] += 1
    redefine_ok = st["acronym_redefine_in"]
    for a in sorted(set(defs) | set(uses)):
        d, ux = sorted(defs.get(a, [])), sorted(uses.get(a, []))
        if ux and (not d or ux[0] < d[0]):
            # never defined: a name that only ever appears next to a citation is the cited work's name (ACE, SICA), not jargon
            if d or (a not in known and plain_uses[a] > 0):
                u = units[ux[0][0]]
                why = (f"is used in {u.file} before it is defined" if d else "is used but never defined")
                hits.add("ACR-01", u, f"{'before' if d else 'undefined'}:{a}",
                         f"{a} {why}: write the full term once with {a} in brackets, then use {a}")
        if len(d) >= 2:
            first_file = units[d[0][0]].file.lower()
            if not any(fnmatch.fnmatch(first_file, g.lower()) for g in redefine_ok):
                u = units[d[1][0]]
                hits.add("ACR-01", u, f"twice:{a}", f"{a} is defined again here; it was already defined in {units[d[0][0]].file}")
        if d and not ux:
            hits.add("ACR-02", units[d[0][0]], f"unused:{a}", f"{a} is defined but never used again; the full term is enough")


# ------------------------------------------------------------------- units

UNITS = ("ms", "µs", "μs", "ns", "Hz", "kHz", "MHz", "GHz", "kg", "mg", "km", "cm", "mm", "nm", "μm", "µm",
         "kB", "KB", "MB", "GB", "TB", "Mb", "Gb", "dB", "mL", "ml", "kJ", "mol", "mmol", "bpm", "fps", "rpm")
RE_UNIT = re.compile(r"(?<![\w.,\\{~-])(\d+(?:[.,]\d+)?) (" + "|".join(sorted(map(re.escape, UNITS), key=len, reverse=True)) + r")(?![\w])")


def check_units(ctx: Context, st: dict, hits: Hits, units: list):
    for u in units:
        s = RE_MATH.sub(HOLE, u.norm)
        for m in RE_UNIT.finditer(s):
            hits.add("FMT-01", u, f"unit:{m.group(1)}{m.group(2)}",
                     f"'{m.group(0)}' can break across a line: write {m.group(1)}~{m.group(2)} (or \\SI{{{m.group(1)}}}{{{m.group(2)}}})")


# ----------------------------------------------------------------- percent

RE_PCT_SYMBOL = re.compile(r"\d\s?%")
RE_PCT_WORD = re.compile(r"\d\s+(?:percent|per cent)\b", re.I)


def check_percent(ctx: Context, st: dict, hits: Hits, units: list):
    found: list[tuple[object, str]] = []
    counts: Counter = Counter()
    first: dict[str, int] = {}
    for i, u in enumerate(units):
        s = prose(u.norm)
        for form, rx in (("symbol", RE_PCT_SYMBOL), ("word", RE_PCT_WORD)):
            n = len(rx.findall(s))
            if n:
                counts[form] += n
                first.setdefault(form, i)
                found.append((u, form))
    want = st["percent"]
    flagged = ({"word"} if want == "symbol" else {"symbol"} if want == "word" else minority(counts, first)) & set(counts)
    for u, form in found:
        if form in flagged:
            other = "percent" if form == "symbol" else "%"
            hits.add("FMT-02", u, f"pct:{form}", f"{'the word percent' if form == 'word' else 'the % sign'} is used here, but the document otherwise writes {other}")


# --------------------------------------------------------------- citations

PLAIN_CITE = re.compile(r"\\cite\*?(?:\[[^\]]*\]){0,2}\{")
NATBIB = re.compile(r"\\(citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|Citep|Citet)\*?(?:\[[^\]]*\]){0,2}\{")
PAREN = re.compile(r"\\(?:cite|citep|parencite|autocite)\*?(?:\[[^\]]*\]){0,2}\{[^}]*\}")


def check_cite_commands(ctx: Context, st: dict, hits: Hits, units: list):
    found: list[tuple[object, str]] = []
    counts: Counter = Counter()
    first: dict[str, int] = {}
    for i, u in enumerate(units):
        for kind, n in (("cite", len(PLAIN_CITE.findall(u.norm))), ("natbib", len(NATBIB.findall(u.norm)))):
            if n:
                counts[kind] += n
                first.setdefault(kind, i)
                found.append((u, kind))
    want = st["cite"]
    flagged = ({"cite"} if want == "natbib" else {"natbib"} if want == "cite" else minority(counts, first)) & set(counts)
    for u, k in found:
        if k in flagged:
            msg = ("plain \\cite is used, but the document is set up for \\citep and \\citet" if want == "natbib"
                   else "\\citep/\\citet are used, but the document is set up for plain \\cite" if want == "cite"
                   else ("plain \\cite is mixed with \\citep/\\citet; this is the less used form" if k == "cite"
                         else "\\citep/\\citet are mixed with plain \\cite; this is the less used form"))
            hits.add("FMT-03", u, f"cite:{k}", msg)


RE_ET_AL = re.compile(r"(?:et al|\b[A-Z])\.?\s*~?$")


def check_cite_position(ctx: Context, st: dict, hits: Hits, units: list):
    """A parenthetical citation goes before the full stop ("... as shown~\\cite{a}.") or after it, but not both."""
    found: list[tuple[object, str]] = []
    counts: Counter = Counter()
    first: dict[str, int] = {}
    for i, u in enumerate(units):
        s = u.norm
        forms = set()
        for m in PAREN.finditer(s):
            before, after = s[: m.start()], s[m.end():]
            if re.match(r"\s*[.,]", after) and re.search(r"[\w}~]\s*$", before):
                forms.add("before-punct")
            pm = re.search(r"([\w}])\s*([.,])\s*~?$", before)
            tail = after.lstrip()[:1]
            ends_a_statement = tail == "" or tail == "." or tail.isupper() or tail == "\\"      # "... result. \cite{x}  Next ..."
            if pm and ends_a_statement and not RE_ET_AL.search(before[: pm.end(2)].rstrip(" .,")) and len(before.strip()) > 20:
                forms.add("after-punct")           # (\cite{x} followed by a lowercase word is a narrative citation, not this)
        for f in forms:
            counts[f] += 1
            first.setdefault(f, i)
            found.append((u, f))
    for u, f in found:
        if f in minority(counts, first):
            hits.add("FMT-04", u, f"citepos:{f}",
                     "a citation follows the full stop here" if f == "after-punct" else "a citation precedes the full stop here; the document otherwise puts it after")


# ---------------------------------------------------------- figures/tables

RE_FLOAT_ENV = re.compile(r"\\begin\{(figure|table)\*?\}")
RE_CAPTION = re.compile(r"\\caption(?:\[[^\]]*\])?\{")


def check_floats(ctx: Context, st: dict, hits: Hits, units: list):
    refs_at: dict[str, int] = {}
    for i, inv in enumerate(ctx.inv):
        for r in inv.refs:
            refs_at.setdefault(r, i)
    index = {unit_ref(inv.unit): i for i, inv in enumerate(ctx.inv)}
    for inv in ctx.inv:
        u = inv.unit
        m = RE_FLOAT_ENV.search(u.raw)
        if u.kind == "para" or not m:
            continue
        labels = list(inv.labels)
        if not labels:
            cap = RE_CAPTION.search(u.norm)
            ident = sha1(re.sub(r"\W+", " ", u.norm[cap.end(): cap.end() + 80] if cap else u.norm[:80]).strip().lower(), 8)
            hits.add("FMT-05", u, f"nolabel:{ident}", f"this {m.group(1)} has no \\label, so the text cannot refer to it")
            continue
        for lab in labels:
            if lab not in refs_at:
                hits.add("FMT-05", u, f"unref:{lab}", f"{m.group(1)} '{lab}' is never referred to in the text")
            elif st["figure_refs_before"] and refs_at[lab] > index[unit_ref(u)]:
                hits.add("FMT-05", u, f"late:{lab}", f"{m.group(1)} '{lab}' appears before the text first refers to it")


# ---------------------------------------------------------------- headings

RE_HEADING = re.compile(r"\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}")


def heading_case(text: str) -> str | None:
    """'title', 'sentence' or None when it cannot be told (short, or mixed with proper nouns)."""
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", RE_FOOTCMD.sub(" ", text))
    rest = [w for w in words[1:] if w.lower() not in SMALL and not w.isupper() and not any(c.isupper() for c in w[1:])]
    if len(rest) < 2:
        return None
    caps = sum(w[0].isupper() for w in rest)
    return "title" if caps == len(rest) else "sentence" if caps == 0 else None


def check_headings(ctx: Context, st: dict, hits: Hits, units: list):
    by_file: dict[str, list] = defaultdict(list)
    for u in units:
        by_file[u.file].append(u)
    found: list[tuple[str, tuple, str, str, int]] = []      # level, (unit or None, file), case, text, line
    for rel in sorted(ctx.tex_texts):                      # every file: a file of headings alone has no units
        text = ctx.tex_texts[rel]
        for m in RE_HEADING.finditer(text):
            case = heading_case(m.group(2))
            if case is None:
                continue
            line = text.count("\n", 0, m.start()) + 1
            unit = next((u for u in by_file.get(rel, []) if u.start <= line <= u.end), None)      # a heading on its own is not a unit
            found.append((m.group(1), (unit, rel), case, re.sub(r"\s+", " ", m.group(2)).strip(), line))
    want = st["heading_case"]
    for level in sorted({f[0] for f in found}):
        rows = [f for f in found if f[0] == level]
        counts: Counter = Counter()
        first: dict[str, int] = {}
        for i, (_, _, case, _, _) in enumerate(rows):
            counts[case] += 1
            first.setdefault(case, i)
        flagged = ({"title"} if want == "sentence" else {"sentence"} if want == "title" else minority(counts, first)) & set(counts)
        for _, (unit, rel), case, text, line in rows:
            if case in flagged:
                expected = want if want != "any" else ("sentence" if case == "title" else "title")
                hits.add("FMT-06", unit, f"head:{level}:{re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()[:60]}",
                         f"heading '{text}' is in {case} case; the {level} headings are otherwise in {expected} case", line, rel)


# ---------------------------------------------------------------- spelling

_IZE = ["optimiz", "organiz", "generaliz", "normaliz", "minimiz", "maximiz", "utiliz", "summariz", "recogniz", "realiz", "visualiz",
        "characteriz", "initializ", "standardiz", "categoriz", "prioritiz", "specializ", "synchroniz", "regulariz", "randomiz",
        "penaliz", "formaliz", "finaliz", "customiz", "emphasiz", "localiz", "stabiliz", "centraliz", "analyz"]
_IZE_SUF = ["e", "es", "ed", "ing", "ation", "ations", "er", "ers"]
_OUR = ["color", "behavior", "favor", "honor", "neighbor", "labor", "flavor"]
_OUR_SUF = ["", "s", "ed", "ing", "ful", "able", "al", "ite"]
_PAIRS = [("labeled", "labelled"), ("labeling", "labelling"), ("modeled", "modelled"), ("modeling", "modelling"),
          ("canceled", "cancelled"), ("traveled", "travelled"), ("signaled", "signalled"), ("signaling", "signalling"),
          ("center", "centre"), ("centers", "centres"), ("centered", "centred"), ("centering", "centring"),
          ("fiber", "fibre"), ("fibers", "fibres"), ("defense", "defence"),
          ("gray", "grey"), ("aluminum", "aluminium"), ("sulfur", "sulphur"), ("artifact", "artefact"), ("artifacts", "artefacts"),
          ("judgment", "judgement"), ("acknowledgment", "acknowledgement"), ("acknowledgments", "acknowledgements"),
          ("enrollment", "enrolment"), ("fulfill", "fulfil"), ("skillful", "skilful"), ("aging", "ageing"), ("liter", "litre"),
          ("liters", "litres"), ("meager", "meagre")]


def _spelling_table() -> dict[str, tuple[str, str]]:
    """word -> (variety, its US form). Built, not stored, so the family rules stay one line each."""
    t: dict[str, tuple[str, str]] = {}
    for stem in _IZE:
        uk_stem = stem[:-1] + "s"
        for suf in _IZE_SUF:
            if stem == "analyz" and suf in ("es", "ation", "ations", "er", "ers"):
                continue                                  # analyses is the plural of analysis in both varieties
            us, uk = stem + suf, uk_stem + suf
            t[us], t[uk] = ("us", us), ("uk", us)
    for stem in _OUR:
        uk_stem = stem[:-2] + "our"
        for suf in _OUR_SUF:
            us, uk = stem + suf, uk_stem + suf
            t[us], t[uk] = ("us", us), ("uk", us)
    for us, uk in _PAIRS:
        t[us], t[uk] = ("us", us), ("uk", us)
    return t


SPELLING = _spelling_table()
RE_WORD = re.compile(r"[A-Za-z][A-Za-z'-]*")


def check_spelling(ctx: Context, st: dict, hits: Hits, units: list):
    rows: list[tuple[object, str, str, str]] = []             # unit, word, variety, us form
    counts: Counter = Counter()
    first: dict[str, int] = {}
    for i, u in enumerate(units):
        for w in RE_WORD.findall(prose(u.norm)):
            hit = SPELLING.get(w.lower())
            if hit:
                counts[hit[0]] += 1
                first.setdefault(hit[0], i)
                rows.append((u, w.lower(), hit[0], hit[1]))
    want = st["spelling"]
    flagged = ({"uk"} if want == "us" else {"us"} if want == "uk" else minority(counts, first)) & set(counts)
    for u, word, variety, us_form in rows:
        if variety in flagged:
            other = "UK" if variety == "us" else "US"
            hits.add("FMT-07", u, f"spell:{word}", f"'{word}' is {variety.upper()} spelling; the document otherwise uses {other} spelling")


# ----------------------------------------------------------- repeated words

RE_REPEAT = re.compile(r"\b([A-Za-z][A-Za-z']*)\s+\1\b", re.I)
REPEAT_OK = {"that", "had"}


def check_repeats(ctx: Context, st: dict, hits: Hits, units: list):
    for u in units:
        seen = set()
        for m in RE_REPEAT.finditer(prose(u.norm)):
            w = m.group(1).lower()
            if w in REPEAT_OK or w in seen:
                continue
            seen.add(w)
            hits.add("FMT-08", u, f"dup:{w}", f"the word '{w}' is repeated")


# --------------------------------------------------------- term variants

AUTO_FAMILIES = [
    ["dataset", "data set", "data-set"], ["email", "e-mail"], ["online", "on-line"], ["pretrained", "pre-trained"],
    ["preprocessing", "pre-processing"], ["hyperparameter", "hyper-parameter"], ["multitask", "multi-task"], ["nonlinear", "non-linear"],
]


def _forms_of(canonical: str) -> list[str]:
    c = canonical.strip().lower()
    if " " in c or "-" in c:
        flat = re.sub(r"[\s-]+", " ", c)
        return list(dict.fromkeys([flat, flat.replace(" ", "-"), flat.replace(" ", "")]))
    return [c]


def _form_regex(form: str) -> re.Pattern:
    """A form is matched as written: "data set" is not "data-set" is not "dataset" (that is the whole point)."""
    return re.compile(r"\b" + r"\s+".join(re.escape(p) for p in form.split()) + r"(?:s|es)?\b", re.I)


def check_terms(ctx: Context, st: dict, hits: Hits, units: list):
    families: list[tuple[list[str], str | None, set[str]]] = []       # forms, declared canonical, banned forms
    for term in ctx.glossary:
        canonical = term.get("canonical")
        if not canonical or term.get("regex"):
            continue
        forms = list(dict.fromkeys(_forms_of(canonical) + [v.strip().lower() for v in (term.get("variants") or [])]))
        if len(forms) > 1:
            families.append((forms, canonical.strip().lower(), {b.strip().lower() for b in (term.get("banned") or [])}))
    declared = {f for fam, _, _ in families for f in fam}
    for fam in AUTO_FAMILIES:
        if not any(f in declared for f in fam):
            families.append((fam, None, set()))
    texts = [(u, prose(u.norm)) for u in units]
    for forms, canonical, banned in families:
        rx = {f: _form_regex(f) for f in forms}
        where: dict[str, list] = defaultdict(list)
        counts: Counter = Counter()
        first: dict[str, int] = {}
        for i, (u, s) in enumerate(texts):
            for f, r in rx.items():
                n = len(r.findall(s))
                if n:
                    counts[f] += n
                    first.setdefault(f, i)
                    where[f].append(u)
        if canonical:
            flagged = {f for f in counts if f != canonical and f not in banned}      # banned forms are COH-01's
        else:
            flagged = minority(counts, first)
        keep = canonical or max(counts, key=lambda f: (counts[f], -first.get(f, 0)), default=None)
        for f in sorted(flagged):
            for u in where[f]:
                hits.add("FMT-09", u, f"term:{f}", f"'{f}' is written differently elsewhere; the document uses '{keep}'")


# ------------------------------------------------------------- e.g. / i.e.

RE_EG = re.compile(r"\b(e\.g|i\.e)\.(\s*,?)", re.I)


def check_eg(ctx: Context, st: dict, hits: Hits, units: list):
    rows: list[tuple[object, str, str]] = []
    counts: Counter = Counter()
    first: dict[str, int] = {}
    for i, u in enumerate(units):
        s = prose(u.norm)
        for m in RE_EG.finditer(s):
            rest = s[m.end():].lstrip()
            if "," in m.group(2):
                form = "comma"
            elif rest[:1].isalnum() or rest[:1] in ("¤", "'", '"'):
                form = "nocomma"
            else:
                continue
            counts[form] += 1
            first.setdefault(form, i)
            rows.append((u, m.group(1).lower() + ".", form))
    want = st["eg_comma"]
    flagged = ({"nocomma"} if want == "yes" else {"comma"} if want == "no" else minority(counts, first)) & set(counts)
    for u, abbr, form in rows:
        if form in flagged:
            hits.add("FMT-10", u, f"eg:{abbr}:{form}", f"'{abbr}' is written {'with' if form == 'comma' else 'without'} a comma here; the document otherwise does the opposite")


# --------------------------------------------------------------- sentences

def check_sentences(ctx: Context, st: dict, hits: Hits, units: list):
    limit = int(st["sentence_max_words"])
    if limit <= 0:
        return
    for u in units:
        for sent in sentences(prose(u.norm)):
            words = re.findall(r"[A-Za-z0-9][\w'-]*", sent)
            if len(words) > limit:
                lead = " ".join(w.lower() for w in words[:8])
                hits.add("FMT-11", u, f"long:{lead}", f"a sentence of {len(words)} words (limit {limit}) begins \"{' '.join(words[:8])} ...\"")


RULES = [check_acronyms, check_units, check_percent, check_cite_commands, check_cite_position, check_floats, check_headings,
         check_spelling, check_repeats, check_terms, check_eg, check_sentences]


def check_format(ctx: Context) -> list[Finding]:
    st = settings(ctx.cfg)
    units = [u for u in ctx.units if u.kind == "para"]
    hits = Hits(ctx)
    for rule in RULES:
        rule(ctx, st, hits, units)
    return hits.out
