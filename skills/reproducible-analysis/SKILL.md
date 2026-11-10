---
name: reproducible-analysis
description: Run analyses so their numbers can be audited later — freeze an analysis plan, execute through the `analysis_run` ledger (argv commands, hashed inputs/outputs, environment allowlist, redacted logs, hard timeouts), declare reported numbers and verify them against a re-execution (`repro_check.json`), check frozen task rules and exclude violating runs, diff runs against the plan, download datasets with provenance via `dataset_get`, profile local files with `data_profile`, and ship a reader-facing `repro_package` (manifest, environment, Dockerfile, CITATION.cff, RO-Crate). Use whenever a result may be reported, published, or revisited after this session.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Reproducible Analysis

> **In Academic Harness:** the ledgers are native tools — `analysis_run`,
> `dataset_get`, `data_profile`, `repro_package` — with state under
> `.dsh/analysis/`, `.dsh/data/`, `.dsh/repro/`, and package output under
> `package/<slug>/`. The tools record what ran; they never interpret the
> science or claim the result is correct.

Use this skill before executing an analysis whose numbers might appear in a
report, manuscript, or decision. For one-off scratch computation with no
lasting claim, plain tooling is fine; the moment a result is reportable, move
it into the ledger.

## Before the first run

1. **Profile the data.** `data_profile path=… target=… split=…` on each input.
   Read the findings: split overlap and near-deterministic target association
   are leakage *risks* to resolve before analysis, not automatic exclusions.
   `not_checked` items (PHI, provenance) stay the author's responsibility.
2. **Acquire data with provenance.** `dataset_get action=get doi=…` to inspect
   files/licenses, then `download` into `data/<slug>/`. Checksum mismatches are
   recorded as `verification_failed` and the file is kept for inspection —
   never quietly re-download until it matches. An unstated license is flagged;
   do not assume one.
3. **Freeze the plan.** `analysis_run action=plan` with question, hypotheses,
   inputs, outputs, methods, alpha, corrections, missing-data rules,
   exclusions, stopping rules, software, and seed. Add `task_rules` when the
   benchmark has constraints (no external data, a required file format, a
   value that must stay fixed): a rule can carry a machine `check` over an
   output path or wait for caller evidence. The plan is frozen at the first
   `run`; changing it later requires `new_version: true` plus a reason, and
   the old plan and runs stay.

## Running

```text
analysis_run action=run slug=primary kind=python \
  command=["python3","analysis/main.py"] \
  env={"ANALYSIS_SEED":"42"} timeout_ms=600000
```

- `command` is an argv array — the tool never uses a shell. Quote-free tokens
  are the point: no injection, no platform surprises.
- The environment is an allowlist plus your explicit `env`; ambient secrets are
  not forwarded, and explicit values are redacted from stored logs. Do not put
  secrets in `env` anyway — logs are shared with readers of the package.
- Network is off by convention (`no_proxy=*`), which is a guardrail, not a
  firewall; `network: true` is recorded in the manifest.
- A nonzero exit or timeout is *recorded*, not hidden. Investigate it; do not
  re-run until green and pretend the earlier attempts never happened.
- `kind: "notebook"` executes via jupyter/papermill and stores the executed
  notebook under the run. A copied notebook output is not evidence; the
  manifest is.

## Checking reported numbers

Declare the number you are going to report **before** the re-execution, and say
which reference it is:

```text
analysis_run action=expect slug=primary expected_reference=reported \
  expected=[{name:"AUROC",value:0.812,path:"results/metrics.json",
             format:"json",key:"metrics.auroc",tolerance:0.001}]
analysis_run action=run slug=primary command=["python3","analysis/main.py"]
analysis_run action=verify_scores slug=primary
```

- `reference: reported` is the paper/table number; `reference: reproduced` is a
  baseline this session re-ran. Never mix them in one comparison.
- `verify_scores` reads only outputs the run hashed. It writes
  `runs/<id>/repro_check.json` with `"reproduction": true|false|null` and
  reports `not_checked` when the run failed, timed out, used a different plan,
  changed its entrypoint, or changed its interpreter — not a silent mismatch.
- Use `allow_environment_drift` / `allow_entrypoint_change` only when you can
  say why the change is irrelevant; the drift is still recorded.
- A match is evidence for the declared numbers, not for the science, other
  metrics, or other datasets.

## Compliance

`analysis_run action=compliance` checks the latest run against the plan's
frozen `task_rules`. A rule with a `check` is evaluated against a hashed output;
a rule without one needs `evidence=[{rule_id, satisfied:true|false}]`. The
verdict is `violated`, `not_checked`, or `compliant`. A violating run is
**discarded**, not refined: `experiment_log` excludes it from `best` and
`dominance`, and `repro_package` leaves it out of the build and deposit under
`excluded_runs`. A non-zero exit is `not_checked`, not a violation.

Before declaring expectations, run `repo_audit action=probe` on the code
repository. If it reports no benchmark-like entrypoint, `verify_scores` will
stay `not_checked` until one is documented; do not invent one.

## Auditing

- `analysis_run action=diff run_id=…` compares a run against the current plan
  and input hashes — the "did anything actually change?" question.
- `diff run_id=a compare_run_id=b` compares two runs field by field.
- `export format=markdown` writes the run report (plan hash, command,
  environment, hashes, log paths) with the standing caveat that it is
  reproducibility evidence, not a guarantee.

## Shipping

`repro_package action=plan` freezes the inventory (authors, analyses/run ids,
experiments, dataset slugs, code files, manuscript, license, funder), `build`
writes the package (manifest.json with SHA-256 per file, environment/,
generated Dockerfile, README with run order and data availability,
CITATION.cff, codemeta.json, ro-crate-metadata.json, checksums.sha256), and
`verify` re-hashes it. Data are referenced, not copied, unless
`include_data: true`. Warnings (missing license, failed run included, dataset
not copied) are surfaced in the build result — resolve or disclose them.
A run excluded by a compliance violation is omitted and listed under
`excluded_runs` with the violated rule ids; do not add it back by hand.
`deposit` is Zenodo-only: preview first, then `confirm: true` with the
unchanged `preview_hash`; it creates a **draft** and never publishes.

## Rules

- Never edit `plan.jsonl`, `runs.jsonl`, or a built package by hand.
- Never present a run's exit code 0 as scientific validity — it evidences that
  the recorded command ran in the recorded environment.
- Never present `reproduction: true` as scientific validity either: it is
  evidence for the declared numbers, at the declared tolerance, in the declared
  environment. A `not_checked` repro is not a pass.
- Never compare a number against the wrong reference: keep `reported` and
  `reproduced` baselines distinct.
- Never re-plan silently: a changed analysis is a new plan version with a
  reason, and readers of the package see both.
- `analysis_run` uses the host's existing permission model; it is not a
  sandbox and not a privilege boundary.
