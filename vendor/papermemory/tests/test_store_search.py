from pathlib import Path

from papermemory.db import Store
from papermemory.ingest import ingest_bibtex
from papermemory.search import search


BIB = """
@inproceedings{simmons2004shear,
  title={Shear Strength Framework for Design of Dumped Spoil Slopes},
  author={Simmons, John V and McManus, Dennis A},
  booktitle={Skempton Conference},
  year={2004}
}
@inproceedings{he2016deep,
  title={Deep Residual Learning for Image Recognition},
  author={He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  booktitle={CVPR},
  year={2016},
  doi={10.1109/CVPR.2016.90}
}
@inproceedings{dosovitskiy2021image,
  title={An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale},
  author={Dosovitskiy, Alexey and Beyer, Lucas},
  booktitle={ICLR},
  year={2021}
}
"""


def test_ingest_search_dedup(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("PAPERMEMORY_DB", str(tmp_path / "t.db"))
    store = Store(tmp_path / "t.db")
    first = ingest_bibtex(store, BIB, project_id="scandy")
    again = ingest_bibtex(store, BIB, project_id="scandy")
    assert len(first) == 3
    assert first[0]["id"] == again[0]["id"]
    hits = search(store, "spoil shear strength", kind="paper")
    assert hits
    assert any("Simmons" in (h.get("title") or "") or "spoil" in (h.get("title") or "").lower() for h in hits)
    paper = store.get_paper("simmons2004shear")
    assert paper is not None
    assert paper["verified"] == 0
    he = store.get_paper("he2016deep")
    assert he["verified"] == 1
    ranked = search(store, "transformers image recognition", kind="paper")
    assert ranked
    assert ranked[0]["bibtex_key"] == "dosovitskiy2021image"
    store.close()


def test_remember_recall(tmp_path: Path):
    store = Store(tmp_path / "t.db")
    store.remember(
        "SCANDY uses Elsevier Harvard author-date citations",
        concepts=["scandy", "citation-style", "elsevier-harvard"],
        project_id="scandy",
    )
    hits = search(store, "harvard citations", kind="observation")
    assert hits
    assert "Harvard" in hits[0]["content"]
    store.close()
