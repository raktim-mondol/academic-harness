import assert from 'node:assert/strict'
import { apply, loadLegacyListAgents } from '../subagent-list-compat.js'
import { readFileSync } from 'node:fs'

const legacy = { name: 'legacy-list-agents' }
assert.equal(await loadLegacyListAgents(() => 'legacy', async () => legacy), legacy)
const unexported = Object.assign(new Error('subpath not exported'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
assert.equal(await loadLegacyListAgents(() => { throw unexported }), null)
const missing = Object.assign(new Error('package missing'), { code: 'ERR_MODULE_NOT_FOUND' })
await assert.rejects(loadLegacyListAgents(() => { throw missing }), { code: 'ERR_MODULE_NOT_FOUND' })
await assert.rejects(loadLegacyListAgents(() => 'legacy', async () => { throw unexported }), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
await assert.rejects(loadLegacyListAgents(() => 'legacy', async () => { throw new Error('broken module') }), /broken module/)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(pkg.exports['./subagent-list-compat'], './subagent-list-compat.js')
assert.ok(pkg.files.includes('subagent-list-compat.js'))
assert.equal(typeof apply, 'function')
console.log('subagent list compatibility OK')
