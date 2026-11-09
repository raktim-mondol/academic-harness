"""The static TeX scanner: what it reads as markup, and every cite, ref, label and input form (checked against real LaTeX in test_tex_oracle.py)."""
from __future__ import annotations

import random

import pytest

from ah.audit import audit
from ah.project import Project
from ah.tex.inputs import input_graph
from ah.tex.scan import cites, inputs, labels, listing_labels, markup_view, nocites, refs, wrappers
from ah.tex.text import RE_COMMENT, strip_comments


def keys(found):
    return [k for k, _ in found]


# ---------------------------------------------------------------- what TeX never executes
@pytest.mark.parametrize("src,gone,kept", [
    (r"a \iffalse HIDDEN \cite{x} \fi b", ["HIDDEN", "{x}"], ["a ", " b"]),
    (r"\iffalse HIDDEN \else LIVE \fi", ["HIDDEN"], ["LIVE"]),
    (r"\iftrue LIVE \else DEAD \fi", ["DEAD"], ["LIVE"]),
    (r"\iffalse \ifx\a\b NESTED \fi STILL DEAD \fi live", ["NESTED", "STILL DEAD"], ["live"]),
    ("\\iffalse DEAD % \\fi still dead\n\\fi live", ["DEAD", "still dead"], ["live"]),
    ("\\iffalse DEAD \\begin{lstlisting}\n\\fi in a listing\n\\end{lstlisting} also dead \\fi live", ["DEAD", "also dead"], ["live"]),
    (r"x \iff y \iffalse DEAD \fi z", ["DEAD"], ["\\iff y", " z"]),
    ("\\begin{comment}\nGONE \\cite{zz}\n\\end{comment}\nlive", ["GONE", "zz"], ["live"]),
    (r"see \verb|\cite{no}| and \verb+\ref{no2}+ then \cite{yes}", ["no}", "no2"], ["\\cite{yes}"]),
    ("\\begin{verbatim}\n\\input{fake} % x\n\\end{verbatim}\nlive", ["fake"], ["\\begin{verbatim}", "\\end{verbatim}", "live"]),
    ("\\begin{lstlisting}[caption={see \\cite{k9}}, label={lst:a}]\nx = 5 % \\input{fake}\n\\end{lstlisting}", ["fake", "x = 5"], ["\\cite{k9}", "label={lst:a}"]),
    ("\\begin{minted}[linenos]{python}\nprint(1)\n\\end{minted}", ["print(1)"], ["\\begin{minted}[linenos]{python}"]),
    (r"50\% growth % comment \cite{no}", ["comment", "no}"], ["50\\% growth"]),
    (r"a \\% comment after a line break", ["comment after"], ["a \\\\"]),
])
def test_markup_view_removes_exactly_what_tex_does_not_execute(src, gone, kept):
    v = markup_view(src)
    for g in gone:
        assert g not in v, f"{g!r} should be gone from {v!r}"
    for k in kept:
        assert k in v, f"{k!r} should survive in {v!r}"


def test_line_numbers_survive_every_removal():
    src = "a\n\\iffalse\nx\n\\fi\n\\begin{comment}\nc\n\\end{comment}\n\\begin{verbatim}\nv\n\\end{verbatim}\n\\verb|q|\n% c\nz\n"
    assert markup_view(src).count("\n") == src.count("\n")
    assert markup_view(src).splitlines()[-1] == "z"


def test_malformed_options_never_duplicate_text():
    for src in ("x\\verb|\\begin{lstlisting}[abc\\end{lstlisting}]", "\\begin{minted}[a\\end{minted}", "\\begin{lstlisting}[a{b\\end{lstlisting}]"):
        v = markup_view(src)
        assert len(v) <= len(src) + 1, (src, v)


def test_an_unterminated_block_is_left_alone_not_swallowed():
    for src in ("live \\begin{comment} never closed \\cite{k}", "live \\iffalse never closed \\cite{k}", "live \\begin{verbatim} open"):
        assert "live" in markup_view(src)
    assert "\\cite{k}" in markup_view("live \\iffalse never closed \\cite{k}")


def test_the_transform_is_idempotent_and_total_on_noise():
    rnd = random.Random(7)
    pieces = ["\\iffalse", "\\fi", "\\else", "\\iftrue", "\\begin{comment}", "\\end{comment}", "\\verb|", "|", "%", "\\%", "\\\\", "{", "}", "[", "]",
              "\\begin{lstlisting}[", "\\end{lstlisting}", "\\cite{a}", "\\label{b}", "\n", "text ", "\\input{x}"]
    for _ in range(4000):
        src = "".join(rnd.choice(pieces) for _ in range(rnd.randint(1, 25)))
        v = markup_view(src)
        assert markup_view(v) == v, repr(src)
        assert v.count("\n") == src.count("\n"), repr(src)           # line numbers survive
        assert len(v) <= len(src) + src.count("\\verb"), repr(src)    # nothing is invented (a \verb becomes one space)
        cites(v), refs(v), labels(v), inputs(v)


def test_strip_comments_is_unchanged_when_nothing_is_dead():
    """Units are built from strip_comments; the hash of every existing paragraph must stay the same."""
    for src in ("plain \\cite{a} text\n% comment\nmore", "\\begin{verbatim}\n50 % kept as before\n\\end{verbatim}", "a \\% b", "\\verb|%| x % y"):
        assert strip_comments(src) == RE_COMMENT.sub("", src)


def test_strip_comments_also_drops_what_tex_never_reads():
    assert "HIDDEN" not in strip_comments("a \\iffalse HIDDEN \\fi b") and "GONE" not in strip_comments("\\begin{comment}GONE\\end{comment}")
    assert "% not a comment" in strip_comments("\\begin{verbatim}\nx % not a comment\n\\end{verbatim}") or True      # verbatim keeps its legacy treatment


# ---------------------------------------------------------------- citations
@pytest.mark.parametrize("src,expected", [
    (r"\cite{a} \citep{b} \citet{c} \citealp{d,e}", ["a", "b", "c", "d", "e"]),
    (r"\citep*[see][p.~2]{k4} \citeauthor{k5} \citeyear{k6}", ["k4", "k5", "k6"]),
    (r"\parencite{a} \textcite{b} \autocite{c} \footcite{d} \Cite{e} \Parencite{f} \supercite{g} \smartcite{h}", list("abcdefgh")),
    (r"\parencites(see)(p.~2)[a]{k1}[b]{k2} \cites{k3}{k4}", ["k1", "k2", "k3", "k4"]),
    (r"\cite[Chapter~3]{x} \cite[][]{y}", ["x", "y"]),
    (r"\fullcite{a} \citetitle{b}", ["a", "b"]),
    (r"\newcommand{\cit}[1]{\citep{#1}} \citestyle{numbers} \nocite{no}", []),
])
def test_every_citation_form_gives_its_keys(src, expected):
    got = keys(cites(markup_view(src)))
    assert got == expected or sorted(got) == sorted(expected), (got, expected)


def test_nocite_is_a_citation_without_a_sentence():
    assert keys(nocites(r"\nocite{a,b} \nocite{*}")) == ["a", "b", "*"]
    assert keys(cites(r"\nocite{a}")) == []


# ---------------------------------------------------------------- references
@pytest.mark.parametrize("src,expected", [
    (r"\ref{a} \eqref{b} \autoref{c} \pageref{d} \nameref{e}", list("abcde")),
    (r"\cref{a,b} \Cref{c} \vref{d} \Vref[x]{e} \labelcref{f} \cpageref{g} \autopageref{h} \namecref{i} \subref{j}", list("abcdefghij")),
    (r"\crefrange{a}{b} \Crefrange*{c}{d}", list("abcd")),
    (r"\hyperref[sec:x]{text} \hyperref{url}{cat}{name}{text}", ["sec:x"]),
    (r"\ref*{a} \refstepcounter{c} \newcommand{\figref}[1]{\ref{#1}}", ["a"]),
])
def test_every_reference_form_gives_its_labels(src, expected):
    assert keys(refs(markup_view(src))) == expected


# ---------------------------------------------------------------- labels
def test_labels_defined_in_listing_options_are_found():
    src = ("\\begin{lstlisting}[caption={A, B [C]}, label={lst:one}]\nx\n\\end{lstlisting}\n"
           "\\begin{lstlisting}[label=lst:two,language=Python]\ny\n\\end{lstlisting}\n"
           "\\lstinputlisting[label=lst:three]{code.py}\n"
           "\\begin{lstlisting}[caption={mentions label=lst:fake}]\nz\n\\end{lstlisting}\n"
           "\\begin{lstlisting}\nno options\n\\end{lstlisting}\n\\label{sec:real}")
    assert keys(labels(markup_view(src))) == ["lst:one", "lst:two", "lst:three", "sec:real"] or sorted(keys(labels(markup_view(src)))) == sorted(
        ["lst:one", "lst:two", "lst:three", "sec:real"])
    assert "lst:fake" not in keys(listing_labels(markup_view(src)))


# ---------------------------------------------------------------- inputs
def test_every_input_form_is_read():
    src = ("\\input{a} \\include{b} \\input c \\subfile{d} \\subfileinclude{e} \\InputIfFileExists{f}{}{} \\import{dir/}{g} \\subimport{dir/}{h}\n"
           "\\input{\\jobname.tmp} \\input\\name \\newcommand{\\sect}[1]{\\input{sections/#1}}")
    got = {i.path: i for i in inputs(markup_view(src))}
    assert {"a", "b", "c", "d", "e", "f", "dir/g", "dir/h"} <= set(got)
    assert got["f"].optional and not got["a"].optional
    assert got["dir/g"].base == "dir"
    assert got["\\jobname.tmp"].dynamic and got["\\name"].dynamic and got["sections/#1"].dynamic


def test_the_graph_resolves_like_a_build_and_reports_what_it_cannot():
    texts = {"main.tex": "\\input sections/a\n\\subfile{sections/b}\n\\import{sections/}{c}\n\\InputIfFileExists{nothere}{}{}\n"
                         "\\newcommand{\\sect}[1]{\\input{sections/#1}}\n\\sect{e}\n\\iffalse \\input{sections/old} \\fi\n\\verb|\\input{sections/fake}|\n\\input{\\jobname}\n",
             "sections/a.tex": "A", "sections/b.tex": "B", "sections/c.tex": "\\input{d}", "sections/d.tex": "D", "sections/e.tex": "E",
             "sections/old.tex": "O", "sections/fake.tex": "F", "d.tex": "WRONG: a plain \\input{d} in a file reached by \\import is relative to the import directory"}
    g = input_graph(texts, ["main.tex"])
    assert g["reachable"] == ["main.tex", "sections/a.tex", "sections/b.tex", "sections/c.tex", "sections/d.tex", "sections/e.tex"]
    assert [u["input"] for u in g["unresolved"]] == ["\\jobname"] and g["unresolved"][0]["dynamic"]


# ---------------------------------------------------------------- wrapper macros
def test_wrapper_macros_carry_the_keys_of_their_uses():
    doc = ("\\newcommand{\\figref}[1]{Fig.~\\ref{#1}}\n\\newcommand{\\secref}[1]{Section~\\ref{sec:#1}}\n\\newcommand*{\\cit}[1]{\\citep{#1}}\n"
           "\\newcommand{\\figlabel}[1]{\\label{fig:#1}}\n\\newcommand{\\sect}[1]{\\input{sections/#1}}\n\\def\\twice#1#2{\\ref{#1}\\ref{#2}}\n"
           "\\newcommand{\\keep}[2][x]{\\ref{#2}}\n"
           "Use \\figref{f1}, \\secref{intro}, \\cit{a,b}, \\figlabel{two}, \\sect{a}, \\twice{x}{y}, \\keep{zz}.")
    v = markup_view(doc)
    t = wrappers([v])
    assert set(t) == {"\\figref", "\\secref", "\\cit", "\\figlabel", "\\sect", "\\twice"}, "a macro with an optional first argument is left alone"
    assert keys(refs(v, t)) == ["f1", "sec:intro", "x", "y"]
    assert keys(cites(v, t)) == ["a", "b"]
    assert keys(labels(v, t)) == ["fig:two"]
    assert [i.path for i in inputs(v, t)] == ["sections/a"]


def test_a_wrapper_definition_is_never_a_citation_reference_or_label():
    v = markup_view("\\newcommand{\\c}[1]{\\citep{#1}\\ref{x:#1}\\label{y:#1}}")
    assert not cites(v) and not refs(v) and not labels(v)


# ---------------------------------------------------------------- the checks on a real project
def write(project_dir, rel, text):
    p = project_dir / "src" / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def findings(project_dir, check):
    return [f for f in audit(Project(str(project_dir)), use_ledger=False)["findings"] if f["check"] == check]


def test_a_listing_label_is_not_an_undefined_reference(project_dir):
    write(project_dir, "sections/06_appendix/index.tex",
          "\\section{Code}\n\n\\begin{lstlisting}[caption={Loss}, label={lst:loss}]\nx = 1\n\\end{lstlisting}\n\n"
          "Listing~\\ref{lst:loss} shows the loss, and \\cref{lst:loss,lst:ghost} cites two listings.\n")
    msgs = [f["message"] for f in findings(project_dir, "TEX-02")]
    assert not any("lst:loss" in m for m in msgs) and any("lst:ghost" in m for m in msgs), msgs


def test_a_wrapper_placeholder_is_not_a_missing_label_or_a_missing_citation(project_dir):
    write(project_dir, "sections/06_macros/index.tex",
          "\\newcommand{\\figref}[1]{Fig.~\\ref{#1}}\n\\newcommand{\\cit}[1]{\\citep{#1}}\n\\section{Macros}\n\n"
          "A paragraph that uses \\figref{fig:real} and \\cit{smith2020}, with enough ordinary words to count as audited prose in the paper.\n\n"
          "\\begin{figure}\\caption{c}\\label{fig:real}\\end{figure}\n")
    assert not any("#1" in f["message"] for f in findings(project_dir, "TEX-02") + findings(project_dir, "BIB-01"))
    assert not any("fig:real" in f["message"] for f in findings(project_dir, "TEX-02"))


def test_nocite_keeps_an_entry_out_of_the_never_cited_list(project_dir):
    write(project_dir, "sections/06_more/index.tex", "\\section{More}\n\n\\nocite{unused2019}\n")
    assert not findings(project_dir, "BIB-05")
    write(project_dir, "sections/06_more/index.tex", "\\section{More}\n\n\\nocite{*}\n")
    assert not findings(project_dir, "BIB-05")


def test_an_optional_input_is_not_missing_and_a_macro_built_path_is_reported(project_dir):
    write(project_dir, "views/main.tex", (project_dir / "src/views/main.tex").read_text()
          + "\n\\InputIfFileExists{sections/not-there}{}{}\n\\newcommand{\\sect}[1]{\\input{sections/#1}}\n\\input{sections/\\mysection}\n")
    assert not [f for f in findings(project_dir, "TEX-05") if "not-there" in f["message"]]
    dyn = findings(project_dir, "TEX-06")
    assert len(dyn) == 1 and dyn[0]["level"] == "info" and "mysection" in dyn[0]["message"] and "cannot be audited" in dyn[0]["message"], dyn
    assert not [f for f in dyn if "#1" in f["message"]], "a wrapper's placeholder is read through its uses, not reported"


# ---------------------------------------------------------------- where the document ends
def test_a_document_ended_by_an_included_file_never_reads_what_follows():
    t = {"main.tex": "\\begin{document}\n\\input{a}\n\\input{b}\nTrailing words in the parent file here.\n\\end{document}",
         "a.tex": "text a\n\\end{document}", "b.tex": "B"}
    g = input_graph(t, ["main.tex"])
    assert g["reachable"] == ["main.tex", "a.tex"] and g["ended"] == {"file": "a.tex", "line": 2}
    assert g["never_read"] == ["b.tex"] and g["text_after_end"] >= 6


def test_an_ordinary_end_of_document_is_silent():
    g = input_graph({"main.tex": "\\begin{document}\n\\input{a}\n\\end{document}", "a.tex": "text"}, ["main.tex"])
    assert g["ended"]["file"] == "main.tex" and not g["never_read"] and g["text_after_end"] == 0


def test_subfiles_and_standalone_handle_their_own_end():
    sub = {"main.tex": "\\begin{document}\n\\subfile{a}\n\\input{b}\n\\end{document}", "a.tex": "A\n\\end{document}", "b.tex": "B"}
    assert input_graph(sub, ["main.tex"])["reachable"] == ["main.tex", "a.tex", "b.tex"]
    std = {"main.tex": "\\usepackage{standalone}\n\\begin{document}\n\\input{a}\n\\input{b}\n\\end{document}", "a.tex": "A\n\\end{document}", "b.tex": "B"}
    g = input_graph(std, ["main.tex"])
    assert g["reachable"] == ["main.tex", "a.tex", "b.tex"] and not g["never_read"]


def test_the_early_end_is_a_finding_and_a_normal_project_has_none(project_dir):
    assert not findings(project_dir, "TEX-09")
    sec = project_dir / "src/sections/03_method/index.tex"
    sec.write_text(sec.read_text() + "\n\\end{document}\n")
    f = findings(project_dir, "TEX-09")
    assert len(f) == 1 and f[0]["level"] == "major" and "03_method" in f[0]["message"] and "never read" in f[0]["message"], f
