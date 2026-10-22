from papermemory.bibtex import parse_bibtex

SAMPLE = """
@inproceedings{simmons2004shear,
  title={Shear Strength Framework for Design of Dumped Spoil Slopes for Open Pit Coal Mines},
  author={Simmons, John V and McManus, Dennis A},
  booktitle={Advances in Geotechnical Engineering: The Skempton Conference},
  pages={981--991},
  year={2004},
  publisher={Thomas Telford, London}
}

@article{he2016deep,
  title={Deep Residual Learning for Image Recognition},
  author={He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  journal={CVPR},
  year={2016},
  doi={10.1109/CVPR.2016.90}
}
"""


def test_parse_two_entries():
    entries = parse_bibtex(SAMPLE)
    assert len(entries) == 2
    first = entries[0]
    assert first["bibtex_key"] == "simmons2004shear"
    assert first["year"] == 2004
    assert "John V Simmons" in first["authors"]
    assert "Dennis A McManus" in first["authors"]
    he = entries[1]
    assert he["doi"] == "10.1109/CVPR.2016.90"
    assert he["title"].startswith("Deep Residual")
