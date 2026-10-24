# OPAL paper

LaTeX paper describing OPAL (Oracle-Preserving Autonomous Lessons), the local
lesson-learning layer implemented in the Academic Harness plugin (v0.21.0).

The paper is modular: `main.tex` inputs `sections/`, `tables/`, `figures/`, and
`appendix/`. The bibliography is the Harness-RSI survey bibliography plus
entries for the survey, the plugin, and PaperMemory.

## Build

```bash
latexmk -pdf -interaction=nonstopmode main.tex
```

or `make`.

## Scope

This is a system paper with an implementation validation, not a controlled
model or user study. It reports 96 RSI checks, 17 passing plugin test suites, a
synthetic pipeline benchmark, and a real LaTeX defect-injection run. It
explicitly assesses the system against the survey's Selection, Activation,
Attribution, and Improvement criteria and does not claim causal research-quality
gains.

## Experiments

The corpus experiment runner is in `experiments/`:

```bash
node experiments/run_experiments.mjs
python3 experiments/make_tables.py
```

It uses nine local documents (three manuscripts, six proposals), 30 hand-labeled routing requests, 40 development and 20 held-out safety examples, 20 development and 10 held-out preference examples, and a PDF DOI sample. Results are written to `experiments/results/`; the paper tables are generated from those JSON files. The current run detected 31/31 injected defects, covered 23/23 specific finding families with leave-one-project-out lessons, measured 56.7% routing accuracy, and measured 0.53 held-out safety F1. The experiment is offline: it does not run a live model session. The RSI test suite also exercises reached-action activation, injected-token cost, oracle manifests, risk metadata, and explicit rollback.

## Structure

- `sections/00-abstract.tex`
- `sections/01-introduction.tex`
- `sections/02-related-work.tex`
- `sections/03-system-context.tex`
- `sections/04-design.tex`
- `sections/05-implementation.tex`
- `sections/06-evaluation.tex`
- `sections/07-discussion.tex`
- `sections/08-limitations.tex`
- `sections/09-conclusion.tex`
- `appendix/a-catalogue.tex`, `b-schemas.tex`, `c-reproducibility.tex`
- `figures/architecture.tex`, `figures/lifecycle.tex`
- `tables/task-classes.tex`, `results.tex`, `evaluation.tex`, `corpus-results.tex`, `defects.tex`, `transfer.tex`, `routing.tex`, `safety.tex`
- `experiments/corpus.example.json` (copy to local `corpus.json`, which is gitignored), `run_experiments.mjs`, `make_tables.py`, `results/`
