"""Opt-in hosted rubric test (OpenCode or Claude Code) on sampled COPIED manuscripts, never on originals.

Requires explicit --model and --corpus (writing-compiler-corpus.py results.json). --adapter picks the route.
This measures engineering behavior, not independently labelled rubric accuracy.
"""
import argparse
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import time

ENGINE = Path(__file__).resolve().parents[1] / "vendor/academic-harness"
sys.path.insert(0, str(ENGINE))
os.environ["PYTHONPATH"] = str(ENGINE) + os.pathsep + os.environ.get("PYTHONPATH", "")

from ah.audit import audit
from ah.checks.rubric import run_rubric
from ah.cli import main
from ah.context import build_context
from ah.project import Project
from ah.verifier.backends import get_backend
import yaml


ADAPTERS = {"opencode": ("ah.verifier.opencode", "opencode-v1"), "claude": ("ah.verifier.claude", "claude-v1")}


def run():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--adapter", choices=sorted(ADAPTERS), default="opencode")
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--switch-model", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    samples = []
    for row in json.loads(Path(args.corpus).read_text()):
        if row.get("error"):
            continue
        ctx = build_context(Project(row["copy"]))
        usable = [u for u in ctx.units if u.kind == "para" and 20 <= u.words <= 160 and "\\input" not in u.norm]
        for u in usable[:2]:
            samples.append(u.norm)
    samples += ["We tested this method on three datasets. It always achieves the best accuracy on every possible dataset.",
                "We evaluated this method on three datasets. We report observations on those datasets without claiming performance elsewhere."]
    with redirect_stdout(io.StringIO()):
        main(["init", str(out / "project"), "--profile", "paper/conference"])
    root = out / "project"
    (root / "src/sections").mkdir(parents=True, exist_ok=True)
    section = root / "src/sections/samples.tex"
    section.write_text("\\section{Sampled paragraphs}\n\n" + "\n\n".join(samples) + "\n")
    cfg = yaml.safe_load((root / "ah.yaml").read_text())
    cfg["tex"]["prose"] = ["sections/samples.tex"]
    cfg["criteria"] = {"workers": 4}
    module, revision = ADAPTERS[args.adapter]
    cfg["verifier"] = {"backend": "command", "model": args.model, "revision": revision, "response_format": "json-v1", "timeout": 200,
                       "cmd": [sys.executable, "-m", module, "--model", args.model]}
    def save():
        (root / "ah.yaml").write_text(yaml.safe_dump(cfg))
    save()
    with redirect_stdout(io.StringIO()):
        main(["units", "sync", "--project", str(root)])
    ids = ["RUB-GENERAL", "RUB-SUPERLATIVE"]
    stats = {}
    def audit_run(name, judge=True):
        p = Project(root)
        start = time.monotonic()
        report = audit(p, ("TR",), rubric_backend=get_backend(p.cfg) if judge else None, rubric_criteria=ids)
        stats[name] = dict(report["rubric_run"], seconds=round(time.monotonic()-start, 3), report_hash=report["report_hash"], ledger=report.get("ledger"))
        (out / f"{name}.json").write_text(json.dumps(report, indent=2))
        (out / "summary.json").write_text(json.dumps(stats, indent=2))
        print(name, json.dumps(stats[name]), flush=True)
    audit_run("cold")
    audit_run("warm")
    section.write_text(section.read_text().replace("It always achieves the best accuracy on every possible dataset.", "It achieved higher accuracy in our limited comparison on those datasets."))
    audit_run("edit")
    cfg["verifier"]["model"] = args.switch_model
    cfg["verifier"]["cmd"][-1] = args.switch_model
    save()
    p = Project(root)
    _, changed = run_rubric(build_context(p), get_backend(p.cfg), limit=2, only_criteria=ids)
    changed.pop("unjudged", None)
    stats["model_switch"] = changed
    cfg["verifier"]["model"] = args.model
    cfg["verifier"]["cmd"][-1] = args.model
    save()
    audit_run("restored", judge=False)
    assert stats["cold"]["errors"] == 0
    assert stats["warm"]["calls"] == 0
    assert stats["warm"]["report_hash"] == stats["cold"]["report_hash"]
    assert stats["edit"]["calls"] == len(ids)
    assert stats["model_switch"]["cached"] == 0 and stats["model_switch"]["calls"] == 2
    assert stats["restored"]["calls"] == 0
    print("live invariants passed", flush=True)


if __name__ == "__main__":
    run()
