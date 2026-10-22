from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

from papermemory.util import new_id, now_iso

EVIDENCE_SCHEMA = "pm-evidence-1"


class BridgeError(Exception):
    code = "ah-bridge-error"

    def __init__(self, message: str):
        code, _, detail = message.partition(":")
        self.code = code.strip()
        self.detail = detail.strip() or None
        super().__init__(message)


def norm_text(text: str) -> str:
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    text = re.sub(r"[‐-―−]", "-", text)
    text = re.sub(r"[*_`\\]", "", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def ah_quote_hash(text: str) -> str:
    collapsed = re.sub(r"\s+", " ", text or "").strip()
    return hashlib.sha1(norm_text(collapsed[:600]).encode("utf-8")).hexdigest()[:10]


def _sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _ah_command() -> list[str]:
    override = os.environ.get("AH_CMD", "").strip()
    return shlex.split(override) if override else ["ah"]


def _registry_entries(ah_root: Path) -> dict[str, dict]:
    path = ah_root / "sources" / "registry.yaml"
    if not path.exists():
        return {}
    entries: dict[str, dict] = {}
    current: dict | None = None
    in_keys = False
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = re.match(r"\s*-?\s*id:\s*(.+)$", line)
        if match:
            sid = match.group(1).strip().strip("'\"")
            current = {"id": sid, "keys": []}
            entries[sid] = current
            in_keys = False
            continue
        if current is None:
            continue
        keys = re.match(r"\s+keys:\s*(.*)$", line)
        if keys:
            value = keys.group(1).strip()
            if value.startswith("["):
                current["keys"] = [item.strip().strip("'\"") for item in value.strip("[]").split(",") if item.strip()]
                in_keys = False
            else:
                in_keys = True
            continue
        if in_keys:
            item = re.match(r"\s*-\s*(\S+)\s*$", line)
            if item:
                current["keys"].append(item.group(1).strip("'\""))
                continue
            in_keys = False
    return entries


def _paper_keys(store, paper_id: str) -> list[str]:
    keys: list[str] = []
    row = store.conn.execute("SELECT bibtex_key FROM papers WHERE id=?", (paper_id,)).fetchone()
    if row and row["bibtex_key"]:
        keys.append(row["bibtex_key"])
    for alias in store.conn.execute(
        "SELECT value FROM paper_aliases WHERE paper_id=? AND kind='bibtex_key' ORDER BY first_seen",
        (paper_id,),
    ).fetchall():
        if alias["value"] and alias["value"] not in keys:
            keys.append(alias["value"])
    return keys


def _materialized_quote(store, claim) -> str:
    if not claim["doc_id"]:
        return ""
    doc = store.conn.execute("SELECT text FROM raw_documents WHERE id=?", (claim["doc_id"],)).fetchone()
    return doc["text"][claim["quote_char_start"]:claim["quote_char_end"]] if doc else ""


def evidence_rows(store, paper_id: str, *, ah_sha16: str | None = None) -> list[dict[str, Any]]:
    paper = store.conn.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
    if not paper:
        return []
    doc = (
        store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (paper["current_doc_id"],)).fetchone()
        if paper["current_doc_id"]
        else None
    )
    if not doc:
        return []
    claims = store.conn.execute(
        """SELECT * FROM claims WHERE paper_id=? AND is_latest=1
           AND status IN ('extracted','verified') AND doc_id=?""",
        (paper_id, doc["id"]),
    ).fetchall()
    rows = []
    corpus_root = store.path.parent
    for claim in claims:
        quote = doc["text"][claim["quote_char_start"]:claim["quote_char_end"]]
        rows.append(
            {
                "schema": EVIDENCE_SCHEMA,
                "claim_id": claim["id"],
                "doc_id": doc["id"],
                "paper_id": paper_id,
                "raw_sha256": doc["sha256"],
                "sha16": doc["sha256"][:16],
                "ah_sha16": ah_sha16,
                "file": str(Path(doc["corpus_path"]).relative_to(corpus_root)) if str(doc["corpus_path"]).startswith(str(corpus_root)) else doc["corpus_path"],
                "ah_file": f"sources/files/{paper_id}.txt",
                "char_start": claim["quote_char_start"],
                "char_end": claim["quote_char_end"],
                "line_start": claim["quote_line_start"],
                "line_end": claim["quote_line_end"],
                "quote": quote,
                "quote_sha256": claim["quote_sha256"],
                "quote_hash": ah_quote_hash(quote),
                "clause_hash": ah_quote_hash(claim["claim_text"]),
            }
        )
    return rows


def _write_evidence(store, paper_id: str, out_dir: Path, ah_sha16: str | None) -> int:
    rows = evidence_rows(store, paper_id, ah_sha16=ah_sha16)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{paper_id}.jsonl"
    with open(target, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


def _register_one(store, paper, ah_root: Path, registry: dict, *, evidence_dir: Path | None) -> dict[str, Any]:
    paper_id = paper["id"]
    doc = (
        store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (paper["current_doc_id"],)).fetchone()
        if paper["current_doc_id"]
        else None
    )
    if not doc or doc["provenance_basis"] != "verbatim":
        return {"paper_id": paper_id, "status": "refused", "reason": "no-raw-file"}
    ah_copy = ah_root / "sources" / "files" / f"{paper_id}.txt"
    if paper_id in registry and ah_copy.exists():
        ah_sha = _sha_file(ah_copy)
        state = "byte-identical" if ah_sha == doc["sha256"] else "text-equivalent" if _quotes_reslice(store, paper_id, doc, ah_copy) else "locator-drift"
        written = _write_evidence(store, paper_id, evidence_dir, ah_sha[:16]) if evidence_dir and state != "locator-drift" else 0
        return {"paper_id": paper_id, "status": "already", "handoff_state": state, "ah_sha16": ah_sha[:16], "ledger_rows_written": written}
    argv = [*_ah_command(), "source", "add", str(doc["corpus_path"]), "--id", paper_id]
    keys = _paper_keys(store, paper_id)
    if keys:
        argv += ["--keys", ",".join(keys)]
    if paper["doi"]:
        argv += ["--doi", paper["doi"]]
    if paper["title"]:
        argv += ["--title", paper["title"]]
    argv += ["--project", str(ah_root)]
    proc = subprocess.run(argv, capture_output=True, text=True)
    if proc.returncode != 0:
        return {"paper_id": paper_id, "status": "failed", "reason": "ah-source-add-failed", "detail": (proc.stderr or proc.stdout).strip()[:300]}
    registry = _registry_entries(ah_root)
    if paper_id not in registry:
        return {"paper_id": paper_id, "status": "failed", "reason": "registry-entry-missing"}
    ah_sha = _sha_file(ah_copy) if ah_copy.exists() else None
    if ah_sha is None:
        state = "locator-drift"
    elif ah_sha == doc["sha256"]:
        state = "byte-identical"
    elif _quotes_reslice(store, paper_id, doc, ah_copy):
        state = "text-equivalent"
    else:
        state = "locator-drift"
    written = _write_evidence(store, paper_id, evidence_dir, ah_sha[:16] if ah_sha else None) if evidence_dir and state != "locator-drift" else 0
    store.mut("AH_REGISTER", paper_id=paper_id, doc_id=doc["id"], status=state, detail="source-add")
    return {"paper_id": paper_id, "status": "registered", "handoff_state": state, "ah_sha16": ah_sha[:16] if ah_sha else None, "ledger_rows_written": written}


def _quotes_reslice(store, paper_id: str, doc, ah_copy: Path) -> bool:
    try:
        ah_text = ah_copy.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    claims = store.conn.execute(
        "SELECT quote_char_start, quote_char_end FROM claims WHERE paper_id=? AND is_latest=1 AND status IN ('extracted','verified')",
        (paper_id,),
    ).fetchall()
    if not claims:
        return False
    for claim in claims:
        quote = doc["text"][claim["quote_char_start"]:claim["quote_char_end"]]
        if quote and quote not in ah_text:
            return False
    return True


def register_to_ah(
    store,
    *,
    paper: str | None = None,
    project: str | None = None,
    all_citable: bool = False,
    ah_root: str | Path | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    root: Path | None = Path(ah_root).expanduser().resolve() if ah_root else None
    if root is None and project:
        row = store.conn.execute("SELECT ah_root FROM projects WHERE key=?", (project,)).fetchone()
        if row and row["ah_root"]:
            root = Path(row["ah_root"]).expanduser().resolve()
    if root is None:
        raise BridgeError("ah-root-required")
    if not (root / "ah.yaml").exists():
        raise BridgeError(f"ah-root-invalid: {root}")
    if paper:
        papers = [store.get_paper(paper)]
        if papers[0] is None:
            raise BridgeError("paper-not-found")
    elif project and all_citable:
        papers = [
            dict(row)
            for row in store.conn.execute(
                """SELECT p.* FROM papers p
                   WHERE p.cite_state IN ('citable','partial') AND p.current_doc_id IS NOT NULL
                     AND EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)
                   ORDER BY p.id""",
                (project,),
            ).fetchall()
        ]
    else:
        raise BridgeError("paper-or-project-all-citable-required")
    if dry_run:
        return {"dry_run": True, "papers": [p["id"] for p in papers], "count": len(papers)}
    registry = _registry_entries(root)
    evidence_dir = Path(os.environ["PAPERMEMORY_EVIDENCE_DIR"]).expanduser().resolve() if os.environ.get("PAPERMEMORY_EVIDENCE_DIR") else None
    results = [_register_one(store, paper_row, root, registry, evidence_dir=evidence_dir) for paper_row in papers]
    store.conn.commit()
    return {
        "registered": sum(1 for item in results if item["status"] == "registered"),
        "already_registered": sum(1 for item in results if item["status"] == "already"),
        "refused": sum(1 for item in results if item["status"] == "refused"),
        "failed": sum(1 for item in results if item["status"] == "failed"),
        "ledger_rows_written": sum(item.get("ledger_rows_written") or 0 for item in results),
        "results": results,
    }


def export_evidence(store, out_path: str | Path, *, project: str | None = None) -> dict[str, Any]:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    sql = """SELECT p.id FROM papers p WHERE p.cite_state IN ('citable','partial') AND p.current_doc_id IS NOT NULL"""
    args: list[Any] = []
    if project:
        sql += " AND EXISTS(SELECT 1 FROM paper_projects pp WHERE pp.paper_id=p.id AND pp.project_key=?)"
        args.append(project)
    rows: list[dict[str, Any]] = []
    for row in store.conn.execute(sql, args).fetchall():
        rows.extend(evidence_rows(store, row["id"]))
    with open(out, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {"path": str(out), "rows": len(rows), "papers": len({row["paper_id"] for row in rows})}


def import_verdicts(store, path: str | Path) -> dict[str, Any]:
    imported = stale = contradicted = unchanged = skipped = 0
    now = now_iso()
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("schema") not in (None, EVIDENCE_SCHEMA, "pm-verdict-1"):
                pass
            claim = store.conn.execute("SELECT * FROM claims WHERE id=?", (row.get("claim_id"),)).fetchone()
            if not claim:
                skipped += 1
                continue
            doc = (
                store.conn.execute("SELECT * FROM raw_documents WHERE id=?", (claim["doc_id"],)).fetchone()
                if claim["doc_id"]
                else None
            )
            paper = store.conn.execute("SELECT current_doc_id FROM papers WHERE id=?", (claim["paper_id"],)).fetchone()
            if (
                doc is None
                or row.get("doc_id") not in (None, claim["doc_id"])
                or row.get("raw_sha256") != doc["sha256"]
                or (paper and paper["current_doc_id"] != doc["id"])
            ):
                stale += 1
                store.mut("VERDICT_IMPORT", claim_id=claim["id"], paper_id=claim["paper_id"], status="stale", reason_code="stale-verdict-sha")
                continue
            verdict = str(row.get("verdict") or "").upper()
            store.conn.execute(
                """INSERT INTO ah_verdicts(id, claim_id, doc_id, raw_sha256, char_start, char_end,
                   verdict, quote, locator, quote_hash, mismatch_json, prompt_version, model,
                   run_id, ledger_sha256, recorded_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    new_id("ahv"), claim["id"], doc["id"], row["raw_sha256"],
                    int(row.get("char_start") or 0), int(row.get("char_end") or 0),
                    verdict, row.get("quote"), row.get("locator"), row.get("quote_hash"),
                    json.dumps(row.get("mismatch") or []), str(row.get("prompt_version") or ""),
                    row.get("model"), row.get("run_id"), str(row.get("ledger_sha256") or ""), now,
                ),
            )
            new_status, reason = claim["status"], claim["status_reason"]
            if verdict in {"NOT_SUPPORTED", "NOT_IN_SOURCE"}:
                new_status = "contradicted"
                reason = f"ah:{verdict}"
                contradicted += 1
            elif verdict in {"PARTIAL", "CONTESTED", "ERROR"}:
                reason = f"ah:{verdict}"
            else:
                unchanged += 1
            store.conn.execute(
                "UPDATE claims SET status=?, status_reason=?, updated_at=? WHERE id=?",
                (new_status, reason, now, claim["id"]),
            )
            store.conn.execute(
                "INSERT INTO claims_history(id, claim_id, event, old_status, new_status, actor, reason, evidence_json, at) VALUES (?,?,'status_change',?,?,?,?,?,?)",
                (new_id("csh"), claim["id"], claim["status"], new_status, "ah-import", f"verdict:{verdict}",
                 json.dumps({"ledger_sha256": row.get("ledger_sha256")}), now),
            )
            store.mut("VERDICT_IMPORT", claim_id=claim["id"], paper_id=claim["paper_id"], doc_id=doc["id"], status="ok", reason_code=verdict)
            imported += 1
    store.conn.commit()
    return {"imported": imported, "stale": stale, "contradicted": contradicted, "unchanged": unchanged, "skipped": skipped}
