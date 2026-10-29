---
name: risk-of-bias-appraisal
description: Appraise included studies for risk of bias with the native `review` ledger — RoB 2, ROBINS-I, QUADAS-2, and Newcastle-Ottawa domains, named reviewers, verbatim quotes, consensus reconciliation, agreement statistics, and rob-table/rob-summary/rob-figure exports. Use when a systematic review needs a risk-of-bias assessment, dual-reviewer appraisal, or an auditable appraisal table.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Risk-of-Bias Appraisal

> **In Academic Harness:** appraisal lives in the native `review` tool. It
> records reviewer judgements under `.dsh/review/<slug>/appraisal.jsonl`, with
> the instrument definition frozen in `instruments.json`. The tool never
> judges a study itself and never returns a quality verdict.

Use this skill after the screening funnel has produced full-text includes. For
the screening ledger, use `systematic-review-ledger`. For a general critique of
a manuscript, use `peer-reviewer` instead — an appraisal is a structured,
instrument-bound judgement, not a review essay.

## Instruments

| Instrument | Use for | Domains | Judgements |
|---|---|---|---|
| `rob-2` | randomised trials | 5 + derived overall | low / some concerns / high |
| `robins-i` | non-randomised interventions | 7 + derived overall | low / moderate / serious / critical / no information |
| `quadas-2` | diagnostic accuracy | 4 domains, 7 risk-of-bias/applicability cells | low / unclear / high |
| `nos` | cohort or case-control | 3 star-count domains | 0 to the domain maximum |

RoB 2 and ROBINS-I derive the overall from the domain judgements. QUADAS-2 and
Newcastle-Ottawa have no derived overall: report the domain cells, and report
the NOS star total as a count, not a grade.

## Reviewer identities

- Use `human:<name>` for people and `ai:<model>` for model judgements. They are
  stored and reported separately.
- With a declared roster (`review start reviewers: [...]`), each reviewer
  screens and appraises independently; no `override` is needed for a second
  reviewer. A declared roster is also the appraisal panel: every declared
  reviewer must judge every domain before a record counts as complete, and
  `appraisal_status` lists who is missing. Do not declare a screener in the
  roster unless they will appraise too.
- `override: true` replaces only that reviewer's earlier event and needs a
  reason. Both events stay in the log.
- Agreement is human-vs-human by default. AI-vs-human and AI-vs-AI pairs are
  reported separately and are never folded into the human kappa.

## Workflow

### 1. Freeze the instrument

```text
review action=start slug=<name> question="…" reviewers=["human:alice","human:bob"] instruments=["rob-2"]
```

`start` freezes the full template. A second version of the same instrument is
rejected; start a new review instead. If no instrument was declared, the first
`appraise` freezes it. Once frozen, template edits cannot change a running
review.

### 2. Appraise one domain at a time

```text
review action=appraise slug=<name> id=r0001 instrument=rob-2 domain=d2 \
  judgement=some_concerns reviewer=human:alice \
  quote="Participants and assessors were aware of the assignment." \
  location="Methods, p. 4" paper=<papermemory-key>
```

- `low`/`high` for RoB 2 and QUADAS-2, and `low`/`critical` for ROBINS-I,
  require a verbatim quote and a location. Other judgements do not.
- With `paper`, the tool calls `papermemory_quote_check`. A quote absent from a
  resolved paper, or found only in the bibliography, is rejected and nothing is
  stored. If the paper cannot be resolved or the check cannot run, the event is
  stored `unverified` with the reason; say so in the report.
- Without `paper`, a quote is stored `unverified`. Do not present it as verified.
- `signalling` answers are optional supporting detail, keyed by question id.
  They are never converted into a domain judgement.
- Read the study before judging. Do not infer a domain from the abstract alone.

### 3. Handle the overall judgement

- RoB 2: any `high` → `high`; otherwise any `some_concerns` → `some_concerns`;
  otherwise `low`.
- ROBINS-I: worst domain, with `no_information` between `moderate` and
  `serious`. This ordering is a local, documented rule; state it when reporting.
- The derived overall is not stored. To override it, appraise
  `domain=overall` with a reason; the override is stored as an explicit event.

### 4. Reconcile disagreements

```text
review action=reconcile slug=<name> scope=appraisal id=r0001 instrument=rob-2 \
  domain=d2 judgement=high reviewer=human:carol reason="Consensus after discussing masking."
```

`reconcile` requires a current conflict or reopened judgement and a reason. The
event records whether the adjudicator was one of the disagreeing reviewers
(`consensus`) or outside the pair (`third_reviewer`). Originals are kept. A later
disagreeing appraisal reopens the key.

### 5. Check completeness, then agreement

```text
review action=appraisal_status slug=<name> instrument=rob-2
review action=agreement slug=<name> scope=appraisal instrument=rob-2 weighting=quadratic
```

- `appraisal_status` reports per-record/per-domain completeness, missing
  reviewers, conflicts, and appraisals outside the included population.
- `agreement` reports percent agreement, Cohen's κ, a normal-approximation 95%
  CI, N, and dropped ratings. Use `linear` or `quadratic` weights for ordinal
  scales; star counts default to linear. For more than two human raters it is
  pairwise only — Fleiss' κ is not implemented.
- Report κ with its marginals and the prevalence caveat. High percent agreement
  with low κ is possible when categories are skewed. κ is not a verdict.

### 6. Export

```text
review action=export slug=<name> format=rob-table table_format=markdown
review action=export slug=<name> format=rob-summary table_format=csv
review action=export slug=<name> format=rob-figure overwrite=true
```

- `rob-table` — one row per included study; domain cells, overall and its basis,
  status. NOS adds `total_stars`.
- `rob-summary` — counts per domain and judgement, plus conflict and pending.
- `rob-figure` — `rob-traffic-light.svg` and `rob-summary.svg` through
  `python-helpers/rob_figure.py` (matplotlib; if missing, install the helper
  environment). Exports refuse to overwrite unless `overwrite: true`.
- The table and CSV name the reviewers behind each resolved row and count
  unverified quotes; the figure note repeats both, with AI reviewers keeping
  their `ai:` prefix.
- Exports contain recorded judgements and completeness counts. They never say
  "low risk", "high quality", "compliant", or "ready for submission".

## Subagent batches

- One reviewer identity per subagent (`ai:<model>` or a delegated `human:<name>`).
- Give the subagent the study text, instrument id, domain id, the paraphrased
  domain prompt, and the evidence rule. Do not give it your tentative judgement.
- Require a quote for every judgement that needs one, and reject a batch that
  omits it rather than "fixing" it in the ledger.
- Appraise domains independently; do not let one domain's verdict steer another.
- Record the batch as that subagent's reviewer identity so agreement can be
  computed later.

## Rules

- Never appraise a record that is not a resolved full-text include.
- Never convert signalling answers into a judgement; the answer algorithms are
  not implemented.
- Never edit the ledger files by hand.
- Never report a derived overall as an explicit reviewer decision.
- Never call a domain or an overall "low risk" without saying it is a recorded
  reviewer judgement under a named instrument.
- AI judgements are labelled as AI everywhere, including exports and agreement.
