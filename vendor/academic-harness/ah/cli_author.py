"""Authoring commands: briefs, packs, claim bindings, snapshots, reviews, fact proposals (design 8)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

from . import briefs as B
from . import claim_sidecar as CS
from . import plan as PL
from . import promote as PM
from . import proposals as PR
from . import reviews as RV
from . import snapshots as SN
from .context import build_context
from .project import Project

OK, FINDINGS, ERR = 0, 1, 2


def _p(a) -> Project:
    return Project(a.project)


def human(a, what: str) -> bool:
    """Approving, verifying, accepting and declining are the author's acts: they need --yes typed by a person, or a terminal."""
    if getattr(a, "yes", False):
        return True
    if sys.stdin.isatty():
        return input(f"{what}. Type 'yes' to confirm: ").strip() == "yes"
    print(f"{what}: this needs a human. Run it interactively, or pass --yes yourself.", file=sys.stderr)
    return False


def _load_json_arg(a) -> dict:
    if getattr(a, "json_arg", None):
        return json.loads(a.json_arg)
    if getattr(a, "spec_file", None):
        return yaml.safe_load(Path(a.spec_file).read_text())
    raise ValueError("give the content with --data '<json>' or --spec-file F")


# ---------------- brief / pack ----------------
def cmd_brief(a):
    p = _p(a)
    try:
        if a.action == "new":
            b = B.new_brief(p, _load_json_arg(a))
            print(f"created draft brief {b.id} for {b.data.get('unit') or b.data.get('file')}; the author approves it with `ah brief approve {b.id}`")
        elif a.action == "list":
            for b in B.load_briefs(p):
                print(f"{b.id:24} {b.data.get('status', 'draft'):9} {b.data.get('unit') or b.data.get('file')}  {str(b.data.get('purpose', ''))[:60]}")
        elif a.action == "show":
            b = B.get_brief(p, a.id)
            print(yaml.safe_dump(b.data, sort_keys=False, allow_unicode=True) if b else f"no brief {a.id}")
        elif a.action == "check":
            ctx = build_context(p)
            n = 0
            for b in ([B.get_brief(p, a.id)] if a.id else B.load_briefs(p)):
                for d in B.check_brief(ctx, b):
                    n += 1
                    print(f"{d['check']:7} {d['level']:6} {d['message']}")
            print(f"{n} finding(s)")
            return FINDINGS if n else OK
        elif a.action == "approve":
            if not human(a, f"Approve brief {a.id}"):
                return ERR
            B.approve(p, a.id)
            print(f"approved {a.id}")
    except (ValueError, KeyError, AttributeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


def cmd_pack(a):
    p = _p(a)
    ctx = build_context(p)
    b = B.get_brief(p, a.target)
    print(B.pack(ctx, b, None if b else a.target))
    return OK


# ---------------- claims ----------------
def cmd_claims(a):
    p = _p(a)
    ctx = build_context(p)
    act = a.action or "list"
    try:
        if act == "list":
            from .claims import extract_claims
            from collections import Counter
            cl = extract_claims(ctx)
            if a.json:
                print(json.dumps([c.__dict__ for c in cl], indent=1))
            else:
                for c in cl[: a.limit]:
                    print(f"{c.id} {c.kind:13} {c.unit:28} {','.join(c.cites)[:40]:40} {c.sentence[:90]}")
                print(f"{len(cl)} claims: {dict(Counter(c.kind for c in cl))}")
        elif act == "extract":
            print(json.dumps(CS.sync(ctx, write=True)))
        elif act == "show":
            uid, sc, rec = CS.find_claim(p, a.ref)
            print(yaml.safe_dump({"unit": uid, **rec}, sort_keys=False, allow_unicode=True))
        elif act == "bind":
            if a.fact:
                print(json.dumps(CS.bind_fact(ctx, a.ref, a.token, a.fact)))
            elif a.auto:
                from .sources.index import Index
                from .sources.registry import doi_index, load_registry, resolve_all, source_map
                uid, sc, rec = CS.find_claim(p, a.ref)
                key = a.source or rec["cites"][0]
                paths = resolve_all(p, key, load_registry(p), source_map(p), ctx.bib, doi_index(p))
                if not paths:
                    raise ValueError(f"no source text for {key}")
                idx = Index(p)
                idx.ensure(key, paths)
                hit = (idx.search([key], rec["clause"], 1) or [None])[0]
                if hit is None:
                    raise ValueError("no passage matches the clause")
                fi = next((i for i, x in enumerate(paths) if hit.file and x.stem == hit.file), 0)
                print(json.dumps({k: v for k, v in CS.bind_passage(ctx, a.ref, key, hit.start, hit.end, fi).items() if k != "quote"}))
            else:
                s, _, e = (a.lines or "").partition("-")
                print(json.dumps({k: v for k, v in CS.bind_passage(ctx, a.ref, a.source, int(s), int(e or s)).items() if k != "quote"}))
        elif act == "verify":
            if not human(a, f"Verify claim {a.ref} as supported as written"):
                return ERR
            print(json.dumps({k: v for k, v in CS.verify(p, a.ref, a.by or "author").items() if k in ("id", "status", "verified_by")}))
    except (ValueError, KeyError, TypeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


# ---------------- snapshots ----------------
def cmd_snapshot(a):
    p = _p(a)
    ctx = build_context(p)
    try:
        if a.action == "save":
            print(json.dumps(SN.save(ctx, a.name, overwrite=a.force)))
        elif a.action == "list":
            print("\n".join(SN.names(p)) or "(none)")
        elif a.action == "diff":
            d = SN.diff(ctx, a.name)
            if a.json:
                print(json.dumps(d, indent=1))
            else:
                print(f"vs {a.name}: {len(d['changed'])} changed, {len(d['added'])} added, {len(d['removed'])} removed")
                for c in d["changed"]:
                    print(f"- {c['unit']} ({c['file']}): {c['diff'][:300]}")
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


# ---------------- reviews ----------------
def cmd_review(a):
    p = _p(a)
    ctx = build_context(p)
    try:
        if a.action == "import":
            rev = RV.import_review(ctx, Path(a.file), a.id)
            print(f"imported {len(rev['items'])} item(s) as review {a.id}; snapshot {rev['snapshot']}")
            try:                         # which comments the checks already know about; never blocks the import
                rows = triage_items(p, ctx, [{"id": it["id"], "text": it["text"]} for it in rev["items"]])
                RV.record_coverage(p, a.id, rows)
                tags = {r["id"]: r["tag"] for r in rows}
            except Exception:
                tags = {}
            for it in rev["items"]:
                print(f"  {it['id']} ({it['kind']}): {it['text'][:90]}" + (f"  [{tags[it['id']]}]" if tags.get(it["id"]) else ""))
        elif a.action == "list":
            for rev in ([RV.load_review(p, a.id)] if a.id else RV.load_all(p)):
                for it in rev["items"]:
                    print(f"{it['id']:8} {it['status']:15} {it['kind']:6} units={','.join(it.get('units') or []) or '-':30} {it['text'][:70]}"
                          + (f"  [{it['coverage']}]" if it.get("coverage") else ""))
        elif a.action == "show":
            print(yaml.safe_dump(RV.load_review(p, a.id), sort_keys=False, allow_unicode=True))
        elif a.action == "set":
            if a.status == "declined" and not human(a, f"Decline review item {a.id}"):
                return ERR
            it = RV.set_item(p, a.id, a.units.split(",") if a.units is not None else None, a.status, a.response)
            print(json.dumps({k: it[k] for k in ("id", "status", "units")}))
        elif a.action == "check":
            rev = RV.load_review(p, a.id)
            ds = RV.check_review(ctx, rev)
            for d in ds:
                print(f"{d['check']:7} {d['level']:6} {d['message']}")
            blocking = [d for d in ds if d["level"] in ("blocker", "major")]
            print(f"{len(ds)} finding(s), {len(blocking)} blocking")
            return FINDINGS if blocking else OK
        elif a.action == "respond":
            rev = RV.load_review(p, a.id)
            blocking = [d for d in RV.check_review(ctx, rev) if d["level"] in ("blocker", "major")]
            text = RV.letter(ctx, rev, a.format)
            out = Path(a.out) if a.out else p.root / p.cfg["reviews"] / f"{a.id}_response.{'md' if a.format == 'md' else 'tex'}"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text)
            print(f"wrote {out} ({len(rev['items'])} items)")
            for d in blocking:
                print(f"  {d['check']}: {d['message']}")
            return FINDINGS if blocking else OK
    except (ValueError, AttributeError, TypeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


# ---------------- proposals ----------------
# ---------------- plan (design 8.1) ----------------
def cmd_plan(a):
    p = _p(a)
    try:
        if a.action == "new":
            ol = PL.new_outline(p, _load_json_arg(a))
            print(f"created draft outline in {p.cfg['outline']}; propose further changes with `ah plan propose`, approve with `ah plan approve`")
            if a.json:
                print(yaml.safe_dump(ol, sort_keys=False, allow_unicode=True))
        elif a.action == "show":
            from .outline import load_outline
            ol = load_outline(p)
            pending = [r for r in PL.load_proposals(p) if r.get("status") == "pending"]
            if a.json:
                print(json.dumps({"outline": ol, "pending": [r.get("id") for r in pending]}, indent=1, default=str))
            else:
                print(f"status: {ol.get('status') or 'legacy'}")
                if ol.get("thesis"):
                    print(f"thesis: {ol['thesis']}")
                for s in ol.get("sections") or []:
                    flag = " planned" if s.get("planned") else ""
                    print(f"section {s.get('file')}{flag}: {s.get('purpose', '')}")
                for c in ol.get("claims") or []:
                    print(f"claim {c.get('id')}: supports={c.get('supports') or []} units={c.get('units') or []}")
                if pending:
                    print("pending proposals: " + ", ".join(r["id"] for r in pending))
        elif a.action == "list":
            rows = PL.load_proposals(p)
            if not rows:
                print("(none)")
            for r in rows:
                print(f"{r.get('id', '?'):24} {r.get('status', '?'):9}")
        elif a.action == "check":
            from .outline import check_outline
            ctx = build_context(p)
            ds = check_outline(ctx) + PL.check_plan(ctx)
            for d in ds:
                print(f"{d['check']:7} {d['level']:6} {d['message']}")
            print(f"{len(ds)} finding(s)")
            return FINDINGS if any(d["level"] in ("blocker", "major") for d in ds) else OK
        elif a.action == "propose":
            rec = PL.propose(p, _load_json_arg(a))
            print(f"proposed plan {rec['id']}; the author approves it with `ah plan approve {rec['id']}`. Do not write prose yet.")
        elif a.action == "diff":
            if not a.id:
                raise ValueError("diff needs a proposal id")
            print(PL.diff_text(p, a.id))
        elif a.action == "approve":
            if not a.id:
                raise ValueError("approve needs a proposal id")
            if not human(a, f"Approve outline plan {a.id}"):
                return ERR
            PL.approve(p, a.id)
            print(f"approved {a.id}; outline.yaml is locked")
    except (ValueError, KeyError, AttributeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


def cmd_propose(a):
    p = _p(a)
    try:
        entry = _load_json_arg(a)
        r = PR.propose(p, entry, a.why or "", by="agent")
        print(f"proposed fact {r['id']}; it computes to {r['computed']}. The author accepts it with `ah proposals accept {r['id']}`.")
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


def cmd_proposals(a):
    p = _p(a)
    try:
        if a.action == "list":
            for r in PR.list_pending(p):
                print(f"{r['proposal']['id']:22} {r['proposal']['kind']:11} computes {json.dumps(r['computed'])[:80]}  why: {r.get('why', '')[:60]}")
        elif a.action == "show":
            print(yaml.safe_dump(next(r for r in PR.list_pending(p) if r["proposal"]["id"] == a.id), sort_keys=False, allow_unicode=True))
        elif a.action == "accept":
            if not human(a, f"Accept fact proposal {a.id} into facts.yaml"):
                return ERR
            e = PR.accept(p, a.id)
            from .facts.model import build_facts
            from .facts.render import write_build
            fs, errs = build_facts(p)
            if not errs:
                write_build(p, fs)
            print(f"accepted {e['id']}; facts rebuilt" + (f" (errors: {errs})" if errs else ""))
        elif a.action == "reject":
            if not human(a, f"Reject fact proposal {a.id}"):
                return ERR
            PR.reject(p, a.id)
            print(f"rejected {a.id}")
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


# ---------------- promote a review comment to a rule ----------------
def _current_findings(p: Project) -> list[dict]:
    """What the checks report now: the code tiers, plus the open findings the ledger holds for the external and rubric tiers."""
    from .audit import audit
    rows = [dict(f, fingerprint=f["fingerprint"]) for f in audit(p, use_ledger=False)["findings"]]
    db = p.state_dir / "ledger.sqlite"
    if db.exists():
        from .ledger.db import Ledger
        led = Ledger(p)
        try:
            for r in led.list(("open", "decision-needed")):
                if r["tier"] in ("TX", "TR"):
                    rows.append({"check": r["check_id"], "level": r["level"], "unit": r["ref"], "state": r["state"],
                                 "message": r["message"], "fingerprint": r["fp"]})
        finally:
            led.close()
    return rows


def triage_items(p: Project, ctx, comments: list[dict]) -> list[dict]:
    return PM.triage(ctx, comments, _current_findings(p))


def cmd_rule(a):
    p = _p(a)
    try:
        if a.action == "propose":
            r = PM.propose(build_context(p), _load_json_arg(a), by="agent")
            if r["kind"] == "pattern":
                print(f"proposed rule {r['id']}: it fires on {r['fires_on_units']} unit(s) now"
                      + "".join(f"\n  {h['unit']}: \"{h['match']}\"" for h in r["fires_now"]))
            else:
                print(f"proposed criterion {r['id']} (example in {r['example_unit']})")
            print(f"The author accepts it with `ah rule accept {r['id']}`. Until then it checks nothing.")
        elif a.action == "list":
            rows = PM.list_pending(p)
            for r in rows:
                body = r.get("rule") or r.get("criterion") or {}
                print(f"{r['id']:24} {r['kind']:10} {str(body.get('pattern') or body.get('question'))[:70]}")
            if not rows:
                print("(none pending)")
        elif a.action == "show":
            print(yaml.safe_dump(next(r for r in PM.list_pending(p) if r["id"] == a.id), sort_keys=False, allow_unicode=True))
        elif a.action == "accept":
            if not a.id:
                raise PM.PromoteError("accept needs a rule id")
            if not human(a, f"Accept rule {a.id} into the project's checks"):
                return ERR
            r = PM.accept(build_context(p), a.id)
            print(f"accepted {r['id']} into {r['file']}; it is checked on every run from now on")
        elif a.action == "reject":
            if not human(a, f"Reject rule proposal {a.id}"):
                return ERR
            PM.reject(p, a.id)
            print(f"rejected {a.id}")
        elif a.action == "test":
            rules, problems = PM.load_rules(p)
            ctx = build_context(p)
            for key, msg in problems:
                print(f"PRM-02 {msg}")
            for rule in rules:
                rx, bad = PM.check_rule(rule)
                fire = PM.firing(ctx, rule, rx)
                print(f"{rule['id']:24} fixtures ok, fires on {len({r for r, _ in fire})} unit(s)")
            print(f"{len(rules)} promoted rule(s), {len(problems)} problem(s)")
            return FINDINGS if problems else OK
    except StopIteration:
        print(f"error: no pending proposal '{a.id}'", file=sys.stderr)
        return ERR
    except (PM.PromoteError, ValueError, KeyError, TypeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


def cmd_triage(a):
    """Tag review comments as covered-by:<rule>, same-unit:<rule> or exploratory. Reads nothing from a model."""
    p = _p(a)
    try:
        ctx = build_context(p)
        if a.review:
            rev = RV.load_review(p, a.review)
            if rev is None:
                raise ValueError(f"no review '{a.review}'")
            comments = [{"id": it["id"], "text": it["text"], "units": it.get("units") or []} for it in rev["items"]]
        else:
            data = _load_json_arg(a)
            comments = data if isinstance(data, list) else data.get("comments") or []
        rows = triage_items(p, ctx, comments)
        if a.review and a.write:
            RV.record_coverage(p, a.review, rows)
        if a.json:
            print(json.dumps({"comments": rows, "summary": PM.summarize(rows)}, indent=1))
        else:
            for r in rows:
                print(f"{str(r['id']):12} {r['tag']}" + ("" if r["located"] else "  (could not find the passage)"))
            s = PM.summarize(rows)
            print(f"{s['comments']} comment(s): {s['covered']} covered, {s['same-unit']} same-unit, {s['exploratory']} exploratory ({s['unlocated']} unlocated)")
    except (PM.PromoteError, ValueError, KeyError, TypeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return ERR
    return OK


def register(sub, add):
    sp = add("brief", cmd_brief, "briefs: what a unit must do")
    sp.add_argument("action", choices=["new", "list", "show", "check", "approve"])
    sp.add_argument("id", nargs="?")
    sp.add_argument("--data", dest="json_arg")
    sp.add_argument("--spec-file")
    sp.add_argument("--yes", action="store_true", help="confirm for the author (humans only)")
    sp = add("pack", cmd_pack, "evidence pack for a brief or unit")
    sp.add_argument("target")
    sp = add("snapshot", cmd_snapshot, "save a snapshot of unit text, or diff against one")
    sp.add_argument("action", choices=["save", "diff", "list"])
    sp.add_argument("name", nargs="?")
    sp.add_argument("--force", action="store_true")
    sp = add("review", cmd_review, "reviewer comments and the response letter")
    sp.add_argument("action", choices=["import", "list", "show", "set", "check", "respond"])
    sp.add_argument("id", nargs="?", help="review id (import: --id), item id for set")
    sp.add_argument("--file")
    sp.add_argument("--units")
    sp.add_argument("--status")
    sp.add_argument("--response")
    sp.add_argument("--format", choices=["md", "tex"], default="md")
    sp.add_argument("--out")
    sp.add_argument("--yes", action="store_true")
    sp = add("plan", cmd_plan, "outline plan: propose, then the author approves")
    sp.add_argument("action", choices=["new", "show", "list", "check", "propose", "diff", "approve"])
    sp.add_argument("id", nargs="?")
    sp.add_argument("--data", dest="json_arg")
    sp.add_argument("--spec-file")
    sp.add_argument("--yes", action="store_true", help="confirm for the author (humans only)")
    sp = add("propose", cmd_propose, "propose a new fact (the author accepts it)")
    sp.add_argument("--data", dest="json_arg")
    sp.add_argument("--spec-file")
    sp.add_argument("--why")
    sp = add("proposals", cmd_proposals, "pending fact proposals")
    sp.add_argument("action", choices=["list", "show", "accept", "reject"])
    sp.add_argument("id", nargs="?")
    sp.add_argument("--yes", action="store_true")
    sp = add("rule", cmd_rule, "promote a review comment to a rule the checks run every time (the author accepts it)")
    sp.add_argument("action", choices=["propose", "list", "show", "accept", "reject", "test"])
    sp.add_argument("id", nargs="?")
    sp.add_argument("--data", dest="json_arg")
    sp.add_argument("--spec-file")
    sp.add_argument("--yes", action="store_true")
    sp = add("triage", cmd_triage, "tag review comments: already covered by a rule, or exploratory")
    sp.add_argument("--data", dest="json_arg", help="JSON list of {id, text, quote}")
    sp.add_argument("--spec-file")
    sp.add_argument("--review", help="an imported review id instead of --data")
    sp.add_argument("--write", action="store_true", help="store the tag on each review item")
