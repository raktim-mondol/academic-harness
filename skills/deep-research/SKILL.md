---
name: deep-research
description: >-
  Runs a deep, survey-grade literature investigation on a research topic:
  freezes research questions, searches from multiple adversarial
  perspectives, verifies every citation, synthesizes evidence into a MECE
  taxonomy with in-sentence cross-comparison, and answers the research
  questions in an evidence-first report. Use when the user asks for a
  literature review, a survey of a field, research landscape mapping, or a
  deep dive into what is known about a topic.
license: CC-BY-NC-SA-4.0
---

# Deep Research

## Overview

The role is a senior researcher who has written strong surveys and served as
a section editor. Someone brings a research topic; the job is to map the
terrain, lay out the key works, surface the tensions and the gaps, and end
with a judgment the evidence has earned.

This is not a search engine and not a bullet-point answer. The deliverable
reads like a real survey paper: questions defined first, evidence developed
systematically, conclusions emerging from the evidence rather than announced
up front and back-filled.

## When to use this skill

- "Survey this direction for me." "What is the state of X?"
- "What are the key works, debates, and open problems in this area?"
- "I need a literature review before committing to this topic."

## When NOT to use this skill

- Judging whether one specific idea is worth pursuing: `idea-evaluator`.
- Drafting or polishing paper prose: `paper-writer`, `intro-drafter`,
  `paper-polish`.
- A quick lookup of one or two papers: plain search suffices; this skill is
  for depth.

## Routing in Academic Harness

- Use this skill for a full survey-grade report with frozen research questions and per-citation verification.
- For a shorter delegated synthesis, use the `literature-researcher` specialist. For a PRISMA-style screening funnel, use `systematic-review-ledger` with the `review` tool. For one-shot discovery, use `literature_search` or the source-specific search tools.
- This skill uses those search tools and PaperMemory; it does not replace the `review` ledger's screening decisions.

## Capability check

- **Literature search**: a scholarly search tool if available; otherwise web
  search over scholarly indexes; otherwise shell access to public APIs
  (Crossref, Semantic Scholar, arXiv, DBLP). With no retrieval at all, this
  skill does not run: say so rather than writing a survey from memory.
- **Sub-agents**: when the environment can spawn parallel sub-agents, each
  search perspective runs as its own agent with a clean context; without
  them, run the perspectives serially yourself. The method does not change,
  only the execution.

## Step 0: freeze the research brief

Before any searching, pin down what is being investigated.

**The brief must contain research questions**: not a topic, but two or three
specific, answerable questions. They are the survey's promise; the
conclusion must answer each one.

If the user gives only a topic ("survey CRISPR for me"), convert it with one
or two clarifying questions:

- "CRISPR clinical progress" becomes RQ1: which diseases have phase-III or
  approved CRISPR therapies? RQ2: where is the safety boundary for in-vivo
  editing? RQ3: what limits accessibility?
- "social media and adolescent mental health" becomes RQ1: does causal
  (not correlational) evidence support harm? RQ2: what is the effect size?
  RQ3: who is most affected?

Brief = topic + research questions + angle + intended reader. Every later
step answers to this brief; drift is not allowed.

The strongest angles come from unexpected convergence or tension across
independent sources. The Angle gate in references/quality-gates.md gives the
tests.

## Phase 1: scout (search and verify)

Generate three to five **search perspectives** around the brief, each with
its own question and its own keywords:

- the mainstream school (who advances this direction, and with what);
- the critics (who doubts it, with what counter-evidence);
- adjacent fields (what other disciplines say about the same question);
- methodology (who challenges how the mainstream measures things:
  meta-analyses, systematic reviews);
- application and policy (what deployment or regulation evidence exists).

Each perspective searches independently, wide then narrow: a first round on
core keywords, a second round narrowed by what the first returned (method
names, dataset names, terms of art). Keyword construction patterns and the
discipline adjustments: references/search-strategy.md.

When sub-agents are available, run one per perspective in parallel; each
returns candidate works with one-line findings. Then merge across
perspectives and check blind spots: perspectives that returned almost
nothing (a real gap, or bad keywords?), sub-directions no perspective
covered, high-frequency works cited by the found papers but missing from
the pool, and discarded results that point somewhere uncovered.

**Every candidate reference is verified before use.** The two-step protocol,
five-grade verdict, and the grey-zone rule (unconfirmable means unused):
references/citation-protocol.md.

Corpus size has no quota; coverage of every sub-direction (three or more
works each) is the bar. Over-collecting is fine; the synthesis phase
filters.

## Phase 2: synthesize

With the verified corpus in hand: extract per-paper findings, cluster by
theme into a MECE taxonomy, assign works to branches, then write the
branches serially, each section citing only its assigned works. In-sentence
cross-comparison is mandatory; contradictions are presented with condition
analysis, never averaged away. The full method:
references/synthesis-framework.md.

After synthesis, run the self-adversarial review (three retrospective
questions, perspective-omission check, concession rules):
references/self-adversarial.md.

## The six gates and the iteration loop

Throughout, six internal gates guard quality (never shown to the reader):

| Gate | One line | Severity | Failure route |
|---|---|---|---|
| Angle | a judgment, or just a listing? | CRITICAL | back to Step 0 |
| Coverage | key works all found? | MAJOR | targeted re-scout |
| Citation | references real and honestly quoted? | CRITICAL | re-verify; delete inventions |
| Taxonomy | organized by theme, MECE? | MAJOR | redesign axes |
| Calibration | claim strength matches evidence? | MAJOR | re-calibrate wording |
| Weaving | in-sentence comparison present? | MAJOR | rewrite flagged sections |

Detection questions and routes: references/quality-gates.md.

The loop this creates is the point: a Coverage or Citation failure sends the
work back to scouting for a **targeted** supplement (new works append to the
corpus; the synthesis updates incrementally), not a restart. Iterate until
every gate is CLEAR and the self-adversarial pass stops finding corrections.
Depth is driven by the topic's complexity, not by a fixed round count.

## Presentation

Organize the final report as a survey paper: abstract; introduction with the
research questions; methodology; taxonomy; branches with comparison tables;
cross-branch synthesis discussion; open problems; a conclusion that answers
the RQs one by one; references. The skeleton, per-part guidance, and
formatting discipline: references/output-structure.md.

Wording strength follows the hedge ladder (claim never exceeds evidence):
references/hedge-calibration.md.

**Evidence-first narration**: the introduction poses the questions, the body
develops the evidence, the conclusion answers. The reader derives the
conclusions alongside the text instead of being told first and shown
supporting quotes after. This ordering is the survey's defense against its
own confirmation bias.

## Cross-discipline evidence standards

Switch what counts as strong evidence by field:

- **CS / AI**: benchmarks, ablations, reproducibility; note model versions
  and evaluation conditions.
- **Biomedicine**: trial phase, patient counts, follow-up length, approval
  status.
- **Social science**: causal versus correlational designs (RCT, natural
  experiments, IV); effect sizes and heterogeneity.
- **Economics and finance**: identification strategy (IV, DID, RDD);
  statistical versus economic significance.
- **Cross-disciplinary**: separate model predictions, observational
  attribution, and field experiments; carry uncertainty ranges.

Non-CS reports include the evidence-type table from the output-structure
reference so readers can weigh evidence kinds.

## Unconfirmed markers: a deliberate difference from paper prose

A survey report is a working document addressed to the researcher, so an
explicit unconfirmed marker ("[unconfirmed: no work retrieved in this
direction]") is honest signaling and is allowed, under the uniform
convention in references/citation-protocol.md. Paper prose (paper-writer,
intro-drafter) forbids all bracketed markers. The two regimes differ on
purpose; do not import this convention into paper drafting.

## Output language

The report follows the language of the user's request: a question asked in
Chinese gets a Chinese survey, English gets English. (This deliberately
differs from the drafting skills, which default to English: a survey is read
by the researcher, not submitted to a venue.) In Chinese reports, keep
technical terms in English with a half-width space around them. An explicit
language request always wins.

## Delivery

A full survey is written to a workspace file (Markdown), with the structure,
tables, and reference list intact. Short literature answers can stay in the
conversation. Capability degradations (perspectives run serially, weaker
retrieval for some literature) are disclosed in a short note.

## Running it as a tracked run

When `deep_research` is available, use it instead of holding the investigation
in context. Everything above is still the method; the tool supplies the part
prose cannot: a frozen query, a resumable step plan, and gates that fail.

```text
deep_research action=start query="<the request, verbatim>" effort=medium run=true
```

- **One scale knob: `effort`.** `low` is a bounded answer from titles, abstracts,
  and metadata in minutes; `medium` is a cited report with loci, four critics, a
  cite check, and full-text reading; `high` is the widest sweep and deepest
  critique. Omit it and the level is read from the request — "quickly", "just
  tell me" reads as low; "comprehensive", "systematic review", "before I commit"
  reads as high — and the run reports which level it chose and why. `tier` and
  `gear` are what `effort` sets underneath; use them only when the user asks for
  something specific, and never ask a user to learn them.
- **When the tool asks, ask.** `status: needs_input` with an `ask_user` question
  means the request pointed in two directions at once and nothing has run or
  spent yet. Put that question to the user and wait. Guessing at an expensive
  run is not yours to make.
- **Checks never soften with the level.** Every level cite-checks what it was
  given and reports what it could not read as `not_checked`. A low-effort answer
  is shorter, not less honest.

```text
deep_research action=status run_id=dr-0001
deep_research action=verify run_id=dr-0001
```

- **The query is gospel.** It is written once to the run ledger and re-read by
  every step; if your summary of it drifts, `verify` reports `query_drift`
  rather than quietly answering a different question.
- **What the levels run.** `low` is the light path — decompose → sweep → draft →
  cite check → polish; `medium` and `high` run the whole pipeline including the
  contradiction graph, loci, depth investigation, four critics, and the patcher.
  A level changes how much work happens, never how strict the checks are.
- **Resume, do not restart.** `action=status` shows step state; `action=resume`
  re-runs the step that died. A step blocked by a CRITICAL gate stays blocked:
  either clear it with `action=gate status=clear` or restart deliberately with
  `from_step`. Never run past a block by asking again.
- **Two retrieval lanes.** The scholarly sweep goes through `literature_search`
  (OpenAlex, Semantic Scholar, PubMed/Europe PMC, arXiv, Crossref, and the keyed
  indexes). A web lane then runs the model's own `web_queries` through Parallel,
  Exa, Tavily, or Brave for guidance documents, trial registers, and reporting.
  Web records are tagged `lane: web`, `work_type: web_page`, so a press release
  is never weighed like a trial. Providers with no key are named as skipped, not
  counted as failures. `web_sources` overrides the order.
- **Full text goes to the library.** With `fetch_full_text: true`, each readable
  open-access copy is deposited into PaperMemory and linked from its corpus row,
  so a quote is verified against stored text and the next session does not
  re-fetch it. A deposit that fails is recorded, and the run keeps its own copy.
- **Cap the spend.** `max_llm_calls`, `max_sources`, and `timeout_minutes` block
  the run when crossed instead of letting it balloon. Check
  `action=status` for calls and tokens before starting a long gear.
- **After synthesis, patch only.** `action=patch` with `hunks: [{find, replace}]`,
  where `find` is copied verbatim and appears once. The store refuses a rewrite
  of a patched artifact; a finding too big for a hunk is escalated as structural,
  not applied by hand.
- **Read the gate before delivering.** `action=verify` returns pass, blocked, or
  `not_checked` per check. Quote integrity needs fetched text, so pass
  `fetch_full_text: true` when verbatim quotation matters — without it the gate
  says `not_checked`, which is not a pass. Independence is counted in voices:
  three copies of one press release score as one source, so "several sources
  report" must mean several clusters.
- `action=export format=markdown` appends the verification record to the report;
  `csv` exports the corpus with cluster ids so a reviewer can audit the counting.

Ledger layout, step names, gate ids, and every error state:
`references/run-ledger.md`.

The ledgers this writes (`corpus.jsonl`, `claims.jsonl`, `findings.jsonl`) are
separate from the `review` screening ledger and from PaperMemory: use `review`
for a PRISMA funnel, PaperMemory for the library of record, and `deep_research`
for an investigation that has to produce a defensible report.

## Boundaries with sibling skills

- Wants a verdict on one idea: `idea-evaluator`.
- Wants prose written or polished: `paper-writer` / `paper-polish`.
- The evaluator or writer discovers the user actually needs the landscape
  first: they route here.
