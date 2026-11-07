# Development

Every server-side file is plain ESM JavaScript — no build step. The Settings page (`client/`) is the exception: it is a browser bundle (React, esbuild) served to the DSH web client.

## Build the Settings page

```sh
npm install   # once, for esbuild
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

The separate [DSH compatibility canary](../.github/workflows/dsh-compat.yml) runs against npm's `latest` and `next` channels with npm and pnpm on pushes, pull requests, and a daily schedule. It installs the packed plugin in a throwaway profile, grants an exact-version exemption **only in that profile** when `next` falls outside the declared engine range, boots DSH, creates an Academic Harness session, and writes a non-secret test setting through the local API. A fake loopback model checks that core tools are advertised, runs `research_template` and `list_agents`, starts a `subagent_pro` child, and confirms the direct-image guard. Server startup alone is insufficient: a preset can fail only when a session mounts it. The check mutates settings, so run it only against an isolated profile. The pnpm lanes also get a channel-matched `@deepseek-ai/dsh-ptc-runtime` profile dependency, because pnpm omits that peer of `dsh-ptc-runtime-node` and DSH's workflow service would then stay pending (`workflow-ptc ... waiting for ptcRuntime`) and block preset sessions; npm resolves peers natively. All four lanes (`latest`/`next` × npm/pnpm) are required. The `next` job is complementary to the engines range: `latest` is the shipping target, `next` warns about upcoming changes while the engine range still adapts.

### `paper_fold` live integration

`paper_fold` also has a live integration test. It installs nothing and uses an existing TextFold:

```sh
python -m pip install 'textfold==0.10.31'
TEXTFOLD_SKIP_INSTALL=1 TEXTFOLD_PYTHON="$(command -v python)" node scripts/test-paper-fold-live.mjs
```

CI requires this test (`TEXTFOLD_LIVE_REQUIRED=1`) and runs the vendored PaperMemory suite with `pytest`, SciPy, Pillow, and defusedxml.

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
