# Human-directed research cycle: implementation plan

**Status:** Phases 1–5 implemented. See the changelog and tool documentation for the shipped interface.

**Scope:** Safer experiment comparisons, repeated-run summaries, experiment lineage, guided handoffs, and evidence-grounded prior-art and figure reports.

**Source of inspiration:** [AI Scientist v1](https://github.com/SakanaAI/AI-Scientist) and [AI Scientist v2](https://github.com/SakanaAI/AI-Scientist-v2), inspected at commits `1de1dbc` and `96bd516`, respectively. These are distinct from the existing [ScientistTwo roadmap](SCIENTISTTWO-ROADMAP.md).

## 1. Decision and boundaries

Academic Harness remains a **human-directed research workbench**, not an autonomous paper factory. The proposed improvements reuse the current ledgers and tools; they do not copy or depend on either upstream repository.

### Goals

1. Prevent a comparison from silently ranking incompatible or unidentifiable runs together.
2. Summarize repeated runs and paired seeds without promoting a best individual seed into a scientific conclusion.
3. Show experiment ancestry, links, failures, and exclusions without creating a second source of truth.
4. Guide the researcher across existing tools while retaining explicit human decisions and approvals.
5. Improve prior-art and figure-to-result handoffs using traceable evidence and measurable limitations.

### Non-goals and safety requirements

- No unattended research loop, automatic experiment generation or execution, automatic promotion, manuscript rewrite, submission, publication, or deposit.
- No new turn-blocking gate; `ah_check` remains the existing writing gate. Comparison eligibility is a property of a report, not a judgment that blocks the conversation.
- No automatic approval of paid compute, data upload, full-scale runs, reviews, or other consequential operations. A workflow recommendation is not permission to execute it.
- No claim that `analysis_run` is a security sandbox: its documented network-off convention is not a firewall or a privilege boundary. Any future execution of generated or untrusted code needs a separately reviewed isolation and approval design.
- No source, prompts, or templates copied from the AI Scientist repositories. Their current licenses contain restrictions and disclosure requirements; obtain legal review before any future code reuse or distribution. High-level ideas alone are the design inspiration here; attribution is not a substitute for a license review.
- No inferred source support, verified novelty, research validity, statistical significance, or acceptance decision. Preserve `not_checked`, `unknown`, and missing evidence as distinct states.
- Respect workspace confinement, credential handling, host permissions, append-only records, and the existing policy for source-ledger ownership. Do not change or delete existing user records to make an implementation easier.

## 2. Baseline in this repository

| Area | Existing behavior and implementation |
|---|---|
| Experiments | `experiment-log.js` exposes `start`, `log`, `compare`, `best`, `verdict`, `link`, `status`, `list`, `show`, and `export`; `experiment-store.js` owns the ledger. Runs already carry metrics, seed, optional parent, artifacts, staged fields, protocol digest, and baseline reference. |
| Comparison gap | `compareExperiments`, `bestExperimentRun`, and `dominanceExperiment` rank eligible individual runs without a complete comparison scope. The staged variant baseline is currently the first stored baseline with the matching `baseline_ref`, not an explicit run selected by dataset or stage. See `experiment-store.js`. |
| Existing exclusions | `experimentCompliance` joins linked `analysis_run` records and excludes recorded compliance violations. Preserve this behavior and expose unresolved links. |
| Execution and evidence | `analysis_run` owns frozen analysis plans, execution manifests, input/output hashes, re-execution checks, and compliance. `experiment_log` records results; it does not execute them. See [Analysis](ANALYSIS.md). |
| Lineage | An experiment run can name an earlier `parent` in the same experiment ledger. Links can name `analysis_run`, other experiment runs, notebook entries, papers, reviews, or `scientific_result`; not every target is necessarily resolvable. |
| Research workflow | `coscientist` owns hypothesis lineage and reads failed/pruned experiment traces. `ablation` links existing runs. `provenance_audit rollup` is a read-only cross-ledger report, not an orchestrator. `research_template` is a prompt catalogue, not an executor. |
| Prior art and figures | `coscientist_verify novelty` records a small retrieved set and an explicitly lexical reading. `figure_audit` inventories image properties and near-duplicate candidates; it does not link figure content to results. |
| Tests | Tests are plain `scripts/test-*.mjs`; `npm test` discovers them. Existing focused commands include `npm run test:experiment`, `npm run test:analysis`, `npm run test:provenance`, and `npm run test:coscientist`. See [Development](DEVELOPMENT.md#tests). |

**Design principle:** add one implementation for comparison eligibility and reuse it everywhere that produces a ranking or aggregate. A warning in only one renderer is not sufficient.

## 3. Phase map and dependencies

| Phase | Scope | Completion criterion | Effort |
|---|---|---|---|
| 1 | Comparison scope and explicit baseline identity | Incompatible or insufficiently identified runs cannot silently appear in the same ranking; legacy behavior is documented | Medium · implemented |
| 2 | Repeated-run summaries | Seed coverage and paired comparisons are reproducible, explain exclusions, and are tested | Medium · implemented |
| 3 | Read-only experiment branch view | A researcher can trace parent runs and recorded links, including failures and unknowns | Medium · implemented |
| 4 | Guided human-controlled research cycle | Existing tools are connected with explicit approvals and missing-state reporting | Small–medium · implemented |
| 5 | Prior-art and figure handoffs | Reports are validated on labeled examples and preserve uncertainty | Medium–large · implemented |

These are relative engineering sizes, not delivery dates. Phase 2 depends on Phase 1's eligibility contract. Phase 3 can begin after Phase 1's data contract is stable. Phase 4 should use the first three phases' actual interfaces. Phase 5 can be developed independently once its evaluation fixtures and provenance boundaries are agreed.

## 4. Shared contracts and compatibility

### 4.1 Comparison identity

Introduce an explicit, versioned, normalized comparison identity for new runs. Names below are proposed, not existing API fields:

```json
{
  "comparison_identity_version": 1,
  "dataset": { "id": "dataset-id", "version_or_hash": "version-or-sha256" },
  "split": { "id": "held-out-split", "version_or_hash": "split-version-or-sha256" },
  "stage": "slice",
  "sampling_digest": "sha256:...",
  "protocol_digest": "sha256:...",
  "metric_definition_digest": "sha256:...",
  "baseline_cohort_id": "baseline-cohort-id"
}
```

- A dataset, split, or sampling identifier is a **recorded identity**, not proof of representativeness, data integrity, or leakage-free evaluation. Prefer verified dataset/artifact hashes where available; otherwise label the field as user-declared. Do not invent versions, hashes, units, or split details.
- The metric-definition digest must include the relevant metric name, direction, units where applicable, and declared parameters/implementation identity. The existing protocol digest covers the evaluation script and metric parameters, not all dataset or metric semantics; it is not a substitute for these fields.
- Canonicalize using existing `ledger-kit.js` primitives. Specify normalization, versioning, and exact hash inputs in code and tests. Never use a digest that encodes absent data as if it were present.
- A **baseline cohort** identifies a comparable reference configuration across replicates. Each staged variant also records the **specific baseline run ID** used for its protocol comparison. This distinction permits seed-matched baseline runs without pretending that every variant must reference the same physical run.
- Compare a baseline and variant only when their required identity fields are compatible; role and candidate identity are not themselves equality requirements. Seed and candidate ID are grouping/pairing dimensions, not reasons by themselves to reject comparison.
- Define `comparable`, `incompatible`, `not_checked`, and `excluded` with reason codes and the exact fields examined. Missing required metadata is `not_checked`, not a match. A recorded compliance violation remains `excluded` and is never restored by an override. Report spec drift separately; drifted protocols cannot enter the same default ranking.
- Human-supplied identities and relationships remain **asserted** unless independently verified. Matching recorded metadata is necessary for a scoped comparison, not proof that the experiment is scientifically comparable.

### 4.2 Existing records and migration

- Reads never rewrite `experiment.json`, `runs.jsonl`, or other source ledgers. Continue to expose all historical runs, links, and verdicts.
- Do not reconstruct historical dataset, split, baseline, seed, or execution status from names or model guesses. Old runs missing required identity fields are visible but `not_checked` for scoped ranking.
- Existing unstaged ledgers remain readable. Unscoped `compare`, `best`, dominance, grouped rankings, Markdown/CSV/JSON/MLflow export summaries, and any other ranking surfaces must either return scoped rankings or return **no ranking** with a clear compatibility/migration explanation. Do not leave an unsafe legacy ranking hidden in an export or helper.
- If retrospective annotations are needed, design a separate append-only, versioned, user-attributed identity event tied to the exact run and evidence, with `asserted` versus `verified` provenance; do not mutate the original run. This is optional for the first implementation if users can instead record new runs. Never silently backfill or change historical baseline identity.
- This is an intentional safety-facing change to ranking output. Document the behavior change, provide migration examples, and test existing consumers and old stores. No implicit `unsafe` fallback or warning-only override.

### 4.3 Research and statistical reporting

- Reports contain recorded facts and computations; they do not declare a winning theory, a causal mechanism, statistical significance, paper quality, or deployability.
- All report surfaces show scope, candidate IDs, included run IDs, denominators, exclusions, missing/unresolved records, and relevant caveats. Stable sort order and stable serialization make repeated reads reproducible.
- Computed reports are derived views. Source ledgers remain authoritative; an optional saved export is a snapshot with source identifiers/digests and generation time, not a new truth store.

## 5. Phase 1 — comparable-run safeguards

### Problem

`best`, `compare`, grouped best, Pareto dominance, and exported summaries can compare individual values that were logged at different stages or under different baselines. Current staged runs record protocol drift, but recording drift alone does not prevent ranking across it. The first-match baseline lookup also becomes ambiguous as soon as more than one applicable baseline exists.

### Proposed implementation

1. **Inventory every ranking surface and caller.** Search `experiment-store.js`, `experiment-log.js`, export helpers, `provenance-store.js`, `coscientist-trace.js`, ablation/repro consumers, tests, and docs. Record which consumers calculate a ranking versus merely display raw runs. Avoid changing raw-ledger readers unnecessarily.
2. **Add identity to new records.** Extend `experiment_log action=log` and its store handler with an explicitly validated comparison identity and, for staged variants, `baseline_run_id`. Retain existing fields and ensure new fields are additive to stored records. For a new staged variant, validate that the named baseline exists in the same ledger, has `role: baseline`, the correct `baseline_ref`, an applicable declared scope, and an available protocol digest. Validate under the ledger lock so concurrent appends cannot change the choice.
3. **Avoid a first-match fallback.** For new staged variants, require an explicit baseline ID when multiple candidates are present; the simpler and safer proposed default is to require it for **all** new staged variants. Historical runs keep their recorded baseline IDs and are not silently reassigned. A baseline ID does not bypass scope checks.
4. **Implement a shared eligibility function** in a focused helper or `experiment-store.js`. It returns included IDs and per-run reasons, using the versioned identity, protocol drift, metric presence, and current compliance join. Never merge unknowns into a valid scope. Treat unresolved analysis links as unknown where they affect a safety or compliance interpretation, rather than falsely declaring compliance.
5. **Require a scope for rankings.** `compare`, `best`, Pareto dominance, and grouped rankings use the same eligibility result. If several valid scopes exist, return separate explicitly identified scopes or ask the caller to choose one; never choose one implicitly. Raw listings remain available.
6. **Update exports.** Markdown/JSON/CSV/MLflow views retain all runs and include enough scope, status, exclusion, and source details to reproduce the result. Ranking summaries use the same function. Clarify that an MLflow-shaped export does not itself enforce this plugin's eligibility rules after import.
7. **Update user surfaces.** Revise `docs/ANALYSIS.md`, `docs/TOOLS.md`, the experiment-tracking skill, `prompt.js` as appropriate, `docs/CHANGELOG.md`, and examples. Document old versus new behavior and the distinction between declared identity and verified evidence.

### Tests and acceptance

- Fixture matrix: same scope; different dataset/version, split, stage, sampling, baseline cohort, protocol, metric definition, missing fields, or explicit baseline; ties; compliance violation; unresolved analysis link; failed or absent metric; reported versus reproduced baseline.
- Two baselines with the same reference but different stages: no first-match selection. Missing/invalid `baseline_run_id` is refused for a new staged variant.
- Verify `compare`, `best`, dominance, grouping, and **all export formats** agree on eligibility; legacy records remain readable but are not silently ranked. A mixed ledger cannot produce one cross-scope winner.
- Exercise concurrent logging, canonicalization, repeatability, malformed identities, workspace paths, and scope version handling.
- Extend `scripts/test-experiment-log.mjs`; add a focused helper test if useful. Run `npm run test:experiment`, affected provenance/analysis/ablation tests, and `npm test` before completion.

**Exit:** No ranking surface silently mixes unknown or incompatible scope; compliance exclusions remain sticky; no historical source ledger is rewritten.

## 6. Phase 2 — repeated-run and paired-seed summaries

### Interface and data

Add a proposed read-only `experiment_log action=replicates` (final name subject to implementation review). Require a Phase 1 comparison scope, a declared metric and direction, an explicit candidate grouping field or run set, and either an expected seed list or an explicit statement that coverage is unknown. A **run** is not automatically a replicate: candidate, dataset/split, stage, protocol, and intended independent unit must be identified first.

For each candidate report:

- Declared expected seeds; observed, missing, duplicated, and unexpected seeds; eligible and excluded run IDs with reasons; failed or missing metric counts where recorded.
- Raw metric values, `n`, arithmetic mean, and **sample** standard deviation (`n - 1`) when `n >= 2`; use `not_checked` with a reason for SD at `n < 2`.
- A descriptive range if useful, clearly labeled and not substituted for uncertainty.
- A paired baseline comparison only for unambiguous, one-to-one matches on seed and Phase 1 comparison scope. Show every pair and `variant − baseline` difference; direction is displayed separately so the sign is not silently reversed. Missing or ambiguous pairs remain visible and unpaired.
- Mean and sample SD of paired differences when supported. For an initial release, do **not** produce confidence intervals or p-values; they require an explicitly justified inferential method and assumptions. If later added, state method, assumptions, confidence level, independent unit, missingness, and limitations, and validate against trusted references.

Seeds are not necessarily independent samples; fixed seed equality does not ensure equivalent random streams. Report this limitation. Do not select winners, claim significance, or hide how candidates or seeds were selected. If multiple trials drove selection, label the summary exploratory where that selection is recorded; otherwise say the selection history is unknown.

### Edge cases and delivery

- Duplicate seed within a candidate/scope is **ambiguous**, not silently averaged or selected. Require the caller to identify a replicate/run or report it as unpaired. Explicitly distinguish reruns, retries, and independent replicates.
- Missing metric, non-finite value, empty group, incompatible scope, differing metric direction, one seed, unmatched baseline, compliance exclusion, and failed linked run are listed rather than converted to zero. Never infer failure solely from an absent metric.
- Read `experiment_log` and already-linked analysis manifests; do not execute new runs, alter old records, or treat an unresolved link as success.
- Document the field definitions and formulas in `docs/ANALYSIS.md` and the tool description. Provide JSON plus a concise human-readable rendering.
- Test known mean/SD and paired deltas, negative values and lower-is-better metrics, duplicates, missing/unexpected seeds, no baseline, identical values, reordered input, and scope or compliance exclusions. Assert deterministic output and no mutation.

### Implemented

`experiment_log action=replicates` is read-only. It requires a Phase 1 `scope_id`, a declared metric with direction, a `candidate_field` and explicit unique `candidates`, a `replicate_unit`, and either `expected_seeds` or `coverage_unknown: true`. Optional `baseline_candidate` pairs a variant only through its recorded `baseline_run_id` and matching seed; `selection_history` defaults to `unknown`. The report keeps duplicate, missing, unexpected, incompatible, failed, and mixed-role runs visible with reasons, returns coverage plus mean and sample SD, and renders text for humans. No confidence interval, p-value, winner, or write is produced. See [Reproducible analysis](ANALYSIS.md#experiment_log).

**Exit:** A researcher can reproduce the summary from its listed runs and can see every incomplete or excluded replicate; no best seed is presented as the repeated-run result.

## 7. Phase 3 — read-only branch view

### Interface and data

`experiment_log action=branches` uses existing same-ledger `parent` IDs, run records, verdicts, and links. It returns a structured graph and a concise text view; `format: mermaid` is the optional rendering. No browser, model call, execution, or second experiment ledger is needed.

Each node should expose:

- Run ID, parent ID, declared role/stage/seed, scope and comparison state, metrics, protocol drift, latest recorded human verdict, and compliance exclusion.
- Hashed artifacts and explicit links; resolve a linked `analysis_run` where possible and display its recorded exit code, timeout, and manifest reference. Label an absent or unresolved link as such.
- A status derived **only from recorded evidence**: e.g. `failed` only when the linked execution records failure/timeout; `pruned` only when a recorded verdict supports that description; otherwise `not_recorded` or `unknown`. Do not call a run failed just because it has no metrics.
- Link provenance and resolution state; an experiment parent is an ancestry link, not proof of scientific causality. Do not infer a connection to a hypothesis or manuscript from textual similarity.

Handle multiple roots, incomplete legacy parents, cycles/corrupt input defensively, duplicate links, long histories, and bounded output. Escape user-controlled labels in Mermaid and apply workspace path rules to exports. Do not load secrets into labels or outputs. Explicitly distinguish the view's source snapshot from a later changed ledger.

### Integration and tests

- Likely touchpoints: `experiment-store.js`, `experiment-log.js`, possibly a small graph-rendering helper; reuse `mermaid_render` only for an explicitly requested rendering. Update [Analysis](ANALYSIS.md) and the experiment-tracking skill.
- Test branching, roots, explicit links, timeout/nonzero exit, unknown execution status, bad verdict, compliance exclusion, missing link target, parent mismatch/corruption, malicious Mermaid labels, and large graph limits.
- Hash source-ledger files before and after the read-only view. If export is requested, only the designated export target may change.

### Implemented

`experiment_log action=branches` is read-only over `experiment.json`, `runs.jsonl`, `links.jsonl`, and `verdicts.jsonl`; it never executes a run and never creates a second ledger. `format` is `text` (default), `json`, or `mermaid`. Only `format: mermaid` with `write: true` writes `<slug>/exports/branches.mmd` inside the workspace (`overwrite: true` replaces it); every other call leaves the workspace unchanged. Each node exposes its run id, parent state, role/stage/seed, scope and comparison state, metrics and metric state, protocol digest and drift, latest human verdict, compliance state, artifact paths/hashes, and labelled links. Linked `analysis_run` records resolve to their exit code, timeout, spawn error, and manifest path/state; notebook, review, and experiment-run links resolve where their ledgers exist; paper links are `not_checked` because PaperMemory is not opened, and `scientific_result` links are `unknown` because those cards are not persisted. Status vocabulary is `good`, `engineering`, `pruned`, `failed`, `not_recorded`, or `unknown`: `failed` requires a resolved linked execution failure or timeout, `pruned` requires a recorded bad verdict, and missing metrics alone never imply failure. Multiple roots, orphans, missing/self/invalid/cyclic parents, duplicate run ids, duplicate links, and corrupt JSONL lines are reported in `anomalies`. Output is bounded by `max_nodes` (default 500, max 5000), `max_edges` (default 1000, max 10000), and `max_links_per_run` (default 50, max 500), with omitted counts kept visible. Source files are hashed into `source_snapshot` and re-checked for `changed_during_read`. Mermaid labels are escaped; run params, notes, environment, and link notes are not included, so secrets are not copied into the view. See [Reproducible analysis](ANALYSIS.md#experiment_log).

**Exit:** The branch view explains what is recorded and what is unknown, and a reader can follow the IDs back to their source records.

## 8. Phase 4 — guided research-cycle workflow

### Approach

Start with a `research_template` entry in `workflows.json`, a first-party skill if warranted, and the existing `provenance_audit rollup`. Remember: `research_template` returns a prompt; it does not itself enforce permissions or execute a workflow. The agent must honor the host's approval mechanisms. If the existing rollup cannot represent a needed state, add a read-only report field to its owner rather than duplicating source ledgers.

### Human-directed sequence

| Step | Existing tools and records | What the guide should show or ask |
|---|---|---|
| 1. Scope | User brief, `coscientist`, optional preregistration | Restate the question, constraints, available data, relevant ethics/permissions, budget, and what the user actually wants to do. |
| 2. Prior art and hypotheses | Search tools, PaperMemory, `coscientist`, `coscientist_verify` | Show evidence and uncertainty; ask the researcher to select, reject, or revise hypotheses. |
| 3. Plan and baseline | `analysis_run plan`, `experiment_log start`, `dataset_get`, optional `data_profile` | Identify dataset/split, metric, protocol, baseline, controls, seeds, and execution environment; show missing inputs. |
| 4. Pilot/slice | `analysis_run`, optional remote compute, `experiment_log` | Present the exact proposed command, data transfer, environment, estimated cost/limits where available, and obtain approval before execution or paid provisioning. Log outcomes and failures. |
| 5. Compare and repeat | Phase 1 scoped comparisons, Phase 2 summaries, Phase 3 branch view | Display comparable runs, excluded/unknown runs, seed coverage, and competing interpretations; the researcher decides next steps. |
| 6. Follow-up and attribution | `ablation`, optional `coscientist trace`, `analysis_run` | Propose missing controls/ablation arms; obtain approval for any new execution. A negative or inconclusive result remains visible. |
| 7. Draft and review | `provenance_audit`, writing tools, optional `deep_review`, `rebuttal` | Show claim/evidence and figure gaps. Offer review with estimated scope; require approval before model-intensive review or edits. Human controls manuscript and response. |
| 8. Export | `repro_package`, provenance reports | Preview artifacts and missing licenses/evidence. Follow the existing explicit-confirmation flow for a draft deposit; never publish automatically. |

Approval is **action-specific and scoped**: a prior general instruction to explore is not permission to run new commands, upload data, spend beyond the approved bound, or rewrite a manuscript. Approval must identify the intended operation and relevant scope; changed inputs or material cost/scope changes require reapproval. Follow the host's actual approval controls rather than inventing an unsupported durable approval mechanism.

### Tests and completion

- Test template discovery, placeholder substitution, missing required inputs, guidance on approvals, and that fetching the template runs no experiment or model call.
- Exercise an offline fixture walkthrough with fake/fixture tool responses: no data, failed run, missing baseline, unpaired seed, declined full run, and review not approved. The workflow must stop or recommend a next action, not execute it.
- Ensure status is derived from source ledgers, reports missing and unknown separately, and does not create a second state machine or imply an automated pass.
- Update `docs/RESEARCH.md`, `docs/ANALYSIS.md`, `docs/TOOLS.md`, `docs/SKILLS.md` if a skill is added, and the changelog.

### Implemented

The guide is a single `research_template` entry, `research-cycle`, in `workflows.json`; no new skill, tool, or ledger was added (decision 6 in section 11: the smaller surface). It takes `slug` and `question` (required) and `constraints` (optional), walks the eight steps above using the shipped Phase 1–3 interfaces (`scope_id`, `baseline_run_id`, `replicates`, `branches`), and stops after each step. Running a command, uploading data, paid compute, a full review, a manuscript edit, and a deposit each require an action-specific approval through the host's `ask_user_question`; the template creates no durable approval record. Status is read from the source ledgers (`provenance_audit rollup`), with missing records reported apart from `unknown`/`not_checked`. See [Research records](RESEARCH.md#guided-research-cycle).

`scripts/test-research-cycle-template.mjs` (`npm run test:research-cycle`) checks discovery, placeholder substitution, that every named tool and action exists in the source, that each consequential step sits behind an approval, and that fetching the template runs nothing. The offline walkthrough with fixture tool responses (no data, failed run, missing baseline, unpaired seed, declined full run, review not approved) needs a model in the loop and has **not** been exercised; the ledger behaviors it relies on are covered by the Phase 1–3 suites.

**Exit:** A researcher can follow one documented path through the existing tools while retaining each consequential decision; the guide never silently starts work.

## 9. Phase 5 — prior-art and figure handoffs

Implement these as two independently releasable subphases. Both start with an inventory and labeled evaluation set; do not assume that an LLM-generated comparison or a vision interpretation is verified evidence.

### 5A. Prior-art triage report

**Reuse:** `literature_search`, source adapters, `paper_resolve`, `paper_get`, PaperMemory quote verification, and `coscientist_verify`. Keep the existing novelty score's lexical and limited-sample caveats intact.

**Proposed output:** for one user-specified claim or hypothesis, report the exact query set, providers, access times, search limits and failures, resolved identifiers, and candidate references. For each candidate distinguish:

- A verified quotation with source and location, when PaperMemory actually confirms it.
- A metadata/abstract-only comparison, labeled as such, or a full-text source not successfully checked.
- The claimed overlap and possible distinction, with evidence links and an `unknown` state where evidence is insufficient.

The output may say **“no close overlap found in the searched material”** with coverage limits; never “proven novel.” Query expansion is bounded and approved where it incurs network/model cost. Store only the minimal search provenance needed to reproduce the report, following existing privacy and source terms. Untrusted retrieved text remains fenced before it enters any model prompt.

**Evaluation and exit** (human labelling waived; see the maintainer decision under *Implemented*): create a small legally usable, human-labeled set covering clear overlap, partial overlap, different methods, misleading abstracts, inaccessible full text, retrieval failure, and no candidate. Record reference-set construction and split development from held-out evaluation. Before implementation, agree measurable coverage and false-overlap/missed-overlap thresholds and abstention expectations; if the dataset is too small, report counts and `not_checked` instead of inventing reliable rates. Test query/source failures, exact quote verification, reproducible source metadata, and no binary novelty claim.

### 5B. Figure-to-result handoff report

**Reuse:** existing `figure_audit` for file properties, `analysis_run`/`experiment_log` hashes and links, `numbers_audit`, manuscript tools, and `provenance_audit`. First inventory whether existing artifacts contain the links needed; do not claim that they already do.

**Proposed output:** map an explicitly supplied figure path/hash and optional manuscript caption/reference to a named generating run and hashed source data or artifact. Show whether each link resolves, whether bytes are current, the source run's recorded execution status, and the numbers that can be extracted through an explicit machine-readable format. A figure may have multiple generating runs or data sources; preserve all declared links.

- A recorded relation is not proof that the figure faithfully depicts the data. A hash proves byte identity, not correctness. Caption or numerical consistency checks are advisory and must identify exactly what was and was not parsed.
- Missing source data, unsupported formats, unparseable figures/captions, ambiguous references, changed bytes, or unlinked figures return `not_checked`/`stale`/`unknown` as applicable. Do not guess plotted values from pixels.
- Vision review, if requested and available, is separately labeled as a model interpretation; it never verifies the underlying data or replaces expert review. No automatic image manipulation or manuscript edit.

**Evaluation and exit:** use small synthetic, licensed fixtures with known hashes, multi-source figures, matching/mismatching captions, stale files, missing input, unsupported formats, and misleading visual content. Have a human label the checkable cases (waived; see the maintainer decision under *Implemented*), declare thresholds before evaluation, and report errors and abstentions. Tests must establish path confinement, broken-link handling, deterministic joins, and that a read-only report does not modify source records.

### Implemented

**5A — `prior_art`** (new tool, `prior-art.js`). It assembles the report from searches the agent already ran and candidates it already read; it performs no search, makes no model call, and resolves no identifier. It records the query set, providers, access times, caps, and failures; the comparison basis per candidate (full text, abstract only, metadata only, unavailable); the caller's claimed overlap and distinction as assertions; and checks each quotation as a verbatim span of the text supplied for that candidate. It never reports that PaperMemory ran. Its strongest statement is `no_close_overlap_found_in_searched_material`, which always carries coverage limits and the sentence that this is not evidence of novelty; with no successful search it makes no statement. The existing lexical reading is reused only as a cross-check flag. Input is bounded, retrieved text is fenced when rendered, and nothing is written unless `write: true`.

**5B — `figure_audit action=handoff`** (`figure-handoff.js`). It joins one figure and optional caption to declared `analysis_run` / `experiment_run` records. Inventory of what existing artifacts contain: `analysis_run` manifests hash declared outputs and record `written_by_run`; `experiment_log` hashes listed artifacts; a figure is linked only when the caller names it. Therefore the report states the link, whether the figure's current bytes match the recorded hash, the run's recorded execution status, and numbers read from a hashed JSON/CSV/TSV file, and it keeps every declared source. It reads no pixels, runs no vision model, and writes nothing.

**Evaluation and thresholds.** `scripts/fixtures/prior-art-eval.json` holds 15 synthetic cases, labelled by the implementer (an AI assistant) and not by an independent human reviewer, and 11 labelled quotations (clear and partial overlap, different methods, misleading abstract, inaccessible full text, retrieval failure, no candidate, results with no reviewed candidate, an unread record asserted as "none", paraphrased and trivially short quotations, capped search, mistaken claimed overlap). Thresholds were declared in the file before the tool was run: every statement, labelled field, and quotation must agree, with zero novelty claims. Two of the author's labels were wrong on the first run (a typo, and a lexical expectation for a candidate with no abstract); they were corrected in the fixture, recorded under `label_corrections`, and the tool was not changed to fit them. The same run showed the report did not say which text its lexical reading used, so `lexical_basis` was added. A separate test found that a search with no status defaulted to success; `status` is now required. An independent code review of the finished branch then found further defects in Phase 5, all fixed with tests: loosely coerced numbers (`[]`, blank text, hex), unknown compliance shown as not excluded, "no close overlap" stated from unreviewed or merely asserted input, a one-word quotation counted as support, a digest that ignored quotations, unfenced identifier and error text, noisy caption tokenising, and an order-dependent source-path rule. Some `prior-art-eval.json` labels changed as a result and each change is logged under `label_corrections`. The set is small and synthetic, so the results are counts and do not estimate performance on real retrieval output; no held-out set of real retrieval output exists yet. Figure fixtures are synthetic, generated by the test, with known hashes: multi-source figures, stale and missing files, an unsupported format, a path and a symlink escape, a failed run, a compliance exclusion, and unreadable values. The caption check is limited to plain numbers and is advisory. **Maintainer decision (2026-11-08):** independent human labelling is not available and is waived. The fixtures are therefore a regression suite written and labelled by the implementer. They check that the rules behave as documented and keep behaving that way; they are not validation against human judgement and must not be cited as evidence that `prior_art` or the handoff is accurate on real material.

**Follow-up (2026-11-08).** A live smoke evaluation on real search results now exists (`npm run eval:prior-art-live`; 8 claims, 53 candidates, implementer-labelled; results and caveats in [Identity and audit tools](IDENTITY-AND-AUDIT-TOOLS.md#prior_art)). It is a smoke check, not an accuracy measurement. Figure handoff accepts an optional `vision_review`, recorded as a model interpretation that verifies nothing. A scripted walkthrough of the guide over real ledgers is `scripts/test-research-cycle-walkthrough.mjs`; it tests the ledgers' states and a test-side approval gate, not a model. **Real-model run (2026-11-08):** the guide was run once with a real model in an isolated DSH (see [Development](DEVELOPMENT.md#live-end-to-end-run-real-host-scripted-model)). It stopped at scope without being told to, ran exactly the one action approved, and surfaced the figure and metric problems itself; one run, one model, so an observation. It also exposed three defects, since fixed: unrecognized template placeholders were silently ignored, `overlap_candidates` could be paraphrased as "no close overlap", and the handoff cannot detect a figure that shows nothing (documented, not fixable without reading pixels). **Still not done:** any measurement of accuracy against human judgement (waived) and any repeated or multi-model evaluation of the guide. The 5,000-run branch-view cap in the handoff is covered by a test with a 5,100-run ledger.

## 10. Cross-phase verification and rollout

### Validation sequence

1. Add small, deterministic fixtures and test the shared eligibility contract before altering public ranking behavior.
2. Run focused suites (`npm run test:experiment`, `npm run test:analysis`, `npm run test:provenance`, `npm run test:coscientist`) plus any relevant ablation, workflow, and figure tests discovered during implementation.
3. Run `npm test`; follow [Development](DEVELOPMENT.md#tests) for the full CI/boot checks. Do not label a network, GPU, provider, or UI scenario tested unless it was actually run.
4. Exercise a realistic temporary workspace with: two datasets; slice/full stages; multiple baselines; protocol drift; three planned seeds with one missing; an explicit failed run; an ablation link; and a declined full run. Demonstrate that all raw records remain visible and no cross-scope winner is produced.
5. Hash pre-existing fixture ledgers before and after read-only actions; check that only an explicitly requested export or the provenance tool's documented cache can be written.
6. Verify outputs for malformed/legacy stores, unresolved links, symlink/path escapes, prompt injection in retrieved text, Mermaid label escaping, and failure without credentials or optional runtimes.

### Release and documentation checklist

- [ ] Document public tool parameters, status vocabulary, example calls using the **actual shipped API**, and behavioral changes in `docs/ANALYSIS.md`, `docs/TOOLS.md`, relevant skills, and `docs/CHANGELOG.md`.
- [ ] Update `schemas/` if new persistent record contracts or fixtures are introduced; do not silently change old schema interpretation.
- [ ] If new modules are created, follow the package export/files and registration conventions in `package.json`, `index.js` or the preset composition as applicable; rebuild generated files only when their source changes.
- [ ] Explain legacy no-ranking behavior, retrospective annotations if supported, and how to inspect raw runs. No destructive migration.
- [ ] Demonstrate that no workflow action automatically executes code, purchases compute, sends data, edits a manuscript, or publishes.
- [ ] Attribute the conceptual inspiration as appropriate and obtain review before any upstream code/prompt reuse. Preserve third-party license and dataset terms.
- [ ] Record what tests were run, what was skipped, known performance limits, and any unresolved statistical or security assumptions.

## 11. Decisions to make during implementation

1. Exact public names and schema for the comparison identity and candidate grouping; freeze examples only after testing real existing ledgers.
2. Whether retrospective identity annotations are needed in Phase 1 or can be deferred in favor of new records. If introduced, decide evidence and correction-event semantics without mutating prior records.
3. Which data identities are sufficiently verified for a given backend, and which are user assertions; never upgrade an assertion silently.
4. Whether a separate branch export is worthwhile beyond JSON/text and existing graph tooling.
5. Which labeled prior-art corpus and figure fixtures can be distributed, and what sample size can support a meaningful evaluation. Agree thresholds before evaluating the final implementation.
6. Whether the guide needs a new skill or a workflow template plus existing skills is enough. Prefer the smaller surface.

These are implementation decisions, not permission to broaden autonomy. If any decision would require unattended execution, alter the safety boundary, or copy restricted upstream material, stop and seek explicit approval and appropriate review.
