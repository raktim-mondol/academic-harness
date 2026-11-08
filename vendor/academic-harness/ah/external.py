"""Tier TX: results of tools that cannot run inside the engine, read as findings.

numbers_audit and figure_audit need SciPy and Pillow, the citation audit needs the network, and all three
live in the plugin's JavaScript. Left outside the engine their results have no check IDs, no fingerprints
and no baseline, so nothing can say whether a re-run found the same thing. This module is the contract that
brings them in:

    .ah/external/<tool>.json
      {"schema": 1, "tool": "numbers_audit", "generated_at": "...",
       "inputs":   {"<path relative to the project root>": "<sha256 of that file>", ...},
       "findings": [{"check": "STAT-01", "file": "sections/a.tex", "line": 12, "key": "...", "message": "..."}]}

A result is trusted only while every file it was computed from still has the recorded hash and the set of
files is still the set the project would audit. Otherwise the tool's own findings are *carried* from the
ledger (not marked fixed by their absence) and a single EXT-00 says the result must be refreshed. A
required tool that was never run says the same. `key` must not contain a line number: it is what keeps a
finding the same finding when the text above it moves.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .checks.base import CATALOGUE, Finding, make
from .context import Context, unit_ref
from .project import Project
from .tex.text import strip_comments
from .util import canonical_json, sha1, sha256_file

SCHEMA = 1
DIRNAME = "external"

# tool -> the checks it may report. The JavaScript bridge (external-bridge.js) writes exactly these.
TOOL_CHECKS: dict[str, tuple[str, ...]] = {
    "numbers_audit": ("STAT-01", "STAT-02", "STAT-03", "STAT-04", "STAT-05"),
    "figure_audit": ("FIG-01", "FIG-02", "FIG-03", "FIG-04"),
    "citation": ("CIT-01", "CIT-02", "CIT-03", "CIT-04", "CIT-05", "CIT-06"),
    "reporting_check": ("RPT-01", "RPT-02", "RPT-03"),
}

IMAGE_EXT = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp")
RE_GRAPHICS = re.compile(r"\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")
RE_GRAPHICSPATH = re.compile(r"\\graphicspath\s*\{((?:\{[^}]*\})+)\}")


def external_dir(project: Project, directory: str | Path | None = None) -> Path:
    d = Path(directory) if directory else project.state_dir / DIRNAME
    return d if d.is_absolute() else project.root / d


def _root_rel(project: Project, p: Path) -> str | None:
    try:
        return p.resolve().relative_to(project.root).as_posix()
    except ValueError:
        return None


def referenced_figures(project: Project) -> list[Path]:
    """Raster images the document includes. Vector files have no DPI and are not the figure audit's business."""
    names: list[str] = []
    dirs = [""]
    for p in project.all_tex_files():
        text = strip_comments(p.read_text(errors="replace"))
        for m in RE_GRAPHICSPATH.finditer(text):
            dirs += re.findall(r"\{([^}]*)\}", m.group(1))
        names += [m.group(1).strip() for m in RE_GRAPHICS.finditer(text)]
    found: dict[Path, None] = {}
    for name in sorted(set(names)):
        for d in dict.fromkeys(dirs):
            base = project.tex_root / d / name
            candidates = [base] if base.suffix.lower() in IMAGE_EXT else [Path(f"{base}{ext}") for ext in IMAGE_EXT]
            hit = next((c for c in candidates if c.is_file()), None)
            if hit is not None:
                found[hit.resolve()] = None
                break
    return sorted(found)


def reporting_checks(project: Project) -> list[dict]:
    """Reporting-guideline checks (reporting_check tool) kept under <project root>/.dsh/reporting/<slug>/ whose
    manuscript is a file inside the project. Their verdicts are recorded judgments, read here, never re-judged."""
    base = project.root / ".dsh" / "reporting"
    out: list[dict] = []
    if not base.is_dir():
        return out
    for d in sorted(p for p in base.iterdir() if p.is_dir() and (p / "check.json").is_file()):
        try:
            manuscript = (json.loads((d / "check.json").read_text()).get("manuscript") or {})
        except (OSError, ValueError):
            continue
        rel_path = manuscript.get("path")
        if manuscript.get("kind") != "file" or not rel_path:
            continue
        target = (project.root / rel_path).resolve()
        rel = _root_rel(project, target)
        if rel is None:
            continue
        out.append({"slug": d.name, "manuscript": rel, "file": project.rel(target), "dir": _root_rel(project, d)})
    return out


def plan(project: Project) -> dict[str, dict]:
    """What each tool must be run on. `path` is relative to the project root (I/O and hashing); `file` is the
    name findings use (relative to the TeX root, as units are)."""
    def entry(p: Path) -> dict | None:
        rel = _root_rel(project, p)
        return {"path": rel, "file": project.rel(p)} if rel else None

    def entries(paths) -> list[dict]:
        return [e for e in (entry(p) for p in paths) if e]

    checks = reporting_checks(project)
    report_inputs: list[Path] = []
    for c in checks:
        d = project.root / c["dir"]
        report_inputs += [p for p in (d / "check.json", d / "verdicts.jsonl", project.root / c["manuscript"]) if p.is_file()]
    return {
        "numbers_audit": {"files": entries(p for p in project.prose_files() if p.suffix == ".tex")},
        "figure_audit": {"files": entries(referenced_figures(project))},
        "citation": {"files": entries(project.bib_files())},
        "reporting_check": {"files": entries(report_inputs), "checks": [{"slug": c["slug"], "file": c["file"]} for c in checks]},
    }


@dataclass
class ExternalResult:
    findings: list[Finding] = field(default_factory=list)
    tools: dict[str, dict] = field(default_factory=dict)
    carry_tools: set[str] = field(default_factory=set)   # old findings stay open: the result cannot be trusted now
    digest: str = ""
    directory: str = ""

    def report(self) -> dict:
        return {"directory": self.directory, "tools": self.tools, "digest": self.digest}


def _parse(tool: str, path: Path) -> tuple[dict | None, str | None]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        return None, f"unreadable ({e})"
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        return None, f"schema is not {SCHEMA}"
    if data.get("tool") != tool:
        return None, f"file says tool {data.get('tool')!r}"
    inputs = data.get("inputs")
    if not isinstance(inputs, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in inputs.items()):
        return None, "inputs must map paths to sha256 hashes"
    items = data.get("findings")
    if not isinstance(items, list):
        return None, "findings must be a list"
    allowed = TOOL_CHECKS[tool]
    for i, it in enumerate(items):
        if not isinstance(it, dict) or not all(isinstance(it.get(k), str) and it.get(k) for k in ("check", "key", "message")):
            return None, f"finding {i} needs check, key and message"
        if it["check"] not in allowed or it["check"] not in CATALOGUE:
            return None, f"finding {i}: {it['check']} is not a check of {tool}"
        if it.get("line") is not None and not isinstance(it["line"], int):
            return None, f"finding {i}: line must be an integer"
        if it.get("file") is not None and not isinstance(it["file"], str):
            return None, f"finding {i}: file must be a string"
    return data, None


def _stale_reasons(project: Project, recorded: dict[str, str], expected: set[str]) -> list[str]:
    out = []
    for rel in sorted(set(recorded) | expected):
        if rel not in recorded:
            out.append(f"{rel} is new")
        elif rel not in expected:
            out.append(f"{rel} is no longer part of the project")
        else:
            p = project.root / rel
            if not p.is_file() or sha256_file(p) != recorded[rel]:
                out.append(f"{rel} changed")
    return out


def load_external(project: Project, ctx: Context, directory: str | Path | None = None) -> ExternalResult:
    """Findings from fresh results; EXT-00 for stale, invalid or missing required ones."""
    d = external_dir(project, directory)
    wanted = plan(project)
    required = set((project.cfg.get("external") or {}).get("required") or [])
    present = {p.stem: p for p in sorted(d.glob("*.json"))} if d.is_dir() else {}
    res = ExternalResult(directory=_root_rel(project, d) or d.as_posix())
    signature = []

    def ext00(kind: str, tool: str, message: str):
        f = make(project.cfg, "EXT-00", None, None, None, f"{kind}:{tool}", message)
        if f:
            res.findings.append(f)

    for tool in TOOL_CHECKS:
        expected = {e["path"] for e in wanted[tool]["files"]}
        info: dict = {"status": "", "findings": 0}
        res.tools[tool] = info
        path = present.get(tool)
        if path is None:
            if not expected:
                info["status"] = "not-applicable"
            else:
                info["status"] = "missing"
                if tool in required:
                    res.carry_tools.add(tool)
                    ext00("missing", tool, f"required external check {tool} has not been run; run ah_external")
            signature.append((tool, info["status"], []))
            continue
        data, bad = _parse(tool, path)
        if data is None:
            info.update(status="invalid", detail=bad)
            res.carry_tools.add(tool)
            ext00("invalid", tool, f"{tool} result is not usable: {bad}; run ah_external to rewrite it")
            signature.append((tool, "invalid", []))
            continue
        info["generated_at"] = data.get("generated_at")
        problems = _stale_reasons(project, data["inputs"], expected)
        if problems:
            more = f" and {len(problems) - 3} more" if len(problems) > 3 else ""
            info.update(status="stale", detail="; ".join(problems[:3]) + more)
            res.carry_tools.add(tool)
            ext00("stale", tool, f"{tool} result is out of date ({info['detail']}); run ah_external to refresh it")
            signature.append((tool, "stale", []))
            continue
        fresh: list[Finding] = []
        for it in data["findings"]:
            line = it.get("line")
            file = it.get("file")
            ref = next((unit_ref(u) for u in ctx.units if file and line and u.file == file and u.start <= line <= u.end), None)
            f = make(project.cfg, it["check"], ref, file, line, it["key"], it["message"])
            if f:
                fresh.append(f)
        res.findings += fresh
        info.update(status="fresh", findings=len(fresh))
        signature.append((tool, "fresh", sorted(f.fingerprint() for f in fresh)))
    res.digest = sha1(canonical_json(signature), 16)
    return res


def tools_of(checks: set[str] | list[str]) -> set[str]:
    """Which tools own these check IDs (EXT-00 belongs to none: it is regenerated every run)."""
    return {t for t, cs in TOOL_CHECKS.items() if any(c in cs for c in checks)}
