---
name: reproducible-analysis
description: Run analyses so their numbers can be audited later — freeze an analysis plan, execute through the `analysis_run` ledger (argv commands, hashed inputs/outputs, environment allowlist, redacted logs, hard timeouts), diff runs against the plan, download datasets with provenance via `dataset_get`, profile local files with `data_profile`, and ship a reader-facing `repro_package` (manifest, environment, Dockerfile, CITATION.cff, RO-Crate). Use whenever a result may be reported, published, or revisited after this session.
allowed-tools: Read Write Edit Bash
license: MIT license
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
   exclusions, stopping rules, software, and seed. The plan is frozen at the
   first `run`; changing it later requires `new_version: true` plus a reason,
   and the old plan and runs stay.

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
`deposit` is Zenodo-only: preview first, then `confirm: true` with the
unchanged `preview_hash`; it creates a **draft** and never publishes.

## Rules

- Never edit `plan.jsonl`, `runs.jsonl`, or a built package by hand.
- Never present a run's exit code 0 as scientific validity — it evidences that
  the recorded command ran in the recorded environment.
- Never re-plan silently: a changed analysis is a new plan version with a
  reason, and readers of the package see both.
- `analysis_run` uses the host's existing permission model; it is not a
  sandbox and not a privilege boundary.
