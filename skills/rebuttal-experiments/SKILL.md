---
name: rebuttal-experiments
description: Use when reviewer points need a kept ledger of what the revision actually closes — stored reviews to import, supplementary experiments to plan per point, existing runs to link as evidence, author answers and declines to record, coverage to read, and a response-letter skeleton to draft. Covers import, plan, link, respond, decline, coverage, draft, export, and status. Do not use for rebuttal strategy or tone (that is `rebuttal-guidance`), for the engine's response letter inside an `ah.yaml` project (that is `ah_review_respond`), or for running the experiments themselves.
allowed-tools: Read Write Edit Bash
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Rebuttal experiments ledger

> **In Academic Harness:** `rebuttal` keeps state under
> `.dsh/rebuttal/<slug>/`. It never fetches and never executes: imported
> points come from a stored `deep_review` round, `ah_review` items, or
> openreview reviews the session already has; every link points at an
> existing `experiment_log` run or a hashed `analysis_run` by id. Coverage is
> an advisory reading; only `ah_check` blocks.

Use this when the question is **"which reviewer points does this revision
actually close, and where is the evidence?"**, not merely how to phrase a
reply. The ledger pairs every imported point with the tasks planned for it,
the runs linked to those tasks, and the author's own answers or declines —
so a claim of coverage is checkable against ids and digests, not prose.

The paper's Rebuttal Planner instantiated `N_t` supplementary experiments
and integrated their results into the manuscript **with no performance gate
at all**. This ledger never computes `N_t` and never instantiates an
experiment; it caps planned stubs with `REBUTTAL_MAX_TASKS` (default 20) in
Settings instead. A supplementary result that fails to help — an
`experiment_log` verdict of `bad` or `engineer`, a `spec_drift` state, a
drifted digest, a non-zero `analysis_run` exit — is recorded beside the
point it was run for, not hidden, and it never reduces coverage.

## Workflow

1. **Import the points.** One source per call; the first import writes the
   round definition.

   ```text
   rebuttal action=import slug=iclr-2027-r1 source=deep_review
     deep_review_key=paper/main.tex manuscript=paper/main.tex
   ```

   A stored `deep_review` round (or `ah_review=R1` for engine items, or
   `reviews=[...]` — the openreview output this session already has) turns
   into points `p0001…`, each keeping its reviewer identity and
   `evaluator_kind`. A re-import dedupes by source + native id and reports
   drift; it never rewrites history.

2. **Plan one stub per point that needs evidence.** Dataset, baseline arm
   (`reproduced` or `reported` — never mixed), metric with direction,
   replicate count with a declared basis or a supplied `power_analysis`
   result, expected evidence type.

   ```text
   rebuttal action=plan slug=iclr-2027-r1 point_id=p0002 dataset=D3
     baseline_ref=reproduced metric=accuracy metric_direction=higher
     replicates=8 replicates_basis=power_analysis power={...}
     experiment_slug=bench evidence=metric_table
   ```

   The cap is re-derived inside the lock on every plan; when it is reached,
   consolidate stubs or answer the point without an experiment.

3. **Link runs that already exist.** The numbers come from the linked run,
   never from a copy.

   ```text
   rebuttal action=link slug=iclr-2027-r1 task_id=t0001
     experiment_slug=bench experiment_run_id=x0007
   ```

   An `experiment_log` link reads metrics live by id; an `analysis_run` link
   needs hashed outputs or artifacts plus your `reading`. Each link pins a
   SHA-256 digest of the whole run, so later drift is visible.

4. **Record the author's own answers and declines.** `respond` stores the
   author's words citing link ids and recorded `manuscript_diff` change ids;
   `decline` records a decline the author already made.

   ```text
   rebuttal action=respond slug=iclr-2027-r1 point_id=p0002
     response="..." link_ids=["l0001"] change_slug=revision-1
     change_ids=["ch-003"]
   rebuttal action=decline slug=iclr-2027-r1 point_id=p0004
     reason="..." ah_item=R1.2
   ```

   A decline with `ah_item` is verified against the engine's live `declined`
   status — run `ah_author action=decline` first. Without one it is stored
   as an author-recorded decline and always labelled unverified.

5. **Read the coverage.**

   ```text
   rebuttal action=coverage slug=iclr-2027-r1
   rebuttal action=coverage slug=iclr-2027-r1 deep_review_key=paper/main.tex
     deep_review_round=2
   ```

   Each point is `answered`, `answered_asserted`, `declined_verified`,
   `declined_recorded`, or `unaddressed`, with its tasks, links, verdicts,
   and digest states beside it. The second form pairs the imported points
   against a newer `deep_review` round: which closed, which are still
   present, and — when the manuscript bytes are identical — which movements
   are reviewer variance, not revision.

6. **Draft and hand off.** `draft` renders a response-letter skeleton
   (markdown or latex) that cites only recorded hunks and linked artifacts,
   returns the `items` array for `manuscript_diff action=letter`, and lists
   the `ah_review_respond` handoff for engine items. Nothing is written
   without `out`.

7. **Close the loop.** After revising, run a fresh `deep_review` round, then
   read `coverage` with that round and `export format=markdown` for the
   artifact. `status` reports the whole ledger at any time.

## Rules

- **No fetch.** The tool makes no network call. Run `openreview` yourself
  and pass its `reviews` array or a workspace file; `forum_id` on this tool
  is refused on purpose.
- **No execution.** It never runs or creates an experiment or analysis.
  Link the run that already exists, by id; a rerun is a new run id, so link
  that one instead of rewriting the link.
- **No invented prose or numbers.** Response text, decline reasons,
  replicate bases, and readings are always the author's or caller's, stored
  as given; every metric the tool surfaces is read live from a linked
  ledger. Never draft reviewer prose yourself and never quote a number that
  is not in a linked run.
- **Declines are verified, not created.** The ledger records a decline the
  author already made. With `ah_item` it must match the engine's live
  `declined` status; without it the decline is labelled author-recorded and
  unverified. Say which of the two paths a decline took; never infer one.
- **Unresolved is not unanswered.** An answer whose cited change id no
  longer resolves stays recorded — the point reads `answered_asserted`, not
  `unaddressed`, and `draft` lists the unresolved ids. A drifted digest or a
  stale version pair is flagged `EVIDENCE STALE`; it is the flag to fix, not
  a point to re-open from scratch.
- **`N_t` is never instantiated.** No replicate count, budget, or task here
  comes from a paper-side formula. The stub cap is `REBUTTAL_MAX_TASKS`,
  Settings-only; a plan refused at the cap is consolidated or answered
  without an experiment, never raised by argument.
- **Inside an `ah.yaml` project the engine is authoritative** for item
  status and the response letter. This ledger keeps its own evidence-linked
  reading beside it; when the two disagree, the warning names both and you
  report the divergence — never silently pick a side.
- **`rebuttal-guidance` supplies strategy; this skill keeps the ledger.**
  Use that skill for reviewer-mindset matching and per-concern plans, this
  one for the import → plan → link → respond → coverage → draft → re-review
  record. Neither writes the other's deliverable.
