"""What TeX actually executes, and every citation, reference, label and input in it (design 11.3).

The static scanner is not a TeX engine. It reads the commands authors really write, checked against real LaTeX (the differential lab in
tests/test_tex_oracle.py compiles each case and compares). What it cannot classify it reports as unresolved; it never skips silently.

  markup_view(text)   the text with everything TeX never executes as markup removed (line numbers kept):
                      % comments, \\iffalse blocks and the dead branch of \\iftrue, the comment environment, the bodies of verbatim,
                      lstlisting, minted and similar environments, and \\verb. The opening line of a listing stays: its options can hold
                      label=... and a caption with citations.
  cites / nocites / refs / labels / inputs    positioned results from a markup view.
"""
from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass

# ------------------------------------------------------------------------------------------------------------------ masking
VERBATIM_ENVS = ("verbatim", "verbatim*", "Verbatim", "Verbatim*", "BVerbatim", "BVerbatim*", "LVerbatim", "LVerbatim*",
                 "lstlisting", "minted", "alltt", "filecontents", "filecontents*")
_LEX = re.compile(
    r"\\(?P<esc>[%\\])"                                                    # \\% and \\\\ are consumed as units, so \\\\% is a line break then a comment
    r"|(?P<pct>%)"
    r"|\\(?P<verb>verb|lstinline)\*?(?P<delim>[^a-zA-Z\s*{\[])"            # \\verb|text|
    r"|\\begin\{(?P<env>comment|" + "|".join(re.escape(e) for e in VERBATIM_ENVS) + r")\}")
_OPEN = re.compile(r"\\(?P<cond>iffalse|iftrue)(?![a-zA-Z@])")
_COND = re.compile(r"\\(?:if(?!f(?![a-zA-Z@]))[a-zA-Z@]*|fi(?![a-zA-Z@])|else(?![a-zA-Z@]))")     # \\iff is the arrow, not a conditional


def _keep_newlines(s: str) -> str:
    return "\n" * s.count("\n")


def _balanced(text: str, pos: int, open_: str, close: str) -> int:
    """Index just after the group that opens at `pos`, or -1. Brace-aware: a ] inside {...} does not close a [...] group."""
    depth, brace, i = 0, 0, pos
    while i < len(text):
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if open_ == "{":
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return i + 1
        elif c == "{":
            brace += 1
        elif c == "}":
            brace = max(0, brace - 1)
        elif brace == 0 and c == open_:
            depth += 1
        elif brace == 0 and c == close:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def _head_end(text: str, pos: int, env: str) -> int:
    """Where the verbatim body starts: after the options (and minted's language) that sit on the opening line."""
    i = pos
    if env in ("lstlisting", "minted", "Verbatim", "Verbatim*", "BVerbatim", "BVerbatim*", "LVerbatim", "LVerbatim*"):
        while i < len(text) and text[i] in " \t":
            i += 1
        if i < len(text) and text[i] == "[":
            j = _balanced(text, i, "[", "]")
            if j > 0:
                i = j
        if env == "minted":
            k = i
            while k < len(text) and text[k] in " \t":
                k += 1
            if k < len(text) and text[k] == "{":
                j = _balanced(text, k, "{", "}")
                if j > 0:
                    i = j
    return i


def _lex(text: str, m: re.Match, comments: bool, verbatim: bool) -> tuple[str | None, int]:
    """One lexical token: (what to emit, where to resume). None means the text is unterminated and the caller keeps the rest as it is."""
    n = len(text)
    if m.group("esc"):
        return m.group(0), m.end()
    if m.group("pct"):
        if not comments:
            return "%", m.end()
        eol = text.find("\n", m.end())
        return "", (n if eol < 0 else eol)
    if m.group("verb"):
        j, nl = text.find(m.group("delim"), m.end()), text.find("\n", m.end())
        if j >= 0 and (nl < 0 or j < nl):
            return (" " if verbatim else text[m.start():j + 1]), j + 1
        return m.group(0), m.end()
    name = m.group("env")
    end = re.compile(r"\\end\{" + re.escape(name) + r"\}").search(text, m.end())
    if not end:
        return None, m.start()
    if name == "comment":
        return _keep_newlines(text[m.start():end.end()]), end.end()
    if verbatim:
        head = _head_end(text[:end.start()], m.end(), name)               # the options must close before the closing tag
        return text[m.start():head] + _keep_newlines(text[head:end.start()]) + text[end.start():end.end()], end.end()
    return text[m.start():end.end()], end.end()


def _dead_part(text: str, pos: int, live_first: bool, comments: bool) -> tuple[int, int] | None:
    """For a conditional whose opener ends at `pos`: the span TeX never reads, or None (unterminated, or nothing dead).

    \\iffalse A \\else B \\fi   dead = A        \\iftrue A \\else B \\fi   dead = B
    Comments, escapes, \\verb and verbatim blocks are opaque while matching, so a \\fi written in a comment or a listing ends nothing."""
    depth, i, dead_from = 1, pos, (None if live_first else pos)
    while True:
        c, lex = _COND.search(text, i), _LEX.search(text, i)
        if not c:
            return None
        if lex and lex.start() < c.start():
            repl, resume = _lex(text, lex, comments, False)
            i = resume if repl is not None else lex.end()
            continue
        word = c.group(0)
        if word.startswith("\\fi"):
            depth -= 1
            if depth == 0:
                return (dead_from, c.start()) if dead_from is not None else None
        elif word.startswith("\\else"):
            if depth == 1:
                if not live_first:
                    return (pos, c.start())
                dead_from = c.end()
        else:
            depth += 1
        i = c.end()


def _transform(text: str, comments: bool, verbatim: bool) -> str:
    """One pass over the text. Always removes the dead branch of \\iffalse / \\iftrue and the comment environment.
    `comments`: also drop % comments.  `verbatim`: also blank \\verb and the bodies of verbatim-like environments (otherwise they are
    copied through untouched, so nothing inside them is mistaken for markup)."""
    out, pos = [], 0
    while True:
        lex, op = _LEX.search(text, pos), _OPEN.search(text, pos)
        if not lex and not op:
            out.append(text[pos:])
            break
        if lex and (not op or lex.start() < op.start()):
            out.append(text[pos:lex.start()])
            repl, resume = _lex(text, lex, comments, verbatim)
            if repl is None:                                             # unterminated: TeX stops with an error; leave the text alone
                out.append(text[lex.start():])
                break
            out.append(repl)
            pos = resume
        else:
            out.append(text[pos:op.start()])
            out.append(op.group(0))
            span = _dead_part(text, op.end(), op.group("cond") == "iftrue", comments)
            if span is None:
                pos = op.end()
            else:
                out.append(text[op.end():span[0]])
                out.append(_keep_newlines(text[span[0]:span[1]]))
                pos = span[1]
    return "".join(out)


def markup_view(text: str) -> str:
    """The text TeX executes as markup: comments, dead conditionals, the comment environment, verbatim bodies and \\verb removed."""
    return _transform(text, comments=True, verbatim=True)


def drop_dead_blocks(text: str) -> str:
    """For text whose % comments are already gone: also remove what TeX never reads (dead conditionals, the comment environment)."""
    return _transform(text, comments=False, verbatim=False)


# ------------------------------------------------------------------------------------------------------------------ cites
_SINGLE_CITES = ("cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "citeyearpar", "citenum", "citefullauthor",
                 "citetalias", "citepalias", "citeA", "citeNP", "shortcite", "Citep", "Citet", "Citealp", "Citealt", "Citeauthor", "Cite",
                 "parencite", "Parencite", "textcite", "Textcite", "autocite", "Autocite", "footcite", "footcitetext", "supercite", "smartcite",
                 "Smartcite", "fullcite", "footfullcite", "citetitle", "Citetitle", "citedate", "citeurl", "volcite", "Volcite", "pvolcite", "Pvolcite",
                 "fvolcite", "tvolcite", "svolcite", "notecite", "Notecite", "pnotecite", "Pnotecite", "fnotecite")
_MULTI_CITES = ("cites", "Cites", "parencites", "Parencites", "textcites", "Textcites", "autocites", "Autocites", "footcites", "footcitetexts",
                "supercites", "smartcites", "Smartcites", "volcites", "Volcites", "pvolcites", "Pvolcites", "notecites", "Notecites")
_names = lambda ns: "|".join(sorted(ns, key=len, reverse=True))      # noqa: E731  (longest first, so citealp is not read as cite + "alp")
_ARGS = r"(?:\([^)]*\)){0,2}(?:\[[^\]]*\]){0,2}"
RE_CITE = re.compile(r"\\(?:(?:" + _names(_SINGLE_CITES) + r")\*?" + _ARGS + r"\{[^}]*\}"
                     r"|(?:" + _names(_MULTI_CITES) + r")" + _ARGS + r"(?:(?:\[[^\]]*\]){0,2}\{[^}]*\})+)")
RE_NOCITE = re.compile(r"\\nocite\s*\{([^}]*)\}")


def _braced(s: str) -> list[str]:
    s = re.sub(r"\([^)]*\)|\[[^\]]*\]", "", s)
    return re.findall(r"\{([^}]*)\}", s)


def cite_keys(match_text: str, params: bool = False) -> list[str]:
    """Every key in one cite command, multi-cites included. A macro parameter (#1) is not a citation, unless `params` asks for the template."""
    body = match_text[1:]
    body = body[re.match(r"[A-Za-z]+", body).end():] if re.match(r"[A-Za-z]+", body) else body
    return [k.strip() for grp in _braced(body.lstrip("*")) for k in grp.split(",") if k.strip() and (params or "#" not in k)]


# ------------------------------------------------------------------------------------------------------------------ refs
_REFS = ("ref", "eqref", "autoref", "Autoref", "pageref", "nameref", "vref", "Vref", "vpageref", "Vpageref", "cref", "Cref", "cpageref", "Cpageref",
         "labelcref", "labelcpageref", "namecref", "nameCref", "lcnamecref", "autopageref", "subref", "thref")
_RANGES = ("crefrange", "Crefrange", "cpagerefrange", "Cpagerefrange", "vrefrange", "vpagerefrange")
RE_REF = re.compile(r"\\(?:(?:" + _names(_RANGES) + r")\*?(?:\[[^\]]*\])?\{[^}]*\}\{[^}]*\}"
                    r"|(?:" + _names(_REFS) + r")\*?(?:\[[^\]]*\])?\{[^}]*\}"
                    r"|hyperref\[[^\]]*\])")


def ref_labels(match_text: str, params: bool = False) -> list[str]:
    if match_text.startswith("\\hyperref["):
        body = [match_text[len("\\hyperref["):-1]]
    else:
        body = _braced(re.sub(r"^\\[A-Za-z]+\*?", "", match_text))
    return [k.strip() for grp in body for k in grp.split(",") if k.strip() and (params or "#" not in k)]


# ------------------------------------------------------------------------------------------------------------------ labels
RE_LABEL = re.compile(r"\\label\{([^}]*)\}")
_LISTING = re.compile(r"\\begin\{(?:lstlisting|minted)\}|\\(?:lstinputlisting|inputminted)\b")


def _top_level_commas(s: str) -> list[str]:
    parts, depth, cur = [], 0, []
    for c in s:
        depth += (c == "{") - (c == "}")
        if c == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(c)
    parts.append("".join(cur))
    return parts


def listing_labels(text: str) -> list[tuple[str, int]]:
    """Labels a listing defines in its options: \\begin{lstlisting}[caption={...}, label={lst:x}] (the book's 18 false TEX-02 findings)."""
    out = []
    for m in _LISTING.finditer(text):
        i = m.end()
        while i < len(text) and text[i] in " \t":
            i += 1
        if i >= len(text) or text[i] != "[":
            continue
        j = _balanced(text, i, "[", "]")
        if j < 0:
            continue
        for part in _top_level_commas(text[i + 1:j - 1]):
            k = re.match(r"\s*label\s*=\s*(?:\{([^{}]*)\}|([^\s,\]]+))\s*$", part)
            if k:
                name = (k.group(1) if k.group(1) is not None else k.group(2)).strip()
                if name and "#" not in name:
                    out.append((name, m.start()))
    return out


# ------------------------------------------------------------------------------------------------------------------ inputs
@dataclass(frozen=True)
class Input:
    path: str                  # as TeX would look it up, with no extension added
    pos: int
    base: str | None = None    # a directory the imported file's own relative inputs are resolved against (\\import)
    optional: bool = False     # \\InputIfFileExists: a missing file is not an error
    dynamic: bool = False      # the path is built by a macro or a parameter, so it cannot be resolved here


RE_INPUT = re.compile(
    r"\\(?P<c1>input|include|subfile|subfileinclude|InputIfFileExists)\s*\{(?P<p>[^}]*)\}"
    r"|\\(?P<c2>input)\s*(?P<b>\\[A-Za-z@]+|[^\s{}\\%]+)"
    r"|\\(?P<c3>import|subimport|includefrom|subincludefrom|inputfrom|subinputfrom)\*?\s*\{(?P<d>[^}]*)\}\s*\{(?P<f>[^}]*)\}")


def _is_dynamic(path: str) -> bool:
    return bool(re.search(r"[\\#{}]", path))


def inputs(text: str, table: dict[str, "Wrapper"] | None = None) -> list[Input]:
    out = []
    for m in RE_INPUT.finditer(text):
        if m.group("p") is not None:
            path = m.group("p").strip()
            out.append(Input(path, m.start(), None, m.group("c1") == "InputIfFileExists", _is_dynamic(path)))
        elif m.group("b") is not None:
            path = m.group("b").strip()
            out.append(Input(path, m.start(), None, False, _is_dynamic(path)))
        else:
            d, f = m.group("d").strip(), m.group("f").strip()
            path = posixpath.normpath(posixpath.join(d, f)) if d and not _is_dynamic(d + f) else (f if not d else d + "/" + f)
            out.append(Input(path, m.start(), posixpath.normpath(d) if d and not _is_dynamic(d) else None, False, _is_dynamic(d + f)))
    if table:
        out = [i for i in out if not (i.dynamic and _PARAM.search(i.path))]        # the placeholder in the definition; its uses are read below
        out += [Input(v, at, None, False, _is_dynamic(v)) for role, v, at in wrapper_uses(text, table) if role == "input"]
        out.sort(key=lambda i: i.pos)
    return out


# ------------------------------------------------------------------------------------------------------------------ wrapper macros
@dataclass(frozen=True)
class Wrapper:
    """A user macro that only wraps a cite, ref, label or input: \\newcommand{\\figref}[1]{Fig.~\\ref{#1}}. Its uses carry the real keys."""
    name: str
    nargs: int
    roles: tuple[tuple[str, str], ...]        # ((role, template), ...) with #1.. left in the template


_DEF = re.compile(r"\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand)\*?\s*(?:\{\s*(?P<n1>\\[A-Za-z@]+)\s*\}|(?P<n2>\\[A-Za-z@]+))"
                  r"\s*(?:\[(?P<k>\d)\])?\s*(?P<dflt>\[[^\]]*\])?\s*(?=\{)")
_DEF_TEX = re.compile(r"\\(?:[gex]?def)\s*(?P<n>\\[A-Za-z@]+)(?P<ps>(?:#\d)+)\s*(?=\{)")
_PARAM = re.compile(r"#(\d)")


def _templates(body: str) -> list[tuple[str, str]]:
    out = []
    for m in RE_CITE.finditer(body):
        out += [("cite", k) for k in cite_keys(m.group(0), params=True) if _PARAM.search(k)]
    for m in RE_REF.finditer(body):
        out += [("ref", k) for k in ref_labels(m.group(0), params=True) if _PARAM.search(k)]
    out += [("label", m.group(1).strip()) for m in RE_LABEL.finditer(body) if _PARAM.search(m.group(1))]
    out += [("input", i.path) for i in inputs(body) if _PARAM.search(i.path)]
    return out


def wrappers(views) -> dict[str, "Wrapper"]:
    """Wrapper macros defined anywhere in the given markup views. A macro with an optional first argument is left alone."""
    table: dict[str, Wrapper] = {}
    for text in views:
        for m in list(_DEF.finditer(text)) + list(_DEF_TEX.finditer(text)):
            at = text.find("{", m.end())
            end = _balanced(text, at, "{", "}") if at >= 0 else -1
            if end < 0:
                continue
            if "dflt" in m.groupdict() and m.group("dflt"):
                continue
            name = (m.group("n1") or m.group("n2")) if "n1" in m.groupdict() else m.group("n")
            nargs = int(m.group("k") or 0) if "k" in m.groupdict() else len(_PARAM.findall(m.group("ps")))
            roles = _templates(text[at + 1:end - 1])
            if roles and nargs:
                table[name] = Wrapper(name, nargs, tuple(roles))
    return table


def _args(text: str, pos: int, n: int) -> tuple[list[str], int] | None:
    out = []
    for _ in range(n):
        while pos < len(text) and text[pos] in " \t\n":
            pos += 1
        if pos >= len(text) or text[pos] != "{":
            return None
        end = _balanced(text, pos, "{", "}")
        if end < 0:
            return None
        out.append(text[pos + 1:end - 1])
        pos = end
    return out, pos


def wrapper_uses(text: str, table: dict[str, Wrapper]) -> list[tuple[str, str, int]]:
    """(role, key or path, position) for every use of a wrapper macro, with its arguments filled into the template."""
    if not table:
        return []
    names = "|".join(re.escape(n) for n in sorted(table, key=len, reverse=True))
    out = []
    for m in re.finditer(r"(?:" + names + r")(?![A-Za-z@])", text):
        w = table[m.group(0)]
        got = _args(text, m.end(), w.nargs)
        if not got or any("#" in a for a in got[0]):
            continue
        for role, template in w.roles:
            value = _PARAM.sub(lambda g: got[0][int(g.group(1)) - 1] if int(g.group(1)) <= len(got[0]) else g.group(0), template)
            if "#" not in value:
                out.append((role, value, m.start()))
    return out


# ------------------------------------------------------------------------------------------------------------------ positioned results
def cites(text: str, table: dict[str, Wrapper] | None = None) -> list[tuple[str, int]]:
    found = [(k, m.start()) for m in RE_CITE.finditer(text) for k in cite_keys(m.group(0))]
    found += [(k.strip(), at) for role, v, at in wrapper_uses(text, table or {}) if role == "cite" for k in v.split(",") if k.strip()]
    return sorted(found, key=lambda x: x[1])


def nocites(text: str) -> list[tuple[str, int]]:
    return [(k.strip(), m.start()) for m in RE_NOCITE.finditer(text) for k in m.group(1).split(",") if k.strip() and "#" not in k]


def refs(text: str, table: dict[str, Wrapper] | None = None) -> list[tuple[str, int]]:
    found = [(k, m.start()) for m in RE_REF.finditer(text) for k in ref_labels(m.group(0))]
    found += [(k.strip(), at) for role, v, at in wrapper_uses(text, table or {}) if role == "ref" for k in v.split(",") if k.strip()]
    return sorted(found, key=lambda x: x[1])


def labels(text: str, table: dict[str, Wrapper] | None = None) -> list[tuple[str, int]]:
    found = [(m.group(1).strip(), m.start()) for m in RE_LABEL.finditer(text) if m.group(1).strip() and "#" not in m.group(1)]
    found += [(v.strip(), at) for role, v, at in wrapper_uses(text, table or {}) if role == "label" and v.strip()]
    return sorted(found + listing_labels(text), key=lambda x: x[1])
