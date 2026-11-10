# Development

Every server-side file is plain ESM JavaScript — no build step. The Settings page (`client/`) is the exception: it is a browser bundle (React, esbuild) served to the DSH web client.

Academic Harness is **Linux-only**. `package.json` declares `"os": ["linux"]`, CI runs on Ubuntu, and Windows/macOS are unsupported. The test suite includes a scope check (`scripts/test-linux-only.mjs`); do not add cross-platform CI lanes without changing that decision and the user-facing requirements.

## Build the Settings page

```sh
npm ci   # once: installs exactly what package-lock.json records (esbuild builds the client)
npm run build # after any client/ change — rebuilds lib/client.js
```

`lib/client.js` is committed so installing the plugin never needs a build step or `pnpm approve-builds` for this package itself.

## Tests

The tool tests are plain Node scripts under `scripts/test-*.mjs` and need no network (the Python-helper cases skip themselves when SciPy/Pillow are unavailable). `npm test` globs and runs all of them; CI calls the same command, so a new test file is picked up automatically:

```sh
npm test                      # every scripts/test-*.mjs
npm test -- deep-research     # only files whose name contains the fragment
node scripts/test-grade.mjs   # a single file
```

Some suites have a per-area alias in `package.json` (for example `npm run test:provenance`). The provenance audit suite hashes every file outside its own cache before and after a run to prove it never writes to a source ledger. The TeX compile path is exercised by hand and is skipped by the fixture suite where TeX is not installed.

The full CI matrix also runs the search-provider tests, the PaperMemory test suite, and a real DSH boot; see [`.github/workflows/verify.yml`](../.github/workflows/verify.yml).

The separate [DSH compatibility canary](../.github/workflows/dsh-compat.yml) runs against npm's `latest` and `next` channels with npm and pnpm on pushes, pull requests, and a daily schedule. It installs the packed plugin in a throwaway profile, grants an exact-version exemption **only in that profile** when `next` falls outside the declared engine range, boots DSH, creates an Academic Harness session, and writes a non-secret test setting through the local API. A fake loopback model checks that core tools are advertised, runs `research_template` and `list_agents`, starts a `subagent_pro` child, and confirms the native image tool is reachable without the old plugin-level denial (the file or model capability may still produce an ordinary tool error). Server startup alone is insufficient: a preset can fail only when a session mounts it. The check mutates settings, so run it only against an isolated profile. The pnpm lanes also get a channel-matched `@deepseek-ai/dsh-ptc-runtime` profile dependency, because pnpm omits that peer of `dsh-ptc-runtime-node` and DSH's workflow service would then stay pending (`workflow-ptc ... waiting for ptcRuntime`) and block preset sessions; npm resolves peers natively. All four lanes (`latest`/`next` × npm/pnpm) are required. The `next` job is complementary to the engines range: `latest` is the shipping target, `next` warns about upcoming changes while the engine range still adapts.

### `paper_fold` live integration

`paper_fold` also has a live integration test. It installs nothing and uses an existing TextFold:

```sh
python -m pip install 'textfold==0.10.31'
TEXTFOLD_SKIP_INSTALL=1 TEXTFOLD_PYTHON="$(command -v python)" node scripts/test-paper-fold-live.mjs
```

CI requires this test (`TEXTFOLD_LIVE_REQUIRED=1`) and runs the vendored PaperMemory suite with `pytest`, SciPy, Pillow, and defusedxml. It also runs the Academic Harness engine suite (`npm run test:ah-engine`, i.e. `PYTHONPATH=$PWD/vendor/academic-harness python3 -m pytest -q vendor/academic-harness/tests`); set `PYTHONPATH` so pytest imports the vendored `ah`, and the suite's `conftest.py` refuses to run against any other copy.

### Live end-to-end run (real host, scripted model)

`npm test` calls tools directly. The DSH host adds checks they never see; for example it rejects any tool result that is not lossless JSON, which an `undefined` property is enough to break (`experiment_log action=branches` shipped broken for this reason). `scripts/live-e2e/` runs the Phase 1-5 tools through a real, isolated DSH:

- `provider.mjs` is a loopback Anthropic-Messages endpoint that plays the fixed tool calls in `steps.mjs`. It is **not a model**: it says nothing about how a model would choose or phrase anything. It is stateless (its position is the number of its own tool results in the request).
- `start.sh` starts it plus a DSH with its own `DSH_HOME`, XDG directories, and a random port, so it never touches a DSH on :3080 or your PaperMemory store. `drive.mjs` opens a session and sends one prompt; `verify.mjs` asserts on the receipt; `stop.sh` stops only the two ports of that run, by exact PID.
- The step script calls the real `literature_search` (network).

Set up the profile on a real disk, not `/tmp` (a `tmpfs` with a per-user quota fills quickly): create `<dir>/home/profiles/e2e/package.json` with `@deepseek-ai/dsh`, `dsh-base` and `dsh-web-app` at one version plus `academic-harness` as `file:<tarball>`, and a `cordis.yml` containing `[]`. Install a **packed copy from a clean export** (`git archive HEAD | tar -x -C <src>`, then `npm pack` there), not a symlink to the working tree, whose `node_modules` may be older than the profile's. After repacking, delete the profile's `package-lock.json` or npm reuses the stale tarball.

Not covered by the scripted run: a real model's judgement and the approval prompts a model would raise. `real-model.mjs` drives the same isolated DSH with a **real** model (the key comes from your environment and is never read or printed; it spends credits) one turn at a time, and dumps every tool call and result from the session log. A model's `ask_user_question` blocks the turn until it is answered; the host rejected the RPC answer in testing, so answer it in the web UI (agent-browser works).

**Real-model run, 2026-11-08** (DeepSeek Flash, one session of four turns; one model, one scenario, with my own scripted approvals, so an observation and not a statistic):

- *Turn 1, no instruction to stop.* The model fetched the `research-cycle` template, inspected the workspace read-only, profiled the data, wrote notebook notes, asked two rounds of questions, and stopped at scope. It made no consequential call and declined to scaffold code. It guessed placeholder keys (`experiment_slug`) and was never told they matched nothing; `research_template` now says so.
- *Turn 2, one approved action.* Exactly one `analysis_run run` with the approved command. It then flagged, unprompted, that the "metrics" were literals hard-coded in the script.
- *Turns 3-4.* It delegated the picture to `subagent_vision`, which reported an empty 8x8 placeholder square, and passed that reading as `vision_review`. The handoff's own states were all consistent (hash current, run succeeded, caption numbers equal the metrics file): the report cannot tell that a figure shows nothing, and only the vision reading and the model's reasoning did. The model reconciled the two itself. Its first `prior_art` call declared abstracts but supplied no text, so the tool reported every quotation `not_checked`; the retry verified 5 of 5. Quotations are checked only against the text the caller supplies, so a caller that invents both text and quotation would pass. It also paraphrased `overlap_candidates` (five partial overlaps) as "no close overlap found"; the statement text now says outright that partial overlap is overlap.


## Documentation diagrams

The SVG diagrams in `docs/assets/diagrams/` are generated from the Mermaid sources in `docs/diagrams/` through Pele:

```sh
npm run docs:diagrams
```

The script writes flattened SVGs (Pele's `--pele-*` CSS variables replaced by their literal fallbacks) so Inkscape, `rsvg-convert`, and CairoSVG rasterize them correctly. Edit the `.mmd` source, not the `.svg`.

## Bundle patch

`cordis.patch.yml` is generated from `presets/academic-harness/agent.cordis.yml`:

```sh
npm run build:patch
```

CI runs `node scripts/build-cordis-patch.mjs --check` and fails if the generated patch is stale.

## Repository layout

| Path | Contents |
|---|---|
| `index.js` | Bundle-level `apply()`: every-preset tools and settings |
| `cordis.patch.yml` | Generated preset composition |
| `presets/academic-harness/` | Preset source |
| `prompt.js`, `prompt-section.js` | Research system prompt |
| `client/` | Settings page source; `lib/client.js` is the committed build |
| `skills/` | 790 bundled skills |
| `python-helpers/` | Python helpers for `sci_inspect`, `power_analysis`, `meta_analysis`, and `grant_budget` XLSX export |
| `vendor/academic-harness/` | Vendored writing engine |
| `vendor/papermemory/` | Vendored PaperMemory package |
| `docs/` | User guides, design notes, and diagram sources |
| `schemas/` | Example JSON contracts for extraction templates, analysis plans, run manifests, preregistration, and submission manifests |
| `scripts/` | Tests, patch build, docs diagrams |

See [Architecture](ARCHITECTURE.md#component-map) for the source-file map.

## Design notes

- [Academic Harness engine](ACADEMIC-HARNESS-ENGINE.md)
- [RSI](RSI.md)
- [ScientistTwo → Academic Harness roadmap](SCIENTISTTWO-ROADMAP.md)

### Vendored engines: wrapper or fork

`vendor/open-deepreview` is pinned by commit (`VENDOR_COMMIT` in `deep-review.js`), so where a new behaviour lives decides how much maintenance it costs.

- **Wrapper by default.** State the plugin needs to keep — review rounds, round digests, `compare`, staleness, token tallies — lives in `deep-review.js` and its store, not in the engine. The new review *criteria* (attribution, evaluator drift, benchmark coverage, unmeasured trade-offs) landed the same way: `action=validity` counts the manuscript itself — keyword hits over masked LaTeX prose and grids parsed out of LaTeX and Markdown bodies — and writes its own artifact (`extra_checks.json` plus a `meta.validity` summary), so re-pinning upstream cannot silently fork them. Its one optional model call is a critic that reuses the same session-route bridge as the engine and can only annotate: no new key, no new endpoint, no new Settings field, and no state it is allowed to change. The vocabularies and the thresholds are the plugin's own invention — the paper states the four criteria and no lexicon or cut-off — and the artifact says so.
- **Fork deliberately.** A change that belongs in the engine's prompts or heuristics means editing `vendor/open-deepreview`, re-pinning `VENDOR_COMMIT`, and updating `vendor/open-deepreview/SOURCE.txt` plus [NOTICE](../NOTICE). The CI boot test imports every module in the tree, so a stale pin or a broken vendor edit fails there rather than at first use.
- **One definition per concept.** Where two surfaces measure the same thing, they share code rather than reimplementing it: `matchPool` is exported from `deep-review.js` and used by `scripts/deep-review-calibration.mjs`, so the harness's finding-overlap number and `compare`'s persisting count cannot drift apart. The exception is deliberate: `validity` calls `runNumbersAudit` for its numeric half but counts grids with its own parser, because `numbers_audit`'s row counter is blind to a multi-column grid.

## License

MIT — see [LICENSE](../LICENSE). Scientific skills are vendored or adapted from several open-source catalogues; see [NOTICE](../NOTICE) for exactly what was copied, renamed, or adapted from each.
