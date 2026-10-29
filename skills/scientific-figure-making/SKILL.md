---
name: scientific-figure-making
description: Create publication-ready matplotlib figures from real data — grouped bars, trends, scatter, heatmaps, radar, multi-panel layouts — with a consistent house style (semantic palette, spines off, vector+PNG export). Use when finalizing plots for a paper, poster, or talk. Do not use for interactive dashboards, Mermaid/structural diagrams (diagram-design), or conceptual illustrations (image_generate).
license: MIT
metadata:
  version: "1.0"
  skill-source: https://github.com/ChenLiu-1996/figures4papers
---

# Scientific figure making

Publication matplotlib figures for papers, slides, and reports. Load this **before** writing a plotting script. Open `scripts/publication_figure.py` for the helpers; do not reinvent rcParams or palettes.

Adapted from the house style in Chen Liu's [figures4papers](https://github.com/ChenLiu-1996/figures4papers) (Nature Machine Intelligence, ICML, NeurIPS, ECCV figures). That repo is CC BY-NC 4.0 — none of its files are vendored here. The helper API it specifies but does not ship is implemented in `scripts/publication_figure.py`.

## When to load

- Matplotlib figures that must look like a finished paper figure (fonts, palette, spines, PDF/PNG).
- Grouped bars, trend lines, heatmaps, scatter, radar, multi-panel grids.
- "Make Figure N publication-quality" / "same style as the other figures."

## When not to load

- Structural diagrams (architecture, flowchart, pipeline, CONSORT) → `diagram-design`.
- Conceptual illustrations with no real numbers → `image_generate`.
- Interactive / web-first plots (Plotly, Altair, Bokeh).
- GIS / dominant 3D / Figma-first infographics.
- The user named a specific journal's column-width spec → still load this for style, then `scientific-visualization` for that venue's millimetre widths.

## Related Supervisor-Skills

For paper-level figure strategy and a design audit before rendering, load `figure-designer`. To reconstruct a raster reference as editable Draw.io, load `drawio-reconstruction`. This skill remains the renderer for real data.

## Mapping onto this plugin

1. Copy `scripts/publication_figure.py` into the workspace next to the figure script (e.g. `figures/publication_figure.py`), or import it by path.
2. `uv add matplotlib numpy` if missing. Set a non-interactive backend before pyplot (`publication_figure.py` does this on import).
3. `apply_publication_style(...)` once, then helpers, then `finalize_figure` to **PNG and PDF**.
4. Real computed data only — never `image_generate`, never fabricated values.
5. Log the output paths as a `notebook` artifact. For a paper figure, delegate `subagent_vision` to check labels, overlap, and that the plot matches the caption.

## House style

- Sans stack: Arial / Helvetica / DejaVu Sans. Base `font.size` 16 (24 for large comparison bars). Spine width 2–3. Top and right spines off. Frameless legends. `svg.fonttype = none`.
- Export: `dpi=300` (600 for dense bar panels). `tight_layout` with pad ~2. Opaque white background.
- Semantic colour (proposed vs baseline stays consistent across a paper):

| Role | Hex | Use |
|------|-----|-----|
| `blue_main` | `#0F4D92` | Proposed / key result |
| `blue_secondary` | `#3775BA` | Related method |
| `green_3` | `#8BCF8B` | Improvement / positive variant |
| `red_strong` | `#B64342` | Baseline / contrast |
| `neutral` | `#CFCECE` | Reference / background |
| `highlight` | `#FFD700` | Single callout only |

Full map and defaults live in `scripts/publication_figure.py` (`PALETTE`, `DEFAULT_COLORS`).

## Helpers

Import from the copied module:

```python
from publication_figure import (
    PALETTE, FigureStyle, apply_publication_style, create_subplots,
    make_grouped_bar, annotate_bars, make_trend, make_heatmap,
    make_scatter, finalize_figure,
)

apply_publication_style(FigureStyle(font_size=24, axes_linewidth=3))
fig, ax = plt.subplots(figsize=(16, 5))
make_grouped_bar(
    ax, categories, series, labels,
    ylabel="Score",
    colors=[PALETTE["blue_main"], PALETTE["green_3"], PALETTE["red_strong"]],
    annotate=True,
)
ax.set_ylim(0.7, 1.0)
finalize_figure(fig, "figures/method_comparison", formats=["png", "pdf"], dpi=300)
```

Signatures, validation, and a smoke-test `__main__` are in the module. Implement one-off chart types (radar, polar) with the same `PALETTE` / `apply_publication_style` / `finalize_figure` rather than a new palette.

## Patterns

- **Ultra-wide comparison panels.** 3–4 metrics in a row: `figsize` width ~3–4× height (e.g. `(28, 6)` or `(45, 12)` for many methods). Scan left-to-right instead of stacking cramped bars.
- **Legend-only axis.** Extra subplot, `ax.set_axis_off()`, place the shared legend there so it never covers data.
- **Hide redundant x ticks.** When the legend already names methods, `ax.set_xticks([])`.
- **Tighten y-limits** to the data band (margin of a small fraction of the range). Do not force 0–100 when every value sits in 85–95.
- **Print-safe bars.** `edgecolor='black'`, linewidth 1.5–3. Hatch (`/`, `\\`, `.`) for ablation subgroups so they survive grayscale.
- **In-bar values.** Annotate large comparison bars (`annotate=True` or `annotate_bars`) so the reader does not need a grid.
- **Ablation alpha.** Same hue, alpha 0.2→1.0 for "completeness" of a method.
- **Trends.** 2–4 curves, linewidth 2–3, `fill_between` for uncertainty. Minimal or no grid.

## Checklist before shipping

- [ ] Real data (no invented numbers)
- [ ] `apply_publication_style` ran before `subplots`
- [ ] Top/right spines off, legend frameless
- [ ] Proposed method is blue; baselines are not
- [ ] Axes labeled with units; panel letters on multi-panel figures
- [ ] PNG + PDF written under `figures/` (or the path the user gave)
- [ ] `subagent_vision` checked a paper-destined figure
