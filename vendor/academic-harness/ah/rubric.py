"""The frozen rubric (tier TR): fixed yes/no criteria about one paragraph, judged by a model, quote-checked.

A free-form review asks the model what it notices, so it notices something different each time. A criterion is
the opposite: one question, written down, with a version. The model answers it about one paragraph; a "yes"
(the problem is present) must quote the words that show it, and the quote is checked against the paragraph here.
The verdict is cached on (criterion, paragraph, model, prompt version), so unchanged text is never judged twice
and always gets the same answer.

A criterion reports at info until the author has measured it. `ah rubric admit` runs the model over units the
author labelled by hand and records Cohen's kappa and precision; only a criterion whose question and model still
match its admission can report above info, and so only then can it gate.

Criteria ask about DEFECTS in text that exists ("yes" = the problem is there), because only a defect has words to
quote. Omissions (a missing section, a missing statement) belong to profile rules, which are exact.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import yaml

from .checks.base import LEVEL_ORDER
from .util import canonical_json, sha1

BUNDLED = Path(__file__).parent / "rubrics"
ADMISSIONS_FILE = "rubric/admissions.yaml"
LABELS_DIR = "rubric/labels"
ID_RE = re.compile(r"^RUB-[A-Z0-9][A-Z0-9-]*$")
KINDS = ("para", "float", "display")


@dataclass
class Criterion:
    id: str
    version: int
    question: str
    level: str
    files: list[str]
    kinds: tuple[str, ...]
    min_words: int
    origin: str

    def qhash(self) -> str:
        """What the model is asked. Level, scope and admission do not change an answer, so they are not in it."""
        return sha1(canonical_json({"id": self.id, "version": self.version, "question": " ".join(self.question.split())}), 16)


@dataclass
class Problem:
    file: str
    key: str
    message: str


def _read(path: Path):
    try:
        return yaml.safe_load(path.read_text()) or {}
    except (OSError, yaml.YAMLError) as e:
        return e


def _parse(raw: dict, origin: str, defaults: dict) -> Criterion | str:
    cid = str(raw.get("id") or "")
    if not ID_RE.match(cid):
        return f"criterion id {cid!r} must look like RUB-NAME (capitals, digits, dashes)"
    q = " ".join(str(raw.get("question") or "").split())
    if len(q) < 20 or not q.endswith("?"):
        return f"{cid}: question must be a full yes/no question ending in '?'"
    level = str(raw.get("level") or "minor")
    if level not in LEVEL_ORDER:
        return f"{cid}: level must be one of {', '.join(LEVEL_ORDER)}"
    version = raw.get("version", 1)
    if not isinstance(version, int) or version < 1:
        return f"{cid}: version must be a positive integer"
    scope = raw.get("scope") or {}
    files = scope.get("files") or ["*"]
    kinds = tuple(scope.get("kinds") or ["para"])
    if isinstance(files, str):
        files = [files]
    if not all(isinstance(g, str) for g in files) or any(k not in KINDS for k in kinds):
        return f"{cid}: scope.files must be globs and scope.kinds from {', '.join(KINDS)}"
    return Criterion(cid, version, q, level, list(files), kinds, int(scope.get("min_words", defaults["min_words"])), origin)


def load_criteria(project) -> tuple[list[Criterion], list[Problem]]:
    """Bundled sets named by the profile, then the project's own files; a later definition of an id replaces an earlier
    one (so a project can reword a bundled criterion), but two in the same layer are a mistake."""
    cfg = project.cfg.get("criteria") or {}
    defaults = {"min_words": int(cfg.get("min_words", 12))}
    by_id: dict[str, Criterion] = {}
    problems: list[Problem] = []

    def layer(items: list[tuple[str, object]]):
        seen: set[str] = set()
        for origin, data in items:
            if isinstance(data, Exception):
                problems.append(Problem(origin, f"unreadable:{origin}", f"{origin} cannot be read: {data}"))
                continue
            rows = data.get("criteria") if isinstance(data, dict) else None
            if not isinstance(rows, list):
                problems.append(Problem(origin, f"layout:{origin}", f"{origin} needs a top-level `criteria:` list"))
                continue
            for raw in rows:
                got = _parse(raw if isinstance(raw, dict) else {}, origin, defaults)
                if isinstance(got, str):
                    problems.append(Problem(origin, f"invalid:{origin}:{got[:60]}", f"{origin}: {got}"))
                    continue
                if got.id in seen:
                    problems.append(Problem(origin, f"duplicate:{got.id}", f"{origin}: criterion {got.id} is defined twice in the same layer"))
                    continue
                seen.add(got.id)
                by_id[got.id] = got

    profile_items = []
    for name in (project.profile.rubric if project.profile else []):
        f = BUNDLED / f"{name}.yaml"
        profile_items.append((f"profile set {name}", _read(f) if f.is_file() else FileNotFoundError(f"no bundled criteria set '{name}'")))
    layer(profile_items)
    skip = {(project.root / ADMISSIONS_FILE).resolve()}
    project_items = []
    for pattern in cfg.get("files") or ["rubric/*.yaml"]:
        for f in sorted(project.root.glob(pattern)):
            if f.is_file() and f.resolve() not in skip:
                project_items.append((f.relative_to(project.root).as_posix(), _read(f)))
    layer(project_items)
    off = set(cfg.get("off") or [])
    return sorted((c for c in by_id.values() if c.id not in off), key=lambda c: c.id), problems


def load_admissions(project) -> dict[str, dict]:
    data = _read(project.root / ADMISSIONS_FILE) if (project.root / ADMISSIONS_FILE).is_file() else {}
    return dict(data.get("admitted") or {}) if isinstance(data, dict) else {}


def configured_model(cfg: dict) -> str | None:
    """The model label the configured backend will report, so cached verdicts can be read with no backend at all."""
    v = cfg.get("verifier") or {}
    kind = v.get("backend")
    if kind in ("pi", "http"):
        return v.get("model") or None
    if kind == "command":
        return " ".join(v.get("cmd") or [])[:60] or None
    return None


def is_admitted(crit: Criterion, admissions: dict, model: str | None) -> bool:
    """An admission is evidence about THIS question and THIS model; changing either voids it."""
    a = admissions.get(crit.id)
    return bool(a) and model is not None and a.get("question_hash") == crit.qhash() and a.get("model") == model


def admitted_ids(project) -> list[str]:
    """Criteria whose admission still holds for the configured model (so the only ones that may report above info)."""
    adm, model = load_admissions(project), configured_model(project.cfg)
    return [c.id for c in load_criteria(project)[0] if is_admitted(c, adm, model)]


def criteria_digest(project) -> str:
    """Everything that decides what the rubric asks and what it may gate; "" when the project has no rubric."""
    try:
        crits, problems = load_criteria(project)
        if not crits and not problems:
            return ""
        adm = load_admissions(project)
        body = [[c.id, c.version, c.qhash(), c.level, c.files, list(c.kinds), c.min_words] for c in crits]
        return sha1(canonical_json({"c": body, "p": sorted(p.key for p in problems), "a": adm}), 16)
    except Exception:       # a snapshot must never be the thing that fails
        return "unreadable"


def in_scope(c: Criterion, unit) -> bool:
    if unit.kind not in c.kinds or unit.words < c.min_words:
        return False
    path = unit.file.lower()
    return any(fnmatch.fnmatch(path, g.lower()) for g in c.files)


# ---- agreement with the author's hand labels ----

def cohens_kappa(pairs: list[tuple[bool, bool]]) -> float:
    """Chance-corrected agreement between two yes/no raters. 1 = perfect, 0 = no better than chance."""
    n = len(pairs)
    if not n:
        return 0.0
    po = sum(a == b for a, b in pairs) / n
    pa, pb = sum(a for a, _ in pairs) / n, sum(b for _, b in pairs) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    if pe >= 1.0:
        return 1.0 if po == 1.0 else 0.0
    return (po - pe) / (1 - pe)


def agreement(pairs: list[tuple[bool, bool]]) -> dict:
    """pairs are (model says defect, author says defect)."""
    tp = sum(m and h for m, h in pairs)
    fp = sum(m and not h for m, h in pairs)
    fn = sum(h and not m for m, h in pairs)
    tn = sum(not m and not h for m, h in pairs)
    return {
        "n": len(pairs), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "positives": tp + fn, "negatives": fp + tn,
        "kappa": round(cohens_kappa(pairs), 4),
        "precision": round(tp / (tp + fp), 4) if tp + fp else 0.0,
        "recall": round(tp / (tp + fn), 4) if tp + fn else 0.0,
    }


def admission_failures(stats: dict, min_labels: int, min_per_class: int, min_kappa: float, min_precision: float) -> list[str]:
    out = []
    if stats["n"] < min_labels:
        out.append(f"only {stats['n']} usable labels; need at least {min_labels}")
    if stats["positives"] < min_per_class or stats["negatives"] < min_per_class:
        out.append(f"need at least {min_per_class} labelled defects and {min_per_class} labelled non-defects (have {stats['positives']} and {stats['negatives']})")
    if stats["kappa"] < min_kappa:
        out.append(f"kappa {stats['kappa']} is below {min_kappa}")
    if stats["precision"] < min_precision:
        out.append(f"precision {stats['precision']} is below {min_precision}: it would flag text the author considers fine")
    return out


def write_admission(project, crit: Criterion, model: str, stats: dict, labels_sha: str, by: str = "author") -> Path:
    path = project.root / ADMISSIONS_FILE
    data = _read(path) if path.is_file() else {}
    data = data if isinstance(data, dict) else {}
    admitted = dict(data.get("admitted") or {})
    admitted[crit.id] = {
        "question_hash": crit.qhash(), "version": crit.version, "model": model, "kappa": stats["kappa"], "precision": stats["precision"],
        "recall": stats["recall"], "n": stats["n"], "positives": stats["positives"], "negatives": stats["negatives"],
        "labels_sha": labels_sha, "admitted_at": date.today().isoformat(), "by": by,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# Written by `ah rubric admit`. An admission is void if the question or the model changes.\n"
                    + yaml.safe_dump({"admitted": dict(sorted(admitted.items()))}, sort_keys=False))
    return path


def load_labels(path: Path) -> list[dict]:
    data = _read(path)
    if isinstance(data, Exception) or not isinstance(data, dict) or not isinstance(data.get("labels"), list):
        raise ValueError(f"{path}: expected a top-level `labels:` list of {{unit, hash, label: yes|no}}")
    out = []
    for i, row in enumerate(data["labels"]):
        label = str(row.get("label")).strip().lower() if isinstance(row, dict) else ""
        if label not in ("yes", "no") or not row.get("unit"):
            raise ValueError(f"{path}: label {i} needs a unit and label: yes|no (yes = the defect is present)")
        out.append({"unit": str(row["unit"]), "hash": str(row.get("hash") or ""), "label": label == "yes"})
    return out
