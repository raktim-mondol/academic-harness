#!/usr/bin/env python3
"""Scan text for signs of AI writing (Wikipedia:Signs of AI writing, adapted
for general prose and LaTeX). Usage: scan_ai_signs.py FILE_OR_DIR... [--top N]
Masks code/verbatim/math, then reports per-file hit counts and densities."""
import sys, re, os, math
from pathlib import Path

AI_VOCAB = ["delve","delves","delving","tapestry","landscapes","pivotal","crucial",
 "testament","underscores","underscored","showcase","showcases","showcasing",
 "bolster","bolstered","bolsters","garner","garnered","foster","fostering",
 "fosters","vibrant","intricate","intricacies","interplay","meticulous",
 "meticulously","enduring","valuable","robust","seamless","seamlessly",
 "harness","harnessing","leverage","leveraging","multifaceted","realm",
 "realms","embark","unwavering","cornerstone","hallmark","resonates",
 "resonance","elevate","elevating","nuanced","rich tapestry","deep dive",
 "cutting-edge","state-of-the-art","seamless integration","holistic"]
VAGUE_ASSOC = [r"associated with", r"related to\b(?!\s+\w+ of)", r"linked to",
 r"connected to", r"played a (?:\w+ ){0,2}(?:role|part)", r"serves? as a? \w+ bridge"]
WEAK_ATTR = [r"experts? (?:argue|believe|suggest|note)s?", r"studies (?:have )?show",
 r"research (?:has |suggests)", r"it is widely (?:regarded|acknowledged|considered|known)",
 r"many (?:have demonstrated|experts believe|argue that)", r"it is worth noting",
 r"it should be noted", r"one could argue"]
HEDGE = [r"as of\b", r"no reliable sources", r"specific details (?:remain|are) (?:scarce|limited|unavailable)",
 r"not(?:ever)?? documented", r"remains unclear", r"continues to (?:evolve|develop|expand)",
 r"evolved significantly", r"in the ever-evolving", r"the world of \w+ is a dynamic"]
ING_TAIL = r", (?:being|highlighting|showcasing|reflecting|ensuring|demonstrating|underscoring|emphasizing|fostering|garnering|making|having|signaling|reinforcing|marking|representing|symbolizing|indicating)\b"
NEG_PARALLEL = [r"not only\b.{0,120}\bbut also", r"not just\b.{0,120}\bbut\b",
 r"it(?:'| is)? is not (?:just|merely|only)\b", r"more than just\b",
 r"not because\b.{0,80}but because", r"rather than\b[^.]{0,60}\b(?:but|is)\b",
 r"this isn't just\b", r"that's not (?:all|to say)"]
COPULA_AVOID = [r"serves? as\b", r"stands as\b", r"\brepresents?\b", r"\bconstitutes?\b",
 r"\bmarks?\b", r"functions? as\b"]
CHALLENGE_HDR = r"(challenges? and|future) (directions?|prospects?|outlook)|challenges? and opportunities"
FORMULAIC_HDR = r"\b(legacy and|impact and legacy|cultural significance|modern day relevance)\b"

def mask(t, is_tex):
    if is_tex:
        t = re.sub(r"\\begin\{(lstlisting|verbatim|minted|align|equation|gather|displaymath)\*?\}.*?\\end\{\1\*?\}", " ", t, flags=re.S)
        t = re.sub(r"\$\$.*?\$\$", " ", t, flags=re.S)
        t = re.sub(r"(?<!\\)\$[^$\n]*(?<!\\)\$", " ", t)
        t = re.sub(r"\\(?:index|label|ref|eqref|cite[tp]?|chapref|input|include|usepackage|graphicspath|hypersetup|pdfbookmark)\{[^{}]*\}", " ", t)
        t = re.sub(r"(?<!\\)%.*", " ", t)
    else:
        t = re.sub(r"```.*?```", " ", t, flags=re.S)
        t = re.sub(r"`[^`\n]*`", " ", t)
    return t

def scan(path, top):
    raw = Path(path).read_text(encoding="utf-8", errors="replace")
    is_tex = path.suffix == ".tex"
    lines = raw.split("\n")
    t = mask(raw, is_tex)
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", t)
    n = max(len(words), 1)
    k = n / 1000.0
    em = len(re.findall(r"(?:---|\u2014|\u2013)", t))
    sents = [s for s in re.split(r"[.!?]+[\n ]+", t) if len(s.split()) > 2]
    lens = [len(s.split()) for s in sents] or [0]
    mean = sum(lens)/len(lens); sd = math.sqrt(sum((x-mean)**2 for x in lens)/len(lens))
    groups = []
    def add(name, hits):
        if hits: groups.append((name, len(hits), [str(h) for h in hits[:top]]))
    vh = [(m.start(), m.group(0)) for w in AI_VOCAB for m in re.finditer(rf"\b{re.escape(w)}\b", t, re.I)]
    add("AI-vocabulary", [w for _, w in sorted(vh)])
    for nm, pats in [("vague-association", VAGUE_ASSOC), ("weak-attribution", WEAK_ATTR),
                     ("hedging-boilerplate", HEDGE), ("negative-parallelism", NEG_PARALLEL),
                     ("copula-avoidance", COPULA_AVOID)]:
        hits = [m.group(0) for p in pats for m in re.finditer(p, t, re.I)]
        add(nm, hits)
    add("superficial-ing-clause", [m.group(0).strip() for m in re.finditer(ING_TAIL, t, re.I)])
    add("rule-of-three-triples", [m.group(0) for m in re.finditer(r"\b\w+ly, \w+ly, (?:and|or) \w+ly\b", t)] +
        [m.group(0) for m in re.finditer(r"\b[a-z]{3,14}, [a-z]{3,14}, and [a-z]{3,14}\b", t)])
    add("formulaic-heading", [m.group(0) for m in re.finditer(CHALLENGE_HDR, t, re.I)] + [m.group(0) for m in re.finditer(FORMULAIC_HDR, t, re.I)])
    if is_tex:
        add("markdown-bold-in-tex", re.findall(r"\*\*[^*\n]+\*\*", t))
    else:
        add("inline-header-list", re.findall(r"^\s*[-*]?\s*\*\*[^*\n]{2,40}:\*\*", t, re.M))
    curly = len(re.findall(r"[\u201c\u201d\u2018\u2019]", t))
    if is_tex and curly: add("curly-quotes-in-tex", ["x"]*curly)
    emoji = re.findall(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", t)
    if emoji: add("emoji", emoji)

    def lines_for(tok):
        out = []
        pat = re.compile(re.escape(tok), re.I)
        for i, l in enumerate(lines, 1):
            if pat.search(l): out.append(i)
            if len(out) >= top: break
        return out
    print(f"\n=== {path}  ({n/1000:.1f}k words | em-dashes {em/k:.1f}/k | sentence length mean {mean:.1f} sd {sd:.1f})")
    if not groups:
        print("  no pattern hits"); return
    for name, cnt, samples in sorted(groups, key=lambda g: -g[1]):
        uniq = sorted(set(map(str, samples)))
        ln = lines_for(uniq[0][:60]) if uniq else []
        print(f"  {name}: {cnt} ({cnt/k:.1f}/k)  e.g. {uniq[0][:60]!r} line(s) {ln[:3]}")
    if sd < 5.5 and len(lens) > 20:
        print("  NOTE: low sentence-length variation (uniform rhythm, an LLM tell)")

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    top = 3
    for a in sys.argv[1:]:
        if a.startswith("--top"): top = int(a.split("=")[-1].replace("--top","").strip() or 3) if "=" in a else top
    if "--top" in sys.argv:
        i = sys.argv.index("--top")
        if i+1 < len(sys.argv) and sys.argv[i+1].isdigit(): top = int(sys.argv[i+1]); args = [a for a in args if a != sys.argv[i+1]]
    files = []
    for a in args:
        p = Path(a)
        files += sorted(p.rglob("*.tex")) if p.is_dir() else [p] if p.exists() else []
        if not p.exists(): print(f"skip (missing): {a}")
    for f in files: scan(f, top)
    print(f"\nscanned {len(files)} file(s)")

main()
