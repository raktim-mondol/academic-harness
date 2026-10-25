# zg ↔ PaperMemory v2 alignment plan

Status: proposed (not implemented) · Date 2026-10-22 · Target release: plugin **v0.15.0**,
PaperMemory **v0.2.1**

## 1. Why

PaperMemory v2 (v0.14.x) is markdown-first, project-scoped and evidence-gated. zg
(`@zvec/zvec-grep`) is a separate semantic workspace index with its own daemon, store and
lifecycle; nothing in v2 breaks it. Three alignment gaps remain:

1. **Routing ambiguity.** Paper markdown now lives in the workspace, so zg indexes it too.
   A zg hit is a semantic snippet, not verbatim evidence; the prompt never forbids citing one.
2. **No index exclusions.** `zg index` supports `-g '!pattern'`, but the native `zvec_index`
   tool exposes only `action`/`root`. If `PAPERMEMORY_DB`/`PAPERMEMORY_DATA_DIR` live inside
   the workspace, zg would index the memory corpus and SQLite/WAL files.
3. **Project slug split (PaperMemory bug, not zg).** Auto-ingest still tags the
   workspace-directory slug (`projectSlugFromCwd`), while the agent queries the manuscript
   slug. v2's strict membership then yields `no-match-in-project`. The plan's SCP-6 expected
   the plugin to pass `cwd` and let Python resolve it; `scope.py` exists but is not wired.

No zg algorithm/index redesign is needed.

## 2. Goals / non-goals

**Goals**
- Agents never use zg output as citation evidence; paper evidence always comes from
  PaperMemory (`cite`, `quote_check`, `trace`, `get`).
- The agent can exclude paths from a zg index; PaperMemory runtime paths are excluded
  automatically when they sit under the index root.
- Auto-ingest resolves the project the same way the agent does (`cwd` → `ah.yaml` →
  manuscript `root_path` → `unassigned`), with an explicit override.
- Keep zg fail-soft (optional semantic search) while PaperMemory stays fail-loud; document
  the asymmetry.

**Non-goals**
- Changing zg embeddings, ranking, daemon transport, or index format.
- Re-tagging existing papers to new project keys (migration note below).
- Automatically detecting “this file is a paper” to reroute queries.
- Remote embeddings changes.

## 3. Workstream A — agent routing guidance (cheap, do first)

**Files**
- `prompt.js` → `## Workspace search` section.
- `skills/zvec-grep/SKILL.md` → new “Boundary with PaperMemory” section.
- `scripts/test-phase7.mjs` → golden markers.

**Change**
Add, in both places:

> zg is workspace context, not evidence. For claims, numbers, quotations, methods or
> citations about a paper, use PaperMemory (`papermemory_cite`, `papermemory_quote_check`,
> `papermemory_trace`, `papermemory_get`). If a zg hit points at a paper markdown file,
> open it in PaperMemory (`outline`, `get`) before using anything from it. A zg snippet is
> never a citable source and does not satisfy the verbatim-quote rule.

Also state that zg tools may be absent (fail-soft); their absence says nothing about
PaperMemory availability.

**Acceptance**
- `node scripts/test-phase7.mjs` checks the new prompt/skill markers.
- No behavioral code change.

## 4. Workstream B — zg index exclusions (code)

**Files**
- `zvec-index.js` — `zvec_index` parameters: add `exclude` (array of zg glob strings,
  `!` prefix) and document it; pass to `startIndex`.
- `zvec-index-engine.js` — `startIndex(opts)` and `createJob({…, globs})` accept globs;
  build args as `['index', '--embedding', embedding, ...globs.flatMap(g => ['-g', g])]`.
  Job key stays `root`; if a job is already running with different globs, join it (document
  in the tool description) — do not restart silently.
- New `zg-excludes.js` — pure helper `mergeExcludes(root, userExcludes, env)`:
  - Resolve the PaperMemory store from `PAPERMEMORY_DB`, else
    `PAPERMEMORY_DATA_DIR`, else `~/.local/share/papermemory/papermemory.db`.
  - Resolve `PAPERMEMORY_EVIDENCE_DIR` if set.
  - For each path inside `root`, add `!<rel>/corpus/**`, `!<rel>/*.db*`,
    `!<rel>/evidence/**` (dedup, POSIX separators, ignore paths outside root).
  - Merge with user excludes; cap at ~32.
- `scripts/test-zg-excludes.mjs` — unit tests for the helper (store outside root → no
  auto-excludes; inside root → expected globs; user excludes preserved/deduped).

**Acceptance**
- Unit script passes; golden surface checks `zvec_index` advertises `exclude`.
- Manual: `zvec_index action=start exclude=["!tmp/**"]` and confirm the exclusion reaches
  `zg index` argv (debug log).
- Running daemon for the same root is reused (no duplicate jobs).

**Risks / rollback**
- Over-broad globs can hide wanted files; only PaperMemory runtime paths are auto-added.
- Rollback: revert `zvec-index*.js` and remove the helper; no index format change.

## 5. Workstream C — canonical project resolution for auto-ingest (PaperMemory + plugin)

**Upstream PaperMemory (v0.2.1)**
- `papermemory/cli.py` — `ingest` gains `--cwd PATH`.
  Resolution before `ingest_path`:
  ```python
  from papermemory.scope import canonical_project_slug
  project = args.project or (
      canonical_project_slug(Path(args.cwd), store=store) if args.cwd else None
  )
  ```
  `canonical_project_slug` precedence (already implemented): explicit project →
  `ah.yaml` ancestor → `manuscripts.root_path == cwd` → `unassigned`. Explicit values are
  slugified.
- `mcp_server.py` — `papermemory_ingest` accepts `cwd`; resolve the same way with the open
  store before ingest.
- Tests `tests/test_scope_wiring.py`:
  - cwd inside an `ah.yaml` root → membership under the directory slug;
  - cwd equal to a `manuscripts.root_path` → manuscript slug;
  - explicit `--project "My Paper"` → `my-paper`, wins over cwd;
  - unknown cwd → `unassigned` membership;
  - MCP ingest with `cwd` matches CLI behavior;
  - existing default (no project, no cwd) remains unscoped/no membership.

**Plugin**
- `papermemory-cli.js` — `ingestDownloadedPaper` and `ingestConvertedMarkdown` accept
  `cwd`; pass `--cwd <cwd>`; pass `--project` only when `PAPERMEMORY_PROJECT` is set.
  Keep `projectSlugFromCwd` exported but mark deprecated for writes.
- `paper-download.js` / `pdf-to-markdown.js` — pass `cwd` from `workspaceRoot(exec)` instead
  of `projectSlugFromCwd(cwd)`; keep `PAPERMEMORY_PROJECT` override.
- `README.md` — document precedence and the `PAPERMEMORY_PROJECT` escape hatch.
- Golden test: assert `--cwd` in `papermemory-cli.js` and both call sites; prompt may note
  scoped ingests use the manuscript project.

**Migration note**
Existing papers keep their old (cwd-derived) project keys. New ingests may land under a
manuscript/ah slug, so a project can temporarily split. Mitigations documented in README:
set `PAPERMEMORY_PROJECT` to the existing key, or re-ingest; a `project rekey` command is
out of scope.

**Risks / rollback**
- Behavior change for explicit `--project` (slugified). Document; it already matches
  `scope.py`.
- Rollback: stop passing `--cwd`; old JS fallback remains.

## 6. Workstream D — operational notes (docs only)

- PaperMemory: fail-loud startup, 14 tools, tool-count drift.
- zg: fail-soft; missing tools ≠ missing memory; progress lives on the same Settings Config.
- Keep `PAPERMEMORY_DB` outside the indexed workspace when possible; exclusions cover the
  accidental case.
- Paper markdown in the workspace: indexed by zg for discovery, used by PaperMemory for
  evidence. Do not delete paper files after ingest (the corpus copy is separate).

## 7. Verification plan

1. `python -m pytest -q` in `/home/raktim/papermemory` (expect 83 + new scope-wiring tests).
2. `node scripts/test-phase7.mjs` (golden surface + prompt/skill markers + `--cwd`).
3. `node scripts/test-zg-excludes.mjs` (new).
4. Re-run the 100+ paper scale test (`scripts/scale-test-papermemory.py`) against the
   scratch corpus to confirm no regressions in retrieval/claims/recap.
5. Manual zg check on this repo: start an index with `exclude`, confirm auto-exclusions when
   `PAPERMEMORY_DB` points inside the repo, then drop the index.
6. `node scripts/build-cordis-patch.mjs --check`, `npm run build` + `git diff --exit-code -- lib/`.

## 8. Release steps

1. Upstream PaperMemory: commit (`--cwd` resolution + tests), bump to **0.2.1**, tag
   `v0.2.1`, push `main` + tag.
2. Plugin: re-vendor PaperMemory 0.2.1, update `SOURCE.txt` pin, bump `BUNDLE_REV` dsh15,
   reinstall venv, bump `package.json` to **0.15.0**.
3. Commit plugin changes (zg exclusions, guidance, slug wiring, docs, tests),
   tag `v0.15.0`, push `main` + tag.
4. CI must pass (PaperMemory tests, golden surface, boot probe).

## 9. Task checklist

- [ ] A1 prompt routing rule + zg skill boundary
- [ ] A2 golden-test markers
- [ ] B1 `zg-excludes.js` helper + tests
- [ ] B2 `zvec_index exclude` parameter → `createJob` globs
- [ ] B3 tool description/docs; manual argv check
- [ ] C1 upstream CLI/MCP `cwd` + scope tests
- [ ] C2 JS forwarding (`--cwd`, drop cwd-slug writes)
- [ ] C3 README precedence + migration note
- [ ] D1 docs: fail-soft/fail-loud asymmetry
- [ ] V1 full pytest + golden + excl tests
- [ ] V2 100+ paper scale rerun
- [ ] R1 release PaperMemory 0.2.1, plugin 0.15.0, tags pushed
