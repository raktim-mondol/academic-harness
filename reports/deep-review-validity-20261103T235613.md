# deep_review evaluation-validity calibration

Generated 2026-11-03T23:56:13.531Z. measured. Advisory readings; the labels are an independent reader's reading, not ground truth.

## Corpus

- manifest: local 14-paper manifest (not packaged)
- papers: 14; evaluable: 14; labels complete: 14; verdict floor: 6 evaluable papers
- PDFs converted with the simple text converter: 14/14; conversion/read failures: 0; pages flagged for OCR, not OCR'd: 1
- references excluded from counting: 11 paper(s); leading PDF line numbers stripped: 6 paper(s)
- label source: two independent readers (methodologist and results auditor); disagreements adjudicated by a third reader
- attribution in corpus mode uses the manuscript text and grids; stored-review claims are included only when a manifest row supplies `claims`/`comments`.

## Per check

| check | verdict | labeled | agreement | flag labels | predicted flagged | TP | missed clear | abstained | false alarms | precision | recall | flag rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| attribution | measured | 14 | 14/14 (1) | 2 | 2 | 2 | 0 | 0 | 0 | 1 | 1 | 0.143 |
| evaluator_drift | measured | 14 | 8/14 (0.571) | 2 | 1 | 1 | 1 | 0 | 0 | 1 | 0.5 | 0.071 |
| benchmark_coverage | measured | 14 | 10/14 (0.714) | 0 | 0 | 0 | 0 | 0 | 0 | — | — | 0 |
| unmeasured_trade_off | measured | 14 | 11/14 (0.786) | 0 | 0 | 0 | 0 | 0 | 0 | — | — | 0 |

Overall state agreement on complete labels: 43/56 (0.768).
False positives on well-formed papers: 0.
Determinism mismatches: 0.

## Per paper

| paper | source | attribution | evaluator_drift | benchmark_coverage | unmeasured_trade_off | deterministic |
| --- | --- | --- | --- | --- | --- | --- |
| scgpt | pdf_converted | clear (clear) | clear (clear) | clear (clear) | clear (clear) | yes |
| cbm2024 | pdf_converted | clear (clear) | clear (clear) | not_checked (clear) !diff | not_checked (not_checked) | yes |
| asoc2023 | pdf_converted | clear (clear) | not_checked (clear) !diff | clear (clear) | not_checked (clear) !diff | yes |
| nature2026-coscientist | pdf_converted | clear (clear) | clear (clear) | clear (clear) | clear (clear) | yes |
| nature2026-agents | pdf_converted | clear (clear) | not_checked (clear) !diff | not_checked (clear) !diff | clear (clear) | yes |
| stair2026 | pdf_converted | clear (clear) | not_checked (not_checked) | clear (clear) | not_checked (not_checked) | yes |
| scandy | pdf_converted | flagged (flagged) | clear (flagged) !miss | clear (clear) | not_checked (not_checked) | yes |
| biofusion | pdf_converted | clear (clear) | clear (clear) | clear (clear) | not_checked (clear) !diff | yes |
| breast-imaging-review | pdf_converted | not_checked (not_checked) | clear (not_checked) !diff | not_checked (clear) !diff | clear (clear) | yes |
| tellez2019 | pdf_converted | clear (clear) | not_checked (clear) !diff | clear (clear) | clear (clear) | yes |
| ebio2024 | pdf_converted | clear (clear) | not_checked (clear) !diff | clear (clear) | not_checked (not_checked) | yes |
| npjcm2026 | pdf_converted | flagged (flagged) | clear (clear) | not_checked (clear) !diff | clear (clear) | yes |
| nbe2026 | pdf_converted | clear (clear) | clear (clear) | clear (clear) | clear (not_checked) !diff | yes |
| fairness-review | pdf_converted | not_checked (not_checked) | flagged (flagged) | clear (clear) | clear (clear) | yes |

## Mismatches

- cbm2024 / benchmark_coverage: predicted not_checked, label clear — 2 grid(s) counted 0 metric axis(es), 2 other axis(es), 2 numeric column(s) and 7 distinct arm label(s); that shape matches neither the thin grid the rule flags nor the wide grid the rule clears — line 102: markdown grid: 3 row(s), 0 metric column(s), 2 other column axis/axes, 2 numeric column(s), 2 arm(s), 0 baseline-like, 0 removal-like / line 156: markdown grid: 6 row(s), 0 metric column(s), 2 other column axis/axes, 2 numeric column(s), 5 arm(s), 0 baseline-like, 0 removal-like
- asoc2023 / evaluator_drift: predicted not_checked, label clear — no before-and-after value pair appears in the manuscript text, so there is no stated change to locate
- asoc2023 / unmeasured_trade_off: predicted not_checked, label clear — no cost-side improvement claim (latency, runtime, memory footprint, throughput, solver iterations) with a number attached
- nature2026-agents / evaluator_drift: predicted not_checked, label clear — no before-and-after value pair appears in the manuscript text, so there is no stated change to locate
- nature2026-agents / benchmark_coverage: predicted not_checked, label clear — 5 grid(s) counted 0 metric axis(es), 8 other axis(es), 2 numeric column(s) and 14 distinct arm label(s); that shape matches neither the thin grid the rule flags nor the wide grid the rule clears — line 5: markdown grid: 6 row(s), 0 metric column(s), 2 other column axis/axes, 0 numeric column(s), 5 arm(s), 0 baseline-like, 0 removal-like / line 35: markdown grid: 3 row(s), 0 metric column(s), 2 other column axis/axes, 0 numeric column(s), 2 arm(s), 0 baseline-like, 0 removal-like
- scandy / evaluator_drift: predicted clear, label flagged — 3 stated value change(s), none in an evaluation-harness or parameter context — line 16: 80 → 250 / line 50: 1976 → 2025
- biofusion / unmeasured_trade_off: predicted not_checked, label clear — no cost-side improvement claim (latency, runtime, memory footprint, throughput, solver iterations) with a number attached
- breast-imaging-review / evaluator_drift: predicted clear, label not_checked — 3 stated value change(s), none in an evaluation-harness or parameter context — line 54: 2021 → 30 / line 149: 6.3 → 7.3
- breast-imaging-review / benchmark_coverage: predicted not_checked, label clear — 10 grid(s) counted 1 metric axis(es), 25 other axis(es), 1 numeric column(s) and 129 distinct arm label(s); that shape matches neither the thin grid the rule flags nor the wide grid the rule clears — line 117: markdown grid: 22 row(s), 0 metric column(s), 3 other column axis/axes, 0 numeric column(s), 22 arm(s), 0 baseline-like, 0 removal-like / line 157: markdown grid: 13 row(s), 0 metric column(s), 4 other column axis/axes, 1 numeric column(s), 12 arm(s), 0 baseline-like, 0 removal-like
- tellez2019 / evaluator_drift: predicted not_checked, label clear — no before-and-after value pair appears in the manuscript text, so there is no stated change to locate
- ebio2024 / evaluator_drift: predicted not_checked, label clear — no before-and-after value pair appears in the manuscript text, so there is no stated change to locate
- npjcm2026 / benchmark_coverage: predicted not_checked, label clear — 1 grid(s) counted 2 metric axis(es), 0 other axis(es), 2 numeric column(s) and 6 distinct arm label(s); that shape matches neither the thin grid the rule flags nor the wide grid the rule clears — line 49: markdown grid: 6 row(s), 2 metric column(s), 0 other column axis/axes, 2 numeric column(s), 6 arm(s), 0 baseline-like, 0 removal-like
- nbe2026 / unmeasured_trade_off: predicted clear, label not_checked — all 1 cost-side claim(s) name a quality or feasibility counter-metric nearby — line 13: turnaround: Published online: xx xx xxxx Deep learning models that infer clinically relevant biomarker status from **Check for updates** tissue images are being explored as rapid and low-cost alternatives to molecular testing. Here we show, through st… — counter-metric: accuracy, auroc

## Interpretation limits

- Labels are a reader's reading of the manuscript, not a venue decision or a proof; disagreement is a prompt to inspect the evidence, not an automatic bug.
- `missed clear` is the dangerous error: the check said `clear` on a case the reader marked `flagged`. `abstained` is `not_checked` on such a case, which is honest but not a pass.
- `false alarms` are `flagged` where the reader did not mark a failure; the well-formed line counts papers with no flagged labels that received any flag.
- PDFs use the simple text converter, no OCR. Pages flagged for OCR can lose text; those papers remain in the measurement but carry the note.
- Attribution corpus mode is text/grid-side. The live action also reads stored review claims, so corpus recall for attribution is a lower bound for papers whose only removal evidence is an engine-typed claim.
