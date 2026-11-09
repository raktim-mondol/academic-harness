"""Findings, levels and the check catalogue (design 5.3, 5.4, Appendix A)."""
from __future__ import annotations

from dataclasses import dataclass

from ..util import sha1

LEVEL_ORDER = {"blocker": 0, "major": 1, "minor": 2, "info": 3}

# check id -> (tier, default level, title). A project can override levels or turn a check off.
CATALOGUE: dict[str, tuple[str, str, str]] = {
    "TEX-01": ("T0", "blocker", "LaTeX build error"),
    "TEX-05": ("T0", "blocker", "\\input names a file that does not exist"),
    "TEX-04": ("T0", "minor", "Overfull boxes in the build log"),
    "UNIT-01": ("T0", "minor", "Unit anchor missing, duplicated, orphaned"),
    "UNIT-02": ("T0", "major", "File not reachable from any view"),
    "UNIT-03": ("T0", "major", "A view file holds prose that no check reads"),
    "UNIT-04": ("T0", "major", "Included prose excluded from audit coverage"),
    "TEX-02": ("T0", "blocker", "Reference to an undefined label"),
    "TEX-03": ("T0", "major", "Duplicate label"),
    "LAT-02": ("T0", "minor", "File longer than the soft line limit"),
    "LAT-03": ("T0", "minor", "Paragraph longer than the word limit"),
    "LAT-06": ("T0", "minor", "Label inside running prose"),
    "LAT-07": ("T0", "minor", "Label prefix does not match its context"),
    "LAT-11": ("T0", "major", "TeX file outside the TeX root (misplaced file)"),
    "LAT-10": ("T0", "minor", "Commented-out prose"),
    "NUM-001": ("T1", "major", "Literal number not backed by a fact or binding"),
    "NUM-002": ("T1", "blocker", "Facts do not build or the macro file is stale"),
    "NUM-003": ("T1", "blocker", "Bound literal differs from its fact"),
    "NUM-004": ("T1", "blocker", "Percentage, interval or sum does not reconcile"),
    "NUM-005": ("T1", "blocker", "Fact macro used but undefined"),
    "NUM-007": ("T1", "blocker", "\\fact is used but no view inputs the generated macro file"),
    "NUM-006": ("T1", "minor", "Fact defined but never used"),
    "STALE-01": ("T1", "major", "Literal equals a superseded value of a fact"),
    "BIB-01": ("T2", "blocker", "Cited key not in the bibliography"),
    "BIB-02": ("T2", "major", "Cited key not in the source registry"),
    "BIB-03": ("T2", "major", "Bibliography fields differ from the registry"),
    "BIB-04": ("T2", "blocker", "Cited source is retracted, corrected or superseded"),
    "BIB-05": ("T2", "info", "Bibliography entries never cited"),
    "BIB-06": ("T2", "major", "Duplicate bibliography key"),
    "COH-01": ("T4", "minor", "Banned or inconsistent term"),
    "COH-02": ("T4", "major", "Source outside the allowed scope for this section"),
    "COH-03": ("T4", "major", "Mirrored fact missing from a file that must state it"),
    "EVD-01": ("T3", "major", "Cited source does not support the claim as stated (model verdict, quote-checked)"),
    "EVD-02": ("T3", "minor", "Number in a cited sentence not found in the cited source"),
    "EVD-03": ("T3", "info", "Verifier error: the claim was not checked"),
    "EVD-04": ("T3", "major", "Cited key has no source text"),
    "EVD-05": ("T4", "major", "A claim's bound source passage is no longer in the source text"),
    "CLM-02": ("T4", "info", "Cited claim has no binding (when the project requires one)"),
    "CLM-05": ("T4", "minor", "Claim text changed after it was bound or verified"),
    "BRF-01": ("T5", "major", "Brief claim not realised in the text (missing fact or citation)"),
    "BRF-02": ("T5", "minor", "Length outside the brief's range"),
    "BRF-03": ("T5", "minor", "Term the brief asks for is not used"),
    "BRF-04": ("T5", "minor", "Citation the brief does not plan for"),
    "BRF-05": ("T5", "major", "Brief names a fact or source that does not exist"),
    "BRF-06": ("T5", "info", "Brief target not written yet"),
    "STY-01": ("T5", "minor", "Style pattern lint (brief must-not/hedging, or document lint)"),
    # Format and consistency rules (checks/t5_format.py). All start at info: promote one in ah.yaml `levels:` after
    # `ah precision` shows how often the author fixes what it flags and how often they waive it.
    "ACR-01": ("T5", "info", "Acronym used before its definition, or defined twice"),
    "ACR-02": ("T5", "info", "Acronym defined but never used again"),
    "ACR-03": ("T5", "info", "Acronym used but never defined (cannot tell jargon from a name: lowest precision of the format rules)"),
    "FMT-01": ("T5", "info", "Number and unit separated by an ordinary space (can break across a line)"),
    "FMT-02": ("T5", "info", "Percent sign and the word 'percent' both used"),
    "FMT-03": ("T5", "info", "Citation commands mixed or different from the declared style (\\cite against \\citep/\\citet)"),
    "FMT-04": ("T5", "info", "Citation placed before the full stop in some places and after it in others"),
    "FMT-05": ("T5", "info", "Figure or table has no label, is never referred to, or appears before it is first mentioned"),
    "FMT-06": ("T5", "info", "Heading capitalisation (sentence case against title case) is inconsistent"),
    "FMT-07": ("T5", "info", "US and UK spelling mixed"),
    "FMT-08": ("T5", "info", "Word repeated ('the the')"),
    "FMT-09": ("T5", "info", "Term written in more than one form (dataset / data set / data-set)"),
    "FMT-10": ("T5", "info", "'e.g.' / 'i.e.' written with a comma in some places and without in others"),
    "FMT-11": ("T5", "info", "Sentence longer than the limit"),
    "ARG-01": ("T5", "major", "Outline claim has no existing supporting unit"),
    "ARG-02": ("T5", "major", "Outline section matches no file"),
    "ARG-03": ("T5", "major", "No outline claim supports the thesis"),
    "ARG-04": ("T5", "minor", "Outline claim supports an unknown id"),
    "ARG-05": ("T5", "info", "Planned outline section is still unwritten"),
    "PLN-01": ("T5", "blocker", "New prose file not in the approved outline or an approved brief"),
    "PLN-02": ("T5", "major", "Approved outline changed outside ah plan approve"),
    "PRM-01": ("T5", "info", "A rule promoted from a review comment matched (the author accepted the rule; it ships with its own fixtures)"),
    "PRM-02": ("T5", "major", "A promoted rule is broken: it does not compile, or one of its own fixtures fails"),
    "REV-01": ("T5", "major", "Review item marked addressed but no mapped unit changed"),
    "REV-02": ("T5", "info", "Review item still open"),
    "REV-03": ("T5", "info", "Unit changed since the review snapshot but belongs to no item"),
    "REV-04": ("T5", "major", "Review item has a status but no response text"),
    "REV-05": ("T5", "major", "Review item mapped to a unit that does not exist"),
    "REV-06": ("T5", "major", "Review refers to a snapshot that does not exist"),
    "CLM-04": ("T4", "major", "Absence or count claim has counterexamples in the sources"),
    "PRF-01": ("T6", "major", "Profile: a required section is missing"),
    "PRF-02": ("T6", "blocker", "Profile: an arithmetic identity between facts does not hold"),
    "PRF-03": ("T6", "major", "Profile: a checklist item is not mapped to existing text"),
    "PRF-04": ("T6", "major", "Profile: a length limit is exceeded"),
    "PRF-05": ("T6", "minor", "Profile: text matches a forbidden pattern"),
    "PRF-06": ("T6", "major", "Profile: the record graph is inconsistent (references, ranges, sums)"),
    "PRF-07": ("T6", "major", "Profile: a required item (criterion, outcome, contribution) is not covered by text"),
    "PRF-08": ("T6", "major", "Profile: a rule or its data file is missing or malformed"),
    "PRF-09": ("T6", "major", "Profile: a reviewer item is not closed"),
    # TX: results of external tools (numbers_audit, figure_audit, citation audit), read from .ah/external/.
    # They ship at minor unless they are a registry fact, because the tools report candidates for review.
    # A project promotes one in ah.yaml `levels:` once it has seen how precise it is on its own text.
    "STAT-01": ("TX", "minor", "Reported p-value does not match its test statistic"),
    "STAT-02": ("TX", "minor", "GRIM: a reported mean is impossible for the stated sample size"),
    "STAT-03": ("TX", "minor", "Sample size, flow count or percentage does not reconcile in the text"),
    "STAT-04": ("TX", "minor", "Confidence interval or effect estimate is inconsistent"),
    "STAT-05": ("TX", "minor", "Table value differs from the value stated in the text"),
    "FIG-01": ("TX", "minor", "Figure resolution is below the minimum DPI"),
    "FIG-02": ("TX", "minor", "Near-duplicate figure files"),
    "FIG-03": ("TX", "info", "Figure file has no DPI metadata"),
    "FIG-04": ("TX", "major", "Figure file cannot be read"),
    "CIT-01": ("TX", "blocker", "Cited reference is retracted (registry record)"),
    "CIT-02": ("TX", "major", "Reference DOI is invalid or not registered"),
    "CIT-03": ("TX", "major", "Reference has an expression of concern or a correction"),
    "CIT-04": ("TX", "minor", "Reference metadata differs from the registry record"),
    "CIT-05": ("TX", "minor", "Reference is duplicated, incomplete or does not format"),
    "CIT-06": ("TX", "info", "Reference could not be verified (no DOI, or the lookup failed)"),
    "RPT-01": ("TX", "minor", "Reporting-guideline item is recorded as not reported or only partly reported"),
    "RPT-02": ("TX", "major", "A recorded reporting verdict no longer verifies against the manuscript (its quote is gone)"),
    "RPT-03": ("TX", "info", "Reporting-guideline item needs a verdict: not assessed yet, or a not-reported claim from an earlier manuscript version"),
    "EXT-00": ("TX", "major", "An external check is stale, invalid or was not run"),
    # TR: the frozen rubric. A model answers fixed yes/no questions about one paragraph and must quote the words
    # that show the problem; the quote is checked here. A criterion reports at info until it is admitted.
    "RUB-01": ("TR", "info", "Rubric criterion failed: the model found the defect and quoted it (the quote is verified)"),
    "RUB-02": ("TR", "major", "Rubric: a criteria file is malformed, or a criterion id is duplicated"),
}

TIERS = ("T0", "T1", "T2", "T3", "T4", "T5", "T6", "TX", "TR")
DEFAULT_TIERS = ("T0", "T1", "T2", "T3", "T4", "T5", "T6")  # T3 deterministic half runs by default; the model half needs a backend. TX joins only when --external is given, TR only with --rubric.


@dataclass
class Finding:
    check: str
    level: str
    ref: str | None        # unit ref (anchor id or file#hash), None for file-level findings
    file: str | None
    line: int | None       # informational only; never part of the fingerprint
    key: str               # stable locus key (e.g. the literal and its sentence), not a line number
    message: str
    tier: str = ""

    def fingerprint(self) -> str:
        return sha1(f"{self.check}|{self.ref or self.file}|{self.key}", 16)

    def to_dict(self) -> dict:
        return {"fingerprint": self.fingerprint(), "check": self.check, "tier": self.tier,
                "level": self.level, "unit": self.ref, "file": self.file, "line": self.line,
                "key": self.key, "message": self.message}


def sort_key(f: Finding):
    return (LEVEL_ORDER.get(f.level, 9), f.check, f.file or "", f.ref or "", f.key)


def make(project_cfg: dict, check: str, ref, file, line, key, message) -> Finding | None:
    tier, level, _ = CATALOGUE[check]
    level = (project_cfg.get("levels") or {}).get(check, level)
    if level == "off":
        return None
    return Finding(check, level, ref, file, line, key, message, tier)
