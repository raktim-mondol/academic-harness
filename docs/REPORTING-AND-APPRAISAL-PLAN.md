# Reporting-guideline checker and risk-of-bias appraisal — implementation plan

Status: **proposed, not implemented** · baseline **v0.28.0** · targets **v0.29.0** (Phase 3) and **v0.30.0** (Phase 4).

This document covers the two evidence-quality phases that remain after the reference-library work:

- **Phase 3** — a reporting-guideline checker (`reporting_check`).
- **Phase 4** — risk-of-bias and critical-appraisal actions in the existing `review` ledger.

They are independent: Phase 3 can ship first, and Phase 4 can reuse `reporting_check` later for appraising other authors' papers. Neither needs a new API key or a network service.

## 1. Why

The harness can discover, store, and quote papers, but it cannot yet answer two common manuscript questions with an auditable trail:

1. **Does the manuscript report what its guideline requires?** CONSORT, STROBE, PRISMA, ARRIVE, TRIPOD, CARE, and STARD each define items that reviewers expect to find. A general LLM pass produces prose, not a checklist a co-author can verify.
2. **How was risk of bias judged, by whom, and do the reviewers agree?** `review` currently records screening decisions and evidence but has no appraisal step, no reviewer-keyed state, and no agreement statistics. A second reviewer has to overwrite the first, which makes dual review impossible to audit.

Both phases follow the same rule: **the model proposes, the tool verifies, the human decides.** No tool returns "compliant", "low risk", or a publication-ready verdict on its own.

## 2. Current state

- `review` (`review.js`) exposes `start`, `add`, `screen`, `evidence`, `status`, and `export`.
- `review-store.js` keeps append-only `screening.jsonl` and `evidence.jsonl` under `<cwd>/.dsh/review/<slug>/`.
- Screening state is the latest event per `(record_id, stage)`. The event stores a `reviewer`, but reviewer is not part of the state key, so a second reviewer must pass `override: true` and the first decision disappears from derived counts.
- `evidence` quotes are stored verbatim but are not checked by `review`; PaperMemory `quote_check`/`trace` remains the verifier.
- `stat_audit` reads `.tex`, `.md`, `.txt`, and `.docx` manuscripts and shells out to `python-helpers/stat_audit.py`; `defusedxml` is already a helper dependency.
- `pdf_to_markdown` is the existing path for PDFs.
- Python helpers already include matplotlib, so a risk-of-bias figure can reuse the existing helper environment.

## 3. Shared design rules

1. **Native, preset-only tools.** No MCP mounts and no new service.
2. **Action-multiplexed.** `reporting_check` is one tool with an `action`; `review` grows new actions rather than adding a second review tool.
3. **Append-only state.** Verdicts and appraisal judgements are never edited in place. Corrections are new events with a reason.
4. **Paraphrase, never republish.** Checklist and instrument text is paraphrased, versioned, and linked to the official source. Official wording is not bundled.
5. **Evidence, not opinion.** A positive judgement needs a verbatim quote and a location; absence claims need the search terms/sections that were checked.
6. **No automated compliance.** Exports report counts and verified evidence, never "compliant" or "ready for submission".
7. **Workspace-confined paths.** Manuscript paths, ledgers, and exports stay inside the session workspace and reject symlink escapes.

## 4. Phase 3 — reporting-guideline checker (`reporting_check`)

### 4.1 Actions

| Action | Behaviour |
|---|---|
| `list` | Available guidelines, versions, and applicable study designs. |
| `suggest` | Candidate guidelines for a manuscript, with the matching terms shown. Never selects one. |
| `start` | Open a check: `slug`, `guideline`, `manuscript` (workspace path or PaperMemory id). Snapshot the manuscript hash. |
| `items` | The checklist with current status, optionally only unassessed or failing items. |
| `candidates` | For one item, ranked passages (section, offsets, excerpt) from the manuscript, found by section heuristics and BM25 over the item's cue terms. |
| `judge` | Record a verdict for an item: `reported`, `partial`, `not_reported`, `not_applicable`, with evidence. |
| `status` | Counts by verdict, items still unassessed, stale evidence. |
| `export` | Markdown, CSV, or a LaTeX supplementary table (item, verdict, section, line/page), with links to the official source. |

### 4.2 Checklist data

Checklists ship as versioned JSON under `checklists/<id>/<version>.json`.

First set:

- CONSORT
- STROBE
- PRISMA 2020 (with PRISMA-S and PRISMA-ScR variants)
- ARRIVE 2.0
- TRIPOD+AI
- CARE
- STARD

Later: SPIRIT, COREQ, SRQR, CHEERS, MOOSE, SQUIRE, and ML reproducibility checklists.

Each item carries:

- `id` — follows the official numbering so exports map to the published form.
- `section` — where the item usually belongs.
- `short_prompt` — a paraphrase, never the official wording.
- `cues` — terms/regexes used to retrieve candidate passages.
- `applies_when` — optional condition (for example, "randomised crossover").
- `source_url` — the official checklist.
- `version` — checklist version.

Counts are reported from the data, not hard-coded in prose.

### 4.3 Evidence rule

- Every item starts `unassessed`.
- `reported` and `partial` require an `evidence` entry: a verbatim quote and its location. The tool re-reads the manuscript and verifies the quote is a substring after whitespace normalisation. A quote that does not appear is rejected, not stored.
- `not_reported` is a claim of absence, so it must list the `searched` terms/sections. It is stored as advisory and flagged for author review.
- `not_applicable` requires a reason and is listed separately so a reader can challenge it.
- If the manuscript hash changes after a verdict, affected evidence is re-verified on `status`; quotes that no longer match become `stale`.
- The export says "N of M items have verified evidence", never "complies with CONSORT".

### 4.4 Manuscript input

Supported: `.tex`, `.md`, `.txt`, `.docx`, and PDF through `pdf_to_markdown`.

- Reuse the workspace-path and docx-reading code from `stat_audit`; `defusedxml` is already available.
- LaTeX is stripped for matching, but offsets are kept against the original so locations are real file positions.
- A PaperMemory id can be used when the manuscript is already stored; the snapshot is taken from the stored markdown.

### 4.5 Integration

- **`ah_*` projects:** when the manuscript is an Academic Harness project, locations are also expressed as `%% @unit` ids from the engine inventory. The vendored engine is not modified; `reporting_check` only reads.
- **PaperMemory:** the same tool can check an ingested paper against a guideline when appraising other authors' work. This is optional for Phase 4.
- **Skills:** a new `reporting-guidelines` skill drives `suggest → start → candidates → judge → export` and tells the agent to delegate item batches to subagents, with the same position-controlled judging discipline as the tournament skill.
- **Notebook:** each check logs start and export entries.
- **RSI:** a later task-class signal `reporting` can capture unverified-quote rejections and stale evidence.

### 4.6 Files and wiring

New:

- `reporting-check.js` — tool registration and rendering.
- `reporting-store.js` — ledger under `<cwd>/.dsh/reporting/<slug>/`: `check.json`, `verdicts.jsonl`, `exports/`.
- `checklists/**` — versioned JSON.
- `skills/reporting-guidelines/SKILL.md`.
- `scripts/test-reporting-check.mjs`.

Modified:

- `presets/academic-harness/agent.cordis.yml` and generated `cordis.patch.yml`.
- `prompt.js` — when to use the tool, and when to stop at evidence rather than a verdict.
- `docs/WRITING.md`, `docs/TOOLS.md`, `README.md`, `docs/CHANGELOG.md`.
- `package.json` exports/files and test script.

### 4.7 Acceptance

- A fabricated quote is rejected.
- A verified quote is accepted across LaTeX, Markdown, and docx fixtures.
- Editing the manuscript marks affected evidence stale.
- `not_reported` without `searched` is rejected.
- Item ids in an export match the checklist file.
- `suggest` returns reasons and never selects a guideline itself.
- The export never contains a "compliant" label.

## 5. Phase 4 — risk-of-bias and appraisal ledger (extends `review`)

### 5.1 New `review` actions

`ACTIONS` grows from `start, add, screen, evidence, status, export` by:

| Action | Behaviour |
|---|---|
| `appraise` | Record a domain-level judgement (and optional signalling-question answers) for a record under a named instrument, by a named reviewer, with a supporting quote. |
| `reconcile` | Record a consensus or third-reviewer decision that supersedes disagreeing judgements; originals stay in the log. |
| `agreement` | Inter-reviewer agreement for screening or appraisal. |
| `appraisal_status` | Per-record and per-domain completeness, with outstanding disagreements. |

`export` gains:

- `rob-table` — per-study domain table (CSV/Markdown).
- `rob-summary` — counts by domain.
- `rob-figure` — traffic-light and summary SVG through `python-helpers/rob_figure.py` (matplotlib is already a helper dependency).

### 5.2 Instruments

Templates live in `appraisal/<instrument>/<version>.json` with domains, optional signalling questions, allowed judgements, and the overall-judgement rule.

First set:

- RoB 2 — randomised trials.
- ROBINS-I — non-randomised interventions (v1 first; v2 only after the spike confirms the mapping).
- QUADAS-2 — diagnostic accuracy.
- Newcastle-Ottawa — cohort and case-control, star counts.

Later: SYRCLE (animal), PROBAST (prediction models), AMSTAR 2 and ROBIS (reviews), JBI tools.

Domain judgements are always entered by a reviewer. For RoB 2 and ROBINS-I, an overall judgement is derived from the domain judgements by the documented rule (for RoB 2: any "high" → high; otherwise any "some concerns" → some concerns; otherwise low) and marked `derived`. A reviewer can override it with a reason.

Mapping signalling-question answers to a domain judgement through the official algorithms is a separate sub-phase (4b), done only if the algorithms can be reproduced and bundled exactly. Until then, signalling answers are stored as supporting detail, not converted into a judgement.

### 5.3 Dual-reviewer support (backward-compatible schema change)

Today screening state is the latest event per `(record_id, stage)`, so a second screener must use `override: true` and the first decision disappears from derived counts.

Change:

- State is derived per `(record_id, stage, reviewer)`.
- Events with no `reviewer` are treated as reviewer `default`, so existing ledgers read identically.
- `deriveStatus` reports a record's **resolved** decision (reconciled, unanimous, or pending/conflict) and a list of conflicts.
- `override` keeps its meaning but applies to the same reviewer's own earlier decision.
- New `appraisal.jsonl`, same append-only discipline, keyed `(record_id, instrument, domain, reviewer)`.
- `review start` accepts an optional `reviewers` list. With two or more, `status` shows conflicts and `reconcile` is available.
- Reviewer identities are typed: `human:<name>` and `ai:<model-or-agent>`. AI judgements are recorded and shown, but agreement is computed human-vs-human by default. AI-vs-human agreement is reported separately and never folded into the human κ.

### 5.4 Agreement statistics

New `agreement.js`, pure functions with golden fixtures:

- Percent agreement.
- Cohen's κ for two raters on nominal categories (screening: include/exclude/maybe).
- Linearly or quadratically weighted κ for the ordinal risk-of-bias scale (low < some concerns < high).
- An approximate confidence interval.
- Explicit edge cases: κ undefined when expected agreement is 1, unequal category sets, single-category data, missing ratings (listwise, with counts reported), and prevalence/bias caveats in the output.

Fleiss' κ for more than two raters is a later addition.

### 5.5 Evidence rule

An appraisal judgement of `low` or `high` should carry a supporting quote and location. When the paper is in PaperMemory, check the quote with `quote_check`; otherwise flag it `unverified`, matching how `review evidence` already works.

### 5.6 Files and wiring

New:

- `agreement.js` — agreement statistics.
- `appraisal/**` — instrument templates.
- `python-helpers/rob_figure.py` — traffic-light and summary SVG.
- `skills/risk-of-bias-appraisal/SKILL.md`.
- `scripts/test-appraisal.mjs`, `scripts/test-agreement.mjs`.

Modified:

- `review-store.js` — reviewer-keyed screening state and `appraisal.jsonl`.
- `review.js` — new actions, parameters, export formats, rendering.
- `skills/systematic-review-ledger/SKILL.md` — route appraisal work.
- `docs/RESEARCH.md`, `docs/TOOLS.md`, `README.md`, `docs/CHANGELOG.md`.
- `package.json` exports/files and test script.
- `scripts/test-review-store.mjs`, `scripts/test-review-tool.mjs`.

### 5.7 Acceptance

- Ledgers created before this change read and export identically.
- Two reviewers can both screen a record without `override`.
- Conflicts appear in `status`.
- κ matches golden values, including the documented edge cases.
- Reconciliation preserves the originals.
- Overall RoB 2 derivation matches a truth table.
- AI-vs-human agreement is never folded into the human κ.
- A fabricated appraisal quote is rejected; an unverifiable one is marked `unverified`.

## 6. Delivery order

1. **Phase 3A — checklist data and ledger.** `reporting-store.js`, checklist JSON for CONSORT/STROBE/PRISMA, `start`/`items`/`judge`/`status`, tests.
2. **Phase 3B — manuscript matching.** `candidates`, `.tex`/`.md`/`.txt`/`.docx` input, stale-evidence handling, export.
3. **Phase 3C — integration.** `ah` unit locations, PaperMemory input, skill, prompt, docs, package/preset wiring.
4. **Phase 4A — agreement primitives.** `agreement.js` and golden fixtures, independent of the review schema.
5. **Phase 4B — reviewer-keyed schema.** `review-store.js` compatibility change, conflict reporting, dual-reviewer tests.
6. **Phase 4C — appraisal and exports.** `appraise`/`reconcile`/`appraisal_status`, instruments, `rob-table`/`rob-summary`/`rob-figure`, skill, prompt, docs.

Phase 3 and Phase 4 can run in parallel after 4A, but 4B must land before 4C.

## 7. Risks and open questions

- **Checklist licensing.** Only paraphrases and item ids are bundled; the official wording is linked. Verify current versions and numbering before shipping each checklist.
- **DOCX/PDF parsing.** Reuse `stat_audit` and `pdf_to_markdown`; do not add a second document parser.
- **Stale evidence.** The manuscript hash is the source of truth. Any edit invalidates dependent verdicts until rechecked.
- **Reviewer identity.** Human and AI judgements must stay distinguishable; agreement defaults to human-vs-human.
- **Instrument rules.** Do not encode a domain rule until it can be reproduced exactly and tested against a truth table.
- **No verdict inflation.** The tools may say "N of M items have verified evidence" or "risk-of-bias judgements are complete"; they must not say "compliant" or "low risk" on their own.
- **Storage growth.** Append-only ledgers are small, but exports and snapshots need a retention note.
- **Optional integration.** `reporting_check` against ingested papers is useful but not required for Phase 4's first release.

## 8. Out of scope

- Republishing official checklist or instrument wording.
- Automatic "compliant" or "low risk" verdicts.
- Meta-analysis pooling, forest plots, or funnel plots.
- A GUI for checklists or appraisal.
- Free-form web scraping of guideline pages.
- Training or fine-tuning a model on the ledgers.

## 9. Verification

Automated:

- `node scripts/test-reporting-check.mjs`
- `node scripts/test-review-store.mjs`
- `node scripts/test-review-tool.mjs`
- `node scripts/test-appraisal.mjs`
- `node scripts/test-agreement.mjs`
- Existing `npm run build`, `npm run build:patch`, and the CI test chain.

Manual:

- Start a review with two reviewers, screen the same record differently, confirm `status` shows a conflict, reconcile it, and export.
- Run a CONSORT check on a small LaTeX manuscript, judge one item with a real quote, edit the manuscript, and confirm the verdict becomes `stale`.
- Confirm no export contains a compliance verdict.
