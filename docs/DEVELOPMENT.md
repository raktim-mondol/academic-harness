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
| `skills/` | 766 bundled skills |
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

## License

MIT — see [LICENSE](../LICENSE). Scientific skills are vendored or adapted from several open-source catalogues; see [NOTICE](../NOTICE) for exactly what was copied, renamed, or adapted from each.
