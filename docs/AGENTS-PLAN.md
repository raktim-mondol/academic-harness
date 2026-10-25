# Specialist agents — gap analysis and implementation plan

Status: **proposed, not implemented** (2026-10-24) · Baseline **v0.19.0**

Source docs: `README.md`, `prompt.js`, `docs/SEARCH-PROVIDERS-PLAN.md`,
`docs/NON-SEARCH-TOOLS-PLAN.md`, `docs/ACADEMIC-HARNESS-ENGINE.md`,
`docs/PAPERMEMORY-V2-PLAN.md`, `docs/ZG-PAPERMEMORY-ALIGNMENT-PLAN.md`,
`academic-harness_docs/*`, `~/.qoder/agents/*.md`

## 1. Why

The tool surface grew through v0.18.0 and v0.19.0: citing and formatting
(`citation`, `manuscript_citations`), integrity (`integrity_check`),
systematic reviews (`review`), clinical/regulatory records
(`clinicaltrials`, `openfda`), datasets and policy (`dataset_search`,
`journal_policy`, `funder_policy`), and the optional audits and discovery
tools (`stat_audit`, `figure_audit`, `repo_audit`, `pdf_references`,
`grant_search`, `patent_search`, `author_lookup`, `openreview`).

The specialist roster did not grow with them.

Findings:

1. **Two rosters, no canonical source.** `prompt.js:57-60` names 22 DSH
   specialists, but only names — the parent composes each brief at delegation
   time. `~/.qoder/agents/` contains 20 full Markdown briefs with different
   names, and the plugin never reads them. The README's "specialist briefs"
   claim is therefore stronger than the code.
2. **The Qoder roster predates the new tools** (agent files: 2026-10-21;
   non-search tools: 2026-10-23/24). No agent owns `integrity_check`,
   `citation`, `review`, `clinicaltrials`/`openfda`, `dataset_search`/
   `journal_policy`/`funder_policy`, or the optional audits.
3. **The rosters have drifted in both directions.** Eleven prompt names have
   no Qoder counterpart; six more exist only under a different name. Three
   important academic roles exist in Qoder but not in the prompt:
   `grant-writer`, `systematic-reviewer`, and `rebuttal-writer`.
4. **Tool allowlists do not match the harness.** The Qoder briefs list only
   Qoder built-ins (`Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, …), so
   `citation-checker` cannot call `citation`, `integrity_check`, `review`, or
   PaperMemory even when the harness is running.
5. **Audit independence is implicit.** `peer-reviewer` is read-only, but most
   other reviewer briefs do not separate "may edit" from "must not edit".

## 2. Current state

| Layer | Where | Count | Notes |
|---|---|---|---|
| DSH specialist roster | `prompt.js:57-60` | 22 names | Names only; grouped by code/literature/design/writing |
| Qoder agent briefs | `~/.qoder/agents/*.md` | 20 files | Full briefs; local only; not shipped with the plugin |
| Plugin package | `package.json`, `seed.js` | 0 agent files | `seed.js` seeds skills only |
| README | `README.md:125` | — | Describes "specialist briefs" for `subagent` |

### 2.1 Name reconciliation

| Prompt roster (`prompt.js`) | Qoder file | Action |
|---|---|---|
| `code-reviewer` | `code-reviewer.md` | Keep; read-only |
| `statistical-reviewer` | `statistician.md` | Pick one canonical name; alias the other |
| `math-checker` | — | Add; route to `subagent_pro` |
| `ml-auditor` | — | Add |
| `data-validator` | `data-scientist.md` | Split validator from analyst, or alias |
| `reproducibility-auditor` | — | Add; owns `repo_audit` |
| `pipeline-engineer` | — | Defer or add |
| `data-visualizer` | `figure-designer.md` | Alias to `figure-designer` |
| `simulation-reviewer` | — | Defer; profession skills cover most |
| `literature-researcher` | `literature-reviewer.md` | Pick one canonical name |
| `citation-checker` | `citation-checker.md` | Keep; add native citation/integrity tools |
| `fact-checker` | — | Add; claim-level verification |
| `methodology-reviewer` | — | Add; distinct from `peer-reviewer` |
| `peer-reviewer` | `peer-reviewer.md` | Keep; add `openreview` |
| `paper-agent-builder` | — | Defer to the `paper2agent` skill |
| `hypothesis-generator` | `hypothesis-generator.md` | Keep |
| `experiment-designer` | `experiment-designer.md` | Keep |
| `protocol-writer` | — | Add |
| `results-interpreter` | — | Add |
| `manuscript-editor` | `paper-writer.md` | Split editor from writer, or alias |
| `abstract-writer` | `paper-writer.md` | Alias to `manuscript-editor` if not split |
| `ethics-reviewer` | — | Add |

Qoder-only academic roles absent from the DSH roster:

- `grant-writer`
- `systematic-reviewer`
- `rebuttal-writer`

Qoder-only development roles (useful for building the plugin, not for the
academic preset): `debugger`, `docs-writer`, `performance-engineer`,
`planner`, `security-auditor`, `test-engineer`, `verifier`.

## 3. Proposed agents

Priority reflects workflow value and whether a shipped tool currently has no
owner. "Gated" means the tool requires `AH_ENABLE_OPTIONAL_TOOLS=1`.

### 3.1 P0 — add in the next release

| Agent | Job | Preferred tools | Mode |
|---|---|---|---|
| `submission-compliance-editor` | Journal fit, word/format limits, citation style, figure requirements, COI, CRediT, data-availability statement, cover letter | `journal_policy`, `citation`, `manuscript_citations`, `figure_audit` (gated), `pdf_references` (gated) | Read-only; may produce a checklist |
| `research-integrity-auditor` | Retractions, expressions of concern, corrections, image duplication, impossible statistics | `integrity_check`, `figure_audit` (gated), `stat_audit` (gated), `pdf_to_markdown` | Read-only |
| `grant-reviewer` | Mock study-section critique: aims, significance, innovation, approach, budget/timeline consistency | `grant_search` (gated), `funder_policy`, `literature_search` | Read-only |
| `reproducibility-auditor` | Code/data availability, environment capture, containerization, one-command reproduction | `repo_audit` (gated), `Bash`, `Read`, `notebook` | Read-only |
| `data-steward` | DMP, repository choice, metadata, licensing, accession numbers, FAIR data-availability statement | `dataset_search`, `journal_policy`, `funder_policy` | Read-only; may draft the statement |

### 3.2 P1 — add when the P0 set is stable

| Agent | Job | Preferred tools | Mode |
|---|---|---|---|
| `clinical-evidence-reviewer` | Trial design/endpoints, posted results, adverse events, regulatory records; keeps them distinct from peer-reviewed evidence | `clinicaltrials`, `openfda`, `pubmed_search`, `integrity_check` | Read-only |
| `prisma-auditor` | Independent second screening and PRISMA count audit; catches missing full-text decisions and includes without evidence | `review`, `literature_search` | Writes screening events only when asked; never edits the protocol |
| `reference-librarian` | `.bib` hygiene, dedupe, DOI/ID resolution, PDF bibliography extraction, reference-manager handoff | `citation`, `paper_resolve`, `pdf_references` (gated), PaperMemory | May write library files |
| `grant-writer` | Draft aims/significance/innovation/approach from verified inputs | `grant_search` (gated), `funder_policy`, `literature_search`, `notebook` | May write |
| `systematic-reviewer` | Protocol, reproducible search strings, risk of bias, synthesis, PRISMA reporting | `review`, `literature_search`, `pubmed_search` | May write protocol/evidence |
| `rebuttal-writer` | Point-by-point response with evidence and manuscript locations | `Read`, `Grep`, `citation`, `manuscript_citations`, PaperMemory | May write |

### 3.3 P2 — fill the remaining prompt-only roles

Add full briefs for: `ml-auditor`, `math-checker`, `methodology-reviewer`,
`fact-checker`, `ethics-reviewer`, `protocol-writer`, `results-interpreter`.
Route `math-checker`, `methodology-reviewer`, and `ml-auditor` to
`subagent_pro`; they are difficulty-bound rather than length-bound.

Defer or drop:

- `paper-agent-builder` — the `paper2agent` skill already owns the workflow.
- `pipeline-engineer` — useful, but overlaps `data-scientist` and `code-reviewer`; add only if users ask for build-and-maintain work.
- `simulation-reviewer` — domain framing comes from the 503 profession skills.
- `data-validator` — split from `data-scientist` only if validation work proves common enough.
- `data-visualizer` — alias to `figure-designer`; do not ship both.

### 3.4 Enrich existing agents

| Agent | Add |
|---|---|
| `citation-checker` | `citation`, `integrity_check`, `paper_resolve`, PaperMemory; check retractions before reporting "verified" |
| `peer-reviewer` | `openreview` (gated) for venue/review context |
| `systematic-reviewer` | `review` ledger, `pubmed_search` preprint routing |
| `statistician` / `statistical-reviewer` | `stat_audit` (gated); GRIM/GRIMMER consistency |
| `figure-designer` / `data-visualizer` | `figure_audit` (gated); DPI/format/duplicate-panel checks |
| `manuscript-editor` / `paper-writer` | `manuscript_citations`, `citation`, `remove-ai-signs` as a post-draft pass |
| `grant-writer` | `funder_policy`, `grant_search` (gated) |

## 4. Non-goals

- **No discipline agents.** Accelerator physicists, zoologists, and actuaries
  are covered by the 503 profession skills; agents should own roles and
  workflows, not fields.
- **No duplicate reviewers.** Ship one statistics reviewer, one literature
  reviewer, and one manuscript editor under canonical names.
- **No single-purpose writers.** Fold journal selection and cover letters into
  `submission-compliance-editor`; fold DMPs into `data-steward`; fold budget
  justification into `grant-writer`/`grant-reviewer`.
- **No write access for auditors.** Integrity, reproducibility, methodology,
  and compliance reviewers report; they do not silently edit.
- **No new MCP mounts.** Agents use the existing native tools and the
  `paper_mcp` escape hatch.
- **No detector evasion.** `remove-ai-signs` remains a style skill; do not
  build a "humanizer" agent or claim detector defeat.
- **No legal or medical advice.** Patent, regulatory, and policy agents report
  records and caveats.

## 5. Implementation options

### 5.1 Option A — prompt-only (cheapest)

Add names and two-line briefs to `prompt.js`, update the README, and add
golden-name assertions to the existing test suite. No new files, no runtime
cost beyond a few dozen tokens. This is how the current roster works, and it
keeps the drift problem.

### 5.2 Option B — canonical registry (recommended)

Add `agents/` to the plugin:

```text
agents/
  roster.js              # canonical array: name, description, group, brief,
                         # read_only, preferredTools, optionalTools, routing
  submission-compliance-editor.md
  research-integrity-auditor.md
  ...
```

Either make `roster.js` the source and generate the Markdown briefs, or make
the Markdown files the source and parse their frontmatter in a build step.
`roster.js` is simpler for `prompt.js` because the prompt section can compose
from it at module load:

```js
import { SPECIALISTS } from './agents/roster.js'
// ...
${renderSpecialistRoster(SPECIALISTS)}
```

Add:

- `scripts/build-qoder-agents.mjs` — emit Qoder-compatible Markdown into
  `dist/qoder-agents/` or optionally seed `~/.qoder/agents/` only when the
  user passes `--install`.
- `scripts/test-agents.mjs` — offline checks:
  - names are unique and kebab-case;
  - every prompt roster name has a brief and description;
  - every brief has a non-empty "When invoked" and "Report" section;
  - read-only agents never request `Write`/`Edit`;
  - every tool name exists in a maintained tool list;
  - gated tools are declared in `optionalTools` and mention the gate.
- `package.json` — add `agents` to `files`; add `agents:build`/`agents:test`
  scripts.
- `README.md` — replace "specialist briefs (code-reviewer, …)" with the
  canonical roster and the reconciliation note.

This makes `prompt.js`, the README, and the Qoder files derive from one list.

### 5.3 Option C — per-agent DSH presets

DSH `@deepseek-ai/dsh-tool-subagent` supports `agentPreset` and
`allowedAgentPresets`, so each specialist could be a full preset with its own
tool allowlist. That is the strongest isolation, but it multiplies preset
maintenance and prompt-registry cost. Not recommended for 20+ roles; reserve
it for a future high-risk agent that needs a genuinely restricted tool
surface.

### 5.4 Brief delivery (open decision)

- **Names-only** (status quo): cheap, inconsistent.
- **Inline briefs in the system prompt**: consistent, but adds several
  thousand tokens to every session.
- **`specialist_brief` tool**: one small schema; the parent fetches a brief on
  demand and passes it to `subagent`. Keeps the prompt small and the briefs
  canonical. Recommended if Option B is chosen.

## 6. Tool access and routing

### 6.1 DSH children

A `subagent` child joins the parent preset by default and inherits its tool
surface. The brief should still name preferred tools and forbidden actions;
do not assume a child will discover the right tool.

### 6.2 Qoder agents

Qoder reads `~/.qoder/agents/*.md` and honours the `tools:` frontmatter. The
current allowlists expose only Qoder built-ins, so those agents cannot call
the plugin's native tools. Two valid choices:

1. Keep Qoder agents as generic reviewers with `Read`/`Grep`/`Glob`/web tools,
   and do not claim native-tool behaviour in their briefs.
2. Generate Qoder variants with whatever Qoder actually exposes (Bash, file
   tools, web tools) and let them shell out to CLI-backed helpers. A generated
   header should state which tools are unavailable.

Do not ship one Markdown file that pretends both environments have the same
tools.

### 6.3 Model routing

| Routing | Agents |
|---|---|
| `subagent` (default) | `submission-compliance-editor`, `data-steward`, `reference-librarian`, `prisma-auditor` |
| `subagent_pro` | `math-checker`, `methodology-reviewer`, `ml-auditor`, `research-integrity-auditor` (when the call is a hard forensic judgment) |
| `subagent_vision` | Figure-panel comparison, microscopy/gel review, compiled-PDF layout audits |
| `subagent_fork` | Continuity only; never for independent verification |

Independent verification must be a fresh `subagent`/`subagent_pro`, not a fork
of the author's session.

## 7. Verification

Automated:

```bash
node scripts/test-agents.mjs
node scripts/test-nonsearch-tools.mjs
node scripts/test-manuscript-tools.mjs
```

Manual smoke, one delegation per P0 agent:

| Agent | Smoke task | Pass condition |
|---|---|---|
| `submission-compliance-editor` | Audit a real manuscript against a chosen journal | Reports policy status, missing items, and no invented requirements |
| `research-integrity-auditor` | Check a known retracted DOI plus a clean DOI | `retracted` vs `clean`, with `checked_at`; `unknown` never becomes `clean` |
| `grant-reviewer` | Score a one-page specific-aims draft | Each criticism ties to a funder criterion or the draft text |
| `reproducibility-auditor` | Audit a public repo | Cites `repo_audit` fields and concrete missing artifacts |
| `data-steward` | Draft a data-availability statement for a dataset DOI | Uses the record's actual license/repository; no invented metadata |

Also verify that a child given an optional tool while the gate is off reports
the tool as unavailable instead of pretending to use it.

## 8. Open decisions

1. **Canonical stats name**: `statistician` or `statistical-reviewer`?
2. **Writing split**: keep `paper-writer` as one agent, or split
   `manuscript-editor` and `abstract-writer`?
3. **Qoder shipping**: keep the Qoder roster local, or generate and seed it
   from the plugin?
4. **Brief delivery**: inline, `specialist_brief` tool, or names-only?
5. **Dev agents**: exclude `debugger`/`planner`/`security-auditor`/etc. from
   the academic preset, or add a separate development roster?
6. **Deferred roles**: add `pipeline-engineer` and `simulation-reviewer` now,
   or wait for a concrete request?

## 9. Checklist

- [ ] Decide canonical names and resolve the 6 aliases
- [ ] Add `agents/roster.js` with P0 briefs
- [ ] Add P0 briefs: submission compliance, integrity, grant review, reproducibility, data stewardship
- [ ] Generate the `prompt.js` specialist section from the roster
- [ ] Add `scripts/test-agents.mjs` and wire it into CI
- [ ] Update `README.md` and `package.json`
- [ ] Add P1 briefs: clinical evidence, PRISMA audit, reference librarian, grant writer, systematic reviewer, rebuttal writer
- [ ] Add P2 briefs and enrich existing agents with new tools
- [ ] Optionally generate/seed Qoder agent files
- [ ] Record the release note and the open decisions above
