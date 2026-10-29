# Changelog

Release notes for Academic Harness. For releases before 0.18.0, see the [GitHub releases](https://github.com/raktim-mondol/academic-harness/releases).

## 0.27.3

- **A project-bound collection keeps its project scope on every export.** Passing an explicit `out` used to drop the collection's project, so re-checking a correct project `.bib` after a key rekey could report `out_of_date` or expect the wrong key. The collection's project is now inferred whenever a collection is named, for every format and destination; the default `.bib` destination remains BibTeX/BibLaTeX-only. An explicit `project` still overrides, and a collection with no project still exports canonical keys.
- **Prompt, skill, and tool description agree.** The reference-library rules now state the project-scope behavior; the `papermemory` skill also corrects `resolve` (`project_keys` is reported only with `project_keys: true`). The seeder refreshes existing 0.27.1 briefs that predate the rule.
- **Regression coverage and a managed-install refresh.** `test_library_export.py::test_a_collections_project_scope_survives_an_explicit_out` and `scripts/test-reference-library.mjs` cover the explicit-`out` case after a rekey. `BUNDLE_REV` is now `dsh17`, so the vendored PaperMemory is reinstalled on the next DSH start.

## 0.27.2

- **Fixed turns failing with `format v4 message requires a producer-owned source kind`.** The hooks tagged the messages they inject (the RSI lesson block, the Academic Harness state card, the stop-gate hand-off) with the retired `{ kind: 'plugin', plugin }` wrapper, which DSH 0.2.1-rc.2's session format refuses. The turn that carried an injected message failed outright; a session with no lesson selected and no Academic Harness project never noticed. They now use the producer-owned kinds `plugin:academic-harness-ah` and `plugin:academic-harness-rsi`. Found by driving a real DSH web session through a browser: the third prompt of a session failed the moment a lesson was injected.
- `scripts/test-phase7.mjs` now fails if either hook file goes back to the retired wrapper.

## 0.27.1

- **The reference library is now a native tool, `reference_library`, so nothing has to be told where the workspace is.** An MCP server is a single process with one fixed working directory, but every DSH session has its own workspace, and the host freezes tool arguments, so a hook cannot supply it either. The MCP version needed the model to pass `cwd` on every import, export, and doctor call. The native tool receives the session, resolves paths against its workspace, and refuses any path that leaves it (symlinks included). It runs the same `papermemory library` code as before.
- The plugin hides the MCP copy (`PAPERMEMORY_HIDE_TOOLS=papermemory_library`, honoured by the PaperMemory server and its `tools` command) so the model sees one library tool, not two. The start-up check now expects 14 MCP tools. Standalone PaperMemory, Grok, and any other host still get the 15th as `papermemory_library`.
- Prompt, `papermemory` skill, docs, and the seeder rule updated (existing installs get the refreshed skill). `scripts/test-reference-library.mjs` covers argument translation for every action, workspace confinement, inline imports, and an end-to-end run against the vendored PaperMemory.

## 0.27.0

- **New `power_analysis` tool** for planning a study before data exist: sample size, power, smallest detectable effect, or alpha (`power`, `sensitivity`); effect-size conversion and computation (`effect_size`); Bonferroni, Holm, Hochberg, Benjamini–Hochberg, and Benjamini–Yekutieli adjustment and per-test alpha planning (`correct`); seeded Monte-Carlo power (`simulate`); and sample size for sensitivity/specificity precision (`diagnostic_precision`). Covers t, proportion, ANOVA, chi-square, correlation, regression, log-rank, equivalence (TOST), and non-inferiority designs.
- **Integrity rules built in.** An assumed effect size needs `effect_source` (pilot, literature with a `source_ref`, smallest effect of interest, or convention); a convention is labelled as one. Post-hoc power from the study's own observed effect is refused. The unrounded and rounded n are both reported, dropout and clustering inflate the enrolment target separately, and every result echoes its assumptions and method.
- Runs on NumPy and SciPy through `python-helpers/power_helper.py`; no new dependency (`statsmodels` is not used). Preset-only, no key, no network.
- New `power-and-sample-size` skill (731 skills). `scripts/test-power.mjs` (`npm run test:power`) checks closed-form results against published values, that every solve mode inverts the others, the refusal rules, reproducible simulation, and registration.

## 0.26.0

- **PaperMemory is now the reference manager.** The vendored PaperMemory moves to 0.3.0 (schema 2100) and adds a reference library: lossless records, unique stable citation keys, tags, collections, notes, import of BibTeX/BibLaTeX/RIS/CSL-JSON, export to BibTeX/BibLaTeX/RIS/CSL-JSON/JSON/CSV, a managed project `.bib` that never overwrites hand edits, duplicate detection, a field-level merge preview, and a library `doctor`. It is one new tool, `mcp__papermemory__papermemory_library`, so PaperMemory exposes **15 tools** (the start-up drift check now expects 15). Nothing was added for Zotero; PaperMemory replaces the need for it.
- **Existing stores migrate on first start.** A schema-2000 store is backed up (`backups/` next to the database) and migrated to 2100 automatically. If another process still holds the database the migration is refused with a clear message and the store is left untouched. `papermemory backup` now also works on a store that still needs migrating.
- **Harness tools use the library.** `citation` takes `library: { cited_only | project | collection | query | all }` as a record source and keeps the library's own keys; `manuscript_citations` takes `library: true` (and `project`) and reports cited keys missing from the library, keys cited under another library key, and a project's entries never cited; `literature_search` marks results already stored (`in_library`) and says nothing when the library cannot be reached; `integrity_check` takes `library` (a bounded sweep of library DOIs, recording each result on the paper; unknown and malformed-DOI results are recorded as unknown, never ok) and `record_in_library` for a single DOI.
- New papers get a library record at ingest, and a key as soon as there is enough metadata to build a good one; export assigns the rest (a `--check` never writes).
- The `papermemory` skill documents the library and is refreshed on existing installs. `scripts/test-library.mjs` (`npm run test:library`) covers the CLI bridge, the `citation` library source (including that both BibTeX writers agree), `manuscript_citations`, integrity sweeps, `literature_search`, and the first-run migration; `scripts/test-phase7.mjs` now tests the vendored package rather than whichever copy is installed.

## 0.25.4

- Fixed `paper_fold` failing preset validation on current DSH/Cordis: the plugin registered through `ctx.tools` without `export const inject = ['tools']`, so every new session failed with `agent-preset/invalid: paper-fold ... cannot get property "tools" without inject`. New sessions and `paper_fold` work again after restart.
- `paper_fold` tests still pass (85 checks).

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
