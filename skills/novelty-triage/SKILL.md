---
name: novelty-triage
description: Use when checking prior art and grounded novelty for a recorded co-scientist hypothesis, including retrieved references, verbatim quote spans, and inconclusive searches.
license: MIT
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Grounded novelty triage

1. Identify the tournament `slug` and hypothesis `id`. Search relevant literature with complementary queries, record scope and date, and read the sources needed to assess the actual mechanism and claim. A search hit or citation count alone cannot establish novelty.
2. Call `coscientist_verify action=novelty slug=<slug> id=<id>`; optionally supply a focused `query`, `limit`, or quote spans from the retrieved references. Supplied `quotes` must be verbatim in those references. Give `novelty_score` only as an attributed caller reading grounded in actual source review.
3. Distinguish the tool's lexical prior-art reading (`10 × (1 − max token coverage)` over a small retrieved set) from a scientific novelty verdict. Report the reference set, supporting or conflicting passages, search limits, and `not_checked` on retrieval failure; never convert a failed lookup into evidence that prior art does not exist.
4. Resolve citations with `coscientist_verify action=citations` and publication status when relevant; use PaperMemory quote checking for evidence. Do not invent citations, interpret registry resolution as claim support, or conflate this triage with legal patent advice.
5. For a claim that is not a recorded tournament hypothesis, run the searches yourself and record them with `prior_art`: every search (provider, query, status, access time, cap, error) and every candidate with its evidence level, claimed overlap, distinction, and verbatim quotations. It checks each quotation against the text you supply, reports coverage limits, and states at most "no close overlap found in the searched material"; it makes no statement when no search succeeded. Confirm quotations from ingested papers with PaperMemory `quote_check`. Expand queries only with the author's approval when they cost network or model time.
