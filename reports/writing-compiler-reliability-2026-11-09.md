# Writing compiler: fixes and post-fix verification

Date: 2026-11-09. Working-tree changes based on commit `0e3cca2`.
Engine rule set **1.9.0**, bundle revision **dsh13**.

## Outcome

The five defects recorded in
[the initial OpenCode report](writing-compiler-opencode-2026-11-09.md) are fixed
and covered by behavioral regressions. The engine and plugin suites pass.
Larger copied-manuscript tests and real OpenCode rubric calls passed the
engineering invariants measured below. This is **not** a claim of independently
validated rubric accuracy, complete TeX interpretation, or native OpenCode host
enforcement.

### Implemented

| Problem | Fix |
|---|---|
| Uncertain answers could close admitted findings | `unclear`, `unverifiable`, errors and exhausted budgets are unresolved. Carry previous findings, including in read-only audits; admitted unresolved pairs produce INCOMPLETE unless a failure already determines FAIL. Only a valid `no` clears an in-scope defect automatically. |
| Model arguments collided after character 60 | Versioned SHA-256 verifier fingerprints include complete structured arguments, backend, route/provider/model, relevant settings and adapter revision. T3 and TR caches and admissions use verifier identity rather than display labels. |
| Failed requests disappeared from accounting | Count calls and known tokens before interpreting success/error. Correction attempts share a thread-safe request budget. Unknown usage has an explicit completeness flag; command adapters can supply structured usage. Pi's hidden transport retries are refused rather than escaping the budget. |
| Included appendix/custom prose was omitted | Migration supplements known folders with the literal input graph. Shared resolution underpins reachability/order; JSON reports input coverage and `UNIT-04` flags included prose outside configured audit coverage. Profile guessing avoids incidental grant vocabulary without a structural grant signal. |
| Malformed scope/admission structures crashed or weakened checks | Validate scope/configuration types and report deterministic rubric diagnostics. Invalid overrides do not silently become the bundled criterion; invalid admission data cannot silently produce a clean completion result. |

Additional improvements: uncertain labels cannot count as negative admission
examples; admitted info-level defects still affect completion; duplicate label
units are rejected; `--retry-unresolved` deliberately retries cached uncertainty;
state cards read cached rubric and external evidence; cache replay does not
report historical tokens as new usage; `python -m ah` is available; an opt-in
OpenCode V2 adapter uses a one-step, tool-denied verifier and an explicit model.

## Regression and packaging checks

| Check | Result |
|---|---|
| `npm run test:ah-engine` | **294 passed**, versus the original 264. |
| `npm test` | **103/103 JavaScript test files passed**, including native-tool mapping, lookup snapshots and external bridge. |
| Native Academic Harness suite | **165 checks** after adding six retry-argument checks; included in the full suite. |
| `git diff --check` | Clean. |
| Fresh installed package | Built/installed into `/tmp/opencode/ah-release-check`; imported from its `site-packages`, rule set 1.9.0. All **79 Python/YAML package files** matched the checkout byte-for-byte. Replayed 84 real cached rubric verdicts with 0 calls and preserved the uncertain answer. The bundled virtualenv was also refreshed and all 79 files matched. |

The initial bundled virtualenv imported an installed engine rather than the
checkout. Current source tests explicitly select `vendor/academic-harness` via
`PYTHONPATH`; the fresh package check validates the installed path separately.
The bundle revision was bumped so existing installations rebuild on upgrade.

Environment: Python 3.13.5, Node v24.15.0, OpenCode v2.2.6.

The new regressions first failed on the unfixed checkout. They cover uncertain
ledger transitions, uncertainty with no previous finding, admitted info-level
findings, read-only carrying, cached uncertainty and explicit retry, uncertain
admission labels, model/endpoint identity, legacy admission invalidation,
appendix/custom input coverage, malformed structures, request budgets,
structured command completions, OpenCode event parsing and history-preserving
recovery of a formerly fixed finding.

## Local manuscript corpus

Discovery examined LaTeX research candidates under the user's home directory.
Personal application/CV material, templates and dependency trees were excluded
from the selected corpus. Twenty distinct root-source texts were selected after
deduplication; some manuscripts/volumes may share content, so these are not 20
independent scientific samples. Source files were copied into new scratch
projects; original TeX source hashes were checked afterward.

| Run | Result |
|---|---|
| Unmodified-source copies | 20 roots; **1,984 parsed units, 129 audited files**. Five stability runs per project; all stable; repeated audit hashes equal; second audits had 0 new, 0 fixed and no unexplained findings. Nine single-file roots correctly raised `UNIT-03` for unparsed root prose. |
| Expanded coverage on copies | Moved each root's document body into an included section **on the copy only**. **2,885 units, 149 audited files**, including appendices/custom paths. Five stability runs per project; all stable; repeated audit hashes equal; no new/fixed/unexplained findings on the unchanged second audits. |
| Largest project | **1,122 units, 37 audited files**. |
| Corpus time | Expanded run: about **32.9 seconds** total for migration, anchors, two audits and five stability runs per project. Largest project about 14.1 seconds for that combined workload. |
| Source safety | All checked original TeX source hashes unchanged. |

The expanded corpus had 5,204 findings in aggregate; their truth was **not**
individually labelled. These counts establish reproducibility and exercised
coverage, not precision. Projects used the explicit `generic` profile to avoid
confounding deterministic testing with speculative venue requirements. The
corpus runner copies TeX/bibliography sources, not every binary asset; it does
not demonstrate LaTeX build or visual-layout correctness.

## Real OpenCode rubric experiment

Primary model: **`openai/gpt-6.1-sol`**, the model selected for this session.
Alternate identity test: **`openai/gpt-6.1-sol-fast`**, two calls only.
No DeepSeek model was used in this experiment.

Sample: first two eligible prose paragraphs from each copied project, plus a
planted overclaim and a clean paragraph. **42 paragraphs**, checked against
`RUB-GENERAL` and `RUB-SUPERLATIVE`: **84 pairs**. Selection was not random or
blind and is not a scientific accuracy study.

| Scenario | Observed |
|---|---|
| Cold run | **84 calls**, 0 errors, 2 verified yes findings, 81 no answers, 1 unclear answer. About 104.9 s. |
| Unchanged replay | **0 calls, 84 cached**, identical report hash `625ce880e13f10d0`; uncertainty remained unresolved. About 0.028 s. |
| Edit only the planted paragraph | **2 calls, 82 cached**; both planted findings cleared by negative verdicts, 0 remaining yes findings. About 4.5 s. The unrelated uncertain pair remained unresolved. |
| Change configured model | **2 calls, 0 cached**, enforced limit of 2; the other 82 pairs remained unresolved. A distinct verifier identity was used. |
| Restore original model, cache-only | **0 calls, 84 cached**, including the uncertain answer. |

Experiment totals: **88 rubric calls**, **79,016 input / 2,965 output tokens**
as reported by the adapter, with complete input/output usage for those calls.
Separate adapter smoke calls are not included. Provider cache accounting may
use different token semantics; no monetary cost estimate is asserted.

The adapter records an explicit model, reads JSON events, rejects tool/error or
incomplete terminal responses, and clears inherited session routing. OpenCode
requires `PWD` to match the subprocess working directory for correct project
agent selection in this environment. Preflight verifies that the dedicated
tool-denied agent is loaded. Global OpenCode instructions/settings can still
supplement the context; temperature zero is **not** asserted for this route.

No real criterion was admitted from these unlabelled paragraphs. In a separate
scratch-only test, a clearly marked **synthetic admission** was applied to the
actual cached model answers: the real unclear result made the rubric INCOMPLETE,
with 0 additional calls. Synthetic admission metadata is engineering-test data,
not human agreement evidence or authorization for a production gate.

## Real external checks and registry replay

- Ran the actual SciPy-backed numbers auditor on all 20 expanded copied
  projects: **0 tool errors**, 64 candidate findings, about 15.0 s total.
  All 20 result files were subsequently ingested as fresh by the engine.
  Candidate accuracy was not independently assessed.
- A separate planted project used the actual numbers/figure/citation tools:
  **STAT-01** for `t(28) = 2.1, p = 0.9`, **STAT-02** for `M = 3.47, N = 10`,
  two **FIG-01** low-DPI findings and one **FIG-02** duplicate-image finding.
- After correcting the p-value to `0.045` without rerunning the external tool,
  the engine emitted **EXT-00** and retained the old STAT-01 as open. After the
  real external rerun, STAT-01 became fixed and EXT-00 disappeared. Unrelated
  code findings can change during that prose edit; the assertion checked the
  statistical finding's own state, not total fixed counts.
- The real citation audit resolved the known LeCun/Bengio/Hinton *Deep learning*
  reference (`10.1038/nature14539`) without citation findings. A repeated audit
  inside `unshare -rn` (network namespace without networking) reused registry
  answers: **3 hits, 0 fetches, 0 failures**, still no citation findings.

## Artifacts and reproduction

Raw artifacts contain manuscript excerpts/local paths and are kept in scratch,
not copied into the repository:

- `/tmp/opencode/writing-compiler-corpus-v1/results.json`
- `/tmp/opencode/writing-compiler-corpus-v2/results.json`
- `/tmp/opencode/writing-compiler-live-fixed-v2/summary.json`
- `/tmp/opencode/writing-compiler-external-results.json`
- `/tmp/opencode/writing-compiler-planted-external/`
- `/tmp/opencode/writing-compiler-npm-final.log`

The corpus/live output directories use owner-only permissions. Reusable opt-in
runners are checked in:

```bash
python3 scripts/writing-compiler-corpus.py \
  --manifest /path/to/private-manuscript-list.json \
  --output /tmp/opencode/new-corpus --runs 5 --limit 80 --extract-root

python3 scripts/writing-compiler-live.py \
  --corpus /tmp/opencode/new-corpus/results.json \
  --model openai/gpt-6.1-sol --switch-model openai/gpt-6.1-sol-fast \
  --output /tmp/opencode/new-live-test

node scripts/writing-compiler-external-live.mjs \
  /tmp/opencode/new-corpus/results.json /tmp/opencode/new-external-results.json
```

The manifest contains `[{"path": "/absolute/path/to/main.tex"}, ...]`.
Select models available in the target OpenCode installation explicitly.

## Remaining limits and follow-up

1. **Human admission evidence:** collect blind human labels and held-out
   measurements. This run does not establish rubric precision, recall or kappa.
2. **Host behavior:** native OpenCode protected-path interception, human
   approval UI, stop-hook reentry and a tool-using agent's multi-round fix loop
   were not validated live here. The adapter is a verifier bridge, not those
   host protections. Existing host hook/guard regressions pass.
3. **Exploratory reviews:** existing promotion/triage regressions pass, but no
   new hosted `deep_review` round or approval interaction was run in this pass.
4. **TeX and profiles:** macro-generated includes, compiled PDF layout, complete
   single-file root parsing and venue-specific profile accuracy remain outside
   this result. Root prose is surfaced, not silently declared audited.
5. **Evidence migration:** legacy caches are bypassed and legacy admissions
   require remeasurement. Existing history is preserved; not every historically
   false fixed decision can be identified from old metadata. A fresh bounded
   audit can reopen a persistent defect with an explained regression state.

These limits should not be replaced by an unconditional claim that every phase
has been proven correct. The implemented fixes close the reproduced correctness
holes; compiler PASS still is not a statement that the science is true.
