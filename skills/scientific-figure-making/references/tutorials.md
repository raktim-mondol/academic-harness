# Tutorials: end-to-end publication figures

Each tutorial uses the real helpers in `scripts/publication_figure.py` (see [api.md](api.md) for full signatures). Copy that module next to your figure script, or import it by path. Set a non-interactive backend before `import matplotlib.pyplot` in unattended runs — the module does this itself when `MPLBACKEND` is unset.

If venue, target dimensions, or export formats aren't given and they'd change the layout or DPI, ask before locking in choices.

---

## Tutorial 1: Grouped bar comparison

**Goal:** Several methods compared across shared categories, with value annotations, exported to PNG + PDF.

**Checklist:**
- [ ] One category list and one numeric array per series, all the same length
- [ ] `apply_publication_style` with a large-panel `FigureStyle` if this is a standalone comparison figure
- [ ] `figsize` wide enough that category labels don't overlap (see [common-patterns.md](common-patterns.md#ultra-wide-multi-metric-panel))
- [ ] Tightened y-limits if all values sit in a narrow band
- [ ] `finalize_figure` at `dpi=300` (or `600` for many thin bars)

```python
import matplotlib.pyplot as plt
from publication_figure import (
    PALETTE, FigureStyle, apply_publication_style,
    make_grouped_bar, finalize_figure,
)

apply_publication_style(FigureStyle(font_size=24, axes_linewidth=3))
fig, ax = plt.subplots(figsize=(16, 5))

categories = ["Metric A", "Metric B", "Metric C", "Metric D"]
series = [
    [0.92, 0.88, 0.85, 0.90],   # Ours
    [0.85, 0.82, 0.88, 0.84],   # Baseline X
    [0.78, 0.80, 0.82, 0.79],   # Baseline Y
]
labels = ["Ours", "Baseline X", "Baseline Y"]

make_grouped_bar(
    ax, categories, series, labels,
    ylabel="Score",
    colors=[PALETTE["blue_main"], PALETTE["green_3"], PALETTE["red_strong"]],
    annotate=True,
)
ax.set_ylim(0.7, 1.0)
finalize_figure(fig, "figures/method_comparison", formats=["png", "pdf"], dpi=300)
```

---

## Tutorial 2: Multi-panel trend with a shared legend

**Goal:** Two trend panels (e.g. train/validation curves) plus a third panel used only for the legend, so the curves aren't obscured.

**Checklist:**
- [ ] `create_subplots` for a 1×3 (or 2×2 with the last cell reserved) grid
- [ ] Plot trends on the data axes first; pull handles/labels from whichever axis has every series
- [ ] `set_axis_off()` on the legend axis, then `legend(handles, labels, loc="center")`
- [ ] Titles per data panel; `finalize_figure` last

```python
import numpy as np
from publication_figure import (
    FigureStyle, apply_publication_style, create_subplots,
    make_trend, finalize_figure,
)

apply_publication_style(FigureStyle(font_size=14, axes_linewidth=2))
fig, axes = create_subplots(1, 3, figsize=(14, 4))

x = np.linspace(0, 10, 50)
y1 = 0.5 + 0.4 * (1 - np.exp(-x / 3))
y2 = 0.45 + 0.35 * (1 - np.exp(-x / 4))

make_trend(axes[0], x, [y1, y2], ["Model A", "Model B"], ylabel="Loss", xlabel="Step")
axes[0].set_title("Training")

make_trend(axes[1], x, [y1 * 1.1, y2 * 1.05], ["Model A", "Model B"], ylabel="Loss", xlabel="Step")
axes[1].set_title("Validation")

handles, labels = axes[0].get_legend_handles_labels()
axes[2].set_axis_off()
axes[2].legend(handles, labels, loc="center")

finalize_figure(fig, "figures/trends", formats=["png", "pdf"], dpi=300)
```

---

## Tutorial 3: Heatmap with labels and colorbar

**Goal:** A labeled correlation or score matrix with a colorbar and optional cell annotations.

**Checklist:**
- [ ] 2D matrix plus matching `x_labels`/`y_labels` (lengths must match the matrix shape)
- [ ] `make_heatmap` with a `cbar_label` describing the units
- [ ] `annotate=True` only for small matrices — text gets unreadable past roughly 10×10
- [ ] `finalize_figure` last

```python
import numpy as np
import matplotlib.pyplot as plt
from publication_figure import (
    FigureStyle, apply_publication_style, make_heatmap, finalize_figure,
)

apply_publication_style(FigureStyle(font_size=12, axes_linewidth=2))
fig, ax = plt.subplots(figsize=(8, 6))

rng = np.random.default_rng(42)
matrix = rng.random((5, 5))
matrix = (matrix + matrix.T) / 2   # symmetric, e.g. a correlation matrix

labels = [f"F{i + 1}" for i in range(5)]
make_heatmap(ax, matrix, x_labels=labels, y_labels=labels, cmap="magma", cbar_label="Correlation")
finalize_figure(fig, "figures/heatmap", formats=["png", "pdf"], dpi=300)
```

---

## Chart types beyond these three

These cover the most common cases; `make_scatter` (single-series scatter) and `make_sphere_illustration` (conceptual 3D-look panels) are documented in [api.md](api.md) and follow the same `apply_publication_style` → draw → `finalize_figure` shape. For radar/polar comparisons, dense scatter/schematic panels, or other layouts not covered by a helper, open the closest real example in [demos.md](demos.md) and adapt it with the same `PALETTE` and `finalize_figure` conventions rather than inventing a new style.

## Related files

- [SKILL.md](../SKILL.md) — When to load this skill, condensed house style
- [api.md](api.md) — Full signatures for every helper used above
- [common-patterns.md](common-patterns.md) — The layout tricks used inside these tutorials
- [design-theory.md](design-theory.md) — Why the defaults used here are what they are
- [demos.md](demos.md) — Production scripts these tutorials are modeled on
