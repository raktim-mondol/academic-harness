# Development

Every server-side file is plain ESM JavaScript — no build step. The Settings page (`client/`) is the exception: it is a browser bundle (React, esbuild) served to the DSH web client.

## Build the Settings page

```sh
npm install   # once, for esbuild
npm run build # after any client/ change — rebuilds lib/client.js
```

`lib/client.js` is committed so installing the plugin never needs a build step or `pnpm approve-builds` for this package itself.

## Tests

The tool tests are plain Node scripts and need no network (the Python-helper cases skip themselves when SciPy/Pillow are unavailable):

```sh
for t in citation-format review-store review-tool integrity registries \
         optional-tools audits grants manuscript-tools nonsearch-tools mermaid-render fold reply-fold paper-fold compute library power reference-library; do
  node scripts/test-$t.mjs
done
node scripts/test-compute-http.mjs
```

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
| `skills/` | 730 bundled skills |
| `python-helpers/` | Python helpers for `sci_inspect` |
| `vendor/academic-harness/` | Vendored writing engine |
| `vendor/papermemory/` | Vendored PaperMemory package |
| `docs/` | User guides, design notes, and diagram sources |
| `scripts/` | Tests, profile migration, patch build, docs diagrams |

See [Architecture](ARCHITECTURE.md#component-map) for the source-file map.

## Design notes

- [Academic Harness engine](ACADEMIC-HARNESS-ENGINE.md)
- [Co-Scientist integration](CO-SCIENTIST-INTEGRATION-PLAN.md)
- [Fold integration](FOLD-INTEGRATION-PLAN.md)
- [Non-search tools](NON-SEARCH-TOOLS-PLAN.md)
- [PaperMemory v2](PAPERMEMORY-V2-PLAN.md)
- [RSI](RSI.md)
- [Search providers](SEARCH-PROVIDERS-PLAN.md)
- [zvec-grep/PaperMemory alignment](ZG-PAPERMEMORY-ALIGNMENT-PLAN.md)

## License

MIT — see [LICENSE](../LICENSE). Scientific skills are vendored or adapted from several open-source catalogues; see [NOTICE](../NOTICE) for exactly what was copied, renamed, or adapted from each.
