from pathlib import Path

from papermemory.citations import cite_check, extract_cite_keys
from papermemory.db import Store
from papermemory.ingest import ingest_bibtex, ingest_manuscript


def test_extract_cite_keys():
    tex = r"Dump heights reach 250 m \citep{simmons2004shear} and CNNs work \citep{he2016deep,dosovitskiy2021image}."
    keys = extract_cite_keys(tex)
    assert keys == ["simmons2004shear", "he2016deep", "dosovitskiy2021image"]


def test_cite_check_missing_and_unverified(tmp_path: Path):
    root = tmp_path / "paper"
    sections = root / "sections"
    sections.mkdir(parents=True)
    (root / "references.bib").write_text(
        """@inproceedings{simmons2004shear,
  title={Shear Strength Framework},
  author={Simmons, John V and McManus, Dennis A},
  year={2004}
}
@inproceedings{he2016deep,
  title={Deep Residual Learning},
  author={He, Kaiming},
  year={2016},
  doi={10.1109/CVPR.2016.90}
}
""",
        encoding="utf-8",
    )
    (sections / "introduction.tex").write_text(
        r"\citep{simmons2004shear} and missing \citep{ghost2020fake} plus \citep{he2016deep}.",
        encoding="utf-8",
    )
    (root / "main.tex").write_text("\\input{sections/introduction}\n", encoding="utf-8")
    store = Store(tmp_path / "mem.db")
    ingest_manuscript(store, root, slug="demo")
    report = cite_check(store, "demo")
    assert "ghost2020fake" in report["missing_from_memory"]
    unverified_keys = {item["key"] for item in report["unverified_cited"]}
    assert "simmons2004shear" in unverified_keys
    assert "he2016deep" not in unverified_keys
    store.close()
