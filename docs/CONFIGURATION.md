# Configuration

Academic Harness reads credentials and preferences from two places:

1. **Settings → Academic Harness API keys** in the DSH web UI. DSH 0.2.x stores these as volatile fields on the plugin's Loader row, persisted in the profile's `cordis.patch.yml` — not in a separate `settings.yaml`.
2. **Shell environment variables.** A non-empty env var wins over the stored value.

No credential is required to install or boot. Each connector or tool stays disabled or returns a clear "key not set" error until its key is present. PaperMemory, notebook, `fold_text`, `paper_fold` local levels, `latex_compile`, and the academic databases' keyless tiers need no key.

## Settings fields

### Search and literature

| Field | Required for | Notes |
|---|---|---|
| `PARALLEL_API_KEY` | Parallel MCP connector, `parallel_search`, `parallel_extract` | Native REST calls take effect on the next call; the MCP connector needs a `dsh` restart. |
| `FIRECRAWL_API_KEY` | Firecrawl MCP connector | MCP mount needs a `dsh` restart. |
| `CONSENSUS_API_KEY` | `consensus_search` | Required; the tool returns a clear error when unset. |
| `SCITE_API_KEY` | Scite MCP connector | An `mcp`-scoped key from <https://scite.ai/users/me/api>; sent as a bearer token to `https://api.scite.ai/mcp`. |
| `BRAVE_API_KEY` | `brave_search` | Independent web index; not a literature index. |
| `TAVILY_API_KEY` | `tavily_search` | AI-native chunks and filters. |
| `EXA_API_KEY` | `exa_search` | Neural/entity search. |
| `PERPLEXITY_API_KEY` | `perplexity_search` | Raw ranked results. |
| `JINA_API_KEY` | `jina_read` | Optional; keyless Reader is 20 RPM, search needs a key. |
| `CORE_API_KEY` | `core_search` | Optional; keyless CORE is capped at ~10 requests/minute. |
| `ADS_API_TOKEN` | `literature_search` (`sources=ads`), `domain_search` ADS actions | Required for ADS; create a token in your ADS account. A daily quota applies. Read per call, no restart. |
| `SCOPUS_API_KEY` | `literature_search` (`sources=scopus`), `domain_search` Scopus actions | Required for Scopus; key from <https://dev.elsevier.com>. Access follows the institution's IP/VPN, so a 401/403 means not entitled. Read per call, no restart. |
| `WOS_API_KEY` | `literature_search` (`sources=wos`), `domain_search` Web of Science actions | Required for Web of Science; key from the Clarivate Developer Portal. Starter has a low daily quota and field limits. Read per call, no restart. |
| `ELICIT_API_KEY` | `elicit_search` | Elicit Pro+ required. |
| `FUTUREHOUSE_API_KEY` | `futurehouse_agent` | Edison Scientific API key. |
| `OPENALEX_API_KEY` | `openalex_search`, `openalex_citations`, `integrity_check`, `funder_policy` | Optional; raises the keyless budget. |
| `S2_API_KEY` | `s2_search` | Optional; raises Semantic Scholar limits. |
| `CROSSREF_MAILTO` | `crossref_lookup`, `coscientist_verify` | Puts requests in Crossref's polite pool; falls back to `UNPAYWALL_EMAIL`. |
| `UNPAYWALL_EMAIL` | `paper_download` | Recommended but not required; enables the Unpaywall lookup. The tool never invents an email. |
| `NCBI_API_KEY` | `pubmed_search` with `source: "ncbi"` | Raises E-utilities from 3 to 10 RPS. |
| `NCBI_EMAIL` | `pubmed_search` with `source: "ncbi"` | Contact email for NCBI. |

### Datasets, policy, and regulatory records

| Field | Required for | Notes |
|---|---|---|
| `DATACITE_API_KEY` | `dataset_search` | Optional; public DataCite data works without it. |
| `ZENODO_API_KEY` | `dataset_search` Zenodo file listings | Optional. |
| `FIGSHARE_API_KEY` | `dataset_search` Figshare file listings | Optional. |
| `SHERPA_ROMERO_API_KEY` | `journal_policy`, `funder_policy` policy half | Without it, `journal_policy` is DOAJ-only with `key_not_set`, and `funder_policy` returns identity only. |
| `OPENFDA_API_KEY` | `openfda` | Optional; raises the low shared daily quota. A 429 means the quota is exhausted. |
| `ORCID_TOKEN` | `author_lookup` | Optional; only raises ORCID limits. ROR is keyless. |
| `PATENTSVIEW_API_KEY` | `patent_search` | **Required on every call**; without it the tool returns a clear error. |

### Models and images

| Field | Meaning | Applies |
|---|---|---|
| `GEMINI_API_KEY` | Gemini API key. `IMAGE_API_KEY` (env only) overrides it | Next call |
| `IMAGE_MODEL` | Image model id. Default `gemini-2.5-flash-image` ("nano banana"); also `gemini-3.1-flash-image`, `gemini-3-pro-image`, or a custom id | Immediate on selection — no Save |
| `SUBAGENT_PRO_BASE_URL`, `SUBAGENT_PRO_MODEL`, `SUBAGENT_PRO_API_KEY` | Optional custom route for `subagent_pro`; all three required | Needs a `dsh` restart |
| `SUBAGENT_VISION_BASE_URL`, `SUBAGENT_VISION_MODEL`, `SUBAGENT_VISION_API_KEY` | Optional custom route for `subagent_vision`; all three required | Needs a `dsh` restart |

Set all three fields to register the route; with none set the tool inherits the session model (a partial set is ignored). The endpoint URL selects Anthropic Messages when it contains `anthropic` (for example `https://api.deepseek.com/anthropic`) and OpenAI Chat Completions otherwise. The plugin writes the route onto the host's pi-ai adapter and stores the API key in the credential service. The legacy ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are still accepted by the API, but those models have been retired and their requests are served by Flash.

The top-level agent's own `read_image` is hidden and guarded, so file-based image inspection always goes through `subagent_vision`; only the spawned child reads image files. Each `subagent_pro`/`subagent_vision` call automatically writes a routing-tagged `decision` entry and, when the child settles, an `observation` entry to the session notebook.

`IMAGE_PROVIDER`, `IMAGE_BASE_URL`, and `IMAGE_API_KEY` select an OpenAI-compatible Images API instead of Gemini. `IMAGE_API_KEY` is also accepted as a Gemini override. These are environment variables.

The bundled launcher (`scripts/dsh-launch`, installed as `academic-harness`) forces `DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic`. That is the Messages-compatible root DSH expects; the bare `https://api.deepseek.com` host returns 404 for chat requests.

### Remote compute

| Field | Required for | Get credentials |
|---|---|---|
| `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | `modal_run` | <https://modal.com/settings> |
| `RUNPOD_API_KEY` | `runpod_run` | <https://console.runpod.io/user/settings> |
| `VAST_API_KEY` | `vastai_run` | <https://cloud.vast.ai/manage-keys/> |

### Hypothesis tournaments

These are optional numbers, not credentials. An explicit argument to `coscientist start` always wins over the stored value.

| Field | Default | Meaning |
|---|---|---|
| `CO_SCIENTIST_MAX_HYPOTHESES` | `5` | Cap for one tournament. Five is the smallest pool that survives a review veto and a withholding without stalling. |
| `CO_SCIENTIST_STEP_BUDGET` | `36` | Steps one tournament may spend. A five-pool needs about 8 generations + 5 reviews + 15 matches to converge rather than end on the budget. |
| `CO_SCIENTIST_DUP_THRESHOLD` | auto: `0.70` lexical, `0.92` cosine | Similarity at which `coscientist add` discards a near-duplicate. An explicit value overrides the measure's default; `1` turns the gate off. |
| `CO_SCIENTIST_SEED` | unset | Makes a tournament's sampled task schedule reproducible. |
| `CO_SCIENTIST_EMBED_MODEL` | `text-embedding-004` | Model used by `coscientist embed`; reuses `GEMINI_API_KEY`. |

### Workspace index

| Field | Default | Meaning |
|---|---|---|
| `ZVEC_GREP_AUTO_INDEX` | `no` | Index this workspace when an Academic Harness session opens. Live for the next session, no restart. |
| `ZVEC_GREP_EMBEDDING` | `local/potion-retrieval-32m` | Default model for *new* indexes. Existing indexes keep their stored model. A new index run reads the current value; restart `dsh` so the search daemon, which takes the value at mount, uses the same model. |
| `ZVEC_GREP_API_KEY` | unset | Not used with local Potion models; only for an opt-in remote (Qwen) embedding provider. |

## When a change takes effect

The Academic Harness preset mounts once as a **standing composition** for the life of the running `dsh` process. A new chat on the same process is not a remount.

| Change | When it applies |
|---|---|
| API keys read by `resolveEnv()` per invocation | The next tool call, no restart |
| `IMAGE_MODEL` | Immediately on dropdown selection, no Save |
| Tournament numbers | New tournaments; explicit arguments win |
| `ZVEC_GREP_AUTO_INDEX` | The next Academic Harness session, no restart |
| MCP connector keys (Parallel, Firecrawl, Scite) | After stopping and restarting `dsh` |
| `SUBAGENT_PRO_*`, `SUBAGENT_VISION_*` | After a `dsh` restart |
| `ZVEC_GREP_EMBEDDING`, `ZVEC_GREP_API_KEY` | New index runs read the current value; a `dsh` restart also hands it to `zg server on` for the search daemon |
| `AH_ENABLE_OPTIONAL_TOOLS` | After a `dsh` restart; the preset rows exist either way |
| Modal SDK | No restart: the first `modal_run` call installs it into `$DSH_HOME/modal-sdk` (unless `ACADEMIC_HARNESS_MODAL_SKIP_INSTALL=1`); a manual profile install still needs a restart |
| `PAPERMEMORY_CLI`, `TEXTFOLD_*`, `ACADEMIC_HARNESS_CLI` | After a `dsh` restart (the MCP/runtime mount is standing) |
| `paper_mcp` server registrations | Tools appear as `mcp__<serverName>__*`; if a mount does not appear, restart `dsh` |

The tools that call `resolveEnv()` per invocation are: `image_generate`, `modal_run`, `runpod_run`, `vastai_run`, `consensus_search`, `parallel_search`, `parallel_extract`, `brave_search`, `tavily_search`, `exa_search`, `perplexity_search`, `jina_read`, `core_search`, `elicit_search`, `futurehouse_agent`, `paper_download`, `openalex_search`, `openalex_citations`, `s2_search`, `crossref_lookup`, `arxiv_search`, `pubmed_search`, `paper_resolve`, `integrity_check`, `citation`, `openfda`, `dataset_search`, `journal_policy`, `funder_policy`, `author_lookup`, `coscientist`, `pdf_references`, and `patent_search`.

## Environment-only variables

| Variable | Effect |
|---|---|
| `ACADEMIC_HARNESS_SKILLS_DIR` | Use a different skills catalogue. `RESEARCHCRAFT_SKILLS_DIR` is still honored as a fallback; `~/scientific-agent-skills/skills` is the default checkout path. |
| `ACADEMIC_HARNESS_HELPERS_DIR` | Use a different `python-helpers` checkout; `RESEARCHCRAFT_HELPERS_DIR` fallback. |
| `ACADEMIC_HARNESS_PYTHON` | Python interpreter for the helpers; `RESEARCHCRAFT_PYTHON` fallback. |
| `ACADEMIC_HARNESS_CLI` / `AH_CMD` | Override the writing-engine CLI. |
| `ACADEMIC_HARNESS_SKIP_INSTALL=1` | Skip creating the plugin-local engine venv. |
| `ACADEMIC_HARNESS_MODAL_SKIP_INSTALL=1` | Skip the managed Modal SDK install; use a profile-installed SDK instead. |
| `ZVEC_GREP_CLI` | Absolute path to `zg` or to `@zvec/zvec-grep`'s `dist/cli/index.js`. |
| `ZVEC_GREP_HOME` | zg state directory (daemon state, token, model cache); defaults to `~/.zvec-grep`. |
| `ZVEC_GREP_SKIP_INSTALL=1` | Skip the managed `zg` npm install (with `ZVEC_GREP_CLI`, use an existing binary). |
| `ZVEC_GREP_SERVER_URL` | Point the MCP mount at an already-running zg server; that endpoint is not torn down when `dsh` exits. |
| `ZVEC_GREP_SERVER_TOKEN` / `ZVEC_GREP_SERVER_TOKEN_FILE` | Bearer token (inline or file) for the zg MCP server. |
| `TEXTFOLD_SKIP_INSTALL=1` | Never install the managed TextFold runtime. |
| `TEXTFOLD_PYTHON=/path/to/python` | Use an interpreter that already has `textfold`. |
| `TEXTFOLD_CLI=/path/to/textfold` | Use a TextFold executable directly. |
| `TEXTFOLD_DATA=/path` | A different document store (absolute path recommended). |
| `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | Forwarded to TextFold for `paper_fold` `generate: true`; `GEMINI_API_KEY` from Settings is forwarded too. |
| `PAPERMEMORY_CLI` | Absolute path to a `papermemory` binary. |
| `PAPERMEMORY_DB` / `PAPERMEMORY_DATA_DIR` | Override the SQLite store location. |
| `PAPERMEMORY_EVIDENCE_DIR` | Evidence directory, automatically excluded from workspace indexing. |
| `XDG_DATA_HOME` | Base for the default PaperMemory store when neither `PAPERMEMORY_DB` nor `PAPERMEMORY_DATA_DIR` is set. |
| `PAPERMEMORY_PROJECT` | Override the project for auto-ingest (slugified). |
| `PAPERMEMORY_SKIP_INSTALL=1` | Skip installing the bundled PaperMemory venv. |
| `AH_ENABLE_OPTIONAL_TOOLS=1` | Register the optional tools; needs a `dsh` restart. |
| `AH_RSI`, `AH_RSI_STORE`, `AH_RSI_*` | Control the local RSI loop; see [RSI](RSI.md#configuration). |
| `IMAGE_PROVIDER`, `IMAGE_BASE_URL`, `IMAGE_API_KEY` | Use an OpenAI-compatible Images API instead of Gemini. |
| `GROBID_BASE_URL` | Required for `pdf_references` (optional tools). |
| `GITHUB_TOKEN` | Optional API metadata for `repo_audit` (env only). |
| `PDFIUM_LIB_PATH`, `ORT_DYLIB_PATH` | OCR shared-library paths for `pdf_to_markdown`. |
| `DSH_HOME` | DSH home; defaults to `~/.dsh`. |
| `OPENFDA_API_KEY`, `SHERPA_ROMERO_API_KEY`, `DATACITE_API_KEY`, `ZENODO_API_KEY`, `FIGSHARE_API_KEY`, `ORCID_TOKEN`, `PATENTSVIEW_API_KEY` | Same fields as Settings; environment wins. |

The old `RESEARCHCRAFT_*` names are honored where code implements a fallback: `RESEARCHCRAFT_SKILLS_DIR`, `RESEARCHCRAFT_HELPERS_DIR`, and `RESEARCHCRAFT_PYTHON`. The old API-key namespace was migrated by the v0.16.0 rename; see [Install](INSTALL.md#renamed-in-v0160).

## Credential behavior

- A blank Settings field means **keep the current value**; **Clear** removes it.
- Keys are write-only in the UI: the page never populates a stored value into the input.
- A shell variable with the same name wins over the stored value.
- Settings values live in the profile's `cordis.patch.yml` (the `academic-harness` Loader row); there is no separate keychain integration.
- Keys entered in Settings reach per-call tools without a restart; MCP connectors and model-id mounts do not. Check the matrix above before concluding a key "doesn't work".

See [Search](SEARCH.md), [Papers](PAPERS.md), [Compute](COMPUTE.md), and [Optional tools](OPTIONAL-TOOLS.md) for what each key unlocks.
