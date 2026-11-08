"""Shared fixtures: a small LaTeX project scaffolded by `ah init` with known findings planted in it.

Run from the repository root with the engine on the path, so pytest never imports another checkout:
    PYTHONPATH=$PWD/vendor/academic-harness vendor/academic-harness/.venv/bin/python -m pytest vendor/academic-harness/tests
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

import ah  # noqa: E402

assert Path(ah.__file__).resolve().is_relative_to(ENGINE), f"imported ah from {ah.__file__}, not {ENGINE}"

INTRO = r"""\section{Introduction}
\label{sec:introduction}

Our method proves that adaptive retrieval improves recall on every benchmark we tried, as
Section~\ref{sec:missing} shows and as earlier work reported \cite{smith2020}.

We evaluate on 1240 documents drawn from three corpora and report the results in a later section of the paper.
"""

METHOD = r"""\section{Method}
\label{sec:method}

The retriever ranks passages with a learned scorer and the reader extracts an answer span from the
top passages; this paragraph is deliberately plain so it produces no findings at all here.
"""

BIB = r"""@article{smith2020,
  title = {Adaptive Retrieval},
  author = {Smith, Jane},
  journal = {Journal of Retrieval},
  year = {2020}
}

@article{unused2019,
  title = {Never Cited},
  author = {Doe, John},
  journal = {Journal of Nothing},
  year = {2019}
}
"""


def write_project(root: Path) -> Path:
    from ah.cli import main
    assert main(["init", "--profile", "paper/conference", str(root)]) == 0
    src = root / "src"
    (src / "sections/01_introduction/index.tex").write_text(INTRO)
    (src / "sections/03_method/index.tex").write_text(METHOD)
    (src / "refs/references.bib").write_text(BIB)
    return root


def write_anchored_project(root: Path) -> Path:
    """The documented workflow: `ah units sync` gives each paragraph a stable `%% @unit` id."""
    from ah.cli import main
    write_project(root)
    assert main(["units", "--project", str(root), "sync"]) == 0
    return root


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    return write_anchored_project(tmp_path / "paper")


@pytest.fixture
def raw_project_dir(tmp_path: Path) -> Path:
    return write_project(tmp_path / "raw")


@pytest.fixture
def project(project_dir: Path):
    from ah.project import Project
    return Project(str(project_dir))
