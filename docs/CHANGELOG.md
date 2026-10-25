# Changelog

Release notes for Academic Harness. For releases before 0.18.0, see the [GitHub releases](https://github.com/raktim-mondol/academic-harness/releases).

## 0.25.3

- The seeder now refreshes first-party briefs that predate the current guidance (Modal SDK troubleshooting, Runpod REST v2, Vast.ai pitfalls), so existing installs receive skill updates without deleting the seeded directories. It still only replaces known-old content, leaving local edits to other skills untouched.
- `scripts/test-academic-harness.mjs` covers the stale-brief refresh.

## 0.25.2

- The `modal` skill now documents the managed SDK runtime (`$DSH_HOME/modal-sdk`), `ACADEMIC_HARNESS_MODAL_SKIP_INSTALL`, and the pnpm 11 `ERR_PNPM_IGNORED_BUILDS` workaround — including why `allowBuilds` belongs in the profile's `pnpm-workspace.yaml`, not in `academic-harness/package.json`.
- The system prompt routes a failed manual Modal install to that skill before profile config is edited, and prefers denying the two optional native builds over `pnpm approve-builds --all`.
- The docs index changelog range now tracks the current release.

## 0.25.1

- **Modal SDK install friction is gone.** `modal_run` now loads the SDK from the profile when present, otherwise installs a pinned `modal@0.11.1` into `$DSH_HOME/modal-sdk` on first use and uses it without restarting dsh. The managed install pre-configures pnpm's `allowBuilds` for its two optional native deps, and `seed.js` writes the same policy into every existing profile that depends on Academic Harness — so a manual `dsh plugin add modal` no longer fails with `ERR_PNPM_IGNORED_BUILDS` under pnpm 11. `ACADEMIC_HARNESS_MODAL_SKIP_INSTALL=1` keeps the manual-only path.

## 0.25.0

- **Vast.ai joins the remote-compute tools.** `vastai_run` searches live marketplace offers for a GPU class, rents the cheapest verified machine, uploads `files_in`, runs a command, copies `files_out` back, and destroys the instance. It supports spot bidding (`bid_price`), a pinned `offer_id`, multiple GPUs (`num_gpus`), an existing `volume_id`, and a price cap (`max_price_dph`). Its SSH key is registered per call and removed during teardown. New `vastai` skill, `VAST_API_KEY` in Settings, and [Compute](COMPUTE.md) coverage.
- **Runpod moved to REST API v2** (`https://api.runpod.io/v2`); v1 retires on 2026-11-15. The client now uses v2's nested `gpu`/`cpu` request, wrapped list responses, cursor pagination for network volumes, `dataCenter` on volume creation, and RFC 9457 errors. The `cpu` instance uses the v2 `cpu5c` flavor (the old `cpu3c-2-4` id is not a v2 value) and a valid `runpod/base` tag, and a pod mounting a network volume is now pinned to that volume's data center. Pod deletion is retried; a final failure returns `runpod_teardown_failed` with the pod id instead of silently dropping it.
- **`modal_run` reaches parity.** Pass `volume_name` to mount a persistent Modal Volume at `/workspace`; GPU instances default to a CUDA/PyTorch image instead of a CUDA-free `python` image; directories work in `files_in`/`files_out` via a tar fallback; the result includes `sandbox_id`; the optional SDK peer is now `^0.11.1`. Every provider now reports `*_teardown_failed` with the resource id if cleanup fails.
- **Fixed the duplicate `modal` skill name.** `skills/modal-usage` now declares `name: modal-usage`, so the vendored K-Dense guide and the first-party `modal` brief both load (730 skills, 730 distinct names). NOTICE records the rename and the bundle's Apache-2.0 header.
- **Transfer and teardown hardening.** Workspace paths are resolved through real paths and cannot name the workspace root or a symlink escape (`files_out: "."` previously replaced the whole workspace). Directory downloads extract to a temp dir and replace the old output only after both tar ends succeed; uploads require both ends too. `scp` downloads and stdout/stderr capture are bounded, transfers have timeouts, the main command is never retried after a dropped connection, and a create whose reply was lost is reconciled by the generated `dshrc-*` name/label. A failed teardown now preserves the run result alongside the error id.
- `scripts/test-compute.mjs` and `scripts/test-compute-http.mjs` (`npm run test:compute`) cover the instance catalogs, v2/Vast request payloads, all three tool registrations, workspace-path guards (root, traversal, symlink), transfer-failure atomicity, and the clients against a mock HTTP server.

## 0.24.0

- The single-file README is now a concise landing page, with the full reference split into modular guides under `docs/`: [Install](INSTALL.md), [Architecture](ARCHITECTURE.md), [Tool index](TOOLS.md), [Configuration](CONFIGURATION.md), [Search](SEARCH.md), [Papers](PAPERS.md), [Writing](WRITING.md), [Research](RESEARCH.md), [Workspace](WORKSPACE.md), [Compute](COMPUTE.md), [Agents](AGENTS.md), [Skills](SKILLS.md), [Optional tools](OPTIONAL-TOOLS.md), [Development](DEVELOPMENT.md), and this [Changelog](CHANGELOG.md). A [docs home](README.md) indexes them.
- 14 diagrams (architecture, capability map, request lifecycle, install flow, search routing, paper pipeline, writing loop, review ledger, tournament loop, workspace-vs-PaperMemory, subagent routing, compute flow, RSI loop, skills map) are authored as Mermaid in `docs/diagrams/` and rendered to flattened SVG with Pele via the new `npm run docs:diagrams`. `flattenColors` is now exported from `mermaid-render.js` for reuse.
- `sci_inspect` and `pdf_to_markdown` now point at the docs pages instead of the README; four tests read the docs pages rather than the old README headings.

## 0.23.0

- `fold_text` folds Markdown at five levels (Full, Brief, Points, Outline, Gist) with no model call, preserving the original words and leaving short texts whole. The Academic Harness preset now also asks for point-first replies in a separate, preset-scoped response-shape section, so a fold keeps the answer.
- A completed chat reply long enough to fold shows a **Read folded:** row in the turn tail; choosing a level opens a folded panel below the untouched original. The row uses the same shared fold engine, keeps the last level in the browser, and never calls a model. **Open in sidebar** opens the same reply in a larger right-dock pane with its own level controls.
- `paper_fold` adds map-first paper reading to the Academic Harness preset: a section map from the author's first sentences, then one section at a time, with no model call by default. TextFold is installed as a pinned optional Python runtime (`textfold==0.10.31`) under `$DSH_HOME/textfold`; `generate:true` asks TextFold's own provider for written levels. PaperMemory remains the evidence layer, and scanned PDFs stay on `pdf_to_markdown`/`subagent_vision`.
- Removed the bundled `paper2agent-paper` reference skill and its 5.7 MB figure/table assets. The `paper2agent`, `paper2skill`, and `paper2mcp` conversion skills are unchanged, and the package is about 5 MB smaller.

## 0.22.1

- `coscientist next` no longer samples a task the ledger cannot execute: at the hypothesis cap, reflection waits for a pending review and generation/evolution are off, instead of handing back a no-op the caller has to override.
- `coscientist_rank propose` completes the first ranking before repeating a pair: while any two active hypotheses have never met, a fresh pair plays first, then selection returns to uncertainty-first. The response reports `pair_matches_played` and `unplayed_pairs_remaining`.
- `coscientist start` accepts `max_matches`; `next` reports `match_cap_reached`, so an explicit user stop bound (for example, one match per active pair) is enforced by the ledger rather than the model's judgment.
- The `co-scientist-tournament` skill judges the two presentation orders sequentially with an identical brief, retries a failed orientation with that same brief, and tells the judge not to load skills or call tools. A child that still fails is recorded as `position_controlled: false` instead of substituting a differently worded run.

## 0.22.0

- Tournament Phase 4: `coscientist graph` (Mermaid lineage/similarity/support diagram, `export format: mermaid`), `coscientist priors` (cross-session feedback and withholdings, read from sibling ledgers), and opt-in `coscientist embed` (Gemini text embeddings that move the duplicate gate to cosine). `zvec-grep` cannot supply this — `zg query --vector` embeds a search query and never returns a vector — so embeddings go through the Gemini endpoint the plugin already uses for images.
- Tournament defaults **5 hypotheses / 36 steps**, sized against the termination rules: five is the smallest pool where a review veto plus a dual-use withholding still leaves three ideas competing, and 36 is where an Elo plateau can actually be reached. A fourth stop reason, `no_competitors`, ends a pool that can no longer field a match instead of burning the budget. `coscientist_verify` (optional) adds Crossref citation integrity with the claim-support ledger, `coscientist safety` exposes the dual-use gate, and `scripts/test-coscientist-routing.mjs` checks that a problem-shaped ask still routes to a hypothesis skill.
- `coscientist` + `coscientist_rank`: a persistent hypothesis tournament (Glicko-2 leaderboard, five-stage review, save-time duplicate gate, scheduling policy with step budget, dual-use withholding, Markdown/JSON export) over append-only logs in `<cwd>/.dsh/coscientist/<slug>/`, plus the `co-scientist-tournament` skill. Algorithms and role prompts ported from [`co-scientist`](https://github.com/raktim-mondol/co-scientist) (MIT); no new dependency. See [docs/CO-SCIENTIST-INTEGRATION-PLAN.md](CO-SCIENTIST-INTEGRATION-PLAN.md).
- `mermaid_render` — Mermaid text → SVG via [Pele](https://github.com/obsidianmd/pele) (npm dependency, MIT), in-process with no browser or mermaid-cli install; every Mermaid 12.1.0 diagram type. Written files get Pele's `--pele-*` CSS variables flattened to literal colors so Inkscape/rsvg/CairoSVG don't rasterize them blank.

## 0.21.0

- RSI architecture instrumentation: reached-action activation, injected-token cost, oracle manifests, lesson risk metadata, and explicit `rollback`.
- Seven-layer plugin-RSI mapping documented; versioned skills/global promotion/executable changes are explicitly deferred or out of scope.
- 96 RSI checks; corpus experiment over nine real documents (31/31 injected defects, 23/23 leave-one-project-out coverage, 56.7% routing accuracy, 0.53 held-out safety F1).
- System paper in [`paper/rsi-local/`](../paper/rsi-local/).

## 0.20.0

- Local recursive self-improvement (RSI) for all research tasks: automatic capture, diagnosis, lesson admission, injection, injected-versus-control tracking, and quarantine/retirement.
- `ah_rsi` in-session control surface and `academic-harness-rsi` offline CLI.
- Synthetic pipeline benchmark, replay benchmark over real captured episodes, and real `ah audit` snapshot baseline.
- Local-only store at `$DSH_HOME/ah-rsi`; `AH_RSI=off|observe|auto`; no author-approval step; no runtime edits to plugin, engine, project, or evaluator.
- New `ah-rsi` skill and [docs/RSI.md](RSI.md).

## 0.19.0

- `remove-ai-signs` skill vendored into the plugin (style editing for machine-sounding prose; no detector-evasion or provenance-removal claims) and steered from a new `## Writing quality` prompt section.
- `manuscript_citations` — manuscript ↔ `.bib` consistency for `.tex`/`.md`: missing, unused, and duplicate keys, undefined `\ref` targets, duplicate labels.
- `funder_policy` — OpenAlex funder identity plus Sherpa Juliet per-version OA policy (keyed half).

## 0.18.0

Academic tooling beyond search (see [docs/NON-SEARCH-TOOLS-PLAN.md](NON-SEARCH-TOOLS-PLAN.md)):

- `citation` — local APA/Vancouver/Harvard/IEEE/Chicago/MLA formatting, BibTeX/RIS export, DOI→BibTeX, and validation.
- `integrity_check` — retraction / expression-of-concern / correction status from Crossref + OpenAlex (never `clean` on a failed lookup).
- `review` — systematic/scoping-review ledger with protocol, screening, evidence, PRISMA-style counts, and exports (new `systematic-review-ledger` skill).
- `clinicaltrials` and `openfda` — trial records/posted results and regulatory adverse-event/recall/510(k) data.
- `dataset_search` and `journal_policy` — DataCite discovery with Zenodo/Figshare file listings, and DOAJ + Sherpa Romeo venue policy; new `ZENODO_API_KEY`, `FIGSHARE_API_KEY`, and `DATACITE_API_KEY` support.
- Optional (`AH_ENABLE_OPTIONAL_TOOLS=1`): `author_lookup` (ORCID/ROR), `openreview`, `pdf_references` (BYO GROBID), `stat_audit`, `figure_audit`, `repo_audit`, `grant_search` (NIH/NSF/Grants.gov), and `patent_search` (PatentsView).
- Europe PMC preprint routing: `pubmed_search preprints: true` and a `literature_search` `preprints` source (`SRC:PPR`).
