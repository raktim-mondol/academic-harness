"""Project manifest (ah.yaml), paths and snapshot hashing (design 3, 4.1, 5.2)."""
from __future__ import annotations

import copy
import fnmatch
from pathlib import Path
from typing import Any

import yaml

from . import RUBRIC_VERSION, profiles
from .util import canonical_json, sha1, sha256_file

DEFAULTS: dict[str, Any] = {
    "project": "untitled",
    "profile": "generic",
    "rubric": RUBRIC_VERSION,
    "tex": {
        "root": ".",
        "views": ["main.tex"],
        "prose": ["**/*.tex"],
        "ignore": ["build/**", ".ah/**"],
        "bib": ["references.bib"],
    },
    "facts": "facts/facts.yaml",
    "facts_macros": "macros/facts.tex",   # relative to tex root; generated, never edited
    "sources": "sources/registry.yaml",
    "glossary": "glossary.yaml",
    "bindings": "bindings.yaml",
    "scope": {},          # {path-glob: [allowed source tags]}; applies to cites in matching files
    "scope_allow": {},    # {path-glob: [source keys]} accepted exceptions to `scope`, decided by the author
    "mirrors": [],        # [{fact: id, variant: pct, files: [globs]}]
    "absence": [],        # [{id, terms: [..], files: [glob], where: ..., unit: id}]
    "levels": {},         # {CHECK-ID: blocker|major|minor|info|off}
    "limits": {"lines_soft": 400, "lines_hard": 800, "para_words_soft": 180, "para_words_hard": 250},
    "gate": {"blocking_levels": ["blocker", "major"], "max_loops": 3, "mode": "new", "verify_touched": False, "judge_touched": False},   # mode new: only findings this prompt introduced
    "protected": [],      # extra globs (relative to the project root) an agent may not write
    "briefs": "briefs",   # one YAML per brief (design 8.2); tool-managed
    "claims_dir": "claims",   # claim sidecars (design 6.3); tool-managed
    "reviews": "reviews",     # imported reviewer comments and responses (design 8.5); tool-managed
    "proposals": "proposals", # facts proposed by an agent, accepted only by the author
    "outline": "outline.yaml",# thesis, sections, claims and the units that support them (design 8.4)
    "plans": "plans",         # outline proposals; author approves with `ah plan approve`
    "claims_policy": {"require_binding": False},
    "lexicons": {},       # {name: regex} extra or replacement style lexicons for must_not / hedging
    "style": {},          # {lints: [names]|[], level: info|minor, format: {cite, percent, spelling, heading_case, eg_comma, sentence_max_words, ...}}; empty = all code lints at info
    "criteria": {"files": ["rubric/*.yaml"], "off": [], "workers": 4, "min_words": 12},  # frozen rubric (tier TR): extra criteria files, ids to switch off
    "done": {"require": [], "lookups_max_age_days": 30},   # the single done/fail/incomplete answer: components that must have been checked, and how old the registry snapshot may be
    "external": {"required": []},  # tools whose results (.ah/external/<tool>.json) must exist: numbers_audit, figure_audit, citation
    "data_policy": "open",  # open | restricted | local (design 13.3)
    "data_policy_allow": [],  # named providers permitted when restricted
    "profile_params": {}, # overrides for the profile's parameters (word limits, venue switches)
    "profile_rules": [],  # extra declarative rules for this project (same shape as a profile's rules)
}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


class Project:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        cfg_path = self.root / "ah.yaml"
        if not cfg_path.exists():
            raise FileNotFoundError(f"no ah.yaml in {self.root}")
        raw = yaml.safe_load(cfg_path.read_text()) or {}
        self.profile = profiles.load(raw.get("profile"))
        base = _merge(DEFAULTS, self.profile.defaults) if self.profile else DEFAULTS
        self.cfg = _merge(base, raw)
        self.state_dir = self.root / ".ah"

    # ---- paths ----
    @property
    def tex_root(self) -> Path:
        return (self.root / self.cfg["tex"]["root"]).resolve()

    def path(self, key: str) -> Path:
        return self.root / self.cfg[key]

    def rel(self, p: Path) -> str:
        """Path relative to the TeX root, with forward slashes (used in units and findings)."""
        try:
            return p.resolve().relative_to(self.tex_root).as_posix()
        except ValueError:
            return p.resolve().relative_to(self.root).as_posix()

    def _ignored(self, rel: str) -> bool:
        pats = self.cfg["tex"]["ignore"]
        return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(rel, p.rstrip("/*") + "/*") for p in pats)

    def all_tex_files(self) -> list[Path]:
        return sorted(p for p in self.tex_root.rglob("*.tex") if not self._ignored(self.rel(p)))

    def view_files(self) -> list[Path]:
        return [self.tex_root / v for v in self.cfg["tex"]["views"] if (self.tex_root / v).exists()]

    def macros_file(self) -> Path:
        return self.tex_root / self.cfg["facts_macros"]

    def prose_files(self) -> list[Path]:
        views = {p.resolve() for p in self.view_files()}
        macros = self.macros_file().resolve()
        out: dict[Path, None] = {}
        for pat in self.cfg["tex"]["prose"]:
            for p in sorted(self.tex_root.glob(pat)):
                rp = p.resolve()
                if p.is_file() and rp not in views and rp != macros and not self._ignored(self.rel(p)):
                    out[p] = None
        return list(out)

    def bib_files(self) -> list[Path]:
        return [self.tex_root / b for b in self.cfg["tex"]["bib"] if (self.tex_root / b).exists()]

    def protected_globs(self) -> list[str]:
        """Paths an agent must not write (design 10.4): evidence, state, definitions of facts and rules."""
        out = ["sources/**", "archive/**", ".ah/**", "ah.yaml", self.cfg["facts"], self.cfg["bindings"], self.cfg["glossary"], self.cfg["sources"]]
        try:
            out.append(self.macros_file().resolve().relative_to(self.root).as_posix())
        except ValueError:
            pass
        out += [f"{self.cfg['briefs']}/**", f"{self.cfg['claims_dir']}/**", f"{self.cfg['reviews']}/**",
                f"{self.cfg.get('plans', 'plans')}/**", self.cfg["outline"]]
        out += ["rules/**"]       # promoted rules: the author accepted each one, an agent must not add or loosen one
        out += ["rubric/**"]      # criteria, hand labels and admissions are the author's: an agent must not admit its own check
        out += list(self.cfg.get("protected") or [])
        out += profiles.protected_files(self)
        return list(dict.fromkeys(out))

    # ---- snapshot (5.2) ----
    def snapshot(self) -> dict[str, str]:
        """Hashes of every input that can change a verdict."""
        def h(paths):
            return sha1(canonical_json(sorted((self.rel(p), sha256_file(p)) for p in paths if p.exists())))
        snap = {
            "tex": h(self.all_tex_files()),
            "bib": h(self.bib_files()),
            "rubric": str(self.cfg["rubric"]),
            "config": sha1(canonical_json(self.cfg)),
        }
        for key in ("facts", "sources", "glossary", "bindings"):
            p = self.path(key)
            snap[key] = sha256_file(p)[:16] if p.exists() else "-"
        from .rubric import criteria_digest
        digest = criteria_digest(self)
        if digest:                      # only when a rubric exists, so projects without one keep their old snapshot
            snap["criteria"] = digest
        from .promote import rules_digest
        rd = rules_digest(self)
        if rd:
            snap["rules"] = rd
        return snap
