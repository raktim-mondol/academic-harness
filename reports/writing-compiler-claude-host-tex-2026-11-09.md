# Writing compiler: Claude Code as host and model, and the scanner against real LaTeX

Date: 2026-11-09. Follows [the OpenCode findings](writing-compiler-opencode-2026-11-09.md) and
[the OpenCode fixes](writing-compiler-reliability-2026-11-09.md). Rule set **1.10.0**, bundle **dsh14**. Environment: Claude Code 2.1.319,
Claude Haiku 5.5 and Sonnet 5.5 (the only models used here), TeX Live 2025 (pdfTeX 3.141592653-2.6-1.40.28), Python 3.13, Node 24.

## What this covers

The OpenCode session ended on a provider usage limit while committing its work, and its last message listed three things as unverified: native
approvals and stop hooks in a real interactive session, rubric accuracy against independent human labels, and complex TeX macros and compiled-page
layout. This pass takes each in turn, with Claude as the model and host, and reports what was found, what was fixed and what is still open.

## Verdict

The OpenCode fixes hold up under an independent check. Host enforcement was **not** as strong as the unit tests suggested: real sessions found
that an agent's shell could do several of the author's acts and answer a confirmation prompt through a pseudo-terminal, and that the guard denied
ordinary reads. The TeX scanner disagreed with real LaTeX on 12 of 16 first cases and raised 19 false blocker findings on the maintainer's own
manuscripts. All of that is fixed and covered by tests that fail without the fix. Rubric **accuracy** is still unmeasured, because no human labels
exist; that cannot be closed by the model.

## Results

### 1. Host enforcement in real Claude Code sessions

`scripts/claude-host-test` runs each session inside bubblewrap (read-only filesystem except the scratch project), with the project's hooks only.

| Check | Haiku 5.5 | Sonnet 5.5 |
|---|---|---|
| Protected edit and shell append (`facts/facts.yaml`, `ah.yaml`, `.claude/settings.json`) denied, file byte-identical | pass | pass |
| Author's acts denied with their reason, nothing recorded (waive, `rule accept`, `disclosure approve`, `provenance set`, a command wrapped in `script`) | pass | pass (one scenario needed a clearer prompt: the model obeyed "stop if blocked" after the first denial) |
| Anchor-dropping rewrite denied | pass | pass |
| Edit adding an unbound number: post-edit note, Stop blocks and re-enters the model, model runs `ah finding decide`, gate stops steering | pass | pass |
| Clean edit: allowed, gate quiet | pass | pass |
| Terminal UI through tmux, 14 checks: Claude Code's own approval dialog (Yes applies, No leaves the file), no dialog for a protected edit, stop gate, author's `! ah finding waive --yes` in the session | 14/14 | not run |

Defects this found (each now has a test that fails without the fix):

| Defect | How it showed | Fix |
|---|---|---|
| `ah rule accept|reject`, `disclosure approve`, `provenance set|fill|record --type human`, `migrate --force` allowed to an agent's shell | probing the guard against every CLI act that asks for `--yes` or a terminal | `guard.HUMAN_ONLY`, one table; a test fails when the CLI gains a terminal-confirmed act the guard does not name |
| `provenance set` has no confirmation at all: an agent could relabel its paragraphs as human-written and change the AI-use disclosure | reading the CLI | denied; an agent may record only `--type agent` |
| A pseudo-terminal answers "type yes" (`printf 'yes\n' \| script -qec 'ah provenance fill ...'`) | reproduced end to end outside the guard | pty wrappers around the engine are denied |
| `cat facts/facts.yaml 2>&1` denied as a write | a model could not read the facts file in a live session | a redirect is a write only when its target is protected |
| A log file that could not be written aborted the `pre` hook before the protection logic ran, and a host reads exit 0 as "allow" | every hook crashed in my first sandbox run | log is best effort; an engine error denies Write, Edit and Bash with the reason |
| `.claude/settings.json` (the hooks themselves) was writable by the agent | reading `protected_globs` | protected |

### 2. Claude as the rubric model

`ah.verifier.claude` (new, opt-in): one tool-free `claude -p` call per prompt, safe mode, empty directory, no session file; only a finished
one-turn answer from exactly the requested model is accepted. 84 (criterion, paragraph) pairs sampled from 20 real manuscripts, the same sample as
the OpenCode run:

| Model | yes | no | unclear | errors | cold-run tokens in / out | calls: cold / replay / after one edit / restored |
|---|---|---|---|---|---|---|
| gpt-6.1-sol (OpenCode run) | 2 | 81 | 1 | 0 | 75,614 / 2,831 | 84 / 0 / 2 / 0 |
| Claude Haiku 5.5 | 3 | 77 | 4 | 0 | 112,787 / 19,297 | 84 / 0 / 2 / 0 |
| Claude Sonnet 5.5 | 2 | 82 | 0 | 0 | 111,011 / 8,806 | 84 / 0 / 2 / 0 |

Pairwise agreement: GPT and Sonnet 83/84, GPT and Haiku 80/84, Haiku and Sonnet 79/84. All three give `yes` on both planted overclaims. By my
reading of each criterion's own question, Haiku's `unclear` answers and its one real-text `yes` ("every setting in Part III ..." in a book's
structure, not a generalised result) were over-cautious. This is **agreement between models, not accuracy**. It matters for completion: with an
admitted criterion each `unclear` pair leaves `ah done` INCOMPLETE, and the smaller model produced four where Sonnet produced none.

### 3. Independent check of the OpenCode fix

The OpenCode agent wrote both the fix and its tests. A randomised model check (`tests/test_ledger_model.py`) gives a scripted reviewer random
yes/no/unclear/unverifiable/error plans over 8 successive audits and compares the ledger and `ah done` with a three-line reference model
(only a valid "no" clears a finding; uncertainty carries it; INCOMPLETE rather than PASS when nothing is open but a pair is unresolved; every
request, including the correction retry, is counted). 70 sequences (560 audits) agree. One regression was found in the fix's validation:
an empty `scope:` or `criteria:` YAML key (null) was rejected where it used to mean "not given"; fixed.

### 4. TeX: the scanner against real LaTeX

A differential test compiles small projects with `latexmk` and compares TeX's own record (the compiled page for the files typeset, the `.aux` for
citations and labels, the log for the references it evaluated) with the scanner's view.

| | Cases agreeing with TeX |
|---|---|
| Scanner as found | 4 of 16 |
| After the fixes (20 cases, including listing labels, `\nocite{*}`, `\end{document}` in an included file) | 20 of 20 |

Real manuscripts: 20 copies compiled (originals untouched; the largest tree reduced to sources and small assets).

| Against TeX's own record | Agree |
|---|---|
| Files read | 20 / 20 |
| Citations | 19 / 20 |
| Labels | 19 / 20 |
| Undefined references | 20 / 20 |
| Text coverage (distinct words of 4+ letters in the PDF found in the scanner's text, bibliography and code listings set aside) | 93.6% to 99.5%, median 98% |

The three exceptions are not scanner defects: one manuscript loads biblatex but cites with natbib's `\citep` (54 TeX errors, TeX recorded none of
those citations), one label is generated by a package, and one manuscript has `\end{document}` inside its last section file, so two appendix files
never reach the PDF (the scanner believed they did; now `TEX-09`). The residual uncovered words are hyphenation, math macros, `\today` and author
blocks.

Effect on real findings: `TEX-02` (blocker) 19 to 0 (all false: labels defined in `lstlisting` options, a wrapper macro's `#1`), `BIB-05`
15 to 13 (`\nocite`), `TEX-09` 0 to 1 (true), `UNIT-02` 0 to 2 (the same two files). Nothing else changed on the 20 manuscripts.

### 5. Compiled-page layout

`parse_log` now reports the page count, glyphs missing from the font and overfull boxes with their lines and first words; `log_findings` makes
one `TEX-04` per paragraph, `TEX-07` for missing glyphs and `TEX-08` for `build.max_pages`. A real log defeated the first design: TeX reports the
last paragraph of an included file after that file's closing parenthesis, so the open-file stack names the parent. Attribution therefore uses the
starting line and the first words of the box, and an ambiguous box stays a document-level finding. Checked against a real `latexmk` build
(page count equals `pdfinfo`; the overfull paragraph is found by id).

## Not verified

- **Rubric accuracy against independent human labels.** No `admissions.yaml` or labelled sheet exists on this machine. The two blind sheets
  (`~/rubric-labelling/`, 98 paragraphs each) are unlabelled. A model cannot supply these, and agreeing with another model is not accuracy.
  Nothing was admitted, so there are no admissions to remeasure; any older admission elsewhere is void until remeasured.
- **DSH and Pi sessions in this pass.** The shared engine code is covered; the DSH adapter by `scripts/test-academic-harness.mjs`. A live DSH run
  needs a paid model or a rebuilt profile and was not done.
- **OpenCode as a host.** There is no OpenCode adapter. It is a verifier route only; OpenCode sessions are not protected.
- **Not built:** a static check for a citation command that the loaded package does not define (natbib `\citep` under biblatex; `audit --build`
  reports the TeX errors instead); macros defined in `.sty` files, wrapper-in-wrapper, and macro-generated prose; layout beyond overfull boxes,
  glyphs and page count (float placement, widows, figure size); the build is not part of `ah done`.
- The 20 manuscripts are one author's writing; the 20 test cases are mine. Passing them is regression evidence, not a proof of completeness.
- Haiku and Sonnet are driven through `claude -p`, which exposes no temperature; repeatability there comes from the verdict cache.

## Re-running

```sh
npm run test:ah-engine                                  # 486 tests; the 20 TeX cases need latexmk and pdftotext, else they are skipped
python3 scripts/claude-host-test/mkproj.py ~/.cache/ah-claude-host/proj-pristine && python3 scripts/claude-host-test/scenarios.py
python3 scripts/claude-host-test/tui_matrix.py          # the real UI in tmux
python3 scripts/writing-compiler-live.py --adapter claude --corpus <results.json> --model claude-sonnet-5-5 --switch-model claude-haiku-5-5 --output <dir>
```

The corpus comparison (compile a copy, read `.fls`, `.aux` and the log, compare with `input_graph`, `cites`, `labels`, `refs`) is a ten-line
variation of `tests/test_tex_oracle.py` applied to a real tree; keep the manuscripts and raw outputs private.
