---
name: deep-review
description: Run the native `deep_review` tool for a Deep-Review-style multi-pass critique of a whole manuscript — cost estimate, segmented review with page/quote-anchored comments, scholar-peer questions, claim-evidence map, reproducibility checklist, and reference verification, with artifacts stored under `.dsh/deep-review/`. Use when the user asks for a deep, multi-pass, or pre-submission review of a full paper, or a second opinion beyond the session model.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Deep Review

> **In Academic Harness:** the native `deep_review` tool wraps the vendored
> Open Deep Review engine (`vendor/open-deepreview`). It runs under Node, stores
> every artifact under `.dsh/deep-review/<key>/`, and returns compact summaries.
> `review` and `verify_citations` run on the session model through the host LLM
> service — the same provider and model as the chat, with no separate key or
> endpoint. `estimate`, `pdf2md`, `status`, `show`, and `list` make no model
> call.

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

## Route a generic review request

A generic request — "review this paper", "what do you think of this manuscript",
"give me feedback" — does not say which kind of review is wanted. Do not silently
pick one. Ask:

> Do you want a deep review (multi-pass engine; I’ll estimate the cost first and
> it may take several minutes) or a normal session review (faster, written by
> this session’s model)?

- **Deep review:** continue with the workflow below — `estimate`, confirm the
  cost, then `review` and `show`.
- **Normal review:** delegate to the `peer-reviewer` subagent (or review inline
  when the request is small). Do not call `deep_review`.

Do not run `estimate` or `review` before the user has chosen the deep review.

## Workflow

### 1. Estimate the cost and confirm it

Always estimate before running a review:

```text
deep_review action=estimate path=paper/main.pdf topology=HIGH thinking_level=MEDIUM
```

The estimate is a heuristic based on page count, topology, and thinking level —
not a meter. Show the low/median/high range to the user and wait for explicit
confirmation. Never start a `review` unprompted, and never pick `EXTRA_HIGH` to
be safe: it multiplies cost and latency for a marginal quality gain.

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
parsed paper Markdown as `paper.md`. A full run can take minutes and send the
manuscript to the configured endpoint repeatedly (once per segment and pass);
warn the user before a `HIGH`/`EXTRA_HIGH` run of a long paper.

Topology and thinking levels:

| Setting | Passes / budget | When |
|---|---|---|
| `LOW` | 1 pass | Quick sanity check; accepts less coverage |
| `MID` | 2 passes | Default; most drafts |
| `HIGH` | 3 passes | Submission-grade or theory-heavy paper |
| `EXTRA_HIGH` | 4 passes | Rare; only when the user asks for maximum depth |

`thinking_level` controls the model's reasoning budget (`LOW`, `MEDIUM`,
`HIGH`). `HIGH` is expensive and only worth it for difficult theory or methods.

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
a fresh review, and estimate again first.

## State and artifacts

```
.dsh/deep-review/<key>/
  review.json       full engine result (comments, claims, checklist, questions, audit)
  review.md         rendered report
  paper.md          parsed PDF Markdown (pdf2md or review of a PDF)
  pdf-meta.json     page count, PDF type, OCR flags (pdf2md)
  citations.json    standalone verify-citations report
  estimate.json     last cost estimate
  meta.json         input hash, engine/model, params, last run, summary, artifact sizes
  runs.jsonl        append-only run history
```

`<key>` is derived from the workspace-relative path, so the same manuscript keeps
one directory across edits; `meta.json` stores the content hash used to flag
staleness. Re-runs overwrite the latest artifacts and append a run record. Use
`action=list` to see stored reviews and `action=status` for the current one.

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
