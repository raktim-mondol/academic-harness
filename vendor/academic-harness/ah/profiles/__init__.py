"""Document-type profiles (design 9): a profile is data. It names the structure, defaults, scaffold files and a list of
declarative rules; the rule kinds live in `rules.py`. Adding a profile never needs a core change."""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

HERE = Path(__file__).parent
_VAR = re.compile(r"\$\{(\w+)\}")


@dataclass
class Profile:
    name: str
    dir: Path
    description: str = ""
    params: dict = field(default_factory=dict)
    defaults: dict = field(default_factory=dict)
    sections: list = field(default_factory=list)       # headings the scaffold creates
    scaffold: dict = field(default_factory=dict)        # project-relative path -> file text
    scaffold_facts: list = field(default_factory=list)  # fact entries appended to facts.yaml by `ah init`
    rules: list = field(default_factory=list)
    rubric: list = field(default_factory=list)          # names of bundled criteria sets (ah/rubrics/<name>.yaml)


def names() -> list[str]:
    return sorted(p.parent.relative_to(HERE).as_posix() for p in HERE.rglob("profile.yaml"))


def load(name: str | None) -> Profile | None:
    if not name or name == "generic":
        return None
    if ".." in name or name.startswith("/"):
        raise ValueError(f"bad profile name '{name}'")
    f = HERE / name / "profile.yaml"
    if not f.is_file():
        raise ValueError(f"unknown profile '{name}'; available: generic, {', '.join(names())}")
    raw = yaml.safe_load(f.read_text()) or {}
    return Profile(name, f.parent, raw.get("description", ""), raw.get("params") or {}, raw.get("defaults") or {},
                   raw.get("sections") or [], raw.get("scaffold") or {}, raw.get("scaffold_facts") or [], raw.get("rules") or [], list(raw.get("rubric") or []))


def resolve(obj: Any, params: dict) -> Any:
    """Replace "${name}" in rule values. A value that is exactly one reference keeps the parameter's type."""
    if isinstance(obj, str):
        m = _VAR.fullmatch(obj)
        if m:
            return copy.deepcopy(params.get(m.group(1), obj))
        return _VAR.sub(lambda mm: str(params.get(mm.group(1), mm.group(0))), obj)
    if isinstance(obj, list):
        return [resolve(x, params) for x in obj]
    if isinstance(obj, dict):
        return {k: resolve(v, params) for k, v in obj.items()}
    return obj


def project_rules(project) -> list[dict]:
    """Profile rules with parameters filled in, then the project's own extra rules (`profile_rules` in ah.yaml)."""
    prof = project.profile
    params = {**(prof.params if prof else {}), **(project.cfg.get("profile_params") or {})}
    rules = [resolve(r, params) for r in (prof.rules if prof else [])]
    rules += [resolve(r, params) for r in (project.cfg.get("profile_rules") or [])]
    return [r for r in rules if _enabled(r, params)]


def _enabled(rule: dict, params: dict) -> bool:
    w = rule.get("when")
    return not (w and "param" in w and not params.get(w["param"]))


def protected_files(project) -> list[str]:
    """Record files that define the document's numbers and structure (grant budget, thesis chapters): the author owns them."""
    return [r["file"] for r in project_rules(project) if r.get("kind") == "records" and r.get("file")]
