#!/usr/bin/env node
/**
 * Credential settings are secrets, not plain strings (decision D47).
 *
 *  1. Classification: every API key / token field is role('secret'); emails,
 *     model ids, endpoint URLs and preferences stay plain.
 *  2. Redaction: with the host's own redactSecrets (when it can be imported;
 *     set AH_HOST_SETTINGS=/path/to/dsh-settings/lib/index.js to run it against a
 *     specific host build) a stored key is absent from the value and present in
 *     the `secrets` sidecar as set:true; an unset key reports set:false.
 *  3. In-process reads are untouched: tools still get the stored key.
 *  4. The page reads "configured" from the sidecar and falls back to the value
 *     when the host sent none; AH_SECRET_SETTINGS=0 restores plain fields.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { KEY_FIELDS, KeysSettingsSchema, SECRET_FIELDS, getStoredKey, registerKeysSettings } from '../settings-keys.js'
import { secretPresence } from '../client/secret-presence.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack || error.message}`)
    process.exitCode = 1
  }
}

const EXPECTED_SECRETS = [
  'PARALLEL_API_KEY', 'FIRECRAWL_API_KEY', 'CONSENSUS_API_KEY', 'SCITE_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY',
  'PERPLEXITY_API_KEY', 'JINA_API_KEY', 'OPENALEX_API_KEY', 'S2_API_KEY', 'NCBI_API_KEY', 'CORE_API_KEY', 'ADS_API_TOKEN',
  'SCOPUS_API_KEY', 'ELSEVIER_INSTTOKEN', 'WOS_API_KEY', 'WILEY_TDM_TOKEN', 'SPRINGER_API_KEY', 'IEEE_API_KEY', 'ELICIT_API_KEY',
  'FUTUREHOUSE_API_KEY', 'TYPESAFE_API_KEY', 'COHERE_API_KEY', 'SHERPA_ROMERO_API_KEY', 'OPENFDA_API_KEY', 'DATACITE_API_KEY',
  'ZENODO_API_KEY', 'FIGSHARE_API_KEY', 'ORCID_TOKEN', 'PATENTSVIEW_API_KEY', 'GEMINI_API_KEY', 'SUBAGENT_PRO_API_KEY',
  'SUBAGENT_VISION_API_KEY', 'MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'RUNPOD_API_KEY', 'VAST_API_KEY', 'ZVEC_GREP_API_KEY',
]

await check('every credential field is a secret and nothing else is', () => {
  assert.deepEqual([...SECRET_FIELDS].sort(), [...EXPECTED_SECRETS].sort())
  for (const field of KEY_FIELDS) {
    const role = KeysSettingsSchema.dict[field].meta.role
    assert.equal(role === 'secret', SECRET_FIELDS.has(field), `${field}: role ${role}`)
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(field)) assert.ok(SECRET_FIELDS.has(field), `${field} looks like a credential but is not classified`)
  }
  for (const plain of ['UNPAYWALL_EMAIL', 'CROSSREF_MAILTO', 'NCBI_EMAIL', 'IMAGE_MODEL', 'SUBAGENT_PRO_BASE_URL', 'SUBAGENT_PRO_MODEL', 'ZVEC_GREP_INDEX_STATE', 'DEEP_REVIEW_MAX_ROUNDS']) {
    assert.ok(!SECRET_FIELDS.has(plain), `${plain} must stay plain`)
  }
})

async function hostRedact() {
  const candidates = [
    process.env.AH_HOST_SETTINGS,
    join(homedir(), '.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js'),
    join(ROOT, 'node_modules/@deepseek-ai/dsh-settings/lib/index.js'),
  ].filter(Boolean)
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const mod = await import(pathToFileURL(path).href)
      if (typeof mod.redactSecrets === 'function') return { redactSecrets: mod.redactSecrets, path }
    } catch { /* try the next */ }
  }
  return null
}

const host = await hostRedact()
if (!host) console.log('SKIP  host redaction: no dsh-settings found (set AH_HOST_SETTINGS to a dsh-settings/lib/index.js)')
else {
  await check('the host strips stored keys from the value and reports presence in the sidecar', () => {
    const stored = { OPENALEX_API_KEY: 'sk-canary-123', RUNPOD_API_KEY: '', UNPAYWALL_EMAIL: 'me@example.org', IMAGE_MODEL: 'm1' }
    const { value, secrets } = host.redactSecrets(KeysSettingsSchema, stored)
    const wire = JSON.stringify(value)
    assert.ok(!wire.includes('sk-canary-123'), 'the canary key crossed the wire')
    assert.equal(value.OPENALEX_API_KEY, undefined)
    assert.equal(value.UNPAYWALL_EMAIL, 'me@example.org', 'a plain field is kept')
    assert.equal(value.IMAGE_MODEL, 'm1')
    const bySlot = new Map(secrets.map((s) => [s.path.join('.'), s.set]))
    assert.equal(bySlot.get('OPENALEX_API_KEY'), true)
    assert.equal(bySlot.get('GEMINI_API_KEY'), false, 'an unset key is reported as not set')
    assert.equal(bySlot.size, SECRET_FIELDS.size, 'every secret slot is enumerated')
  })
}

await check('tools still read the stored key in-process', () => {
  const config = { OPENALEX_API_KEY: '  sk-canary-123 \n', GEMINI_API_KEY: '' }
  registerKeysSettings({ settings: {}, effect() {}, on: () => () => {} }, config)
  assert.equal(getStoredKey('OPENALEX_API_KEY'), 'sk-canary-123')
  assert.equal(getStoredKey('GEMINI_API_KEY'), undefined)
})

await check('the page takes "configured" from the sidecar and falls back to the value', () => {
  const view = { namespaces: [
    { ns: 'other', secrets: [{ path: ['X'], set: true }] },
    { ns: 'academic-harness', secrets: [{ path: ['OPENALEX_API_KEY'], set: true }, { path: ['GEMINI_API_KEY'], set: false }] },
  ] }
  const presence = secretPresence(view)
  assert.equal(presence.get('OPENALEX_API_KEY'), true)
  assert.equal(presence.get('GEMINI_API_KEY'), false)
  assert.equal(presence.get('S2_API_KEY'), undefined, 'a field the sidecar does not name falls back to the value')
  assert.equal(secretPresence(undefined), undefined)
  assert.equal(secretPresence({ namespaces: [{ ns: 'academic-harness', secrets: [] }] }), undefined, 'no sidecar: read the value')
  assert.equal(secretPresence({ namespaces: [{ ns: 'academic-harness', secrets: [{ path: ['a', 'b'], set: true }] }] }).size, 0, 'nested paths are not this form')
  const source = readFileSync(join(ROOT, 'client/ApiKeysSection.jsx'), 'utf8')
  assert.match(source, /fromSidecar !== undefined \? fromSidecar : Boolean\(snapshot\.value/)
  assert.match(readFileSync(join(ROOT, 'client/index.js'), 'utf8'), /describe: ctx\.configForms\.describe\?\.\(\)/)
  assert.match(readFileSync(join(ROOT, 'lib/client.js'), 'utf8'), /fromSidecar/, 'lib/client.js is rebuilt (npm run build)')
})

await check('AH_SECRET_SETTINGS=0 restores plain fields', () => {
  const result = spawnSync(process.execPath, ['-e', `
    import('./settings-keys.js').then((m) => {
      const roles = Object.values(m.KeysSettingsSchema.dict).map((s) => s.meta.role).filter(Boolean)
      console.log(JSON.stringify(roles))
    })`], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, AH_SECRET_SETTINGS: '0' } })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim()), [])
})

if (process.exitCode) console.error('secret settings: FAILED')
else console.log(`secret settings: ${passed} checks passed`)
