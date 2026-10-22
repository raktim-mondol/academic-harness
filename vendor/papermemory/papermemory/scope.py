from __future__ import annotations

from pathlib import Path

from papermemory.util import slugify


class ScopeError(Exception):
    code = "project-unresolved"


def _ah_root(start: Path, depth: int = 6) -> Path | None:
    current = start
    for _ in range(depth):
        if (current / "ah.yaml").exists():
            return current
        if current.parent == current:
            break
        current = current.parent
    return None


def canonical_project_slug(
    cwd_or_root: Path | str,
    *,
    project: str | None = None,
    store=None,
) -> str:
    if project:
        return slugify(project)
    root = Path(cwd_or_root).expanduser().resolve()
    ah_root = _ah_root(root) if root.exists() else None
    if ah_root is not None:
        return slugify(ah_root.name)
    if store is not None:
        row = store.conn.execute(
            "SELECT slug FROM manuscripts WHERE root_path=? ORDER BY updated_at DESC LIMIT 1",
            (str(root),),
        ).fetchone()
        if row:
            return row["slug"]
    return "unassigned"
