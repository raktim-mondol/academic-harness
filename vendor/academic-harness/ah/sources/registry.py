"""Source registry and ingestion (design 7.1, 7.2).

A source is anything with a stable locator and a quotable passage. The registry records metadata,
status and a content hash; the converted text is stored read-only and line-numbered so a locator
(`file:start-end`) stays valid. A source with no text is `metadata-only`: claims about it can be
reported as unverifiable but never as supported.
"""
from __future__ import annotations

import csv
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import yaml

from ..project import Project
from ..util import sha256_file


@dataclass
class Source:
    id: str
    file: Path | None          # converted text, absolute
    meta: dict


def load_registry(project: Project) -> dict[str, dict]:
    p = project.path("sources")
    if not p.exists():
        return {}
    return {s["id"]: s for s in (yaml.safe_load(p.read_text()) or {}).get("sources", []) or []}


def save_registry(project: Project, reg: dict[str, dict]) -> None:
    p = project.path("sources")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(yaml.safe_dump({"sources": list(reg.values())}, sort_keys=False, allow_unicode=True))


def to_text(src: Path) -> str:
    """Plain text from a .md/.txt/.tex file or a PDF (via pdftotext). Raises if it cannot."""
    if src.suffix.lower() == ".pdf":
        if shutil.which("pdftotext") is None:
            raise RuntimeError("pdftotext is not installed; convert the PDF to text first")
        out = subprocess.run(["pdftotext", "-layout", str(src), "-"], capture_output=True, text=True)
        if out.returncode != 0 or len(out.stdout.strip()) < 200:
            raise RuntimeError("PDF has no extractable text (scanned?); OCR it first")
        return out.stdout
    return src.read_text(errors="replace")


def add_source(project: Project, path: Path, sid: str, *, keys=None, **meta) -> dict:
    """Register a source: copy its text into sources/files/<id>.txt (read-only) and record its hash.

    Markdown/text sources are byte-copied so the stored verbatim layer and its sha256
    stay identical to the sender's raw document (no newline re-encoding)."""
    src = Path(path)
    dest = project.root / "sources" / "files" / f"{sid}.txt"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.chmod(0o644)
    if src.suffix.lower() in {".md", ".txt"}:
        dest.write_bytes(src.read_bytes())
    else:
        dest.write_text(to_text(src))
    dest.chmod(0o444)
    reg = load_registry(project)
    entry = {"id": sid, **{k: v for k, v in meta.items() if v is not None}, "file": str(dest.relative_to(project.root)),
             "sha256": sha256_file(dest), "status": meta.get("status") or "ok"}
    if keys:
        entry["keys"] = list(keys)
    reg[sid] = {**reg.get(sid, {}), **entry}
    save_registry(project, reg)
    return reg[sid]


def source_map(project: Project) -> dict[str, str]:
    """Optional table mapping citation key -> text file, for corpora that already exist on disk."""
    cfg = project.cfg.get("source_map")
    if not cfg:
        return {}
    out: dict[str, str] = {}
    for spec in cfg if isinstance(cfg, list) else [cfg]:
        p = project.root / spec["file"]
        if not p.exists():
            continue
        with p.open(newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh, delimiter="\t"):
                k, v = (r.get(spec["key"]) or "").strip(), (r.get(spec["path"]) or "").strip()
                if k and v:
                    out[k] = v
    return out


DOI_RX = re.compile(r"10\.\d{4,9}/[^\s)\]>\"'<,;]+")


def _norm_doi(d: str) -> str:
    return d.lower().rstrip(".,;:)")


def doi_index(project: Project) -> dict[str, list[Path]]:
    """DOI -> every text file whose first 4000 characters carry that DOI (the same paper is often stored
    in several conversions that differ in what they kept). Cached by file size and mtime."""
    import json
    import fnmatch
    cache_p = project.state_dir / "doi_index.json"
    cache = json.loads(cache_p.read_text()) if cache_p.exists() else {}
    files: list[Path] = []
    for g in project.cfg.get("source_globs", []) or []:
        files += sorted(project.root.glob(g))
    for d in project.cfg.get("source_dirs", []) or []:
        files += sorted((project.root / d).glob("*.md")) + sorted((project.root / d).glob("*.txt"))
    files += [project.root / v for v in source_map(project).values()]
    files += [project.root / s["file"] for s in load_registry(project).values() if s.get("file")]
    out: dict[str, list[Path]] = {}
    changed = False
    for f in dict.fromkeys(files):
        if not f.is_file():
            continue
        st = f.stat()
        sig = [st.st_size, int(st.st_mtime)]
        ent = cache.get(str(f))
        if not ent or ent[0] != sig:
            with f.open(errors="replace") as fh:
                m = DOI_RX.search(fh.read(4000))
            ent = [sig, _norm_doi(m.group(0)) if m else ""]
            cache[str(f)] = ent
            changed = True
        if ent[1]:
            out.setdefault(ent[1], []).append(f)
    if changed:
        project.state_dir.mkdir(parents=True, exist_ok=True)
        cache_p.write_text(json.dumps(cache))
    return out


def entry_for(reg: dict[str, dict], key: str) -> dict | None:
    """Registry entry by citation key: the id itself or any alias registered with --keys."""
    if key in reg:
        return reg[key]
    for entry in reg.values():
        if key in (entry.get("keys") or []):
            return entry
    return None


def resolve_all(project: Project, key: str, reg=None, smap=None, bib: dict | None = None, dois: dict | None = None) -> list[Path]:
    """Primary file for the key plus every other conversion of the same paper (same DOI). The DOI comes from the
    registry, the bibliography, or the primary file itself, so papers the key map does not list can still be found."""
    reg = load_registry(project) if reg is None else reg
    primary = resolve(project, key, reg, smap)
    dois = doi_index(project) if dois is None else dois
    entry = entry_for(reg, key) or {}
    doi = (entry.get("doi") or (bib.get(key).fields.get("doi") if bib and bib.get(key) else "") or "")
    doi = _norm_doi(str(doi)) if doi else ""
    if not doi and primary is not None:
        for d, fl in dois.items():
            if primary in fl:
                doi = d
                break
    files = list(dois.get(doi, [])) if doi else []
    if primary is not None and primary not in files:
        files.insert(0, primary)
    elif primary is not None:
        files.remove(primary)
        files.insert(0, primary)
    return files


def resolve(project: Project, key: str, reg: dict[str, dict] | None = None, smap: dict[str, str] | None = None) -> Path | None:
    """Text file for a citation key: registry `file`, then source_map, then `<dir>/<key>.md` conventions."""
    reg = load_registry(project) if reg is None else reg
    smap = source_map(project) if smap is None else smap
    cands: list[str] = []
    entry = entry_for(reg, key)
    if entry and entry.get("file"):
        cands.append(entry["file"])
    if key in smap:
        cands.append(smap[key])
    for d in project.cfg.get("source_dirs", []) or []:
        for ext in (".md", ".txt"):
            cands.append(f"{d}/{key}{ext}")
    for c in cands:
        p = project.root / c
        if p.is_file():
            return p
    return None
