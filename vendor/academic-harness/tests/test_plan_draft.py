"""The optional draft contract on an outline: literature, citation hints, figures, section points."""
from __future__ import annotations

import pytest

from ah.context import build_context
from ah.outline import check_outline, load_outline, save_outline
from ah.plan import approve, draft_queries, plans_dir, propose


def _outline() -> dict:
    return {
        "thesis": "Adaptive retrieval helps on the logged benchmark.",
        "sections": [
            {"file": "sections/01_introduction/*", "purpose": "Introduction"},
            {"file": "sections/02_method/*", "purpose": "Method", "planned": True},
        ],
        "claims": [],
        "literature": {
            "cutoff": "2024-11",
            "introduction": {
                "hook": "Retrieval is used as a memory for language models.",
                "gap": "The logged runs measure recall on the three corpora only.",
                "searches": ["survey of retrieval-augmented generation"],
            },
            "related_work": [{
                "cluster": "Dense retrieval",
                "searches": ["dense passage retrieval baselines"],
                "limitation": "They freeze the index.",
                "bridge": "The method refreshes the index from the log.",
            }],
        },
        "citation_hints": [{
            "name": "ImageNet",
            "kind": "dataset",
            "title": "ImageNet: A large-scale hierarchical image database",
            "section": "sections/02_method/index.tex",
        }],
        "figures": [{
            "id": "fig_ablation",
            "type": "plot",
            "source": "experiment",
            "experiment": "ablation",
            "objective": "Show the recall drop when the index refresh is removed.",
            "aspect": "16:9",
        }],
        "section_points": [{
            "file": "sections/02_method/index.tex",
            "point": "Formalize the loss using equation 3 of the idea note.",
        }],
    }


def test_propose_approve_and_queries(project):
    propose(project, {"id": "draft1", "outline": _outline()})
    approved = approve(project, "draft1")
    assert approved["status"] == "approved"
    assert load_outline(project)["literature"]["cutoff"] == "2024-11"
    rows = draft_queries(load_outline(project))
    kinds = [row["kind"] for row in rows]
    assert kinds == ["intro", "related", "hint"]
    assert {row["year_max"] for row in rows} == {2024}
    assert rows[2]["title"].startswith("ImageNet")
    assert rows[2]["query"].startswith("ImageNet")
    findings = [d for d in check_outline(build_context(project)) if d["check"] == "ARG-06"]
    assert findings == []


def test_propose_rejects_a_bad_block_and_writes_nothing(project):
    bad = _outline()
    bad["literature"]["cutoff"] = "November 2024"
    with pytest.raises(ValueError, match="cutoff"):
        propose(project, {"id": "bad-cutoff", "outline": bad})
    assert not (plans_dir(project) / "bad-cutoff.yaml").exists()

    bad = _outline()
    bad["figures"][0].pop("experiment")
    with pytest.raises(ValueError, match="experiment"):
        propose(project, {"id": "bad-plot", "outline": bad})

    bad = _outline()
    bad["citation_hints"][0].pop("title")
    with pytest.raises(ValueError, match="query or an exact title"):
        propose(project, {"id": "bad-hint", "outline": bad})

    bad = _outline()
    bad["section_points"][0]["file"] = "sections/99_missing.tex"
    with pytest.raises(ValueError, match="matches no outline section"):
        propose(project, {"id": "bad-point", "outline": bad})

    bad = _outline()
    bad["figures"][0]["id"] = "my_figure"
    with pytest.raises(ValueError, match="figure"):
        propose(project, {"id": "bad-id", "outline": bad})


def test_outline_without_draft_blocks_has_no_arg06(project):
    findings = [d for d in check_outline(build_context(project)) if d["check"] == "ARG-06"]
    assert findings == []


def test_hand_edited_literature_block_is_arg06(project):
    outline = load_outline(project)
    outline["status"] = "approved"
    outline["literature"] = {"cutoff": "nope"}
    save_outline(project, outline)
    findings = [d for d in check_outline(build_context(project)) if d["check"] == "ARG-06"]
    assert findings
    assert all(d["level"] == "minor" for d in findings)
