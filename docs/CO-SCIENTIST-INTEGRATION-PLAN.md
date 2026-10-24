# Co-Scientist tournament — gap analysis and integration plan

Status: **Phases 0–4 implemented (unreleased)** (2026-10-24) · baseline **v0.21.0** ·
target **v0.22.0**

Implementation notes: §13.1 (Phases 0–1), §13.2 (Phase 3), §13.3 (Phases 2 and 4).
Phase 4's vector path does **not** go through `zvec-grep` as drafted — see §10 and
§13.3 for why, and for the threshold semantics that changed with it.

Implementation notes for Phases 0–1 are in §13.1. Four things landed differently
from this plan's draft, all recorded there: the ledger is one event log rather than
four files (`safety` / `provenance` are event types, not tables), the step budget is
named `CO_SCIENTIST_STEP_BUDGET`, `add` checks the cap before the duplicate gate, and
a rejected or withheld hypothesis may not seed a child. The judge-orientation
mapping (§8.2) turned out to be the sharp edge of the whole surface and is now
spelled out in the tool description, the render output, and the skill.

Sibling plans: `docs/NON-SEARCH-TOOLS-PLAN.md` (the tool pattern this follows),
`docs/AGENTS-PLAN.md` (the specialist roster this depends on),
`docs/SEARCH-PROVIDERS-PLAN.md` (the search layer this reuses, already complete).

Source docs: `/tmp/co-scientist` (clone of
<https://github.com/raktim-mondol/co-scientist>, MIT © 2025 Raktim Mondol) —
`src/agents/*.ts`, `src/models/tournament.ts`, `src/taskQueue/queue.ts`,
`src/memory/stores/*.ts`, `src/prompts/**/*.yaml`, `README.md`; plus
`prompt.js`, `README.md`, `review-store.js`, `skills/generating-scientific-hypotheses/SKILL.md`.

## 1. Why

The harness can already generate hypotheses. `skills/generating-scientific-hypotheses`
is a first-party distillation of Gottweis et al. (Nature 2026): parse the goal,
search before proposing, 5–8 candidates, critique with search, rank with a
short rationale, emit cards, stop for the scientist. It is good at what a
single-pass skill can do.

What it cannot do, and what no layer of this plugin does today:

1. **Nothing persists.** Rankings, verdicts, and transcripts die with the
   context window. A session that generated twelve hypotheses yesterday cannot
   resume, compare, or extend them. There is no hypothesis ledger analogous to
   `review-store.js`.
2. **Nothing is scored rigorously.** "Ranked by in-line pairwise comparison"
   is a vibe. There is no rating with uncertainty, no mechanism that makes
   repeated head-to-head evidence accumulate, and no control for the judge's
   well-documented position bias.
3. **Nothing terminates on evidence.** No budget accounting, no plateau
   detection, no rule for "stop generating and start ranking."
4. **Nothing blocks duplicates.** Four near-identical hypotheses cost the same
   review and debate budget as four distinct ones and quietly inflate a
   leaderboard.
5. **Nothing checks citations before they rank.** `integrity_check` and
   `crossref_lookup` verify a DOI a human supplies. A generated hypothesis that
   cites five invented papers is scored on the same footing as one that cites
   five real ones.
6. **Nothing quarantines.** Dual-use screening is prose in a skill
   ("not unsafe, unethical, or dual-use enablement"), with no withheld state
   and no human release step.
7. **Feedback does not move the ranking.** A wet-lab result that refutes a
   hypothesis is a notebook entry; the leaderboard never changes.

`co-scientist` implements all seven, but as a standalone Bun CLI with its own
SQLite/vector store, MCP OAuth clients, ONNX embedding model, and ink TUI.
Vendoring that runtime is the wrong move (§4). Its **algorithms and policies
are the right move** — they are pure, deterministic, and small, and they are
exactly the layer the harness is missing.

This plan ports the state + math as native deterministic tools and the
agent loop as a skill that drives DSH subagents, reusing the existing search,
verification, notebook, and PaperMemory layers untouched.

## 2. Current state

| Capability | Harness today | Where |
|---|---|---|
| Hypothesis ideation | `generating-scientific-hypotheses` skill (single-pass, human-in-loop) | `skills/`, routed at `prompt.js:15` |
| Specialist roles | `hypothesis-generator`, `experiment-designer` roster names + routing skills | `prompt.js:63`, `skills/hypothesis-generator` |
| Literature discovery | `consensus_search`, `parallel_search`, `openalex_search`, `s2_search`, `pubmed_search`, `literature_search` | 14+ native tools, 3 MCP connectors |
| Paper acquisition / reading | `paper_download`, `pdf_to_markdown`, `parallel_extract` | `paper-download.js` |
| Claim/paper memory | PaperMemory (14 tools, real SQLite) | `papermemory.js` |
| Reference existence | `crossref_lookup`, `paper_resolve` | `crossref-lookup.js`, `paper-resolve.js` |
| Retraction awareness | `integrity_check` (Crossref relationships + OpenAlex flags) | `integrity-check.js:175` |
| Running log / result cards | `notebook` (`kind: "hypothesis"`, `relatesTo`, `stance`), `scientific_result` | `notebook.js` |
| Structured local ledger | `review` + append-only JSONL + `.lock` | `review-store.js:64-122` |
| Local semantic similarity | `zg` with `local/potion-retrieval-32m` (opt-in index) | `zvec-grep-cli.js:24` |
| Async external job | in-tool `start`/`status`/`cancel` returning a `task_id` | `futurehouse-agent.js:123-136` |
| Rating/ledger for hypotheses | **none** | — |
| Dedup gate / budget / plateau / quarantine | **none** | — |

Upstream inventory worth porting (all pure functions unless noted):

| Component | Upstream | What it is |
|---|---|---|
| Glicko-2 | `src/models/tournament.ts:64-230` | rating/RD/volatility update, Illinois σ′ solver |
| Review→rating seed | `tournament.ts:250` | `1000 + (avg/10) * 400`, reviewed RD 200 |
| Atomic dual update | `hypothesisStore.ts:119` | zero-sum pair write in one transaction |
| Judge debias | `agents/judgeDebias.ts:18-42` | map presented verdict, swap-and-average reconcile |
| Scheduler weights | `taskQueue/queue.ts:132-206` | six phase tables |
| Termination | `queue.ts:240-280` | budget, Elo plateau, cap+drained+enough-matches |
| Matchmaking | `agents/ranking.ts:319-346` | RD-priority, proximity opponent, top-10 pool |
| Duplicate gate | `agents/diversity.ts:12-30`, `proximity.ts:56-105` | ≥0.92 cosine discard; ≥0.70 similarity edge (upstream also caps the ANN candidate list at 20 — dropped here, since similarity is recomputed over the whole live pool at tournament sizes) |
| Citation penalty | `agents/citationIntegrity.ts:6-27` | soft penalty from weighted fabrication rate |
| Safety gate | `agents/safety.ts:4-56` | severity ranks → `quarantined`, human release |
| RLEF feedback | `rlef/reward-signal.ts:61-123` | reward → Glicko-2 vs a virtual opponent |
| Evolution seeding | `agents/evolution.ts:95-118` | child starts at `round(bestParentElo * 0.85)`, RD 350 |
| Role prompts | `src/prompts/{generation,reflection,ranking,evolution,meta_review,supervisor}/*.yaml` | 24 Handlebars templates with strict JSON contracts |

## 3. Design principles

1. **Port the math and the policy, not the runtime.** Anything deterministic
   and LLM-free moves to JS in this plugin. Anything that needs a model becomes
   a subagent brief. Nothing new gets a dependency.
2. **The loop stays model-driven; the decision rule stays in code.** The
   plugin has no background runner and tools must return. So `coscientist`
   exposes the *policy* (`next` returns the sampled task and the weights that
   produced it, `status` says whether to continue) and the session executes it.
   The model drives; the tool decides what driving means this turn.
3. **The tool enforces, the prompt only steers** — the standing rule from
   `docs/NON-SEARCH-TOOLS-PLAN.md` §8. A duplicate, an out-of-order review, a
   quarantined hypothesis, or an unverified citation is rejected in code.
4. **No new search provider, no new store engine, no new key** unless a phase
   genuinely needs one. Evidence, verification, and retrieval reuse what ships.
5. **No invented citations, unchanged.** Unverified stays `[VERIFY]`; a
   hypothesis with unverified citations is penalized, never silently credited.
6. **Append-only, human-auditable, resumable.** Same philosophy as the review
   ledger: state is derived from events, every rating change carries its
   evidence, nothing is overwritten.
7. **Advisory where it is not proof.** Near-duplicate detection and
   claim-support labelling are signals for a scientist, not verdicts.

## 4. Why the runtime is not vendored

The `ah` Python engine is vendored because it is a self-contained CLI in a venv
(`academic-harness-cli.js:237-269`). `co-scientist` cannot follow that path:

| Blocker | Upstream | Consequence here |
|---|---|---|
| `bun:sqlite` + `drizzle-orm/bun-sqlite` | `src/db/index.ts:1-2` | no bun in this plugin; Node ESM only |
| `sqlite-vec` native extension, raw `vec0` | `db/index.ts:142`, `migrate.ts:146` | native install, unbundled, Drizzle-unmodelable |
| ONNX MiniLM via `@huggingface/transformers` | `llm/embedding.ts:6-40` | ~80 MB weight download to `~/.cache` at first use |
| MCP OAuth 2.1 PKCE + dynamic client registration + loopback callback + `xdg-open` | `consensusAuth.ts:96,249,266`, `sciteAuth.ts:270` | interactive browser auth inside a plugin tool; `CONSENSUS_API_KEY`/`SCITE_API_KEY` already cover this natively |
| `parallel-web` SDK, `p-queue` | `tools/search.ts` | duplicates `parallel_search`/`parallel_extract` and `search-http.js` `RateLimiter` |
| ink 5 / react 18 TUI, commander bin | `src/cli/**` | the harness already has a UI; a `.ts`-run bin is not shippable here |
| Single-writer PID lock reading `/proc/<pid>/status`, `SIGKILL` | `db/index.ts:18-103` | hostile to a shared session process |
| Long-running autonomous supervisor | `agents/supervisor.ts:123` | no background job facility; the loop must be turn-driven |

Cost/benefit: the ported surface is ~600 lines of dependency-free JS plus
prompts. The vendored surface is a bun app, a native SQLite extension, an ONNX
model, two OAuth flows, and a duplicated search stack.

## 5. Component mapping

| co-scientist | Integration | Mechanism |
|---|---|---|
| `SupervisorAgent` loop | **Skill + policy tool** | `skills/co-scientist-tournament` drives turns; `coscientist next` supplies the sampled task |
| Goal parse (`supervisor/parse_goal.yaml`) | **Subagent brief** | one `subagent` call → stored as the session protocol |
| Generation ×4 strategies | **Subagent briefs + stored evidence** | `literature_exploration` / `scientific_debate` / `assumption_chaining` / `research_expansion`; discovery via existing search tools |
| DeepResearch evidence bank | **Reuse** | `parallel_search` (`advanced`) + `parallel_extract` + `paper_download` → `pdf_to_markdown` → PaperMemory |
| Reflection ×5 stages | **Subagent briefs; verdicts recorded in the tool** | tool computes the seed rating; stages are enforced in order |
| Provenance (claim→paper support) | **Reuse + tool** | `consensus_search`/`s2_search` per claim; support recorded as a claim ledger |
| Citation integrity | **Reuse** | `paper_resolve` → `crossref_lookup` (title-match 0.7) + `integrity_check` for retraction |
| Safety quarantine | **Tool state + human release** | status `quarantined`, release requires a reason |
| Glicko-2 tournament | **Ported** | `coscientist-models.js`; matchup + verdict recording in `coscientist_rank` |
| Judge debias | **Ported** | both orderings judged by two subagents (or one briefed twice); tool reconciles |
| Evolution ×6 mutations | **Subagent briefs + lineage** | `parentIds` lineage; child seeded at 85 % of best parent |
| Proximity/dedup gate | **Ported (lexical), optional vector upgrade** | shingle-Jaccard in-tool; `zg` embeddings where indexed |
| Knowledge graph | **Defer (P2)** | export as Mermaid through `mermaid_render` rather than a graph DB |
| Meta-review / research overview | **Subagent brief + tool field** | critique stored on the session and injected into later briefs |
| Experiment protocol | **Reuse** | `experiment-designer` skill/role; protocol stored on the hypothesis |
| Report/export, activity log | **Tool + `notebook`** | Markdown/JSON under `.dsh/coscientist/<slug>/exports/`; cards logged with `kind: "hypothesis"` |
| RLEF feedback | **Ported** | `coscientist_rank` `record_feedback` → reward → Glicko-2 vs virtual opponent |
| TUI / slash commands | **Drop** | DSH chat already provides it |

## 6. Phase 0 — deterministic core (`coscientist-models.js`)

One dependency-free module, every function pure, every constant carried over
verbatim with an upstream comment. This is the only place rating arithmetic
lives; no tool or prompt recomputes it.

| Export | Upstream | Contract |
|---|---|---|
| `GLICKO2_SCALE`, `TAU`, `GLICKO2_DEFAULTS`, `GLICKO2_REVIEWED_RD` | `tournament.ts:64-81` | `173.7178`, `0.5`, `{rating:1200, rd:350, volatility:0.06}`, `200` |
| `computeGlicko2Update(a, b, result)` | `tournament.ts:177` | `{newA, newB}`; RD capped at 350, σ rounded to 1e-6; Illinois solver, ε 1e-6, ≤1000 iterations |
| `seededGlicko2Rating(novelty, correctness, testability)` | `tournament.ts:250` | `round(1000 + (mean(scores)/10) * 400)`; RD `200` when any score exists else `350`; absent scores ignored |
| `citationPenalty({total, fabricated, unverified})` | `citationIntegrity.ts:11-27` | `f = (fabricated + 0.5 * unverified) / total`; `ratingDelta = -round(f * 150)`, `rdDelta = round(f * 100)`; `total === 0` ⇒ no penalty |
| `combineSwappedVerdicts(normal, swapped)` / `mapPresentedVerdict(presented, swapped)` | `judgeDebias.ts:18-42` | agree → winner; decisive+draw → decisive; contradictory → draw |
| `computeWeights(stats)` / `sampleNextTaskType(weights, rand)` / `shouldTerminate(stats, eloHistory)` | `queue.ts:132-280` | tables and thresholds verbatim (§9) |
| `selectMatchup(hypotheses, neighbours, rand)` | `ranking.ts:319-346` | priority `(rd ?? 350) / (matchesPlayed + 1)`; similar opponent first, else random from the top-10 slice |
| `isNearDuplicate(candidate, neighbours, threshold)` | `diversity.ts:12-30` | `score = max(cosine)`; duplicate when `score >= threshold`; `threshold >= 1` disables |
| `similarityEdges(pairs, {edge: 0.70, duplicate: 0.92})` | `proximity.ts:6,56-105` | edge above 0.70; duplicate above 0.92 rejects the lower-rated one |
| `extractRewardFromFeedback({sentiment, scores})` / `applyFeedbackAsGlicko2(reward, state)` | `reward-signal.ts:61-123` | `reward = 0.4 * sentiment + 0.6 * scoreAvg`; win/loss at `|reward| > 0.33` else draw; virtual opponent RD 50 |
| `evolvedSeedRating(bestParentElo)` | `evolution.ts:95-118` | `round(bestParentElo * 0.85)`, RD 350, volatility 0.06, or 1200 when parentless |
| `mulberry32(seed)` | `util/rng.ts:59` | seeded RNG so `SEED` reproduces a schedule |

Invariants the tests must lock in (they are the reason to port at all):

- Zero-sum: `newA.rating + newB.rating ≈ oldA.rating + oldB.rating` (±1 rounding).
- Draw is symmetric: equal-rating, equal-RD players return equal ratings.
- A win against a high-RD opponent moves the rating less than a win against a
  certain one (`g(φ)` damping).
- `seededGlicko2Rating` is monotone in mean review score and never below 1000
  once the citation penalty is folded in (`reflection.ts:175` clamps at 1000).
- `citationPenalty` is soft: one unverified citation among ten must not
  eliminate a hypothesis.
- Termination never fires before round 10, and plateau requires 20 Elo samples,
  `|Δ| < 5`, `totalMatches >= 10`, and `maxEver > 1210`.
- `mulberry32(SEED)` reproduces an entire `sampleNextTaskType` sequence.

## 7. Phase 0 — state store (`coscientist-store.js`)

Same shape and philosophy as `review-store.js`: append-only JSONL under the
workspace, current state derived from the latest event per key, no database, no
server, safe under concurrent subagent writes.

```
<cwd>/.dsh/coscientist/<slug>/
  protocol.json     goal, constraints, rubric, search_queries, max_hypotheses, step_budget, dup_threshold, seed
  events.jsonl      one line per hypothesis transition: added | reviewed | provenance | penalty |
                    safety | status | feedback | protocol | synthesis | dispatch
  matches.jsonl     one line per judged match (both orientations, verdict, transcript ref, ratings)
  snapshot.json     atomic (tmp + rename) derived state, regenerable from the logs
  exports/          leaderboard/report Markdown + JSON, never overwritten without `overwrite`
  .lock             held by store-lock.js while appending
```

As built, provenance/safety/feedback are **event types in `events.jsonl`**, not
separate files: one ordered log is what makes a replay reproduce the ratings
exactly, and splitting them would put the same hypothesis's history on two
timelines.

Rules:

- `<slug>` via the existing `reviewSlug()` normalizer; `start` refuses an
  existing `protocol.json` unless `resume: true`.
- Writes go through a lock. `review-store.js`'s `withLock` (`:96-122`, `mkdir`
  spin, 60 s stale steal, 10 s give-up) is not exported — **extract it to
  `store-lock.js`** and have both `review-store.js` and
  `coscientist-store.js` import it, rather than duplicating the spin (§19).
- Ratings are never stored twice: `snapshot.json` is a cache; a rebuild from
  the logs is the source of truth, and a mismatch is reported, not patched.
- The store is shared across the delegation tree by resolving the session root
  `cwd` the way `notebook.js:30-44` does, so parallel subagents append to one
  ledger.
- Every derived number a report shows is accompanied by the event count that
  produced it (matches played, reviews recorded) so a thin tournament is
  visibly thin.

## 8. Tool map

Three action-multiplexed tools; two on by default, one gated. Each is
`defineTool` + `inject: ['tools']` + `apply(ctx)` with `name =
'academic-harness-<module>'`, matching `review.js:202-206`.

### 8.1 `coscientist` — session, hypotheses, lifecycle (default)

| Action | Parameters | Behavior |
|---|---|---|
| `start` | `slug`, `goal`, `background`, `constraints`, `keywords`, `evaluation_criteria`, `hypothesis_attributes`, `evaluation_rubric`, `parsed_title`, `domain`, `search_queries`, `max_hypotheses`, `step_budget`, `dup_threshold`, `seed`, `resume` | Write `protocol.json`; refuse overwrite without `resume`; return the protocol and an empty leaderboard |
| `add` | `slug`, `hypothesis{title, summary, content, rationale, experimental_plan, key_assumptions[], citations[], novelty_assessment}`, `strategy`, `round`, `parent_ids[]` | Run the duplicate gate against same-session non-rejected entries and **discard with the offending score** when it fires; assign id; seed rating (1200/350/0.06 for `generation:*`, `evolvedSeedRating` for `evolution:*`); append `added` |
| `review` | `slug`, `id`, `stage` (`initial`/`full`/`deep_verification`/`simulation`/`observation`), `verdict` (`pass`/`fail`/`uncertain`), `novelty_score`, `correctness_score`, `testability_score` (0–10), `safety_flag`, `summary`, `critique`, `supporting_evidence[]` | Enforce stage order; `fail` at `initial` or `full` → `rejected`; after `observation` compute the best-of-stages seed + citation penalty and mark `active`; append `reviewed` |
| `status` | `slug` | Leaderboard (rank, rating, RD, W/L/D, matches, strategy, lineage), counts by status, rounds, budget used, `terminated` + reason, weights in force |
| `next` | `slug`, `rand` (optional, else seeded) | `computeWeights` + `sampleNextTaskType` + `shouldTerminate` → `{task, weights, terminate, reason, guidance}` — the policy the session must follow this turn |
| `set_status` | `slug`, `id`, `status` (`active`/`rejected`/`quarantined`), `reason` | Only legal transitions; `rejected` requires a reason; releasing `quarantined` requires `reason` and records who |
| `lineage` | `slug`, `id` | Parent/child tree + field-level diff against the parent (upstream `diff` command) |
| `export` | `slug`, `format` (`markdown`/`json`), `overwrite` | Ranked report with verdicts, transcripts, provenance summary; write under `exports/` |

### 8.2 `coscientist_rank` — matches and feedback (default)

| Action | Parameters | Behavior |
|---|---|---|
| `propose` | `slug`, `k` (ANN candidates, default 20) | `selectMatchup` using RD priority + similarity edges; returns the pair and **both presentation orders** the caller must judge |
| `record` | `slug`, `a`, `b`, `verdict_ab`, `verdict_ba`, `rationale`, `transcript`, `round`, `match_type` — each verdict names the **presented slot**, so agreement is `A` + `B` | Map `verdict_ba` back to real terms, `combineSwappedVerdicts`, then one atomic dual Glicko-2 update under the lock; append to `matches.jsonl`. A verdict supplied for only one orientation is accepted but reported as `position_controlled: false` |
| `compare` | `slug`, `a`, `b` | Manual head-to-head: returns the pair and both orders without recording (the session judges, then calls `record`) |
| `feedback` | `slug`, `id`, `feedback_text`, `sentiment` (−1..1), `novelty`/`correctness`/`testability` (0–10), `recorded_by` | `extractRewardFromFeedback` → Glicko-2 vs the virtual opponent; append `feedback`. This is the only path that lets an experimental result move a rank |
| `similarity` | `slug`, `id` | Neighbours above 0.70 with scores (feeds `next` matchmaking and the report) |

### 8.3 `coscientist_verify` — citation integrity + claim support (gated)

`if (!optionalToolsEnabled()) return`, i.e. `AH_ENABLE_OPTIONAL_TOOLS=1` and a
restart, same as `figure-audit.js:89`.

| Action | Parameters | Behavior |
|---|---|---|
| `citations` | `slug`, `id` | For each citation: `paper_resolve` then Crossref/OpenAlex title match (threshold 0.7, `CROSSREF_MAILTO` polite pool, shared `getLimiter`); classify `verified`/`unverified`/`fabricated`; return `{f, ratingDelta, rdDelta, summary}` and store the ledger row. The caller folds the delta in via `review`/`set_status`; a registry that could not be queried yields `unverified`, never `verified` |
| `claims` | `slug`, `id`, `query_per_claim` (default true) | Split the hypothesis into load-bearing claims, search each (`consensus_search` + `s2_search`), return per-claim `supports`/`contradicts`/`unaddressed` with the paper and a confidence, plus a one-line summary for the debate brief. Advisory: labels a claim's literature status, never a verdict on the hypothesis |

No tool calls a model. `remoteJudge` (`rsi-core.js:850-900`) proves the plugin
*can* reach an env-configured endpoint, but bundling an LLM client into these
tools would fork the session's model routing and billing for no benefit —
subagents already are the harness-native LLM worker, and they return
asynchronously with completion notices (`prompt.js:59`).

## 9. Scheduler policy, ported verbatim

`computeWeights` tables (generation / reflection / ranking / evolution /
proximity / meta_review) as in `queue.ts:132-206`:

| Phase | Condition | Weights |
|---|---|---|
| At cap, reviews pending | `total ≥ maxHypotheses && pendingReview > 0` | 0 / .70 / .15 / .05 / .05 / .05 |
| At cap, drained | `total ≥ maxHypotheses` | 0 / .10 / .55 / .25 / .05 / .05 |
| Review backlog | `pendingReview > active * 0.5` (checked before bootstrap) | .10 / .55 / .20 / .08 / .05 / .02 |
| Bootstrap | `active < 3`, `canRank = active ≥ 2` | .70/.22/.03/.03/.02/.03 → .50/.20/.20/.03/.04/.03 |
| Mid-run | `round < 20` | .30 / .20 / .30 / .10 / .07 / .03 |
| Late-run | otherwise | .15 / .20 / .30 / .25 / .05 / .05 |

`shouldTerminate` (`queue.ts:240-280`) in priority order: budget exhausted;
never before round 10; Elo plateau (≥20 samples, `|Δ| < 5`, `totalMatches ≥ 10`,
`maxEver > 1210`); cap reached with nothing pending and
`totalMatches ≥ active * 3`. As built, the plateau/cap guards are evaluated
against **completed** dispatches rather than the one about to start, so the loop
runs at most one dispatch more than upstream before either can fire — the budget
guard is checked first and is unaffected.

Two items are recorded in §13.4: the default pool matches upstream's 5 with a
budget derived from what that pool actually costs, and a fourth stop reason
`no_competitors` catches the stall a smaller pool makes reachable.

One deliberate deviation: upstream counts **tokens** from its own LLM client
(`llm.getTotalTokensUsed()`). The plugin cannot see subagent token usage from a
tool, so `budget_tokens` degrades to an **advisory round/step budget** —
`next` counts dispatch rounds and the session reports elapsed tokens from
context. Recorded as an open decision (§19.4); everything else keeps its exact
numbers so results stay comparable to upstream.

## 10. Evidence, dedup, and search integration

- **Evidence gathering** replaces upstream's Consensus/Scite MCP + Parallel SDK
  stack with tools that already ship: `consensus_search` **and**
  `parallel_search` in the same round (the standing `literature-researcher`
  rule), `openalex_search`/`s2_search`/`pubmed_search` for discovery breadth,
  `parallel_extract` + `paper_download` → `pdf_to_markdown` when a claim needs
  full text, PaperMemory search before re-deriving anything already ingested.
- **No search dead-switch ported.** Upstream halts the whole session after 5
  consecutive empty searches (`search.ts:208`). Here each search tool surfaces
  its own error and the skill stops generating when the literature layer is
  unavailable, so a keyless provider cannot silently halt the tournament.
- **Duplicate gate** is lexical by default: word 5-gram shingles over the
  normalized title + summary, Jaccard against same-session non-rejected
  candidates, discard at ≥ 0.70 (≈ upstream's cosine 0.92 in strictness;
  `dup_threshold: 1` disables it). Deterministic, no dependency, no download.
  **The `zg` upgrade drafted here does not exist.** `zg query --vector <text>`
  embeds a query to search an *index* and never returns the vector, and there is
  no `zg` command that embeds arbitrary text, so a workspace index cannot supply
  hypothesis embeddings. Phase 4 therefore implements cosine dedup through the
  Gemini embedding endpoint the plugin already credentials for
  `image_generate` — opt-in per call (`coscientist embed`), see §13.3.
- **Cross-session priors** (upstream `reward_memory`) map onto PaperMemory for
  papers/claims and the notebook for hypotheses; no fourth store.

## 11. Skill and subagent orchestration

`skills/co-scientist-tournament/SKILL.md` (seeded automatically by
`seed.js:12-26`) carries the loop. Every upstream YAML prompt becomes a brief
block in `references/` with its template variables named explicitly, since a
subagent receives prose in `prompt`, not Handlebars.

| Brief | Upstream template | Output contract |
|---|---|---|
| `parse-goal` | `supervisor/parse_goal.yaml` | title, domain, keywords[], hypothesisAttributes[], evaluationRubric, searchQueries[] |
| `gen-literature` | `generation/literature_exploration.yaml` | title, summary, content, rationale, experimentalPlan, noveltyAssessment, keyAssumptions[], citations[] |
| `gen-debate` | `generation/scientific_debate.yaml` (+ a second turn: challenge → refine) | same 8 keys |
| `gen-assumption-chain` | `generation/assumption_chaining.yaml` | same |
| `gen-expansion` | `generation/research_expansion.yaml` (+ unexplored concepts) | same |
| `rev-initial/full/deep-verification/simulation/observation` | `reflection/*.yaml` | verdict, 3 scores, safetyFlag, summary, critique, supportingEvidence[] |
| `advocate` / `judge-simple` / `judge-debate` | `ranking/simple_comparison.yaml`, `ranking/debate_match.yaml` | `{"winner":"A"\|"B"\|"draw","rationale"}` |
| `evolve-grounding/coherence/cross-pollination/combination/simplification/out-of-box` | `evolution/*.yaml` | the 8-key hypothesis object |
| `synthesize-critique` / `research-overview` | `meta_review/*.yaml` | critique prose injected into later briefs |
| `design-protocol` | `experiment_design/protocol.yaml` | stepwise protocol on the top hypothesis |
| `classify-safety` | `reflection/safety_review.yaml` | severity (`none`/`low`/`moderate`/`high`) + category |

Loop the skill runs, one tool-visible step at a time:

1. `start` → `parse-goal` subagent → protocol saved into `protocol.json`.
2. Ask for `next`; dispatch exactly that task:
   - *generation* → gather evidence, run one strategy brief, `add`; the tool's
     duplicate gate may discard it, which is a normal outcome to report.
   - *reflection* → five stage briefs in order, then `coscientist_verify
     citations` + `claims` when gated on, `review` each stage.
   - *ranking* → `propose`, judge **both orders** (two subagents, or one briefed
     twice with the pair swapped), `record`.
   - *evolution* → pick a top hypothesis, run a mutation brief, `add` with
     `parent_ids`.
   - *proximity* / *meta_review* → `similarity` refresh; synthesis brief whose
     critique is stored and prepended to later generation.
3. Re-ask `next` until it returns `terminate` with a reason; never loop past a
   budget warning without telling the user.
4. On termination: `design-protocol` for the top hypothesis, `research-overview`
   synthesis, `export`, then `notebook` cards (`kind: "hypothesis"`,
   `stance: supports/refutes`) for the kept hypotheses.
5. Any `safety_flag` or a flagged classification → `set_status quarantined`,
   presented to the human as withheld pending an explicit release with reason.
6. Later experimental results go through `feedback`, not prose.

Generation-strategy rotation is likewise upstream's
(`generation.ts:363-370`: literature-first below 3 active, then
`round % 4`), as is evolution's `round % 6`. The skill quotes them; the tool
records what actually ran.

Also add a `workflows.json` entry (`co-scientist-tournament`, category
`ideation`, placeholders `goal`/`max_hypotheses`) so the existing
`research_template` tool can hand the loop to a fresh session, and one
`docs/AGENTS-PLAN.md`-consistent roster note: the tournament briefs are
*stages*, not new named specialists, so `hypothesis-generator` stays the single
delegation name for the generation stage.

## 12. Registration and wiring

| File | Change |
|---|---|
| `coscientist-models.js`, `coscientist-store.js`, `store-lock.js` | New (Phase 0) |
| `coscientist.js`, `coscientist-rank.js`, `coscientist-verify.js`, `coscientist-embed.js` | New tools |
| `review-store.js` | Import the extracted `store-lock.js`; behavior unchanged |
| `presets/academic-harness/agent.cordis.yml` | `- id: coscientist / name: academic-harness/coscientist` (+ `coscientist-rank`, `coscientist-verify`); no realm — each registers into the shared `tools` registry and provides no service, per the file's own rule at `:12-19` |
| `package.json` | `exports` + `files` entries for all six modules; **no new dependency** |
| `settings-keys.js:42` | `CO_SCIENTIST_MAX_HYPOTHESES`, `CO_SCIENTIST_STEP_BUDGET`, `CO_SCIENTIST_DUP_THRESHOLD`, `CO_SCIENTIST_SEED` (defaults in-tool, Settings-editable per call) |
| `client/ApiKeysSection.jsx` | New "Hypothesis tournament" group |
| `prompt.js` | New `## Hypothesis tournaments` section after `## Lab notebook`; extend the `prompt.js:15` routing sentence so a one-shot ask stays on `generating-scientific-hypotheses` and a persistent/rigorous ask loads the tournament skill |
| `skills/co-scientist-tournament/` | `SKILL.md` + `references/*.md` briefs |
| `workflows.json` | `co-scientist-tournament` template |
| `scripts/test-coscientist-models.mjs`, `test-coscientist-store.mjs`, `test-coscientist-tool.mjs`, `test-coscientist-verify.mjs` | New suites (fake `ctx`/`exec` pattern of `test-review-tool.mjs:5-13`; `node:assert/strict`) |
| `README.md` | Tool section + keys + optional-tool enablement + upstream attribution |
| `NOTICE` | Add the ported-code line: algorithms and prompts derived from `co-scientist` (MIT © 2025 Raktim Mondol), itself inspired by Gottweis et al. (already cited at `NOTICE:83`) |
| `cordis.patch.yml` | `npm run build:patch` |
| `lib/client.js` | `npm run build` |
| `docs/CO-SCIENTIST-INTEGRATION-PLAN.md` | Status and checklist updated as phases land |

`index.js` is not touched — these are preset-only, like every Phase 1–8 tool.

## 13. Phases

**Phase 0 — core and store.** `coscientist-models.js`,
`coscientist-store.js`, `store-lock.js` extraction, three suites. *Accept:*
every §6 invariant holds; zero-sum survives a 200-match simulated tournament;
`mulberry32(SEED)` reproduces a sampled sequence byte-for-byte; a simulated
concurrent write of 50 events under lock derives exactly the expected snapshot;
`review` tool tests still pass after the lock extraction.

**Phase 1 — tournament (default-on).** `coscientist` (`start`/`add`/`review`/
`status`/`next`/`set_status`/`lineage`/`export`) + `coscientist_rank`
(`propose`/`record`/`compare`/`similarity`), preset rows, `prompt.js` section,
skill with the parse/generation/reflection/judge briefs. *Accept:* a goal →
≥6 ranked hypotheses with recorded verdicts across a resumed session; a
near-duplicate `add` is discarded with its score; `review` out of stage order is
rejected; a `fail` at `initial` rejects before any debate is spent; `record`
with contradictory orientations yields a draw; ratings move only through
`record`/`feedback`; `next` reaches `terminate` on the plateau rule in a
simulated schedule; `export` writes Markdown/JSON without overwriting.

**Phase 2 — loop breadth.** Evolution briefs + lineage seeding,
`compare`/`feedback`, `meta_review` critique injection, `design-protocol`,
`research-overview`, `workflows.json` template, README. *(Partly absorbed into
Phase 1 — see §13.1: `compare`, `feedback`, `design_protocol`, `synthesize`, and
`lineage` shipped with the tools; the briefs are written. What is left is the
`workflows.json` template and the subagent-run discipline in the skill.)* *Accept:* an evolved
child is seeded at `round(0.85 × bestParent)` with RD 350 and appears in
`lineage`; `feedback` with `reward > 0.33` raises the rating and the ledger
shows why; the protocol lands on the top hypothesis and nowhere else.

**Phase 3 — verification and safety (gated).** `coscientist_verify` +
`classify-safety` + quarantine wiring + claim-support injection into debates.
*Accept:* a fabricated citation lowers the seed and widens RD by the mapped
amount; a registry failure yields `unverified` and never `verified`; a `high`
severity classification quarantines and `set_status` refuses to activate it
without a release reason; `AH_ENABLE_OPTIONAL_TOOLS` unset leaves both tools
absent from the surface.

**Phase 4 — vector similarity, graph export, cross-session priors.** As built:
`coscientist embed` (Gemini embeddings, not `zg` — see §10), `coscientist graph`
+ `export format: mermaid` (rendered by `mermaid_render`), and `coscientist priors`
(sibling-ledger retrieval). *Accept:* an embedded pool gates at cosine 0.92 and
labels the measure; a partly embedded pool reports `mixed` and never blends
scales; one model per tournament is enforced; the graph has no dangling edges,
dedupes a shared paper, survives labels containing `[`, `"`, `<`, `|`, and reads
identically twice; priors surface another slug's refutation and withholding, rank
by overlap, skip the current slug, and never fail on a corrupt sibling.

### 13.1 Phase 0–1 implementation notes (2026-10-24, unreleased)

Landed as planned, with four deliberate deviations found while testing:

- **One event log, not four.** Provenance, penalty, safety, status, feedback,
  protocol, synthesis, and dispatch are types in `events.jsonl` (§7). Ratings
  replay from `events.jsonl` + `matches.jsonl` in one pass, so a rebuilt snapshot
  is provably equal to the cached one — the store suite asserts that.
- **Cap before gate.** `add` checks `max_hypotheses` before running the duplicate
  gate, so a full tournament reports `hypothesis_cap` rather than doing similarity
  work it cannot use. Consequence for the loop: once the pool is full, a
  restatement is refused as a cap hit, not as a duplicate.
- **A set-aside idea is not lineage.** `add` refuses `parent_ids` naming a
  `rejected` or `quarantined` hypothesis: an 85 % seed from a dead idea would
  launder it back into the tournament. Rejected ideas stay readable through
  `lineage`, and a revived idea is added as a new hypothesis.
- **Idempotent status.** `set_status` to the status a hypothesis already holds
  returns `unchanged: true` and writes no event, instead of erroring on a
  transition the caller did not need.

The **orientation mapping** (§8.2) is the sharp edge of this surface, and each
order reports the *presented* slot: agreement is `verdict_ab: A` with
`verdict_ba: B`. Passing the same letter twice is the third row of the table in
`references/tournament.md` §3 — a draw, not a bug. A test written against the
intuitive reading fails exactly this way, so the mapping is stated in the tool's
parameter description, in `record`'s render output, in the skill, and in the
golden-surface test.

Also shipped, beyond the Phase 1 list: `feedback` (RLEF), `compare`,
`design_protocol`, `synthesize`, and `lineage`. **Phase 2 therefore shrinks** to
the remaining briefs (the four generation strategies and six mutations are
already written in `references/briefs.md`; the evolution/protocol/overview
subagent runs are a skill-discipline matter), the `workflows.json` template, and
the README prose. Phase 3 (`coscientist_verify`) is not built; the store already
accepts its output. `recordProvenance` folds the mapped penalty into the seed when
the check arrives before the final review stage, and applies it as its own
`penalty` event when it arrives after activation. The review event records what
the seed consumed, so a re-verification charges only the difference — the same
penalty is never counted twice whichever order it arrives in (asserted both ways
in `scripts/test-coscientist-store.mjs`).

Verification: `npm run test:coscientist` (`scripts/test-coscientist-models.mjs`
for every §6 invariant, `scripts/test-coscientist-store.mjs` for sequencing,
concurrency, resume, and export, `scripts/test-coscientist-tool.mjs` for a whole
tournament driven only through the registered tool surface — including a
termination reached through the sampled schedule), plus
`scripts/test-nonsearch-tools.mjs` extended with the §12 golden markers and a
pin on the upstream first-match value (a 1200/350 vs 1200/350 `A_wins` yields
1362/1038). `store-lock.js` extraction is covered by the pre-existing
`test-review-store.mjs` and `test-review-tool.mjs`, both still green.

Budget deviation (§9) shipped as decided: `terminationCheck` receives
`tokensUsed = dispatches` and `budgetTokens = step_budget`, and the tool renders
`steps_used/step_budget` — never a token figure it cannot observe.

### 13.2 Phase 3 implementation notes (2026-10-24)

`coscientist-verify.js` ships gated behind `AH_ENABLE_OPTIONAL_TOOLS`, as the one
tournament module that reaches the network. Four decisions differ from §8.3:

- **`claims` records; it does not judge.** Deciding whether a paper supports a
  claim is a model judgement, and a tool here cannot call a model. So
  `coscientist_verify claims` takes the `{claim, support, confidence,
  paper_title, paper_doi}` array a subagent produced and puts it in the ledger —
  the same division `review` keeps between the screening ledger and the search
  layer. §8.3's "split the hypothesis into load-bearing claims, search each" is
  therefore the skill's brief (`references/briefs.md` §7), not this tool's job.
- **Three ways to come back unverified, said differently.** No candidate returned;
  a candidate that shared fewer than three significant title tokens; a partial
  match below 0.7. All three are `unverified`, and `fabricated` is reserved for
  the one case upstream reserves it for — a DOI the caller asserted that Crossref
  does not list. A registry outage is never a verification and never an accuse of
  invention.
- **One Crossref budget.** The limiter is process-wide and keyed by name, so the
  polite-pool intervals match `crossref_lookup` and `integrity_check` exactly
  rather than opening a competing third one. Verification runs sequentially; a
  burst of parallel registry hits is how a check gets rate-limited away.
- **`recordProvenance` merges.** Counts and claim judgements may arrive apart, in
  either order, and each falls back to what the ledger already holds — so a
  claims pass cannot erase a citation check, and a re-check charges only the
  difference against what the seed already absorbed.

Retraction is reported, not scored: `check_integrity: true` reuses
`runIntegrityCheck` and lists retracted/under-concern citations separately,
because a retracted paper still *exists* — the penalty measures fabrication, and
conflating the two would silently invent a new rating rule.

**The safety gate got a tool surface.** §8 assigned quarantine to the store but
left `recordSafety` unreachable from a session. `coscientist` now has a `safety`
action (severity/category/reasoning/threshold) that applies the upstream
severity-rank decision and withholds automatically; a review attempt on a
withheld hypothesis is refused, and release still needs a name (§17 keeps the
human-in-the-loop rule). Actions on `coscientist` are therefore eleven, not ten.

Verification: `scripts/test-coscientist-verify.mjs` runs the whole matrix against
Crossref/OpenAlex fixtures — every classification and reason string, mailto
politeness, cancellation, the seed-order vs active-order penalty paths,
idempotent re-verification, claims merging and validation, retraction reporting
without a penalty change, the 30-citation cap, and the gate (nothing registers
without the flag). `scripts/test-optional-tools.mjs` now covers all three gated
modules together.

### 13.3 Phase 2 and 4 implementation notes (2026-10-24)

Phase 2 needed no new code: the evolution/protocol/overview briefs were already
written into `references/briefs.md` with Phase 1, and the remaining item — the
catalogue entry — landed as `co-scientist-tournament` in `workflows.json`
(category `literature`, placeholder `goal` required, `max_hypotheses` optional,
routing to the skill), reachable through the existing `research_template` tool.

Phase 4 changed one documented behaviour and fixed one latent bug.

- **The bug first.** `similarity()` took `one.vector ?? one.text`, so an
  embedded candidate compared against an unembedded neighbour scored
  `String([0.11, -0.4, …])` as a bag of digit shingles — a plausible-looking
  number on neither scale. The API now takes `{ text, vector }` on both sides and
  uses cosine **only** when both are embedded with equal dimensions; a mixed pool
  degrades to lexical and says `measure: 'lexical'` for that pair.
- **Thresholds follow the measure.** `protocol.dup_threshold` is `null` by
  default, meaning "0.92 if cosine, 0.70 if lexical" (`defaultThresholds`), so
  turning embeddings on does not silently apply a lexical bar to cosine scores. An
  explicit number still overrides, and `1` still disables the gate. Every
  discard and every edge now carries `measure` and the `threshold` that fired.
- **Vectors arrive through one door.** `add` already accepted a `vector`; the new
  `embed` action fills in whatever the pool lacks, in one batch, and
  `attachVectors` refuses mismatched dimensions outright — two embedding models
  in one tournament would make every later number meaningless and undetectable.
  Re-attaching replaces (last event wins) rather than duplicating a hypothesis.
- **`GEMINI_API_KEY`, not a new provider.** Embeddings reuse the credential the
  plugin already carries for `image_generate` and the shared `search-http`
  limiter; the key goes in an `x-goog-api-key` header, never the URL. Absent a
  key the call fails with the reason rather than falling back quietly, because a
  "semantic" result obtained lexically would be a lie about its own scale.
  `CO_SCIENTIST_EMBED_MODEL` overrides the default model.
- **The graph is derived, not authored.** `knowledgeGraph` walks the ledger:
  `evolved` edges from `parentIds`, `related` edges from the same similarity pass
  the gate uses, and paper nodes only from claim judgements already recorded. No
  concept extraction — upstream mined concepts with a model, and inventing that
  here would put unverified edges into a figure. A lineage pair is never repeated
  as a similarity edge, and labels are stripped of everything Mermaid parses as
  syntax, which is asserted against a title containing `["alpha"] <b>|</b>`.
- **Priors read the siblings.** Upstream kept a `reward_memory` table; here
  `priorFeedback` scans `<cwd>/.dsh/coscientist/*` for `feedback`, rejected
  `status`, and quarantined events outside the current slug and ranks them by
  order-free token overlap (`tokenOverlap` — shingle overlap scored 0 between a
  query and a paraphrased prior, which is why this needed a second measure). A
  sibling with corrupt JSON is skipped; a sibling with no readable `protocol.json`
  still contributes, falling back to its slug for provenance. Retrieval is a
  hint to the scientist, never an automatic veto on generation.

Tests: `scripts/test-coscientist-embed.mjs` (request shape, header-not-URL, batch
and blank-text handling, every `parseEmbeddings` failure including dimension
mismatch, key fallback, 403/cancel/short-response errors, token overlap) and
`scripts/test-coscientist-graph.mjs` (vector validation, cosine gate switch,
dimension refusal, graph structure/escaping/determinism, prior ranking,
self-skip, corrupt and protocol-less siblings). Both run in
`npm run test:coscientist`, which now covers six suites.

### 13.4 Shortlist defaults and the stall guard (2026-10-24)

**Final defaults: `DEFAULT_MAX_HYPOTHESES` 5, `DEFAULT_STEP_BUDGET` 36.** These
were 6/40 as drafted, then briefly 3/24 while "smaller is cheaper" was being
tested; 3 was reverted because it is not actually a workable pool, and the
arithmetic is what settled it. A pool of N with L lost to vetoes or withholding
ends on `cap_reached_and_ranked` after 3·(N−L) matches, which must be spread over
(N−L)(N−L−1)/2 pairs:

| N | L=0 matches (per pair) | L=2 matches (per pair) | rounds to finish | plateau reachable |
|---|---|---|---|---|
| 3 | 9 (3×) | **1 active → stall** | ~20 | never |
| **5** | 15 (1.5×) | 9 (3×) | ~31 | yes |
| 6 | 18 (1.2×) | 12 (2×) | ~36 | yes |
| 8 | 24 (0.9×) | 18 (1.2×) | ~47 | yes |

Three hypotheses die from ordinary attrition — one review veto plus one dual-use
withholding leaves a single candidate and nothing can be matched. Five is the
smallest pool where losing two still leaves three competing at upstream's own
3-matches-each ratio, it is upstream's default cap (`MAX_HYPOTHESES=5`), and it
keeps per-pair coverage above the point where a ranking stops being head-to-head
and becomes a transitive chain. 36 = the ~31 rounds a clean 5-pool needs plus
slack for generations the duplicate gate discards; it is also the smallest budget
at which `elo_plateau` can fire, since that rule needs 20 dispatch samples and
≥10 matches — at 24 the plateau branch was unreachable code. Both defaults are
stated with that arithmetic where the constants live
(`coscientist-store.js:47-67`), in the Settings hints, in the tool description,
and in the skill's budget paragraph, because the failure mode is a user raising one
without the other. The leaderboard never truncated anything — it lists every
non-rejected hypothesis — so the pool size *is* the list size, and the only
10-window in the code is `TOP_ELO_WINDOW`, the plateau statistic.

**`no_competitors`** is a deliberate addition to the ported termination rules: the
cap is reached, nothing waits for review, and fewer than two hypotheses can still
compete. Upstream could not easily reach that state at 5–20 hypotheses; at a
default of 3, one review veto plus one withholding leaves a single candidate,
and the old rules would keep sampling `ranking` (which cannot pair one
hypothesis with itself) until the budget ran out. It sits **before** the
round-10 guard for that reason — there is no work for the remaining rounds to do
— and after the budget check, so `budget_exhausted` still wins when both apply.
`pendingReview > 0` and `totalHypotheses < cap` both keep the loop alive, which is
what stops it firing during a normal bootstrap.

The same change made the recognition surface testable, and it needed to be: the
skills are selected from their frontmatter `description` plus the triage table, so
`scripts/test-coscientist-routing.mjs` asserts (1) each description still contains
the phrasings it claims to trigger on, including the problem-shaped ones ("why
does", "expected A and got B", "test next", "falsify"); (2) each skill's negative
clause still names the near-miss families and where they belong; (3) every
destination named in the triage table is a shipped skill directory, which is the
check that catches a rename breaking routing; (4) `prompt.js` still carries the
"ranked and kept" fork. It then scores a fixed set of realistic asks against both
descriptions with the same order-free `tokenOverlap` the ledger uses and asserts
the right side wins **by a margin** on the eight asks whose vocabulary genuinely
differs — and explicitly does *not* assert a universal threshold, because a
bag-of-words overlap between a one-line ask and a paragraph of prose scores
0.14–0.29 on function-word noise alone. The two asks it cannot separate are
asserted to be the ones the skill instructs the agent to ask about instead, so the
brittle part of routing stays documented rather than falsely numeric.

Tests: models gains the stall matrix (`no_competitors` fires for 0/1 active at
cap; not with a pending review; not below the cap; not with two active; budget
still first), the store asserts the defaults on a session that passes none and
that explicit values still override, and the tool drives a real 3/24 tournament
(explicit, because the shipped 5/36 defaults are chosen not to stall) where two of
three ideas are vetoed — it stops at round < 6 with `no_competitors` rather than
spending the budget, while the same two-loss shape under the default 5-pool is
asserted to keep three competitors alive.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Token cost explodes (debate matches are 3 reason calls, upstream's own worry) | `max_hypotheses` + step budget defaults kept small (6 hypotheses / 40 steps); `next` reports cost per dispatch; the skill surfaces cumulative steps every round and stops on the warning |
| Model-driven loop drifts off-rails | The policy is in the tool, not the prose: `next` returns exactly one dispatch and `status` refuses to continue past termination; the skill may not improvise a sixth review stage |
| Judge bias despite both orderings | Contradictory orientations become draws in code; a single-orientation `record` is accepted but flagged `position_uncontrolled` in the render, so a thin judgment is visible |
| Lexical dedup misfires (same mechanism, different claim) | Advisory threshold, tunable, `1` disables, and the discarded pair is always reported with its score so a human can overrule |
| Glicko-2 misread as measured quality | Leaderboard always shows matches played + RD; a report of a 2-match tournament is labelled preliminary; ratings are never rendered as confidence |
| Store bloat / concurrent subagent corruption | Append-only logs, one lock, derived snapshot regenerable from the logs. The ledger sits beside `review`'s and `notebook`'s under `.dsh/`; it is working state, not the deliverable, so only `exports/` output is what a user version-controls or attaches. |
| Quarantine read as censorship | Withheld, not deleted: severity, category, and the human release path with recorded reason are in the same ledger; the tool states it screens dual-use risk, not truth |
| Overlap with `generating-scientific-hypotheses` | That skill stays the one-shot path; the tournament skill is only for persistent/ranked/multi-round asks, and the routing sentence in `prompt.js:15` draws the line |
| Overlap with `review`/`notebook`/`ah_*` ledgers | Four separate concerns stay separate: papers/claims = PaperMemory, screening = `review`, prose ledger = `ah_*`, hypothesis tournament = `coscientist`, with `notebook` as the human-facing log |
| Upstream drift | Port functions and constants once with `upstream:` comments and a pinned commit; no live coupling, no vendored code tree |
| Attribution gaps | NOTICE line + README credit for both the ported code and Gottweis et al. |

## 15. Explicit non-goals

- No vendoring of the `co-scientist` runtime, no bun, no `bun:sqlite`, no
  `sqlite-vec`, no `drizzle` (§4).
- No new literature provider, no MCP OAuth client, no re-implementation of
  Consensus/Scite auth.
- No ONNX/transformers embedding model shipped or downloaded at runtime.
- No autonomous background supervisor, no long-running tool, no polling loop
  inside a tool call.
- No new subagent names in the DSH roster; tournament stages reuse the
  `subagent` tool with briefs.
- No in-tool LLM client and no second model route.
- No wet-lab execution, no protocol automation, no clinical or regulatory
  claims; generated hypotheses remain hypotheses, and `design-protocol` output
  is a plan a scientist reviews.
- No knowledge-graph database, no entity resolution.
- No automation of dual-use decisions: quarantine is a human gate, never an
  auto-reject, and never a claim that a released hypothesis is safe.
- No replacement of `generating-scientific-hypotheses`, `experiment-designer`,
  or `hypothesis-generator`.
- No claim that a Glicko-2 rating measures scientific merit; it measures
  tournament outcomes, and unplayed hypotheses carry RD 350.

## 16. Sequencing and release shape

Phase 0 + 1 land together as **v0.22.0** — the store without a tournament is
inert, and the tournament without the store is what the plugin already has.
Phase 2 is a v0.22.x feature release (skill briefs only, no schema change).
Phase 3 ships gated behind `AH_ENABLE_OPTIONAL_TOOLS` with the other optional
tools, so a `dsh` restart note goes in the README. Phase 2 and 4 ride along in the
same release: they add no gated surface (`embed` is an action on an ungated tool but
is opt-in per call and costs a key + a request), and the graph depends on
`mermaid_render`, which ships on every preset.

Docs update in the same release: this file's status line, the README tool
table, and `docs/AGENTS-PLAN.md`'s roster note about stage briefs.

## 17. Open decisions

1. **Two default tools vs one.** §8.1/§8.2 split state from math. A single
   action-multiplexed `coscientist` with ~14 actions is also defensible and
   costs less prompt real estate; decide at implementation against the
   rendered description length.
2. **`store-lock.js` extraction** vs ~25 duplicated lines. Preferred: extract,
   since two stores with divergent lock behavior is the worse failure mode.
3. **Dedup default.** Lexical 0.70 (no deps, always available) vs requiring a
   `zg` index. Lexical is the default; vector is a P4 flag.
4. **Budget semantics without token visibility.** Options: round/step budget
   (simple, honest), a `tokens_used` parameter the session supplies from context
   accounting (closer to upstream, untrustworthy), or deferring budget
   enforcement to the plateau rule only. Pick at Phase 1 with a real session's
   usage data.
5. **Quarantine vs `ah` hooks.** Whether a quarantined hypothesis should also
   be blocked from `ah_*` writing flows (e.g. never becoming a claim/source
   without release), or stay purely inside this ledger. Needs a look at
   `academic-harness-hooks.js:209-260`.
6. **RD display.** Show raw Glicko-2 RD alongside ratings, or translate to a
   confidence band for readers who will not know what 110 means.

## 18. Task checklist

- [x] Phase 0: `coscientist-models.js` (Glicko-2, seed, penalty, debias,
      weights, termination, matchup, dedup, RLEF, evolution seed, mulberry32)
- [x] Phase 0: `store-lock.js` extraction + `coscientist-store.js`
      (protocol, events, matches, provenance, safety, snapshot, exports)
- [x] Phase 0: `scripts/test-coscientist-models.mjs`,
      `test-coscientist-store.mjs` (§6 invariants, concurrency, resume)
- [x] Phase 0: re-run `test-review-store.mjs` / `test-review-tool.mjs` after the
      lock extraction
- [x] Phase 1: `coscientist.js` + `coscientist-rank.js`
- [x] Phase 1: `scripts/test-coscientist-tool.mjs` (temp workspace, fake ctx/exec)
- [x] Phase 1: preset rows, `package.json` exports/files, `settings-keys.js`,
      `client/ApiKeysSection.jsx`
- [x] Phase 1: `skills/co-scientist-tournament/SKILL.md` + `references/` briefs
      (parse, 4 generation, 5 reflection, advocate/judge×2, safety)
- [x] Phase 1: `prompt.js` section + routing sentence; README; NOTICE;
      `npm run build:patch`; `npm run build`
- [x] Phase 2: evolution briefs + `compare`/`feedback`/`meta_review`/
      `design-protocol`/`research-overview`; `workflows.json` template
- [x] Phase 3: `coscientist-verify.js` (gated) + `scripts/test-coscientist-verify.mjs`
      with Crossref/OpenAlex fixtures; quarantine enforcement tests
- [x] Phase 3: optional-tool docs + `test-optional-tools.mjs` marker
- [ ] Release: version bump, CHANGELOG, README tool table, plan status update
