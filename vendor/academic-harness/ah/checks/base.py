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
    "ARG-01": ("T5", "major", "Outline claim has no existing supporting unit"),
    "ARG-02": ("T5", "major", "Outline section matches no file"),
    "ARG-03": ("T5", "major", "No outline claim supports the thesis"),
    "ARG-04": ("T5", "minor", "Outline claim supports an unknown id"),
    "ARG-05": ("T5", "info", "Planned outline section is still unwritten"),
    "PLN-01": ("T5", "blocker", "New prose file not in the approved outline or an approved brief"),
    "PLN-02": ("T5", "major", "Approved outline changed outside ah plan approve"),
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
}

TIERS = ("T0", "T1", "T2", "T3", "T4", "T5", "T6")
DEFAULT_TIERS = ("T0", "T1", "T2", "T3", "T4", "T5", "T6")  # T3 deterministic half runs by default; the model half needs a backend


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
