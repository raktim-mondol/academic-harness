# Codebase review: academic-harness 0.50.0

Reviewed and verification completed 2026-11-10 at `32ab58f` (release 0.50.0, `main`). No source file was changed; only this report was updated. Live integration used an isolated DSH 0.2.2-rc.1 with the plugin's pinned 0.2.1-rc.5 tool/MCP packages; CI installs host 0.2.1-rc.5. See §9 for reproduction results, corrections, and remaining validation boundaries.

How to read the status column. **ran—host** means observed through the real isolated DSH; **ran—local** means a real module was exercised with local fixtures or substituted dependencies, not a live provider; **read** means static inspection only. A local contract double does not prove an external service's current behavior. These ad hoc reproductions are not committed regression tests. In particular, A1's original fresh-session execution claim was **not reproduced** and has been narrowed below.

## 1. Summary

The plugin is carefully built in most places: stores are append-only and locked, the client renders reply text without any HTML injection path, the Python helpers have no shell, network or pickle use, the live end-to-end scripts refuse port 3080 and kill by PID, and the NOTICE file is unusually thorough. The problems cluster in three areas:

1. **Trust and approval.** Analysis and repository-test execution bypass approval, and unconfigured compute tools reach their execute handlers without approval. Explicit MCP registration also runs a workspace command without asking. The earlier claim that merely creating a fresh session runs its registry was not reproduced on the tested host.
2. **Two feedback loops that quietly mis-score.** The writing gate resets itself mid-turn, which also blanks the learning loop's gate signal; the experimental-feedback reward misreads negated results.
3. **Licensing and weight.** Four proprietary skills and one more non-commercial skill ship inside an MIT package, and the session carries roughly 160k tokens of plugin material before the user types.

Test state after verification: Node suite **103/103 test files passed** (the optional live TextFold test self-skipped because TextFold is absent); vendored engine pytest **506 passed** (57.46 s on rerun); vendored PaperMemory pytest **233 passed**. The client bundle and source map rebuild byte-for-byte, and the generated cordis patch passes `--check`. All suites used scratch homes/state; pytest explicitly selected the vendored imports and a scratch PaperMemory DB. No paid compute, real image generation, publication, or dataset upload was performed; the user's DSH on :3080 and PaperMemory store were not used.

## 2. Top priorities

| # | Item | Why first | Status |
|---|------|-----------|--------|
| 1 | A2 No approval prompt on spend/exec tools | Real analysis and repository-test commands execute without an approval request | ran—host; compute checked only without keys |
| 2 | B1/B2 Writing gate resets; learning loop loses the gate signal | A handoff becomes a clean-looking terminal state while the defect remains | ran—host + local |
| 3 | C1 Four restricted Anthropic skills ship in an MIT-licensed package | Included licence text forbids redistribution; maintainer/legal review required | licence text read; clean package inclusion measured |
| 4 | A3 `repo_audit run_tests` inherits host environment | An invented secret canary reached the repository's test process | ran—local; same tool also exercised in host |
| 5 | A1 MCP trust/environment boundary | Explicit register executes without approval; automatic fresh-session mount remains unconfirmed | mixed: host registration confirmed; startup not reproduced |
| 6 | B3 Learning loop treats subagent task prompts as user speech | A short delegated prompt can become a user-scoped active preference | ran—local listener harness |
| 7 | A4/A5 Image-build injection; download network/size/timeout gaps | Unescaped build instructions and real local redirect/limit reproductions | ran—local; no cloud build |
| 8 | A6 `analysis_run` blocks the process inside a lock | A 20 ms heartbeat was delayed to about 330 ms by a 300 ms child | ran—local; stale lock simulated |
| 9 | B4 Zenodo upload uses the wrong request shape | Public API contract mismatch, rejected by a strict local double | ran—local + official docs; not sandbox |
| 10 | B6 Reward scorer reads "did not improve… no significant effect" as neutral | Wrong-signed rating updates | ran |

## 3. Findings

### A. Execution, credentials and trust

**A1. `paper_mcp` workspace trust boundary; startup claim narrowed** — `paper-mcp.js:192-221`, `:112-119`, `:121-158` — **High if automatic mounting is reachable; explicit registration confirmed**

The registered `session/created` listener loads `<cwd>/.dsh/paper-mcps.json` and requests mounts for its entries without an approval check. Whether the preset-scoped listener sees its own session's creation is a separate lifecycle question. The existence checks (`:348-357`) are only in `register`, not this listener. `envFor` resolves arbitrary `envNames` through `resolveEnv` (host environment, then stored supported keys).

Original local probe: directly invoking that listener requested a mount of `/bin/sh`, args `["run.sh"]`, workspace cwd, and a named invented environment canary, even when the script did not exist. This proves the listener's behavior, not its reachability in the real host.

Real-host correction: creating a fresh session with a prewritten registry did **not** create the script's canary file. A subsequent `paper_mcp status` reported `not-mounted`. Therefore this report no longer claims that simply opening a folder executes the registry on DSH 0.2.2-rc.1. Other host versions, restore paths, and lifecycle arrangements remain unverified.

Separately, a scripted `paper_mcp register` in the same host executed the harmless workspace shell script without an approval request. It received both the explicitly named canary and an unnamed, **non-credential-shaped** parent-environment canary. The pinned MCP client's `buildChildEnv` merges `scrubbedParentEnv()` with explicit env: `envNames` is not the entire child environment. Credential-shaped parent variables are meant to be scrubbed; this probe does **not** establish leakage of unnamed API keys. Explicitly requested host secrets can still be reintroduced by `envFor`. See A2 for the confirmed missing approval boundary.

Fix:
- Require a one-time per-workspace confirmation, recorded under `$DSH_HOME` (not in the workspace), keyed by a hash of the entry.
- Restrict `envNames` to approved names, and make the inherited-versus-explicit environment contract clear; test credential scrubbing separately.
- Check that `command` and server entry exist before mounting.
- Return `ask` from `tools/pre-execute` for `paper_mcp register`.

**A2. No approval prompt for tools that spend money or run code** — `academic-harness-hooks.js:213-218`; pinned tool-pipeline default `@deepseek-ai/dsh-tools/lib/index.js:3321` — **High, ran—host (bounded scope below)**

The host's `tools/pre-execute` defaults to allow. The plugin's only `kind: 'ask'` is for `ah_author`. In the isolated host, the scripted provider froze an analysis plan, ran a Node file-writing canary, and ran a fixture repository's `npm test`. All succeeded without an approval request. `modal_run`, `runpod_run`, and `vastai_run` reached their `not_configured` results without asking; no credentials or real provisioning were used. The next `ah_author` call paused with `pendingInput: ["approval"]`, and the session log's **only** `approval/asked` named `ah_author`. This positive control rules out a missing approval service. A separate real-host `paper_mcp register` also executed the workspace canary without asking.

Static extension, **not individually exercised live**: `paper_download`, `deidentify`, `latex_compile`, `paper_backfill` with `dry_run: false`, migration, and Zenodo deposit have no matching plugin approval listener. Model-supplied `confirm: true` is not a human approval event. Do not confuse the host's `approval: ask` policy with a blanket prompt for all tools: it handles actions that actually request approval.

Fix: one `tools/pre-execute` listener that returns `ask` for a named list, with the cost estimate or command in the reason. Add a test with a fake host that proves the listener answers `ask`.

**A3. `repo_audit run_tests` runs repository tests with the host environment** — `repo-audit.js:616` (clone), `:651` (`spawnSync` with no `env`) — **High, ran—local and host**

Any `https://` URL is cloned, then its detected test command runs with the inherited environment, so every API key in the DSH process is visible to that repository's code. `analysis_run` already builds an allowlisted environment (`analysis-store.js:220-232`).

Reproduction: a fixture `package.json` test printed an invented `AH_REVIEW_FAKE_SECRET` supplied only to the parent process. `runRepoAudit({path, run_tests: true})` returned it in `stdout_tail` and exited 0. The isolated host also ran fixture tests and wrote their canary file. No external repository was cloned and no real key was used; the shared execution path is confirmed, not an exploit against a remote repository.

Fix: reuse that `baseEnv`; run async with a kill; add the approval from A2.

**A4. `modal_run` interpolates package names into a Dockerfile** — `modal-run.js:212`, `:215` — **Medium, ran—local SDK double**

`image_apt` and `image_pip` are joined unquoted into `RUN` lines. Every remote path elsewhere in the file goes through `shellQuote`, so this is the odd one out. Validate each entry against a strict package-name pattern.

The real tool passed an apt entry containing a newline plus `RUN`, and a pip entry containing `; printf ... #`, unchanged to a fake SDK's `dockerfileCommands`. The fake refused sandbox creation, so no image was built and nothing was billed. This is injection into the image-build instructions, not proof of execution on the local host; the tool already intentionally permits a separate remote shell `command`.

**A5. Downloads lack consistent network, body-timeout and aggregate-size guards** — `dataset-get.js:82-115`, `:156-170`; `publisher-tdm.js:25-36`; `image-gen-client.js:112-114` — **Medium, ran—local**

A dataset link can redirect to a local or private address. Reuse the guard at `paper-download.js:56`. The same gap exists at `publisher-tdm.js:25-27` (`redirect: 'follow'`) and `image-gen-client.js:112` (provider URL fetched with no host guard or size cap). There are three separate public-host guards (`paper-download.js:56/95`, `citation.js:109`, `paper-artifacts.js:190`) and several call sites without one.

Verification:
- The real dataset fetcher followed a loopback HTTP redirect and read the target canary. This tests redirects/local-address acceptance, not a live public-origin redirect or DNS rebinding.
- A fake image API response naming a loopback URL caused the real image client to fetch its bytes. No image was generated. A substituted Wiley endpoint also accepted a real local redirect to a PDF canary; no publisher service was contacted.
- **New:** `defaultFetchBinary` clears its timeout after response headers, before the returned body is consumed. A 25 ms timeout allowed a delayed body to finish after about 180 ms. Keep the deadline active through the body stream.
- **New:** with no `Content-Length`, two 4-byte files were both written under a 5-byte `maxTotalBytes` limit (8 bytes total). The pre-read total check uses only the declared length; enforce the remaining total budget while reading actual bytes.

**A6. `analysis_run` freezes the process inside a lock** — `analysis-store.js:506` (`withLock`), `:527` (`spawnSync`, up to 60 min); `store-lock.js:15` (`STALE_MS = 60_000`) — **Medium, ran—local**

`spawnSync` blocks the Node event loop for the whole run, so nothing else in the plugin (or the host) is served meanwhile, and a second process may take the lock after 60 s. Spawn asynchronously and hold the lock only while writing the run record. The host job service (`job_output`, `job_list`, `job_kill`) is the natural home.

A 300 ms fixture child delayed a scheduled 20 ms heartbeat to about 330 ms in the real `runAnalysis` (327–331 ms across repeated probes). Separately, making an actively held lock's mtime stale allowed a second `withLock` callback to enter while its owner remained active. The stale timestamp was deliberately simulated; a 60-minute run and a real 60-second cross-process overlap were not performed.

**A7. Paid-compute clients: no timeout, no abort, uneven price caps** — `vastai-client.js:19`, `runpod-client.js:18`; `vastai-run.js:186-187` — **Medium, ran—local request capture; price behavior read**

Both `request()` functions call `fetch` with no timeout and no `signal` parameter, so undici's default is the only bound and a user cancel cannot interrupt them, including the teardown call that stops billing. Give each request its own timeout, pass the tool's signal to provisioning calls, and keep teardown on its own timer so a cancel cannot abort it. Separately, only Vast.ai has a price cap, and a pinned `offer_id` bypasses it (`dph_total: null`); Modal and Runpod have none.

A substituted `fetch` captured Runpod create/delete and Vast.ai create/destroy: all four requests had no `signal`. No provider was contacted. Actual cancellation during provisioning, teardown after disconnect, and the pinned-offer budget case remain live-provider validation items, not measured billing outcomes.

**A8. SSH host-key checking is off** — `ssh-client.js:92-94` (`StrictHostKeyChecking=no`, known-hosts to `/dev/null`) — **Low, read**

Reasonable for throwaway rented machines, but state it in the tool description, and prefer trust-on-first-use inside one run.

**A9. Secrets in URLs** — `mcp-connectors.js:53` and `papermemory-backfill.js:195` put the Firecrawl key in the URL path; `papermemory-backfill.js:153` and `:224-227` add `api_key` as a query parameter — **Low, read**

`search-http.js` redacts query strings in its own logs (`safeUrl`), but the MCP endpoint above and any third-party log do not. Prefer an `Authorization` header where the service allows it.

### B. Correctness

**B1. The writing gate resets its own state mid-turn** — `academic-harness-hooks.js:187-210`, `:127`, `:290`; engine `hooks.py:194-208` — **High, ran—host and local**

The host calls `preStep` every step. `messages` is the inbox claim, so the gate's own `steer()` message and post-edit context messages make `messages.length` non-zero. The listener treats any non-empty inbox as a new user prompt: it clears `handedOff` and `t3Steered` (`:191-192`) and runs `ah hook userprompt` again. After a handoff the engine's `userprompt` sees a settled turn and re-baselines, so the blockers the model just introduced count as pre-existing and the loop counter restarts, all within one turn. The `alreadyHandedOff`/`alreadyT3` branches of `gateDecision` never apply, and the final stop emits `none`.

Confirmed in the real host: a scripted `bash` edit introduced an unresolved `\ref`, then the provider returned final text on each retry. One host turn produced **`continue → continue → continue → handoff → none`**. At completion the engine state had `loops: 0`, `settled: false`, `touched: []`; a fresh `ah check` still reported `TEX-02`, and the canary reference remained in the source. No human reply or new turn intervened. Nuance: the Python engine preserves the baseline during the three retries; the destructive reset is **after handoff**, not on every plugin message. The earlier listener harness also reproduced this; a counterfactual inbox filter preserved the handoff without editing source.

Fix: reset only when the host turn number changes (as `rsi-hooks.js:262-291` does), or when a message has `source.kind === 'user'`. Add a fake-host test; only the pure `gateDecision` is covered today (`scripts/test-academic-harness.mjs:231-241`).

**B2. The learning loop keeps only the last gate event** — `rsi-hooks.js:248`; `rsi-core.js:613-614`, `:632`, `:638`, `:650-651` — **High, ran—host event sequence and local listener harness**

The `none` event emitted at the final stop sets `currentTurn.gate = null`, erasing an earlier `handoff` or `continue`. The associated gate penalties are then absent. The real-host sequence in B1 contains exactly this terminal `none`. Independently, driving the real RSI listener with a substantive tool result and `continue → handoff → none` wrote an episode with `gate: null`, quality **1.0**; omitting only the terminal `none` preserved `handoff` and quality **0.8**. Keep gate-attempt/handoff history separately from a genuinely resolved final state; do not treat unobserved/empty as proof of resolution.

**B3. Subagent task prompts count as user speech** — `rsi-hooks.js:293-320`; host `@deepseek-ai/dsh-subagent/lib/index.js:1466-1467` — **Medium, ran—local listener harness**

The host stamps a delegated prompt `source: { kind: 'user' }`. `rsi-hooks.js` runs preference extraction, forget detection and correction detection on it with no agent-kind check (`agentKind` exists at `:52-54` but only labels). A preference becomes `scope: 'user'`, `status: 'active'`, `inject_probability: 1` (`recordExplicitPreference`, `rsi-core.js:1130`), i.e. global across projects. A host-appended guidance text happens to trip the 500-character cap on preferences, but forget and correction have no cap. Fix: skip subagent sessions.

The real listener was driven with `depth: 1`, `origin: 'subagent'`, a parent agent, and a short `source.kind: 'user'` delegated preference. It wrote a user-scoped, active, explicit lesson. This confirms the missing origin guard for that shape; it is not a claim that every real delegated prompt bypasses the host's appended-text/length constraint. A full live delegation was not run.

**B4. Zenodo upload does not match the documented request contract** — `repro-package-store.js:673-677` — **Medium, ran—local contract double; official docs checked**

It POSTs a raw `application/octet-stream` body to `…/deposit/depositions/{id}/files?name=`. [Zenodo's official developer documentation](https://developers.zenodo.org/), checked directly during this verification, specifies `multipart/form-data` with `name` and `file` for that legacy endpoint; raw file bodies use `PUT` to the deposition's `links.bucket` plus the filename. A minimal locally built package made the real deposit function send the raw POST, which a strict local contract double rejected with HTTP 400. The shipped fake in `scripts/test-repro-package.mjs:177` accepts any upload and misses this. Files are also read fully into memory. **No live or sandbox deposition was created:** the contract mismatch is verified; a real service response and successful replacement upload remain unverified.

**B5. The evidence check runs once per session** — `hooks.py:341-342` (`t3_done` set, never cleared) — **Low, ran—local engine seam**

The advisory T3 check is documented per turn nowhere; either clear it per turn or document it.

Two `userprompt → stop` cycles in the real `handle()` with a local state fixture and substituted evidence verifier called that verifier once, returned the first advisory, and skipped the second while retaining `t3_done: true`. No reasoning model was called. This establishes cadence, not whether once-per-session was intended product behavior.

**B6. The experimental-feedback reward misreads negation** — `coscientist-models.js:723-751`; used at `coscientist-store.js:1778` — **Medium, ran**

`feedbackSentiment` counts positive and negative keywords. Results I measured:

| Text | Score |
|------|-------|
| "The treatment did not improve survival; no significant effect was observed." | 0.00 (neutral) |
| "It does not fail under load." | -1.00 |
| "Replication failed. The effect was not significant and the method does not work." | -0.50 |

Run through `extractRewardFromFeedback` and `applyFeedbackAsGlicko2Match` from a fresh hypothesis (rating 1200) with scores 5/5/5: "Replication failed. No significant effect was observed." gives reward -0.433, a recorded loss, and the rating falls to 1025. "The treatment did not improve survival; no significant effect was observed." gives reward -0.300, a recorded draw, and the rating stays at 1200. Two phrasings of the same negative finding differ by 175 rating points. When no scores are given, the keyword count is the whole reward. The ledger records `sentiment` and `reward`, so it is auditable, but the sign can be wrong. Fix: ask the caller for an explicit outcome (`supports` / `refutes` / `inconclusive`) and use keywords only as a fallback with a warning.

**B7. Guard failure is server-logged but not made visible to the model/user** — `academic-harness-hooks.js:159-162`, `:238-241`; `rsi-core.js:916-926` — **Low, ran—local for pre-hook; remote-judge fallback read**

`runHook` returns nothing on exit codes other than 0 or 1, a failing pre-hook is only logged, a missing engine only warns, and the lesson-admission path retains a candidate when `remoteJudge` yields no verdict. A fake engine that consumed its stdin then exited 2 caused the real pre-execute listener to allow a would-be protected write; the warning existed only in the server log, with no model warning context. The fake host did not actually write the protected file. Remote-judge outage/admission remains a static observation. Surface a one-line session warning so an inactive guard is visible.

**B8. Smaller correctness items — read unless stated otherwise**
- `makeRand(null)` and `makeRand('')` seed 0 (`coscientist-models.js:290-293`), confirmed by direct calls; no callers were found, so no live effect was identified.
- `papermemory-library.js:80-81`, `:130` and `papermemory-cli.js:453` (`quoteCheck`) append model-supplied tokens to the CLI without `--`, so a token starting with `-` is read as a flag.
- `papermemory-dream.js:109-125` awaits the dream pass inside `agent/disposed` (up to 30 s, hourly), although its header says it runs off the model's attention; default mode is `apply`, which changes note statuses in the shared store (reversible with `--restore`).
- `subagent-models.js:241-251` accepts `http:` endpoints for the key-bearing custom route; warn on non-HTTPS non-localhost.
- `subagent-models.js:385-395` always registers `subagent_pro` and `subagent_vision`, adding two tool definitions even when no custom route exists.
- `subagent-models.js:115-130` writes 600-character prompt and answer excerpts into the workspace notebook automatically.
- `subagent-models.js:95-100` hard-codes the preset id instead of `isPluginPreset`.
- `vastai-run.js:212` reuses a label and `reconcileOrphanInstance` (`:77-93`) is a fifth copy of a helper.
- `store-lock.js:55-60` uses a fixed `.tmp` file name; `pnpm-workspace.js` writes non-atomically; `paper-mcp.js:74-79` writes its registry unlocked.
- `repo-audit.js:443-457` runs `vm.Script` and `:424` `literalMatches` with no timeout; `Math.random` ids at `citation-network.js:205`, `literature-watch.js:61`, `reporting-check.js:937`.
- `cite_check` samples the first 12 records; `deep-research.js` `gateDeps` (`:717`) stubs `consensusClaimed` and `numericCheck`; the report is truncated at 20,000 characters.

**B9. Early engine exit can leave an unhandled stdin `EPIPE`** — `academic-harness-cli.js:162-164`, `:189-193` — **Medium, ran—local, newly found during verification**

`run()` handles the child process's `error`, but not `child.stdin` errors. In a separate Node process, calling the real helper with a child that immediately exits 2 and a 1 MiB input caused an unhandled `write EPIPE` and Node exit 1, rather than a normal `{code, out, err}` result. A small failing pre-hook fixture also hit this race once; its corrected, stdin-consuming fixture is the B7 test above. Handle stdin stream errors and resolve the child outcome safely. This is a helper-process reproduction; it does not establish how the production host's top-level error handling would recover.

### C. Licensing and bundled content

**C1. Four restricted Anthropic skills ship in the MIT-licensed package** — `skills/docx`, `skills/pdf`, `skills/pptx`, `skills/xlsx` — **High (legal review), licence text read and package inclusion measured**

Each carries an identical `LICENSE.txt` (same MD5): "© 2025 Anthropic, PBC. All rights reserved." It says use is governed by your agreement with Anthropic and, notwithstanding that, users may not extract or retain copies outside the Services, reproduce or copy the materials, create derivative works, or "distribute, sublicense, or transfer these materials to any third party". They are tracked in git (186 files) and shipped in the npm package, and `NOTICE` does not mention them. This is not legal advice; the practical fix is to remove them from the bundle (and point users to Anthropic's own distribution), or get written permission and list them in `NOTICE`.

**C2. A sixth non-commercial skill is missing from `NOTICE`** — `skills/what-if-oracle/SKILL.md:5` (`license: CC BY-NC-SA 4.0`, from `ashrafkahoush-ux/claude-consciousness-skills`) — **Medium, read**

`NOTICE` lists five CC BY-NC-SA skills (deep-research, intro-drafter, paper-polish, paper-writer, rebuttal-guidance) and says MIT does not relicense them. This one is not listed. A packaging option to exclude non-commercial skills would cover all six.

**C3. Licence labels are incomplete or ambiguous** — **Low, ran**

Of 790 skills: 629 say MIT (in three spellings), 77 have no `license` key, 12 say `Unknown`, and the other 72 use about 25 different spellings, several of them free text or a URL instead of a licence name (for example a link to a library's LICENSE file, or "CeCILL FREE SOFTWARE LICENSE AGREEMENT"). Among them are the five CC-BY-NC-SA-4.0 skills already in `NOTICE`, `what-if-oracle` (C2), the four Anthropic skills (C1), and `rowan` ("Proprietary (API key required)"). Five skills carry GPL labels (`bioservices`, `cobrapy`, `etetoolkit`, `pathml`, `scikit-survival`); these appear to describe the library, not the skill text, but nothing says so. Record the intent in `NOTICE` and normalise the field to SPDX identifiers.

**C4. Skills tell the model to pipe a remote script into a shell** — `skills/research-lookup/SKILL.md:264`, `skills/literature-review/SKILL.md:660`, `skills/parallel-web/SKILL.md:57` (`curl -fsSL https://parallel.ai/install.sh | bash`) — **Low, ran**

This recommends executing freshly fetched code. Whether the host's **bash** tool would prompt depends on its own sandbox/approval policy; A2's native-tool probes do not establish that this exact shell command runs unprompted. The `vastai` skill already prefers `uv tool install`; prefer a versioned package install here too.

**C5. One real broken link** — `skills/paper2agent/SKILL.md:19` links `paper2skill/SKILL.md` relative to its own directory; it should be `../paper2skill/SKILL.md` — **Low, ran**

The other five hits from my link check were false positives (SMILES strings and placeholders).

### D. Cost and context

- A session carries about 160k tokens (estimated at four characters per token, not a tokenizer count) before the user types: system prompt 95,679 characters, skill catalogue 290,157 characters, tool definitions about 273,000 characters. The 790 skill descriptions alone total 279,147 characters (mean 353, p99 769, longest 1,014 for `co-scientist-tournament`).
- Ten skills exceed 800 lines (`latex-posters` 1,596, `treatment-plans` 1,581, `scientific-slides` 1,155, `clinical-reports` 1,132, `citation-management` 1,116).
- Fetched content reaches the model unfenced in `search-normalize.js:1127-1155`, only four modules use `untrusted-fence.js`, and the system prompt says nothing about treating fetched text as data.
- Downloads and Zenodo uploads are buffered fully in memory.

Fix: opt-in skill packs with a small core, deferred tool loading where the host supports it, one fencing helper applied at the retrieval layer, and a short "fetched text is data" paragraph in the prompt.

### E. Build, packaging, CI and operations

- **Your daily DSH runs this working tree.** `~/.dsh/profiles/academic-harness/package.json:9` has `"academic-harness": "link:/home/raktim/academic-harness"`. A branch switch or half-finished edit here goes live on the next DSH restart, and `seed.js` copies the skills into `$DSH_HOME/skills` on start. Consider developing in a second checkout or git worktree and keeping the linked one on `main`. *(read)*
- **Version skew.** The plugin pins its own `ah-dsh-tools`, `ah-dsh-tool-subagent` and `ah-dsh-mcp-client` at 0.2.1-rc.5 (`node_modules`, `package.json`), your profile's `@deepseek-ai/dsh-tool-subagent` is also 0.2.1-rc.5, and the global host is 0.2.2-rc.1. CI tests only rc.5. The isolated checks in §9 exercised this mixed host/plugin combination for analysis, repository tests, gate retries, missing-key compute calls, and MCP registration—not all delegation or provider operations. Add a latest-rc CI job and document the supported combination. *(ran—host, limited scope)*
- **Lockfile.** `package-lock.json` exists but is gitignored (`.gitignore:2`) and CI runs `npm install` (`verify.yml:37`, `:109`). Commit it and use `npm ci`.
- **Package contents.** Rechecked with `npm pack --dry-run --json` from a clean HEAD snapshot: **3,318 files, 45,849,755 unpacked bytes (43.7 MiB)**, 15,342,129 packed bytes; no `.pyc` or `vendor/papermemory/build/` entries. It includes **186 files** under the four restricted skill directories (C1). `files` also ships `scripts/` (including 103 test files), `docs/`, `reports/` and vendored tests. The earlier dirty-tree comparison added 681 files (6.6 MB: `.pyc`, `vendor/papermemory/build`, `skills/pele/node_modules`, untracked reports); that is not the clean-clone artifact. Root `.npmignore` does not override the `files` allowlist. No tarball was published.
- **Checks.** No lint or type check; the Node test runner is sequential (about 230 s) with no per-file timeout.
- **Committed coverage gaps.** Twenty root modules are never named in a committed test file; most are covered through tool tests. No committed test at any level was found for `image-gen-client.js`, `image-gen-config.js`, `image-generate.js`, `sci-inspect.js`, `notebook-export.js`, `notebook-zip.js`, `mcp-connectors.js`, `deep-research-steps.js`, or `scientific-result.js`. No committed test drives the gate/RSI listeners. The ad hoc image-client and listener checks in §9 reduce review uncertainty, but do not close these regression-coverage gaps. *(ran: test inventory; not a line-coverage measurement)*
- **Smaller.** `scripts/live-e2e/start.sh:9` runs `rm -rf "$E/workspace"` on a caller-supplied path with no guard; the isolated DSH inherits the rest of your shell environment (it sets only the model key to a dummy). `vendor/academic-harness/` has no LICENSE file; `pyproject.toml` says `0.3.6+ah.1` where `vendor/papermemory/SOURCE.txt` says 0.3.5; `installBundled` installs an unpinned `pypdf>=4.0`; `run()` sends SIGTERM without a follow-up SIGKILL; the stdlib fallback in `python-helpers/document_text.py:14-25` rejects `<!DOCTYPE` only as UTF-8 bytes, so a UTF-16 docx would bypass it when `defusedxml` is absent (CI installs it; make it required).

### F. Maintainability

`deep-review.js` is a 3,990-line monolith, and `deep-research.js` `runAsJob` (`:745-818`) duplicates `deep-review.js:568`. `workspaceRoot` is re-implemented in 51 modules and path confinement in 11. Stores import from tool monoliths, and `rsi-store.js:189-217` has its own lock. `package.json` declares about 170 `exports` subpaths. Windows-only branches remain in a Linux-only plugin. `prompt.js:359` contains a dated sentence (Runpod v1 retires 2026-11-15) that becomes stale after that date; the client already targets v2.

## 4. Suggested features

1. **Approval and budget layer**: one listener, a durable record of what was approved, a per-session spend cap, a cost estimate before each paid run and a spend ledger across Modal, Runpod and Vast.ai.
2. **Workspace trust**: a per-workspace confirmation for anything that mounts or runs code from the folder (A1), stored outside the folder.
3. **Detached runs** through the host job service for `analysis_run` and the compute tools.
4. **Skill packs**: a small core plus opt-in domain packs; an option to leave out non-commercial skills.
5. **Shared network guard and async process runner**: public-host check, redirect policy, size cap, environment allowlist, timeout and kill in one module.
6. **Test infrastructure**: a fake-host harness for hook listeners, a parallel runner with per-file timeouts and JUnit output, an opt-in test against `sandbox.zenodo.org`, and a prompt-injection case plus a token count in the live end-to-end run.
7. **Secret settings fields**: mark key fields `role('secret')` and expose a server-derived map of which keys are configured, so stored keys stop reaching browser snapshots. (The current non-secret schema is a deliberate, commented trade-off in `settings-keys.js`; the client inputs are write-only password fields.)
8. **Explicit experiment outcome** field for `coscientist` feedback (B6).

## 5. Checked and found clean

- **Client** (`client/*`): no `innerHTML`, `eval`, network calls or `postMessage`; reply text is rendered through `createElement` so React escapes it, and links become inert spans; `localStorage` holds only the fold level inside try/catch.
- **Python helpers** (`python-helpers/*.py`, 5,793 lines): no subprocess, network, pickle or `yaml.load`; numpy loads use `allow_pickle=False`; docx parsing caps XML at 50 MB and rejects DTDs.
- **Secrets**: no secret-shaped strings in skills other than fake fixtures in redaction tests (`skills/autoskill/tests`).
- **Skills structure**: all 790 parse, every `name` matches its directory, no duplicate names.
- **Live e2e scripts**: random port, separate `DSH_HOME`, refusal of :3080 in `drive.mjs:18`, `real-model.mjs:20` and `stop.sh:9`, kill by exact PID, dummy model key.
- **Co-Scientist math** (`coscientist-models.js`): the Glicko-2 update and Illinois volatility solver match Glickman's published algorithm; thresholds carry their upstream source.
- **Backfill** (`papermemory-backfill.js`): dry run by default, open-access only, exact-title identity matching, quality gate before ingest, retry ledger.
- **Modal remote paths** are consistently `shellQuote`d (except A4).

## 6. Coverage

| Area | How checked |
|------|-------------|
| Node tests | Reran: 103/103 test files passed, scratch home/state |
| Engine and PaperMemory pytest | Reran: 506 and 233 passed, isolated homes and vendored imports |
| Client build and generated patch | In-memory esbuild output matches both committed client files; cordis `--check` passed |
| Real DSH 0.2.2-rc.1 | Isolated boot, command/approval controls, gate sequence, MCP fresh-session and explicit-registration checks (§9) |
| `paper-mcp.js`, `papermemory-backfill.js`, `-library.js`, `-dream.js`, `subagent-models.js`, `coscientist-models.js` | Read in full |
| `client/*`, `python-helpers/*`, `scripts/live-e2e/*` | Pattern scan, then targeted reads |
| 790 skills | Structural audit of all frontmatter and links; pattern scan of all files for secrets and risky commands; content not reviewed skill by skill |
| 203 root modules | Gate, RSI, tool, store and client modules read earlier; the rest swept for `shell:`/`exec`, blocking spawns, `fetch` without timeouts and keys in URLs, not read line by line |
| Dependencies | Listed and compared with host versions; `npm audit` not run (needs the registry and a lockfile) |

**Still not done:** paid/provider-backed provisioning or teardown, a live Zenodo sandbox deposit, a full live subagent-origin learning test, an independent human/legal judgment on skill licences, a browser/UI approval click-through, and a host-0.2.1-rc.5 integration rerun. A1 automatic fresh-session mounting was not reproduced on 0.2.2-rc.1. See §9.4; these are explicit limits, not passed checks.

## 7. Corrections to earlier statements

- `seed.js` does refresh skills, but only `SKILL.md` for 32 named skills (`:69-78`); others never update after the first seed.
- The paper-state card is deduplicated by hash (`hooks.py:211-216`).
- `reporting-check.js:598` is a local function named `fetch`, not a network call.
- The Runpod client already targets v2 (`runpod-client.js:15`).
- `.pyc` files and `vendor/papermemory/build` ship only from a dirty-tree pack, not from the GitHub install.
- CI already checks for a stale client build and a stale cordis patch, and installs the pinned host.
- Earlier today I said the repo's `node_modules` was empty; it has 38 entries, including the pinned `ah-dsh-*` packages.
- A1's fake callback probe did not prove automatic execution on opening a folder. The real fresh-session test did not mount it; only explicit registration executed the canary.
- B1 does not reset the engine's retry count on every plugin message. The engine preserves unsettled edits through the retries; the reset occurs after the handoff message is fed back through `userprompt`.
- The existence of an `ask` approval policy does not automatically ask for each tool. Real logs contained only the positive-control `ah_author` approval request.
- Ad hoc probes and a passing suite do not mean regression tests for these findings have been added. No fixes were implemented.

## 8. Suggested order of work

1. **Trust PR**: A2 and A3 first (approval plus environment isolation), with real-host positive controls. Add A1's explicit-registration trust boundary; resolve the automatic-mount lifecycle before claiming an opening-a-folder exploit or changing startup behavior.
2. **Licence PR**: remove or relicense C1, add C2 to `NOTICE`, normalise C3. No code risk.
3. **Gate PR**: B1 and B2 with a fake-host test written first, then B3.
4. **Hardening PR**: A4, A5 (including body timeout/actual-byte total caps), A7, B7, B9 and the shared network/process helpers.
5. **Reliability PR**: A6 (async `analysis_run`) and B4 (Zenodo `PUT` to the bucket link, tested against the sandbox).
6. **Scoring PR**: B6 explicit outcome.
7. **Weight PR**: skill packs and prompt trimming (D), packaging cleanup and lockfile (E).

## 9. Verification completion and handoff

### 9.1 Isolation and method

The interrupted Claude session had completed the static review and broad test runs, but had not finished its live checks. This continuation completed the bounded local verification and updated the findings above; **it did not implement fixes, change runtime configuration in the user's profile, commit, push, or publish**.

- The real-host test used `~/.cache/ah-review-e2e`, a separate `DSH_HOME`, fake `HOME`, isolated XDG directories, a random loopback port, and an environment built from an explicit small dictionary. Model traffic went only to the loopback scripted provider; its replies were predetermined, not judgments by a real model.
- Only invented canaries and fixture manuscripts/repositories were used. The user DSH at :3080 was never contacted. The provider/DSH review processes were stopped by their recorded PIDs after collecting evidence.
- An initial working-tree symlink could not resolve a host peer package during session creation. The harness was changed to a clean `git archive HEAD` snapshot in the **throwaway profile only**, with host peers visible and current preset YAML. This harness-layout error, an earlier fake-host callback-arity error, and an initially missing required bash description are **not** plugin findings.
- The MCP shell fixture writes canaries and then sleeps; it is deliberately not a functioning MCP server. Script execution is evidence even if the subsequent MCP handshake fails; no claim of a healthy registered MCP tool is made.
- Public Zenodo developer documentation was read. No authenticated external upload/provisioning/entitlement call was made. The tests do not authorize or substitute for those operations.

### 9.2 Evidence matrix

| Finding/check | Verification and observed result | Boundary |
|---|---|---|
| A1 automatic startup | Create a fresh preset session with an existing registry; no execution canary, later status `not-mounted` | Original opening-a-folder exploit **not reproduced** on host 0.2.2-rc.1 |
| A1/A2 explicit register | Real `paper_mcp register` started the fixture script; named and non-credential-shaped unnamed canaries arrived | Not proof that unnamed credential-shaped variables evade the transport scrubber |
| A2 native approvals | Analysis/file canary and repository tests ran; all three missing-key compute calls reached execute; only `ah_author` generated `approval/asked` and paused | No configured compute run or UI approval click |
| A3 environment | Real `runRepoAudit` returned the invented secret from its test subprocess | Local fixture, not a remote clone or real secret |
| A4 image instructions | Real Modal tool passed newline/semicolon package entries unchanged into the substituted SDK | Sandbox creation deliberately refused; no build or spend |
| A5 redirects | Dataset followed a real loopback redirect; image URL fallback fetched a loopback target; substituted Wiley endpoint followed a local PDF redirect | No public-network/private-network transition or DNS-rebinding test |
| A5 body deadline | A 25 ms fetch timeout did not interrupt a body completing after about 180 ms | Fast local timing reproduction, not a long-running production hang |
| A5 aggregate cap | Two unlengthened 4-byte streams were written despite a 5-byte total cap | Tiny fixture; no memory-exhaustion attempt |
| A6 blocking/lock | 20 ms heartbeat fired after about 330 ms; a stale-mtime active lock was stolen | Staleness simulated; no hour-long run |
| A7 request cancellation | Four real client operations emitted fetch options without a signal | Fetch replaced; no live cancellation/billing test |
| B1 gate lifecycle | One real host turn emitted `continue ×3 → handoff → none`, then completed with empty touched state and an unresolved reference still present | Scripted provider ignores retry guidance by design; not an assessment of model behavior |
| B2 RSI gate loss | Real listeners wrote quality 1.0 with terminal `none`, versus 0.8 with retained handoff | Episode comparison is a local listener harness |
| B3 delegated preference | Real listener wrote an active user-scoped lesson for a short, subagent-origin prompt | Not a complete live spawn with the host's appended guidance |
| B4 Zenodo | Captured raw POST conflicts with official multipart contract; strict local double returns 400 and real function rejects | No sandbox request; fake rejection is not attributed to Zenodo |
| B5 T3 cadence | Two engine turns, one substituted evidence-verifier call | No model evaluation; intended cadence still needs a product decision |
| B6 sentiment | Direct rerun reproduces scores 0, -1, -0.5 for the three examples in §3 | Linguistic scoring defect, not a scientific assessment |
| B7 failed pre-hook | Engine consumes input then exits 2; real listener returns `allow`, warning only server-side | No protected write actually executed; remote-judge fallback still static |
| B9 stdin error | Immediate child exit plus 1 MiB stdin makes separate Node process exit 1 on unhandled `EPIPE` | Production host recovery behavior not exercised |
| Existing tests/build | 103 Node test files, 506 engine tests, 233 PaperMemory tests; client JS/map match; cordis patch current | Optional TextFold live integration self-skipped |
| Clean package | 3,318 files; 45,849,755 unpacked bytes; 186 restricted-skill files; no `.pyc` or vendored build tree | Dry-run only; no distribution/upload |

### 9.3 Reproduction artifacts

Local evidence and ad hoc scripts are retained at:

`~/.cache/ah-review-verification-20261110/`

Key files:
- `verification-summary.json`: revision, versions, test counts, host observations, and local probe outputs.
- `review-local-probes.mjs`, `review-local-probes.log`, `review-local-results.json`: A3–A7, B2–B4, and the added download cases. On this checkout, rerun with `node ~/.cache/ah-review-verification-20261110/review-local-probes.mjs`.
- `review-advisory.py`: B5 engine-seam test (`PYTHONDONTWRITEBYTECODE=1 python3 <file>`).
- `review-fail-open.mjs`: B7 listener test (`node <file>`).
- `review-epipe.mjs`, `review-epipe.log`: B9; **nonzero exit with `EPIPE` is the reproduced failure**, not a passing ordinary test.
- `host-observations.json`, scripted-provider receipts, and redacted boot log: isolated integration observations; bootstrap credentials are not included.
- `review-node-tests.log`, pytest logs, and `review-clean-pack.json`: suite/pack evidence.

These are machine-local investigation artifacts, not a checked-in, portable regression suite. Paths point to this checkout; temporary fixtures live under `/tmp/opencode`, and the host profile is under the separate cache directory above. A future fix should first turn the relevant reproductions into maintained tests under `scripts/` or the vendored engine tests.

### 9.4 Explicitly remaining validation / team decisions

The locally testable core claims above now have observed outcomes, including one materially narrowed claim (A1). The following are **not** certified by this review:

1. **Host/version and lifecycle matrix:** repeat A1 on the CI host 0.2.1-rc.5 and on restored/imported sessions; determine whether the auto-mount listener is reachable in each composition. Repeat the confirmed approval/gate controls there. An isolated boot on 0.2.2 is not parity evidence for every host version.
2. **Live providers:** with explicit account-owner authorization, validate a tiny Zenodo **sandbox draft**, cloud provisioning/cancel/teardown, and pinned-offer caps. Define resource/deposit cleanup and budget before running. The current findings do not measure real bills or provider error responses.
3. **Full origin and failure paths:** test a real delegated session including host-added guidance; test forget/correction contamination and remote-judge outage admission end-to-end. Only the short-prompt preference listener and pre-hook exit path were dynamically reproduced here.
4. **Other native approvals and UI:** individually exercise the static A2 extension list, observe approval UI behavior with a browser, and check Settings secret exposure from actual client snapshots. The `ah_author` pending-input/event control proves server-side approval routing, not UI accessibility or completeness.
5. **Licence and product intent:** maintainers/counsel must determine redistribution rights and per-skill attribution (C1–C3), and maintainers must choose T3 cadence, explicit experiment outcomes, trust policy, and budget defaults. Licence text/package inclusion are evidence, not a legal opinion.
6. **Broader static leads:** A8/A9, most B8 items, prompt-injection robustness, exact tokenizer/context cost, the remaining coverage gaps, and maintainability proposals remain static findings or recommendations. No actual credential interception, SSH adversary, huge-download stress test, independent scientific validation, lint rollout, or full skill-by-skill content review was performed.

**Handoff:** review this report before changing behavior. Prioritize confirmed approval/environment isolation and gate/RSI defects; assess restricted-content distribution before the next release. Keep the unconfirmed lifecycle and external-service cases distinct from those confirmed failures.
