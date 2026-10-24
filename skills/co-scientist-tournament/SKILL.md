---
name: co-scientist-tournament
description: >
  Run a persistent, ranked multi-round hypothesis tournament, and the ledger that
  keeps it: generate diverse candidates from the literature, review each through
  five stages, debate them head-to-head onto a Glicko-2 leaderboard, evolve the
  best, and export a ranked shortlist that survives across sessions. Use when the
  user wants hypotheses *ranked and kept* rather than listed: a shortlist to
  defend or compare, which of these is strongest and why, a set they will resume,
  extend, or revisit later, iterative generate-critique-evolve rounds, more
  candidates than one pass should hold, or a mention of a tournament,
  leaderboard, Elo/Glicko ranking, head-to-head comparison, or Co-Scientist.
  Also use when they hand over a puzzle and want the candidates scored against
  each other before choosing. Do not use for one pass of ideation (that is
  generating-scientific-hypotheses), for analyzing chosen outcome data
  (framing-research-questions, designing-the-analysis), for a literature review,
  or for manuscript writing.
license: MIT
metadata:
  version: "1.0"
---

# Co-Scientist hypothesis tournament

Generate → review → rank → evolve, with the state kept in a ledger so a
tournament survives the end of this context window. Adapted from the open-source
`co-scientist` implementation of Gottweis et al., *Nature* (2026); the rating
math, scheduling policy, and duplicate gate run in code, not in prose.

Not a confirmatory analysis, and not a source of results. Generated hypotheses
recombine published knowledge. Never invent a citation, DOI, paper title, or
number.

## Is this a hypothesis ask at all

Most people describe a problem, not a task. Decide from what they need back, not
from the presence of the word "hypothesis":

| What they say | What it is | Go to |
|---|---|---|
| "why does X happen", "what could explain this", "we expected A and got B" | needs candidate explanations | `generating-scientific-hypotheses` (one pass), this skill if they want them ranked and kept |
| "what should I test next", "give me something falsifiable", "novel target for Y" | needs a testable claim | same split as above |
| "which of these is strongest", "rank them", "a shortlist I can defend", "we will revisit this next month" | needs a kept ranking | `co-scientist-tournament` |
| "more candidates, and better ones", "evolve/improve these", "run another round" | needs generate-critique-evolve | `co-scientist-tournament` |
| "does X cause Y in this data", "run the test", "is my result significant" | chosen outcome + question | `framing-research-questions`, `designing-the-analysis` — not hypothesis generation |
| "what is known about X", "summarize the literature" | a survey | `literature-review` / search tools |
| "review this paper", "write the discussion" | manuscript work | the writing and review skills |

Two rules that survive everything else:

- **Search before proposing.** A hypothesis is a claim about what is not yet
  published; say it is novel only after searching, and mark anything you could not
  verify `[VERIFY]`.
- **A generated hypothesis is not a finding.** It is a recombination of
  published knowledge offered as something worth testing. If the user is about to
  act on it as evidence, stop and say so.

If the ask is ambiguous between one pass and a tournament, ask one question —
"Do you want these ranked and kept, or is a short list enough for now?" — rather
than silently starting a tournament that costs debate matches.

## What the tools own

`coscientist` and `coscientist_rank` (state under `.dsh/coscientist/<slug>/`).
They decide; you dispatch. **Do not reimplement any of this in your own
reasoning** — do not compute ratings, pick matchups, or decide whether the loop
should continue.

| The tool enforces | You cannot talk it out of |
|---|---|
| A near-duplicate `add` is discarded with its similarity score | Distinct claims must differ in mechanism, not wording |
| `add` refuses past the hypothesis cap | — |
| Review stages run in order; a `fail` at `initial`/`full` rejects | A rejected hypothesis never re-enters; add a new one |
| Only `active` hypotheses compete; withheld ones cannot be matched | Quarantine is a human release, with a name and a reason |
| Ratings move only through `record` and `feedback` | Prose praise changes nothing |
| `next` samples the task; `status`/`next` say when to stop | You do not choose when the tournament ends |
| Both presentation orders are needed, or the match is flagged | A single-order verdict is position-biased |

`next` returns one sampled task and one line of guidance. The four generation
strategies and six evolution mutations are in `references/briefs.md`; the rating
and termination rules are in `references/tournament.md`.

## Loop

1. **Start.** Restate the goal, constraints, and what a useful output looks like.
   Ask **one** question only if a missing constraint would change the search.
   Run `coscientist priors` before anything else — if a sibling tournament in this
   workspace already refuted, rejected, or withheld something similar, say so
   rather than generating another version of it. Then run the goal-parse brief
   (`references/briefs.md` §1) in a `subagent`, then
   `coscientist start` with its parsed title, domain, keywords, rubric, and seed
   queries. Keep the defaults: **5 hypotheses, 36 steps**. Five is the smallest
   pool where one review veto and one dual-use withholding still leave three
   ideas competing — at three the tournament stalls on `no_competitors` — and
   past five each pair starts meeting less than twice, which buys breadth at the
   cost of a head-to-head ranking. Raise both together and only when the user
   asks for a deeper search, and say what it costs: 15 matches is at least 30
   judging calls, more if any pair goes to debate. A bigger pool on the same
   budget ends on `budget_exhausted` rather than on converged rankings.
2. **Dispatch.** Ask `next`, do exactly that task, record the result, ask again.
   One task per turn is fine; several is fine while each is recorded.
   - `generation` → search, then one strategy brief, then `add`. A discard is a
     normal outcome: report the score and the neighbour, then go generate a
     genuinely different claim.
   - `reflection` → pick one `pending_review` hypothesis, run the five stage
     briefs in order, `review` after each. Verify its citations with
     `coscientist_verify citations` when that optional tool is enabled
     (`AH_ENABLE_OPTIONAL_TOOLS=1`); otherwise do it by hand with
     `paper_resolve` / `crossref_lookup`, plus `integrity_check` for retraction.
     Anything you could not resolve is unverified — never counted as verified.
   - `ranking` → `coscientist_rank propose`, then **two judge subagents in the
     same turn, one per presentation order**, then `record` with both verdicts.
     Report `verdict_ab` and `verdict_ba` as the *presented* slot that won, so
     agreement is `A` + `B` — see `references/tournament.md` §3 before recording.
   - `evolution` → run the named mutation brief on a top hypothesis, then `add`
     with `parent_ids` and `strategy: evolution:<name>`.
   - `proximity` → `coscientist_rank similarity`; surface any duplicate pair to
     the scientist rather than quietly deleting one.
   - `meta_review` → synthesize a cross-cutting critique and `synthesize` it; it
     steers later generation.
3. **Stop when the tools say stop.** `next` returns `terminate` with a reason.
   Then: design the protocol for the top hypothesis, write the research overview,
   export, and report.
4. **Show the structure.** `coscientist graph` builds a Mermaid diagram from the
   ledger alone — solid arrows are parentage, dotted ones are similarity pairs, and
   a paper node exists only because a recorded claim judgement named it. Write it
   with `export format: "mermaid"` and hand the file to `mermaid_render` for SVG.
   Explain the edges you show; a diagram the scientist cannot read is decoration.
5. **Cosine is opt-in.** `coscientist embed` is the only tournament call that
   needs `GEMINI_API_KEY` and the network, so it is never automatic. Reach for it
   when the pool is large or the user suspects paraphrases are passing the lexical
   gate; it moves the gate to upstream's 0.92 cosine. A pool that is only partly
   embedded is reported as **mixed** — embed the rest before trusting a similarity
   number, and never present a mixed score as semantic.
6. **Report honestly.** Give the leaderboard with rating, RD, and matches played.
   A hypothesis that played 1 match is not established; say so. Never render a
   rating as confidence, probability, or scientific merit.
7. **Log it.** `notebook` with `kind: "hypothesis"` per kept hypothesis, and
   later results with `relatesTo` and `stance`. The tournament ledger holds the
   detail; the notebook holds the thread.

## Resuming

`coscientist status` reads the ledger as it stands. Say which tournament you
resumed, its round, and its matches, then continue dispatching. Never start a
second slug for the same goal — pass `resume: true` to adjust budgets.

## Safety

A review stage that raises a dual-use or harm concern sets `safety_flag`.
Run the safety-classifier brief and record it with `coscientist safety` — the tool
applies the threshold and withholds the hypothesis for you. A withheld hypothesis
stays in the ledger, out of the tournament, and is reported as withheld with its
severity. Only the user releases one, and only with a named reason. Releasing does
not make the idea safe — it makes it eligible to be ranked.

Never produce an executable protocol for enhancing a pathogen, weaponizing an
agent, or evading a diagnostic. Refuse that half of the request, keep the benign
hypotheses, and say what you withheld.

## Delegation

`subagent` returns immediately and the answer arrives as a completion notice;
never poll. The two orientations of one match are independent, so run them as
two subagents in the same turn. Put the specialist name in `description` and the
brief plus the concrete pair in `prompt` — a judge needs both hypotheses in full,
the provenance line, and the rubric.

## Read next

- `references/briefs.md` — every subagent brief and its exact JSON contract.
- `references/tournament.md` — ratings, RD, matchups, judging order, termination.
- `generating-scientific-hypotheses` — the single-pass version of this work.
- `experiment-designer` — controls, power, and analysis plan once one hypothesis
  is chosen.
