from __future__ import annotations

from pathlib import Path
from typing import Any


def extract_pdf(path: Path) -> dict[str, Any]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError("pypdf is required for PDF ingest. pip install pypdf") from exc

    header = path.read_bytes()[:8]
    if not header.startswith(b"%PDF"):
        raise ValueError(f"{path} is not a PDF (header={header!r}). Often a failed download/HTML page.")

    reader = PdfReader(str(path))
    meta = reader.metadata or {}
    pages: list[dict[str, Any]] = []
    texts: list[str] = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        text = text.replace("\x00", " ")
        pages.append({"page": i, "text": text})
        texts.append(text)
    full = "\n\n".join(texts)
    title = None
    for key in ("title", "/Title"):
        value = getattr(meta, "title", None) if key == "title" else meta.get(key) if hasattr(meta, "get") else None
        if value:
            title = str(value).strip()
            break
    if not title:
        title = _guess_title(full) or path.stem
    authors = []
    creator = getattr(meta, "author", None)
    if creator:
        authors = [part.strip() for part in str(creator).replace(";", ",").split(",") if part.strip()]
    return {
        "title": title,
        "authors": authors,
        "pages": pages,
        "text": full,
        "page_count": len(pages),
        "pdf_path": str(path.resolve()),
        "source_type": "pdf",
    }


def _guess_title(text: str) -> str | None:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for line in lines[:12]:
        if 8 <= len(line) <= 220 and not line.lower().startswith("arxiv"):
            return line
    return lines[0] if lines else None
