"""Command line: `ah <command>`. All commands accept --project DIR and --json (design 11.6)."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

from . import __version__
from .audit import audit, det_check, run_checks
from .checks.base import CATALOGUE, DEFAULT_TIERS, TIERS
from .context import build_context, unit_ref
from .facts.model import build_facts
from .facts.render import diff_lock, read_lock, to_lock, write_build
from .ledger.db import Ledger
from .project import Project
from .sweep import sweep_fact, sweep_value
from .tex.units import sync_project

EXIT_OK, EXIT_FINDINGS, EXIT_ERROR = 0, 1, 2

INIT_AH = """project: {name}
profile: generic
tex:
  root: src
  views: [views/main.tex]
  prose: ["sections/**/*.tex", "appendices/**/*.tex"]
  bib: [refs/references.bib]
facts: facts/facts.yaml
glossary: glossary.yaml
sources: sources/registry.yaml
"""


def _proj(a) -> Project:
    return Project(a.project)


def _tiers(a) -> tuple[str, ...]:
    if not getattr(a, "tiers", None):
        base = DEFAULT_TIERS
        if getattr(a, "evidence", False) or getattr(a, "verify", False):
            base = tuple(t for t in TIERS if t in DEFAULT_TIERS or t == "T3")
        return base
    t = tuple(x.strip().upper() for x in a.tiers.split(",") if x.strip())
    bad = [x for x in t if x not in TIERS]
    if bad:
        raise SystemExit(f"unknown tier(s): {bad}; choose from {TIERS}")
    return t


def render_report(rep: dict, limit: int = 25) -> str:
    cov = rep["coverage"]
    lines = [f"ah audit  project={rep['project']}  tiers={','.join(rep['tiers'])}  rubric={rep['rubric']}"
             + (f"  run={rep['run']}" if "run" in rep else ""),
             f"coverage: {cov['units']} units ({cov['paragraph_units']} paragraphs, {cov['float_units']} floats) in {cov['files']} files; "
             f"{cov['units_with_anchor']} anchored; {cov['citations']} citations; {cov['facts']} facts; {cov['bindings']} bindings",
             f"numbers in paragraphs: {cov['numbers_in_paragraphs']}"]
    live = [f for f in rep["findings"] if f["state"] in ("open", "decision-needed")]
    if rep.get("evidence"):
        e = rep["evidence"]
        lines.append(f"evidence: {e['claims']} cited claims; {e['with_source']} have source text, {e['no_source']} do not; numbers checked in {e['number_checked']} ({e['number_missing']} not found); "
                     f"verified {e['verified']} {e['verdicts']}; model calls {e['calls']} (cached {e['cached']}), tokens in/out {e['tokens_in']}/{e['tokens_out']}, errors {e['errors']}")
    if rep.get("cost"):
        c = rep["cost"]
        extra = f"; T3 calls {c.get('t3_calls', 0)} cached {c.get('t3_cached', 0)}" if "t3_calls" in c else ""
        lines.append(f"cost: {c['seconds']}s  {c['mode']}" + (f" ({c['note']})" if c.get("note") else "")
                     + f"; units {c.get('units_changed', '?')}/{c.get('units_total', '?')} rechecked" + extra)
    lines.append(f"open findings: {len(live)}  by level: {rep['counts']}")
    lines.append(f"by check: {rep['checks_fired']}")
    if "ledger" in rep:
        lines.append(f"ledger: {rep['ledger']}  causes of new findings: {rep['new_causes']}")
        if rep.get("unexplained"):
            lines.append(f"!! UNEXPLAINED new findings (harness bug): {rep['unexplained']}")
    shown = 0
    for lvl in ("blocker", "major", "minor", "info"):
        group = [f for f in live if f["level"] == lvl]
        if not group:
            continue
        lines.append(f"\n[{lvl}] {len(group)}")
        for f in group:
            if shown >= limit:
                break
            where = f"{f['unit'] or f['file'] or '-'}" + (f" ({f['file']}:{f['line']})" if f["unit"] and f.get("line") else "")
            lines.append(f"  {f['fingerprint'][:8]} {f['check']:9} {where}: {f['message'][:160]}")
            shown += 1
    if len(live) > shown:
        lines.append(f"  ... {len(live) - shown} more (use --json or --limit)")
    g = rep["gate"]
    lines.append(f"\ngate: {'PASS' if g['passed'] else 'FAIL'}  ({g['blocking']} blocking at levels {g['levels']})")
    return "\n".join(lines)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def cmd_init(a):
    from . import profiles
    try:
        prof = profiles.load(a.profile)
    except ValueError as e:
        print(e, file=sys.stderr)
        return EXIT_ERROR
    root = Path(a.dir)
    if (root / "ah.yaml").exists():
        print(f"{root}/ah.yaml already exists; not overwriting", file=sys.stderr)
        return EXIT_ERROR
    (root / "src/views").mkdir(parents=True, exist_ok=True)
    (root / "src/sections/01_introduction").mkdir(parents=True, exist_ok=True)
    for d in ("facts", "sources", "src/refs"):
        (root / d).mkdir(parents=True, exist_ok=True)
    (root / "ah.yaml").write_text(INIT_AH.format(name=root.resolve().name).replace("profile: generic", f"profile: {a.profile}"))
    (root / "facts/facts.yaml").write_text(yaml.safe_dump({"facts": prof.scaffold_facts if prof else []}, sort_keys=False))
    (root / "sources/registry.yaml").write_text("sources: []\n")
    (root / "glossary.yaml").write_text("terms: []\n")
    (root / "src/refs/references.bib").write_text("")
    heads = (prof.sections if prof and prof.sections else ["Introduction"])
    inputs = []
    for i, h in enumerate(heads, 1):
        d = f"sections/{i:02d}_{_slug(h)}"
        (root / "src" / d).mkdir(parents=True, exist_ok=True)
        (root / "src" / d / "index.tex").write_text(f"\\section{{{h}}}\n\\label{{sec:{_slug(h)}}}\n\nWrite the first paragraph here.\n")
        inputs.append(f"\\input{{{d}/index}}")
    (root / "src/views/main.tex").write_text(
        "\\documentclass{article}\n\\input{../src/macros/facts}\n\\begin{document}\n" + "\n".join(inputs) + "\n\\end{document}\n")
    for rel, text in (prof.scaffold if prof else {}).items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    sections_ol = [{"file": f"sections/{i:02d}_{_slug(h)}/*", "purpose": h} for i, h in enumerate(heads, 1)]
    (root / "outline.yaml").write_text(yaml.safe_dump(
        {"status": "draft", "thesis": "", "sections": sections_ol, "claims": []}, sort_keys=False))
    print(f"created {a.profile} project in {root}; next: ah units sync && ah facts build && ah audit")
    return EXIT_OK


def cmd_units(a):
    p = _proj(a)
    if a.action == "hashes":
        from .hooks import unit_hashes
        print(json.dumps(unit_hashes(p)))
        return EXIT_OK
    s = sync_project(p, write=not a.check)
    print(json.dumps(s, indent=1) if a.json else
          f"{'would change' if a.check else 'synced'}: {s['added']} anchors added, {s['hash_updated']} hashes updated, {s['unchanged']} unchanged in {s['files']} files; orphan anchors: {len(s['orphan_anchors'])}")
    for o in s["orphan_anchors"]:
        print("  orphan:", o)
    return EXIT_FINDINGS if a.check and (s["added"] or s["hash_updated"]) else EXIT_OK


def cmd_verify_touched(a):
    """Advisory T3 on the files an agent just changed. Never a gate; JSON for adapters."""
    from .hooks import verify_touched
    p = _proj(a)
    files = [x.strip() for x in (a.files or "").split(",") if x.strip()]
    before = json.loads(a.before) if a.before else None
    print(json.dumps(verify_touched(p, files, before=before)))
    return EXIT_OK


def cmd_inventory(a):
    from .audit import coverage
    ctx = build_context(_proj(a))
    cov = coverage(ctx)
    print(json.dumps(cov, indent=1) if a.json else "\n".join(f"{k}: {v}" for k, v in cov.items()))
    return EXIT_OK


def cmd_facts(a):
    p = _proj(a)
    fs, errs = build_facts(p)
    if a.action == "list" and a.json:
        print(json.dumps({fid: {"kind": f.kind, "default": f.default_variant(), "variants": {v: d["plain"] for v, d in f.variants.items()},
                                "superseded": [s["text"] for s in f.superseded]} for fid, f in fs.facts.items()}, indent=1))
        return EXIT_ERROR if errs else EXIT_OK
    if a.action == "list":
        for fid, f in fs.facts.items():
            print(f"{fid:24} {f.kind:11} " + "  ".join(f"{v}={d['plain']}" for v, d in sorted(f.variants.items())))
        for e in errs:
            print("ERROR:", e)
        return EXIT_ERROR if errs else EXIT_OK
    if errs:
        for e in errs:
            print("ERROR:", e)
        return EXIT_ERROR
    old = read_lock(p)
    if a.action == "check":
        d = diff_lock(old, to_lock(fs))
        stale = bool(d["added"] or d["removed"] or d["changed"])
        print(json.dumps(d, indent=1) if a.json else f"facts vs lock: added={d['added']} removed={d['removed']} changed={list(d['changed'])}")
        return EXIT_FINDINGS if stale else EXIT_OK
    d = write_build(p, fs)
    print(f"wrote {p.macros_file()} and lock; added={d['added']} removed={d['removed']} changed={list(d['changed'])}")
    if d["changed"]:
        ctx = build_context(p)
        print("\nsweep of changed facts (units that use them or still hold the old value):")
        for fid, vars_ in d["changed"].items():
            res = sweep_fact(ctx, fid, {fid: vars_})
            print(f"  {fid}: {len(res['uses'])} uses, {len(res['stale_or_old'])} places holding an old or superseded value")
            for h in res["stale_or_old"][:10]:
                print(f"     {h['unit'] or h['file']}: {h['why']}: ...{h['snippet']}...")
    return EXIT_OK


def _backend(a, p):
    from .verifier.backends import get_backend
    if not getattr(a, "verify", False):
        return None
    if getattr(a, "model", None) or getattr(a, "provider", None):
        p.cfg.setdefault("verifier", {}).update({k: v for k, v in (("model", a.model), ("provider", a.provider)) if v})
        p.cfg["verifier"].setdefault("backend", "pi")
    if getattr(a, "thinking", None) is not None:
        p.cfg.setdefault("verifier", {})["thinking"] = a.thinking
    b = get_backend(p.cfg)
    if b is None:
        raise SystemExit("--verify needs a `verifier:` section in ah.yaml (backend: pi|command)")
    return b


def _t3kw(a):
    return {"use_cache": not getattr(a, "no_cache", False), "limit": getattr(a, "limit_claims", 0) or 0,
            "only_files": getattr(a, "file", None) or None}


def _narrow(rep: dict, files: list[str] | None, brief: bool) -> dict:
    """Keep only findings in the named files (paths relative to the TeX root or the project root); optionally compact."""
    if files:
        want = [f.strip().lstrip("./") for f in files]
        keep = [f for f in rep["findings"] if f["file"] and any(f["file"] == w or f["file"].endswith("/" + w) or w.endswith("/" + f["file"]) or w.endswith(f["file"]) for w in want)]
        rep = dict(rep, findings=keep)
        live = [f for f in keep if f["state"] in ("open", "decision-needed")]
        from collections import Counter
        rep["counts"] = dict(Counter(f["level"] for f in live))
        rep["checks_fired"] = dict(Counter(f["check"] for f in live))
        blocking = [f for f in live if f["level"] in rep["gate"]["levels"]]
        rep["gate"] = dict(rep["gate"], passed=not blocking, blocking=len(blocking))
    if brief:
        rep = {"gate": rep["gate"], "counts": rep["counts"], "tiers": rep["tiers"],
               "findings": [{"fp": f["fingerprint"], "check": f["check"], "level": f["level"], "unit": f["unit"], "file": f["file"],
                             "line": f["line"], "state": f["state"], "message": f["message"][:240]} for f in rep["findings"]
                            if f["state"] in ("open", "decision-needed")]}
    return rep


def cmd_check(a):
    p = _proj(a)
    rep = audit(p, _tiers(a), use_ledger=False, backend=_backend(a, p), **_t3kw(a))
    rep = _narrow(rep, a.files.split(",") if getattr(a, "files", None) else None, getattr(a, "brief", False))
    print(json.dumps(rep, indent=1) if a.json else (render_report(rep, a.limit) if "coverage" in rep else json.dumps(rep, indent=1)))
    return EXIT_OK if rep["gate"]["passed"] else EXIT_FINDINGS


def cmd_audit(a):
    p = _proj(a)
    extra = None
    if a.build:
        from .tex.build import log_findings, parse_log, run_build
        ctx = build_context(p)
        b = run_build(p)
        if b.get("error"):
            print("build:", b["error"], file=sys.stderr)
            return EXIT_ERROR
        extra = log_findings(ctx, parse_log(b["log"]))
    rep = audit(p, _tiers(a), use_ledger=not a.no_ledger, extra_findings=extra, backend=_backend(a, p),
                incremental=getattr(a, "incremental", False), **_t3kw(a))
    if a.det_check:
        rep["det01"] = det_check(p, _tiers(a), backend=_backend(a, p))
    if a.json:
        print(json.dumps(rep, indent=1))
    else:
        print(render_report(rep, a.limit))
        if "det01" in rep:
            print(f"DET-01: {'identical' if rep['det01']['identical'] else 'DIFFERENT'} ({rep['det01']['findings']} findings, hash {rep['det01']['hash']})")
    if rep.get("unexplained") or ("det01" in rep and not rep["det01"]["identical"]):
        return EXIT_ERROR
    return EXIT_OK if rep["gate"]["passed"] else EXIT_FINDINGS


def cmd_build(a):
    from .tex.build import parse_log, run_build
    p = _proj(a)
    b = run_build(p, a.view)
    if b.get("error"):
        print("build:", b["error"], file=sys.stderr)
        return EXIT_ERROR
    parsed = parse_log(b["log"])
    print(json.dumps(parsed, indent=1) if a.json else f"build {'PDF produced' if b['ok'] else 'FAILED'}: {len(parsed['errors'])} TeX errors (TeX continues past 'ignored' ones), "
          f"{len(parsed['undefined_refs'])} undefined refs, {len(parsed['undefined_cites'])} undefined cites, "
          f"{len(parsed['duplicate_destinations'])} duplicate destinations, {len(parsed['undefined_facts'])} undefined facts, {parsed['overfull']} overfull")
    return EXIT_OK if b["ok"] else EXIT_FINDINGS


def cmd_sweep(a):
    ctx = build_context(_proj(a))
    if a.fact:
        res = sweep_fact(ctx, a.fact)
    else:
        res = sweep_value(ctx, a.value, a.regex)
    if a.json:
        print(json.dumps(res, indent=1))
    else:
        rows = res if isinstance(res, list) else res["uses"] + res["stale_or_old"]
        for h in rows:
            print(f"{h['unit'] or '-':22} {h['file'] or '-':36} {h['why']}: ...{h.get('snippet', '')}...")
        print(f"{len(rows)} place(s)")
    return EXIT_OK


def cmd_finding(a):
    p = _proj(a)
    led = Ledger(p)
    try:
        if a.action == "list":
            rows = led.list(tuple(a.state.split(",")) if a.state else None)
            if a.json:
                print(json.dumps([{k: r[k] for k in ("fp", "state", "level", "check_id", "ref", "file", "message", "cause", "regression")} for r in rows], indent=1))
                return EXIT_OK
            for r in rows:
                print(f"{r['fp'][:8]} {r['state']:9} {r['level']:7} {r['check_id']:9} {r['ref'] or r['file'] or '-'}: {r['message'][:110]}")
            print(f"{len(rows)} finding(s)")
        elif a.action == "show":
            rows = led.get(a.fp)
            for r in rows:
                print(json.dumps(dict(r), indent=1))
        elif a.action == "decide":
            if not a.reason:
                print("decide needs --reason (the question for the author)", file=sys.stderr)
                return EXIT_ERROR
            if not led.get(a.fp):          # the finding came from a stateless check: record the current state first
                led.close()
                audit(p, use_ledger=True)
                led = Ledger(p)
            last = led.last_run()
            fp = led.decide(a.fp, a.reason, last[0] if last else 0)
            print(f"{fp[:8]} is now decision-needed: {a.reason}")
        elif a.action == "waive":
            if not a.by or not a.reason:
                print("waive needs --by and --reason", file=sys.stderr)
                return EXIT_ERROR
            if not a.yes and not (sys.stdin.isatty() and input(f"Waive {a.fp}? type 'yes': ").strip() == "yes"):
                print("waiving needs a human: run interactively or pass --yes yourself", file=sys.stderr)
                return EXIT_ERROR
            rows = led.get(a.fp)
            if len(rows) != 1:
                print(f"{len(rows)} findings match", file=sys.stderr)
                return EXIT_ERROR
            ctx = build_context(p)
            ref = rows[0]["ref"]
            u = ctx.unit_by_ref().get(ref) if ref else None
            last = led.last_run()
            fp = led.waive(a.fp, a.reason, a.by, None if a.forever or not u else u.hash, ref, last[0] if last else 0)
            print(f"waived {fp[:8]} ({'until the unit changes' if u and not a.forever else 'forever'})")
    finally:
        led.close()
    return EXIT_OK


def cmd_bind(a):
    """Suggest bindings: literal numbers in prose that equal a fact variant's digits."""
    ctx = build_context(_proj(a))
    sugg = []
    for i in ctx.inv:
        if i.unit.kind != "para":
            continue
        for n in i.nums:
            if n.cls != "literal":
                continue
            for fid, f in ctx.facts.facts.items():
                for var in f.variants:
                    if var in ("frac", "full", "ci"):
                        continue
                    if ctx.facts.number_text(f"{fid}.{var}") == n.text:
                        sugg.append({"unit": unit_ref(i.unit), "token": n.text, "fact": f"{fid}.{var}"})
    print(json.dumps({"bindings": sugg}, indent=1) if a.json else "\n".join(f"- {{unit: {s['unit']}, token: \"{s['token']}\", fact: {s['fact']}}}" for s in sugg))
    return EXIT_OK


def cmd_eval(a):
    from .eval.seed import run_seed
    return run_seed(Path(a.project), only=a.only, json_out=a.json)


def cmd_eval_dispatch(a):
    if a.action == "claims":
        return cmd_eval_claims(a)
    if a.action == "style":
        return cmd_eval_style(a)
    return cmd_eval(a)


def cmd_eval_style(a):
    from .eval.style import run_style_eval
    golden = Path(a.golden) if a.golden else Path(__file__).resolve().parent.parent / "golden/t5_style_v0.jsonl"
    res = run_style_eval(golden)
    print(json.dumps(res, indent=1, default=str))
    return EXIT_OK


def cmd_evidence(a):
    from .evidence import export_ledger, import_memory_ledger

    p = _proj(a)
    if a.action == "export":
        rows = export_ledger(p)
        text = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
        if a.out:
            Path(a.out).write_text(text + ("\n" if text else ""), encoding="utf-8")
        if a.json:
            print(json.dumps({"rows": len(rows), "out": a.out}, indent=1))
        elif not a.out:
            print(text)
        return EXIT_OK
    if not a.path:
        print("import-ledger requires a PaperMemory ledger path", file=sys.stderr)
        return EXIT_ERROR
    print(json.dumps(import_memory_ledger(p, Path(a.path)), indent=1))
    return EXIT_OK


def cmd_source(a):
    from .sources.index import Index
    from .sources.registry import add_source, load_registry, resolve, source_map
    p = _proj(a)
    if a.action == "add":
        meta = {"title": a.title, "year": a.year, "doi": a.doi, "kind": a.kind, "class": a.cls, "tags": a.tags.split(",") if a.tags else None}
        e = add_source(p, Path(a.path), a.id, keys=a.keys.split(",") if getattr(a, "keys", None) else None, **meta)
        print(json.dumps(e, indent=1))
    elif a.action == "list":
        reg = load_registry(p)
        for sid, s in reg.items():
            print(f"{sid:28} {s.get('status', 'ok'):10} {s.get('year', '-')}  {(s.get('title') or '')[:60]}  [{s.get('file') or 'metadata-only'}]")
        print(f"{len(reg)} source(s)")
    elif a.action == "search":
        reg, smap, idx = load_registry(p), source_map(p), Index(p)
        path = resolve(p, a.id, reg, smap)
        if not path:
            print(f"no text for '{a.id}'", file=sys.stderr)
            return EXIT_ERROR
        idx.ensure(a.id, path)
        from .sources.index import snippet
        for ps in idx.search([a.id], a.query, a.k):
            print(f"{ps.locator}  (score {ps.score:.2f})\n   {snippet(ps.text, a.query, 300)}")
    return EXIT_OK


def cmd_claims(a):
    from .claims import extract_claims
    ctx = build_context(_proj(a))
    cl = extract_claims(ctx)
    from collections import Counter
    if a.json:
        print(json.dumps([c.__dict__ for c in cl], indent=1))
    else:
        for c in cl[: a.limit]:
            print(f"{c.id} {c.kind:13} {c.unit:28} {','.join(c.cites)[:40]:40} {c.sentence[:90]}")
        print(f"{len(cl)} claims: {dict(Counter(c.kind for c in cl))}")
    return EXIT_OK


def cmd_eval_claims(a):
    from .eval.claims_eval import run_claims_eval
    from .verifier.backends import get_backend
    p = _proj(a)
    if a.model or a.provider:
        p.cfg.setdefault("verifier", {}).update({k: v for k, v in (("model", a.model), ("provider", a.provider)) if v})
        p.cfg["verifier"].setdefault("backend", "pi")
        if a.thinking is not None:
            p.cfg["verifier"]["thinking"] = a.thinking
    backend = None if a.no_model else get_backend(p.cfg)
    res = run_claims_eval(p, Path(a.golden), backend, k=a.k, limit=a.limit, repeat=a.repeat, use_cache=not a.no_cache, jev=a.jev)
    print(json.dumps(res, indent=1, default=str))
    return EXIT_OK


def cmd_models(a):
    """Show the project's data_policy and whether the configured verifier is admitted."""
    from .verifier.backends import PolicyError, admit, endpoint_class
    p = _proj(a)
    v = p.cfg.get("verifier") or {}
    policy = p.cfg.get("data_policy") or "open"
    kind = v.get("backend") or "(none)"
    url = v.get("url") or v.get("base_url")
    info = {"data_policy": policy, "data_policy_allow": p.cfg.get("data_policy_allow") or [],
            "verifier": {"backend": kind, "provider": v.get("provider"), "model": v.get("model"), "url": url,
                         "class": endpoint_class(kind, url) if kind not in ("(none)",) else None}}
    try:
        if v.get("backend"):
            admit(p.cfg, v["backend"], url)
            info["admitted"] = True
            info["note"] = "T3 --verify will call this backend"
        else:
            info["admitted"] = True
            info["note"] = "no verifier configured; T3 --verify is skipped (deterministic EVD-02 still runs)"
    except PolicyError as e:
        info["admitted"] = False
        info["note"] = str(e)
    if a.json:
        print(json.dumps(info, indent=1))
    else:
        print(f"data_policy: {policy}" + (f" allow={info['data_policy_allow']}" if info["data_policy_allow"] else ""))
        print(f"verifier: backend={kind} provider={v.get('provider') or '-'} model={v.get('model') or '-'} "
              f"url={url or '-'} class={info['verifier']['class']}")
        print(("admitted: " if info["admitted"] else "refused: ") + info["note"])
        print("writer: the Pi (or Claude Code) session; the engine does not call it")
    return EXIT_OK if info["admitted"] else EXIT_ERROR


def cmd_config(a):
    p = _proj(a)
    print(json.dumps({"root": str(p.root), "tex_root": str(p.tex_root), "project": p.cfg["project"], "protected": p.protected_globs(),
                      "prose": [p.rel(f) for f in p.prose_files()], "views": [p.rel(f) for f in p.view_files()],
                      "gate": p.cfg["gate"], "macros": p.rel(p.macros_file())}, indent=1))
    return EXIT_OK


def cmd_state(a):
    from .state import build_state
    print(build_state(_proj(a), unit=getattr(a, "unit", None)))
    return EXIT_OK


def cmd_hook(a):
    from . import hooks
    return hooks.main(a.event)


def cmd_hooks_config(a):
    from . import hooks
    print(json.dumps(hooks.hooks_config(a.cmd), indent=1))
    return EXIT_OK


def cmd_profile(a):
    from . import profiles
    if a.action == "list" or not a.name:
        for n in profiles.names():
            print(f"{n:32} {profiles.load(n).description}")
        return EXIT_OK
    try:
        prof = profiles.load(a.name)
    except ValueError as e:
        print(e, file=sys.stderr)
        return EXIT_ERROR
    print(f"{prof.name}\n{prof.description}\nparameters: {prof.params or '-'}\nscaffold sections: {', '.join(prof.sections) or '-'}")
    for r in prof.rules:
        print(f"  rule {r.get('id', r['kind']):16} {r['kind']:14} " + (f"file={r['file']}" if r.get("file") else (f"map={r['map']}" if r.get("map") else "")))
    return EXIT_OK


def cmd_catalogue(a):
    for cid, (tier, lvl, title) in CATALOGUE.items():
        print(f"{cid:9} {tier} {lvl:8} {title}")
    return EXIT_OK


def cmd_migrate(a):
    from .migrate import apply, plan
    root = Path(a.dir)
    try:
        pl = plan(root, profile=a.profile, dest=Path(a.dest) if a.dest else None,
                  facts=a.facts or a.bind_facts, bind_facts=a.bind_facts,
                  min_repeats=a.min_repeats, legacy_level=a.legacy_literals)
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_ERROR
    public = {k: v for k, v in pl.items() if not k.startswith("_")}
    if not a.apply:
        if a.json:
            print(json.dumps(public, indent=1))
        else:
            s = public["scan"]
            print(f"migrate {s['root']}")
            print(f"  guessed profile: {public['profile']}  views: {s['views']}  bib: {s['bib']}")
            print(f"  prose: {s['prose_globs']}")
            print(f"  would write: {list(public['writes'])}")
            if public["candidates"]:
                print(f"  fact candidates ({len(public['candidates'])}):")
                for c in public["candidates"][:15]:
                    print(f"    {c['id']:16} {c['text']}{'%' if c['pct'] else ''} ×{c['count']}")
            for w in public["warnings"]:
                print("  warning:", w)
            for r in public["recommendations"]:
                print("  next:", r)
            print("dry run; pass --apply to write the overlay")
        return EXIT_OK
    try:
        res = apply(pl, force=a.force, yes=a.yes)
    except (FileExistsError, PermissionError) as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_ERROR
    if a.sync:
        from .facts.model import build_facts
        from .facts.render import write_build
        from .tex.units import sync_project
        p = Project(res["dest"])
        sync_project(p)
        fs, errs = build_facts(p)
        if errs:
            print("facts:", "; ".join(errs), file=sys.stderr)
        else:
            write_build(p, fs)
    if a.json:
        print(json.dumps({**public, "applied": res}, indent=1))
    else:
        print(f"migrated {res['dest']} profile={res['profile']} wrote {len(res['written'])} overlay file(s)")
        if res["bound"]:
            print(f"  bound facts in {len(res['bound'])} file(s)")
        print("next: ah audit")
    return EXIT_OK


def cmd_provenance(a):
    from . import provenance as PV
    p = _proj(a)
    if a.action == "list":
        from .ledger.db import Ledger
        led = Ledger(p)
        try:
            rows = [dict(r) for r in led.provenance_list(a.type)]
        finally:
            led.close()
        if a.json:
            print(json.dumps(rows, indent=1))
        else:
            for r in rows:
                print(f"{r['unit']:28} {r['author_type']:8} {r.get('model') or '-':20} brief={r.get('brief_id') or '-'} {r['recorded_at']}")
            print(f"{len(rows)} record(s)")
        return EXIT_OK
    if a.action == "show":
        s = PV.summary(p)
        payload = s if a.json else {k: s[k] for k in ("units", "recorded", "counts", "models", "briefs", "verifier_models", "disclosure")}
        print(json.dumps(payload, indent=1, default=str))
        return EXIT_OK
    if a.action == "set":
        if not a.unit or not a.type:
            print("set needs a unit id and --type", file=sys.stderr)
            return EXIT_ERROR
        row = PV.record(p, a.unit, author_type=a.type, model=a.model, brief_id=a.brief, by=a.by or "author", note=a.note or "")
        print(json.dumps(row, indent=1) if a.json else f"{row['unit']} {row['author_type']} model={row.get('model') or '-'}")
        return EXIT_OK
    if a.action == "record":
        files = [x.strip() for x in (a.files or "").split(",") if x.strip()]
        if not files:
            print("record needs --files", file=sys.stderr)
            return EXIT_ERROR
        rows = PV.record_files(p, files, author_type=a.type or "agent", model=a.model, brief_id=a.brief, by=a.by or "agent", note=a.note or "")
        print(json.dumps({"recorded": len(rows), "units": [r["unit"] for r in rows]}, indent=1) if a.json
              else f"recorded {len(rows)} unit(s) as {a.type or 'agent'}")
        return EXIT_OK
    if a.action == "fill":
        if not a.type or not a.by:
            print("fill needs --type and --by", file=sys.stderr)
            return EXIT_ERROR
        if not a.yes and not (sys.stdin.isatty() and input(f"Mark unrecorded units as {a.type}? type 'yes': ").strip() == "yes"):
            print("fill needs a human: run interactively or pass --yes yourself", file=sys.stderr)
            return EXIT_ERROR
        n = PV.fill_missing(p, author_type=a.type, by=a.by, note=a.note or "filled unrecorded units")
        print(f"filled {n} unrecorded unit(s) as {a.type}")
        return EXIT_OK
    print("unknown provenance action", file=sys.stderr)
    return EXIT_ERROR


def cmd_disclosure(a):
    from . import provenance as PV
    p = _proj(a)
    d = PV.draft(p)
    if a.action == "approve":
        if not a.yes and not (sys.stdin.isatty() and input("Approve this AI-use disclosure? type 'yes': ").strip() == "yes"):
            print("approving needs a human: run interactively or pass --yes yourself", file=sys.stderr)
            return EXIT_ERROR
        text = Path(a.file).read_text() if a.file else d["text"]
        row = PV.approve(p, text, by=a.by or "author")
        print(json.dumps({"hash": row["text_hash"], "at": row["recorded_at"]}, indent=1) if a.json
              else f"approved disclosure {row['text_hash'][:12]} at {row['recorded_at']}")
        return EXIT_OK
    if a.out:
        Path(a.out).write_text(d["text"])
        print(f"wrote {a.out}")
        return EXIT_OK
    if a.json:
        print(json.dumps(d, indent=1))
    else:
        print(d["text"], end="")
    return EXIT_OK


def cmd_mcp(a):
    from .mcp_server import serve
    return serve(Path(a.project).resolve())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="ah", description="Academic Harness engine")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_, project=True):
        sp = sub.add_parser(name, help=help_)
        if project:
            sp.add_argument("--project", default=".", help="project directory (default .)")
        sp.add_argument("--json", action="store_true")
        sp.set_defaults(fn=fn)
        return sp

    sp = add("init", cmd_init, "create a project skeleton", project=False)
    sp.add_argument("dir")
    sp.add_argument("--profile", default="generic", help="document type, see `ah profile list`")
    sp = add("profile", cmd_profile, "list profiles or show one", project=False)
    sp.add_argument("action", choices=["list", "show"])
    sp.add_argument("name", nargs="?")
    sp = add("units", cmd_units, "sync unit anchors")
    sp.add_argument("action", choices=["sync", "hashes"])
    sp.add_argument("--check", action="store_true", help="dry run; exit 1 if anchors need changes")
    sp = add("verify-touched", cmd_verify_touched, "advisory T3 on files this prompt changed (never a gate)")
    sp.add_argument("--files", default="", help="comma list of prose files, project- or TeX-relative")
    sp.add_argument("--before", default="", help="JSON object of unit-id -> hash from `ah units hashes` at prompt start")
    add("inventory", cmd_inventory, "counts of units, numbers, citations")
    sp = add("facts", cmd_facts, "build or check facts and the macro file")
    sp.add_argument("action", choices=["build", "check", "list"])
    for name, fn, h in (("check", cmd_check, "run checks, no ledger"), ("audit", cmd_audit, "run checks and reconcile with the ledger")):
        sp = add(name, fn, h)
        sp.add_argument("--tiers", help="comma list from " + ",".join(TIERS))
        sp.add_argument("--limit", type=int, default=25)
        sp.add_argument("--evidence", action="store_true", help="add tier T3: cited claims against the cited sources")
        sp.add_argument("--verify", action="store_true", help="T3 with the model verifier from ah.yaml (costs model calls)")
        sp.add_argument("--no-cache", action="store_true")
        sp.add_argument("--files", help="comma list: report only findings in these files")
        sp.add_argument("--brief", action="store_true", help="compact JSON: gate, counts, open findings")
        sp.add_argument("--limit-claims", type=int, default=0)
        sp.add_argument("--model", help="override verifier.model")
        sp.add_argument("--provider", help="override verifier.provider")
        sp.add_argument("--thinking", default=None, help="override thinking level; empty sends no flag")
        sp.add_argument("--file", action="append", help="only claims in this file (relative to the TeX root)")
        if name == "audit":
            sp.add_argument("--build", action="store_true", help="also compile and parse the log")
            sp.add_argument("--no-ledger", action="store_true")
            sp.add_argument("--det-check", action="store_true", help="DET-01: rebuild twice, compare")
            sp.add_argument("--incremental", action="store_true",
                            help="re-run T3 only on units whose hash changed since the last ledger run")
    sp = add("build", cmd_build, "compile a view and parse the log")
    sp.add_argument("--view")
    sp = add("sweep", cmd_sweep, "list every place a value or fact appears")
    g = sp.add_mutually_exclusive_group(required=True)
    g.add_argument("--value")
    g.add_argument("--fact")
    sp.add_argument("--regex", action="store_true")
    sp = add("finding", cmd_finding, "list, show, waive findings")
    sp.add_argument("action", choices=["list", "show", "waive", "decide"])
    sp.add_argument("fp", nargs="?", default="")
    sp.add_argument("--state")
    sp.add_argument("--by")
    sp.add_argument("--reason")
    sp.add_argument("--forever", action="store_true")
    sp.add_argument("--yes", action="store_true", help="confirm a waiver non-interactively (humans only)")
    add("bind", cmd_bind, "suggest bindings for literal numbers that equal a fact")
    sp = add("eval", cmd_eval_dispatch, "seeded-error, labelled-claim, or T5 style evaluation")
    sp.add_argument("action", choices=["seed", "claims", "style"])
    sp.add_argument("golden", nargs="?", help="for `claims`: golden JSONL (golden/claims_v0.jsonl)")
    sp.add_argument("--only")
    sp.add_argument("--k", type=int, default=3)
    sp.add_argument("--limit", type=int, default=0)
    sp.add_argument("--repeat", type=int, default=1)
    sp.add_argument("--no-model", action="store_true")
    sp.add_argument("--no-cache", action="store_true")
    sp.add_argument("--model", help="override verifier.model for this run")
    sp.add_argument("--provider", help="override verifier.provider for this run")
    sp.add_argument("--thinking", default=None, help="override the thinking level; empty string sends no flag")
    sp.add_argument("--jev", action="store_true", help="also score every (claim, passage) pair with Jev; needs TYPESAFE_API_KEY in the environment")
    sp = add("source", cmd_source, "register, list and search sources")
    sp.add_argument("action", choices=["add", "list", "search"])
    sp.add_argument("path", nargs="?")
    sp.add_argument("--id")
    sp.add_argument("--keys", help="comma-separated citation-key aliases for this source")
    sp.add_argument("--title")
    sp.add_argument("--year", type=int)
    sp.add_argument("--doi")
    sp.add_argument("--kind")
    sp.add_argument("--cls", help="research | context | own")
    sp.add_argument("--tags")
    sp.add_argument("--query", default="")
    sp.add_argument("--k", type=int, default=3)
    from . import cli_author
    ev = add("evidence", cmd_evidence, "exchange evidence ledger rows with PaperMemory")
    ev.add_argument("action", choices=["export", "import-ledger"])
    ev.add_argument("path", nargs="?")
    ev.add_argument("--ledger", action="store_true")
    ev.add_argument("--out")

    sp = add("claims", cli_author.cmd_claims, "cited claims: list, extract sidecars, bind, verify")
    sp.add_argument("action", nargs="?", choices=["list", "extract", "bind", "verify", "show"])
    sp.add_argument("ref", nargs="?")
    sp.add_argument("--limit", type=int, default=40)
    sp.add_argument("--source")
    sp.add_argument("--lines", help="START-END lines of the source text")
    sp.add_argument("--char-span", dest="char_span", help="START-END character offsets (authoritative when set)")
    sp.add_argument("--quote-sha256", dest="quote_sha256")
    sp.add_argument("--raw-sha256", dest="raw_sha256")
    sp.add_argument("--memory-claim", dest="memory_claim")
    sp.add_argument("--auto", action="store_true", help="bind the best retrieved passage")
    sp.add_argument("--fact")
    sp.add_argument("--token")
    sp.add_argument("--by")
    sp.add_argument("--yes", action="store_true", help="confirm for the author (humans only)")
    cli_author.register(sub, add)
    sp = sub.add_parser("hook", help="Claude Code hook handler: reads the event JSON on stdin")
    sp.add_argument("event", choices=["userprompt", "pre", "post", "stop"])
    sp.set_defaults(fn=cmd_hook)
    sp = sub.add_parser("hooks-config", help="print the Claude Code settings block that installs the hooks")
    sp.add_argument("--cmd", default="ah", help='how to run the engine, e.g. "uv run --project /path ah"')
    sp.set_defaults(fn=cmd_hooks_config)
    add("config", cmd_config, "effective configuration for adapters (protected paths, gate, files)")
    sp = add("state", cmd_state, "paper-state card for an agent")
    sp.add_argument("--unit", help="add the brief, neighbours and claims for this unit")
    add("catalogue", cmd_catalogue, "list checks", project=False)
    add("models", cmd_models, "data_policy and verifier backend (local-model mode)")
    sp = add("migrate", cmd_migrate, "overlay ah.yaml on an existing LaTeX tree (dry-run unless --apply)", project=False)
    sp.add_argument("dir", nargs="?", default=".", help="LaTeX project directory")
    sp.add_argument("--profile", help="override the guessed profile")
    sp.add_argument("--dest", help="write the overlay here instead of in-place")
    sp.add_argument("--apply", action="store_true", help="write ah.yaml and scaffold files")
    sp.add_argument("--force", action="store_true", help="overwrite an existing ah.yaml")
    sp.add_argument("--facts", action="store_true", help="propose fact entries for repeated literals")
    sp.add_argument("--bind-facts", action="store_true", help="rewrite repeated literals to \\fact{id} (needs --yes)")
    sp.add_argument("--min-repeats", type=int, default=2)
    sp.add_argument("--legacy-literals", default="info", choices=["info", "minor", "major"],
                    help="NUM-001 level for unbound leftover numbers")
    sp.add_argument("--yes", action="store_true", help="confirm prose rewrites (humans only)")
    sp.add_argument("--no-sync", dest="sync", action="store_false", help="do not run units sync / facts build after apply")
    sp.set_defaults(sync=True)
    sp = add("provenance", cmd_provenance, "who wrote each unit (human/agent/mixed)")
    sp.add_argument("action", choices=["list", "show", "set", "record", "fill"])
    sp.add_argument("unit", nargs="?")
    sp.add_argument("--type", choices=["human", "agent", "mixed", "unknown"])
    sp.add_argument("--model")
    sp.add_argument("--brief")
    sp.add_argument("--by")
    sp.add_argument("--files", help="comma list of prose files for `record`")
    sp.add_argument("--note")
    sp.add_argument("--yes", action="store_true")
    sp = add("disclosure", cmd_disclosure, "draft (or approve) an AI-use statement from provenance")
    sp.add_argument("action", nargs="?", choices=["draft", "approve"], default="draft")
    sp.add_argument("--out", help="write the draft markdown to this file")
    sp.add_argument("--file", help="approve this edited file instead of the fresh draft")
    sp.add_argument("--by")
    sp.add_argument("--yes", action="store_true", help="confirm approval (humans only)")
    add("mcp", cmd_mcp, "stdio MCP server for non-Pi agents (Cursor, Claude Desktop, ...)")
    a = ap.parse_args(argv)
    try:
        return a.fn(a)
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        return EXIT_ERROR
    except Exception as e:
        from .verifier.backends import PolicyError
        if isinstance(e, PolicyError):
            print(f"error: {e}", file=sys.stderr)
            return EXIT_ERROR
        raise


if __name__ == "__main__":
    sys.exit(main())
