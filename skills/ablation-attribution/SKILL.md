---
name: ablation-attribution
description: Use when a paper or method claims a gain from a component and you need a frozen removal grid, records linked to hashed runs, paired deltas against a reference, and an advisory attribution reading with a human verdict. Covers start, plan, record, report, verdict, prune, show, status, and export.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Ablation and attribution

> **In Academic Harness:** `ablation` keeps state under
> `.dsh/ablation/<slug>/`. It never runs an experiment: every record points at
> an existing `experiment_log` run or a hashed `analysis_run`. The attribution
> reading is advisory; only `ah_check` blocks.

Use this when the question is **"does the gain survive removing this
component?"**, not merely whether another run moved a metric. The ledger makes
the removal grid explicit before results are seen and keeps every number tied
to a stored run.

## Workflow

1. **Bind the method and champion idea.**

   ```text
   ablation action=start slug=solver question="Does warm start carry the gain?"
     idea_id=idea-017 idea_source=coscientist/lr-sweep
     method={"name":"Warm-start solver","description":"reuse the initialized cache"}
   ```

   The champion id comes from the `coscientist` tournament; `start` is
   write-once.

2. **Freeze the plan.** One reference arm (usually `full`), then one arm per
   removed component. Each removal arm names the component, code path or
   module, and the metric changes it expects.

   ```text
   ablation action=plan slug=solver
     plan={"reference_arm":"full","datasets":["D1","D2"],
           "metrics":[{"name":"accuracy","direction":"higher"},{"name":"latency","direction":"lower"}],
           "replicates":2,
           "arms":[{"id":"full"},
                   {"id":"no-warm","component":"warm_start","code_path":"solver.py:init",
                    "expected":[{"metric":"latency","change":"increase"}]}]}
   ```

   The plan is frozen once; do not rewrite it after seeing results.

3. **Record links, not numbers.** For an `experiment_log` run the metrics come
   from the run itself; for an `analysis_run` the run must have hashed outputs
   and you supply the metric reading.

   ```text
   ablation action=record slug=solver arm=no-warm dataset=D1 replicate=1
     experiment_slug=bench experiment_run_id=x0007
   ```

4. **Read the paired report.**

   ```text
   ablation action=report slug=solver
   ablation action=status slug=solver
   ```

   Each row compares the removal arm with the reference on the same dataset and
   replicate. Ties and missing cells are listed, not dropped. A component is
   read as `attributed` only when every paired expected metric changes in the
   declared direction; `unattributed` when none does; `partial` for mixed
   evidence or missing cells; `not_checked` without paired evidence.

5. **Record the human verdict and prune.**

   ```text
   ablation action=verdict slug=solver verdict=unattributed reason="cache removal is a tie"
   ablation action=prune slug=solver arm=no-cache reason="tie, not worth another replicate"
   ```

   `good | refine | unattributed` is the decision, not the reading. Pruning is
   append-only and excludes the arm from the attribution reading.

6. **Export.** `export format=markdown|json|csv` produces the artifact a later
   attribution check or `ah_fact`/`ah_claims_bind` can read.

## Rules

- A missing cell or a tie is not evidence of attribution. Report it.
- No attribution reading is a scientific claim; the human verdict is separate.
- Do not copy numbers by hand into the ledger: link the run, and let an
  `analysis_run` record carry the source digest and hashed outputs.
- Do not prune an arm to make a reading cleaner; prune because the arm is no
  longer worth running, and keep the event.
