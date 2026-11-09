"""T5 format and consistency rules (ACR-*, FMT-*).

Every rule has texts that must fire and texts that must not. The corpus is written by the author of the rules, so it
is regression evidence (a rule that changes behaviour breaks a case), NOT evidence of accuracy on real prose. That
evidence is the author's own fix/waive decisions: `ah precision`.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest
import yaml

from ah.audit import audit, run_checks
from ah.checks.base import CATALOGUE, DEFAULT_TIERS
from ah.checks.t5_format import check_format, heading_case, initials_match, minority, prose
from ah.cli import main
from ah.context import build_context
from ah.project import Project

SECTION = "src/sections/04_experiments/index.tex"
FORMAT_RULES = sorted(c for c in CATALOGUE if c.startswith(("ACR-", "FMT-")))


@dataclass
class Case:
    rule: str
    name: str
    paras: list[str]
    fires: bool                               # must the rule fire (True) or stay silent (False)?
    key: str | None = None                    # a key the rule must produce (positive cases)
    fmt: dict = field(default_factory=dict)   # style.format overrides
    glossary: list[dict] | None = None


def para(text: str) -> str:
    return text


def words(n: int) -> str:
    return " ".join("w" + chr(97 + i // 26) + chr(97 + i % 26) for i in range(n)) + "."      # waa wab wac ...: letters only, so they count as words


LONG, MEDIUM = words(70), words(30)

CASES = [
    # ---- ACR-01 / ACR-02
    Case("ACR-01", "used before its definition", ["Our NLP system is fast.", "Natural language processing (NLP) is common."], True, "before:NLP"),
    Case("ACR-01", "never defined", ["The CNN model reached high accuracy on the task.", "The CNN model was trained for ten epochs on the data."], True, "undefined:CNN"),
    Case("ACR-01", "defined twice", ["Natural language processing (NLP) is common. NLP is used.", "Natural language processing (NLP) is defined again here."], True, "twice:NLP"),
    Case("ACR-01", "initials that do not spell it are no definition", ["The Big Cats (XYZ) are discussed here in this paragraph."], True, "undefined:XYZ"),
    Case("ACR-01", "defined then used", ["Natural language processing (NLP) is common. NLP is used widely."], False),
    Case("ACR-01", "reverse definition", ["NLP (natural language processing) is common. NLP is used."], False),
    Case("ACR-01", "plural of a defined acronym", ["Large language models (LLMs) are common. LLMs are used."], False),
    Case("ACR-01", "hyphenated long form", ["Long short-term memory (LSTM) is old. An LSTM is used."], False),
    Case("ACR-01", "well-known acronyms need none", ["The PDF file and the URL are shown here for the reader."], False),
    Case("ACR-01", "roman numerals are not acronyms", ["Part II of the study and Part III are described below in detail."], False),
    Case("ACR-01", "declared as known", ["The BERT encoder is used here for the embeddings."], False, fmt={"acronyms_known": ["BERT"]}),
    Case("ACR-01", "a check identifier is not an acronym", ["Findings PRF-03 and BIB-01 were the most common in the whole audit."], False),
    Case("ACR-01", "a cited system's name", ["Gated consolidation lets ACE grow an evolving context over time~\\cite{a}."], False),
    Case("ACR-01", "the same name with no citation anywhere is jargon", ["Gated consolidation lets ACE grow an evolving context over time.", "The ACE context is rewritten by the reflector after every task."], True, "undefined:ACE"),
    Case("ACR-01", "common computing terms", ["Run the CLI and read the JSONL log written by the tool in the folder."], False),
    Case("ACR-02", "defined and never used again", ["Natural language processing (NLP) is common in many applications today."], True, "unused:NLP"),
    Case("ACR-02", "defined and used", ["Natural language processing (NLP) is common. NLP is used widely."], False),
    # ---- FMT-01
    Case("FMT-01", "plain space before a unit", ["The latency was 5 ms on average over the whole benchmark run."], True, "unit:5ms"),
    Case("FMT-01", "a file size", ["We stored a 12 GB file for every run of the whole benchmark suite."], True, "unit:12GB"),
    Case("FMT-01", "tie keeps them together", ["The latency was 5~ms on average over the whole benchmark run."], False),
    Case("FMT-01", "siunitx", ["The latency was \\SI{5}{ms} on average over the whole benchmark run."], False),
    Case("FMT-01", "inside maths", ["The latency was $5 ms$ on average over the whole benchmark run."], False),
    Case("FMT-01", "a one-letter unit is ambiguous and left alone", ["The run took 5 s on average over the whole benchmark run."], False),
    # ---- FMT-02
    Case("FMT-02", "both forms", ["It rose by 5\\% in the first year.", "It then fell by 3 percent in the second year."], True, "pct:word"),
    Case("FMT-02", "declared word form", ["Accuracy was 90\\% on the test set."], True, "pct:symbol", fmt={"percent": "word"}),
    Case("FMT-02", "only the sign", ["It rose by 5\\% in the first year.", "It then fell by 3\\% in the second year."], False),
    Case("FMT-02", "only the word", ["It rose by 5 percent in the first year."], False),
    Case("FMT-02", "'percentage' is not 'percent'", ["It rose by 5\\% and the percentage fell in the second year."], False),
    # ---- FMT-03
    Case("FMT-03", "plain cite among natbib", ["As shown by \\cite{a} earlier work.", "Many works agree~\\citep{b} on this point.", "Many works agree~\\citep{c} again on this."], True, "cite:cite"),
    Case("FMT-03", "declared natbib", ["Earlier work on this topic~\\cite{a} agrees with ours."], True, "cite:cite", fmt={"cite": "natbib"}),
    Case("FMT-03", "declared plain cite", ["Earlier work on this topic~\\citep{a} agrees with ours."], True, "cite:natbib", fmt={"cite": "cite"}),
    Case("FMT-03", "natbib throughout", ["Earlier work on this topic~\\citep{a} agrees with ours.", "See \\citet{b} for more details on it."], False),
    Case("FMT-03", "plain throughout", ["Earlier work on this topic~\\cite{a} agrees with ours.", "See also~\\cite{b} for more details on it."], False),
    Case("FMT-03", "biblatex commands are neither", ["Earlier work on this topic~\\parencite{a} agrees with ours.", "See \\textcite{b} for more details on it."], False),
    # ---- FMT-04
    Case("FMT-04", "one citation after the full stop", [
        "The method improves recall on every benchmark we tried in the study~\\cite{a}.",
        "Earlier work also found gains across all the corpora in the study~\\cite{b}.",
        "The method improves recall on every benchmark we tried in the study. \\cite{c}"], True, "citepos:after-punct"),
    Case("FMT-04", "always before", [
        "The method improves recall on every benchmark we tried in the study~\\cite{a}.",
        "Earlier work also found gains across all the corpora in the study~\\cite{b}."], False),
    Case("FMT-04", "a narrative citation starts a sentence", [
        "The method improves recall on every benchmark we tried in the study~\\cite{a}.",
        "The method improves recall on every benchmark we tried in the study. \\cite{c} showed that this holds."], False),
    Case("FMT-04", "et al. is not a sentence end", [
        "The method improves recall on every benchmark we tried in the study~\\cite{a}.",
        "Smith et al. \\cite{b} reported that the method improves recall in the whole study."], False),
    # ---- FMT-05
    Case("FMT-05", "a figure with no label", ["\\begin{figure}\n\\includegraphics{x}\n\\caption{A caption of the plot}\n\\end{figure}"], True),
    Case("FMT-05", "a labelled figure nobody mentions", ["\\begin{figure}\n\\includegraphics{x}\n\\caption{A plot}\n\\label{fig:a}\n\\end{figure}"], True, "unref:fig:a"),
    Case("FMT-05", "mentioned only after it appears", [
        "\\begin{figure}\n\\includegraphics{x}\n\\caption{A plot}\n\\label{fig:a}\n\\end{figure}",
        "As Figure~\\ref{fig:a} shows, recall improves on every benchmark in the whole study."], True, "late:fig:a", fmt={"figure_refs_before": True}),
    Case("FMT-05", "mentioned after it appears is fine by default", [
        "\\begin{figure}\n\\includegraphics{x}\n\\caption{A plot}\n\\label{fig:a}\n\\end{figure}",
        "As Figure~\\ref{fig:a} shows, recall improves on every benchmark in the whole study."], False),
    Case("FMT-05", "mentioned before it appears", [
        "As Figure~\\ref{fig:a} shows, recall improves on every benchmark in the whole study.",
        "\\begin{figure}\n\\includegraphics{x}\n\\caption{A plot}\n\\label{fig:a}\n\\end{figure}"], False, fmt={"figure_refs_before": True}),
    # ---- FMT-06
    Case("FMT-06", "one sentence-case heading among title case", [
        "\\section{Results on the Benchmark Datasets}", "\\section{Analysis of the error sources}", "\\section{Discussion of the Main Findings}"], True,
         "head:section:analysis of the error sources"),
    Case("FMT-06", "declared sentence case", ["\\section{Results on the Benchmark Datasets}"], True, None, fmt={"heading_case": "sentence"}),
    Case("FMT-06", "consistent title case", ["\\section{Results on the Benchmark Datasets}", "\\section{Discussion of the Main Findings}"], False),
    Case("FMT-06", "short headings cannot be told apart", ["\\section{Related Work}", "\\section{Method}", "\\section{Results and discussion}"], False),
    Case("FMT-06", "acronyms and proper nouns do not count as capitals", ["\\section{Training the BERT encoder on ImageNet}", "\\section{Results on the Benchmark Datasets}"], False),
    Case("FMT-06", "levels are separate", ["\\section{Results on the Benchmark Datasets}", "\\subsection{Analysis of the error sources}"], False),
    # ---- FMT-07
    Case("FMT-07", "one UK word among US", [
        "The color scheme was chosen carefully for the figure design.", "We normalize the inputs before training the network on them.",
        "The behavior of the system was stable across runs.", "The colour of the line shows the baseline in the plot."], True, "spell:colour"),
    Case("FMT-07", "declared US", ["The behaviour of the system was stable across all the runs."], True, "spell:behaviour", fmt={"spelling": "us"}),
    Case("FMT-07", "UK throughout", ["The colour scheme was chosen carefully.", "We normalise the inputs before training the network."], False),
    Case("FMT-07", "US throughout", ["The color scheme was chosen carefully.", "We normalize the inputs before training the network."], False),
    Case("FMT-07", "catalogue is fine in US English too", ["The catalog lists every check.", "The catalogue is long and it lists every check in the tool."], False),
    Case("FMT-07", "analyses is the plural of analysis in both", ["We analyze the data and report two analyses of the errors in the study."], False),
    # ---- FMT-08
    Case("FMT-08", "a doubled word", ["This is is a test of the system in the lab today."], True, "dup:is"),
    Case("FMT-08", "a doubled article, different case", ["We train The the model for ten epochs on the data."], True, "dup:the"),
    Case("FMT-08", "that that", ["It was shown that that approach works well in the lab."], False),
    Case("FMT-08", "had had", ["The team had had little time to prepare the whole study."], False),
    Case("FMT-08", "a citation between two identical words", ["We follow the work in \\cite{a} in the main experiments of the study."], False),
    Case("FMT-08", "punctuation between them", ["After the run ended. Ended runs were discarded from the study."], False),
    # ---- FMT-09
    Case("FMT-09", "a rare form among a common one", [
        "We use a dataset of images.", "The data set was cleaned.", "Each dataset has labels for training.", "A dataset is split into folds."], True, "term:data set"),
    Case("FMT-09", "a declared variant", ["We use a dataset of images in every experiment."], True, "term:dataset",
         glossary=[{"canonical": "data set", "variants": ["dataset"]}]),
    Case("FMT-09", "one form throughout", ["We use a dataset of images.", "Each dataset has labels for training."], False),
    Case("FMT-09", "a banned form is COH-01's", ["We use a dataset of images in every experiment."], False,
         glossary=[{"canonical": "data set", "banned": ["dataset"]}]),
    Case("FMT-09", "email and e-mail", ["Send an email to the editor.", "Send an e-mail to the author.", "Another email follows after this one."], True, "term:e-mail"),
    # ---- FMT-10
    Case("FMT-10", "one without the comma", [
        "Use tools (e.g., a hammer) when needed in the lab.", "Other tools (e.g., a saw) help too in the lab.", "Some tools (e.g. a drill) are used as well."],
         True, "eg:e.g.:nocomma"),
    Case("FMT-10", "declared with the comma", ["Some tools (e.g. a drill) are used as well in the lab."], True, "eg:e.g.:nocomma", fmt={"eg_comma": "yes"}),
    Case("FMT-10", "always with the comma", ["Use tools (e.g., a hammer) when needed.", "Use ideas (i.e., a plan) when needed."], False),
    Case("FMT-10", "never with the comma", ["Use tools (e.g. a hammer) when needed.", "Use ideas (i.e. a plan) when needed."], False),
    # ---- FMT-11
    Case("FMT-11", "a very long sentence", [LONG], True, "long:waa wab wac wad wae waf wag wah"),
    Case("FMT-11", "a lower limit", [MEDIUM], True, None, fmt={"sentence_max_words": 10}),
    Case("FMT-11", "a run-in heading is not part of the sentence", ["\\paragraph{" + words(30)[:-1] + "} " + words(40)], False),
    Case("FMT-11", "an ordinary sentence", [MEDIUM], False),
    Case("FMT-11", "switched off by a zero limit", [LONG], False, fmt={"sentence_max_words": 0}),
]


@pytest.fixture(scope="module")
def lab(tmp_path_factory):
    from conftest import write_anchored_project
    return write_anchored_project(tmp_path_factory.mktemp("fmt") / "p")


def analyse(root: Path, paras: list[str], fmt: dict | None = None, glossary: list[dict] | None = None, levels: dict | None = None):
    src = root / "src" / "sections"
    for f in src.glob("*/index.tex"):
        f.write_text("")
    (root / SECTION).write_text("\n\n".join(paras) + "\n")
    cfg = yaml.safe_load((root / "ah.yaml").read_text())
    cfg["style"] = {"format": fmt} if fmt else {}
    cfg["levels"] = levels or {}
    (root / "ah.yaml").write_text(yaml.safe_dump(cfg))
    (root / "glossary.yaml").write_text(yaml.safe_dump({"terms": glossary}) if glossary else "terms: []\n")
    assert main(["units", "--project", str(root), "sync"]) == 0
    return check_format(build_context(Project(str(root))))


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c.rule}:{c.name}")
def test_case(lab, case):
    found = [f for f in analyse(lab, case.paras, case.fmt, case.glossary) if f.check == case.rule]
    if case.fires:
        assert found, f"{case.rule} should fire on {case.paras!r}"
        if case.key:
            assert case.key in {f.key for f in found}, f"{case.key!r} not in {[f.key for f in found]}"
    else:
        assert not found, f"{case.rule} should be silent on {case.paras!r} but gave {[(f.key, f.message) for f in found]}"


def test_every_rule_has_positive_and_negative_cases():
    for rule in FORMAT_RULES:
        pos = [c for c in CASES if c.rule == rule and c.fires]
        neg = [c for c in CASES if c.rule == rule and not c.fires]
        assert pos and neg, f"{rule} needs at least one case that fires and one that does not"


def test_precision_and_recall_on_the_fixtures(lab, capsys):
    """Regression evidence only: the cases were written by the rules' author."""
    stats = {r: {"tp": 0, "fp": 0, "fn": 0, "tn": 0} for r in FORMAT_RULES}
    for c in CASES:
        fired = any(f.check == c.rule for f in analyse(lab, c.paras, c.fmt, c.glossary))
        key = ("tp" if fired else "fn") if c.fires else ("fp" if fired else "tn")
        stats[c.rule][key] += 1
    lines = ["rule    cases  precision  recall"]
    for r, s in stats.items():
        n = sum(s.values())
        prec = s["tp"] / (s["tp"] + s["fp"]) if s["tp"] + s["fp"] else 1.0
        rec = s["tp"] / (s["tp"] + s["fn"]) if s["tp"] + s["fn"] else 1.0
        lines.append(f"{r:7} {n:5}  {prec:9.2f}  {rec:6.2f}")
        assert prec == 1.0 and rec == 1.0, f"{r}: {s}"
    print("\n" + "\n".join(lines))


# ---- helpers behind the rules ----

def test_prose_view_never_joins_words_across_what_it_removes():
    s = prose("We follow \\cite{a} the work in \\ref{x} in $x$ in \\emph{short} text\\footnote{note} here~now.")
    assert "follow ‡ the" in s and "in ¤ in" in s and "emph" not in s and "now" in s
    assert "risk_tier" not in prose("the field \\texttt{risk\\_tier} is set") and "¤" in prose("the field \\texttt{risk} is set")
    assert prose("\\paragraph{Gated consolidation} ACE grows and consolidates.").startswith("Gated consolidation. ACE")


def test_acronym_initials():
    assert initials_match("NLP", ["natural", "language", "processing"])
    assert initials_match("CNN", ["convolutional", "neural", "network"])
    assert initials_match("LSTM", ["long", "short-term", "memory"])
    assert initials_match("SVM", ["support", "vector", "machine"])
    assert initials_match("MoE", ["x"]) is False
    assert initials_match("RLHF", ["reinforcement", "learning", "from", "human", "feedback"]), "small words may be skipped"
    assert not initials_match("XYZ", ["big", "cats"])


def test_heading_case_needs_enough_evidence():
    assert heading_case("Results on the Benchmark Datasets") == "title"
    assert heading_case("Results on the benchmark datasets") == "sentence"
    assert heading_case("Related Work") is None and heading_case("Method") is None
    assert heading_case("Training the BERT encoder on ImageNet") is None


def test_minority_is_the_form_that_disagrees_and_ties_keep_the_first_seen():
    from collections import Counter
    assert minority(Counter(us=3, uk=1), {"us": 0, "uk": 1}) == {"uk"}
    assert minority(Counter(us=1, uk=1), {"us": 5, "uk": 2}) == {"us"}, "a tie keeps the form that appeared first"
    assert minority(Counter(us=4), {"us": 0}) == set()


# ---- levels, determinism, the ledger ----

def test_every_rule_ships_at_info_and_levels_in_ah_yaml_promote_or_silence_it(lab):
    for rule in FORMAT_RULES:
        assert CATALOGUE[rule][0] == "T5" and CATALOGUE[rule][1] == "info", rule
    text = ["This is is a test of the system in the lab today."]
    assert {f.level for f in analyse(lab, text) if f.check == "FMT-08"} == {"info"}
    assert {f.level for f in analyse(lab, text, levels={"FMT-08": "minor"}) if f.check == "FMT-08"} == {"minor"}
    assert not [f for f in analyse(lab, text, levels={"FMT-08": "off"}) if f.check == "FMT-08"]


def test_the_rules_are_in_the_default_audit_and_do_not_move(project_dir):
    path = project_dir / SECTION
    path.write_text("\\section{Experiments}\n\nThis is is a test of the system in the lab today, using 5 ms budgets.\n\n"
                    "Natural language processing (NLP) is common in many applications today.\n")
    assert main(["units", "--project", str(project_dir), "sync"]) == 0
    runs = [audit(Project(str(project_dir)), DEFAULT_TIERS) for _ in range(3)]
    fired = {f["check"] for f in runs[0]["findings"]}
    assert {"FMT-08", "FMT-01", "ACR-02"} <= fired
    assert len({r["report_hash"] for r in runs}) == 1
    assert runs[1]["ledger"]["new"] == 0 and runs[2]["ledger"]["new"] == 0 and not runs[2]["unexplained"]


def test_a_finding_keeps_its_identity_when_text_above_it_changes(project_dir):
    path = project_dir / SECTION
    path.write_text("A first paragraph that says nothing in particular about the study.\n\nThis is is a test of the system in the lab today.\n")
    assert main(["units", "--project", str(project_dir), "sync"]) == 0
    before = {f["fingerprint"] for f in audit(Project(str(project_dir)), DEFAULT_TIERS)["findings"] if f["check"] == "FMT-08"}
    path.write_text("A new opening paragraph.\n\nAnother one before it.\n\n" + path.read_text())
    assert main(["units", "--project", str(project_dir), "sync"]) == 0
    rep = audit(Project(str(project_dir)), DEFAULT_TIERS)
    assert {f["fingerprint"] for f in rep["findings"] if f["check"] == "FMT-08"} == before and before
    assert not rep["unexplained"]


def test_fixing_the_text_closes_the_finding_with_a_cause(project_dir):
    path = project_dir / SECTION
    path.write_text("This is is a test of the system in the lab today.\n")
    assert main(["units", "--project", str(project_dir), "sync"]) == 0
    audit(Project(str(project_dir)), DEFAULT_TIERS)
    path.write_text(path.read_text().replace("is is", "is"))
    rep = audit(Project(str(project_dir)), DEFAULT_TIERS)
    assert not [f for f in rep["findings"] if f["check"] == "FMT-08"] and rep["ledger"]["fixed"] >= 1 and not rep["unexplained"]


def test_the_clean_fixture_project_has_no_format_findings(project_dir):
    assert not check_format(build_context(Project(str(project_dir))))


# ---- ah precision ----

def test_ah_precision_turns_fix_and_waive_decisions_into_an_estimate(project_dir, capsys):
    from ah.ledger.db import Ledger
    path = project_dir / SECTION
    path.write_text("This is is a test of the system in the lab.\n\nWe stored a 12 GB file for every run of the study.\n\n"
                    "Another is is repeated here in the text of the study.\n")
    assert main(["units", "--project", str(project_dir), "sync"]) == 0
    rep = audit(Project(str(project_dir)), DEFAULT_TIERS)
    dup = sorted((f for f in rep["findings"] if f["check"] == "FMT-08"), key=lambda f: f["line"])      # first and third paragraph
    unit = [f for f in rep["findings"] if f["check"] == "FMT-01"]
    assert len(dup) == 2 and len(unit) == 1
    assert main(["finding", "waive", dup[1]["fingerprint"][:10], "--by", "author", "--reason", "intended", "--project", str(project_dir), "--yes"]) == 0
    path.write_text(path.read_text().replace("This is is a", "This is a"))              # the author fixes the other one
    audit(Project(str(project_dir)), DEFAULT_TIERS)
    capsys.readouterr()
    assert main(["precision", "--project", str(project_dir), "--json"]) == 0
    rows = {r["check"]: r for r in json.loads(capsys.readouterr().out)["checks"]}
    assert (rows["FMT-08"]["fixed"], rows["FMT-08"]["waived"], rows["FMT-08"]["decided"], rows["FMT-08"]["precision"]) == (1, 1, 2, 0.5)
    assert rows["FMT-08"]["verdict"] == "too few decisions" and rows["FMT-01"]["open"] == 1 and rows["FMT-01"]["precision"] is None


def test_ah_precision_without_a_ledger_says_so(project_dir, capsys):
    assert main(["precision", "--project", str(project_dir)]) == 0
    assert "no ledger" in capsys.readouterr().out


# ---- the post-edit hook ----

def _post_edit(root: Path, sid: str):
    from ah import hooks
    data = {"session_id": sid, "cwd": str(root), "tool_name": "Edit", "tool_input": {"file_path": str(root / SECTION)}}
    hooks.handle("userprompt", dict(data, tool_name="", tool_input={}))        # the baseline, taken before the edit
    path = root / SECTION
    path.write_text(path.read_text() + "\nThis is is a test of the system in the lab today, using 5 ms budgets.\n")
    return hooks.handle("post", data)


def test_the_post_edit_hook_stays_quiet_about_advisory_format_rules(project_dir):
    out = _post_edit(project_dir, "quiet")
    assert out is None or "FMT-0" not in out["hookSpecificOutput"]["additionalContext"], "info-level format rules are not an agent's to-do list"


def test_once_promoted_a_format_rule_does_reach_the_agent(project_dir):
    cfg = yaml.safe_load((project_dir / "ah.yaml").read_text())
    cfg["levels"] = {"FMT-08": "minor"}
    (project_dir / "ah.yaml").write_text(yaml.safe_dump(cfg))
    out = _post_edit(project_dir, "loud")
    note = out["hookSpecificOutput"]["additionalContext"]
    assert "FMT-08" in note and "FMT-01" not in note, "the promoted rule is reported; the others stay advisory"
