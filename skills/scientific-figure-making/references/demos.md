# Real-world demos

`scripts/publication_figure.py` and the rest of this skill's references encode conventions observed across the `figure_*` projects in [figures4papers](https://github.com/ChenLiu-1996/figures4papers) — Chen Liu's collection of camera-ready figure scripts from published papers. That repository is CC BY-NC 4.0; nothing from it is vendored here (see [design-theory.md](design-theory.md) for why), but its scripts are useful as real, worked examples once you've matched this skill's conventions to your own data. Clone it or browse on GitHub to see the actual code.

## Project folders

| Project | Link | Notable chart types |
|---|---|---|
| `figure_ImmunoStruct` | [figures4papers/figure_ImmunoStruct](https://github.com/ChenLiu-1996/figures4papers/tree/main/figure_ImmunoStruct) | Bar plots, quantitative comparison |
| `figure_CellSpliceNet` | [figures4papers/figure_CellSpliceNet](https://github.com/ChenLiu-1996/figures4papers/tree/main/figure_CellSpliceNet) | Bar comparison, ablation |
| `figure_Brainteaser` | [figures4papers/figure_Brainteaser](https://github.com/ChenLiu-1996/figures4papers/tree/main/figure_Brainteaser) | Bar composition breakdown |
| `figure_VIGIL` | [figures4papers/figure_VIGIL](https://github.com/ChenLiu-1996/figures4papers/tree/main/figure_VIGIL) | Radar plots, line plots, concept panels |
| `figure_ophthal_review` | [figures4papers/figure_ophthal_review](https://github.com/ChenLiu-1996/figures4papers/tree/main/figure_ophthal_review) | Trend plots by month |
| `figure_RNAGenScape` | [figures4papers/figure_RNAGenScape](https://github.com/ChenLiu-1996/figures4papers/tree/main/figure_RNAGenScape) | Heatmaps |
| `figure_Dispersion` | [figures4papers/figure_Dispersion](https://github.com/ChenLiu-1996/figures4papers/tree/main/figure_Dispersion) | 3D-style spheres, performance plots |
| `figure_Cflows` | [figures4papers/figure_Cflows](https://github.com/ChenLiu-1996/figures4papers/tree/main/figure_Cflows) | Comparison, ablation, trajectory plots |

## Mapping demos to this skill's helpers

| If you're building | Look at | Then build with |
|---|---|---|
| Grouped/quantitative bars | `figure_ImmunoStruct`, `figure_CellSpliceNet`, `figure_Brainteaser` | `make_grouped_bar` + `annotate_bars` ([tutorials.md](tutorials.md#tutorial-1-grouped-bar-comparison)) |
| Radar/polar comparisons | `figure_VIGIL` | Same `PALETTE` / `apply_publication_style` / `finalize_figure`, `ax.plot` on a polar axis — no dedicated helper, see [api.md](api.md#related-files) |
| Trend/line panels with a legend | `figure_VIGIL`, `figure_ophthal_review`, `figure_Cflows` | `make_trend` ([tutorials.md](tutorials.md#tutorial-2-multi-panel-trend-with-a-shared-legend)) |
| Heatmaps | `figure_RNAGenScape` | `make_heatmap` ([tutorials.md](tutorials.md#tutorial-3-heatmap-with-labels-and-colorbar)) |
| Conceptual 3D-look panels | `figure_Dispersion` | `make_sphere_illustration` |

## Related files

- [SKILL.md](../SKILL.md) — When to load this skill
- [api.md](api.md) — Helpers implemented locally, no copied code
- [common-patterns.md](common-patterns.md) — Layout patterns drawn from these demos
- [design-theory.md](design-theory.md) — Style theory and the license reason nothing is vendored
- [tutorials.md](tutorials.md) — Worked examples using this skill's own module
