"""Paths for the Claude Code host test. Nothing here is specific to one machine.

AH_HOST_TEST_DIR   where scratch projects, runs and the `ah` shim live (default ~/.cache/ah-claude-host; keep it off tmpfs)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ENGINE = REPO / "vendor" / "academic-harness"
HOST = Path(os.environ.get("AH_HOST_TEST_DIR") or Path.home() / ".cache" / "ah-claude-host")
HOME = Path.home()
HERE = Path(__file__).resolve().parent
SHIM = HOST / "bin" / "ah"
PRISTINE = HOST / "proj-pristine"


def install_shim() -> Path:
    """`ah` that runs the engine from THIS checkout (not an installed copy), so a hook under test is the code under test."""
    SHIM.parent.mkdir(parents=True, exist_ok=True)
    SHIM.write_text(f"#!/bin/sh\nexport PYTHONPATH={ENGINE}\nexec {sys.executable} -m ah \"$@\"\n")
    SHIM.chmod(0o755)
    return SHIM
