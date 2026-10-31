#!/usr/bin/env python3
"""Render a PRISMA-style flow diagram from a review ledger JSON request.

The request is produced by review.js. This helper is dependency-free: it reads
JSON on stdin and writes one JSON object on stdout. Counts are never invented;
missing counts are rendered as "not recorded" and listed as warnings.
"""
import html
import json
import sys
import textwrap
from datetime import datetime, timezone


def as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def n_text(value):
    return "not recorded" if value is None else str(value)


def esc(value):
    return html.escape(str(value), quote=True)


def wrap(value, width):
    return textwrap.wrap(str(value), width=max(10, width)) or [""]


def text_block(x, y, lines, size=14, weight="normal", fill="#1f2937", width=52, line_height=20):
    out = []
    current = y
    for line in lines:
        for part in wrap(line, width):
            out.append(
                f'<text x="{x}" y="{current}" font-size="{size}" '
                f'font-weight="{weight}" fill="{fill}">{esc(part)}</text>'
            )
            current += line_height
    return "\n".join(out), current


def box(x, y, width, height, title, lines, fill="#f8fafc", stroke="#334155", title_size=15):
    chars = max(18, int((width - 36) / 7.2))
    body, _ = text_block(x + 18, y + 26, [title], size=title_size, weight="bold", width=chars, line_height=18)
    details, _ = text_block(x + 18, y + 64, lines, size=12, width=chars, line_height=18)
    return (
        f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="10" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="2"/>\n{body}\n{details}'
    )


def arrow(x1, y1, x2, y2):
    return (
        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#334155" '
        f'stroke-width="2" marker-end="url(#arrowhead)"/>'
    )


def reason_lines(reasons, stage, limit=3):
    rows = [row for row in reasons if row.get("stage") == stage]
    rows.sort(key=lambda row: (-as_int(row.get("count")) if as_int(row.get("count")) is not None else 0, str(row.get("reason", ""))))
    lines = []
    for row in rows[:limit]:
        lines.append(f"{row.get('reason') or '(no reason)'}: {n_text(as_int(row.get('count')))}")
    if len(rows) > limit:
        lines.append(f"+{len(rows) - limit} more reason(s)")
    return lines


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as error:
        print(json.dumps({"error": f"invalid request JSON: {error}"}))
        return

    screening = request.get("screening") or {}
    title = screening.get("title_abstract") or {}
    full = screening.get("full_text") or {}
    search = request.get("search") or {}
    databases = [str(item) for item in (request.get("databases") or []) if str(item).strip()]
    included = request.get("included") or []
    included_count = len(included) if isinstance(included, list) else as_int(included)

    records_total = as_int(request.get("records_total"))
    added = as_int(search.get("added"))
    skipped = as_int(search.get("skipped"))
    queries = as_int(search.get("queries"))
    duplicates = skipped
    identified = None
    if added is not None or skipped is not None:
        identified = (added or 0) + (skipped or 0)
    if records_total is not None and duplicates is not None:
        identified = max(identified or 0, records_total + duplicates)

    title_excluded = as_int(title.get("exclude"))
    title_maybe = as_int(title.get("maybe"))
    title_pending = as_int(title.get("pending"))
    title_conflict = as_int(title.get("conflict"))
    full_include = as_int(full.get("include"))
    full_excluded = as_int(full.get("exclude"))
    full_maybe = as_int(full.get("maybe"))
    full_pending = as_int(full.get("pending"))
    full_conflict = as_int(full.get("conflict"))
    full_assessed = None
    if any(value is not None for value in [full_include, full_excluded, full_maybe, full_pending, full_conflict]):
        full_assessed = sum(value or 0 for value in [full_include, full_excluded, full_maybe, full_pending, full_conflict])

    warnings = []
    for label, value in [
        ("records identified", identified),
        ("duplicates removed", duplicates),
        ("records screened", records_total),
        ("title/abstract exclusions", title_excluded),
        ("full-text assessed", full_assessed),
        ("full-text exclusions", full_excluded),
        ("studies included", included_count),
    ]:
        if value is None:
            warnings.append(f"{label} is not recorded")
    if not databases:
        warnings.append("no databases are recorded in the protocol")
    unresolved = sum(value or 0 for value in [title_maybe, title_pending, full_maybe, full_pending])
    conflicts = (title_conflict or 0) + (full_conflict or 0)
    if unresolved:
        warnings.append(f"{unresolved} maybe/pending decision(s) remain; resolve them before reporting a final flow")
    if conflicts:
        warnings.append(f"{conflicts} conflict(s) remain; resolve them before reporting a final flow")

    reasons = request.get("exclusion_reasons") or []
    title_reasons = reason_lines(reasons, "title_abstract")
    full_reasons = reason_lines(reasons, "full_text")

    width = 1180
    main_x, main_w = 300, 500
    side_x, side_w = 850, 290
    top = 110
    step = 170
    main_h = 108
    side_h = 128
    rows = 5
    height = top + rows * step + 120

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="prisma-title prisma-desc">',
        '<defs><marker id="arrowhead" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#334155"/></marker></defs>',
        '<style>text{font-family:Inter,Segoe UI,Arial,sans-serif;}</style>',
        f'<rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>',
        f'<text id="prisma-title" x="40" y="46" font-size="24" font-weight="bold" fill="#0f172a">PRISMA-style flow — {esc(request.get("slug") or "review")}</text>',
        f'<text id="prisma-desc" x="40" y="74" font-size="14" fill="#475569">{esc(request.get("question") or "")}</text>',
    ]

    y1 = top
    y2 = top + step
    y3 = top + step * 2
    y4 = top + step * 3
    y5 = top + step * 4

    parts.append(box(main_x, y1, main_w, main_h, f"Records identified (n = {n_text(identified)})", [
        f"Queries: {n_text(queries)}",
        f"Sources: {', '.join(databases) if databases else 'not recorded'}",
    ], fill="#eef4ff"))
    parts.append(arrow(main_x + main_w / 2, y1 + main_h, main_x + main_w / 2, y2))
    parts.append(box(main_x, y2, main_w, main_h, f"Duplicates removed (n = {n_text(duplicates)})", [
        "Duplicate records removed before screening.",
    ]))
    parts.append(arrow(main_x + main_w / 2, y2 + main_h, main_x + main_w / 2, y3))
    parts.append(box(main_x, y3, main_w, main_h, f"Records screened (n = {n_text(records_total)})", [
        f"Title/abstract: include {n_text(as_int(title.get('include')))} · exclude {n_text(title_excluded)} · maybe {n_text(title_maybe)}",
        f"Pending {n_text(title_pending)} · conflicts {n_text(title_conflict)}",
    ]))
    parts.append(arrow(main_x + main_w, y3 + main_h / 2, side_x, y3 + side_h / 2))
    parts.append(box(side_x, y3 - 10, side_w, side_h, f"Excluded at title/abstract (n = {n_text(title_excluded)})", title_reasons or ["No exclusion reasons recorded."], fill="#fff1f2"))
    parts.append(arrow(main_x + main_w / 2, y3 + main_h, main_x + main_w / 2, y4))
    parts.append(box(main_x, y4, main_w, main_h, f"Full-text assessed (n = {n_text(full_assessed)})", [
        f"Full text: include {n_text(full_include)} · exclude {n_text(full_excluded)} · maybe {n_text(full_maybe)}",
        f"Pending {n_text(full_pending)} · conflicts {n_text(full_conflict)}",
    ]))
    parts.append(arrow(main_x + main_w, y4 + main_h / 2, side_x, y4 + side_h / 2))
    parts.append(box(side_x, y4 - 10, side_w, side_h, f"Excluded at full text (n = {n_text(full_excluded)})", full_reasons or ["No exclusion reasons recorded."], fill="#fff1f2"))
    parts.append(arrow(main_x + main_w / 2, y4 + main_h, main_x + main_w / 2, y5))
    parts.append(box(main_x, y5, main_w, main_h, f"Studies included (n = {n_text(included_count)})", [
        "Full-text includes recorded in the ledger.",
    ], fill="#eefaf1"))

    footer_y = y5 + main_h + 46
    parts.append(f'<text x="40" y="{footer_y}" font-size="12" fill="#64748b">PRISMA-style flow derived from recorded ledger events; it is not a compliance statement. Ledger hash: {esc(request.get("ledger_hash") or "not recorded")}. Generated: {esc(request.get("generated_at") or datetime.now(timezone.utc).isoformat())}</text>')
    if warnings:
        warning_text = "Warnings: " + " | ".join(warnings)
        parts.append(f'<text x="40" y="{footer_y + 22}" font-size="12" fill="#b91c1c">{esc(warning_text)}</text>')
    parts.append("</svg>")

    counts = {
        "identified": identified,
        "duplicates_removed": duplicates,
        "screened": records_total,
        "title_excluded": title_excluded,
        "full_text_assessed": full_assessed,
        "full_text_excluded": full_excluded,
        "included": included_count,
        "maybe_pending": unresolved,
        "conflicts": conflicts,
    }
    print(json.dumps({"svg": "\n".join(parts), "counts": counts, "warnings": warnings}))


if __name__ == "__main__":
    main()
