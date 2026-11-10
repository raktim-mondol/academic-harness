---
name: experimental-design
description: Choose and generate a reproducible randomization or design-of-experiments schedule with the `design` tool — simple/block/stratified/cluster/crossover/minimization allocation, allocation and blinding codes, realized-balance diagnostics, full/fractional factorial, Plackett–Burman, central composite, and Box–Behnken designs.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Experimental Design

> **In Academic Harness:** `design` writes schedules under `.dsh/design/<slug>/`.
> A seed is required and stored; a schedule is reproducible from it. `balance`
> reports realized balance only. DOE output is a design matrix, not an analysis.

## Randomization

1. **Pick the unit and the question.** Participant, cluster, period, or
   repeated-measure design changes the unit of allocation. State the arms,
   allocation ratio, and any stratification factors before randomizing.
2. **Choose the method.**
   - `simple`: independent allocation; require n to be a multiple of the
     allocation total.
   - `block`: permuted blocks of `block_size`; keeps arms close within blocks.
   - `stratified`: block randomization within strata (`strata: [{name, n}]` or
     participant `stratum` fields).
   - `cluster`: allocate clusters, not participants; report cluster counts and
     sizes.
   - `crossover`: sequences such as `["AB","BA"]` (one-letter arms) or arrays
     of arm names; record periods and washout.
   - `minimization`: sequential allocation to reduce imbalance across supplied
     prognostic factors; ties are broken with the seeded RNG.
3. **Record codes.** The schedule includes per-participant allocation codes and
   arm-level blinding codes. These are records, not allocation concealment, and
   they do not implement a clinical workflow.
4. **Check balance.** `balance` reports arm counts, numeric SMDs against the
   first arm, categorical shares, and flags at |SMD| > 0.1 or a 10% share
   difference. It only assesses covariates you supplied; it cannot guarantee
   balance in unmeasured variables.

## DOE

- **Full factorial** for a small complete grid; **fractional factorial** with
  explicit generators (e.g. `D=ABC`) when runs are limited — read the defining
  relation and resolution before choosing it.
- **Plackett–Burman** screens many two-level factors for large main effects;
  it aliases main effects with two-factor interactions and cannot resolve them.
- **Central composite** and **Box–Behnken** fit quadratic response surfaces;
  the matrix is coded, and center points/alpha are reported.
- The design states its assumed model and aliasing. Randomize the run order
  with the stored seed; do not analyse the response inside this tool.

## Hand-off

Write the design, primary outcome, analysis model, and decision rules into
`preregister` before collecting data. Use `power_analysis` for sample size and
`analysis_run` for the actual analysis. Load `designing-the-analysis` for the
broader planning workflow and `experiment-designer` when a specialist should
critique the protocol.
