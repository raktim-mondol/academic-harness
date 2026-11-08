"""Findings ledger and run manifests (design 5.3, 6.7).

State machine:  open -> fixed (the check passes again) -> open again = regression
                open -> waived (author, with reason and expiry) -> open when the expiry holds no more
Only a re-run of a check can mark a finding fixed. Nothing in this module lets an agent close one.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from ..checks.base import Finding
from ..project import Project

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, manifest TEXT NOT NULL, report_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS findings (
  fp TEXT PRIMARY KEY, check_id TEXT, tier TEXT, level TEXT, state TEXT, ref TEXT, file TEXT, key TEXT,
  message TEXT, cause TEXT, first_seen INTEGER, last_seen INTEGER, regression INTEGER DEFAULT 0, fixed_in INTEGER);
CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, fp TEXT, kind TEXT, by TEXT, reason TEXT, condition TEXT, run_id INTEGER);
CREATE TABLE IF NOT EXISTS provenance (
  unit TEXT PRIMARY KEY, author_type TEXT NOT NULL, model TEXT, brief_id TEXT, by_whom TEXT,
  recorded_at TEXT NOT NULL, unit_hash TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS provenance_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, unit TEXT, author_type TEXT, model TEXT, brief_id TEXT, by_whom TEXT,
  recorded_at TEXT, unit_hash TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS disclosures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, draft TEXT NOT NULL, status TEXT NOT NULL, by_whom TEXT,
  recorded_at TEXT, text_hash TEXT);
"""


class Ledger:
    def __init__(self, project: Project):
        project.state_dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(project.state_dir / "ledger.sqlite")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self):
        self.db.close()

    # ---- runs ----
    def last_run(self) -> tuple[int, dict] | None:
        r = self.db.execute("SELECT id, manifest FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        return (r["id"], json.loads(r["manifest"])) if r else None

    def next_run_id(self) -> int:
        r = self.db.execute("SELECT COALESCE(MAX(id),0)+1 AS n FROM runs").fetchone()
        return int(r["n"])

    # ---- reconcile ----
    def reconcile(self, run_id: int, findings: list[Finding], tiers_run: set[str], unit_hashes: dict[str, str],
                  prev: dict | None, snapshot: dict, causes_enabled: bool = True) -> dict:
        cur = {f.fingerprint(): f for f in findings}
        stats = {"new": 0, "unchanged": 0, "fixed": 0, "regressed": 0, "waived": 0, "reopened": 0}
        causes: dict[str, str] = {}
        rows = {r["fp"]: r for r in self.db.execute("SELECT * FROM findings")}

        for fp, f in cur.items():
            r = rows.get(fp)
            if r is None:
                cause = self._cause(f, prev, unit_hashes, snapshot, tiers_run)
                self.db.execute(
                    "INSERT INTO findings (fp,check_id,tier,level,state,ref,file,key,message,cause,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (fp, f.check, f.tier, f.level, "open", f.ref, f.file, f.key, f.message, cause, run_id, run_id))
                stats["new"] += 1
                causes[fp] = cause
            elif r["state"] == "fixed":
                self.db.execute("UPDATE findings SET state='open', regression=1, last_seen=?, message=?, level=?, fixed_in=NULL WHERE fp=?",
                                (run_id, f.message, f.level, fp))
                stats["regressed"] += 1
                causes[fp] = "regression"
            elif r["state"] == "waived":
                cond = self._waiver_condition(fp)
                if cond.get("type") == "unit_hash" and unit_hashes.get(cond.get("ref")) not in (None, cond.get("hash")):
                    self.db.execute("UPDATE findings SET state='open', last_seen=?, cause='waiver-expired:text-changed' WHERE fp=?", (run_id, fp))
                    stats["reopened"] += 1
                    causes[fp] = "waiver-expired:text-changed"
                else:
                    self.db.execute("UPDATE findings SET last_seen=? WHERE fp=?", (run_id, fp))
                    stats["waived"] += 1
            else:  # open or decision-needed
                self.db.execute("UPDATE findings SET last_seen=?, message=?, level=? WHERE fp=?", (run_id, f.message, f.level, fp))
                stats["unchanged"] += 1

        for fp, r in rows.items():
            if fp in cur or r["state"] not in ("open", "decision-needed"):
                continue
            if r["tier"] in tiers_run:
                self.db.execute("UPDATE findings SET state='fixed', fixed_in=? WHERE fp=?", (run_id, fp))
                stats["fixed"] += 1
        self.db.commit()
        return {"stats": stats, "causes": causes}

    def _cause(self, f: Finding, prev: dict | None, unit_hashes: dict, snap: dict, tiers_run: set[str]) -> str:
        if prev is None:
            return "first-coverage"
        if f.tier not in set(prev.get("tiers_run", [])):
            return "first-coverage"
        if f.ref and f.ref in unit_hashes:
            if f.ref not in prev.get("unit_hashes", {}):
                return "unit-new"
            if prev["unit_hashes"][f.ref] != unit_hashes[f.ref]:
                return "text-changed"
        ps = prev.get("snapshot", {})
        if f.tier == "TX" and ps.get("external") != snap.get("external"):
            if f.check == "EXT-00" and ps.get("tex") != snap.get("tex"):
                return "text-changed"   # a result went stale because the text it was computed from changed
            return "evidence-changed"   # an external tool was re-run (or its result went unusable) since the last audit
        if any(ps.get(k) != snap.get(k) for k in ("facts", "sources", "bindings", "glossary", "bib")):
            return "evidence-changed"
        if ps.get("rubric") != snap.get("rubric") or ps.get("config") != snap.get("config") or ps.get("criteria") != snap.get("criteria"):
            return "rubric-changed"
        if f.tier == "TR":
            return "evidence-changed"   # the model's verdict on unchanged text and criteria is new: it had not been judged before
        if ps.get("tex") != snap.get("tex"):
            return "text-changed"
        return "UNEXPLAINED"

    def _waiver_condition(self, fp: str) -> dict:
        r = self.db.execute("SELECT condition FROM decisions WHERE fp=? AND kind='waive' ORDER BY id DESC LIMIT 1", (fp,)).fetchone()
        return json.loads(r["condition"]) if r and r["condition"] else {}

    # ---- queries ----
    def get(self, prefix: str) -> list[sqlite3.Row]:
        return list(self.db.execute("SELECT * FROM findings WHERE fp LIKE ?", (prefix + "%",)))

    def list(self, states: tuple[str, ...] | None = None) -> list[sqlite3.Row]:
        q, args = "SELECT * FROM findings", ()
        if states:
            q += " WHERE state IN (%s)" % ",".join("?" * len(states))
            args = states
        return list(self.db.execute(q + " ORDER BY check_id, file, ref, key", args))

    def waive(self, fp: str, reason: str, by: str, unit_hash: str | None, ref: str | None, run_id: int):
        rows = self.get(fp)
        if len(rows) != 1:
            raise ValueError(f"{len(rows)} findings match '{fp}'")
        cond = {"type": "unit_hash", "ref": ref, "hash": unit_hash} if unit_hash and ref else {"type": "forever"}
        self.db.execute("INSERT INTO decisions (fp,kind,by,reason,condition,run_id) VALUES (?,?,?,?,?,?)",
                        (rows[0]["fp"], "waive", by, reason, json.dumps(cond), run_id))
        self.db.execute("UPDATE findings SET state='waived' WHERE fp=?", (rows[0]["fp"],))
        self.db.commit()
        return rows[0]["fp"]

    def decide(self, fp: str, question: str, run_id: int) -> str:
        """Hand a finding to the author: state decision-needed, with the question. Only a person can resolve it."""
        rows = self.get(fp)
        if len(rows) != 1:
            raise ValueError(f"{len(rows)} findings match '{fp}'")
        self.db.execute("INSERT INTO decisions (fp,kind,by,reason,condition,run_id) VALUES (?,?,?,?,?,?)",
                        (rows[0]["fp"], "decide", "agent", question, None, run_id))
        self.db.execute("UPDATE findings SET state='decision-needed' WHERE fp=?", (rows[0]["fp"],))
        self.db.commit()
        return rows[0]["fp"]

    def save_run(self, run_id: int, manifest: dict, report_hash: str):
        self.db.execute("INSERT INTO runs (id, manifest, report_hash) VALUES (?,?,?)", (run_id, json.dumps(manifest, sort_keys=True), report_hash))
        self.db.commit()

    def all_run_manifests(self) -> list[dict]:
        return [json.loads(r["manifest"]) for r in self.db.execute("SELECT manifest FROM runs ORDER BY id")]

    # ---- provenance (design 13.2) ----
    def provenance_get(self, unit: str) -> dict | None:
        r = self.db.execute("SELECT * FROM provenance WHERE unit=?", (unit,)).fetchone()
        return dict(r) if r else None

    def provenance_list(self, author_type: str | None = None) -> list[sqlite3.Row]:
        if author_type:
            return list(self.db.execute("SELECT * FROM provenance WHERE author_type=? ORDER BY unit", (author_type,)))
        return list(self.db.execute("SELECT * FROM provenance ORDER BY unit"))

    def provenance_set(self, unit: str, *, author_type: str, model: str | None, brief_id: str | None,
                       by_whom: str, recorded_at: str, unit_hash: str | None, note: str) -> dict:
        vals = (unit, author_type, model, brief_id, by_whom, recorded_at, unit_hash, note)
        self.db.execute(
            "INSERT INTO provenance (unit,author_type,model,brief_id,by_whom,recorded_at,unit_hash,note) VALUES (?,?,?,?,?,?,?,?) "
            "ON CONFLICT(unit) DO UPDATE SET author_type=excluded.author_type, model=excluded.model, brief_id=excluded.brief_id, "
            "by_whom=excluded.by_whom, recorded_at=excluded.recorded_at, unit_hash=excluded.unit_hash, note=excluded.note",
            vals)
        self.db.execute(
            "INSERT INTO provenance_log (unit,author_type,model,brief_id,by_whom,recorded_at,unit_hash,note) VALUES (?,?,?,?,?,?,?,?)",
            vals)
        self.db.commit()
        return dict(self.db.execute("SELECT * FROM provenance WHERE unit=?", (unit,)).fetchone())

    def disclosure_latest(self) -> dict | None:
        r = self.db.execute("SELECT * FROM disclosures ORDER BY id DESC LIMIT 1").fetchone()
        return dict(r) if r else None

    def disclosure_approve(self, text: str, *, by: str, recorded_at: str, text_hash: str) -> dict:
        self.db.execute("INSERT INTO disclosures (draft,status,by_whom,recorded_at,text_hash) VALUES (?,?,?,?,?)",
                        (text, "approved", by, recorded_at, text_hash))
        self.db.commit()
        r = self.db.execute("SELECT * FROM disclosures ORDER BY id DESC LIMIT 1").fetchone()
        return dict(r)
