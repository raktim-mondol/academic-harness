"""The argument list `ah_author action=waive` builds (academic-harness.js) must be one the engine accepts.

Found live: the tool sent `finding waive <id> --reason ... --yes` with no `--by`, the engine refuses that, so no waiver made through
the host could ever succeed (and the agent went looking for a name to supply, and picked one from the git config)."""
from __future__ import annotations

from ah.audit import audit
from ah.cli import main
from ah.ledger.db import Ledger
from ah.project import Project


def test_the_tool_argv_waives_a_finding(project_dir):
    p = Project(str(project_dir))
    fp = next(f["fingerprint"] for f in audit(p, use_ledger=True)["findings"] if f["check"] == "TEX-02")
    argv = ["finding", "waive", fp[:8], "--by", "author", "--reason", "known: figure to be supplied", "--yes", "--project", str(project_dir)]
    assert main(argv) == 0
    led = Ledger(p)
    try:
        assert led.get(fp[:8])[0]["state"] == "waived"
    finally:
        led.close()


def test_without_by_the_engine_refuses(project_dir):
    p = Project(str(project_dir))
    fp = next(f["fingerprint"] for f in audit(p, use_ledger=True)["findings"] if f["check"] == "TEX-02")
    assert main(["finding", "waive", fp[:8], "--reason", "x", "--yes", "--project", str(project_dir)]) != 0
