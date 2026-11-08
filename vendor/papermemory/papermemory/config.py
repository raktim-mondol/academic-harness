from __future__ import annotations

import os
from pathlib import Path

from papermemory import __version__

APP_NAME = "papermemory"
VERSION = __version__


def data_dir() -> Path:
    override = os.environ.get("PAPERMEMORY_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg).expanduser().resolve() / APP_NAME
    return Path.home() / ".local" / "share" / APP_NAME


def db_path() -> Path:
    override = os.environ.get("PAPERMEMORY_DB")
    if override:
        return Path(override).expanduser().resolve()
    return data_dir() / "papermemory.db"


def ensure_dirs() -> Path:
    path = data_dir()
    path.mkdir(parents=True, exist_ok=True)
    return path
