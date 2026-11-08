"""Stability report: run the checks N times on an unchanged snapshot and measure how much the findings move.

A check that gives different findings on the same text cannot drive a fix loop: the agent would chase
noise. DET-01 (`audit.det_check`) compares two runs by hash; this report runs N times and says, per tier,
which fingerprints came and went, so an unstable check can be named and fixed or demoted.

Nothing here writes the ledger. The snapshot is read before and after; if the files changed during the
runs the report says so instead of blaming the checks.
"""
from __future__ import annotations

from collections import defaultdict

from .audit import report_hash, run_checks
from .checks.base import DEFAULT_TIERS, Finding
from .context import build_context
from .project import Project


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def stability(project: Project, tiers: tuple[str, ...] = DEFAULT_TIERS, runs: int = 5, backend=None, **t3kw) -> dict:
    runs = max(2, int(runs))
    snap_before = project.snapshot()
    hashes: list[str] = []
    per_run: list[dict[str, Finding]] = []
    for _ in range(runs):
        found = run_checks(build_context(project), tiers, backend=backend, **t3kw)
        per_run.append({f.fingerprint(): f for f in found})
        hashes.append(report_hash(found))
    snap_after = project.snapshot()
    units = build_context(project).units
    unanchored = sum(1 for u in units if not u.uid)

    by_tier: dict[str, list[set[str]]] = defaultdict(lambda: [set() for _ in range(runs)])
    for i, fs in enumerate(per_run):
        for fp, f in fs.items():
            by_tier[f.tier or "?"][i].add(fp)

    tier_report = {}
    for tier in sorted(set(tiers) | set(by_tier)):
        sets = by_tier[tier] if tier in by_tier else [set() for _ in range(runs)]
        base = sets[0]
        tier_report[tier] = {
            "findings": [len(s) for s in sets],
            "jaccard_min": round(min(_jaccard(base, s) for s in sets[1:]), 4),
        }

    always = set.intersection(*(set(fs) for fs in per_run))
    ever: dict[str, Finding] = {}
    for fs in per_run:
        ever.update(fs)
    unstable = []
    for fp in sorted(set(ever) - always):
        f = ever[fp]
        unstable.append({"fingerprint": fp, "check": f.check, "tier": f.tier, "unit": f.ref, "file": f.file,
                         "seen_in_runs": sum(1 for fs in per_run if fp in fs), "message": f.message})

    changed = snap_before != snap_after
    warnings = []
    if unanchored:
        warnings.append(f"{unanchored}/{len(units)} unit(s) have no %% @unit anchor: their findings are keyed by text hash, "
                        "so any edit to the paragraph re-keys them (reported as fixed + new). Run `ah units sync`.")
    return {
        "runs": runs,
        "tiers": list(tiers),
        "identical": len(set(hashes)) == 1,
        "distinct_report_hashes": sorted(set(hashes)),
        "per_tier": tier_report,
        "unstable": unstable,
        "input_changed_during_runs": changed,
        "unanchored_units": unanchored,
        "warnings": warnings,
        "verdict": ("input-changed" if changed else "stable" if len(set(hashes)) == 1 else "unstable"),
    }


def ledger_unexplained(project: Project) -> list[dict]:
    """Open ledger findings whose cause the reconcile step could not name (no text, evidence or rubric change)."""
    if not (project.state_dir / "ledger.sqlite").exists():
        return []
    from .ledger.db import Ledger
    led = Ledger(project)
    try:
        return [{"fingerprint": r["fp"], "check": r["check_id"], "unit": r["ref"], "file": r["file"], "message": r["message"]}
                for r in led.list(("open", "decision-needed")) if r["cause"] == "UNEXPLAINED"]
    finally:
        led.close()
