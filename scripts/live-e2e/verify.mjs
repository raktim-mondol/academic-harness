#!/usr/bin/env node
// Assert on the receipt of a live end-to-end run (see provider.mjs / steps.mjs).
//   node verify.mjs <receipt.json> <workspace>
// These are observations of the real host + plugin + tools, not of a model.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [receiptFile, workspace] = process.argv.slice(2)
if (!workspace) throw new Error('usage: node verify.mjs <receipt.json> <workspace>')
const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
const H = Object.fromEntries(receipt.history.map((h) => [h.step, h]))

assert.equal(receipt.finished, true, 'the scripted session finished')
assert.equal(receipt.history.length, receipt.total_steps)
assert.deepEqual(receipt.history.filter((h) => h.is_error).map((h) => `${h.step} ${h.name}: ${h.text.slice(0, 120)}`), [], 'no tool call failed in the real host')
for (const tool of ['research_template', 'experiment_log', 'analysis_run', 'figure_audit', 'prior_art', 'literature_search', 'subagent_vision']) assert.ok(receipt.declared_tools.includes(tool), `${tool} is declared to the model`)

assert.match(H[0].text, /Guide the human-directed research cycle/)
assert.match(H[0].text, /not an executor and not permission/, 'the guide states it grants no permission')
assert.match(H[2].text, /Comparison scope \(user-declared\)/)
assert.match(H[7].text, /user-declared, not scientific verification/)
assert.match(H[8].text, /missing eligible: 3/)
assert.match(H[8].text, /unpaired x0004: seed_mismatch/)
assert.match(H[8].text, /no confidence interval, p-value, or winner is computed/)
assert.match(H[10].text, /exit 0/)
assert.match(H[12].text, /read-only branch view/)
assert.match(H[12].text, /resolved \(exit 0\)/)
assert.match(H[13].text, /execution succeeded · figure in record: current/)
assert.match(H[13].text, /value \[0\] out\/metrics\.json: 0\.8123/)
assert.match(H[13].text, /2 matched, 0 unmatched/)
assert.match(H[13].text, /Vision review \(model interpretation, not verification/)
assert.match(H[13].text, /figure is not_recorded in this run's record/, 'an experiment run that never listed the figure is a stated gap')
assert.doesNotMatch(H[13].text, /\bverified\b/i)
assert.match(H[14].text, /Figure audit: 1 file/, 'the original inventory action still works')

const results = H[15].text.split(/^\d+\. \*\*/m).slice(1)
assert.ok(results.length >= 3, `live search returned ${results.length} results`)
assert.ok(results.filter((block) => block.split('\n').slice(1).join(' ').length > 250).length >= results.length - 1, 'OpenAlex-era results carry abstracts through the stock search path')
assert.match(H[16].text, /Prior-art triage: inconclusive/, 'with every claimed overlap left unknown the tool refuses a statement')
assert.doesNotMatch(H[16].text, /\bnovel\b/i)
assert.match(H[17].text, /not evidence that the claim is novel/)
assert.match(H[18].text, /workflow\(s\)/)

const saved = join(workspace, '.dsh', 'prior-art', 'e2e-live-claim')
assert.ok(existsSync(saved) && readdirSync(saved).length === 1, 'write:true saved exactly one report')
for (const file of ['experiment.json', 'runs.jsonl', 'links.jsonl']) assert.ok(existsSync(join(workspace, '.dsh', 'experiments', 'bench', file)), `ledger ${file}`)
const runs = readFileSync(join(workspace, '.dsh', 'experiments', 'bench', 'runs.jsonl'), 'utf8').trim().split('\n')
assert.equal(runs.length, 4, 'exactly the four logged runs; nothing else wrote to the ledger')
console.log(`live end-to-end OK: ${receipt.history.length} real tool calls through the host, ${results.length} live search results`)
