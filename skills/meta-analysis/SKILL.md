---
name: meta-analysis
description: Run a pairwise meta-analysis as an auditable ledger with the native `meta_analysis` tool — effect-size conversion, fixed/random pooling, DL/PM/REML tau², Hartung–Knapp CIs, heterogeneity, subgroup and meta-regression analyses, leave-one-out, Egger/Begg/funnel diagnostics, diagnostic-accuracy pooling, forest/funnel/SROC plots, and import from a review extraction table. Use when the user asks for pooled effect sizes, heterogeneity, a forest plot, a meta-regression, publication bias, or diagnostic accuracy synthesis.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Meta-analysis

> **In Academic Harness:** the native `meta_analysis` tool owns the ledger and
> the statistical helper. Discovery and screening stay in `review`; extraction
> must be complete before `import_review`. The tool reports computed estimates
> and warnings — never a certainty, quality, or clinical recommendation.

Use this skill when the deliverable is a pooled estimate, a heterogeneity
summary, a forest/funnel/SROC plot, or a meta-regression. For a narrative
synthesis, use `literature-review`; for screening and appraisal, use
`systematic-review-ledger` and `risk-of-bias-appraisal`.

## Ledger layout

```
.dsh/meta/<slug>/
  protocol.json      write-once effect measure, model, tau2/CI method, alpha
  studies.jsonl      append-only prepared studies with analysis-scale effects
  analyses.jsonl     append-only results (pool, subgroup, regression, …)
  plots/             forest-<id>.svg, funnel-<id>.svg, sroc-<id>.svg
  exports/           meta-analysis.json, studies.csv, report.md
```

Never edit these files by hand. Corrections are new analyses, not silent
rewrites of the protocol.

## Workflow

### 1. Freeze the protocol

```text
meta_analysis action=start slug=<name> question="…" outcome="…" \
  effect_measure=RR model=random tau2_method=reml ci_method=normal alpha=0.05
```

- `effect_measure`: `OR`, `RR`, `HR`, `IRR`, `MD`, `SMD`, `RD`, or `ZR`.
- `model`: `fixed` or `random`. `tau2_method`: `dl`, `pm`, or `reml` (random).
- `ci_method`: `normal` or `hartung_knapp`. HK is often preferred with few
  studies; it is wider and uses a t distribution.
- `start` refuses to overwrite unless `resume: true`. Do not change the
  protocol after seeing results; a new question gets a new slug.

### 2. Add studies

```text
meta_analysis action=add slug=<name> studies=[
  {"id":"S1","label":"Smith 2020","effect":-0.22,"se":0.15,"log_scale":true,"alloc":"random","ablat":44},
  {"id":"S2","label":"Lee 2021","type":"binary","a":10,"b":20,"c":15,"d":25}
]
```

- For a ratio measure, `log_scale: true` means `effect` and `se` are already on
  the log scale. Without it, pass the ratio-scale effect plus `ci_low`/`ci_high`
  (or a log-scale SE explicitly).
- Raw inputs: `type:"binary"` with `a,b,c,d` or `events1,n1,events2,n2`;
  `type:"continuous"` with `m1,sd1,n1,m2,sd2,n2`; `type:"correlation"` with
  `r,n`; `type:"hr"` with `hr,ci_low,ci_high` or `log_hr,se`;
  `type:"diagnostic"` with `tp,fp,fn,tn`.
- Metadata (`alloc`, `dose`, `rob`, `design`, `year`, …) is preserved for
  subgroup and meta-regression.
- Duplicate ids are skipped and reported. Invalid studies are skipped with the
  reason; do not silently drop them from the report.

### 3. Pool and inspect heterogeneity

```text
meta_analysis action=pool slug=<name>
```

Report the pooled estimate and 95% CI, k, model, τ² method, CI method, Q, I²,
τ², prediction interval, and every warning. Do not call a result "significant"
or "effective" on the tool's behalf; report the numbers and let the author
interpret them. A prediction interval is available only with at least three
studies.

### 4. Subgroups, meta-regression, influence

```text
meta_analysis action=subgroup slug=<name> field=alloc
meta_analysis action=meta_regression slug=<name> covariates=["ablat"]
meta_analysis action=leave_one_out slug=<name>
```

- `field` must be a metadata field; groups with one study are reported but not
  pooled.
- Meta-regression covariates must be numeric. Categorical moderators need
  explicit dummy coding. The output includes residual τ², Q_E, p, and a
  pseudo-R²; it is an association under the model, not a causal effect.
- `leave_one_out` reports the full estimate and each omitted-study estimate.

### 5. Publication bias

```text
meta_analysis action=publication_bias slug=<name>
```

Report Egger's intercept test, Begg's rank correlation, and the funnel plot
path. Fewer than 10 studies makes these diagnostics unreliable; the tool
warns. Trim-and-fill is **not implemented** in this release; say so rather
than implying it was run. Funnel asymmetry is not proof of publication bias.

### 6. Diagnostic accuracy

```text
meta_analysis action=add slug=<diag-name> studies=[{"id":"D1","type":"diagnostic","tp":40,"fp":10,"fn":20,"tn":70}, …]
meta_analysis action=diagnostic slug=<diag-name>
```

The current implementation pools logit sensitivity and specificity
separately and draws study points plus the pooled point. It is **not** a full
bivariate/HSROC model; state that limitation. The SROC plot path is returned.

### 7. Import a review extraction table

```text
meta_analysis action=import_review slug=<name> review=<review-slug>
```

Defaults match the built-in PICO fields (`effect`, `se`, `ci_low`, `ci_high`,
`n`, `outcome`, `effect_measure`, `label`). Pass `mapping` for a custom
template. Only complete extraction rows are imported; conflicted, incomplete,
and outcome/measure-mismatched rows are skipped with reasons. Ratio measures
need a confidence interval or explicit log-scale SE.

### 8. Plots, report, export

```text
meta_analysis action=plot slug=<name> kind=forest analysis_id=ma0001
meta_analysis action=report slug=<name>
meta_analysis action=export slug=<name> format=json
meta_analysis action=export slug=<name> format=csv
meta_analysis action=export slug=<name> format=report
meta_analysis action=export slug=<name> format=forest
meta_analysis action=export slug=<name> format=funnel
meta_analysis action=export slug=<name> format=sroc
```

`pool`, `publication_bias`, and `diagnostic` write their plot automatically.
Exports refuse to overwrite unless `overwrite: true`.

## Reporting rules

- Report the model, τ² estimator, CI method, alpha, k, and every warning.
- Use "pooled estimate" and "95% CI", not "proven", "effective", "safe", or
  "recommended".
- Heterogeneity is part of the result, not an afterthought: report Q, I², τ²,
  and the prediction interval when available.
- Fewer than 5 studies: treat heterogeneity and CIs as unstable. Fewer than 10:
  do not rely on funnel-plot tests.
- A meta-regression coefficient is not a causal effect.
- A diagnostic SROC here is a study-point plot with univariate pooling; do not
  describe it as a bivariate/HSROC analysis.
- Import only complete extraction rows; never fill a conflicted value to make a
  study eligible.
- The tool never decides certainty, quality, or clinical applicability.
