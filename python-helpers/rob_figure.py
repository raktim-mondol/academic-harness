"""Render risk-of-bias traffic-light and summary SVGs.

Reads one JSON request from stdin and prints one JSON object on stdout. The
request supplies domains, a colour/symbol scale, and per-study cell values;
the helper draws nothing else and never decides a judgement.
"""

import io
import json
import re
import sys

MAX_STUDIES = 200
MAX_DOMAINS = 24
MAX_LABEL = 60
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_STYLE = {"color": "#9e9e9e", "symbol": "?"}


def truncate(value, limit=MAX_LABEL):
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def bad_request(message):
    return {"error": message, "code": "bad_request"}


def normalise_style(entry):
    color = str(entry.get("color") or "")
    symbol = str(entry.get("symbol") or "?")
    return {
        "color": color if HEX.match(color) else DEFAULT_STYLE["color"],
        "symbol": symbol[:2],
    }


def build_scale(scale):
    styles = {}
    labels = []
    for entry in scale:
        if not isinstance(entry, dict) or not entry.get("id"):
            raise ValueError("each scale entry needs an id")
        item = {
            "id": str(entry["id"]),
            "label": truncate(entry.get("label") or entry["id"]),
            **normalise_style(entry),
        }
        styles[item["id"]] = item
        labels.append(item)
    if not labels:
        raise ValueError("scale must not be empty")
    return styles, labels


def render_svg(figure):
    buffer = io.StringIO()
    figure.savefig(buffer, format="svg", metadata={"Date": None})
    return buffer.getvalue()


def traffic_svg(title, note, domains, styles, studies, warnings):
    from matplotlib.figure import Figure
    from matplotlib.patches import Patch, Rectangle

    width = max(7.5, 1.45 * max(1, len(domains)) + 3.8)
    height = max(4.6, min(60.0, 0.32 * max(1, len(studies)) + 0.18 * len(domains) + 3.4))
    figure = Figure(figsize=(width, height))
    axes = figure.add_axes([0.24, 0.2, 0.72, 0.5])
    figure.text(0.5, 0.94, title, ha="center", va="top", fontsize=11)
    if note:
        figure.text(0.5, 0.985, truncate(note, 180), ha="center", va="top",
                    fontsize=6, color="#616161", wrap=True)
    axes.set_xlim(0, len(domains))
    axes.set_ylim(0, max(1, len(studies)))
    axes.invert_yaxis()
    axes.set_xticks([index + 0.5 for index in range(len(domains))])
    axes.set_xticklabels([truncate(domain["label"], 32) for domain in domains],
                         rotation=35, ha="right", va="bottom", fontsize=6.5,
                         rotation_mode="anchor")
    axes.xaxis.tick_top()
    axes.tick_params(axis="x", length=0, pad=4)
    axes.set_yticks([index + 0.5 for index in range(len(studies))])
    axes.set_yticklabels([truncate(study["label"], 40) for study in studies], fontsize=7)
    axes.tick_params(axis="y", length=0)
    for spine in axes.spines.values():
        spine.set_visible(False)

    used = {}
    for row, study in enumerate(studies):
        for column, domain in enumerate(domains):
            cell = (study.get("cells") or {}).get(domain["id"]) or {}
            raw = cell.get("value")
            value = "pending" if raw is None or raw == "" else str(raw)
            style = styles.get(value)
            if style is None:
                warnings.append(f"unknown value {value!r} for {study.get('id')} {domain['id']}; using pending")
                style = styles.get("pending", DEFAULT_STYLE)
            used[style["id"]] = style
            axes.add_patch(Rectangle((column + 0.06, row + 0.06), 0.88, 0.88,
                                     facecolor=style["color"], edgecolor="white", linewidth=1.2))
            axes.text(column + 0.5, row + 0.54, style["symbol"], ha="center", va="center",
                      fontsize=10, color="white", fontweight="bold")

    if not studies:
        axes.text(len(domains) / 2 if domains else 0.5, 0.5, "No included studies",
                  ha="center", va="center", fontsize=10, color="#616161")

    handles = [Patch(facecolor=item["color"], edgecolor="white", label=f"{item['symbol']} {item['label']}")
               for item in styles.values()]
    figure.legend(handles=handles, loc="lower center", ncol=min(4, len(handles)),
                  fontsize=7, frameon=False, bbox_to_anchor=(0.5, 0.01))
    return render_svg(figure)


def summary_svg(title, note, domains, styles, studies, warnings):
    from matplotlib.figure import Figure
    from matplotlib.patches import Patch

    order = [item["id"] for item in styles.values()]
    counts = []
    for domain in domains:
        row = {value: 0 for value in order}
        for study in studies:
            cell = (study.get("cells") or {}).get(domain["id"]) or {}
            raw = cell.get("value")
            value = "pending" if raw is None or raw == "" else str(raw)
            if value not in row:
                warnings.append(f"unknown value {value!r} for {study.get('id')} {domain['id']}; counting as pending")
                value = "pending" if "pending" in row else order[0]
            row[value] += 1
        counts.append(row)

    width = max(9.0, min(16.0, 0.6 * max(1, len(studies)) + 6.0))
    height = max(3.4, min(60.0, 0.36 * max(1, len(domains)) + 2.6))
    figure = Figure(figsize=(width, height))
    axes = figure.add_axes([0.38, 0.18, 0.58, 0.62])
    axes.set_title(title, fontsize=11, pad=10)
    if note:
        figure.text(0.5, 0.985, truncate(note, 180), ha="center", va="top",
                    fontsize=6, color="#616161", wrap=True)
    axes.set_xlim(0, max(1, len(studies)))
    axes.set_ylim(-0.6, max(0.6, len(domains) - 0.4))
    axes.set_yticks(range(len(domains)))
    axes.set_yticklabels([truncate(domain["label"], 45) for domain in domains], fontsize=7)
    axes.set_xlabel("Studies", fontsize=8)
    axes.tick_params(axis="both", labelsize=7)
    for spine in ("top", "right", "left"):
        axes.spines[spine].set_visible(False)

    for index, domain in enumerate(domains):
        left = 0
        for value in order:
            count = counts[index][value]
            if not count:
                continue
            style = styles[value]
            axes.barh(index, count, left=left, height=0.62,
                      color=style["color"], edgecolor="white", linewidth=0.6)
            if count >= max(1, len(studies) * 0.12):
                axes.text(left + count / 2, index, str(count), ha="center", va="center",
                          fontsize=7, color="white", fontweight="bold")
            left += count

    if not studies:
        axes.text(0.5, 0.5, "No included studies", ha="center", va="center",
                  fontsize=10, color="#616161")

    handles = [Patch(facecolor=item["color"], edgecolor="white", label=item["label"])
               for item in styles.values()]
    figure.legend(handles=handles, loc="lower center", ncol=min(4, len(handles)),
                  fontsize=7, frameon=False, bbox_to_anchor=(0.5, 0.01))
    return render_svg(figure)


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except Exception as error:
        print(json.dumps(bad_request(f"request is not valid JSON: {error}")))
        return 0

    try:
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        domains = request.get("domains")
        studies = request.get("studies")
        scale = request.get("scale")
        if not isinstance(domains, list) or not domains:
            raise ValueError("domains must be a non-empty list")
        if not isinstance(studies, list):
            raise ValueError("studies must be a list")
        if not isinstance(scale, list):
            raise ValueError("scale must be a list")
        if len(domains) > MAX_DOMAINS:
            raise ValueError(f"at most {MAX_DOMAINS} domains are supported")
        if len(studies) > MAX_STUDIES:
            raise ValueError(f"at most {MAX_STUDIES} studies are supported")
        for domain in domains:
            if not isinstance(domain, dict) or not domain.get("id") or not domain.get("label"):
                raise ValueError("each domain needs an id and a label")
        styles, _ = build_scale(scale)
        title = truncate(request.get("title") or "Risk of bias", 120)
    except ValueError as error:
        print(json.dumps(bad_request(str(error))))
        return 0

    try:
        import matplotlib
        matplotlib.use("Agg")
        matplotlib.rcParams["svg.hashsalt"] = "academic-harness"
    except ImportError:
        print(json.dumps({
            "error": "matplotlib is not installed; install the python-helpers dependencies (matplotlib)",
            "code": "matplotlib_missing",
        }))
        return 0

    warnings = []
    note = truncate(request.get("note") or "", 180)
    try:
        panels = request.get("panels") or ["traffic", "summary"]
        svg = {}
        if "traffic" in panels:
            svg["traffic"] = traffic_svg(title, note, domains, styles, studies, warnings)
        if "summary" in panels:
            svg["summary"] = summary_svg(title, note, domains, styles, studies, warnings)
    except Exception as error:  # surface a readable error instead of a traceback
        print(json.dumps({"error": f"render failed: {error}", "code": "render_failed"}))
        return 0

    print(json.dumps({
        "svg": svg,
        "studies": len(studies),
        "domains": len(domains),
        "warnings": warnings[:20],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
