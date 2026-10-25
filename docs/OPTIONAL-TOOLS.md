# Optional tools

Several tools ship behind an opt-in flag: `AH_ENABLE_OPTIONAL_TOOLS=1` (**env only, not Settings**).

With the flag unset the tools are not registered at all — they are absent from the tool list and the system prompt. The preset rows always exist, so enabling the flag needs a **`dsh` restart**.

## Tools

### `author_lookup`

ORCID author search and single-ORCID records (name, works count, employment with ROR ids) plus ROR institution search/lookup (name, aliases, country, website).

- `ORCID_TOKEN` is optional and only raises limits; ROR is keyless.
- Ambiguous names return candidates — identities are never merged automatically.

### `openreview`

OpenReview API v2 submission search, a forum's reviews/decision, and venue metadata.

- Read-only; fields a venue does not publish stay absent.
- OpenReview may answer with an HTTP 403 browser-verification challenge, in which case open the forum URL with `agent-browser`.

### `pdf_references`

GROBID bibliography extraction from a workspace PDF.

- Requires `GROBID_BASE_URL` (for example `http://127.0.0.1:8070`) **in addition** to the flag; without a reachable GROBID service the tool reports the failure and never generates references itself.
- `resolve: true` checks each extracted DOI's title against Crossref.

### `coscientist_verify`

Citation integrity and claim support for the [hypothesis tournament](RESEARCH.md#hypothesis-tournaments).

- `citations` checks every work a hypothesis cites against Crossref (a DOI that is not registered is `fabricated`; a title nobody matches, or any registry error, is only `unverified` — never reported as verified) and records the counts that drive the rating penalty.
- `check_integrity: true` adds retraction status via `integrity_check`.
- `claims` records the supports/contradicts/unaddressed judgements a subagent reached, so the ledger holds them rather than the transcript.
- `CROSSREF_MAILTO` moves it into the polite pool; it shares one Crossref limiter with `crossref_lookup`.

### `stat_audit`

Recomputes p-values from reported t/F/χ²/z/r statistics and df, flags `p = 0` and incompatible statistic/p pairs, and optionally runs GRIM on reported means.

- Requires SciPy in the helper environment.
- Candidate inconsistencies only, never misconduct. GRIMMER is not implemented.

### `figure_audit`

Local inventory of figure files (dimensions, DPI, mode, format), low-DPI and missing-DPI flags, and dHash-based near-duplicate groups.

- Advisory; it does not detect manipulation.

### `repo_audit`

Static reproducibility checklist (README, LICENSE, environment file, tests, CI, entry points, data availability, release tag) for a local path or an https `repo_url` cloned into a temp dir.

- Code is not executed unless `run_tests: true`.
- `GITHUB_TOKEN` (env only) is optional for API metadata.

### `grant_search`

Funded-project and opportunity discovery:

- NIH RePORTER (awards, amounts, dates),
- NSF Award Search (awards),
- Grants.gov (posted/forecast opportunities).

Filters by query, PI, organization, and fiscal year; `get` reads one award/opportunity by id. Informational only, not grant-writing advice.

### `patent_search`

PatentsView prior-art/assignee/inventor lookup over US patents with grant/priority dates and optional abstracts.

- **Requires `PATENTSVIEW_API_KEY` on every call**; without it the call returns a clear error.
- No legal-status or freedom-to-operate conclusions.

## Not gated

`literature_search` also gains a `preprints` source (Europe PMC `SRC:PPR`) available **without** the flag, and chooses it automatically for biomedical queries that mention preprints.

## Enabling

```sh
export AH_ENABLE_OPTIONAL_TOOLS=1
# restart dsh so the preset remounts and registers the tool rows
```

The flag is read at mount time. Changing it in a running process has no effect until `dsh` restarts. See [Configuration](CONFIGURATION.md#when-a-change-takes-effect).

## Related

- [Configuration](CONFIGURATION.md) — `GROBID_BASE_URL`, `GITHUB_TOKEN`, `PATENTSVIEW_API_KEY`, `ORCID_TOKEN`.
- [Research](RESEARCH.md) — tournaments and clinical/regulatory records.
- [Skills](SKILLS.md) — the `agent-browser` skill used by `openreview`.
