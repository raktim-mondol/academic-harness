#!/usr/bin/env python3
"""Publication-figure helpers for Academic Harness.

House style adapted from the conventions in Chen Liu's figures4papers
(https://github.com/ChenLiu-1996/figures4papers). No code from that
repository is included; this module implements the helper API that
workflow specifies.

Copy this file next to a figure script, or import it by path:

    from publication_figure import (
        PALETTE, FigureStyle, apply_publication_style,
        make_grouped_bar, make_trend, make_heatmap, finalize_figure,
    )
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

import numpy as np

# Headless by default so figure scripts work in the sandbox.
if os.environ.get("MPLBACKEND") is None:
    import matplotlib

    matplotlib.use("Agg")

import matplotlib.pyplot as plt
from matplotlib.axes import Axes
from matplotlib.container import BarContainer
from matplotlib.figure import Figure

PALETTE = {
    "blue_main": "#0F4D92",
    "blue_secondary": "#3775BA",
    "green_1": "#DDF3DE",
    "green_2": "#AADCA9",
    "green_3": "#8BCF8B",
    "red_1": "#F6CFCB",
    "red_2": "#E9A6A1",
    "red_strong": "#B64342",
    "neutral": "#CFCECE",
    "highlight": "#FFD700",
    "teal": "#42949E",
    "violet": "#9A4D8E",
}

DEFAULT_COLORS = [
    PALETTE["blue_main"],
    PALETTE["green_3"],
    PALETTE["red_strong"],
    PALETTE["teal"],
    PALETTE["violet"],
    PALETTE["neutral"],
]

_EXPORT_FORMATS = {"pdf", "svg", "eps", "png", "jpg", "jpeg", "tif", "tiff"}


@dataclass(frozen=True)
class FigureStyle:
    font_size: int = 16
    axes_linewidth: float = 2.5
    use_tex: bool = False
    font_family: tuple[str, ...] = (
        "DejaVu Sans",
        "Helvetica",
        "Arial",
        "sans-serif",
    )


def apply_publication_style(style: FigureStyle | None = None) -> None:
    """Configure matplotlib rcParams. Call once before creating figures."""
    style = style or FigureStyle()
    plt.rcParams.update(
        {
            "font.family": "sans-serif",
            "font.sans-serif": list(style.font_family),
            "font.size": style.font_size,
            "axes.titlesize": style.font_size,
            "axes.labelsize": style.font_size,
            "xtick.labelsize": max(style.font_size - 2, 8),
            "ytick.labelsize": max(style.font_size - 2, 8),
            "legend.fontsize": max(style.font_size - 2, 8),
            "axes.spines.right": False,
            "axes.spines.top": False,
            "axes.linewidth": style.axes_linewidth,
            "legend.frameon": False,
            "svg.fonttype": "none",
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.grid": False,
            "text.usetex": style.use_tex,
        }
    )


def create_subplots(
    nrows: int = 1,
    ncols: int = 1,
    figsize: tuple[float, float] | None = None,
    **kwargs,
) -> tuple[Figure, np.ndarray]:
    """Return (fig, axes) with axes flattened to a 1D array."""
    fig, axes = plt.subplots(nrows, ncols, figsize=figsize, **kwargs)
    axes_arr = np.atleast_1d(axes).ravel()
    return fig, axes_arr


def finalize_figure(
    fig: Figure,
    out_path: str | os.PathLike,
    formats: Sequence[str] | None = None,
    dpi: int = 300,
    close: bool = True,
    pad: float = 0.05,
    **kwargs,
) -> list[Path]:
    """Save to one or more formats. Creates parent directories."""
    path = Path(out_path)
    if formats is None:
        ext = path.suffix.lstrip(".").lower()
        formats = [ext] if ext in _EXPORT_FORMATS else ["pdf", "png"]
    formats = [f.lower().lstrip(".") for f in formats]
    unknown = [f for f in formats if f not in _EXPORT_FORMATS]
    if unknown:
        raise ValueError(f"unsupported export formats: {unknown}")
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout(pad=2)
    saved: list[Path] = []
    stem = path.with_suffix("")
    for fmt in formats:
        dest = Path(f"{stem}.{fmt}")
        fig.savefig(
            dest,
            dpi=dpi,
            facecolor="white",
            bbox_inches="tight",
            pad_inches=pad,
            **kwargs,
        )
        saved.append(dest)
    if close:
        plt.close(fig)
    return saved


def _as_1d(name: str, values) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    if arr.ndim != 1:
        raise ValueError(f"{name} must be 1D, got shape {arr.shape}")
    return arr


def _colors(n: int, colors: Sequence[str] | None) -> list[str]:
    palette = list(colors) if colors else list(DEFAULT_COLORS)
    if not palette:
        raise ValueError("colors is empty")
    return [palette[i % len(palette)] for i in range(n)]


def make_grouped_bar(
    ax: Axes,
    categories: Sequence[str],
    series: Sequence[Sequence[float]],
    labels: Sequence[str],
    ylabel: str = "Value",
    colors: Sequence[str] | None = None,
    annotate: bool = False,
) -> BarContainer:
    """Grouped bars. `series` is one array per group, each length = len(categories)."""
    cats = list(categories)
    if len(series) != len(labels):
        raise ValueError("series and labels must be the same length")
    arrays = [_as_1d(f"series[{i}]", s) for i, s in enumerate(series)]
    for i, arr in enumerate(arrays):
        if arr.size != len(cats):
            raise ValueError(
                f"series[{i}] length {arr.size} != len(categories) {len(cats)}"
            )
    n_groups = len(arrays)
    x = np.arange(len(cats), dtype=float)
    width = min(0.8 / max(n_groups, 1), 0.28)
    offset = (n_groups - 1) * width / 2
    cols = _colors(n_groups, colors)
    last: BarContainer | None = None
    for i, (arr, label, color) in enumerate(zip(arrays, labels, cols)):
        last = ax.bar(
            x - offset + i * width,
            arr,
            width=width * 0.92,
            label=label,
            color=color,
            edgecolor="black",
            linewidth=1.5,
        )
        if annotate:
            annotate_bars(ax, last)
    ax.set_xticks(x)
    ax.set_xticklabels(cats)
    ax.set_ylabel(ylabel)
    ax.legend()
    assert last is not None
    return last


def annotate_bars(
    ax: Axes,
    bars: BarContainer,
    fmt: str = "{:.2f}",
    fontsize: int = 10,
    padding: int = 3,
) -> None:
    """Add text above each bar in a BarContainer."""
    ax.bar_label(bars, fmt=fmt, fontsize=fontsize, padding=padding)


def make_trend(
    ax: Axes,
    x,
    y_series: Sequence,
    labels: Sequence[str],
    colors: Sequence[str] | None = None,
    ylabel: str | None = None,
    xlabel: str | None = None,
    show_shadow: bool = True,
) -> None:
    """Multiple lines. Each y_series entry is 1D and the same length as x."""
    x_arr = _as_1d("x", x)
    if len(y_series) != len(labels):
        raise ValueError("y_series and labels must be the same length")
    cols = _colors(len(y_series), colors)
    for y, label, color in zip(y_series, labels, cols):
        y_arr = _as_1d(label, y)
        if y_arr.size != x_arr.size:
            raise ValueError(
                f"series {label!r} length {y_arr.size} != len(x) {x_arr.size}"
            )
        if show_shadow:
            ax.plot(x_arr, y_arr, color=color, linewidth=6, alpha=0.15, zorder=1)
        ax.plot(
            x_arr,
            y_arr,
            color=color,
            linewidth=2.5,
            label=label,
            zorder=2,
        )
    if ylabel:
        ax.set_ylabel(ylabel)
    if xlabel:
        ax.set_xlabel(xlabel)
    ax.legend()


def make_heatmap(
    ax: Axes,
    matrix,
    x_labels: Sequence[str] | None = None,
    y_labels: Sequence[str] | None = None,
    cmap: str = "magma",
    cbar_label: str | None = None,
    annotate: bool = False,
):
    """2D heatmap with optional labels, colorbar, and cell annotations."""
    mat = np.asarray(matrix, dtype=float)
    if mat.ndim != 2:
        raise ValueError(f"matrix must be 2D, got shape {mat.shape}")
    im = ax.imshow(mat, cmap=cmap, aspect="auto")
    cbar = ax.figure.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    if cbar_label:
        cbar.set_label(cbar_label)
    if x_labels is not None:
        if len(x_labels) != mat.shape[1]:
            raise ValueError("x_labels length must match matrix columns")
        ax.set_xticks(range(mat.shape[1]), list(x_labels), rotation=45, ha="right")
    if y_labels is not None:
        if len(y_labels) != mat.shape[0]:
            raise ValueError("y_labels length must match matrix rows")
        ax.set_yticks(range(mat.shape[0]), list(y_labels))
    if annotate:
        vmax = np.nanmax(np.abs(mat)) or 1.0
        for i in range(mat.shape[0]):
            for j in range(mat.shape[1]):
                val = mat[i, j]
                ax.text(
                    j,
                    i,
                    f"{val:.2f}",
                    ha="center",
                    va="center",
                    color="white" if abs(val) > 0.45 * vmax else "black",
                    fontsize=8,
                )
    ax.spines["left"].set_visible(False)
    ax.spines["bottom"].set_visible(False)
    return im


def make_scatter(
    ax: Axes,
    x,
    y,
    label: str | None = None,
    color: str | None = None,
    size: float = 50,
    alpha: float = 0.7,
):
    """Single-series scatter. x and y must be the same length."""
    x_arr = _as_1d("x", x)
    y_arr = _as_1d("y", y)
    if x_arr.size != y_arr.size:
        raise ValueError("x and y must be the same length")
    return ax.scatter(
        x_arr,
        y_arr,
        s=size,
        c=color or PALETTE["blue_main"],
        alpha=alpha,
        label=label,
        edgecolors="none",
    )


def make_sphere_illustration(
    ax: Axes,
    light_dir: tuple[float, float, float] = (-0.5, 0.5, 0.8),
    resolution: int = 128,
    alpha: float = 0.6,
) -> None:
    """Shaded disk that reads as a 3D sphere. For conceptual panels, not data."""
    n = int(resolution)
    yy, xx = np.mgrid[-1 : 1 : n * 1j, -1 : 1 : n * 1j]
    zz = 1.0 - xx**2 - yy**2
    disk = zz >= 0
    z = np.sqrt(np.clip(zz, 0, None))
    lx, ly, lz = light_dir
    norm = np.sqrt(lx * lx + ly * ly + lz * lz) or 1.0
    shade = (xx * lx + yy * ly + z * lz) / norm
    img = np.clip(0.35 + 0.65 * shade, 0, 1)
    rgba = np.zeros((n, n, 4))
    rgba[..., 0] = 0.06
    rgba[..., 1] = 0.30
    rgba[..., 2] = 0.57
    rgba[..., 3] = np.where(disk, alpha, 0.0) * (0.4 + 0.6 * img)
    ax.imshow(rgba, origin="lower", extent=(-1, 1, -1, 1), interpolation="bilinear")
    ax.set_aspect("equal")
    ax.set_xlim(-1.05, 1.05)
    ax.set_ylim(-1.05, 1.05)
    ax.axis("off")


def _smoke(out_dir: Path) -> list[Path]:
    """Write a tiny grouped-bar + trend pair to prove the helpers run."""
    apply_publication_style(FigureStyle(font_size=14, axes_linewidth=2))
    fig, axes = create_subplots(1, 2, figsize=(10, 3.5))
    make_grouped_bar(
        axes[0],
        ["A", "B", "C"],
        [[0.92, 0.88, 0.85], [0.78, 0.80, 0.82]],
        ["Ours", "Baseline"],
        ylabel="Score",
        colors=[PALETTE["blue_main"], PALETTE["red_strong"]],
        annotate=True,
    )
    axes[0].set_ylim(0.7, 1.0)
    x = np.linspace(0, 10, 40)
    make_trend(
        axes[1],
        x,
        [0.5 + 0.4 * (1 - np.exp(-x / 3)), 0.45 + 0.35 * (1 - np.exp(-x / 4))],
        ["Model A", "Model B"],
        ylabel="Metric",
        xlabel="Step",
    )
    return finalize_figure(fig, out_dir / "smoke", formats=["png", "pdf"], dpi=120)


if __name__ == "__main__":
    import tempfile

    dest = Path(tempfile.mkdtemp(prefix="publication-figure-"))
    saved = _smoke(dest)
    print("wrote", ", ".join(str(p) for p in saved))
