#!/usr/bin/env python3
"""Candidate statistical-inconsistency audit (advisory, never misconduct).

Reads a JSON request on stdin:
  {"path": "...", "text": "...", "alpha": 0.05, "grim": true}

Reports test statistics with reported p-values, recomputes p from the reported
statistic and df, and optionally runs a GRIM check on reported means. Output
is JSON: {"file", "rows", "summary", "notes"}.

No network. Findings are candidates for human review, not conclusions.
"""
import json
import math
import re
import sys
import zipfile
try:
    from defusedxml import ElementTree
except Exception:  # defusedxml is optional; fall back to stdlib with a size cap
    from xml.etree import ElementTree

MAX_DOCX_XML_BYTES = 50 * 1024 * 1024

try:
    from scipy import stats as scipy_stats
except Exception:  # pragma: no cover - surfaced to the caller
    scipy_stats = None

WORD_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

STAT_PATTERNS = [
    ("t", re.compile(r"(?<![\w.])t\s*\(\s*(?P<df1>\d+(?:\.\d+)?)\s*\)\s*=\s*(?P<stat>[-+]?\d+(?:\.\d+)?)", re.I)),
    ("F", re.compile(r"(?<![\w.])F\s*\(\s*(?P<df1>\d+(?:\.\d+)?)\s*,\s*(?P<df2>\d+(?:\.\d+)?)\s*\)\s*=\s*(?P<stat>[-+]?\d+(?:\.\d+)?)", re.I)),
    ("chi2", re.compile(r"(?:χ2|χ²|chi2|chi-square|chi squared)\s*\(\s*(?P<df1>\d+(?:\.\d+)?)\s*\)\s*=\s*(?P<stat>[-+]?\d+(?:\.\d+)?)", re.I)),
    ("z", re.compile(r"(?<![\w.])z\s*=\s*(?P<stat>[-+]?\d+(?:\.\d+)?)", re.I)),
    ("r", re.compile(r"(?<![\w.])r\s*\(\s*(?P<df1>\d+(?:\.\d+)?)\s*\)\s*=\s*(?P<stat>[-+]?\d*\.\d+)", re.I)),
]
P_VALUE = re.compile(r"\bp\s*(?P<op><|>|=|≤|≥)\s*(?P<p>\d+\.\d+|0?\.\d+|[01])(?!\d)", re.I)
MEAN = re.compile(r"\b(?:M|Mean|mean)\s*=\s*(?P<mean>-?\d+\.\d+)\b")
SAMPLE_N = re.compile(r"\b[Nn]\s*=\s*(?P<n>\d+)\b")
GRIM_SCALES = [(1, 5), (1, 7), (0, 10), (1, 10), (0, 4), (1, 100), (0, 100)]


def docx_text(path):
    with zipfile.ZipFile(path) as archive:
        info = archive.getinfo("word/document.xml")
        if info.file_size > MAX_DOCX_XML_BYTES:
            raise ValueError("docx document.xml is too large to audit safely")
        xml = archive.read(info)
    root = ElementTree.fromstring(xml)
    lines = []
    for paragraph in root.iter(f"{WORD_NS}p"):
        text = "".join(node.text or "" for node in paragraph.iter(f"{WORD_NS}t"))
        lines.append(text)
    return "\n".join(lines)


def read_source(request):
    text = request.get("text")
    path = request.get("path")
    if text:
        return None, str(text)
    if not path:
        raise ValueError("give a path or text")
    lower = path.lower()
    if lower.endswith(".docx"):
        return path, docx_text(path)
    if not lower.endswith((".tex", ".md", ".markdown", ".txt", ".text")):
        raise ValueError("path must end in .tex, .md, .txt, or .docx")
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return path, handle.read()


def recompute_p(kind, statistic, df1, df2):
    if scipy_stats is None:
        raise RuntimeError("scipy is required for stat_audit (pip install scipy)")
    if kind == "t":
        return float(2 * scipy_stats.t.sf(abs(statistic), df1))
    if kind == "F":
        return float(scipy_stats.f.sf(statistic, df1, df2))
    if kind == "chi2":
        return float(scipy_stats.chi2.sf(statistic, df1))
    if kind == "z":
        return float(2 * scipy_stats.norm.sf(abs(statistic)))
    if kind == "r":
        if abs(statistic) >= 1:
            return None
        t_value = statistic * math.sqrt(df1 / (1 - statistic * statistic))
        return float(2 * scipy_stats.t.sf(abs(t_value), df1))
    return None


def p_value_issue(reported, op, recomputed):
    if recomputed is None:
        return "invalid_statistic"
    if op == "=":
        if reported == 0:
            return "p_reported_zero"
        tolerance = max(0.01, 0.25 * reported)
        if abs(reported - recomputed) > tolerance:
            return "incompatible_statistic_and_p"
        return None
    if op in ("≤", "<="):
        return None if recomputed <= reported + 0.005 else "p_claim_false"
    if op in ("<",):
        return None if recomputed < reported + 0.005 else "p_claim_false"
    if op in ("≥", ">=", ">"):
        return None if recomputed >= reported - 0.005 else "p_claim_false"
    return None


def grim_possible(mean, n):
    return [
        (low, high)
        for low, high in GRIM_SCALES
        if low <= mean <= high and abs(mean * n - round(mean * n)) < 1e-6
    ]


def stat_label(kind, df1, df2, statistic):
    if df1 is None:
        return f"{kind} = {statistic:g}"
    df_text = f"{df1:g}, {df2:g}" if df2 is not None else f"{df1:g}"
    return f"{kind}({df_text}) = {statistic:g}"


def line_number(content, index):
    return content.count("\n", 0, index) + 1


def context_of(content, index):
    start = content.rfind("\n", 0, index) + 1
    end = content.find("\n", index)
    if end == -1:
        end = len(content)
    return content[start:end].strip()[:400]


def audit(request):
    file_name, content = read_source(request)
    alpha = float(request.get("alpha") or 0.05)
    rows = []
    seen = set()

    for kind, pattern in STAT_PATTERNS:
        for match in pattern.finditer(content):
            tail = content[match.end(): match.end() + 60]
            p_match = P_VALUE.search(tail)
            if not p_match:
                continue
            df1 = float(match.group("df1")) if "df1" in match.groupdict() and match.group("df1") else None
            df2 = float(match.group("df2")) if "df2" in match.groupdict() and match.group("df2") else None
            statistic = float(match.group("stat"))
            reported = float(p_match.group("p"))
            op = p_match.group("op")
            key = (kind, int(df1 or 0), int(df2 or 0), round(statistic, 6), round(reported, 6), op)
            if key in seen:
                continue
            seen.add(key)
            recomputed = None
            try:
                recomputed = recompute_p(kind, statistic, df1, df2)
            except Exception as error:  # pragma: no cover
                rows.append({
                    "line": line_number(content, match.start()),
                    "statistic": stat_label(kind, df1, df2, statistic),
                    "reported_p": reported,
                    "recomputed_p": None,
                    "issue": "recompute_failed",
                    "context": context_of(content, match.start()),
                    "detail": str(error),
                })
                continue
            issue = p_value_issue(reported, op, recomputed)
            if issue:
                rows.append({
                    "line": line_number(content, match.start()),
                    "statistic": stat_label(kind, df1, df2, statistic),
                    "reported_p": f"{op} {reported:g}",
                    "recomputed_p": round(recomputed, 6) if recomputed is not None else None,
                    "alpha": alpha,
                    "issue": issue,
                    "context": context_of(content, match.start()),
                })

    grim_checked = 0
    grim_flagged = 0
    if request.get("grim"):
        for mean_match in MEAN.finditer(content):
            after = SAMPLE_N.search(content, mean_match.end(), min(len(content), mean_match.end() + 80))
            before = None
            for candidate in SAMPLE_N.finditer(content, max(0, mean_match.start() - 80), mean_match.start()):
                before = candidate
            n_match = after or before
            if not n_match:
                continue
            n = int(n_match.group("n"))
            if n < 2:
                continue
            mean = float(mean_match.group("mean"))
            grim_checked += 1
            possible = grim_possible(mean, n)
            if not possible:
                grim_flagged += 1
                rows.append({
                    "line": line_number(content, mean_match.start()),
                    "statistic": f"M = {mean:g}, N = {n}",
                    "reported_p": None,
                    "recomputed_p": None,
                    "issue": "grim_inconsistent",
                    "context": context_of(content, mean_match.start()),
                    "scales_tested": [f"{low}-{high}" for low, high in GRIM_SCALES],
                })

    rows.sort(key=lambda row: (row["line"], row["issue"]))
    notes = [
        "Candidate inconsistencies for human review, not misconduct.",
        "GRIM assumes an integer response scale; a flag means the mean is impossible on every tested scale.",
        "GRIMMER (SD consistency) is not implemented.",
    ]
    if scipy_stats is None:
        notes.append("scipy is not installed; p-value recomputation was skipped.")
    return {
        "file": file_name,
        "alpha": alpha,
        "rows": rows,
        "summary": {
            "flagged": len(rows),
            "grim_checked": grim_checked,
            "grim_flagged": grim_flagged,
        },
        "notes": notes,
    }


def main():
    try:
        request = json.load(sys.stdin)
        print(json.dumps(audit(request), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
