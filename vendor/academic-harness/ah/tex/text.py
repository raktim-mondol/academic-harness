"""Low-level LaTeX text helpers: comments, environments, sentences, prose view.

Deliberately small. It is not a TeX engine. Constructs it cannot classify are reported as
unparsed by the callers, never silently skipped (design 11.3).
"""
from __future__ import annotations

import re

# The citation, reference, label and input patterns live in scan.py with the rest of the scanner; they are re-exported here because most
# of the engine imports them from this module. Read their matches through scan.cite_keys / ref_labels / inputs, not group(1).
from .scan import RE_CITE, RE_INPUT, RE_LABEL, RE_NOCITE, RE_REF, cite_keys, drop_dead_blocks, ref_labels  # noqa: F401

FLOAT_ENVS = ("figure", "figure*", "table", "table*", "longtable", "tikzpicture", "tabularx",
              "tabular", "algorithm", "lstlisting", "verbatim")
DISPLAY_ENVS = ("equation", "equation*", "align", "align*", "gather", "gather*")
HEADING_CMDS = r"(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?"

RE_COMMENT = re.compile(r"(?<!\\)%.*$", re.M)
RE_FACT = re.compile(r"\\fact\{([^}]*)\}")
RE_ANCHOR = re.compile(r"^\s*%%\s*@unit\s+(\S+)(?:\s+h=([0-9a-f]+))?\s*$")


def strip_comments(text: str) -> str:
    """Remove % comments and what TeX never reads (the dead branch of \\iffalse / \\iftrue, the comment environment), but keep every
    newline, so line numbers still match the source. Verbatim text is left in: it is typeset, so it stays a unit."""
    return drop_dead_blocks(RE_COMMENT.sub("", text))


def find_envs(text: str, names=FLOAT_ENVS + DISPLAY_ENVS):
    """Outermost environments of the given names as (name, start, end) character spans."""
    found = []
    pat = re.compile(r"\\begin\{(" + "|".join(re.escape(n) for n in names) + r")\}")
    for m in pat.finditer(text):
        end = re.compile(r"\\end\{" + re.escape(m.group(1)) + r"\}").search(text, m.end())
        if end:
            found.append((m.group(1), m.start(), end.end()))
    found.sort(key=lambda e: e[1])
    out = []
    for e in found:
        if out and e[1] < out[-1][2]:
            continue
        out.append(e)
    return out


def mask_ranges(text: str, ranges) -> str:
    chars = list(text)
    for _name, a, b in ranges:
        for i in range(a, b):
            if chars[i] != "\n":
                chars[i] = " "
    return "".join(chars)


def split_paragraphs(masked: str):
    """Blank-line separated runs of a masked, comment-stripped text.

    Returns [(start_line, end_line, text)]. A run-in heading, \\item or sectioning command
    starts a new run, so one unit is one rhetorical piece (design 4.2 LAT-03).
    """
    out, cur, start = [], [], None

    def flush(end_line):
        nonlocal cur, start
        if cur:
            out.append((start, end_line, "\n".join(cur)))
        cur, start = [], None

    lines = masked.split("\n")
    for i, line in enumerate(lines, 1):
        if line.strip():
            if cur and re.match(r"\s*\\(?:paragraph|subparagraph|item|section|subsection|subsubsection)\b", line):
                flush(i - 1)
            if start is None:
                start = i
            cur.append(line)
        else:
            flush(i - 1)
    flush(len(lines))
    return out


def is_structure_only(p: str) -> bool:
    q = re.sub(r"\\" + HEADING_CMDS + r"\{[^}]*\}", "", p)
    q = re.sub(r"\\(?:label|input|include|clearpage|newpage|FloatBarrier|noindent|appendix)\{?[^}\n]*\}?", "", q)
    q = re.sub(r"\\(?:begin|end)\{(?:itemize|enumerate|description)\}(?:\[[^\]]*\])?", "", q)
    return not re.sub(r"\s+", "", q)


def prose_view(s: str) -> str:
    """Text a reader sees, roughly: cite/ref/label/fact arguments and commands removed."""
    s = RE_CITE.sub(" ", s)
    s = RE_REF.sub(" ", s)
    s = RE_LABEL.sub(" ", s)
    s = RE_FACT.sub(" ", s)
    s = re.sub(r"\\(?:url|href|doi)\{[^}]*\}", " ", s)
    s = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?", " ", s)
    s = s.replace("{,}", ",").replace("\\,", "").replace("~", " ")
    s = re.sub(r"[{}]", "", s)
    return s


def word_count(p: str) -> int:
    return len(re.findall(r"[A-Za-z]{2,}", prose_view(p)))


def sentences(p: str) -> list[str]:
    flat = re.sub(r"\s+", " ", p)
    flat = re.sub(r"(\d)\.(\d)", r"\1<dot>\2", flat)
    flat = re.sub(r"\b(et~?al|e\.g|i\.e|vs|Fig|Tab|Eq|approx|cf)\.", r"\1<dot>", flat)
    parts = re.split(r"(?<=[.!?])(?:\s+|$)", flat)
    return [x.replace("<dot>", ".").strip() for x in parts if x.strip()]
