---
name: power-and-sample-size
description: Plan a study's sample size, power, or smallest detectable effect with the native `power_analysis` tool; convert effect sizes; correct for multiple comparisons; simulate power for designs without a closed form. Use when the user asks how many participants or samples they need, whether a study is adequately powered, what effect they could detect, how to adjust for many tests, or to justify a sample size in a protocol, grant, or pre-registration.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Power and Sample Size

Use `power_analysis` for every power, sample-size, effect-size, or multiplicity number. Do not compute them by hand or quote them from memory, and do not hand the user a number without the assumption behind it.

## The one question that decides everything

**Where does the effect size come from?** The sample size is only as good as that number. Ask the user, in this order of preference:

1. `smallest_effect_of_interest` — the smallest difference that would matter scientifically or clinically. This is the best basis for a confirmatory study.
2. `literature` — an estimate from a published study. Give `source_ref` (the DOI or PaperMemory id). Published effects are inflated by selection; say whether a conservative value (the lower confidence bound) was used. Find the paper with `literature_search`, and read the number from the stored text with PaperMemory `quote_check`, not from a snippet.
3. `pilot` — an estimate from the user's own pilot. Pilot estimates are noisy; suggest planning for the lower end of the interval.
4. `convention` — Cohen's small/medium/large. Acceptable only when nothing else exists, and it is reported as a convention. Never present it as evidence about this study.

If the user has none of these, say so and offer `sensitivity` instead: "with n per group you could detect an effect of at least d = …".

## Workflow

1. **Name the design and the primary analysis.** Which test will actually be run (`t_two_sample`, `t_paired`, `anova_oneway`, `proportion_two`, `chisq`, `correlation`, `regression`, `logrank`, `equivalence_means`, `noninferiority_means`)? Power for one test does not carry over to another.
2. **Fix alpha and tails** before looking at anything (usually 0.05, two-sided). If several primary comparisons are planned, use `correct` for the per-test alpha (`planning_alpha_per_test`) and plan with that.
3. **Solve** with `action: "power"`. Give `effect_source`. For proportions give `options.p1` and `options.p2`; for a log-rank test the answer is *events*, so give `options.event_prob` to turn it into participants.
4. **Report both numbers.** The unrounded n and the rounded n (always rounded up), the power the rounded n actually achieves, and the assumptions the tool echoes (test, tails, alpha, variance, allocation).
5. **Inflate for reality separately.** Dropout (`options.dropout`) and clustering (`options.cluster_size`, `options.icc`) change how many to *enrol*; they do not change the analytic n. Report `enrol` as its own line.
6. **Stress it.** `sensitivity` with a `curve` shows how power falls if the true effect is smaller. For equivalence/non-inferiority, clustered, repeated-measures, or unusual designs, confirm with `simulate` (a `seed` is required) and tell the user a statistician should review it.
7. **Record it** in the notebook and in the pre-registration (the `preregistering-analysis` skill): test, alpha, effect size and its source, power, n, and the tool's method line. In a manuscript, write the sample-size justification from those lines.

## Rules the tool enforces, and you must not work around

- **No post-hoc power.** Power computed from the effect observed in the same study is a function of the p-value and adds nothing. If the user asks "was my study adequately powered?" after the fact, give the confidence interval of the effect, or `sensitivity` ("this sample could detect d ≥ …"). Do not rename the observed effect as `pilot`.
- **An effect size of zero, or a hazard ratio of one,** has nothing to detect.
- A power target that cannot be reached is reported as such; do not loosen alpha or the effect to make it work without telling the user.

## Effect sizes and conversions

`effect_size` converts between d, r, f, f², η², odds ratio, h, and w, and computes them from means and SDs (with Hedges' g and an approximate interval), t, F, χ², or two proportions. Conversions between d and r/f assume two equal groups; the result says so. Use it to put a published effect on the scale the planned test needs.

## Multiple comparisons

`correct` adjusts p-values (Bonferroni, Holm, Hochberg, Benjamini–Hochberg, Benjamini–Yekutieli). Say which family of tests is being controlled and whether the aim is family-wise error (Holm/Bonferroni) or false discovery rate (BH/BY). Hochberg and BH assume independence or positive dependence; BY does not.

## What this is not

A planning aid for a design the user has chosen. It does not choose the design, and it does not make an underpowered study acceptable. State limits plainly.
