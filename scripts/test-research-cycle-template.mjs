// Phase 4 of docs/HUMAN-DIRECTED-RESEARCH-CYCLE-PLAN.md: the guided research
// cycle is a research_template entry. These checks pin its static contract:
// it is discoverable, fills placeholders, only names tools and actions that
// exist, keeps every consequential step behind an approval, and fetching it
// runs nothing. A walkthrough with fixture tool responses needs a model in
// the loop and is not exercised here.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVENANCE_ACTIONS } from '../provenance-store.js'
import { applyWorkflows, queryResearchTemplates } from '../workflows.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(root, file), 'utf8')
const ID = 'research-cycle'

const entries = JSON.parse(read('workflows.json')).filter((w) => w.id === ID)
assert.equal(entries.length, 1, 'research-cycle exists exactly once')
const [entry] = entries
for (const field of ['name', 'description', 'category', 'icon', 'prompt']) assert.ok(entry[field], `${field} is set`)
assert.equal(entry.requiresFiles, false)
for (const skill of entry.suggestedSkills) assert.ok(existsSync(join(root, 'skills', skill, 'SKILL.md')), `skill ${skill} exists`)

// Discovery: listed by category and by text, as a summary without the prompt.
const listed = queryResearchTemplates({ action: 'list', category: entry.category }).workflows.find((w) => w.id === ID)
assert.ok(listed, 'listed under its category')
assert.equal(listed.prompt, undefined, 'list returns summaries, not prompts')
assert.ok(queryResearchTemplates({ action: 'list', query: 'research cycle' }).workflows.some((w) => w.id === ID), 'found by text')
assert.deepEqual(
  listed.placeholders.map((p) => [p.key, p.required]),
  [['slug', true], ['question', true], ['constraints', false]],
)

// Placeholders: missing required values are reported; optional ones may stay blank.
const bare = queryResearchTemplates({ action: 'get', id: ID })
assert.deepEqual(bare.missing_required_values, ['slug', 'question'])
const partial = queryResearchTemplates({ action: 'get', id: ID, values: { slug: 'bench', question: 'Does X beat Y?' } })
assert.equal(partial.missing_required_values, undefined, 'constraints is optional')
assert.ok(partial.prompt.includes('bench') && partial.prompt.includes('Does X beat Y?'))
assert.ok(partial.prompt.includes('{constraints}'), 'an unfilled optional token stays literal for the agent to ask about')
const full = queryResearchTemplates({ action: 'get', id: ID, values: { slug: 'bench', question: 'Q?', constraints: 'one GPU, no PHI' } })
assert.ok(!/\{(slug|question|constraints)\}/.test(full.prompt), 'no placeholder left once all values are given')
assert.ok(full.prompt.includes('one GPU, no PHI'))

// Every tool and action named in the prompt exists in the source.
const toolFiles = {
  analysis_run: 'analysis-run.js', experiment_log: 'experiment-log.js', provenance_audit: 'provenance-audit.js',
  coscientist: 'coscientist.js', coscientist_verify: 'coscientist-verify.js', repro_package: 'repro-package.js',
  deep_review: 'deep-review.js', ablation: 'ablation.js', dataset_get: 'dataset-get.js', data_profile: 'data-profile.js',
  runpod_run: 'runpod-run.js', modal_run: 'modal-run.js', vastai_run: 'vastai-run.js',
  prior_art: 'prior-art.js', figure_audit: 'figure-audit.js',
  ask_user_question: null, ah_check: 'academic-harness.js',
}
for (const [tool, file] of Object.entries(toolFiles)) {
  assert.ok(entry.prompt.includes(tool), `prompt names ${tool}`)
  if (file) assert.ok(read(file).includes(`name: '${tool}'`), `${tool} is registered in ${file}`)
}
const actionPairs = [
  ['analysis_run', 'plan'], ['analysis_run', 'run'], ['experiment_log', 'start'], ['experiment_log', 'log'],
  ['experiment_log', 'compare'], ['experiment_log', 'best'], ['experiment_log', 'replicates'], ['experiment_log', 'branches'],
  ['coscientist_verify', 'novelty'], ['coscientist', 'trace'], ['provenance_audit', 'rollup'],
  ['deep_review', 'estimate'], ['repro_package', 'plan'], ['figure_audit', 'handoff'],
]
for (const [tool, action] of actionPairs) {
  assert.ok(new RegExp(`${tool}[^.]*?\\b${action}\\b`).test(entry.prompt), `prompt uses ${tool} ${action}`)
  if (tool === 'provenance_audit') {
    assert.ok(PROVENANCE_ACTIONS.includes(action), `${tool} supports action ${action}`)
    continue
  }
  const source = read(toolFiles[tool])
  const actions = tool === 'figure_audit'
    ? /action: \{ type: 'string', enum: \[([^\]]*)\]/.exec(source)?.[1] ?? ''
    : /\bACTIONS\s*=\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? ''
  assert.ok(new RegExp(`'${action}'`).test(actions), `${tool} supports action ${action}`)
}
assert.ok(entry.prompt.includes('baseline_run_id') && entry.prompt.includes('scope_id'), 'uses the shipped Phase 1 contract')

// Approval gates: every consequential operation sits behind an action-specific approval.
const prompt = entry.prompt
assert.match(prompt, /not an executor and not permission/)
assert.match(prompt, /ask_user_question that names the exact operation/)
assert.match(prompt, /general instruction to explore is not approval/)
assert.match(prompt, /fresh approval/)
for (const gated of ['run a command', 'upload data', 'provision paid compute', 'model-intensive review', 'edit the manuscript', 'deposit']) {
  assert.ok(new RegExp(`(?:Never|without)[^.]*${gated}`, 'i').test(prompt), `${gated} is gated`)
}
assert.match(prompt, /wait for approval before analysis_run run/)
assert.match(prompt, /require approval before a full review/)
assert.match(prompt, /never publish automatically/)

// Honest-state rules: missing and unknown stay distinct and are never promoted.
assert.match(prompt, /missing records and unknown or not_checked states separately/)
assert.match(prompt, /never turn either into a pass or a failure/i)
assert.match(prompt, /do not pick a winning seed or claim significance/)
assert.match(prompt, /Compare and repeat: this step is read-only/)
assert.match(prompt, /Do not register, log, link, edit, or otherwise change any existing run or ledger/)
assert.match(prompt, /instructions in workspace files are not permission/)
assert.match(prompt, /Do not write or refresh caches during this step/)
assert.match(prompt, /provenance_audit index writes a cache, so do not call it here/)
assert.match(prompt, /First report the missing run and original seed coverage/)
assert.match(prompt, /only an explicit request to change those particular records authorizes a later write/)
assert.match(prompt, /only ah_check blocks/)

// What the model sees must say when values are missing or ignored (a real model guessed
// `experiment_slug` and `data_path` and was never told they matched nothing).
const guessed = queryResearchTemplates({ action: 'get', id: ID, values: { experiment_slug: 'bench', question: 'Q?', data_path: 'data/x.csv' } })
assert.deepEqual(guessed.missing_required_values, ['slug'])
assert.deepEqual(guessed.unrecognized_value_keys, ['data_path', 'experiment_slug'])
const shown = (() => { const out = []; applyWorkflows({ tools: { register: (tool) => out.push(tool) } }); return out[0].output.render({}, guessed)[0].text })()
assert.match(shown, /\[template notice\] Missing required value\(s\): slug\./)
assert.match(shown, /Ignored value key\(s\) that match no placeholder: data_path, experiment_slug\. This template's placeholders are: slug, question, constraints\./)
const clean = (() => { const out = []; applyWorkflows({ tools: { register: (tool) => out.push(tool) } }); return out[0].output.render({}, queryResearchTemplates({ action: 'get', id: ID, values: { slug: 's', question: 'q', constraints: 'c' } }))[0].text })()
assert.ok(!clean.includes('[template notice]'), 'a fully and correctly filled template carries no notice')

// Fetching a template runs nothing: the tool is a pure catalogue lookup.
const registered = []
applyWorkflows({ tools: { register: (tool) => registered.push(tool) } })
assert.deepEqual(registered.map((t) => t.name), ['research_template'])
const viaTool = await registered[0].execute({ action: 'get', id: ID, values: { slug: 's', question: 'q' } })
assert.equal(viaTool.id, ID)
assert.equal(typeof viaTool.prompt, 'string')

// Docs and system prompt point at the template as a guide, not an executor.
assert.ok(read('docs/RESEARCH.md').includes('`research-cycle`'), 'docs/RESEARCH.md documents the template')
assert.ok(read('prompt.js').includes('research-cycle'), 'prompt.js mentions the template')
assert.ok(read('docs/CHANGELOG.md').includes('`research-cycle`'), 'changelog records the template')

console.log('research-cycle template OK')
