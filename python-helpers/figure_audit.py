#!/usr/bin/env python3
"""Figure quality/duplication audit (advisory, local, no network).

Reads {"paths": [...], "dir": "...", "min_dpi": 300, "similarity_threshold": 0.92}
on stdin and reports dimensions, DPI, mode, format, low-resolution candidates,
and pairwise perceptual-hash similarity. Duplicate panels are candidates for
human review, not manipulation claims.
"""
import json
import os
import sys
from pathlib import Path

try:
    from PIL import Image
except Exception as error:  # pragma: no cover - surfaced to the caller
    print(json.dumps({"error": f"Pillow is required for figure_audit: {error}"}))
    sys.exit(0)

EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp", ".gif"}
MAX_FILES = 500
MAX_BYTES = 200 * 1024 * 1024


def collect(request):
    files = []
    for value in request.get("paths") or []:
        files.append(Path(value))
    directory = request.get("dir")
    if directory:
        root = Path(directory)
        if not root.is_dir():
            raise ValueError(f"not a directory: {directory}")
        found = sorted(
            path for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in EXTENSIONS
        )
        files.extend(found[: MAX_FILES - len(files)])
    seen = set()
    unique = []
    for path in files:
        key = str(path.resolve())
        if key in seen:
            continue
        seen.add(key)
        unique.append(path)
    if not unique:
        raise ValueError("give paths or a dir containing images")
    return unique[:MAX_FILES]


def image_dpi(image):
    dpi = image.info.get("dpi")
    if isinstance(dpi, (tuple, list)) and dpi:
        values = [float(value) for value in dpi if value]
        if values:
            return [round(value, 1) for value in values[:2]]
    tags = getattr(image, "tag_v2", None)
    if tags is not None:
        x = tags.get(282)
        y = tags.get(283)
        if x and y:
            try:
                return [round(float(x), 1), round(float(y), 1)]
            except (TypeError, ValueError):
                pass
    return None


def dhash(image):
    small = image.convert("L").resize((9, 8), Image.LANCZOS)
    pixels = list(small.getdata())
    bits = 0
    for row in range(8):
        for col in range(8):
            left = pixels[row * 9 + col]
            right = pixels[row * 9 + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def similarity(first, second):
    return 1.0 - bin(first ^ second).count("1") / 64.0


def audit(request):
    min_dpi = float(request.get("min_dpi") or 300)
    threshold = float(request.get("similarity_threshold") or 0.92)
    paths = collect(request)
    entries = []
    hashes = {}
    for path in paths:
        entry = {"path": str(path), "flags": []}
        try:
            if not path.is_file():
                raise FileNotFoundError("file not found")
            size = path.stat().st_size
            if size > MAX_BYTES:
                entry["flags"].append("too_large")
                entry["bytes"] = size
                entries.append(entry)
                continue
            with Image.open(path) as image:
                entry.update({
                    "width": image.width,
                    "height": image.height,
                    "format": image.format,
                    "mode": image.mode,
                    "bytes": size,
                    "dpi": image_dpi(image),
                })
                hashes[str(path)] = dhash(image)
            if entry["dpi"]:
                if min(entry["dpi"]) < min_dpi:
                    entry["flags"].append("low_dpi")
            else:
                entry["flags"].append("dpi_missing")
        except Exception as error:
            entry["error"] = str(error)
            entry["flags"].append("unreadable")
        entries.append(entry)

    duplicates = []
    hash_items = list(hashes.items())
    for index, (path_a, hash_a) in enumerate(hash_items):
        for path_b, hash_b in hash_items[index + 1:]:
            score = similarity(hash_a, hash_b)
            if score >= threshold:
                duplicates.append({
                    "a": path_a,
                    "b": path_b,
                    "similarity": round(score, 4),
                })
    duplicates.sort(key=lambda pair: pair["similarity"], reverse=True)

    low_dpi = [entry["path"] for entry in entries if "low_dpi" in entry["flags"]]
    unreadable = [entry["path"] for entry in entries if "unreadable" in entry["flags"]]
    review_order = [pair["a"] for pair in duplicates] + low_dpi
    seen = set()
    review_order = [path for path in review_order if not (path in seen or seen.add(path))]

    return {
        "files": entries,
        "duplicates": duplicates,
        "suggested_review_order": review_order,
        "summary": {
            "files": len(entries),
            "low_dpi": len(low_dpi),
            "dpi_missing": sum(1 for entry in entries if "dpi_missing" in entry["flags"]),
            "duplicate_pairs": len(duplicates),
            "unreadable": len(unreadable),
        },
        "min_dpi": min_dpi,
        "similarity_threshold": threshold,
        "notes": [
            "Duplicate/near-duplicate panels and low-resolution files are candidates for human review.",
            "The perceptual hash is a dHash computed locally; it does not detect manipulation.",
        ],
    }


def main():
    try:
        request = json.load(sys.stdin)
        print(json.dumps(audit(request), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(0)


if __name__ == "__main__":
    main()
