# Design theory: why the house style looks this way

`scripts/publication_figure.py` and the house-style table in [SKILL.md](../SKILL.md) encode a set of conventions observed across the `figure_*` demo projects in [figures4papers](https://github.com/ChenLiu-1996/figures4papers) — Chen Liu's collection of camera-ready figure scripts from published ML/bio papers (Nature Machine Intelligence, ICML, NeurIPS, ECCV). That repository is CC BY-NC 4.0 (non-commercial), which is incompatible with shipping its code or prose inside this MIT-licensed plugin. Nothing here is copied from it — the numbers below (colors, sizes, DPI) are the same because they're the same style choice, but the module and this explanation are independent, ResearchCraft-native implementations. See [demos.md](demos.md) to browse the originals.

## Why minimalist and high-contrast

Reviewers and readers see these figures at reduced size — a half-column crop in a PDF, a thumbnail in a slide deck. Anything that doesn't carry information (grid lines, boxed legends, redundant tick labels, right/top spines that frame nothing) competes with the data for a shrinking amount of visual budget. The style strips those first:

- `axes.spines.right/top = False` — a chart doesn't need a box, only the two axes it's measured against.
- `legend.frameon = False` — a legend box is another rectangle competing with the plot's own rectangles.
- No grid by default — grid lines read as texture at small sizes; use direct labeling or a colorbar instead.

## Why two font-size tiers

- **16pt / 2.5pt spines (default):** compact multi-panel figures, subfigures inside a larger composite, anything that will sit at roughly a half or third of a column width.
- **24pt / 3pt spines:** a single wide comparison-bar panel meant to be read on its own, often spanning a full page width. At this size, thin default spines and small text look under-weighted next to bold bars.

Pick the tier by how much of the final page the figure occupies, not by habit — a 24pt panel crammed into a subfigure slot will overflow its labels.

## Why vector-safe export settings

`svg.fonttype="none"` and `pdf.fonttype`/`ps.fonttype=42` keep text as real, editable glyphs in vector exports instead of outlined paths. That matters twice: a copyeditor or co-author can still select and fix a typo in the exported PDF, and the file stays small (outlined text bloats vector files badly at high glyph counts, as in dense heatmap annotations).

`dpi=300` is the default because it's the minimum most venues accept for raster figures; `600` is worth the larger file only for panels with many thin bars, hatching, or small in-bar text, where 300dpi visibly aliases edges. `tight_layout(pad=2)` is a deliberately generous pad — it costs a little whitespace to guarantee axis labels and titles never clip, which is a more common failure than "too much margin."

## Why this particular palette

| Role | Hex | Intent |
|------|-----|--------|
| `blue_main` / `blue_secondary` | `#0F4D92` / `#3775BA` | The paper's own method — the thing the reader should remember |
| `green_1`/`2`/`3` | `#DDF3DE` / `#AADCA9` / `#8BCF8B` | Improvements, ablation variants that help |
| `red_1`/`2`/`red_strong` | `#F6CFCB` / `#E9A6A1` / `#B64342` | Baselines and contrasts |
| `neutral` | `#CFCECE` | Reference bars, background categories, anything not being argued about |
| `highlight` | `#FFD700` | A single callout — using it twice defeats the point |
| `teal` / `violet` | `#42949E` / `#9A4D8E` | Extra series beyond the blue/green/red budget |

The palette is small on purpose. A reader who sees blue in figure 2 and blue again in figure 5 should be able to assume it's the same method without re-reading the legend — that only works if the mapping is used consistently across every figure in one paper, not re-picked per plot. Green/red as "good/bad" and blue as "ours" are common enough visual conventions that they read correctly even before the legend is checked, which matters for reviewers skimming.

## Layout choices and why they exist

- **Wide aspect for multi-metric bars** (`figsize` width ≈ 3–4× height): a reader scans left to right; a wide canvas lets 3–4 metrics sit at a readable bar width instead of being squeezed into a square panel.
- **Legend-only axis**: once a figure has enough series or panels that a legend box would cover data, giving the legend its own subplot (`ax.set_axis_off()`) is cheaper than fighting `loc=` placement.
- **Hiding redundant x-ticks**: if the legend or panel title already names the categories, repeating them as x-tick labels is pure redundancy — remove one.
- **Tightened y-limits**: the default of starting axes at 0 is right for absolute quantities, wrong for comparisons in a narrow band (e.g., accuracy scores between 0.85–0.95) — a full 0–1 axis flattens real differences into noise. Set limits to the data's actual range plus a small margin.
- **Edge + hatch on bars**: color alone disappears in grayscale printing or for colorblind readers; a black edge and an optional hatch pattern (`/`, `\`, `.`) keep adjacent bars distinguishable without color.
- **Alpha for ablation "completeness"**: when an ablation adds components one at a time to the same method, using one hue at increasing alpha (0.2 → 1.0) shows the progression without inventing new colors that would need their own legend entries.

## What this does not cover

3D projections (`make_sphere_illustration` fakes one for conceptual panels only — it is not a real projection), geographic/GIS mapping, and interactive or web-first plotting (Plotly, Altair, Bokeh) are out of scope for this skill; see the "When not to load" section of [SKILL.md](../SKILL.md).

## Related files

- [SKILL.md](../SKILL.md) — Condensed house style and checklist
- [api.md](api.md) — The functions that implement these choices
- [common-patterns.md](common-patterns.md) — The same ideas as copy-pasteable snippets
- [demos.md](demos.md) — The original figure_* scripts these conventions are drawn from
- [tutorials.md](tutorials.md) — End-to-end figures built with this theory applied
