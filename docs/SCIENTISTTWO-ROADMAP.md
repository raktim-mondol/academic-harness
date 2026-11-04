# ScientistTwo → Academic Harness: implementation roadmap

Status: **Phases 0, 1, and 2 implemented; Phases 3–10 are plan.** See §3 for what shipped and what is still proposed.
Source paper: *ScientistTwo: Pioneering the Human Knowledge Frontier with Autonomous AI* (Google Cloud AI Research — J. Nam, J. Yoon, et al.), LaTeX bundle reviewed locally.
Shaping decision: the plugin stays **advisory**. ScientistTwo's contribution we keep is its *control structure* — critic verdicts, per-stage round budgets, attribution-before-acceptance, staged compute, and post-hoc integrity audits. Its autonomy we do not keep.

---

## 1. Premise and non-goals

**Keep from the paper**
- `stage(candidate, critic, refine, max_rounds)` as a record shape: every stage leaves a stored verdict with a reason and a round count.
- Two-tier compute: reproduce a baseline on a slice, gate cheaply, scale survivors up.
- Attribution as an acceptance condition separate from metric movement.
- Review → revision → **re-review** measured across rounds, with an in-distribution vs held-out evaluator distinction.
- Post-hoc integrity: re-execution of reported numbers, protocol immutability, reference verification, method–code alignment.

**Non-goals (deliberate)**
- No unattended multi-stage runner, no self-driving loop, no dollar/token-gated autonomy.
- No second turn-blocking gate. `ah_check` (`blocking_levels: blocker|major`, `mode: new`, `max_loops: 3`, then hard author handoff) remains the only gate.
- No auto-submit, no auto-repair that rewrites a manuscript without `ah_author`.
- Score-like outputs stay "an automated reviewer's reading", never a decision.

---

## 2. Verified starting point

Code-grounded facts the plan builds on.

| Existing capability | Where | Note |
|---|---|---|
| Action-multiplexed tool convention | `experiment-log.js`, `deep-review.js:29` | `ACTIONS` const + `run*Action(args, exec)` + total `renderValue` switch + `presentCall`; logic/persistence in the paired `*-store.js` |
| Registration ritual | `integrity-check.js:9,426-459`, `docs/DEVELOPMENT.md` | root ESM file, `export const name = 'academic-harness-<area>'`, `inject = ['tools']`, `apply(ctx){ ctx.tools.register(defineTool({...})) }`; contract carried in parameter `description` prose |
| Append-only ledger primitives | `ledger-kit.js` (`stableStringify`, `sha256`/`shortHash`/`hashFile`, `appendJsonl`/`readJsonl`), `store-lock.js`, `schemas/` | state under `<cwd>/.dsh/<kind>/<slug>/` |
| Review critique | `deep-review.js:29,44-52,617-680`; `vendor/open-deepreview/src/{agents/pipeline.ts,agents/anchoring.ts,types/schema.ts}` | anchored comments with `CRITICAL/MAJOR/MINOR/SUGGESTION`; `ClaimEvidenceMapping` = `SUPPORTED/PARTIALLY_SUPPORTED/UNSUPPORTED/OVERCLAIMED`; 9-item reproducibility checklist; `AuthorRebuttalQuestion`; review-quality self-audit; **no paper score** |
| ~~Review history is lossy~~ | `deep-review.js:74` (`key = docKey(relPath)`), `:78-93`, `:728-752` | **closed by Phase 1.** One dir per manuscript path; every `review` is kept as a numbered round under `rounds/`, `review.json`/`review.md` hold the latest pass, and `compare` diffs two rounds. `runs.jsonl` still keeps run metadata only, never review content |
| Citation verification verdicts | `deep-review.js:1053`; `vendor/open-deepreview/src/citation/checker.ts:392-454` | `OK/MINOR_MISMATCH/MAJOR_MISMATCH/VERIFIED_BY_SEARCH/NOT_FOUND/HALLUCINATED/SKIPPED` → `citations.json`. Detects; does not repair |
| Hypthesis tournament | `coscientist.js:25`, `coscientist-rank.js`, `coscientist-verify.js` | Glicko-2 with RD/volatility; five-stage ordered review with **0–10 novelty/correctness/testability** scores and pass/fail/uncertain; position-controlled pairwise judging; near-duplicate discard (0.70 Jaccard / 0.92 cosine); six named evolution mutations; `lineage`, `priors`, `next`, `graph`, `synthesize` |
| Run + sweep ledgers | `analysis-run.js`/`analysis-store.js`, `experiment-log.js:95-140` | frozen plans with versioned supersession; immutable manifests (argv, env allowlist, hashed in/out, `timeout_ms`/`timed_out`/`exit_code`/`duration_ms`, redacted logs, run-vs-run and run-vs-plan diffs); sweep runs with params/metrics/seeds/`parent`, best-by-named-metric-with-direction, ties listed, "no implicit best model" |
| Execution + hashing substrate | `analysis_run`, `repro_package.js`, `repo_audit`, `python-runtime.js`, `runpod_run`/`modal_run`/`vastai_run` | static repo checklist today; nothing re-executes a repo to compare reported numbers |
| Pipeline template | `deep-research.js:45,577-697,945-1086`, `deep-research-steps.js` | step-per-phase (`STEP_IDS`/`planFor`/`runSteps`), write-once frozen query + `assertGospel`/`query_drift`, `budgetState` enforced **before every step**, resumable steps, four fixed critic lenses, ship gate with `not_checked` honesty |
| Frozen-evaluator + control groups | `rsi-core.js` (OPAL / Local-RSI) | randomized holdout (`exploration=0.5`, `active_control_rate=0.1`), two-sided injected-vs-control promotion with SE margin, quarantine/retire/rollback, fixed-evaluator rule, risk tiers T0–T4 |
| Cross-ledger audit | `provenance-audit.js`, `provenance-store.js` | already joins review / deep-review / notebook / analysis / experiment / dataset / meta-analysis / `ah` claim sidecars by stored ids and hashes |
| Human approval | `ah_author` (waive, accept/reject a fact, approve brief/plan, verify claim, decline review item), `ah_review` list/import/show/check, `ah_review_respond`, `manuscript_diff` (response letter cites only recorded hunks) | the response-letter discipline already exists |
| Skill rules | `skills/*/SKILL.md`, `docs/SKILLS.md`, `seed.js` | dir name == frontmatter `name`; required frontmatter is exactly `name` + `description`, ≤1024 chars; description third-person, begins **"Use when…"**, states *only* triggering conditions — never a workflow summary; first-party skills add `license: MIT`, `metadata.version: "1.0"`, `metadata.skill-author: Academic Harness`, often `allowed-tools: Read Write Edit Bash` |
| Test + CI | `scripts/run-tests.mjs`, `package.json` `test:*`, `.github/workflows/verify.yml` | CI installs into a throwaway profile and boots it, importing every module — an unregistered import fails the build |

### Genuine gaps

1. ~~**Review rounds**~~ — **closed by Phase 1.** `deep_review` used to overwrite; rounds plus `compare` now make a revision's effect measurable.
2. ~~**Evaluation-validity criteria.**~~ — **closed by Phase 2.** Engine heuristics (`review_heuristics.ts:21-45`) police unfair criticism (H1 "not surprising", H3 unanchored novelty claim, H5 penalizing unclaimed-SOTA, H7 "too simple", H15 preference-as-flaw) and still say nothing about validity; `deep_review`'s `validity` action now counts attribution, evaluator drift, benchmark coverage, and unmeasured trade-offs wrapper-side, as advisory readings rather than a verdict.
3. **Advisory score + evaluator provenance.** No score anywhere; nothing records whether the reviewer that graded the draft also guided its revision.
4. **Staged experimentation contract.** `experiment_log` records numbers but has no benchmark spec, no baseline/variant role, no subset→full stage, no verdict vocabulary, no protocol digest, no single-metric-vs-dominance distinction.
5. **Ablation and attribution.** The word "ablation" appears in tool code only inside `rsi-core.js`; no planner, no component arms, no attribution veto.
6. **Baseline reference identity.** The paper compares the *subset* stage against the reproduced baseline and the *full-set* stage against the **original reported SOTA** (`tables/overview.tex:15-16`). Nothing in the plugin distinguishes the two references, so a run can silently compare against the wrong one.
7. **Score verification by re-execution** (reported vs recomputed), **spec-compliance with discard**, **method–code alignment anchors**, **citation repair**.
8. **Limitation records** as first-class, quotable, coupled-to-ideas artifacts.

---

## 3. Phases

Effort: **S** = action/prompt/doc only · **M** = new fields + handler + tests · **L** = new tool or store + docs + tests · **XL** = multi-store.

### Phase 0 — Baseline and calibration harness · M · ✅ implemented

**Shipped as `scripts/deep-review-calibration.mjs`** (not `test-deep-review-calibration.mjs`: `scripts/run-tests.mjs` globs `test-*.mjs`, so a network-touching harness must not carry that prefix). Three modes: `--collect` builds a sample manifest of real ratings and decisions through the `openreview` tool; `--report` reads stored rounds and emits `reports/deep-review-calibration-<stamp>.{md,json}`; `--validity --corpus <manifest>` runs the four deterministic checks over a labeled corpus and emits `reports/deep-review-validity-<stamp>.{md,json}`.

Two constraints found while building it, both now documented in the script header:

- `deep_review` needs the host llm bridge, so the harness cannot produce reviews by itself. It measures artifacts a session already stored; producing them stays a session action.
- The single most useful number is not agreement with decisions but **reviewer variance**: finding overlap between two rounds of a *byte-identical* manuscript. It needs no venue labels, no model call beyond a second review, and it bounds every later "findings closed" claim — which is exactly what Phase 1's `compare` now reports as `input_changed: false`.

Both sections print `not_checked` below their sample floor (3 same-manuscript pairs for variance, 6 joined rows with both decision classes for agreement) instead of reporting a number the data cannot carry.

- Fixtures: the stored-shape census (`schema.meta_versions`, `legacy_stores`, rounds per store) is the baseline record for the v1→v2 migration; `scripts/fixtures/deep-review/calibration-sample.json` ships as an empty shape because rows carry third-party titles and identifiers.
- The vendor-vs-wrapper decision is recorded under Phase 2 and in `docs/DEVELOPMENT.md` (§ Vendored engines: wrapper or fork).
- **Validity corpus mode** (`scripts/deep-review-validity-calibration.mjs`, also `deep-review-calibration.mjs --validity --corpus`). It imports the same `evaluateValidity` function `deep_review action=validity` uses, converts PDFs with the simple text converter (no OCR; pages flagged for OCR are disclosed and left unprocessed), and compares the four states to labels. Per check it reports state agreement, flag rate, precision/recall, missed clears (the dangerous error), abstentions, false alarms, false-positive papers among well-formed studies, and determinism; it also fails if identical bytes produce different states or evidence. A corpus row can supply stored-review `claims`/`comments`; otherwise attribution is text/grid-side.
- **Measured on 14 real PDFs** (12 research papers and 2 evidence syntheses) already on this machine: 14/14 converted, one OCR-flagged page left unprocessed, references excluded on 11 papers, leading PDF line numbers stripped on 6. Two independent readers (methodologist and results auditor) labeled every paper; 9/14 agreed and 5 were adjudicated by a third reader. Final report: `reports/deep-review-validity-20261103T235613.md`; the corpus manifest and full JSON report carry absolute paths and are kept outside the package (local-only).
  - **0 false-positive papers and 0 false alarms on every check**; determinism mismatches 0.
  - `attribution` 14/14 (2 true positives, precision 1, recall 1); `evaluator_drift` 8/14 (1 true positive, 1 missed clear, 4 abstentions); `benchmark_coverage` 10/14 (0 flags, 4 abstentions); `unmeasured_trade_off` 11/14 (0 flags, 2 abstentions, 1 reverse). Overall state agreement 43/56 (0.768).
  - The sample contains no reader-flagged coverage or trade-off failures; those checks' positive cases remain covered by `coverage-thin.md` and `trade-off-pinet.md`. The evaluator sample has two positives (one caught) and the attribution sample two (both caught).
- **Calibration loop.** The first pass (before fixes) had 10 false-positive papers and 39.3% overall agreement. The general failures were references and PDF line numbers counted as prose/grids, coverage requiring labelled metric columns and a literal "Baseline" row, and removal language requiring exact words. The fixed rules mask references (stopping at an appendix/supplementary heading), strip leading PDF line numbers, count numeric value columns and treat any second arm as a comparator, recognize Identity/Grayscale/from-scratch baselines, require an ablation mention to carry a table/figure, and return `not_checked` for reviews with no mechanism of their own. See the CHANGELOG for the full list.

**Exit:** stored baseline shapes, a variance metric, and a labeled real-paper validity measurement. ✅
**Why first:** the paper's own credibility comes from ablating its parts and scoring with a held-out reviewer. The paper also demonstrates the inflation risk directly: its in-distribution reviewer keeps rising across rebuttal rounds (5.2 → 6.9 → 7.6) while the held-out reviewer peaks at round 1 and declines (5.6 → 5.8 → 5.7), and human-authored accepted papers score *lower* on the in-loop reviewer than the system's own output (6.2–6.9 vs 7.5). Without Phase 0 we cannot tell an improvement from a rubric we have started to game.

### Phase 1 — Review rounds without loss · M · ✅ implemented

**Shipped in `deep-review.js` + `experiment` of the store contract:**

- Rounds are kept as `rounds/<run_id>.json` (a *finding digest*: matching keys, severity counts, claim statuses, checklist statuses, citation verdicts, token tally) and `rounds/<run_id>.md` (that round's report). `review.json`/`review.md` still hold the latest pass, so every existing `show` path behaves unchanged. Digests rather than full copies keep the ladder small and give `compare` exactly what it needs.
- `meta.json` is `schemaVersion` 2 with `rounds[]` and `latest_round`. A v1 store is **not** rewritten by reads — `status`, `show section=rounds`, and `compare` treat it as one virtual round — and the next `review` materializes that pass into `rounds/` before appending the second, so upgrading a workspace never loses its only review.
- `compare` (read-only, no model call) pairs findings by wording, then wording similarity (token overlap ≥ 0.6), then the quoted span, and prints a `Matched by` line naming which rule did the pairing. Comment ids are tried first, but live runs against the real engine showed ids carry a per-run hash (`c-1-ed35c869` vs `c-1-6d91b699`), so id matching is mostly inert — and exact-wording-only matching was splitting a reworded criticism into one closed and one opened, which is what the similarity tier fixes. It also returns `input_changed` — with identical bytes, the whole delta is reviewer variance.
- Live end-to-end through the DSH Web UI (agent-browser, real engine, `LOW` topology): three rounds on one manuscript with a revision between rounds 1 and 2, a re-review of unchanged bytes, and a hand-written v1 store read then upgraded. Round 1→2 reported `Matched by: id 2, summary 1, quote 2, similar 1` and folded the reworded *"No patient-level split details"* → *"Patient-level split details missing"* into `moved` instead of close+open. Round 2→3 (unchanged bytes) reported `id 2, summary 1, quote 10` with 13 of 22 findings still open — **9 closed and 6 opened per pass on an identical manuscript is the measured variance floor**, Phase 0's headline number arriving by accident. v1 reads left the store untouched (`schemaVersion` still 1, no `rounds/` created); the upgrade preserved the original 19-comment digest and 20,840-byte report as round 1.
- The progress sink now accumulates the bridge's per-call token usage, so each round carries its own call/token tally and `status` sums them across the ladder. This replaced the roadmap's original "sum the stored estimate" idea: measured usage beats priced guesses.
- Tests (`scripts/test-deep-review-tool.mjs`): two-round ladder, matching after re-issued ids, citation clearing, checklist and claim transitions, explicit `from`/`to`, same-round and unknown-round errors, single-round refusal, v1 upgrade path, token tally. Docs: `docs/PAPERS.md` (rounds + calibration subsections), `docs/TOOLS.md`, `README.md`, `skills/deep-review/SKILL.md` §6, `prompt.js` guidance, `docs/CHANGELOG.md` under *Unreleased*.

**Exit:** a second review no longer destroys the first, and `compare` answers what moved. ✅

### Phase 2 — Evaluation-validity checks · M · ✅ implemented

**Shipped in `deep-review.js` — no vendor file moved, so `VENDOR_COMMIT` is untouched and still unpinned-dragged:**

- A new `validity` action on `deep_review`, plus a `validity` section on `show`, two parameters (`round` — a round number as a string or integer, or a `run_id`, latest by default — and `critic`, default true), and a 5-minute default timeout. It needs a stored review, reads `review.json` when the selected round is the latest and that file exists and `rounds/<run_id>.json` otherwise, and records which one it used.
- A deterministic inventory of the MANUSCRIPT itself: text from the file (`.tex`/`.md`/`.markdown`/`.txt`/`.text`) or, for a PDF, the stored `paper.md` when its recorded source hash matches the current PDF, else a fresh `convertPdfMarkdown`, with `text_source` naming which; results grids counted from LaTeX `table`/`tabular`/`array`/`longtable` bodies (rows split on `\\`, cells on `&`) and Markdown pipe rows; and `runNumbersAudit` for the numeric half, recorded as `inventory.numeric_audit`. Caps are disclosed rather than silent: 400,000 characters, 40 grids, 60 rows, 10 evidence items per check, 25 arm labels.
- Four advisory checks, each `clear`, `flagged`, or `not_checked` with a reason string, `{kind, line, text}` evidence, and tallies. `attribution` — does the gain survive removal of the named mechanism? (the appendix TeCh rows: a variant beating the baseline on 5 of 6 metrics that was rejected because EMA + label smoothing carried it). `evaluator_drift` — is the change in the harness, threshold, or display rather than the model? (T-SAE: `act_threshold_frac 0.01→0.05` changes what the LLM judge sees). `benchmark_coverage` — how wide is the results grid? (the ScientistOne-vs-ScientistTwo contrast, corrected below). `unmeasured_trade_off` — is a counter-metric reported beside the headline gain? (Pinet: −16.7% latency bought by deleting the solver work that controls constraint violation, feasibility never reported). LaTeX prose is matched through `maskLatex()` so comments, math, and commands cannot manufacture a hit; `evaluator_drift` runs on comment-masked raw lines so a `\texttt` parameter change survives while a commented-out one does not, and Markdown HTML comments and fenced code are masked for every check. `flagged` names an absence in the text, never a flaw in the work, and `not_checked` is never a pass — a manuscript that cannot be read leaves all four `not_checked` carrying the read error as the reason.
- The critic is **at most one model call** — temperature 0, `max_tokens` 8000 (live runs: 700 was consumed by a reasoning session model before any JSON appeared, and 4000 ran out on two of three calls) — on the existing session route through `startLlmBridge` (`deep-review.js:259`), so **no new key, no new endpoint, no new Settings field**, and it can only annotate: the reply is validated (check ids confined to the four, strings clipped) and attached as `check.advisory` plus `critic.counter_metrics` and `critic.generic_controls`. No state ever moves because of it. A missing `ctx.llm`, an unresolvable route, a failed HTTP call, or a non-JSON reply still completes the pass and records the critic `not_checked` with the reason; `critic: false` makes zero calls.
- Persistence: `extra_checks.json` (`ARTIFACTS.extra_checks`, `schemaVersion` 1, so it appears in `meta.artifacts`), a `runRecord('validity', …)` row in `runs.jsonl`, and a `meta.validity` summary on the existing `schemaVersion` 2 store — no migration, and a pre-rounds v1 store is materialized into `rounds/` on this write instead of being left half-upgraded while `meta.params` keeps the REVIEW's params. `status` reports the summary and whether it still matches the current bytes; the pass appends its own notebook entry `deep-review-validity-<run_id>` (type `observation`, tags `deep-review` / `validity` / `key:<storeKey>`) inside a swallow-all try/catch.
- Verified offline (`critic: false`) on fixtures modelled on the paper's four cases: 5-of-6 metrics plus EMA/label smoothing over a single `Accuracy` column flags `attribution` and `benchmark_coverage`; "`act_threshold_frac 0.01 → 0.05` changes what the judge displays" flags `evaluator_drift`; "reduces solver iterations 50 to 10, cuts latency 16.7%, reports speed only" flags `unmeasured_trade_off`; a well-formed study (w/o arms, baseline and reference rows, 3 metric columns × 3 dataset columns, a latency gain reported with constraint violation and accuracy) flags nothing. Identical bytes reproduce identical states, a LaTeX comment mentioning latency and ablation is ignored, and the `\texttt` threshold change is still caught. These cases are now committed: `scripts/fixtures/deep-review/validity/` (four failure fixtures plus `well-formed.md`) and `scripts/test-deep-review-validity.mjs` (run by `npm run test:deep-review`), which also covers determinism, LaTeX masking, the unreadable-format `not_checked` path, store artifacts, and the critic (one call, annotate-only, failure-tolerant).
- **Two corrections to the plan this section replaces.** `paper_context` is **not** used for the local inventory: `runPaperContext` takes an external identifier and does network tiering, so it cannot inventory the file under review — the pass reads the manuscript itself (and `html-sections` is not involved either, for the same reason). `numbers_audit` is reused, but only for its numeric half: its row counter is provably blind to a multi-column grid, so grid counting goes through the pass's own parser. And the coverage contrast the plan called "the paper's v1 contrast" is in the bundle **ScientistOne-vs-ScientistTwo** (`sections/4_experiment.tex:13`), and the 4-figures/2-tables vs 9/12 counts are an author self-report that includes the appendix — so `benchmark_coverage` counts the grid axes it can actually see instead of reproducing that comparison. Those axis and arm counts are aggregated across every parsed grid, so a second table can widen a thin first one.
- **The thresholds and vocabularies are ours.** The paper states the four criteria and no lexicon and no cut-off, so `CONTROL_PHRASES`, `GAIN_PHRASES`, `COST_PHRASES`, `QUALITY_PHRASES`, `HARNESS_PHRASES`, and the wide-versus-thin grid rule are invented here, and `extra_checks.json` carries that as a standing note.
- **Calibrated against real papers (Phase 0).** Reference/bibliography sections are masked (stopping at an appendix/supplementary heading), leading PDF line numbers are stripped, coverage counts numeric value columns and treats a second arm as a comparator, baselines are recognized by names like Identity/Grayscale/from-scratch, an ablation mention needs a table/figure to count, and a review/synthesis with no mechanism of its own answers `attribution: not_checked`; `evaluateValidity` is exported so the harness and the action share one implementation. See `reports/deep-review-validity-20261103T235613.md` and the Phase 0 section.
- **Not wired:** `provenance_audit` does not read `extra_checks.json`, so these findings do not appear in a cross-ledger audit yet — it still joins only the stored `deep_review` claims and citation verdicts. Wiring them in belongs with Phase 8's `action=arms`.
- Docs: `docs/PAPERS.md` (new *Evaluation-validity checks* subsection), `docs/TOOLS.md`, `docs/ARCHITECTURE.md` (store row, which Phase 1 left without `rounds/`), `docs/DEVELOPMENT.md` (the wrapper bullet, which said these criteria were "planned"), `docs/SKILLS.md` (a `deep-review` row in the workflow-and-tool table, which had every other first-party tool skill but this one), `docs/README.md` index blurb, `README.md`, the `deep-review` skill §7, `prompt.js`, the preset row comment, and `docs/CHANGELOG.md` under *Unreleased*.

**Vendor policy:** these are criteria, so they *could* live in `prompts.ts`/`review_heuristics.ts`. Default is wrapper-side to keep `VENDOR_COMMIT` (`deep-review.js:27`) unpinned-dragged; any vendor edit is recorded in `vendor/open-deepreview/SOURCE.txt` and `NOTICE` and the commit is re-pinned. Revisit only if Phase 0 shows the wrapper pass is structurally limited. **Shipped as wrapper-side, as decided.**
**Exit:** catches the four cases on fixtures with no false positives on well-formed papers, measured against Phase 0. Fixture half ✅ (a well-formed study raises no flags; the live Web UI pass on Markdown and PDF rounds is recorded in the CHANGELOG). Phase 0 measurement ✅ on the 14-paper corpus: **0 false-positive papers, 0 false alarms on every check, 43/56 overall state agreement, determinism mismatches 0**; `attribution` 14/14, `evaluator_drift` 8/14 with one missed clear, `benchmark_coverage` 10/14 and `unmeasured_trade_off` 11/14 with no false alarms (abstentions dominate). The corpus has no reader-flagged coverage/trade-off failures, so their recall remains fixture-backed rather than corpus-measured; the evaluator miss is a granularity change the keyword rule cannot see.

### Phase 3 — Advisory score with evaluator provenance · M

- Dimension readings (soundness / originality / clarity / significance) on a declared venue scale, each citing the comment ids that produced it; `show` section `score`. Scale source named in the artifact; nothing keys a gate off the number.
- **`evaluator_kind: in_distribution | held_out`** — recorded per round, and set to `in_distribution` whenever a prior round's rubric text fed revision. This is the paper's own methodological split (ScholarPeer in-loop, Stanford Agentic Reviewer held out) and it is the honest half of "reviewer threshold".
- Settings additions (extend the existing block listed in `docs/TOOLS.md` §Settings-only surfaces): default rubric, max rounds, per-run cost ceiling.
- Wording reviewed for verdict-creep in `prompt.js`, `docs/PAPERS.md`, `docs/WRITING.md`.

**Exit:** Phase 0 harness reports correlation against real decisions; docs state advisory posture in the tool's own description text.

### Phase 4 — Staged experimentation contract · M–L · unblocks 5, 7, 8

All of this lands on `experiment_log` + `experiment-store.js` — no parallel store.

- `start`: declare a **benchmark spec** — datasets, metrics with directions, splits, the baseline arm, and the task rules the solution must respect.
- `log`: `role: baseline | variant` and **`baseline_ref: reproduced | reported`**. The paper's two stages compare against *different* references (reproduced subset baseline vs original reported SOTA); encoding the identity is the cheapest way to stop a variant being declared better against the wrong number.
- `log`: `stage: subset | slice | full`, with the sampling rule recorded (seeded subsample of a declared size/stratification). Note: the paper never specifies its subset — "representative benchmark slices" is the entire definition — so the rule is **ours to design and document**, not a port.
- New action **`verdict`**: `good | engineer | bad` with reason, `engineering_round`, and budget; a budget-exhausted `engineer` is recorded as force-`bad` (the paper: pruning is the consequence, Engineer is not a terminal state). Advisory record of a **human** decision.
- New field **`protocol_digest`**: SHA-256 of the eval script + metric parameters captured at baseline; every later run is checked and drift is reported as `spec_drift`. This is the paper's finding that a structural check beats a prompt-level prohibition list.
- `best`: add multi-metric Pareto **`dominance`** beside the existing single-metric best; the paper's own gate says "preferred", never defines it for a multi-metric grid, so dominance relations are ours to specify.

**Tests:** extend `scripts/test-experiment-log.mjs`; register `spec_drift` in `provenance_audit` unsupported states. **Docs:** `docs/ANALYSIS.md#experiment_log`, TOOLS row, CHANGELOG.

### Phase 5 — New tool `ablation` · L

The paper's most distinctive mechanism and the plugin's largest hole.

- File `ablation.js` + `ablation-store.js`; state `.dsh/ablation/<slug>/`; actions `start, plan, record, report, verdict, prune, show, status, export`.
- `start` binds a method spec and the champion idea id (from `coscientist`).
- `plan` — component arms, each naming the code path or module removed and the metric it is expected to move; `component` × `arm` × `dataset` × `metric`.
- `record` — **runs nothing**: links `experiment_log` / `analysis_run` ids so every number has a hash behind it.
- `report` — per-component Δ per metric against the declared spec, with ties and missing arms listed.
- `verdict` — `good | refine | unattributed`. `unattributed` is the point: a gain carried by generic controls is recorded as not attributable to the mechanism.
- `export` — Markdown/JSON/CSV; the attribution result is what Phase 2's check reads, and `ah_fact`/`ah_claims_bind` can bind the component numbers.

**Effort anchor:** the paper reports 5–6 component ablations per accepted paper and `N_abl = 1` refinement in practice — plan for a handful of arms, not a grid explosion.
**Tests/docs:** new `scripts/test-ablation-tool.mjs` + `scripts/test-ablation-store.mjs`; `docs/ANALYSIS.md` section; TOOLS row; skill in Phase 10.

### Phase 6 — Limitation records and grounded novelty on `coscientist` · M

Extend the tournament; do not add a competing ideation ledger (it already scores novelty 0–10 in its five-stage review and controls duplicates).

- Actions **`limitation`** (`add` / `verify` / `status`) with a round-capped sufficiency loop. Record schema follows the paper's published artifact, which is more specific than its method text: a flat numbered list where each entry has **Methodological Flaw** (quoting the offending equation), **Why it limits the method**, **Opportunity for Improvement** (generic, plural remedy *families* — not a single chosen fix), plus the source quote span. Vocabulary is binary `sufficient | insufficient`; refine is **set append**, never rewrite or delete.
- Coupling becomes machine-checkable: **`addresses_limitation`** on `add`, a coverage view in `status`, and limitation nodes in `graph`/`export` — the paper's seed artifacts tag each idea component "(Addressing Limitation k)" one-to-one.
- **`coscientist_verify novelty`**: retrieve the reference set, store it, and pin the novelty score to retrieved quote spans. Today a novelty number exists without a stored evidence base; the paper's entire published spec is "retrieves two reference papers", with no formula, range, or threshold — so the scoring function is **ours, and must be documented as ours**.
- **`trace` / `traces`**: read `experiment_log` runs — including pruned and failed ones — as input to the existing evolution mutations. Nothing in the plugin reads failure logs back into ideation today.
- **`select`**: an evidence-bound Selector step that freezes the champion idea id for ablation and drafting, comparing metrics *and* recorded logs across surviving candidates.

**Tests:** extend `scripts/test-coscientist-tool.mjs`, `test-coscientist-store.mjs`, `test-coscientist-verify.mjs`. **Docs:** `docs/RESEARCH.md#hypothesis-tournaments`, TOOLS rows, `skills/co-scientist-tournament/references/briefs.md`.

### Phase 7 — New tool `rebuttal` · M–L · depends on 1 and 4/5

Advisory coverage ledger with no execution of its own.

- File `rebuttal.js` + `rebuttal-store.js`; state `.dsh/rebuttal/<slug>/`; actions `import, plan, link, coverage, draft, export, status`.
- `import` from a `deep_review` round (Phase 1), `ah_review` items, or real `openreview` reviews — keeping the reviewer identity and `evaluator_kind` with each imported point.
- `plan` — per question/weakness a supplementary task stub: dataset, baseline arm (`reproduced` or `reported`), metric, replicate count (`power_analysis`), expected evidence type. The paper's Rebuttal Planner consumes the **whole review**, not only weaknesses, and never instantiates `N_t`; we cap it in Settings instead.
- `link` — task → `experiment_log` / `analysis_run` ids, so an answer points at hashed artifacts.
- `coverage` — answered / declined-via-`ah_author decline` / unaddressed; `draft` feeds `ah_review_respond` and `manuscript_diff`, which already restrict a response letter to recorded hunks.
- Deliberate divergence, recorded in the docs: the paper integrates rebuttal results into the manuscript **with no performance gate at all**. We gate on *coverage*, not on outcome, and a supplementary result that fails to help is still recorded and reportable.
- Closing the loop: a fresh `deep_review` round + `compare` shows which points actually closed.

**Tests/docs:** `scripts/test-rebuttal-tool.mjs`; `docs/WRITING.md`; TOOLS row; CHANGELOG.

### Phase 8 — Re-execution, compliance, and alignment · L · depends on 4

Where the remaining integrity checks belong, per the audits: execution belongs to `analysis_run` (it already owns argv, env allowlist, hashing, timeouts), repo questions to `repo_audit`, joins to `provenance_audit`.

- `analysis_run action=expect` + `action=verify_scores` — declare the reported numbers on the frozen plan, then compare against a re-execution's parsed outputs; report match / mismatch / **`not_checked`** when the environment, entrypoint, or timeout makes re-execution impossible. The paper's own artifact shape is instructive: a re-run of `python final.py` regenerated the exact AUROC/FPR95 pair and wrote `repro_check.json` with `"reproduction": true`.
- `analysis_run action=compliance` with frozen `task_rules` — rule-violating solutions are **excluded from best, from `repro_package`, and from deposit** rather than refined. This mirrors the paper's only discard action, and it inherits its cost honestly: the spec filter is what turned a 50-task run into 49.
- `repo_audit action=probe` (S) — does the repo expose a runnable benchmark entrypoint at all? Cheap precursor that decides whether `expect`/`verify_scores` is even offered.
- `repo_audit action=align` — method-section anchors (equation, symbol, constant, default value) mapped to verified `file:line`; the report feeds `ah_claims_bind` so the writing engine can hold the method section to the code.
- `citation action=repair` — for each `HALLUCINATED`/`MISMATCH` verdict, ground with live lookup (`crossref_lookup`, `paper_get`, `bibtex-resolve`, PaperMemory) and write a **new** `.bib`; never edit in place. Detection is mature today, repair does not exist.
- `provenance_audit action=arms` — one artifact, four columns (reported vs recomputed, protocol digest, references, method–code) rendered as a readiness roll-up over artifacts that already exist; plus new unsupported states `no_attribution`, `rerun_mismatch`, `verdict_missing`.
- Scope correction to hold onto: the four-check "CoE Integrity Audit" is **ScientistOne's** framework, imported and cited; ScientistTwo's own contribution is the enforcement side (three refinement agents plus prompt design), and the audit is **not a pipeline stage** — it is absent from the overview table and the shared pseudocode, and two of its four checks are manuscript-side repairs. Also: score verification has **no** repair agent (it is prevented upstream by prompting for self-contained reproducible scripts), so the plugin's equivalent prevention lives in the `analysis_run`/`experiment_log` guidance text, not in a new agent.

### Phase 9 — Loop roll-up, not a loop runner · S→M · decide at the end of Phase 8

Start as a **report**, not a store: `provenance_audit` (or a `deep_review`-style `show`) renders the ordered record — frozen problem → limitations → idea pool → subset verdicts → scale-up → selection → ablation/attribution → review rounds with evaluator kind → integrity columns → promoted incumbent — by joining ids that Phases 4–8 create, with per-stage cost/time summed from the ledgers that already log them.

A dedicated `frontier` ledger is only justified if that roll-up proves too slow or too implicit. Two properties it would still owe us: **`promote`** (this cycle's winner becomes the next cycle's declared baseline — the paper's compounding result), and honest accounting (the paper's headline gain is computed **over successful cases only**, and its cost/time averages cover 33 of 107 problems, including VM cost — do not let our roll-up inherit that framing).

**Improvement over the paper, free:** in the paper the reproduced subset baseline is the one artifact with **no critic and no refine** (`tables/overview.tex:14`), so the reference number underpinning the entire accept/refine chain is unverified until the final re-run. Because our `analysis_run` already produces immutable manifests, we can gate the baseline itself at Phase 4/8 — a strictly better loop shape than the source.

### Phase 10 — Skills, templates, prompt, docs · S · continuous with each phase

- `workflows.json` rows (zero code, ship any week): `limitation-mining`, `subset-first-eval`, `ablation-plan`, `rebuttal-plan`, `review-round-diff`. Format: `{id, name, description, category, icon, prompt, requiresFiles, placeholders[]}`.
- New skills — each `skills/<kebab>/SKILL.md`, dir name == `name`, description begins "Use when…" and lists **only** triggers, ≤1024 chars, plus `license: MIT`, `metadata.version`, `metadata.skill-author: Academic Harness`:
  `subset-first-eval`, `ablation-attribution`, `rebuttal-experiments`, `limitation-mining`, `novelty-triage`, `method-code-alignment`, `integrity-audit`.
- Updated skills: `deep-review` (rounds/compare — ✅ with Phase 1, and the `validity` step — ✅ with Phase 2 — as §7; `score` still owed by Phase 3), `co-scientist-tournament` (+ `references/briefs.md`), `agentic-data-science-pipeline`, `ah-revise-from-review`, `numbers-audit`.
- `prompt.js` sections for the new actions, and the two habits the paper insists on: reproduce before you compare, and never mix the reproduced and reported references.
- Docs: `docs/TOOLS.md` rows with correct scope (preset-only), new sections in PAPERS / ANALYSIS / RESEARCH / WRITING / PROVENANCE, `docs/SKILLS.md`, `docs/CHANGELOG.md`, `NOTICE` for any vendored diff or adapted paper material. Phase 2 shipped its share: the validity clause in the `deep_review` row, an *Evaluation-validity checks* subsection in PAPERS, a `deep-review` row in the `docs/SKILLS.md` workflow-and-tool table (that table listed every other first-party tool skill and was missing this one), the `docs/README.md` index blurb, and an *Unreleased* changelog entry; `NOTICE` gained nothing, because no vendor file moved and no paper text was copied — the four criteria are paraphrased.
- Tests wired into `scripts/run-tests.mjs` + `package.json` `test:*`; CI `verify.yml` boots the profile and imports every module.

---

## 4. Sequencing

| Phase | Depends on | Independently shippable | Effort |
|---|---|---|---|
| 0 Calibration | — | ✅ shipped | M |
| 1 Review rounds | — | ✅ shipped (`compare`, rounds, v1 upgrade, token tallies) | M |
| 2 Validity checks | 0 (proof), 1 (cleaner input) | ✅ shipped (`validity`, four checks, one bounded critic, `extra_checks.json`, `meta.validity`) | M |
| 3 Score + provenance | 0, 1 | yes | M |
| 4 Staged experiment contract | — | yes; unblocks 5/7/8 | M–L |
| 5 `ablation` | 4 | no | L |
| 6 Limitations + novelty + traces | PaperMemory anchors | yes | M |
| 7 `rebuttal` | 1, 4, 5 | no | M–L |
| 8 Re-execution / compliance / align | 4, 5 | partial | L |
| 9 Loop roll-up | 4–8 | last, maybe never as a store | S–M |
| 10 Skills/docs/tests | per phase | continuous | S |

Recommended cut: **0 → 1 → 4 → 2 → 5 → 3 → 6 → 7 → 8 → decide 9.**
Phases 1 and 4 are the two structural holes — review history and a staged, verdicted, reference-named experiment record — and everything else composes on them.
Phase 2 was taken before 4, so what has actually shipped is 0 → 1 → 2; `validity` needed only a stored round, not the experiment contract, and 4 still unblocks 5/7/8.

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| Verdict creep: a score becomes a de facto gate | Phase 3 keys nothing; only `ah_check` blocks; tool description text says advisory; calibration report names the distinction |
| Gaming our own rubric | `evaluator_kind` flag; report held-out numbers as the headline; Phase 0 tracks drift between the two |
| Vendor drift on `open-deepreview` | wrapper-side passes in 2/3; any fork re-pins `VENDOR_COMMIT`, updates `SOURCE.txt` + `NOTICE`, and is re-verified by CI boot |
| Store schema migration | `meta.json` `schemaVersion` 1→2 with a v1-tolerant reader; new ledgers get `schemas/` entries and a migration note in CHANGELOG |
| Re-execution cost and safety | `analysis_run`'s argv-only executor, env allowlist with redaction, hard timeouts; remote via `runpod_run`/`modal_run`/`vastai_run`; confirm-gated; `not_checked` rather than silent skip; never in the session workspace by default |
| Scope creep back toward autonomy | Phase 9 stays last and is decided on evidence; no runner in any phase |
| Two similar stores (ablation vs experiment_log; rebuttal vs ah_review) | both are ledgers over other ledgers: they link ids and never store their own numbers |
| Novelty/attribution scoring invented where the paper is silent | every such spec is documented as ours in its guide section, not presented as a port |

---

## 6. Paper-fidelity notes (what the verified reading actually says)

Carry these forward when documenting, because several headline numbers are weaker or narrower than they are usually quoted:

- **Cost/time scope.** $3,765 and "2–3 days" (caption: "2.5 days on average") are measured on the **33 NeurIPS-2025 problems only**, not per task over 107; the figure includes **virtual-machine** cost, not inference alone; the conclusion rounds it to "approximately $3,800". Body and caption also disagree on which stages dominate time.
- **Success and gain framing.** 80.4% = **86/107 executed** (per venue: 33/38 NeurIPS, 4/5 ICLR, 49/64 ICML spotlight). The +25.2% is an average **over successful cases only**, extracted by parsing main tables 10 times with a model and averaging — a heuristic, not a measurement — and it drops to 13.9% average on NeurIPS-2025 and 3.8% on ICLR-2026, where the AutoSOTA comparison reports 7.2%.
- **Unspecified where implementation must invent.** `N_seed`, `N_0`, `N_e`, `N_k`, `N_p`, `N_t` never get values; the novelty score has no formula, range, threshold, or tie-break (only the ordering invariant); the "benchmark subset" has no size, sampling, or stratification rule and **no ablation isolates subset-first**; "preferred" in the comparison gate is never defined for a multi-metric grid; and it is unstated what happens when the 16-round limitation budget exhausts without a sufficiency verdict.
- **Verdict vocabularies are per-stage, not one set.** subset/full critics `{Good, Bad, Engineer}`, ablation critic `{Good, Refine}`, meta-review `{Accept, Refine}`, the shared pseudocode `{accept, refine, discard}`; the peer-review stage is a **scalar threshold** (`s_review ∈ [1,10]`, early exit at 8), and initial drafting has **no critic at all**. The full-set verdict set is never enumerated; the "final verdict is Good/Bad" line exists only as commented-out LaTeX.
- **Loop asymmetries worth knowing before porting.** Success exit is cumulative `#Good ≥ S`; whole-process termination is specified only when round K is reached with **zero** successes — 1..S−1 still feeds the Selector. A meta-review that fails its comparison does **not** re-enter ideation: the run terminates keeping the previous best. `N_meta` and `N_abl` are nominally loops but 1 in the shipped configuration. Budgets are **round and success counts only** — there is no dollar/token/wall-clock ceiling anywhere, and the meta loop re-triggers the inner loops so per-stage caps multiply.
- **Reviewer scales.** The 1–10 scale appears in table captions; what "ICLR" refers to in the method is the **drafting format** (ICLR 2025, following PaperOrchestra). Human evaluation used a separate 1–5 Likert scale (33 papers, 9 reviewers, overall 3.7 standalone / 3.0 relative, with humans ahead on methodological rigor). PaperOrchestra and ScholarPeer are external cited components wrapped by the drafter and reviewer — their internals are unspecified. The system's own limitation statement concedes it does not reach spotlight/oral caliber, so "acceptance" here is an automated proxy.
- **Artifact-labeled claims.** "Installs external models during rebuttals" (TabPFN, pinned deps, `requirements_rebuttal.txt`) survives only as an appendix screenshot plus a commented-out case study, and the rebuttal PDFs sit in the X-Mahalanobis folder while the appendix attributes the rebuttal exemplar to a different paper. Treat as a demonstrated capability, not a specified pipeline step.

---

## 7. How this plan was produced

A 101-agent fan-out mapped paper mechanisms and plugin clusters, proposed 25 candidates, and attempted three-lens adversarial verification plus a judge panel. **The paper extractions (6/6) and the plugin cluster audits (10/10) completed**; their corrections are folded into §2, §3, and §6, and they are what changed most of the earlier "new tool" ideas into actions on existing tools.

**Not completed:** the verify and judge stages (80 agents) failed on a credit limit, so the 25 §3 items are **unverified** — the run's own "survives" flag is vacuous there, since an empty verdict set satisfied `refutes === 0` — and the review-domain proposer died outright, so Phases 1–3 and 7 come from direct reading of `deep-review.js`, `vendor/open-deepreview/`, and the `ah_*` surface rather than from the fan-out. Treat §4's ordering as a judgment call to re-check, not an adjudicated ranking.

Run artifacts: `.qoder/sessions/40ffff6a-0fc8-4580-aa6d-5cff5b30c727/workflows/runs/wf_0af1e50d-a26/output.json` and `journal.jsonl`.
Before implementing each phase, verify its named files, action enums, and store fields against current `main` — the plugin moves fast, and this document is a plan, not a spec of record.
