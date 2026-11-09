"""The free-review path with a real model: two independent reviews, triage, a rule proposed from one comment, the author accepts it, a repair.

Phase 5 of the writing compiler says a free review is exploratory (it finds something different every time), that triage tells which comments a check
already covers, and that a recurring comment can become a rule only after the author accepts it. This drives that path with Claude as the reviewer,
through the real `ah` commands. The reviewer here is `claude -p` on the section text, not DSH's `deep_review` tool.

    python3 review_path.py <project-copy> [--model claude-sonnet-5-5]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from config import ENGINE, SHIM  # noqa: E402

sys.path.insert(0, str(ENGINE))
from ah.context import build_context  # noqa: E402
from ah.project import Project  # noqa: E402
from ah.promote import reader_text, words  # noqa: E402
from ah.verifier.claude import command, parse_result  # noqa: E402


def ask(model: str, prompt: str) -> str:
    p = subprocess.run(command(model, 0.5, None), input=prompt, capture_output=True, text=True, timeout=240)
    text, _ = parse_result(p.stdout, model)
    return text


def json_of(text: str):
    m = re.search(r"(\[.*\]|\{.*\})", text, re.S)
    return json.loads(m.group(1))


def ah(root: Path, *args: str, stdin: str | None = None) -> tuple[int, str]:
    p = subprocess.run([str(SHIM), *args, "--project", str(root)], capture_output=True, text=True, input=stdin)
    return p.returncode, (p.stdout + p.stderr).strip()


def review(model: str, paragraphs: list[tuple[str, str]], n: int = 6) -> list[dict]:
    body = "\n\n".join(f"[{uid}] {t}" for uid, t in paragraphs)
    out = ask(model, "You are a critical reviewer of part of a scientific proposal. Below are numbered paragraphs, each with its id in brackets.\n"
              f"Write up to {n} specific review comments about wording: overclaiming, missing qualification, vagueness, unsupported superlatives, hedging. "
              "For each give `id` (c1, c2, ...), `text` (one or two sentences) and `quote`: an exact phrase of at least 40 characters copied verbatim from ONE "
              "paragraph that the comment is about. Reply with only a JSON list.\n\n" + body)
    got = json_of(out)
    return [{"id": str(c["id"]), "text": str(c["text"]), "quote": str(c["quote"])} for c in got if isinstance(c, dict) and {"id", "text", "quote"} <= set(c)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--model", default="claude-sonnet-5-5")
    a = ap.parse_args()
    root = Path(a.project).resolve()
    ctx = build_context(Project(str(root)))
    paras = [(u.uid or u.file, reader_text(u.norm)) for u in ctx.units if u.kind == "para" and 35 <= u.words <= 140][:14]
    print(f"{len(paras)} paragraphs sent to each reviewer")
    reviews = [review(a.model, paras), review(a.model, paras)]
    flat = [words(p) for _, p in paras]
    found = [[c for c in rv if any(words(c["quote"]) in t for t in flat)] for rv in reviews]
    units = [{next((uid for (uid, _), t in zip(paras, flat) if words(c["quote"]) in t), None) for c in f} for f in found]
    print(f"review A: {len(reviews[0])} comments ({len(found[0])} quote real text) on {len(units[0])} paragraphs; review B: {len(reviews[1])} ({len(found[1])}) on {len(units[1])}")
    print(f"  same paragraph in both: {len(units[0] & units[1])}; same quote in both: {len({words(c['quote']) for c in found[0]} & {words(c['quote']) for c in found[1]})}")
    for tag, f in zip("AB", found):
        code, out = ah(root, "triage", "--json", "--data", json.dumps(f))
        print(f"  triage {tag}: {json.loads(out)['summary']}" if code == 0 else f"  triage {tag} failed: {out[:160]}")
    # one comment becomes a rule
    pick = found[0][0]
    print(f"\ncomment: {pick['text']}\nquote:   {pick['quote']}")
    spec_text = ask(a.model, "A review comment and the exact words it is about are below. If, and only if, a program can recognise this problem without judgement, "
                    "propose a rule as a JSON object with keys: `id` (PRM-<NAME>), `kind`: \"pattern\", `comment`, `span` (the quote), `why` (why a program can decide it), "
                    "`pattern` (a Python regular expression over the text a reader sees, specific, not matching empty text), `flags`: \"i\", `message`, `level`: \"info\", "
                    "`negatives` (a list of 2 plain sentences the pattern must NOT match). Reply with only the JSON object.\n\n"
                    f"COMMENT: {pick['text']}\nSPAN: {pick['quote']}")
    spec = json_of(spec_text)
    spec["comment"], spec["span"] = pick["text"], pick["quote"]
    print("proposed:", json.dumps({k: spec[k] for k in ("id", "pattern", "message") if k in spec}))
    code, out = ah(root, "rule", "propose", "--json", "--data", json.dumps(spec))
    print(f"propose exit {code}: {out[:600]}")
    if code != 0:
        print("the engine refused the proposal, which is a valid outcome; nothing is accepted")
        return 0
    rid = spec["id"]
    code, out = ah(root, "rule", "accept", rid)
    print(f"agent-style accept without --yes: exit {code}: {out[:140]}")
    code, out = ah(root, "rule", "accept", rid, "--yes")
    print(f"author accepts: exit {code}: {out[:140]}")
    code, out = ah(root, "check", "--json")
    prm = [f for f in json.loads(out)["findings"] if f["check"] == "PRM-01"] if code in (0, 1) else []
    print(f"PRM-01 findings now: {len(prm)}")
    code, out = ah(root, "triage", "--json", "--data", json.dumps([pick]))
    print("the original comment is now:", json.loads(out)["comments"][0]["tag"])
    if prm:
        f = prm[0]
        print("repair: reword the first flagged sentence, audit twice")
        path = next(p for p in root.rglob(Path(f["file"]).name) if p.is_file())
        text = path.read_text()
        m = re.search(spec["pattern"], text, re.I)
        if m:
            path.write_text(text[:m.start()] + "(reworded)" + text[m.end():])
            for _ in range(2):
                code, out = ah(root, "audit", "--json")
            rep = json.loads(out)
            print("after repair: PRM-01", sum(f["check"] == "PRM-01" for f in rep["findings"]), "| unexplained:", rep.get("unexplained"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
