# Writing compiler: OpenCode model test, 2026-11-09

## Scope and verdict

**Not ready to rely on as a completion gate without fixes.** The deterministic
engine and a small live model-backed rubric scenario worked, but the tests also
found an admitted rubric finding being marked fixed when the verdict was
`unclear`, and a model change reusing the previous model's cached verdicts.
These are counterexamples to the compiler's completion and model-isolation
claims, not merely untested cases.

Model: `openai/gpt-6.1-terra`, invoked by `opencode run` through a temporary
`command`-backend adapter. No DeepSeek model was used in this test. The adapter
was an experimental bridge, not a built-in OpenCode integration. Its command
backend does not set temperature, and the model ran with OpenCode's session
instructions; this is not a controlled temperature-zero accuracy evaluation.
All manuscripts and mutations were in `/tmp/opencode/writing-compiler-eKOgBA/`;
the real paper was copied from `paper/rsi-local`. The original was not edited.

## Results

| Test | Observation |
|---|---|
| Engine regression suite | `npm run test:ah-engine`: **264 passed**. |
| Plugin and bridges | `node scripts/test-academic-harness.mjs`: **159 passed**; `test-lookup-snapshot.mjs` and `test-external-bridge.mjs` passed. These are automated tests, not live registry or UI tests. |
| Stability, small and real copies | Five runs each: every code tier had minimum overlap **1.0**. The real-copy audit run twice had hash `3fa4b35853f90019`; the second had 0 new, 0 fixed, and no unexplained findings. This does not independently establish correctness or stability across restarts. |
| Live rubric, planted and clean paragraph | `RUB-GENERAL` on two synthetic paragraphs: 2 model calls, 1 yes and 1 no; the yes quoted the overclaim and produced an info finding. Repeating it: 0 calls, 2 cached, same finding and fingerprint `1b9fcb655fc972eb`. After editing only the overclaim: 1 call, 1 cached, both no. |
| Live rubric, switch model | Changed the adapter argument from `openai/gpt-6.1-terra` to `openai/gpt-6.1-terra-fast`. The engine made **0 calls** and reused both old verdicts. See finding 2. |
| Cost visibility | The three actual model calls' OpenCode events reported 29,656 input and 92 output tokens in total, with 4,864 cache-read tokens and cost 0 in the event logs. The compiler reported 0 input and 0 output tokens because the command backend does not parse usage. These event counts may have provider-specific cache semantics; they are not a monetary cost estimate. |

The real manuscript migration guessed `grant/proposal`; the deterministic
stability result is therefore **not** a validity assessment of its findings
against the correct paper profile. Its generated `tex.prose` also omitted the
`appendix/` files. See finding 4.

## Findings

### 1. Admitted `unclear` verdicts can close findings and look complete — high

In a scratch project, a synthetic admission was written directly for testing;
it was **not** a real author admission or a precision measurement. A fake
backend first returned a valid `yes` on a paragraph, producing an open admitted
`RUB-01`. A second audit, with caching disabled and unchanged paragraph text,
returned `unclear`. The ledger reported `fixed: 1`; the finding disappeared and
the rubric component said `ok: 1 admitted criteria, no open finding`. In a
separate run, two `unclear` results counted as 2 judged, 0 unjudged. The overall
test project still failed because of an unrelated `TEX-05`, so an overall PASS
was **not** observed.

`vendor/academic-harness/ah/checks/rubric.py:195-208` only puts missing/error
verdicts in `unjudged` and skips all non-yes verdicts. The carry logic in
`vendor/academic-harness/ah/audit.py:103-111,173` therefore does not preserve
the earlier finding. `vendor/academic-harness/ah/done.py:91-100` sees no
unjudged pair. `unverifiable` follows the same non-yes branch; its full ledger
transition was not independently reproduced. Treat unresolved answers as
unresolved for carrying and completion, rather than as a `no`.

### 2. Command-backend cache and admissions can collide across models — high

`vendor/academic-harness/ah/verifier/backends.py:83` and
`vendor/academic-harness/ah/rubric.py:149-157` use the first 60 characters of
the joined command as the model identity. Both actual configurations above
resolved to `python3 /tmp/opencode/writing-compiler-eKOgBA/adapter.py ope`.
The second real rubric run after the model argument changed reported both
verdicts cached and made no new calls. Because admissions use the same model
identity, a collision can also leave an admission valid for a different model.
Changing a script's implementation at the same path is another identity risk.
Use an explicit, non-truncated backend/model identity or a collision-resistant
identity that includes the complete configuration and an explicit version.

### 3. Failed model calls are omitted from call counts — medium

With a fake backend returning an endpoint error twice, the backend counted 2
actual calls, but `rubric_run` reported `calls: 0, errors: 2`. In
`vendor/academic-harness/ah/checks/rubric.py:195-204`, the error branch
continues before adding the verdict's calls and token usage. This hides failed
requests in cost and rate accounting. The separate command-backend token
limitation is described in the results table.

### 4. Migration silently omitted an included appendix — medium

`ah migrate paper/rsi-local --json` listed three `appendix/*.tex` files in its
scan, but selected only `sections/**/*.tex` for prose, with no warning, even
though `main.tex` includes all three appendix files. The copy was migrated and
the audit coverage did not include those appendix prose files. The scanner in
`vendor/academic-harness/ah/migrate.py:60-66` recognizes `appendices/` but not
`appendix/`. The same scan guessed `grant/proposal` for this system paper; a
user can override the profile, but the guess needs inspection. This means the
stable real-copy result above is partial coverage, not a whole-paper check.

### 5. Some malformed criterion structures crash instead of yielding RUB-02 — medium

On a scratch copy, a criterion with a valid ID and question but
`scope: invalid` caused `load_criteria` to raise `AttributeError: 'str' object
has no attribute 'get'`. `vendor/academic-harness/ah/rubric.py:83-96` assumes
scope is a mapping and directly converts `min_words` to an integer. The
existing malformed-file test covers invalid YAML and several invalid values,
but not this structure. Validate types and convert failures into `RUB-02`.

## Coverage limits

- This is one small live model scenario, not an accuracy or admission study;
  no criterion was admitted on real labels.
- Live registry outages, external-tool execution, rule promotion, free-review
  integration, approvals, host stop hooks and an agent-driven convergence loop
  were not exercised in this run. Existing automated tests and prior
  DeepSeek-only reports must not be mistaken for OpenCode live evidence.
- The temporary bridge and its model-event log, plus the scratch repro scripts
  `repro.py` and `repro-ledger.py`, are under the scratch path above. The
  synthetic admission and backend outputs exist only in scratch projects.
