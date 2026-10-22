from __future__ import annotations

import os
import re
from pathlib import Path


class SandboxError(Exception):
    code = "path-escape"


FIGURE_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)")


def resolve_in_root(raw: str, roots: list[Path]) -> str:
    target = os.path.realpath(os.path.expanduser(str(raw)))
    for root in roots:
        root_real = os.path.realpath(os.path.expanduser(str(root)))
        if target == root_real or target.startswith(root_real + os.sep):
            return target
    raise SandboxError(f"path outside allowed roots: {raw}")


def figure_refs(text: str) -> list[str]:
    return FIGURE_RE.findall(text or "")


def unresolved_figures(text: str, root: Path) -> list[str]:
    missing: list[str] = []
    for ref in figure_refs(text):
        if ref.startswith(("http://", "https://", "data:")):
            continue
        try:
            resolved = Path(resolve_in_root(str(Path(root) / ref), [root]))
        except SandboxError:
            missing.append(ref)
            continue
        if not resolved.exists():
            missing.append(ref)
    return missing
