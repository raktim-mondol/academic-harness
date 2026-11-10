#!/usr/bin/env node
/**
 * The tool surface stays measurable and nothing is deferred without an
 * activation path (decision D40; see docs/DEFERRED-TOOLS.md).
 */
import assert from 'node:assert/strict'
import { collectToolDefinitions, wireSize } from './measure-tool-surface.mjs'

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.message}`)
    process.exitCode = 1
  }
}

const { found, skipped } = await collectToolDefinitions()

await check('the plugin tools can be enumerated and sized', () => {
  assert.ok(found.length > 90, `only ${found.length} tools found`)
  const names = found.map((f) => f.definition.name)
  assert.equal(new Set(names).size, names.length, `duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i)}`)
  for (const expected of ['skill_search', 'skill_load', 'literature_search', 'analysis_run']) assert.ok(names.includes(expected), `${expected} missing`)
  assert.ok(found.every(({ definition }) => wireSize(definition) > 40))
  assert.ok(skipped.length <= 1, `modules that failed to load: ${skipped.join('; ')}`)
})

await check('no tool is marked deferLoading until the host can activate it again', () => {
  const deferred = found.filter(({ definition }) => definition.deferLoading === true).map((f) => f.definition.name)
  assert.deepEqual(deferred, [], 'a deferred tool is uncallable on routes with toolUpdate until a tool-addition record is written; see docs/DEFERRED-TOOLS.md')
})

await check('the new on-demand skill tools stay small', () => {
  for (const name of ['skill_search', 'skill_load']) {
    const { definition } = found.find((f) => f.definition.name === name)
    assert.ok(wireSize(definition) < 1500, `${name} is ${wireSize(definition)} characters`)
  }
})

if (process.exitCode) console.error('tool surface: FAILED')
else console.log(`tool surface: ${passed} checks passed (${found.length} tools, ${found.reduce((n, f) => n + wireSize(f.definition), 0)} characters)`)
