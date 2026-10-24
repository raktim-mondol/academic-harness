# Subagent briefs

Every brief below is a `subagent` call: put the specialist name in `description`,
and the brief text plus the concrete inputs in `prompt`. Contracts are JSON
because the ledger needs typed fields — but a subagent answers in prose, so ask
for the JSON object and parse it yourself. Map the keys to the tool's parameter
names as written.

Standing rules for every brief — put them in the prompt:

- **Never invent** a citation, DOI, paper title, author list, or number. If you
  did not find it, write `[VERIFY]`.
- Report only what the supplied literature supports. If a claim rests on general
  knowledge, say so rather than manufacturing a reference.
- These are hypotheses, not results. No therapeutic, clinical, or validated
  claims.
- Return the JSON object and nothing around it.

---

## 1. Goal parse

Specialist: `hypothesis-generator`. Inputs: the raw goal, background, constraints.
Output feeds `coscientist start`.

> Parse this research goal into a tournament configuration.
>
> RESEARCH GOAL: `<goal>`  ·  BACKGROUND: `<background>`  ·  CONSTRAINTS: `<list>`
>
> Produce: `title` (≤100 chars), `domain` (primary scientific domain), `keywords`
> (5–10 specific terms), `hypothesis_attributes` (4–6 properties a good hypothesis
> here must have), `evaluation_rubric` (2–3 sentences on how to judge quality for
> *this* goal), `search_queries` (3–5 concrete academic queries).
> Respond with JSON only.

Record with `start` as `parsed_title`, `domain`, `keywords`,
`hypothesis_attributes`, `evaluation_rubric`, `search_queries`.

## 2. Query set

Run before each generation when the tournament already has hypotheses, so the
search explores uncovered ground rather than re-reading the same papers.

> Generate 3 distinct academic search queries for this goal.
> RESEARCH GOAL / DOMAIN / KEY TERMS: `<…>`
> HYPOTHESES SO FAR (explore the gaps they leave): `<titles + one-line summaries>`
> QUERIES ALREADY USED (do not repeat): `<list>`
>
> Each query must target a different sub-topic or method, use specific terminology
> (5–10 words), and be a real search string. JSON only: `{"queries": ["…","…","…"]}`

## 3. Evidence digest

Ground generation in what sources actually say. Use `consensus_search` **and**
`parallel_search` (`advanced` for a survey) with the queries above, then
`parallel_extract`, or `paper_download` + `pdf_to_markdown` when a claim needs the
full paper. Ask a subagent to bank the evidence:

> RESEARCH GOAL: `<goal>`
> EVIDENCE GATHERED SO FAR: `<digest>`  ·  OPEN GAPS: `<list>`
> CANDIDATE SOURCES (unread): `<urls>`
>
> Decide the next step. If the evidence already grounds a novel, testable
> hypothesis, return `{"sufficient": true, "gaps": [], "urlsToRead": [], "nextQueries": []}`.
> Otherwise pick up to 2–3 URLs that fill the gaps (copied exactly) and up to 3 new
> queries. Then, for each source you read, extract
> `{"rationale": "…", "evidence": "…", "summary": "…"}`
> keeping the source's own wording and never dropping a quantitative result.
> You never invent content that is not in the source.

Label each item in the digest `[1]`, `[2]`, … with its URL; the generation brief
below cites those labels, and you convert them back to URLs before `add`.

## 4. Generation strategies

The `next` task tells you which one to run: `literature_exploration` while fewer
than 3 hypotheses are active, then rotating by round — `scientific_debate`,
`assumption_chaining`, `research_expansion`, back to `literature_exploration`.

All four return the same object, which maps 1:1 onto `coscientist add`:

```json
{
  "title": "≤80 chars",
  "summary": "1–3 sentences",
  "content": "the full hypothesis, 300–600 words",
  "rationale": "mechanism and justification, 200–400 words",
  "experimental_plan": "how to test it, 150–300 words",
  "novelty_assessment": "what is published vs. what is new here, 100–200 words",
  "key_assumptions": ["…", "…"],
  "citations": ["url or DOI actually relied on"]
}
```

Pass `strategy: generation:<name>` and the current `round`.

### 4.1 `literature_exploration`

> Generate a novel hypothesis for this goal by synthesizing the provided
> literature. RESEARCH GOAL / DOMAIN / KEY TERMS / DESIRED ATTRIBUTES: `<…>`
> RELEVANT LITERATURE (labeled, with source URLs): `<digest>`
> META-REVIEW FEEDBACK (avoid these issues): `<critique, if any>`
> ALREADY-EXPLORED IDEAS (these occupy the idea space): `<titles + summaries>`
>
> Propose something **mechanistically distinct** from all of them — a different
> pathway, level of analysis, or causal mechanism, not a marginal tweak. Find a
> knowledge gap or an unexpected connection, make the claim specific and testable,
> and propose concrete experiments. In `citations`, list only the labeled sources
> you actually used.

### 4.2 `scientific_debate`

> Facilitate a structured debate to produce one hypothesis.
> RESEARCH GOAL / DOMAIN / EVALUATION CRITERIA: `<…>`  ·  KNOWN ISSUES TO AVOID: `<critique>`
>
> **Scientist A (proposer)** puts forward a bold hypothesis with a mechanism.
> **Scientist B (critic)** attacks the assumptions, finds gaps, offers alternative
> interpretations. **Scientist A (refiner)** answers the criticism and strengthens
> the claim. **Judge** synthesizes the debate into the final hypothesis. Run it as
> two turns: the first proposes, the second challenges and refines. Then return the
> refined hypothesis as JSON.

### 4.3 `assumption_chaining`

> Build a hypothesis by chaining testable assumptions.
> RESEARCH GOAL / DOMAIN / KEY TERMS: `<…>`  ·  KNOWN ISSUES TO AVOID: `<critique>`
>
> 1. State one plausible but unproven assumption about the domain.
> 2. If it holds, what 2–3 intermediate observations follow?
> 3. What specific, measurable predictions does the chain imply?
> 4. Synthesize the chain into one coherent, testable hypothesis.
> Show the reasoning, then return the JSON. `key_assumptions` is the chain itself.

### 4.4 `research_expansion`

> Generate a hypothesis in a direction the current set does not cover.
> RESEARCH GOAL / DOMAIN: `<…>`
> EXISTING HYPOTHESES (do not repeat these directions): `<titles + summaries>`
> META-REVIEW FEEDBACK: `<critique>`
>
> Identify what is missing — a different scale (molecular / cellular / systemic),
> a different mechanism, a different model system, or a cross-disciplinary link —
> and fill the gap with something clearly distinct from everything listed.

## 5. Review stages

Record each stage with `coscientist review` as soon as it comes back, in this
order. `novelty_score` / `correctness_score` / `testability_score` are 0–10;
omit a dimension the stage does not assess (do not guess a number for it).
`critique` is a single string.

Contract for all five:

```json
{
  "verdict": "pass | fail | uncertain",
  "novelty_score": 0-10,
  "correctness_score": 0-10,
  "testability_score": 0-10,
  "safety_flag": false,
  "summary": "one sentence",
  "critique": "one string, not an array",
  "supporting_evidence": ["url or DOI"]
}
```

### 5.1 `initial` — no search

> Quick quality review of this hypothesis. TITLE / CONTENT / RATIONALE / KEY
> ASSUMPTIONS: `<…>`
> Assess only: plausibility (is it internally coherent, any contradiction?), basic
> novelty (is it trivial or already known?), safety. Use internal knowledge, do not
> search. Be permissive here — fail only for obvious impossibility, something
> completely trivial, or a safety concern.

### 5.2 `full` — with literature

> Full peer review. TITLE / CONTENT / RATIONALE / EXPERIMENTAL PLAN: `<…>`
> RELEVANT LITERATURE: `<digest from fresh searches on the title and its two
> load-bearing assumptions>`
> Assess novelty against that literature (what is new, what is already published),
> correctness of the mechanisms, testability and feasibility of the proposed
> experiments, and the impact if it were true. Put the URLs you relied on in
> `supporting_evidence`.

### 5.3 `deep_verification` — assumption decomposition

> Verify each assumption independently. TITLE / CONTENT / KEY ASSUMPTIONS /
> RATIONALE: `<…>`
> For every key assumption: decompose it into 2–3 sub-assumptions, judge each
> (supported / unsupported / unknown), and decide whether any one of them
> invalidates the hypothesis. Score `correctness_score`; set the other two to null.

### 5.4 `simulation` — failure modes

> Simulate this mechanism and experiment step by step. TITLE / CONTENT /
> EXPERIMENTAL PLAN: `<…>`
> Trace cause to effect; at each step name what could go wrong; simulate the
> experiment and the confounds that could invalidate it; then judge whether the
> failure modes are fundamental (the hypothesis is wrong) or addressable (the
> design needs work). Score correctness and testability.

### 5.5 `observation` — explanatory power

> Test whether this hypothesis explains known observations. TITLE / CONTENT: `<…>`
> OBSERVATIONS FROM LITERATURE: `<web + literature search results on the topic's
> anomalous, surprising, or unexplained findings>`
> Identify which observations are anomalous, say whether this hypothesis predicts
> them (yes / partially / no), score how much of the anomaly set it accounts for,
> and name what it cannot explain — flagging those as weaknesses or as pointers to
> a refinement. Score correctness; set novelty and testability to null.
>
> A `fail` here does not kill the hypothesis; it enters the tournament with a
> lower seed so the debate can argue about it.

## 6. Safety classifier

Run after the reviews pass, before the first match. Specialist: `peer-reviewer`
(read-only) or `ethics-reviewer`.

> Screen this hypothesis for dual-use and harm risk. You are **not** judging
> scientific merit — a valid hypothesis can still be too hazardous to pursue.
> TITLE / CONTENT / RATIONALE / KEY ASSUMPTIONS / EXPERIMENTAL PLAN: `<…>`
> Could pursuing or publishing this materially enable: creation or enhancement of
> pathogens, toxins, or bioweapons; chemical, radiological, or nuclear weapons;
> direct serious harm to humans; another clear dual-use capability?
> Routine beneficial science — including legitimate disease-mechanism,
> drug-discovery, or defensive research — is not a concern merely because the
> field is sensitive. Flag it only when this specific idea gives uplift toward harm.
> Severity: `none` | `low` (sensitive area, minimal actionable uplift) | `moderate`
> (plausible misuse pathway) | `high` (clear actionable uplift toward serious harm
> or a weapon).
> JSON only: `{"severity": "…", "category": "bioweapon | dual_use | human_harm | chem_weapon | none", "reasoning": "1–3 sentences about the actual risk, not the field"}`

Record with `coscientist safety` — it applies the threshold and withholds the
hypothesis when the severity meets it. Report it as withheld, never as deleted.

## 7. Provenance and citation support

Do this with a subagent and the tools that ship: `paper_resolve` and
`crossref_lookup` to confirm a work exists, `integrity_check` for retraction and
correction status, `consensus_search` / `s2_search` for claim support.

> Check these claims against the literature. For each: search it, find the paper
> that bears on it, and return
> `{"claim": "…", "paper_title": "…", "paper_doi": "…", "support": "supports | contradicts | unaddressed", "confidence": 0-1}`
> A claim nobody addressed is `unaddressed`, not contradicted. Never return a paper
> you did not find.

Then check that every cited work exists — `coscientist_verify citations` when the
optional tool is enabled, otherwise `paper_resolve` / `crossref_lookup` by hand.
The distinction that matters: a DOI the hypothesis asserts that Crossref does not
list is **fabricated**; a title nobody matched, or a registry that errored, is only
**unverified**. Those counts drive a soft penalty, never a veto.

## 8. Judging a match

`coscientist_rank propose` returns the pair and both presentation orders. Run
**two sequential subagents, one at a time** — the same brief, with A and B
swapped — so the result does not depend on who was shown first. Sequential, not
parallel: a single judge at a time starts reliably, and a retry costs one child
rather than two. Specialist: `peer-reviewer`.

> Which hypothesis is scientifically superior?
> HYPOTHESIS A: `<title, summary, rationale>`  ·  PROVENANCE FOR A: `<claim-support line>`
> HYPOTHESIS B: `<…>`  ·  PROVENANCE FOR B: `<…>`
> The provenance shows how each one's key claims hold up against real papers.
> A contradicted claim is a significant weakness; a well-supported claim adds
> credibility. Judge novelty, scientific soundness, evidence credibility,
> testability, and potential impact.
> Do not call tools or load skills; judge from the material above and answer in
> your final message.
> JSON only: `{"winner": "A | B | draw", "rationale": "2–3 sentences"}`

The two runs must differ **only** in which hypothesis occupies slot A. If a child
settles as `failed before it finished` with no closing message, retry the
identical brief (same wording, same length); after two failures report that
orientation as unavailable and record the match with one orientation instead of
substituting a differently-worded run.

For a debate match (the pair near the top of the leaderboard), use the advocate
structure instead: strongest case for A, strongest case for B, cross-examination
of each other's weaknesses (novelty flaws, feasibility, logical gaps, contradicted
provenance), then the judge's verdict in the same JSON.

**Mapping the two verdicts.** Each verdict names the *presented slot*, not the
hypothesis. So in the B,A run the slot labelled A is `b`. Record `verdict_ab` from
the A,B run and `verdict_ba` from the B,A run: agreement is `A` + `B`. Two
identical letters mean the judges disagreed about which hypothesis is better and
the ledger will score it as a draw. Save the transcript to a workspace file and
pass its path as `transcript`.

## 9. Evolution mutations

`next` names the mutation for the round. Run the brief on a top-ranked hypothesis
(or several, for `combination`), then `coscientist add` with `parent_ids` and
`strategy: evolution:<name>`. The child starts at 85 % of its best parent's rating
and must earn the rest. Output contract is the same as §4.

| Mutation | Brief |
|---|---|
| `grounding` | Find the 2–3 weakest aspects of the original; strengthen or correct them with literature; fill reasoning gaps with evidence. Produce an *improved* hypothesis, not a summary. |
| `coherence` | Remove internal contradictions; check the plan is actually feasible; make mechanism → prediction flow logically; simplify complexity while preserving the core insight. |
| `cross_pollination` | Graft the **single** most transferable mechanism from an inspiration onto the primary, keeping the primary's identity intact. Say exactly what was borrowed, from where, and why it strengthens rather than replaces. This is not a merge. |
| `combination` | Take the strongest elements of several hypotheses, find where the mechanisms complement each other, and synthesize a genuinely new hypothesis stronger than any part — not a summary of all of them. |
| `simplification` | Isolate the one most important testable prediction, strip what cannot be directly tested, and design the simplest experiment that would validate or refute the core claim. Keep the novel insight. |
| `out_of_box` | Name the conventional assumptions in the seed, invert or challenge at least one major one, move to a different mechanism, scale, or discipline. Surprising but still grounded. |

## 10. Meta-review synthesis

> Synthesize the patterns across reviews and debates into a meta-review critique.
> REVIEW SUMMARIES from the top hypotheses: `<…>`  ·  RECENT DEBATE OUTCOMES: `<…>`
> ·  TOP HYPOTHESES: `<titles>`
> Cover: recurring issues across hypotheses; what the highest-scoring ones share;
> directions that were overlooked; what generation should focus on next; what
> reviewers should weight more heavily. 3–5 actionable bullets per section. Prose.

Record with `coscientist synthesize` as `meta_critique`. It is injected into later
generation and review briefs, so write it as instructions, not commentary.

## 11. Research overview

Write this when the tournament has terminated, and record it as `overview`.

> Synthesize the ranked hypotheses into a research roadmap for the goal
> `<goal>` in `<domain>`. TOP-RANKED HYPOTHESES (with ratings): `<…>`
> META-REVIEW INSIGHTS: `<critique>`  ·  SESSION STATISTICS: `<counts, matches, rounds>`
> Sections: Executive Summary; Top Hypotheses (claim, basis, approach, priority);
> Recommended Research Priorities (what to run first, and why); Key Knowledge
> Gaps; Cross-Cutting Themes; Suggested Expert Collaborations; Conclusion.
> Prose a scientist could hand to a lab. Say plainly where the evidence is thin.

## 12. Experiment protocol

Only for the hypothesis the scientist chooses (default: the top-ranked one).
Specialist: `experiment-designer`.

> Design a protocol a lab team could follow directly. HYPOTHESIS / SUMMARY /
> CONTENT / RATIONALE / KEY ASSUMPTIONS / EXISTING PLAN: `<…>`  ·  LITERATURE: `<…>`
> JSON only: `{"overview": "…", "steps": [{"step": 1, "action": "…", "details": "…"}],
> "reagents_and_equipment": ["…"], "datasets": ["…"], "expected_outcomes": "what a
> positive looks like and what a negative would mean", "controls": "positive and
> negative controls; blinding", "timeline_weeks": 12, "cost_tier": "low | medium | high"}`
> 5–12 concrete steps; realistic timeline including analysis; low `<$5k`,
> medium `$5k–$50k`, high `>$50k`.

Record with `coscientist design_protocol` using the `steps` array (action + details
joined). `experiment-designer` remains the authority on controls, power, and the
analysis plan; this brief only fixes the format the ledger stores.
