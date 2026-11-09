"""Promote a free-form review comment into a rule that is checked every time (writing-compiler phase 5).

A free review (deep_review, a referee simulation) notices different things on every run, so it can never be the
definition of "done". What it can be is a source of candidates: when a comment names a problem a program could have
found, the problem is written down as a rule, and from then on it is found by the program, on every run, whether or
not anyone runs another review.

Two kinds of rule can be promoted:
  pattern    a regular expression over the text a reader sees (finding PRM-01). It ships with the sentence the comment
             pointed at as its positive fixture, optional negative fixtures, and a count of where it fires today.
  criterion  a yes/no question for the frozen rubric (phase 4). It reports at info until the author admits it.

The agent can propose; only the author accepts (`ah rule accept`, the same pattern as fact proposals). A proposal is
validated against the manuscript before the author sees it, so the author reviews real hits, not a promise.

`triage` goes the other way: for each review comment it says whether a rule already fires on the unit it is about
(`covered-by:<id>`), fires there but without an evident link to the comment (`same-unit:<id>`), or nothing does
(`exploratory`). That shows which free-review comments were already known and which are new.
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import yaml

from .checks.base import LEVEL_ORDER
from .context import Context, unit_ref
from .project import Project

RULES_FILE = "rules/promoted.yaml"
CRITERIA_FILE = "rubric/promoted.yaml"
RULE_ID = re.compile(r"^PRM-[A-Z0-9][A-Z0-9-]*$")
MAX_PATTERN = 300
NESTED_QUANT = re.compile(r"\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]")     # (a+)+ : exponential backtracking
KINDS = ("para", "float", "display")


class PromoteError(ValueError):
    pass


# ---------------------------------------------------------------- the text a rule sees
def reader_text(norm: str) -> str:
    """What a reader reads of a unit (the same view the format rules use)."""
    from .checks.t5_format import prose
    return prose(norm)


def words(s: str) -> str:
    """Letters and digits only, lower case, single spaces: a quote copied from a PDF still finds its place."""
    return " ".join(re.findall(r"[a-z0-9%]+", s.casefold()))


def locate(ctx: Context, span: str) -> list:
    """Units whose reader text contains the span (compared as words, so punctuation, case and line breaks do not matter)."""
    want = words(span)
    if len(want) < 8:
        return []
    needle = f" {want} "
    return [u for u in ctx.units if needle in f" {words(reader_text(u.norm))} "]


def sentence_around(text: str, span: str) -> str:
    """The sentence(s) of `text` that contain the span; the whole text when it spans more than two sentences."""
    want = f" {words(span)} "
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z¤‡(\\])", text)
    for i, part in enumerate(parts):
        if want in f" {words(part)} ":
            return part.strip()
    for i in range(len(parts) - 1):
        joined = parts[i] + " " + parts[i + 1]
        if want in f" {words(joined)} ":
            return joined.strip()
    return text.strip()


# ---------------------------------------------------------------- rule files
def _read_yaml(path: Path):
    try:
        return yaml.safe_load(path.read_text()) or {}
    except (OSError, yaml.YAMLError) as e:
        return e


def compile_pattern(pattern: str, flags: str = "i") -> re.Pattern:
    if not isinstance(pattern, str) or not pattern.strip():
        raise PromoteError("a pattern rule needs a pattern")
    if len(pattern) > MAX_PATTERN:
        raise PromoteError(f"the pattern is {len(pattern)} characters; keep it under {MAX_PATTERN}")
    if NESTED_QUANT.search(pattern):
        raise PromoteError("the pattern repeats a repeated group, which can take exponential time; simplify it")
    bits = 0
    for ch in str(flags or ""):
        if ch == "i":
            bits |= re.I
        elif ch == "m":
            bits |= re.M
        elif ch == "s":
            bits |= re.S
        else:
            raise PromoteError(f"unknown flag '{ch}' (use i, m or s)")
    try:
        rx = re.compile(pattern, bits)
    except re.error as e:
        raise PromoteError(f"the pattern does not compile: {e}") from e
    if rx.search(""):
        raise PromoteError("the pattern matches empty text, so it would fire everywhere")
    return rx


def check_rule(rule: dict) -> tuple[re.Pattern | None, list[str]]:
    """Compile a rule and run its fixtures. Returns the pattern and what is wrong with it (empty when it is sound)."""
    bad: list[str] = []
    rid = str(rule.get("id") or "")
    if not RULE_ID.match(rid):
        bad.append(f"id {rid!r} must look like PRM-NAME (capitals, digits, dashes)")
    if not str(rule.get("message") or "").strip():
        bad.append("the rule needs a message saying what is wrong")
    if str(rule.get("level") or "info") not in LEVEL_ORDER:
        bad.append(f"level must be one of {', '.join(LEVEL_ORDER)}")
    scope = rule.get("scope") or {}
    if not isinstance(scope, dict) or any(k not in KINDS for k in (scope.get("kinds") or [])):
        bad.append(f"scope.kinds must be from {', '.join(KINDS)}")
    try:
        rx = compile_pattern(rule.get("pattern"), rule.get("flags", "i"))
    except PromoteError as e:
        return None, bad + [str(e)]
    fx = rule.get("fixtures") or {}
    pos, neg = list(fx.get("positive") or []), list(fx.get("negative") or [])
    if not pos:
        bad.append("the rule has no positive fixture (a sentence it must match)")
    for t in pos:
        if not rx.search(str(t)):
            bad.append(f"positive fixture no longer matches: {str(t)[:60]!r}")
    for t in neg:
        if rx.search(str(t)):
            bad.append(f"negative fixture matches: {str(t)[:60]!r}")
    return rx, bad


def load_rules(project: Project) -> tuple[list[dict], list[tuple[str, str]]]:
    """(rules, problems) from rules/promoted.yaml. A problem is (key, message); the file is never half-trusted."""
    f = project.root / RULES_FILE
    if not f.is_file():
        return [], []
    data = _read_yaml(f)
    if isinstance(data, Exception):
        return [], [("unreadable", f"{RULES_FILE} cannot be read: {data}")]
    rows = data.get("rules") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return [], [("layout", f"{RULES_FILE} needs a top-level `rules:` list")]
    out, problems, seen = [], [], set()
    for raw in rows:
        raw = raw if isinstance(raw, dict) else {}
        rid = str(raw.get("id") or "?")
        if rid in seen:
            problems.append((f"{rid}:duplicate", f"promoted rule {rid} is defined twice"))
            continue
        seen.add(rid)
        _, bad = check_rule(raw)
        if bad:
            for b in bad:
                problems.append((f"{rid}:{b[:50]}", f"promoted rule {rid}: {b}"))
            continue
        out.append(raw)
    return out, problems


def rules_digest(project: Project) -> str:
    """Everything that decides what the promoted rules report; "" when there are none (so old snapshots do not change)."""
    from .util import sha1
    f = project.root / RULES_FILE
    if not f.is_file():
        return ""
    try:
        return sha1(" ".join(f.read_text().split()), 16)
    except OSError:
        return "unreadable"


def in_scope(rule: dict, u) -> bool:
    import fnmatch
    scope = rule.get("scope") or {}
    if u.kind not in (scope.get("kinds") or ["para", "float"]):
        return False
    globs = scope.get("files") or ["*"]
    return any(fnmatch.fnmatch(u.file, g) for g in globs)


def hits(rx: re.Pattern, text: str) -> list[str]:
    """Distinct matched strings, in order of first appearance."""
    seen, out = set(), []
    for m in rx.finditer(text):
        s = " ".join(m.group(0).split())
        if s and s.casefold() not in seen:
            seen.add(s.casefold())
            out.append(s)
    return out


def unit_hits(rule: dict, rx: re.Pattern, u) -> list[str]:
    return hits(rx, reader_text(u.norm)) if in_scope(rule, u) else []


def firing(ctx: Context, rule: dict, rx: re.Pattern) -> list[tuple[str, str]]:
    """Where the rule fires on the manuscript right now: (unit ref, matched text)."""
    return [(unit_ref(u), m) for u in ctx.units for m in unit_hits(rule, rx, u)]


# ---------------------------------------------------------------- proposals
def pdir(p: Project) -> Path:
    return p.root / p.cfg["proposals"] / "rules"


def _existing_ids(p: Project) -> set[str]:
    ids = {str(r.get("id")) for r in load_rules(p)[0]}
    from .rubric import load_criteria
    ids |= {c.id for c in load_criteria(p)[0]}
    return ids


def propose(ctx: Context, spec: dict, by: str = "agent") -> dict:
    """Validate a draft rule against the manuscript and park it for the author. Raises PromoteError."""
    p = ctx.project
    kind = str(spec.get("kind") or "pattern")
    if kind not in ("pattern", "criterion"):
        raise PromoteError("kind must be pattern or criterion")
    rid = str(spec.get("id") or "")
    span = " ".join(str(spec.get("span") or "").split())
    comment = " ".join(str(spec.get("comment") or "").split())
    if not span:
        raise PromoteError("give the span: the words in the manuscript that the review comment is about")
    if not comment:
        raise PromoteError("give the review comment this rule comes from")
    if not str(spec.get("why") or "").strip():
        raise PromoteError("say why a program can decide this (what makes the problem recognisable without judgement)")
    if rid in _existing_ids(p) or (pdir(p) / f"{rid}.yaml").exists():
        raise PromoteError(f"'{rid}' already exists or is already proposed")
    units = locate(ctx, span)
    if not units:
        raise PromoteError("the span is not in the manuscript (compared as words; it must be at least 8 characters of the reader's text). "
                           "Quote the sentence exactly as the manuscript has it.")
    u0 = units[0]
    origin = {"source": str(spec.get("source") or ""), "comment": comment[:600], "span": span[:400], "unit": unit_ref(u0)}
    rec: dict = {"kind": kind, "why": str(spec["why"]).strip(), "proposed_by": by, "origin": origin}
    if kind == "pattern":
        rule = {
            "id": rid, "pattern": spec.get("pattern"), "flags": str(spec.get("flags") or "i"),
            "message": str(spec.get("message") or "").strip(), "level": str(spec.get("level") or "info"),
            "scope": {"files": list(spec.get("files") or ["*"]), "kinds": list(spec.get("kinds") or ["para", "float"])},
            "fixtures": {"positive": [sentence_around(reader_text(u0.norm), span)],
                         "negative": [str(x) for x in (spec.get("negatives") or [])]},
        }
        rx, bad = check_rule(rule)
        if bad:
            raise PromoteError("; ".join(bad))
        fire = firing(ctx, rule, rx)
        prose_units = [u for u in ctx.units if in_scope(rule, u)]
        limit = max(3, len(prose_units) // 5)
        fired_units = {r for r, _ in fire}
        if len(fired_units) > limit:
            raise PromoteError(f"the pattern fires on {len(fired_units)} of {len(prose_units)} units; a rule that broad is noise. Make it more specific")
        rec["rule"] = rule
        rec["fires_now"] = [{"unit": r, "match": m} for r, m in fire[:20]]
        summary = {"id": rid, "kind": kind, "fires_on_units": len(fired_units), "fires_now": rec["fires_now"][:5]}
    else:
        from .rubric import _parse
        crit = {"id": rid, "version": 1, "question": spec.get("question"), "level": str(spec.get("level") or "minor"),
                "scope": {"kinds": list(spec.get("kinds") or ["para"]), "files": list(spec.get("files") or ["*"])}}
        got = _parse(crit, "proposal", {"min_words": 12})
        if isinstance(got, str):
            raise PromoteError(got)
        rec["criterion"] = crit
        rec["example"] = {"unit": unit_ref(u0), "span": span[:400]}
        summary = {"id": rid, "kind": kind, "example_unit": unit_ref(u0)}
    d = pdir(p)
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{rid}.yaml").write_text(yaml.safe_dump(rec, sort_keys=False, allow_unicode=True))
    return summary


def list_pending(p: Project) -> list[dict]:
    d = pdir(p)
    out = []
    for f in sorted(d.glob("*.yaml")) if d.exists() else []:
        r = yaml.safe_load(f.read_text()) or {}
        r["id"] = f.stem
        out.append(r)
    return out


def _append(path: Path, key: str, entry: dict, header: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = yaml.safe_load(path.read_text()) if path.exists() else None
    rows = list((data or {}).get(key) or []) if isinstance(data, dict) else []
    rows.append(entry)
    path.write_text(header + yaml.safe_dump({key: rows}, sort_keys=False, allow_unicode=True))


def accept(ctx: Context, rid: str, by: str = "author") -> dict:
    """The author's act. The rule is checked again against the manuscript as it is now, then written to the project."""
    p = ctx.project
    f = pdir(p) / f"{rid}.yaml"
    if not f.exists():
        raise PromoteError(f"no pending rule proposal '{rid}'")
    rec = yaml.safe_load(f.read_text())
    if rid in _existing_ids(p):
        raise PromoteError(f"'{rid}' already exists")
    stamp = {"promoted": date.today().isoformat(), "by": by, **{k: v for k, v in rec["origin"].items() if k in ("source", "comment", "span", "unit")}}
    if rec["kind"] == "pattern":
        rule = dict(rec["rule"])
        _, bad = check_rule(rule)
        if bad:
            raise PromoteError("; ".join(bad))
        rule["origin"] = stamp
        _append(p.root / RULES_FILE, "rules", rule,
                "# Rules promoted from review comments. Each one was accepted by the author and ships with its own fixtures.\n"
                "# An agent cannot edit this file; change a rule here, or switch it off by removing it.\n")
        where = RULES_FILE
    else:
        crit = dict(rec["criterion"])
        crit["origin"] = stamp
        _append(p.root / CRITERIA_FILE, "criteria", crit,
                "# Criteria promoted from review comments. They report at info until the author admits them (`ah rubric admit`).\n")
        where = CRITERIA_FILE
    f.unlink()
    return {"id": rid, "kind": rec["kind"], "file": where}


def reject(p: Project, rid: str) -> None:
    f = pdir(p) / f"{rid}.yaml"
    if not f.exists():
        raise PromoteError(f"no pending rule proposal '{rid}'")
    f.unlink()


# ---------------------------------------------------------------- triage
QUOTED = re.compile(r"[\"“”‘’']([^\"“”‘’']{20,400})[\"“”‘’']")
STOP = set("that this with from have which their were been than such also these those into more most only over used using "
           "should would could there where when what while about between because being does each other some very will your".split())


def spans_of(comment: dict) -> list[str]:
    """The words a comment points at: its `quote`, else any quoted passage inside its text."""
    out = []
    q = " ".join(str(comment.get("quote") or "").split())
    if q:
        out.append(q)
    out += [" ".join(m.group(1).split()) for m in QUOTED.finditer(str(comment.get("text") or ""))]
    return out


def _link_words(finding: dict) -> set[str]:
    msg = str(finding.get("message") or "")
    inside = " ".join(re.findall(r"[\"“”`']([^\"“”`']{3,120})[\"“”`']", msg))
    check = str(finding.get("check") or "")
    return {w for w in re.findall(r"[a-z]{4,}", f"{inside} {check}".casefold()) if w not in STOP}


def triage(ctx: Context, comments: list[dict], findings: list[dict]) -> list[dict]:
    """Tag each review comment: covered-by:<ids>, same-unit:<ids>, or exploratory. `findings` are audit findings."""
    by_unit: dict[str, list[dict]] = {}
    for f in findings:
        if f.get("unit") and f.get("state", "open") in ("open", "decision-needed", "regressed"):
            by_unit.setdefault(f["unit"], []).append(f)
    out = []
    for c in comments:
        units: list[str] = []
        for s in spans_of(c):
            for u in locate(ctx, s):
                if unit_ref(u) not in units:
                    units.append(unit_ref(u))
        for ref in c.get("units") or []:
            if ref not in units:
                units.append(ref)
        text_words = set(re.findall(r"[a-z]{4,}", f"{c.get('text') or ''} {c.get('quote') or ''}".casefold())) - STOP
        covered, same = [], []
        for ref in units:
            for f in by_unit.get(ref, []):
                row = {"check": f["check"], "fingerprint": f.get("fingerprint") or f.get("fp"), "level": f["level"], "unit": ref}
                (covered if _link_words(f) & text_words else same).append(row)
        if covered:
            status, tag = "covered", "covered-by:" + ",".join(dict.fromkeys(r["check"] for r in covered))
        elif same:
            status, tag = "same-unit", "same-unit:" + ",".join(dict.fromkeys(r["check"] for r in same))
        else:
            status, tag = "exploratory", "exploratory"
        out.append({"id": c.get("id"), "tag": tag, "status": status, "units": units, "located": bool(units),
                    "by": covered or same})
    return out


def summarize(rows: list[dict]) -> dict:
    n = {"covered": 0, "same-unit": 0, "exploratory": 0}
    for r in rows:
        n[r["status"]] += 1
    return {"comments": len(rows), **n, "unlocated": sum(1 for r in rows if not r["located"])}
