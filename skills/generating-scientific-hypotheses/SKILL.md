---
name: generating-scientific-hypotheses
description: >
  Generate, critique, rank, or refine scientific hypotheses — mechanistic
  explanations, drug-repurposing or novel-target hypotheses, and discriminating
  experiments. Use when the user asks to propose or brainstorm hypotheses,
  explain a mechanism, suggest what to test, or rank/critique a hypothesis set,
  and when they run /generating-scientific-hypotheses. Trigger it for
  problem-shaped asks too, where they describe an observation or a surprise and
  want it accounted for: why does X happen, what could explain this result, I
  expected A but got B, what is a novel target or mechanism for Y, what should I
  test next, how could I falsify this, what drives this phenotype. Do not use for
  confirmatory data analysis of a chosen outcome, literature reviews, or
  manuscript writing.
license: MIT
metadata:
  version: "1.0"
---

# Generating scientific hypotheses

Literature-grounded ideation. Load this when the ask is to **generate, critique, rank, or plan a test for hypotheses**. Distilled from Co-Scientist (Gottweis et al., *Nature* 2026) and Robin (Ghareeb et al., *Nature* 2026): several candidates, search-checked novelty, scientist chooses.

Not a confirmatory analysis. If they already have a question and outcome data to test it, use `framing-research-questions` instead. After they **select** a hypothesis and want to test it on data, hand off to that skill.

## When not to load

- Analyzing a dataset, fitting a model, or running a pre-registered test
- Writing or reviewing a paper, grant, or literature survey
- Ordinary lookup (“what is known about X”) with no request for new claims

## Criteria (score every candidate)

1. **Alignment** — matches the stated goal, constraints, and preferences
2. **Plausibility** — no obvious flaw; contradiction with prior work is explicit and justified
3. **Novelty** — not a restatement of a published result; **search before claiming novel**
4. **Testability** — a feasible experiment or analysis could refute it under the given constraints
5. **Safety** — not unsafe, unethical, or dual-use enablement

Do not invent citations, DOIs, or paper titles. Unverified → `[VERIFY]`. Do not claim a validated therapy, wet-lab result, or clinical recommendation.

These outputs recombine published knowledge. Treat them as hypotheses, not new biology.

## Procedure

1. **Parse the goal.** Question, constraints (indication/subtype, approved-drugs-only, assay limits, …), and what a useful output looks like. Ask **one** clarifying question only if a missing constraint would change the search.

2. **Search before proposing.**
   - Therapeutic ask: disease mechanisms → a testable assay → intervention candidates.
   - Open scientific ask: existing explanations → gaps → new claims that could fill them.
   - On Academic Harness: `consensus_search` **and** `parallel_search` (`advanced` for a survey); `mcp__papermemory__papermemory_search` for claims and papers already in memory; `paper_download` + `pdf_to_markdown` when a claim needs the full paper (download also ingests into PaperMemory). If those tools are absent, use the literature/web search this surface has. Still no invented citations.

3. **Propose 5–8 candidates**, not one. Prefer non-obvious links across fields over a known result relabeled as a hypothesis.

4. **Critique with search.** Drop or flag non-novel, implausible, untestable, or unsafe items. For a complex claim, split into assumptions and check the load-bearing ones.

5. **Rank** with a short rationale (novelty + correctness + testability). Pairwise comparison in-line is enough.

6. **Emit a card per kept hypothesis.** Open `references/hypothesis-card.md` and follow that schema.

7. **Stop for the scientist.** Present the ranked cards. They select, veto, or inject their own idea. Do not treat a next experiment as decided.

8. **If they provided data**, interpret it, then revise the set. Log each card with the `notebook` tool (`kind: "hypothesis"`); later results use `relatesTo` and `stance` `supports` / `refutes`.
