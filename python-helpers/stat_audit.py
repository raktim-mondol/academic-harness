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

from document_text import read_source

try:
    from scipy import stats as scipy_stats
except Exception:  # pragma: no cover - surfaced to the caller
    scipy_stats = None

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


CI_RE = re.compile(
    r"(?:(?P<level>\d{2})\s*%\s*)?(?:CI|confidence interval)\s*[:\-=]?\s*[\[\(]?\s*"
    r"(?P<low>-?\d+(?:\.\d+)?)\s*(?:to|–|—|-|,)\s*(?P<high>-?\d+(?:\.\d+)?)",
    re.I,
)
ESTIMATE_BEFORE_CI = re.compile(
    r"(?P<label>OR|RR|HR|IRR|SMD|MD|WMD|beta|β|estimate|mean difference|risk ratio|odds ratio|hazard ratio)"
    r"\s*(?:=|:|of)?\s*(?P<value>-?\d+(?:\.\d+)?)\s*(?:[\(\[,]\s*)?$",
    re.I,
)
ESTIMATE_PAREN_CI = re.compile(
    r"(?P<value>-?\d+(?:\.\d+)?)\s*[\(\[]\s*(?:(?:\d{2})\s*%\s*)?(?:CI|confidence interval)",
    re.I,
)
TOTAL_N_RE = re.compile(r"\bN\s*=\s*(?P<value>-?\d+(?:\.\d+)?)\b")
SUBGROUP_N_RE = re.compile(r"\bn\s*=\s*(?P<value>-?\d+(?:\.\d+)?)\b")
COUNTED_RE = re.compile(r"\b(?P<value>\d[\d,]*)\s+(?:participants|patients|subjects|samples|records|studies|items)\b", re.I)
FLOW_RE = re.compile(r"\b(randomi[sz]ed|allocated|analy[sz]ed|screened|included|enrolled)\s*[:=]?\s*(?:n\s*=\s*)?(?P<value>\d[\d,]*)\b", re.I)
FRACTION_PERCENT_RE = re.compile(r"(?P<num>\d[\d,]*)\s*/\s*(?P<den>\d[\d,]*)\s*\(\s*(?P<pct>\d+(?:\.\d+)?)\s*%\s*\)")
PERCENT_RE = re.compile(r"(?P<prefix>[<>≤≥]?)\s*(?P<value>-?\d+(?:\.\d+)?)\s*%")
STANDALONE_P_RE = re.compile(r"\bp\s*(?P<op><|>|=|≤|≥|<=|>=)\s*(?P<value>-?\d+(?:\.\d+)?)", re.I)
TABLE_ROW_MD = re.compile(r"^\s*\|.*\|\s*$")
TABLE_ROW_TEX = re.compile(r"^\s*[^%]*&[^%]*\\\\\s*$")


def normalize_section(name):
    value = re.sub(r"[^a-z0-9 ]+", " ", str(name or "").lower()).strip()
    if "abstract" in value:
        return "abstract"
    if any(word in value for word in ("method", "material", "participant", "procedure")):
        return "methods"
    if any(word in value for word in ("result", "finding", "outcome", "analysis")):
        return "results"
    if any(word in value for word in ("discussion", "conclusion", "limitation")):
        return "discussion"
    if any(word in value for word in ("reference", "bibliograph", "literature cited")):
        return "references"
    if any(word in value for word in ("table", "figure")):
        return "tables"
    return "other"


def section_ranges(content):
    ranges = []
    for match in re.finditer(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", content, re.S | re.I):
        ranges.append((match.start(), match.end(), "abstract"))
    headings = []
    for match in re.finditer(r"\\(?:section|chapter|subsection)\*?\{([^{}]*)\}", content):
        headings.append((match.start(), normalize_section(match.group(1))))
    for match in re.finditer(r"^(#{1,4})\s+(.+)$", content, re.M):
        headings.append((match.start(), normalize_section(match.group(2))))
    headings.sort(key=lambda item: item[0])
    for index, (start, name) in enumerate(headings):
        end = headings[index + 1][0] if index + 1 < len(headings) else len(content)
        ranges.append((start, end, name))
    return ranges


def section_at(ranges, index):
    matches = [
        (end - start, name)
        for start, end, name in ranges
        if start <= index < end
    ]
    return min(matches)[1] if matches else "other"


def line_of(content, index):
    return content.count("\n", 0, index) + 1


def context_at(content, index, limit=400):
    start = content.rfind("\n", 0, index) + 1
    end = content.find("\n", index)
    if end == -1:
        end = len(content)
    return content[start:end].strip()[:limit]


def number_token(value):
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def ignored_number_context(content, index):
    window = content[max(0, index - 120): index + 120]
    line = context_at(content, index, 500)
    if re.search(r"\\cite[tp]?\{|\\ref\{|\\eqref\{|doi|arxiv|https?://|www\.", window, re.I):
        return True
    if re.fullmatch(r"\s*(?:19|20)\d{2}\s*", line):
        return True
    return False


def add_row(rows, seen, kind, line, detail, **extra):
    key = (kind, line, detail)
    if key in seen:
        return
    seen.add(key)
    row = {"kind": kind, "line": line, "detail": detail}
    row.update({key: value for key, value in extra.items() if value is not None})
    rows.append(row)


def numbers_audit(request):
    file_name, content = read_source(request)
    if str(file_name or request.get("path") or "").lower().endswith(".tex"):
        content = re.sub(r"(?<!\\)%.*$", "", content, flags=re.M)
        request = dict(request)
        request["text"] = content
        request["path"] = None
    sections = section_ranges(content)
    rows = []
    seen = set()
    not_checked = []
    counts = {"p_values": 0, "ci": 0, "n": 0, "percentages": 0, "tables": 0, "effects": 0}

    lines = content.split("\n")
    line_offsets = []
    offset = 0
    for line in lines:
        line_offsets.append(offset)
        offset += len(line) + 1

    def offset_of_line(number):
        return line_offsets[number - 1] if 1 <= number <= len(line_offsets) else 0

    # Existing test-statistic + p recomputation is reused unchanged.
    base = audit(request)
    for row in base.get("rows", []):
        issue = row.get("issue", "p_value")
        kind = "grim" if issue.startswith("grim") else "p_value"
        if kind == "p_value":
            counts["p_values"] += 1
        add_row(
            rows, seen, kind, row.get("line"),
            issue,
            section=section_at(sections, offset_of_line(row.get("line") or 1)),
            statistic=row.get("statistic"),
            reported_p=row.get("reported_p"),
            recomputed_p=row.get("recomputed_p"),
            context=row.get("context"),
        )

    # Standalone p-value sanity: impossible ranges and reported zeros.
    for match in STANDALONE_P_RE.finditer(content):
        if ignored_number_context(content, match.start()):
            continue
        line = line_of(content, match.start())
        section = section_at(sections, match.start())
        if section == "references":
            continue
        counts["p_values"] += 1
        value = float(match.group("value"))
        if value < 0 or value > 1:
            add_row(rows, seen, "p_value", line, f"p-value outside [0, 1]: {match.group(0).strip()}",
                    section=section, context=context_at(content, match.start()))
        elif match.group("op") == "=" and value == 0:
            add_row(rows, seen, "p_value", line, "reported p = 0; report p < 0.001 instead",
                    section=section, context=context_at(content, match.start()))

    # Confidence intervals and their nearby estimate.
    for match in CI_RE.finditer(content):
        if ignored_number_context(content, match.start()):
            continue
        line = line_of(content, match.start())
        section = section_at(sections, match.start())
        if section == "references":
            continue
        counts["ci"] += 1
        low = float(match.group("low"))
        high = float(match.group("high"))
        level = match.group("level")
        before = content[max(0, match.start() - 120): match.start()]
        estimate_match = ESTIMATE_BEFORE_CI.search(before) or ESTIMATE_PAREN_CI.search(before)
        label = estimate_match.group("label") if estimate_match and "label" in estimate_match.groupdict() else None
        estimate = float(estimate_match.group("value")) if estimate_match else None
        if low == high:
            add_row(rows, seen, "ci", line, f"confidence interval has zero width: {low:g} to {high:g}",
                    section=section, context=context_at(content, match.start()))
        elif low > high:
            add_row(rows, seen, "ci", line, f"confidence interval is reversed: {low:g} to {high:g}",
                    section=section, context=context_at(content, match.start()))
        if estimate is not None:
            counts["effects"] += 1
            if not (low <= estimate <= high):
                add_row(rows, seen, "effect_ci", line,
                        f"estimate {estimate:g} lies outside its confidence interval {low:g} to {high:g}",
                        section=section, label=label, estimate=estimate, ci=[low, high],
                        context=context_at(content, match.start()))
            if label and re.fullmatch(r"(?:OR|RR|HR|IRR|odds ratio|risk ratio|hazard ratio)", label, re.I) and (low <= 0 or estimate <= 0):
                add_row(rows, seen, "effect_ci", line,
                        f"ratio measure {label} has a non-positive value or interval bound ({low:g} to {high:g})",
                        section=section, label=label, estimate=estimate, ci=[low, high],
                        context=context_at(content, match.start()))
        elif level and level not in ("90", "95", "99"):
            not_checked.append(f"line {line}: confidence level {level}% not checked by a fixed rule")

    # Total N by section, subgroup n, counted participants, and flow counts.
    total_by_section = {}
    for match in TOTAL_N_RE.finditer(content):
        if ignored_number_context(content, match.start()):
            continue
        line = line_of(content, match.start())
        section = section_at(sections, match.start())
        if section == "references":
            continue
        counts["n"] += 1
        value = number_token(match.group("value"))
        if value is None:
            continue
        if value < 0:
            add_row(rows, seen, "n", line, f"negative sample size: N = {match.group('value')}",
                    section=section, context=context_at(content, match.start()))
        elif value != int(value):
            add_row(rows, seen, "n", line, f"fractional sample size: N = {match.group('value')}",
                    section=section, context=context_at(content, match.start()))
        else:
            total_by_section.setdefault(section, []).append((line, int(value), context_at(content, match.start())))

    distinct_totals = {}
    for section, values in total_by_section.items():
        for line, value, context in values:
            distinct_totals.setdefault(value, []).append((section, line, context))
    if len(distinct_totals) > 1 and total_by_section:
        first_line = min(line for value in distinct_totals.values() for _, line, _ in value)
        summary = "; ".join(
            f"N={value} in {', '.join(sorted({section for section, _, _ in entries}))}"
            for value, entries in sorted(distinct_totals.items())
        )
        add_row(rows, seen, "n_inconsistent", first_line,
                f"different total sample sizes recorded: {summary}",
                section="multiple", context="; ".join(entry[2] for entries in distinct_totals.values() for entry in entries[:1])[:400])

    for section, values in total_by_section.items():
        max_total = max(value for _, value, _ in values)
        for match in SUBGROUP_N_RE.finditer(content):
            if section_at(sections, match.start()) != section:
                continue
            value = number_token(match.group("value"))
            if value is None:
                continue
            counts["n"] += 1
            if value < 0:
                add_row(rows, seen, "n", line_of(content, match.start()), f"negative subgroup size: n = {match.group('value')}",
                        section=section, context=context_at(content, match.start()))
            elif value > max_total:
                add_row(rows, seen, "n_subgroup", line_of(content, match.start()),
                        f"subgroup n = {int(value)} exceeds the largest total N = {max_total} in {section}",
                        section=section, context=context_at(content, match.start()))
    for match in COUNTED_RE.finditer(content):
        if ignored_number_context(content, match.start()):
            continue
        section = section_at(sections, match.start())
        if section in ("references", "other"):
            continue
        counts["n"] += 1
        value = number_token(match.group("value"))
        if value == 0:
            add_row(rows, seen, "n", line_of(content, match.start()), f"zero participants recorded: {match.group(0).strip()}",
                    section=section, context=context_at(content, match.start()))

    flow_counts = {}
    for match in FLOW_RE.finditer(content):
        if ignored_number_context(content, match.start()):
            continue
        section = section_at(sections, match.start())
        if section == "references":
            continue
        flow_counts.setdefault(match.group(1).lower(), []).append((line_of(content, match.start()), int(match.group("value")), context_at(content, match.start())))
    for earlier, later in [("randomized", "analyzed"), ("randomized", "analysed"), ("screened", "included"), ("allocated", "analyzed")]:
        earlier_values = flow_counts.get(earlier, [])
        later_values = flow_counts.get(later, [])
        if earlier_values and later_values and later_values[-1][1] > earlier_values[-1][1]:
            add_row(rows, seen, "flow_count", later_values[-1][0],
                    f"{later} count ({later_values[-1][1]}) exceeds the earlier {earlier} count ({earlier_values[-1][1]})",
                    section=section_at(sections, offset_of_line(later_values[-1][0])), context=later_values[-1][2])

    # Fractions with percentages and standalone percentages.
    for match in FRACTION_PERCENT_RE.finditer(content):
        if ignored_number_context(content, match.start()):
            continue
        line = line_of(content, match.start())
        section = section_at(sections, match.start())
        if section == "references":
            continue
        counts["percentages"] += 1
        numerator = number_token(match.group("num"))
        denominator = number_token(match.group("den"))
        reported = float(match.group("pct"))
        if denominator and denominator > 0:
            expected = 100.0 * numerator / denominator
            if abs(expected - reported) > 0.6:
                add_row(rows, seen, "percentage", line,
                        f"percentage {reported:g}% does not match {int(numerator)}/{int(denominator)} = {expected:.1f}%",
                        section=section, context=context_at(content, match.start()))
        elif denominator == 0:
            add_row(rows, seen, "percentage", line, "division by zero in a reported percentage",
                    section=section, context=context_at(content, match.start()))
    for match in PERCENT_RE.finditer(content):
        if ignored_number_context(content, match.start()):
            continue
        section = section_at(sections, match.start())
        if section == "references":
            continue
        value = float(match.group("value"))
        counts["percentages"] += 1
        if value < 0 or value > 100:
            add_row(rows, seen, "percentage", line_of(content, match.start()),
                    f"percentage outside 0–100: {match.group(0).strip()}",
                    section=section, context=context_at(content, match.start()))

    # Table rows: compare a labelled single value with the same label in text.
    table_lines = set()
    table_rows = []
    for index, line in enumerate(lines, start=1):
        if TABLE_ROW_MD.match(line) and not re.fullmatch(r"\s*\|?[\s:|-]+\|?\s*", line):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) >= 2:
                table_lines.add(index)
                table_rows.append((index, cells))
        elif TABLE_ROW_TEX.match(line) and "&" in line:
            cells = [re.sub(r"\\(?:toprule|midrule|bottomrule|hline)", "", cell).strip() for cell in line.split("&")]
            if len(cells) >= 2:
                table_lines.add(index)
                table_rows.append((index, cells))
    text_no_tables = "\n".join(line for index, line in enumerate(lines, start=1) if index not in table_lines)
    matched_table_rows = 0
    for line_number, cells in table_rows:
        label = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?", "", cells[0])
        label = re.sub(r"[^A-Za-z0-9 .%/-]+", " ", label).strip()
        number_cells = [cell for cell in cells[1:] if re.fullmatch(r"\s*-?\d+(?:\.\d+)?\s*", cell)]
        if len(label.split()) < 2 or len(number_cells) != 1:
            continue
        counts["tables"] += 1
        table_value = float(number_cells[0])
        found = False
        for occurrence in re.finditer(re.escape(label), text_no_tables, re.I):
            left = max(text_no_tables.rfind(".", 0, occurrence.start()), text_no_tables.rfind("\n\n", 0, occurrence.start()))
            right_candidates = [
                index for index in (
                    text_no_tables.find(".", occurrence.end()),
                    text_no_tables.find("\n\n", occurrence.end()),
                ) if index != -1
            ]
            right = min(right_candidates) if right_candidates else len(text_no_tables)
            window = text_no_tables[left + 1:right + 1]
            values = [float(value.replace(",", "")) for value in re.findall(r"\b\d[\d,]*(?:\.\d+)?\b", window)]
            if not values:
                continue
            if any(abs(value - table_value) < 1e-9 for value in values):
                found = True
                matched_table_rows += 1
                break
            add_row(rows, seen, "table_text", line_number,
                    f"table row “{label}” reports {table_value:g}, but the matching text gives {values[:4]}",
                    section=section_at(sections, offset_of_line(line_number)),
                    values=values[:4], table_value=table_value)
            found = True
            break
        if not found:
            not_checked.append(f"line {line_number}: table row “{label}” has no unambiguous matching sentence")

    if not_checked:
        not_checked.append("unit consistency and effect-size plausibility are not checked automatically")
    if not request.get("grim"):
        not_checked.append("GRIM/GRIMMER were not run (pass grim=true to check reported means)")

    rows.sort(key=lambda row: (row["line"], row["kind"]))
    by_kind = {}
    for row in rows:
        by_kind[row["kind"]] = by_kind.get(row["kind"], 0) + 1
    checked = counts["p_values"] + counts["ci"] + counts["n"] + counts["percentages"] + counts["tables"]
    notes = [
        *[note for note in base.get("notes", []) if "Candidate inconsistencies" not in note and "GRIM assumes" not in note and "GRIMMER" not in note],
        "Candidate numerical-reporting inconsistencies for human review, not a verdict on validity or misconduct.",
        "Only explicit, locally checkable patterns are tested; unmatched values and units stay not_checked.",
        "Percentages are compared with an absolute tolerance of 0.6 percentage points to allow rounding.",
    ]
    if not rows:
        notes.append("No candidate inconsistencies were detected in the tested patterns.")
    return {
        "file": file_name,
        "mode": "numbers",
        "rows": rows,
        "summary": {
            "checked": checked,
            "flagged": len(rows),
            "not_checked": len(not_checked),
            "matched_table_rows": matched_table_rows,
            "by_kind": by_kind,
            **counts,
        },
        "sections": [
            {"name": name, "start_line": line_of(content, start), "end_line": line_of(content, max(start, end - 1))}
            for start, end, name in sections
        ],
        "not_checked": not_checked,
        "notes": notes,
    }


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
        result = numbers_audit(request) if request.get("mode") == "numbers" else audit(request)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
