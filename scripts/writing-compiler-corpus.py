"""Opt-in local corpus regression. Only copied TeX/bibliography sources are mutated.

Input: JSON [{"path": "/absolute/manuscript/main.tex"}, ...]. No discovery or model calls.
Outputs may contain private manuscript paths; keep the output directory private.
"""
import argparse
from contextlib import redirect_stdout
import hashlib
import io
import json
import re
from pathlib import Path
import shutil
import sys
import time

ENGINE = Path(__file__).resolve().parents[1] / "vendor/academic-harness"
sys.path.insert(0, str(ENGINE))

from ah.audit import audit
from ah.cli import main
from ah.migrate import scan
from ah.project import Project
from ah.stability import stability
from ah.tex.text import RE_INPUT, strip_comments
import yaml


def copy_sources(source: Path, dest: Path):
    root, seen, unresolved = source.parent.resolve(), set(), []

    def copy(path):
        path = path.resolve()
        if path in seen:
            return
        if not path.is_relative_to(root):
            unresolved.append(str(path))
            return
        seen.add(path)
        rel = path.relative_to(root)
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        for inc in RE_INPUT.findall(strip_comments(path.read_text(errors="replace"))):
            name = inc if inc.endswith(".tex") else inc + ".tex"
            found = next((p for p in (root / name, path.parent / name) if p.is_file()), None)
            if found:
                copy(found)
            else:
                unresolved.append(inc)
    copy(source)
    for bib in root.rglob("*.bib"):
        if any(p.startswith('.') or p in ('node_modules', 'vendor', 'archive') for p in bib.relative_to(root).parts):
            continue
        target = dest / bib.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(bib, target)
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in seen}, unresolved


def main_run():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--extract-root", action="store_true", help="move root document bodies into a section on copies only")
    args = ap.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    rows, seen = [], set()
    for entry in json.loads(Path(args.manifest).read_text()):
        source = Path(entry["path"])
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        if len(rows) >= args.limit:
            break
        dest = out / f"paper-{len(rows):03d}"
        start = time.monotonic()
        row = {"source": str(source), "copy": str(dest)}
        try:
            hashes, missing = copy_sources(source, dest)
            if args.extract_root:
                root_file = dest / source.name
                raw = root_file.read_text()
                match = re.search(r"\\begin\{document\}(.*?)\\end\{document\}", raw, re.S)
                if match:
                    section = dest / "ah-test-body.tex"
                    section.write_text(match.group(1))
                    root_file.write_text(raw[:match.start(1)] + "\n\\input{ah-test-body}\n" + raw[match.end(1):])
                    row["root_body_extracted_on_copy"] = True
            with redirect_stdout(io.StringIO()):
                assert main(["migrate", str(dest), "--apply", "--profile", "generic"]) == 0
                cfg = yaml.safe_load((dest / "ah.yaml").read_text())
                cfg["tex"]["views"] = [source.name]
                (dest / "ah.yaml").write_text(yaml.safe_dump(cfg))
                assert main(["units", "sync", "--project", str(dest)]) == 0
            p = Project(dest)
            first, second = audit(p), audit(p)
            stable = stability(p, runs=args.runs)
            row.update(units=first["coverage"]["units"], files=first["coverage"]["files"], findings=len(first["findings"]),
                       hash_equal=first["report_hash"] == second["report_hash"], ledger=second["ledger"],
                       unexplained=second["unexplained"], stable=stable["verdict"], checks=first["checks_fired"],
                       scope=first["coverage"]["input_scope"], source_unresolved=missing,
                       originals_unchanged=all(hashlib.sha256(Path(f).read_bytes()).hexdigest() == h for f, h in hashes.items()))
            (dest / "audit.json").write_text(json.dumps(first, indent=2))
            (dest / "stability.json").write_text(json.dumps(stable, indent=2))
        except Exception as e:
            row["error"] = f"{type(e).__name__}: {e}"
        row["seconds"] = round(time.monotonic() - start, 3)
        rows.append(row)
        (out / "results.json").write_text(json.dumps(rows, indent=2))
        print(json.dumps({k: row.get(k) for k in ("copy", "units", "stable", "hash_equal", "seconds", "error")}), flush=True)
    print("results:", out / "results.json")


if __name__ == "__main__":
    main_run()
