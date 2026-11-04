---
name: deep-review
description: Run the native `deep_review` tool for a Deep-Review-style multi-pass critique of a whole manuscript — segmented review with page/quote-anchored comments, scholar-peer questions, claim-evidence map, reproducibility checklist, and reference verification, kept as numbered rounds that `compare` can diff, plus four advisory evaluation-validity readings over the manuscript's own text and grids and an advisory dimension score with held-out/in-distribution provenance. Use when the user asks for a deep, multi-pass, or pre-submission review of a full paper, a second opinion beyond the session model, whether a revision closed the findings from an earlier review, whether a reported gain survives removing its mechanism, changing the evaluator, and reading the results grid against a baseline, or for an automated soundness/originality/clarity/significance reading on a declared scale.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.3"
  skill-author: Academic Harness
---

# Deep Review

> **In Academic Harness:** the native `deep_review` tool wraps the vendored
> Open Deep Review engine (`vendor/open-deepreview`). It runs under Node, stores
> every artifact under `.dsh/deep-review/<key>/`, and returns compact summaries.
> `review` and `verify_citations` run on the session model through the host LLM
> service — the same provider and model as the chat, with no separate key or
> endpoint. `validity` uses that same route for at most one critic call, and
> `critic: false` makes none. `pdf2md`, `status`, `show`, `compare`, and `list`
> make no model call; `estimate` is optional.

Use this skill for a full-manuscript critique produced by an external multi-pass
engine. It is not a fast proofread, not a systematic-review ledger, and not a
reporting-guideline verdict.

## Choose the right reviewer

| Need | Use |
|---|---|
| Multi-pass critique of a whole manuscript, anchored to pages | `deep_review` |
| Reproducible screening funnel, PRISMA counts, dual reviewers | `review` (systematic-review-ledger) |
| CONSORT/STROBE/PRISMA item-by-item reporting audit | `reporting_check` |
| A referee report written by this session's model | `peer-reviewer` subagent |
| Literature positioning or novelty search | `literature_search`, `peer-reviewer`, `literature-review` |

`deep_review` findings are advisory criticism. It does not decide acceptance and
does not replace the user's judgment.
For the stored-round-to-author-response handoff use `rebuttal-experiments`; for
an audit of reruns, protocols, references, and code alignment use
`integrity-audit`. Neither replaces the review or author decisions.

## Route every paper-review request

A paper-review request — "review this paper", "critique my manuscript", "give me
feedback", "write a referee report", "assess this draft" — does not tell you
whether the user knows the deep engine exists. Do not silently pick the normal
path, and do not assume the user knows `deep_review`. Always ask, describing both
options, unless the user explicitly chose deep or normal in this conversation:

> Do you want a deep review (multi-pass engine with page/quote-anchored comments,
> author questions, and reference checks; it may take several minutes) or a
> normal session review (faster, written by this session’s model)?

- **Deep review:** continue with the workflow below — confirm the run, then
  `review` and `show`.
- **Normal review:** delegate to the `peer-reviewer` subagent (or review inline
  when the request is small). Do not call `deep_review`.

Do not run `review` before the user has chosen the deep review.

Writing ends the same way: when a paper, manuscript, or technical document you
just wrote is finished, deliver the draft and then offer this choice — describe
what `deep_review` adds (multi-pass, page/quote-anchored comments, reference
checks; several minutes) and wait for the user's answer.
The user must accept before any review runs — never start one unprompted.

## Live progress

Each review runs as a background job owned by the session. While it runs, the
session header shows the job with a live stage/percentage line; expand it to
stream the engine log — segmentation, budgeting, per-segment verification,
synthesis, citation checks, report — plus each model call's route, duration, and
token usage. The finished job remains under **Finished** for later inspection,
and the review result includes `job_id`. Collapsing the output stops the live
stream, not the job; use the row's stop control to cancel, after which the tool
returns a cancellation error.

## Workflow

### 1. Confirm the run

Deep review runs on the session model, so there is no separate key or endpoint.
Confirm the scope and that the user wants the multi-pass run; it can take
several minutes. Never start a `review` unprompted, and never pick `EXTRA_HIGH`
to be safe: it multiplies run time for a marginal quality gain.

`estimate` is optional: use it only when the user asks for an engine-run
estimate. It makes no model call.

### 2. Run the review

```text
deep_review action=review path=paper/main.pdf topology=MID thinking_level=MEDIUM
```

Optional controls:

- `focus`: extra reviewer guidance, e.g. "concentrate on the causal claims,
  missing baselines, and the external validity of the benchmark". Max 4000 chars.
- `citations: false`: skip reference verification.
- `scholar_peer: false`: skip the summary, checklist, and author questions.
- `timeout_minutes`: 1–120; review defaults to 30.

The engine accepts PDF, TeX, Markdown, and plain text. For PDFs it also saves the
parsed paper Markdown as `paper.md`. A full run can take minutes and sends the
manuscript through the session model repeatedly (once per segment and pass);
confirm the scope before a `HIGH`/`EXTRA_HIGH` run of a long paper.

Topology and thinking levels:

| Setting | Passes / budget | When |
|---|---|---|
| `LOW` | 1 pass | Quick sanity check; accepts less coverage |
| `MID` | 2 passes | Default; most drafts |
| `HIGH` | 3 passes | Submission-grade or theory-heavy paper |
| `EXTRA_HIGH` | 4 passes | Rare; only when the user asks for maximum depth |

`thinking_level` controls the model's reasoning budget (`LOW`, `MEDIUM`,
`HIGH`). `HIGH` adds model work and latency and only helps difficult theory or
methods.

### 3. Read the compact result first

`review` returns severity counts, the top comments, question and flagged-citation
counts, quality-audit scores, and stored paths. Report the shape of the result
before drilling in. Do not paste the whole report into the conversation.

### 4. Drill in with `show`

```text
deep_review action=show path=paper/main.pdf section=summary
deep_review action=show path=paper/main.pdf section=comments severity=CRITICAL include_body=true
deep_review action=show path=paper/main.pdf section=questions
deep_review action=show path=paper/main.pdf section=checklist
deep_review action=show path=paper/main.pdf section=claims
deep_review action=show path=paper/main.pdf section=citations
deep_review action=show path=paper/main.pdf section=markdown max_chars=20000
```

- `comments` pages with `limit` (max 50) and `offset`; bodies are omitted unless
  `include_body: true` (clipped).
- `citations` covers only **flagged** references. Clean references are omitted by
  the engine, not by the plugin — say "no flagged references", never "all
  references verified".
- `markdown` returns the rendered report, capped (default 20k, max 60k chars).

### 5. Turn findings into revisions

For each finding you accept: locate the quoted passage, decide the edit, and make
it in the manuscript. Keep the engine's quote as the anchor; do not invent page
numbers. Route statistical concerns to `statistical-reviewer`, citation support
to `citation-checker`, and reporting items to `reporting_check`. After substantive
edits, `status` reports the stored review as stale; re-run only if the user wants
a fresh review, and confirm the run again.

### 6. Measure the revision with the round ladder

Every `review` is kept as a numbered round, so a revision is checkable instead of
remembered. After the user approves a second run:

```text
deep_review action=review path=paper/main.pdf          # round 2, round 1 stays on disk
deep_review action=compare path=paper/main.pdf          # latest vs previous
deep_review action=compare path=paper/main.pdf from=1 to=2
deep_review action=show path=paper/main.pdf section=rounds
```

`compare` reports closed, opened, and persisting findings with severity moves,
plus claim, checklist, and citation transitions. Read it with two cautions, and
state both to the user:

- Findings are paired by wording, then wording similarity (token overlap ≥ 0.6),
  then the quoted span. Comment ids are tried first but the engine re-issues them
  per run, so ids rarely match. `compare` prints a `Matched by` line naming the
  rule that paired each finding — read it before calling anything closed. A
  reworded criticism can still slip past pairing, so a closed finding is a lead,
  not proof the science improved.
- If `compare` says the manuscript bytes did not change, every difference between
  the rounds is reviewer variance. Measure that before crediting a revision with
  closing anything, and never average over it silently.

When the revision was guided by a prior round's rubric or report, pass
`rubric_round` to the next review so the round is recorded honestly as
`in_distribution`; otherwise it stays `held_out`. The kind appears in
`show section=rounds`, `compare`, and the stored score.

`compare` never accepts or rejects the paper, and the round ladder is not a
score to climb. Where the user wants the tool itself checked,
`node scripts/deep-review-calibration.mjs --report` summarizes stored rounds and
their agreement with real OpenReview decisions, reporting `not_checked` when the
sample is too small.

### 7. Check the validity of what the paper claims

`validity` asks the four questions the engine's critique leaves open — whether a
claimed gain survives removing its mechanism (`attribution`), whether a stated
before-and-after value change sits in the evaluation harness rather than the model
(`evaluator_drift`), how wide the results grid actually is (`benchmark_coverage`),
and whether a quality or feasibility counter-metric stands beside a speed, memory,
or iteration gain (`unmeasured_trade_off`) — by counting keywords and grid shapes
in the manuscript itself. It needs a stored review, reads the round named by
`round` (latest by default) against the current manuscript text, and answers
`clear`, `flagged`, or `not_checked` for each check.

```text
deep_review action=validity path=paper/main.pdf                   # latest round, one critic call
deep_review action=validity path=paper/main.pdf round=1 critic=false
deep_review action=show path=paper/main.pdf section=validity
```

Read it with two cautions, and state both to the user:

- A `flagged` state names an absence in the text, not a flaw in the work: the
  counters read words and grid shapes, and the vocabularies and cut-offs are the
  plugin's own, because the paper states the four criteria and no lexicon or
  threshold. A paper that ablates off-line has nothing here to find. `not_checked`
  is not a pass either — the manuscript carried too little to judge — so never tell
  the user a paper is clean because nothing was flagged. Reference lists and
  leading PDF line numbers are excluded before counting, and a review/synthesis
  with no mechanism of its own answers `not_checked` for attribution rather than
  `flagged`; a `clear` is an affirmative reading of the text, not proof.
- The critic is at most one model call, on the session route, and it can only
  annotate: it never changes a state, and `critic: false` makes no call at all.
  Where the session has no model route, the call fails, or the reply is not JSON,
  the deterministic checks still complete and the critic records `not_checked` with
  the reason.

`validity` never accepts or rejects the paper, and its four states are readings
from counting rather than a score to climb; nothing here gates, and only
`ah_check` blocks. It writes `extra_checks.json` beside the review and appends its
own notebook entry tagged `validity`, so do not log that pass yourself.
`provenance_audit` indexes the artifact: a `flagged` validity check appears as
an `unverified` claim, a `not_checked` check stays `not_checked`, and `arms`
reports the validity flags beside the citation column.

### 8. Read the advisory score

`score` makes one bounded model call over a stored round and returns four
dimension readings on a declared numeric scale: `soundness`, `originality`,
`clarity`, and `significance`. Every dimension must cite one to four stored
comment ids; a dimension without a numeric reading or a valid citation is
`not_checked`, never guessed. The overall is the model's score or the mean of
the scored dimensions (source recorded), plus confidence and limitations.

```text
deep_review action=score path=paper/main.pdf
deep_review action=score path=paper/main.pdf round=1 rubric="Score 1–10 ..."
deep_review action=show path=paper/main.pdf section=score
```

- The scale and rubric source are in the artifact: a per-call `rubric`, the
  `DEEP_REVIEW_DEFAULT_RUBRIC` setting, or the built-in 1–5 rubric. A numeric
  range in the rubric text sets the scale.
- `evaluator_kind` is `held_out` by default. Pass `rubric_round` on `review`
  when a prior round's rubric or report fed the revision; that round is
  `in_distribution`. Old rounds and v1 stores are `held_out` with
  `evaluator_kind_source: inferred`.
- A missing model route, failed call, or non-JSON reply completes with
  `state: not_checked` and a reason. `not_checked` is not a pass.
- The score is an automated reviewer's reading, **not an acceptance decision, a
  venue outcome, or a gate**. Read a low dimension as a prompt to inspect its
  cited comments, not as a target to optimize. When both evaluator kinds exist,
  quote the held-out reading as the honest headline. The Phase 0 calibration
  report can correlate stored scores with real decisions and prints
  `not_checked` below its sample floor.
- `DEEP_REVIEW_MAX_ROUNDS` and the per-review ceiling setting are optional
  review budgets; raise or clear them rather than bypassing a refusal.

## State and artifacts

```
.dsh/deep-review/<key>/
  review.json       full engine result for the latest round
  review.md         rendered report for the latest round
  rounds/*.json     per-round finding digest (matching keys, counts, claims, checklist)
  rounds/*.md       per-round rendered report
  paper.md          parsed PDF Markdown (pdf2md or review of a PDF)
  pdf-meta.json     page count, PDF type, OCR flags (pdf2md)
  citations.json    standalone verify-citations report
  estimate.json     last optional engine estimate
  extra_checks.json stored evaluation-validity checks (states, inventory, evidence, critic)
  score.json        stored advisory dimension score (scale, rubric source, dimensions, comment ids)
  meta.json         input hash, engine/model, params, last run, summary, round index, validity and score summaries
  runs.jsonl        append-only run history
```

`<key>` is derived from the workspace-relative path, so the same manuscript keeps
one directory across edits; `meta.json` stores the content hash used to flag
staleness, `rounds[]`, and `latest_round`. Re-runs replace `review.json` and
`review.md` with the newest pass but keep every earlier round under `rounds/`. A
store written before rounds (schema v1) reads as one round; the next `review`
materializes that pass into `rounds/` first, so upgrading a workspace never loses
its only review. Use `action=list` to see stored reviews and `action=status` for
the current one, including the round ladder and its cumulative model calls.

## Failure modes

- **No session model route** — the tool needs a calling agent with a selected
  provider/model, and a `dsh` build that exposes the `llm` service. Start it
  from a normal chat session; switching the chat model changes the reviewer.
- **Model/provider error** — the bridge surfaces the host's failure code
  (auth, quota, context limit) instead of inventing a second key; fix the
  session model configuration and retry.
- **Native PDF module missing** — `@firecrawl/pdf-inspector` ships a platform
  binary; reinstall the plugin if the error names the optional dependency.
- **Node too old** — installed under `node_modules`, the engine needs Node
  ≥ 22.15; the tool returns an explicit error rather than a stack trace.
- **Timeout** — raise `timeout_minutes` only after confirming with the user;
  a timed-out run writes a failed record to `runs.jsonl` and leaves prior
  artifacts intact.

## Reporting

Lead with the severity distribution and the few findings that change the paper's
credibility. Quote the anchored location. Separate what the engine found from
your own assessment. Never present the review as a submission guarantee, and
never claim the manuscript is free of problems because the engine found none.
