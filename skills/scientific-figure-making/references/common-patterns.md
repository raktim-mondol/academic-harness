# Common patterns

Copy-pasteable versions of the condensed list in [SKILL.md](../SKILL.md#patterns). Each pattern is a recurring layout or encoding decision, not a new helper function — build them with the functions in [api.md](api.md).

---

## Ultra-wide multi-metric panel

Comparing 3–4 metrics (or many methods) in one row needs width, not height — a square panel forces bars to be thin and labels to rotate.

```python
fig, ax = plt.subplots(figsize=(28, 6))   # or (45, 12) for many methods
```

Rule of thumb: canvas width ≈ 3–4× height. Check the rendered bar width before shipping — if labels still overlap, widen further rather than shrinking the font.

## Legend-only axis

Once a legend would sit on top of data (many series, or a legend wider than the plot), give it a dedicated subplot instead of tuning `loc=`.

```python
fig, axes = create_subplots(1, 3, figsize=(14, 4))
# ... plot into axes[0], axes[1] ...

handles, labels = axes[0].get_legend_handles_labels()
axes[2].set_axis_off()
axes[2].legend(handles, labels, loc="center")
```

Gather handles from whichever axis has the most complete label set — a panel that only plots a subset of series will produce an incomplete legend.

## Hiding redundant category ticks

If the legend or panel title already names what's on the x-axis, drop the tick labels instead of repeating them.

```python
ax.set_xticks([])
```

Use when: many methods compared across several metric panels, and the method names live in one shared legend rather than every subplot.

## Tightening y-limits to the data band

The default of an axis starting at 0 flattens real differences when every value lives in a narrow band.

```python
lo, hi = data.min(), data.max()
margin = 0.05 * (hi - lo) or 0.02   # fallback for near-constant data
ax.set_ylim(lo - margin, hi + margin)
```

Avoid a fixed `(0, 100)` axis when every value sits in `85–95`; the reader should be able to see the gap between bars, not squint at it.

## Print-safe bar encoding

Color alone fails in grayscale print and for colorblind readers. Add a black edge always; add hatching when two bars share a hue (e.g. ablation subgroups of the same method).

```python
ax.bar(x, y, color=PALETTE["blue_secondary"], edgecolor="black", linewidth=2, hatch="/")
```

Hatch characters: `/`, `\`, `.`, `x` — pick distinct ones per subgroup, not per bar, so the pattern still maps to a legend category.

## Semantic color mapping

Reuse the same hue for the same role across every figure in a paper so a reader doesn't need to re-check the legend each time.

| Use | Palette key |
|-----|-------------|
| Proposed / key method | `blue_main`, `blue_secondary` |
| Improvement / positive variant | `green_1`, `green_2`, `green_3` |
| Baseline / contrast | `red_1`, `red_2`, `red_strong` |
| Reference / background category | `neutral` |
| Single callout (use once) | `highlight` |
| Extra series beyond blue/green/red | `teal`, `violet` |

Full hex values and the default color cycle are in [api.md](api.md#constants); the rationale for the mapping is in [design-theory.md](design-theory.md#why-this-particular-palette).

## Ablation alpha ramp

When an ablation adds one component at a time to the same method, use one color at increasing opacity instead of a new hue per row — it visually reads as "completeness."

```python
for i, (label, y) in enumerate(ablation_rows):
    ax.bar(x[i], y, color=PALETTE["blue_secondary"], alpha=0.2 + 0.8 * i / (len(ablation_rows) - 1))
```

## Related files

- [SKILL.md](../SKILL.md) — When to load this skill
- [api.md](api.md) — `PALETTE`, helpers, and their signatures
- [demos.md](demos.md) — Real scripts that use these patterns
- [design-theory.md](design-theory.md) — Why each pattern exists
- [tutorials.md](tutorials.md) — Full walkthroughs combining several patterns
