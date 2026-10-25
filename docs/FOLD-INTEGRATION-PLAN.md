# Paper folding and reply folding — implementation plan

Status: **Phases 0–3 and 4a implemented; Phase 4b optional** · Date 2026-10-25 · Baseline **v0.22.1**

Source reviewed: [`chenxiachan/textfold`](https://github.com/chenxiachan/textfold) at version
`0.10.31` (commit `2182d9a`, Apache-2.0; published on PyPI as `textfold==0.10.31`).
This plan covers only:

1. **`paper_fold`** — a map-first paper reader for the Academic Harness preset.
2. **Reply folding** — a `fold_text` tool, a point-first response prompt section, and
   an optional inline fold panel in the DSH chat.

Everything else in TextFold (reader UI, desktop app, Obsidian bridge, Zotero, gallery,
WebMCP, translation UI, library/notes) is out of scope. The goal is to take the two
useful mechanisms and make them feel native to this plugin, not to port TextFold.

---

## 1. Design principles

These constraints are what keep the work seamless; every decision below follows them.

- **Reuse Academic Harness's existing surfaces.** One new preset-only native tool
  (`paper_fold`), one new host-level tool (`fold_text`), one new prompt section, and one
  additive client slot. No new server, no new MCP connector, no second settings page.
- **Do not duplicate PaperMemory.** `paper_fold` is for orientation and reading structure.
  PaperMemory remains the source of verbatim quotes, claims, citation keys, and evidence.
  `paper_fold` does **not** auto-ingest in v1.
- **No hidden model calls.** `paper_fold` defaults to TextFold's local levels
  (`--no-generate`). Model-written levels are opt-in and only work when TextFold itself
  has a provider. `fold_text` never calls a model at all.
- **Do not replace DSH's assistant renderer.** Reply folding is additive: the official
  message stays untouched, and a folded reading panel appears below the turn.
- **Preserve the original words.** Reply folding deletes a prefix; it never paraphrases.
  Paper folding's `brief` level is verbatim sentences; generated levels carry TextFold's
  evidence anchors and provenance.
- **Keep data where the plugin already keeps it.** TextFold's runtime and papers live
  under `$DSH_HOME/textfold`, outside the workspace, so `zg` does not index them.
- **Attribute what is ported.** The reply-fold engine is a port; TextFold is Apache-2.0.
  Add the attribution to `NOTICE`, not a vague README mention.

---

## 1a. Phase 0 findings (2026-10-25)

The spikes changed two design choices. Record them before implementation.

**DSH client contract — confirmed.** The installed DSH `0.2.1-rc.2` slot metadata for
`conversation.chat.turnTail` lists these standard props: `useChat`, `useConversation`,
`useInput`, `inputActions`, `useSession`, `sessionId`, `useProjection`, `useAccess`,
`useTrajectory`, plus the global `useSessions` and workspace hooks. The owner props are
`{ turn, seq, openFile }`. No fallback to `assistant-actions` or a node renderer is
needed; the inline turn-tail plan is viable as written.

**TextFold CLI — pinned install works, but JSON is the reliable interface.** In a clean
`uv` venv, `textfold==0.10.31` installs from PyPI with `trafilatura`, `pdf-inspector`,
`pypdfium2`, `mammoth`, and the rest. Offline `get --no-generate` works on Markdown,
arXiv HTML, and a text PDF. Findings:

- **`topic` is too weak for a map.** Local topics are the first three words of the first
  sentence ("Scientific papers are", "Prior work on"). Local `takeaway` is the first
  sentence truncated to a headline and reads as a real map. **Change:** `action=map`
  defaults to `level=takeaway`, not `topic`.
- **Use `--json` once, render the view in JS.** The JSON carries `id`, `title`, `lang`,
  `provenance`, sections, and every unit with `full`, `brief`, `evidence`, `key`,
  `takeaway`, and `topic`. Local section `takeaway`/`topic` are empty, but units are
  populated. The CLI's Markdown path adds a "No model" warning on stderr, silently falls
  back to English for `--lang`, and raises a Python traceback for a bad `--section`.
  Parsing the JSON once removes all three failure modes and lets the tool validate
  sections and language before returning anything. **Change:** `paper_fold` calls
  `get --json` and renders `map`/`section`/`export` from the parsed document; it does not
  call `get --level` Markdown.
- **Language fallback is silent.** With no model, `get --no-generate --lang zh` prints
  English and exits 0. **Change:** if `lang != en` and `generate:false`, return
  `model-required` before spawning. If `generate:true`, verify `json.lang` and
  `json.provenance.local`; return `model-required` or `translation-unavailable` rather
  than pretending the requested language was produced.
- **Bad sections are a traceback, not an error code.** `_pick` raises
  `ValueError: no section S99` with a Python stack. **Change:** validate `section`
  against the JSON's `sections` array and return `bad-section` with the valid ids.
- **Scanned PDFs exit 0 with no stdout.** The message
  "This PDF needs the PDF engine" goes to stderr. **Change:** detect empty stdout plus
  that message and return `scanned-pdf`; route to `pdf_to_markdown`/`subagent_vision`.
- **Text-PDF structure varies.** The JOSS sample PDF produced only a `Summary` section,
  while the arXiv HTML produced a clean nested map (`S1`, `S2`, `S2.SS1`). Prefer
  HTML/JATS sources; for PDFs, say that the map may be shallow and use the full text or
  `pdf_to_markdown` when it is.
- **`--json` includes full text.** The transfer is local (Python → Node), not into the
  model context; raise the spawn buffer to 64 MB and cap the JSON at a documented size
  (`too-large`) rather than truncating it silently.

---

## 2. Workstream A — `paper_fold`

### 2.1 What the agent gets

A native preset-only tool that turns a known paper (DOI, arXiv ID, PMC ID, URL, or a
workspace file) into a section map, then lets the agent open one section at a time.
This is the context-economy tool: the agent reads the map before spending context on
the full text.

```text
paper_fold action=map ref=2501.12345
  → # Title
    ## 1 Introduction  [S1]
    - Modern deep learning paradigms largely abstract away the temporal dimension
    - This observation motivates our central hypothesis: temporal structure ...
    ## 2 Method  [S2]
    - We split each document into sections and paragraphs
    - ...
    Deeper: action=section level=key section=<id>

paper_fold action=section ref=2501.12345 section=S2 level=key
  → ## 2 Method  [S2]
    **section takeaway, when the document has one**
    - unit point ...
    - unit point ...

paper_fold action=doc ref=2501.12345 write_to=literature/paper.json
  → wrote textfold/doc JSON (source format v0)

paper_fold action=status
  → TextFold 0.10.31 ready · data ... · install: builtin venv
```

### 2.2 Tool contract

File: `paper-fold.js` (new), exported as `academic-harness/paper-fold`, mounted in the
Academic Harness preset only.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `action` | `map \| section \| doc \| export \| status` | `map` | `map` is the orientation call. |
| `ref` | string | required for all but `status` | DOI, arXiv ID, PMC/Europe PMC ID, bioRxiv/medRxiv DOI, URL, or a workspace-relative file path. |
| `level` | `topic \| takeaway \| key \| brief \| full` | `takeaway` for `map`; `key` for `section` | TextFold document levels, coarsest first. Local `topic` is a three-word prefix, so `takeaway` is the useful default map. |
| `section` | string | — | Section id (`S3`), number (`3.2`), or 1-based position, as printed in the map. Required for `section`. |
| `lang` | string | `en` | Translation requires a TextFold model; with `generate: false`, non-`en` returns an actionable error. |
| `generate` | boolean | `false` | Passes no `--no-generate` when true. Only use when the user asks for model-written levels and TextFold has a provider. |
| `write_to` | string | — | Workspace-relative path for `doc` / `export`. |
| `max_chars` | number | 12000 | Inline cap for `map` / `section`; output beyond it points at `write_to`. |

`doc` writes TextFold's `textfold/doc` JSON (`docs/format.md`, version 0). `export` writes
the Markdown at the requested level (default `full`) and is the path for sharing or for a
later explicit PaperMemory ingest. Both require `write_to`; they never dump a full paper
into the transcript.

Output shape:

```js
{
  ok: true,
  action: 'map',
  ref: '2501.12345',
  level: 'takeaway',
  lang: 'en',
  generated: false,
  doc_id: '2501.12345',
  title: 'Constraint Breeds Generalization ...',
  sections: 7,                  // section count, for the caller
  markdown: '...',             // omitted when write_to is set
  write_to: 'literature/paper.json',
  truncated: false,
  textfold_version: '0.10.31',
  warnings: []
}
```

Errors carry `ok: false`, `error_code`, and a plain `error`:
`textfold-missing`, `textfold-install-failed`, `model-required`, `translation-unavailable`,
`no-html`, `no-fulltext`, `no-article`, `scanned-pdf`, `timeout`, `cancelled`, `too-large`,
`path-escapes-workspace`, `bad-section` (with the valid section ids), `bad-ref`.

`presentCall`: generic card, title `Fold paper → <action>`, kind `search`, location when
`ref` is a workspace file.

### 2.3 Runtime and install

File: `textfold-runtime.js` (new).

TextFold is a Python package, not a Node library. Keep it out of `python-helpers/.venv`
(that venv belongs to `sci_inspect` and its scientific dependencies) and out of the
workspace.

- **Home:** `$DSH_HOME/textfold`.
- **Venv:** `$DSH_HOME/textfold/venv` (Windows: `Scripts/python.exe`).
- **Data:** `$DSH_HOME/textfold/data`, passed as `TEXTFOLD_DATA`.
- **Package:** `textfold==0.10.31`, installed from PyPI with `uv` when available, else
  `python3 -m venv` + `pip`. Pin in `TEXTFOLD_VERSION`; the tool verifies the installed
  version and reports drift instead of silently using a newer format.
- **Preparation:** start `ensureTextfoldInstalled()` in the background when the preset
  mounts (non-blocking, like PaperMemory and the AH engine). The tool awaits the same
  promise. First install can take a minute; it must not block plugin installation.
- **Overrides (env only):**
  - `TEXTFOLD_SKIP_INSTALL=1` — never auto-install; use `TEXTFOLD_PYTHON`.
  - `TEXTFOLD_PYTHON=/path/to/python` — an interpreter that already has `textfold`.
  - `TEXTFOLD_CLI=/path/to/textfold` — a CLI entry point instead of `-m textfold`.
  - `TEXTFOLD_DATA=/path` — a different document store.
- **No TextFold server.** Use the CLI (`python -m textfold get ...`) only. Do not start
  `textfold serve`, do not allocate a port, and do not expose a new HTTP surface.
- **Dependencies:** TextFold's normal install. Do **not** install the MinerU PDF engine
  (about 3.4 GB) automatically. Text-based PDFs, arXiv HTML, PMC/JATS, web pages,
  Markdown, and Office files work without it; scanned PDFs return `scanned-pdf` and are
  routed to `pdf_to_markdown` / `subagent_vision` instead.

### 2.4 Model policy

`generate: false` is the default and the recommended path. It fetches/parses the paper and
uses TextFold's local ladders: the author's first sentence stands in for takeaway/brief,
and a short prefix for topic. On HTML/JATS sources that gives a usable section map with
verbatim content at zero model cost; PDF section quality varies (see §1a).

`generate: true` is opt-in and has a deliberate constraint: TextFold needs its own
provider (Claude Code, Codex, Pi, or an OpenAI-compatible endpoint in
`~/.textfold/settings.json`). DSH's model route is not automatically visible to it.
Before spawning, `textfold-runtime.js` forwards provider keys that are already in the
process environment: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY`, and `GEMINI_API_KEY` (the only one of these the plugin's Settings
page currently stores). Provider setup for `generate: true` otherwise belongs to
TextFold itself or to an installed agent CLI; adding provider fields to this plugin's
Settings is a follow-up, not part of this plan. If TextFold reports no model, return
`model-required` with the exact options; never silently fall back to a different
provider.

The tool description and prompt must say this plainly: **local structural levels by
default; model-written levels only when the user asks and a provider exists.** Do not
copy TextFold's "one model call per section" behavior into a default path that spends
the user's quota without consent.

### 2.5 Tool implementation notes

- Parse arguments as a pure function (`buildTextfoldArgs`) so tests do not need Python.
  The only subprocess call is `python -m textfold get <ref> --json [--no-generate]
  [--lang <lang>]`.
- Parse the JSON once. `renderPaperView(document, action, level, section)` returns the
  Markdown for `map`/`section`/`export` and validates the section. Do not invoke
  `get --level` a second time; the JSON already carries every level and every section id.
- `ref` handling:
  - A URL (`http://`, `https://`) or an identifier (DOI, arXiv, PMC, bioRxiv) passes
    through.
  - Anything else is a file. Resolve it inside the session workspace with the same
    containment check `paper-download.js` uses (`resolveWorkspacePath`); reject escapes.
- **Language/provenance gate.** After parsing:
  - `generate:false` + `lang != en` → `model-required` before spawning (TextFold would
    silently return English).
  - `generate:true` + `document.provenance.local` → `model-required`; the request asked
    for generated levels but no provider was found.
  - `generate:true` + `document.lang !== lang` → `translation-unavailable`.
  Never return English while claiming the requested language.
- **Section validation.** Match `section` by `id`, `num`, or 1-based index over
  `document.sections`. On a miss, return `bad-section` with
  `sections: [{ id, num, title }]`; do not spawn again with an invalid id.
- **Process errors.** TextFold does not use exit codes consistently:
  - scanned/image-only PDF → stderr "This PDF needs the PDF engine", stdout empty,
    exit 0 → `scanned-pdf`;
  - no provider with `--no-generate` → a "No model" stderr warning **and** valid JSON on
    stdout; ignore the warning and proceed (the document is local);
  - bad `--section` would be a Python traceback, but the JSON-first path validates first;
  - missing package/venv → `textfold-missing` / `textfold-install-failed`;
  - empty stdout with a known message → map to the documented code; otherwise include the
    last stderr line and the exit code.
- Spawn with a 64 MB `maxBuffer` and a timeout: 2 minutes for `map`/`section` with
  `generate:false`, 10 minutes for `generate:true`, 1 minute for `status`. If stdout
  exceeds the cap, return `too-large` and suggest `pdf_to_markdown` or a section-specific
  read; do not truncate JSON silently.
- Forward cancellation through `exec.signal` when available; kill the child and return
  `timeout`/`cancelled` rather than leaving a Python process behind.
- Inline output is bounded by `max_chars`; `doc`/`export` write to `write_to` via the
  same workspace containment check and return a short confirmation.
- Ignore TextFold's progress lines on stderr in the rendered output; keep the last
  non-progress line only for warnings/errors.
- Do not add `force` in v1: the `get` CLI has no `--force`. Regeneration is done through
  TextFold's own app or by clearing its stored layer. Document that limitation instead
  of inventing a flag that does nothing.

### 2.6 Integration points

| Where | Change |
|---|---|
| `index.js` | **No change** for `paper_fold` (preset-only). |
| `presets/academic-harness/agent.cordis.yml` | Add `- id: paper-fold` / `name: academic-harness/paper-fold` with a comment: preset-only, dedicated venv, local levels by default. |
| `cordis.patch.yml` | Regenerate with `npm run build:patch`; never hand-edit. |
| `package.json` | Add `"./paper-fold": "./paper-fold.js"` and `"./textfold-runtime": "./textfold-runtime.js"` to `exports`; add both files to `files`. |
| `prompt.js` | Add a short `## Reading papers` subsection: map first, section second, full text only when needed; PaperMemory stays the citation source; scanned PDFs go to `pdf_to_markdown`. |
| `skills/literature-researcher/SKILL.md` | Add "call `paper_fold action=map` before reading a paper in full" and the boundary with PaperMemory. |
| `skills/papermemory/SKILL.md` | Add "a `paper_fold` line is orientation, not evidence; quotes and citation keys come from PaperMemory." |
| `README.md` | Add to "What it adds"; add "Read at the right level" under "Downloading and reading papers"; add the runtime/model limits. |
| `NOTICE` | Note the optional TextFold runtime (Apache-2.0) and the version. No code is vendored for workstream A, so this is an acknowledgment, not a copied-code notice. |
| `docs/FOLD-INTEGRATION-PLAN.md` | This file. |

### 2.7 Routing guidance for the model

Add to `## Reading papers` (wording to refine during implementation):

```text
For a paper you already have an identifier, URL, or file for, call paper_fold action=map
before reading it in full. Read the map, then request only the sections that matter:
paper_fold action=section section=S3 level=key. Use pdf_to_markdown when you need the
entire text, when the PDF is scanned, or when you are about to ingest it into PaperMemory.
paper_fold's local levels are the author's first sentences, not evidence for a claim;
for quotes, numbers, and citation keys, use PaperMemory (quote_check, trace, cite).
Do not use paper_fold for discovery or citation; those stay on literature_search and
the academic database tools.
```

### 2.8 Tests

New: `scripts/test-paper-fold.mjs` (plain Node, no network).

- `buildTextfoldArgs` covers `get --json`, `--no-generate`, `--lang`; no `--level` or
  `--section` is ever passed to the CLI.
- `renderPaperView` covers `map` (takeaway by default), `section` (key default, by id,
  number, and 1-based index), `topic`/`takeaway`/`key`/`brief`/`full`, generated vs local
  sections, and the "Deeper" hint.
- Tool registration: name `paper_fold`, required `ref` (except `status`), action enum,
  default `generate: false`.
- A fake `TEXTFOLD_PYTHON` script prints canned JSON:
  - map renders section titles, ids, and unit takeaways;
  - section selects `S2.SS1` by id and `2` by number;
  - `doc` writes the raw JSON to the workspace and does not inline the full document;
  - `export` renders Markdown at the requested level;
  - path traversal is rejected;
  - missing package / install failure / `No model` fallback / scanned PDF / language
    fallback / bad section map to the documented error codes;
  - output over `max_chars` is truncated and points at `write_to`.
- Static assertions: `package.json` export and files entry; preset row; `prompt.js`
  markers; `README.md` marker; no `paper_fold` mention in optional-tools-only contexts.

CI integration (`.github/workflows/verify.yml`):

- Add a Python step `pip install 'textfold==0.10.31'` and run:
  - `node scripts/test-paper-fold.mjs`
  - a real offline smoke on a small Markdown fixture with
    `TEXTFOLD_PYTHON="$(command -v python)" paper_fold action=map generate=false`,
    asserting the output contains a section id and makes no model call.
- Keep the existing `npm run build:patch -- --check` and `npm run build` checks.

Add `paper-fold` to the README's test loop. `scripts/test-paper-fold.mjs` covers the
package/files/preset assertions; `scripts/test-nonsearch-tools.mjs` is unchanged.

### 2.9 Acceptance criteria

- `paper_fold action=map` on a local Markdown paper returns a `takeaway`-level map with
  section ids and makes no network or model call.
- `action=section` on a map id returns that section at `key` or `brief`, with the original
  section id printed; an unknown section returns `bad-section` and the valid ids.
- `action=doc` / `action=export` write only inside the workspace and never dump the whole
  document into the transcript.
- `action=status` reports the TextFold version, data directory, and install state.
  Model availability is discovered on the first `generate: true` call, not guessed by
  `status` (TextFold's provider scan touches local agent binaries and is too slow for a
  status ping).
- A missing install, missing model, requested-but-unavailable language, scanned PDF, and
  an unsupported DOI each return one of the documented error codes with an actionable
  next step. A local-level response is never presented as model-written.
- A repeated call reuses TextFold's stored layers; no re-fetch or re-fold.

---

## 3. Workstream B — reply folding

Reply folding has two independent pieces. B1 (engine + tool + prompt) ships first and has
no UI risk. B2 (inline fold panel) is additive and can be disabled by removing one client
registration.

### 3.1 Levels

Keep TextFold's reply-level names, which are already clearer for chat than the document
levels:

| Level | What remains |
|---|---|
| `full` | the reply as written |
| `brief` | the first one or two sentences of each paragraph, one per list item |
| `points` | the first sentence of each paragraph and list item |
| `outline` | headings plus the first sentence under each; falls back to `points` when the reply has no headings |
| `gist` | the reply's first sentence |

Short replies (under about 80 words) and folds that hide less than 25% stay whole. These
thresholds come from TextFold's mod; they are deliberate, not arbitrary.

### 3.2 B1 — `fold-core.js` and `fold_text`

**`fold-core.js`** (new, pure ESM, no Node or React imports; shared by host and client):

- Port the block parser and fold logic from
  `plugins/textfold/hooks/fold.ts`, adapted to DSH:
  - keep headings, paragraphs, lists, tables, code fences, blockquotes, rules;
  - drop Pi's "art row" detection (DSH renders Mermaid separately);
  - keep CJK sentence terminators (`。！？`) and the abbreviation guard;
  - protect inline code and balance `**`/backtick spans cut by a fold;
  - return both `text` and structured `blocks` so the client can render without
    re-parsing;
  - expose `worthFolding`, `foldReply`, `foldStats`, `firstSentence`.
- Attribution header points at the TextFold source file, commit `2182d9a`, Apache-2.0.

**`fold-text.js`** (new, host-level tool; register from `index.js` with the other
general tools):

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `text` | string, required | — | Markdown to fold; 200k-character cap. |
| `level` | `full \| brief \| points \| outline \| gist` | `brief` | |
| `format` | `markdown \| json` | `markdown` | JSON returns text + stats + blocks. |
| `write_to` | string | — | Workspace-relative path; otherwise inline. |

Returns `{ ok, level, folded, text, stats: { words_before, words_after, hidden_ratio }, truncated }`.
If the text is too short or the fold hides too little, returns the original with
`folded: false` and a one-line reason. `presentCall` card: `Fold text → Brief`.

Why host-level: it has no dependencies and is useful in any preset. The prompt section
that makes folds read well is preset-scoped (see B2).

### 3.3 B2 — point-first response prompt

**File:** `prompt-section.js` (add a second `ctx.systemPrompt.section`, or a small new
`response-shape.js` mounted as a preset row).

```text
## Response shape

- Open with the answer or decision, not with what you are about to do.
- In every paragraph and list item, put the sentence that states its point first;
  the rest is evidence, mechanism, or qualification.
- Keep headings for long replies. Do not add a separate "Summary" section just to
  satisfy this; the fold uses what is already first.
- Tool output and code blocks are not folded. Write the prose around them so the
  first sentence still carries the point.
```

Why a separate section: it changes the shape of every reply, so it should be isolatable
and easy to disable/measure. It also has a one-time prompt-cache cost; keep it short.
Add a test asserting the section exists and is preset-scoped (not global).

### 3.4 B3 — inline fold panel in the DSH chat

**Files:** `client/reply-fold.js` (selector, shared content/view), `client/ReplyFold.jsx`,
`client/FoldPane.js` (Phase 4a right-dock body), `client/index.js` (registration),
`lib/client.js` (rebuilt and committed).

**Registration.** Add a list entry to `conversation.chat.turnTail`:

```js
ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
  name: 'conversation.chat.turnTail',
  id: 'academic-harness-reply-fold',
  order: 40,
  inject: () => ({ openFoldPane }), // Phase 4a: opens the right-dock pane
}, ReplyFold))
```

**Why `turnTail`, not `conversation.chat.node`.** DSH exposes a keyed assistant node
renderer, but replacing it means reimplementing DSH's Markdown, image, link, streaming,
and action behavior. `turnTail` is an additive list seat under a completed turn: the
official transcript is untouched, and the fold panel is opt-in. This is the seamless
adaptation; do not replace the assistant renderer in v1.

**Reading the reply.** The turn-tail contribution receives the session standard props.
Use `useChat` (augmented by `dsh-client-ui-chat` on `SessionStandardProps`) with one pure
selector per turn:

```js
const text = useChat((snapshot) => {
  const keys = snapshot.locations.getTurn(turn)
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const node = snapshot.nodes.get(keys[i])
    if (node?.kind !== 'assistant-step') continue
    const blocks = node.data.finalNode?.blocks ?? node.data.blocks ?? []
    return blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n\n')
  }
  return ''
})
```

This ignores reasoning and tool blocks, and does not fold a still-streaming reply (the
turn tail appears when the turn closes). If `useChat` is not injected in the target DSH
version, the spike must either use `useSession`'s event store or fall back to a
`conversation.chat.assistant-actions` entry; do not scrape the DOM.

**UI.**

- If the text is under the minimum or the fold hides too little, render nothing.
- Otherwise render a small row: `Read folded:` + `Full`, `Brief`, `Points`, `Outline`,
  `Gist` buttons. `Full` is the default and closes the panel.
- Selecting another level expands a bordered panel below the row with the folded text.
  The original message stays above it, untouched and fully selectable.
- Render the structured blocks directly in React (`<p>`, `<ol>/<ul>`, `<pre><code>`,
  `<table>`, `<blockquote>`, heading-styled `<p>`). Use React text nodes, never
  `dangerouslySetInnerHTML`. A small inline renderer handles `` `code` ``, `**bold**`,
  and `*italic*`; links stay as text in v1 (the official transcript still has the real
  links). Do not add a Markdown dependency just for this panel.
- Keep the last chosen level in `localStorage` (`ah-fold-level`); default `full`.
- Accessibility: `aria-pressed`, `aria-expanded`/`aria-controls` on the selected level,
  and a labeled panel (`"Folded reply, Brief level"`); keyboard operation of the buttons.
  Do not bind global 1–5 keys: the composer owns digits.
- Theme: use existing DSH CSS variables with neutral fallbacks; light/dark and narrow
  widths must be checked manually.
- No new **runtime** client dependency and no new `dsh.client.inject` entries are
  required; React is external. `react`/`react-dom` were added as devDependencies only
  for the server-render test.

**Right-sidebar pane (Phase 4a):** implemented in `client/FoldPane.js` and opened by
the inline row's `Open in sidebar` action. It reuses the same fold engine and level
row, lives in one tab that updates when another reply is opened, and never replaces the
inline row, which remains the primary view.

### 3.5 Tests

`scripts/test-fold.mjs` (plain Node):

- Block parsing: headings, paragraphs, ordered/unordered lists, tables with and without
  leading pipes, code fences, blockquotes, rules.
- Fold behavior: `brief` keeps two sentences per paragraph, `points` one, `outline`
  falls back to `points` without headings, `gist` keeps the first sentence.
- Safety: inline code containing `.`/`?`, abbreviations (`e.g.`, `Fig.`, `et al.`),
  bold/code spans cut at a sentence boundary, CJK stops, mixed CJK/Latin.
- Guards: short reply unchanged; a fold hiding less than 25% returns the original;
  empty text; 200k cap.
- Tool: registration, `format: 'json'`, `write_to`, path escape rejection, truncated
  inline output.
- Static: `index.js` registers `applyFoldText`; `package.json` export/files;
  `prompt-section.js` contains the response-shape section; README/NOTICE/CI markers.

`scripts/test-reply-fold.mjs` uses React 18 server rendering (dev-only
`react`/`react-dom`) to check:

- `closingAssistantText` picks the last text-bearing assistant-step and ignores
  reasoning, other turns, and malformed snapshots;
- all five levels, the Full close, the outline→points fallback, short/empty text,
  CJK, table/code/list rendering, nested code inside bold, ARIA state, and the
  CSS-variable fallbacks;
- `readFoldLevel`/`writeFoldLevel`, `client/index.js`'s turn-tail registration,
  the rebuilt `lib/client.js`, and the docs/CI wiring.

The real UI matrix was run with `agent-browser` against the Academic Harness profile
and an existing long session:

- short replies would have no row (the 80-word/25% gate is covered by the engine and
  renderer tests);
- a long headed reply showed Full / Brief / Points / Outline / Gist; Full closed the
  panel; Outline fell back to Points for a reply without headings;
- list, table, and nested bold+code rendered in the real UI; fenced code is covered by
  the renderer tests; the original reply stayed above the panel and selectable;
- the chosen level persisted across a page reload;
- the row appeared in the turn tail before the standard copy/feedback actions, in the
  dark theme.

The browser console was not separately captured; no visible UI errors appeared during
the session.

Add `reply-fold` to the README test loop and to `.github/workflows/verify.yml`'s
non-search step.

### 3.6 Acceptance criteria

- `fold_text` turns a 1,000-word Markdown reply into the five levels without changing a
  word; a short reply comes back unchanged with `folded: false`.
- The response-shape section is present only on the Academic Harness preset.
- A completed reply longer than the threshold shows the fold row; each level renders;
  the original transcript is untouched; the chosen level persists in the browser.
- No new runtime dependency, no second model call, and no change to tool output
  rendering. React/ReactDOM are devDependencies for the server-render test only.

---

## 4. File change map

| File | Workstream | Change |
|---|---|---|
| `paper-fold.js` | A | New preset-only tool. |
| `textfold-runtime.js` | A | Dedicated venv, install, spawn, model env. |
| `fold-core.js` | B | Pure block/fold engine, shared host/client. |
| `fold-text.js` | B | New host-level tool. |
| `client/reply-fold.js` | B | Selector, persisted level, shared content/level row, inline view. |
| `client/ReplyFold.jsx` | B | Turn-tail container. |
| `client/FoldPane.js` | B | Right-dock folded reading pane (Phase 4a). |
| `client/index.js` | B | Turn-tail entry, fold tab type/body, sidebar service injection. |
| `lib/client.js` | B | Rebuilt with `npm run build`; committed. |
| `index.js` | B | Register `applyFoldText(ctx)`. |
| `prompt-section.js` | B | Add the response-shape system-prompt section. |
| `prompt.js` | A/B | Add `## Reading papers`; reference `fold_text` where relevant. |
| `presets/academic-harness/agent.cordis.yml` | A | Add the `paper-fold` row. |
| `cordis.patch.yml` | A | Regenerated, not hand-edited. |
| `package.json` | A/B | Exports, files, test scripts, client sidebar inject. |
| `scripts/test-paper-fold.mjs` | A | New; 85 checks with a fake CLI. |
| `scripts/test-paper-fold-live.mjs` | A | New; 14 checks against a real TextFold. |
| `scripts/fixtures/fake-textfold.mjs` | A | Fake CLI fixture for the managed-runtime tests. |
| `scripts/test-fold.mjs` | B | New; 82 checks. `test-nonsearch-tools.mjs` unchanged. |
| `scripts/test-reply-fold.mjs` | B | New; 55 checks with React server rendering. |
| `.github/workflows/verify.yml` | A/B | New tests + TextFold install + live test; boot skips managed install. |
| `README.md` | A/B | Feature list, reading workflow, reply folding, test loop, release notes. |
| `NOTICE` | A/B | Ported reply-fold engine attribution; TextFold runtime note. |
| `skills/literature-researcher/SKILL.md` | A | Map-first reading guidance. |
| `skills/papermemory/SKILL.md` | A | Boundary: orientation vs evidence. |
| `docs/FOLD-INTEGRATION-PLAN.md` | A/B | This plan. |

No changes to `mcp-connectors.js`, `settings-keys.js`, `papermemory.js`, or the existing
search/citation tools. `paper_fold` is not a connector and needs no API-key field.

---

## 5. Rollout

### Phase 0 — spike (done, see §1a)

- DSH `0.2.1-rc.2` injects `useChat`/`sessionId` into `conversation.chat.turnTail`;
  the inline turn-tail design is confirmed, no fallback needed.
- `textfold==0.10.31` installs from PyPI in an isolated `uv` venv; offline `get` works on
  Markdown and arXiv HTML; a text PDF may produce a shallow map; a scanned PDF returns
  the PDF-engine message with exit 0.
- Local `takeaway` is the useful map level; local `topic` is too weak. The CLI's
  `--lang` fallback is silent, so `paper_fold` must verify JSON `lang`/`provenance`.
- Decision: one `get --json` call, render views in JS, validate sections and language
  before returning.

### Phase 1 — `fold_text` + response shape (done)

Implemented:

- `fold-core.js` — shared pure engine; string levels, structured blocks, no Pi
  art-row detection, CJK sentence handling, and the 80-word/25% gate.
- `fold-text.js` — host-level `fold_text`, registered from `index.js`; 200k-character
  cap, `write_to` with workspace/symlink containment, JSON output with stats/blocks.
- `prompt.js` / `prompt-section.js` — `RESPONSE_SHAPE` as its own preset-scoped section
  (`order: 21`), leaving the main prompt untouched.
- `scripts/test-fold.mjs` — 82 checks, including the TextFold fold fixtures, DSH
  structured blocks, path and symlink escapes, schema validation, and static wiring.
- README "Reply folding", release note, NOTICE attribution, CI test entry.

Deviation from the file map: `scripts/test-nonsearch-tools.mjs` is not modified.
`fold_text` is host-level like `mermaid_render`, so the dedicated `test-fold.mjs` is
the closer convention and keeps all fold assertions in one place. `package.json` lists
`fold-core.js` and `fold-text.js` under `files` but deliberately does not export them
(host-level tools are not public exports, matching `mermaid_render`).

### Phase 2 — `paper_fold` (done)

Implemented:

- `textfold-runtime.js` — pinned `textfold==0.10.31`; managed venv under
  `$DSH_HOME/textfold`, data under `$DSH_HOME/textfold/data`; background prepare on
  preset mount; `uv` → venv+pip fallback; version check for the managed install;
  `TEXTFOLD_PYTHON` / `TEXTFOLD_CLI` / `TEXTFOLD_SKIP_INSTALL` / `TEXTFOLD_DATA`
  overrides; bounded process runner with timeout and abort signal; provider env
  forwarding.
- `paper-fold.js` — preset-only `paper_fold` with `map`, `section`, `doc`, `export`,
  `status`; one `get --json` call; JS renderer; language/provenance gates;
  section validation; workspace/symlink-safe writes; 12k inline cap with `write_to`;
  `bad-section` returns the valid ids.
- Preset row in `presets/academic-harness/agent.cordis.yml`, regenerated
  `cordis.patch.yml`, package exports/files, prompt `## Reading papers at the right
  level`, literature-researcher and papermemory skill boundaries, README section,
  NOTICE runtime note.
- `scripts/test-paper-fold.mjs` — 85 checks with a fake CLI and fixture.
- `scripts/test-paper-fold-live.mjs` — 14 checks against a real `textfold==0.10.31`;
  CI installs the package and runs it with `TEXTFOLD_LIVE_REQUIRED=1`, and the boot
  check uses `TEXTFOLD_SKIP_INSTALL=1`/`TEXTFOLD_PYTHON=python` to avoid a managed
  install during boot.

Manual checks on the real tool:

| Source | Result |
|---|---|
| arXiv HTML (`2512.23916`) | 18 sections; clean nested map (`S1`, `S2`, `S2.SS1`) |
| PMC/JATS via DOI (`10.1371/journal.pone.0000308`) | 12 sections; PMC metadata |
| Text PDF (JOSS) | one shallow `Summary` section, as predicted; use `pdf_to_markdown` for depth |
| Scanned image-only PDF | `scanned-pdf`, routed to `pdf_to_markdown`/`subagent_vision` |
| Paywalled DOI (`10.1038/nature12373`) | `no-fulltext` |
| Local Markdown | map/section/doc/export/status all pass |
| Model-written levels | `generate:true` used Claude Code and reported `generated:true`; no provider returns `model-required` |

The managed installer was also smoke-tested into a throwaway `DSH_HOME`; it created
the venv, installed 0.10.31, and served a real `get --json`.

Deviation from the plan: no second `get --level` call. The JSON-first design from
Phase 0 is implemented, which is why the language and section gates are exact.

### Phase 3 — reply fold panel (done)

Implemented:

- `client/reply-fold.js` — `closingAssistantText` selector (last text-bearing
  assistant-step; reasoning and tools excluded), persisted `ah-fold-level`, and a
  presentational `ReplyFoldView` with structured block rendering, inline
  code/bold/italic/link handling, ARIA state, and CSS-variable fallbacks.
- `client/ReplyFold.jsx` — the `conversation.chat.turnTail` container; `useChat`
  supplies the closing reply, `useState`/`localStorage` hold the level.
- `client/index.js` — the additive turn-tail registration
  (`academic-harness-reply-fold`, order 40) and the right-dock tab type/body
  registration (Phase 4a).
- `lib/client.js` — rebuilt; the bundle includes the registration and the shared
  `fold-core.js`.
- `scripts/test-reply-fold.mjs` — 55 checks: selector behavior, all five levels,
  table/code/list rendering, nested inline code inside bold, CJK, short text,
  persisted level, Full-content rendering, the right-dock pane body, static
  registration, built bundle, and docs/CI wiring.
- `package.json` — `react`/`react-dom` devDependencies for server rendering;
  `test:reply-fold`; `@deepseek-ai/dsh-client-ui-sidebar-right` in the client inject list.
- README "Read folded:" paragraph and release note; CI runs the test.

Real UI verification (Academic Harness profile, existing long sessions, dark theme):

- the row appeared under both long replies, before the standard action row;
- Full closed the panel; Brief, Points, Outline, and Gist rendered;
- a reply without headings read as Points at Outline, as designed;
- the table, list, and nested bold+code rendered in the real UI; fenced code is covered
  by the server-render test;
- the selected level persisted across a page reload;
- the original replies stayed above the panel and remained selectable.

### Phase 4a — right-sidebar folded pane (done)

Implemented:

- `client/FoldPane.js` — the right-dock body. It reads the reply and level from the
  tab's navigation params, keeps its own level state, writes the shared
  `ah-fold-level` preference, and renders the shared `FoldContent`/`FoldLevelRow`.
  Full shows all of the reply's prose in the pane.
- `client/index.js` — registers the tab type with `ctx.sidebarRightTabs.register`
  (`id`/`kind` `academic-harness-reply-fold-pane`, `keepMounted: true`) and the body
  under `sidebar.right.pane.tab`; the turn-tail `inject` supplies `openFoldPane`,
  which calls `ctx.sidebarRight.openTab(kind, { params: { text, level } })`.
- `client/reply-fold.js` — exports `FoldContent` and `FoldLevelRow`; `foldReply(full)`
  now returns rendered structured blocks so the pane's Full level shows the whole reply.
- `package.json` — `@deepseek-ai/dsh-client-ui-sidebar-right` added to the client
  inject list; `react`/`react-dom` remain dev-only test dependencies.
- `scripts/test-reply-fold.mjs` — 55 checks, including `FoldContent` Full/Points,
  `FoldPane` server rendering, the empty state, the sidebar action, and sidebar wiring.

Real UI verification (Academic Harness profile, existing long session, dark theme):

- `Open in sidebar` opened the right dock with a **Read folded** tab;
- the pane showed the reply and its own Full / Brief / Points / Outline / Gist row;
- Full showed all of the reply's prose including the table; Brief truncated list items;
- opening another reply reused the same tab and updated its content and level;
- the tab's close, split, and fullscreen controls remained available;
- the inline row remained above the original reply and was unaffected.

The tab is one per session and updates in place. Navigation params are not part of the
sidebar's persisted layout, so after a page reload the pane shows a short “Open a reply
with Open in sidebar” hint until opened again from the row.

### Phase 4b — other follow-ups (optional)

- Explicit PaperMemory export/ingest for `paper_fold` (after deciding record identity:
  reuse the existing PaperMemory record by DOI/PDF hash; do not create a second paper).
- Agent-authored levels (`paper_fold action=prepare` → agent writes JSON → `action=save`)
  for users without a TextFold provider. This uses DSH's model but costs turns/context;
  design it only if the local-level map is not enough in practice.
- A `TEXTFOLD_MODEL`/provider field in Settings only if real users hit the model gap
  repeatedly; do not add provider management for a first release.

Phases 0–3 and 4a are complete; 4b remains optional.

---

## 6. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| TextFold package/CLI drift | tool breaks after an upstream release | Pin `0.10.31`; version check; CI integration on a Markdown fixture; error says how to update. |
| Python install fails (offline, no `uv`) | `paper_fold` unavailable | Prepare in background; `TEXTFOLD_PYTHON`/`TEXTFOLD_CLI` overrides; `action=status` diagnostics; the rest of the preset still loads. |
| Model provider mismatch | `generate:true` fails or surprises with cost | Default `generate:false`; explicit `model-required`; never auto-select a provider; document TextFold's own settings. |
| Scanned PDFs need MinerU | users expect every PDF to fold | Return `scanned-pdf` and route to `pdf_to_markdown`/`subagent_vision`; do not auto-install 3.4 GB. |
| Duplicate paper stores | PaperMemory and TextFold diverge | No auto-ingest in v1; PaperMemory stays the citation source; explicit export only. |
| DSH slot API change | fold panel disappears or misrenders | Additive turn-tail entry; spike the props first; the engine/tool remain useful without the UI. |
| Reply-shape prompt changes reply quality | users dislike the style | Short, separate prompt section; measure on a sample; easy to remove; no global prompt change. |
| Folded panel duplicates text | copy/search confusion | Panel is collapsed by default, clearly labeled, original remains; no DOM replacement. |
| License/attribution | compliance | Apache-2.0 notice in `NOTICE` for the port; TextFold runtime acknowledged in README; no vendored reader code. |
| Auto-install is a supply-chain surface | trust concern | Pinned PyPI version, opt-out env, no arbitrary git installs; document the install location. |

---

## 7. Verification commands

```sh
# host-level, preset-only, and reply-view wiring
node scripts/test-fold.mjs
node scripts/test-reply-fold.mjs
node scripts/test-paper-fold.mjs
node scripts/test-nonsearch-tools.mjs

# generated preset and client bundle
npm run build:patch
npm run build
git diff --exit-code -- lib/ cordis.patch.yml

# real TextFold CLI, no model
python -m pip install 'textfold==0.10.31'
TEXTFOLD_LIVE_REQUIRED=1 TEXTFOLD_SKIP_INSTALL=1 TEXTFOLD_PYTHON="$(command -v python)" \
  node scripts/test-paper-fold-live.mjs

# manual
dsh --profile academic-harness
```

Manual paper checks: an arXiv HTML paper, a PMC/JATS paper, a text-based PDF, a scanned
PDF, a DOI without open full text, and a local Markdown file. Manual reply checks: short,
long headed, list/table/code, CJK, multi-turn, session switch, light/dark, narrow pane.

---

## 8. Decisions to confirm before implementation

1. **`paper_fold` default-on vs gated.** Recommendation: default-on in the Academic
   Harness preset, with background install and `TEXTFOLD_SKIP_INSTALL=1`. It is a
   headline reading feature, and the plugin already auto-provisions PaperMemory and
   zvec-grep. If a heavy Python install at first mount is unacceptable, gate it behind
   `AH_ENABLE_OPTIONAL_TOOLS` like the Phase 6/7 tools.
2. **`generate:true` in v1.** Recommendation: keep it, but only as an explicit opt-in
   with `model-required` errors. Do not add a provider-management UI.
3. **Reply fold placement.** Recommendation: inline turn-tail panel (additive, no
   renderer replacement). Revisit a right-sidebar pane only after real use.
4. **PaperMemory export.** Recommendation: defer auto-ingest. Add an explicit
   `export` + ingest path after defining how to merge with an existing DOI/PDF record.

---

## 9. Source mapping appendix

| Academic Harness piece | TextFold source | Adaptation |
|---|---|---|
| `paper_fold` | `textfold/__main__.py` (`get`), `fold.py` (Markdown/JSON), `ladder.py`, `parse.py`, `jats.py`, `office.py`, `zotero.py` not included | Call the Python CLI; do not port the reader or storage. Local levels by default. |
| TextFold document levels | `docs/format.md`, `ladder.py` | Expose `topic/takeaway/key/brief/full`; preserve `evidence` and provenance in JSON. |
| `fold-core.js` | `plugins/textfold/hooks/fold.ts` | Port the block parser and fold, drop Pi art rows, add structured blocks and CJK tests. |
| Response shape | `plugins/textfold/hooks/fold.ts` + README, "Why you can trust a fold" | Short preset-scoped prompt section; no Claude-specific wording. |
| Reply UI | `plugins/textfold/hooks/register.tsx`, `plugins/textfold/hooks/fold.ts` | DSH `conversation.chat.turnTail`; original transcript untouched; no global 1–5 keys. |
| Model providers | `textfold/models.py`, `agents.py`, `providers.py` | Not ported. TextFold's own provider detection; no DSH model bridge in v1. |

TextFold is Apache-2.0, © 2026 Xia Chen. The `fold.ts` port must keep its Apache-2.0
notice, and `NOTICE` must name the file, the commit, and the modifications. The Python
package is an optional runtime dependency; it is not vendored.

---

## 10. What this plan deliberately does not do

- Port the TextFold web reader, desktop app, or its visual zoom.
- Add Zotero, Obsidian, WebMCP, or the static gallery (Zotero was previously removed from
  this plugin and is not reintroduced here).
- Replace DSH's assistant renderer.
- Add a second model/provider manager.
- Auto-ingest into PaperMemory.
- Change the existing `pdf_to_markdown`, `paper_download`, search, citation, or memory
  tools. `paper_fold` is additive; `pdf_to_markdown` remains the full-text and
  PaperMemory-ingest path.
