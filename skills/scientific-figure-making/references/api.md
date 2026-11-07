# API reference: `scripts/publication_figure.py`

Full signatures for the helper module summarized in [SKILL.md](../SKILL.md). Copy the module next to a figure script, or import it by path — it is not installed as a package.

```python
from publication_figure import (
    PALETTE, DEFAULT_COLORS, FigureStyle, apply_publication_style,
    create_subplots, finalize_figure, make_grouped_bar, annotate_bars,
    make_trend, make_heatmap, make_scatter, make_sphere_illustration,
)
```

---

## Constants

### `PALETTE`

`dict[str, str]` of semantic hex colors: `blue_main`, `blue_secondary`, `green_1`/`green_2`/`green_3`, `red_1`/`red_2`/`red_strong`, `neutral`, `highlight`, `teal`, `violet`. Role assignments are in [SKILL.md](../SKILL.md#house-style) and [design-theory.md](design-theory.md).

### `DEFAULT_COLORS`

`list[str]`, the fallback color cycle used by the plot helpers when `colors=None`: `[blue_main, green_3, red_strong, teal, violet, neutral]`. Cycles with modulo, so it never raises on more series than colors.

---

## `FigureStyle`

```python
@dataclass(frozen=True)
class FigureStyle:
    font_size: int = 16
    axes_linewidth: float = 2.5
    use_tex: bool = False
    font_family: tuple[str, ...] = ("DejaVu Sans", "Helvetica", "Arial", "sans-serif")
```

Immutable config passed to `apply_publication_style`. Raise `font_size` to 24 and `axes_linewidth` to 3 for large single-panel comparison bars; the defaults suit compact multi-panel figures. Only set `use_tex=True` when a LaTeX toolchain is present on the machine that will render the figure — it fails hard otherwise.

## `apply_publication_style(style=None)`

Writes the house style into `matplotlib.rcParams`: sans font stack, font sizes derived from `style.font_size`, top/right spines off, frameless legends, vector-safe text (`svg.fonttype="none"`, `pdf.fonttype`/`ps.fonttype=42` so text stays editable rather than outlined), opaque white figure/axes background, no grid. Call it once, before creating any figure — `rcParams` is global for the process.

## `create_subplots(nrows=1, ncols=1, figsize=None, **kwargs)`

Thin wrapper over `plt.subplots` that always returns `(fig, axes)` with `axes` raveled to a flat 1D `np.ndarray`, so single-axis and grid layouts index the same way (`axes[0]`, `axes[1]`, ...). Extra kwargs pass through to `plt.subplots`.

## `finalize_figure(fig, out_path, formats=None, dpi=300, close=True, pad=0.05, **kwargs)`

Runs `fig.tight_layout(pad=2)`, saves to every format in `formats`, and returns the list of written `Path`s.

- `formats=None` infers a single format from `out_path`'s suffix if it's one of `pdf, svg, eps, png, jpg, jpeg, tif, tiff`; otherwise defaults to `["pdf", "png"]`.
- Creates `out_path`'s parent directories.
- `dpi=300` matches the repository default; use `600` for dense bar panels with many thin bars or small annotation text.
- `pad=0.05` is `bbox_inches="tight"` padding in inches, separate from the `tight_layout(pad=2)` call.
- `close=True` closes the figure after saving (frees memory in batch scripts); set `False` to keep editing it.

Raises `ValueError` on an unsupported format — check the message rather than guessing an extension.

---

## Plot helpers

Each helper draws onto an `Axes` you already created (via `create_subplots` or `plt.subplots`); none of them create figures.

### `make_grouped_bar(ax, categories, series, labels, ylabel="Value", colors=None, annotate=False)`

Grouped/clustered bars. `series` is one 1D array-like per group (one bar cluster per category); every entry must have `len(categories)` values, and `len(series) == len(labels)`. Bar width narrows automatically as the group count grows (capped at `0.28`), and bars get a black `1.5`pt edge for print-safety. Sets x-ticks to `categories`, `ylabel`, and a legend. Returns the last `BarContainer` drawn — pass it to `annotate_bars` when you called this with `annotate=False`. Raises `ValueError` on length mismatches.

### `annotate_bars(ax, bars, fmt="{:.2f}", fontsize=10, padding=3)`

Wraps `ax.bar_label`; prints the formatted value above each bar in a `BarContainer`.

### `make_trend(ax, x, y_series, labels, colors=None, ylabel=None, xlabel=None, show_shadow=True)`

Multi-line trend plot. Each entry in `y_series` must match `len(x)`. `show_shadow=True` (default) draws a wide, low-alpha duplicate of each line beneath it (`linewidth=6, alpha=0.15`) as a soft halo — not a statistical confidence band; for real uncertainty, use `ax.fill_between` directly on `ax` before or after calling this. Adds a legend automatically. Raises `ValueError` on a length mismatch.

### `make_heatmap(ax, matrix, x_labels=None, y_labels=None, cmap="magma", cbar_label=None, annotate=False)`

2D `imshow` heatmap with an attached colorbar. `matrix` must be 2D; `x_labels`/`y_labels`, if given, must match `matrix.shape[1]`/`shape[0]` and are rotated 45° on the x-axis. `annotate=True` prints each cell's value, switching to white text when the cell's magnitude exceeds 45% of the matrix's max absolute value (for legibility over dark cells). Hides the left/bottom spines (heatmaps don't need them). Returns the `AxesImage`.

### `make_scatter(ax, x, y, label=None, color=None, size=50, alpha=0.7)`

Single-series scatter with no marker edges (`edgecolors="none"`) so dense clouds don't muddy. Defaults to `PALETTE["blue_main"]` when `color` is omitted. `x`/`y` must be equal length.

### `make_sphere_illustration(ax, light_dir=(-0.5, 0.5, 0.8), resolution=128, alpha=0.6)`

Renders a shaded disk that reads as a lit 3D sphere, for conceptual/schematic panels — not a real 3D projection and not a substitute for actual 3D data plots. Turns off axis ticks and frame (`ax.axis("off")`). Higher `resolution` smooths the shading at the cost of render time.

---

## Validation and conventions

- All numeric inputs go through `np.asarray(..., dtype=float)`; shape and length mismatches raise `ValueError` with the offending sizes, rather than silently broadcasting or truncating.
- Set a non-interactive backend before `import matplotlib.pyplot` in headless/batch runs: `matplotlib.use("Agg")`. The module does this itself when `MPLBACKEND` is unset in the environment.
- Save under a project's `figures/` directory (or the path the user specifies) with stable basenames — `finalize_figure` creates missing parent directories but does not invent a location.
- When comparisons, panel count, color roles, or output resolution are underspecified in a way that would change the figure's meaning, confirm with the user rather than guessing.

## Related files

- [SKILL.md](../SKILL.md) — When to load this skill, condensed house style
- [demos.md](demos.md) — Real `figure_*` scripts these helpers are compatible with
- [common-patterns.md](common-patterns.md) — Layout and print-safe patterns built from these helpers
- [design-theory.md](design-theory.md) — Why the defaults are what they are
- [tutorials.md](tutorials.md) — End-to-end scripts using this module
