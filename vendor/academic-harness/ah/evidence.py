"""Evidence ledger exchange with PaperMemory (design 8.1/8.4).

AH stores bindings in claim sidecars. When a binding was made from a memory
row it carries memory_claim_id, the full source sha256 and the quote sha256.
export_ledger emits those bindings; import_memory_ledger reads pm-evidence-1
rows, matches sidecar claims by clause_hash, and binds the exact char span.
"""
from __future__ import annotations

import json
from pathlib import Path

from .claim_sidecar import bind_passage, clause_hash, load_all
from .context import Context, build_context
from .project import Project


def export_ledger(p: Project) -> list[dict]:
    rows = []
    for unit, sidecar in load_all(p).items():
        for claim in sidecar.get("claims", []):
            for binding in claim.get("bindings", []):
                if binding.get("type") != "passage" or not binding.get("memory_claim_id"):
                    continue
                rows.append(
                    {
                        "schema": "ah-evidence-1",
                        "claim_id": binding["memory_claim_id"],
                        "unit": unit,
                        "ah_claim": claim.get("id"),
                        "source": binding.get("source"),
                        "file": binding.get("file"),
                        "start": binding.get("start"),
                        "end": binding.get("end"),
                        "char_start": binding.get("char_start"),
                        "char_end": binding.get("char_end"),
                        "raw_sha256": binding.get("raw_sha256"),
                        "quote_sha256": binding.get("quote_sha256"),
                        "quote_hash": binding.get("quote_hash"),
                        "status": claim.get("status"),
                    }
                )
    return rows


def import_memory_ledger(p: Project, path: Path) -> dict:
    ctx = build_context(p)
    index: dict[str, list[tuple[str, dict]]] = {}
    for unit, sidecar in load_all(p).items():
        for claim in sidecar.get("claims", []):
            index.setdefault(clause_hash(claim.get("clause") or claim.get("text") or ""), []).append((unit, claim))
    imported = unmatched = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("schema") not in (None, "pm-evidence-1"):
            continue
        candidates = index.get(row.get("clause_hash") or "")
        if not candidates:
            unmatched += 1
            continue
        unit, claim = candidates[0]
        try:
            bind_passage(
                ctx, claim["id"], row.get("paper_id") or row.get("source") or "", 0, 0, 0,
                char_start=int(row.get("char_start") or 0),
                char_end=int(row.get("char_end") or 0),
                quote_sha256=row.get("quote_sha256"),
                raw_sha256=row.get("raw_sha256"),
                memory_claim_id=row.get("claim_id"),
            )
            imported += 1
        except ValueError:
            unmatched += 1
    return {"imported": imported, "unmatched": unmatched}
