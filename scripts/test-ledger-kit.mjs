import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  appendJsonl, csvCell, exportText, hashFile, mdCell, nowIso, readJson, readJsonl,
  requireText, sha256, shortHash, slug, stableStringify, writeOnceJson,
} from '../ledger-kit.js'
import {
  PROVENANCE_SCHEMA_VERSION, assertProvenanceLink, contentHash, provenanceKind,
  provenanceLink, shortContentHash,
} from '../provenance.js'
import { makeWorkspace } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-ledger-kit-')

try {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
    'stableStringify must sort object keys recursively',
  )
  assert.equal(
    stableStringify({ a: [1, undefined, { z: 1, y: 2 }] }),
    '{"a":[1,null,{"y":2,"z":1}]}',
    'stableStringify must keep array order and normalize undefined array entries',
  )
  assert.equal(sha256('abc').length, 64)
  assert.equal(sha256('abc'), sha256('abc'), 'sha256 must be deterministic')
  assert.equal(shortHash('abc', 8).length, 8)
  assert.equal(shortHash('abc', 8), sha256('abc').slice(0, 8))
  assert.equal(slug('  A review: phase 1!  '), 'a-review-phase-1')
  assert.equal(requireText(' value ', 'value'), 'value')
  assert.throws(() => requireText('  ', 'value'), /value is required/)
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/)

  const file = workspace.path('nested/data.jsonl')
  const rows = [{ id: 1, text: 'alpha' }, { id: 2, text: 'beta, "quoted"' }]
  assert.equal(appendJsonl(file, rows), 2)
  assert.deepEqual(readJsonl(file), rows)
  assert.equal(appendJsonl(file, []), 0)
  assert.deepEqual(readJsonl(workspace.path('missing.jsonl')), [])

  workspace.write('nested/bad.jsonl', '{"ok":true}\nnot-json\n')
  assert.throws(
    () => readJsonl(workspace.path('nested/bad.jsonl')),
    /line 2 is not valid JSON/,
  )

  const once = workspace.path('nested/protocol.json')
  assert.equal(writeOnceJson(once, { version: 1 }), once)
  assert.deepEqual(readJson(once), { version: 1 })
  assert.throws(() => writeOnceJson(once, { version: 2 }), /write-once/)
  assert.equal(readJson(workspace.path('nested/missing.json')), null)

  const textFile = workspace.path('nested/report.md')
  assert.equal(exportText(textFile, 'hello').bytes, 5)
  assert.equal(workspace.read('nested/report.md'), 'hello')
  assert.throws(() => exportText(textFile, 'again'), /already exists/)
  assert.doesNotThrow(() => exportText(textFile, 'again', { overwrite: true }))
  assert.equal(workspace.read('nested/report.md'), 'again')

  workspace.write('nested/hash.txt', 'hash me')
  assert.equal(hashFile(workspace.path('nested/hash.txt')), sha256('hash me'))
  assert.equal(existsSync(workspace.path('nested/hash.txt')), true)

  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(mdCell('a|b\n c'), 'a\\|b c')

  assert.equal(PROVENANCE_SCHEMA_VERSION, '1')
  assert.equal(provenanceKind('paper'), 'paper')
  assert.throws(() => provenanceKind('nope'), /unknown provenance kind/)
  assert.deepEqual(provenanceLink('quote', 'sha256:abc'), { kind: 'quote', id: 'sha256:abc' })
  assert.throws(() => provenanceLink('paper', ''), /provenance id is required/)
  assert.equal(contentHash({ b: 1, a: 2 }), contentHash({ a: 2, b: 1 }))
  assert.match(contentHash('x'), /^sha256:[0-9a-f]{64}$/)
  assert.equal(shortContentHash('x', 12).length, 12)
  assert.doesNotThrow(() => assertProvenanceLink({ kind: 'run', id: 'run-1' }))
  assert.throws(() => assertProvenanceLink({ kind: 'run' }), /provenance id is required/)

  // The example schemas are documentation, but they must stay parseable.
  for (const name of [
    'extraction-template.example.json',
    'analysis-plan.example.json',
    'run-manifest.example.json',
    'preregistration.example.json',
    'submission-manifest.example.json',
  ]) {
    const parsed = JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), 'utf8'))
    assert.ok(parsed && typeof parsed === 'object')
  }

  console.log('ledger-kit OK')
} finally {
  workspace.cleanup()
}
