"""Torture cases for the static TeX scanner (used by test_tex_oracle.py). Each case is a tiny project; real LaTeX decides what is true."""

PRE = r"\documentclass{article}" + "\n"
LOREM = "This paragraph carries enough ordinary words to count as audited prose in the compiler and to show up in the compiled page."

CASES: dict[str, dict] = {}


def case(name, files, note=""):
    CASES[name] = {"files": files, "note": note}


case("plain", {
    "main.tex": PRE + r"\begin{document}\input{sections/a}\include{sections/b}\end{document}" + "\n",
    "sections/a.tex": LOREM + " Alpha.\n", "sections/b.tex": LOREM + " Beta.\n"},
    "the baseline the scanner is built for")

case("input-no-braces", {
    "main.tex": PRE + "\\begin{document}\n\\input sections/a\n\\input{sections/b}\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n", "sections/b.tex": LOREM + " Beta.\n"},
    "\\input name without braces is plain TeX and valid LaTeX")

case("subfiles", {
    "main.tex": PRE + "\\usepackage{subfiles}\n\\begin{document}\n\\subfile{sections/a}\n\\subfile{sections/b.tex}\n\\end{document}\n",
    "sections/a.tex": "\\documentclass[../main.tex]{subfiles}\n\\begin{document}\n" + LOREM + " Alpha.\n\\end{document}\n",
    "sections/b.tex": "\\documentclass[../main.tex]{subfiles}\n\\begin{document}\n" + LOREM + " Beta.\n\\end{document}\n"},
    "\\subfile reads the file between its own \\begin{document} and \\end{document}")

case("import", {
    "main.tex": PRE + "\\usepackage{import}\n\\begin{document}\n\\import{sections/}{a}\n\\subimport{sections/}{b}\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n\\input{c}\n", "sections/b.tex": LOREM + " Beta.\n", "sections/c.tex": LOREM + " Gamma.\n"},
    "import changes the base directory for the \\input inside the imported file")

case("includeonly", {
    "main.tex": PRE + "\\includeonly{sections/a}\n\\begin{document}\n\\include{sections/a}\n\\include{sections/b}\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n", "sections/b.tex": LOREM + " Beta.\n"},
    "b.tex is listed but not built")
CASES["includeonly"]["allow_extra"] = ("sections/b.tex",)      # an author still wants the excluded chapter audited, and its labels resolve through b.aux

case("macro-include", {
    "main.tex": PRE + "\\newcommand{\\sect}[1]{\\input{sections/#1}}\n\\begin{document}\n\\sect{a}\n\\sect{b}\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n", "sections/b.tex": LOREM + " Beta.\n"},
    "an include wrapped in a user macro")

case("dead-code", {
    "main.tex": PRE + "\\usepackage{comment}\n\\begin{document}\n\\input{sections/a}\n"
                "\\iffalse\n\\input{sections/old1}\n\\fi\n\\begin{comment}\n\\input{sections/old2}\n\\end{comment}\n"
                "% \\input{sections/old3}\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n", "sections/old1.tex": LOREM + " Old one.\n", "sections/old2.tex": LOREM + " Old two.\n",
    "sections/old3.tex": LOREM + " Old three.\n"},
    "inputs that are never read: \\iffalse, comment environment, % comment")

case("inputifexists", {
    "main.tex": PRE + "\\begin{document}\n\\InputIfFileExists{sections/a}{}{}\n\\InputIfFileExists{sections/missing}{}{}\n\\IfFileExists{sections/b.tex}{\\input{sections/b}}{}\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n", "sections/b.tex": LOREM + " Beta.\n"},
    "conditional inputs")

case("verbatim-inputs", {
    "main.tex": PRE + "\\usepackage{listings}\n\\begin{document}\n\\input{sections/a}\n"
                "Use \\verb|\\input{sections/fake1}| to include a file.\n"
                "\\begin{verbatim}\n\\input{sections/fake2}\n\\end{verbatim}\n"
                "\\begin{lstlisting}\n\\input{sections/fake3}\n\\end{lstlisting}\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n", "sections/fake1.tex": LOREM + " Fake1.\n", "sections/fake2.tex": LOREM + " Fake2.\n",
    "sections/fake3.tex": LOREM + " Fake3.\n"},
    "commands shown as text, not executed")

BIB = "@article{k1, title={One}, author={A, B}, year={2020}, journal={J}}\n@article{k2, title={Two}, author={C, D}, year={2021}, journal={J}}\n" \
      "@article{k3, title={Three}, author={E, F}, year={2022}, journal={J}}\n@article{k4, title={Four}, author={G, H}, year={2023}, journal={J}}\n" \
      "@article{k5, title={Five}, author={I, J}, year={2024}, journal={J}}\n@article{k6, title={Six}, author={K, L}, year={2019}, journal={J}}\n" \
      "@article{k7, title={Seven}, author={M, N}, year={2018}, journal={J}}\n@article{k8, title={Eight}, author={O, P}, year={2017}, journal={J}}\n"

case("cites-natbib", {
    "main.tex": PRE + "\\usepackage{natbib}\n\\newcommand{\\cit}[1]{\\citep{#1}}\n\\begin{document}\n"
                "A \\cite{k1}, \\citep{k2}, \\citet{k3}, \\citep*[see][p.~2]{k4}, \\citeauthor{k5}, \\citeyear{k6}, \\citealp{k7,k8}.\n"
                "Wrapped: \\cit{k1}. \\nocite{k2}\n\\bibliographystyle{plain}\\bibliography{refs}\n\\end{document}\n",
    "refs.bib": BIB},
    "natbib commands and a wrapper macro")

case("cites-biblatex", {
    "main.tex": PRE + "\\usepackage[backend=biber]{biblatex}\n\\addbibresource{refs.bib}\n\\begin{document}\n"
                "A \\cite{k1}, \\parencite{k2}, \\textcite{k3}, \\autocite{k4}, \\footcite{k5}, \\Cite{k6}, \\Parencite{k7}, "
                "\\parencites(see)(p.~2)[a]{k1}[b]{k2}, \\cites{k3}{k4}, \\supercite{k8}.\n\\nocite{k2}\n\\printbibliography\n\\end{document}\n",
    "refs.bib": BIB},
    "biblatex commands: capitalised, multi, \\nocite")

case("refs", {
    "main.tex": PRE + "\\usepackage{amsmath}\n\\usepackage{varioref}\n\\usepackage{hyperref}\n\\usepackage{cleveref}\n\\newcommand{\\figref}[1]{Fig.~\\ref{#1}}\n\\begin{document}\n"
                "\\ref{u1} \\eqref{u2} \\autoref{u3} \\pageref{u4} \\nameref{u5} \\cref{u6} \\Cref{u7,u8} \\vref{u9} \\Vref{u10} "
                "\\hyperref[u11]{text} \\crefrange{u12}{u13} \\labelcref{u14} \\cpageref{u15} \\figref{u16} \\autopageref{u17} \\namecref{u18}.\n"
                "\\end{document}\n"},
    "every reference form; all labels undefined so the log lists exactly the ones TeX evaluated")

case("labels", {
    "main.tex": PRE + "\\usepackage{amsmath}\n\\newcommand{\\figlabel}[1]{\\label{fig:#1}}\n\\newcounter{x}\n\\begin{document}\n"
                "\\section{Intro}\\label{sec:intro}\n\\begin{equation}\\label{eq:a} a=b \\end{equation}\n"
                "\\begin{figure}\\caption{c}\\label{fig:one}\\end{figure}\n\\figlabel{two}\n"
                "\\begin{align}\\label{eq:b} a&=b \\\\ c&=d \\label{eq:c}\\end{align}\n\\end{document}\n"},
    "label forms including a wrapper macro")

case("prose-in-macros", {
    "main.tex": PRE + "\\newcommand{\\claim}{We show that the proposed estimator is consistent under the stated conditions and report its variance.}\n"
                "\\newenvironment{remark2}{\\par\\textbf{Remark.} }{\\par}\n"
                "\\title{A title with several words}\\author{A. Author}\n\\begin{document}\\maketitle\n"
                "\\begin{abstract}An abstract that has a number of ordinary words in it.\\end{abstract}\n"
                "\\claim\n\n\\begin{remark2}A remark with words that appear in the compiled page.\\end{remark2}\n\\end{document}\n"},
    "prose that lives in a macro body, a title, an abstract, a custom environment")

case("crlf-bom", {
    "main.tex": "\ufeff" + (PRE + "\\begin{document}\r\n\\input{sections/a}\r\n\\end{document}\r\n"),
    "sections/a.tex": (LOREM + " Alpha.\r\n")},
    "CRLF line endings and a byte order mark")

case("percent-escapes", {
    "main.tex": PRE + "\\usepackage{url}\n\\begin{document}\n\\input{sections/a}\n"
                "We saw 50\\% growth \\cite{k1} and visited \\url{http://example.org/a\\%20b} then \\ref{undefined-after-percent}.\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n"},
    "an escaped percent must not start a comment")


case("listing-labels", {
    "main.tex": PRE + "\\usepackage{listings}\n\\begin{document}\n"
                "\\begin{lstlisting}[caption={A caption with, a comma and [brackets]}, label={lst:one}]\nx = 1 % not a comment\n\\end{lstlisting}\n"
                "\\begin{lstlisting}[label=lst:two,language=Python]\ny = 2\n\\end{lstlisting}\n"
                "\\lstinputlisting[label=lst:three]{code.py}\n"
                "\\begin{lstlisting}[caption={mentions label=lst:fake}]\nz\n\\end{lstlisting}\n\\end{document}\n",
    "code.py": "print(3)\n"},
    "labels defined in a listing's options (the book's 18 false TEX-02 blockers)")

case("nocite-star", {
    "main.tex": PRE + "\\begin{document}\nText \\cite{k1}.\n\\nocite{*}\n\\bibliographystyle{plain}\\bibliography{refs}\n\\end{document}\n",
    "refs.bib": BIB},
    "\\nocite{*} cites every entry")


case("end-document-in-a-section", {
    "main.tex": PRE + "\\begin{document}\n\\input{sections/a}\n\\input{sections/b}\n\\input{sections/c}\n\\end{document}\n",
    "sections/a.tex": LOREM + " Alpha.\n", "sections/b.tex": LOREM + " Beta.\n\\end{document}\n", "sections/c.tex": LOREM + " Gamma.\n"},
    "a section file ends the document; c.tex is never typeset (found in a real manuscript)")

case("end-document-with-subfiles", {
    "main.tex": PRE + "\\usepackage{subfiles}\n\\begin{document}\n\\subfile{sections/a}\n\\subfile{sections/b}\n\\end{document}\n",
    "sections/a.tex": "\\documentclass[../main.tex]{subfiles}\n\\begin{document}\n" + LOREM + " Alpha.\n\\end{document}\n",
    "sections/b.tex": "\\documentclass[../main.tex]{subfiles}\n\\begin{document}\n" + LOREM + " Beta.\n\\end{document}\n"},
    "subfiles end their own document, not the main one")
