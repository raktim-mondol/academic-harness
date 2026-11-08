/**
 * Lookup snapshot: the registry answers an audit used are frozen, so the same references give the same
 * findings. No network: every fetch is a fake that counts its calls and can be made to fail.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openSnapshot, lookupKey, pacedFetch, SNAPSHOT_RELATIVE, SNAPSHOT_VERSION } from '../lookup-snapshot.js'
import { runCitation } from '../citation.js'
import { runIntegrityCheck } from '../integrity-check.js'
import { fakeExec, makeWorkspace } from './helpers/test-workspace.mjs'

const DOI = '10.1000/target'
const CR = `https://api.crossref.org/works/${encodeURIComponent(DOI)}`
const OA = `https://api.openalex.org/works/doi:${DOI}`

function network(answers = {}) {
  const calls = []
  const state = { down: false, answers }
  const fetchJson = async (url) => {
    calls.push(url)
    if (state.down) return { ok: false, status: 0, error: 'request timed out' }
    const hit = Object.entries(state.answers).find(([prefix]) => url.startsWith(prefix))
    return hit ? hit[1] : { ok: false, status: 404, data: null, error: 'HTTP 404' }
  }
  return { fetchJson, calls, state }
}

const crossrefWork = (extra = {}) => ({
  ok: true, status: 200,
  data: { message: { DOI, title: ['Target Paper'], issued: { 'date-parts': [[2020]] }, author: [{ family: 'Smith' }], 'container-title': ['Journal of Tests'], reference: new Array(300).fill({ key: 'r' }), ...extra } },
})
const openalexWork = (extra = {}) => ({ ok: true, status: 200, data: { id: 'https://openalex.org/W1', display_name: 'Target Paper', is_retracted: false, is_paratext: false, ...extra } })

/* --------------------------------------------------------------------- key */

assert.equal(lookupKey(`${CR}?mailto=a@b.org`), lookupKey(CR), 'mailto does not change the answer')
assert.equal(lookupKey(`${OA}?select=id,doi&api_key=SECRET`), lookupKey(`${OA}?api_key=OTHER&select=id,doi`), 'credentials and parameter order are not identity')
assert.notEqual(lookupKey(`${OA}?select=id`), lookupKey(`${OA}?select=id,doi`), 'a different projection is a different answer')
assert.equal(lookupKey('https://api.crossref.org/works/10.1000%2FTarget'), lookupKey('https://api.crossref.org/works/10.1000/target'), 'DOI case and %2F do not split the key')
assert.equal(lookupKey('https://example.org/x'), null, 'only the registries are frozen')
assert.equal(lookupKey('not a url'), null)

/* -------------------------------------------------------- miss, then hit */

{
  const ws = makeWorkspace('ah-snap-')
  try {
    const net = network({ [CR]: crossrefWork() })
    const first = openSnapshot(ws.cwd, { base: net.fetchJson })
    const a = await first.fetchJson(`${CR}?mailto=me@example.org`)
    assert.equal(a.ok, true)
    assert.equal(net.calls.length, 1)
    assert.equal(a.data.message.reference, undefined, 'the bulk nothing reads is not kept')
    first.flush()
    assert.ok(ws.exists(SNAPSHOT_RELATIVE))
    assert.equal(first.stats().fetched, 1)

    const second = openSnapshot(ws.cwd, { base: net.fetchJson })
    const b = await second.fetchJson(CR)
    assert.equal(net.calls.length, 1, 'a stored answer is not fetched again')
    assert.deepEqual(b.data, a.data, 'the first run and every later run see the same data')
    assert.equal(b.snapshot.cached, true)
    assert.equal(second.stats().hits, 1)
    assert.ok(second.stats().asof, 'the age of what was used is reported')

    const file = ws.read(SNAPSHOT_RELATIVE)
    assert.ok(!file.includes('me@example.org'), 'the contact address is never written')
    assert.equal(JSON.parse(file).version, SNAPSHOT_VERSION)
  } finally { ws.cleanup() }
}

/* ---------------------------------------- what is and is not remembered */

{
  const ws = makeWorkspace('ah-snap-')
  try {
    const net = network({ [CR]: { ok: false, status: 404, data: { message: 'Resource not found.' }, error: 'HTTP 404' } })
    const snap = openSnapshot(ws.cwd, { base: net.fetchJson })
    const miss = await snap.fetchJson(CR)
    assert.equal(miss.status, 404)
    const again = await snap.fetchJson(CR)
    assert.equal(again.status, 404)
    assert.equal(again.ok, false)
    assert.equal(net.calls.length, 1, '"no such DOI" is a definitive answer and is kept')

    net.state.down = true
    const failure = await snap.fetchJson(OA)
    assert.equal(failure.ok, false)
    assert.equal(failure.status, 0, 'with nothing stored, the failure comes back as the failure it was')
    assert.equal(failure.snapshot, undefined)
    net.state.down = false
    net.state.answers[OA] = openalexWork()
    const recovered = await snap.fetchJson(OA)
    assert.equal(recovered.ok, true, 'a failure is never stored, so the next call tries again')
    assert.equal(snap.stats().failed, 1)
  } finally { ws.cleanup() }
}

/* ------------------------------------------- refresh, expiry, outage */

{
  const ws = makeWorkspace('ah-snap-')
  try {
    let clock = Date.parse('2026-01-01T00:00:00Z')
    const net = network({ [OA]: openalexWork() })
    const open = (options = {}) => openSnapshot(ws.cwd, { base: net.fetchJson, now: () => clock, ...options })
    const s1 = open()
    await s1.fetchJson(OA)
    s1.flush()

    net.state.answers[OA] = openalexWork({ is_retracted: true })
    const s2 = open()
    assert.equal((await s2.fetchJson(OA)).data.is_retracted, false, 'upstream changed, snapshot did not: the audit still sees the old answer')

    const s3 = open({ refresh: true })
    assert.equal((await s3.fetchJson(OA)).data.is_retracted, true, 'refresh fetches again')
    assert.equal(s3.stats().refreshed, 1)
    s3.flush()

    net.state.down = true
    const s4 = open({ refresh: true })
    const kept = await s4.fetchJson(OA)
    assert.equal(kept.data.is_retracted, true, 'a refresh that fails keeps the earlier answer')
    assert.equal(kept.snapshot.stale, true)
    assert.equal(s4.stats().served_stale, 1)
    s4.flush()
    assert.equal(JSON.parse(ws.read(SNAPSHOT_RELATIVE)).entries[lookupKey(OA)].data.is_retracted, true, 'and the file is unchanged')

    net.state.down = false
    net.state.answers[OA] = openalexWork({ is_retracted: false })
    clock += 31 * 86_400_000
    const s5 = open()
    assert.equal((await s5.fetchJson(OA)).data.is_retracted, false, 'an answer older than the maximum age is fetched again')
    s5.flush()
    const s6 = open({ maxAgeDays: 0 })
    net.state.answers[OA] = openalexWork({ is_retracted: true })
    clock += 365 * 86_400_000
    assert.equal((await s6.fetchJson(OA)).data.is_retracted, false, 'maxAgeDays 0 never expires')
  } finally { ws.cleanup() }
}

/* ----------------------------- concurrency, pacing, passthrough, files */

{
  const ws = makeWorkspace('ah-snap-')
  try {
    const net = network({ [CR]: crossrefWork() })
    const snap = openSnapshot(ws.cwd, { base: net.fetchJson })
    await Promise.all([snap.fetchJson(CR), snap.fetchJson(CR), snap.fetchJson(CR)])
    assert.equal(net.calls.length, 1, 'identical requests in flight share one fetch')

    let paced = 0
    const limiter = { run: async (fn) => { paced += 1; return fn() } }
    await pacedFetch(snap.fetchJson, limiter, CR, {})
    assert.equal(paced, 0, 'a stored answer needs no pacing')
    await pacedFetch(snap.fetchJson, limiter, OA, {})
    assert.equal(paced, 1, 'a real request still goes through the provider limiter')

    const other = 'https://example.org/data'
    net.state.answers[other] = { ok: true, status: 200, data: { n: 1 } }
    await snap.fetchJson(other)
    await snap.fetchJson(other)
    assert.equal(net.calls.filter((u) => u === other).length, 2, 'other hosts go straight through')
    snap.flush()
    assert.ok(!Object.keys(JSON.parse(ws.read(SNAPSHOT_RELATIVE)).entries).some((k) => k.startsWith('example.org')))

    const memory = openSnapshot(null, { base: net.fetchJson })
    await memory.fetchJson(CR)
    assert.deepEqual(memory.flush(), { written: false })
    assert.equal(memory.stats().persisted, false)
  } finally { ws.cleanup() }
}

{
  const ws = makeWorkspace('ah-snap-')
  try {
    const net = network({ [CR]: crossrefWork(), [OA]: openalexWork() })
    const a = openSnapshot(ws.cwd, { base: net.fetchJson })
    const b = openSnapshot(ws.cwd, { base: net.fetchJson })
    await a.fetchJson(CR)
    await b.fetchJson(OA)
    a.flush()
    b.flush()
    const keys = Object.keys(JSON.parse(ws.read(SNAPSHOT_RELATIVE)).entries)
    assert.equal(keys.length, 2, 'two writers keep each other\'s answers')

    ws.write(SNAPSHOT_RELATIVE, '{ not json')
    const rebuilt = openSnapshot(ws.cwd, { base: net.fetchJson })
    assert.match(rebuilt.stats().load_note, /unreadable/)
    await rebuilt.fetchJson(CR)
    rebuilt.flush()
    assert.equal(Object.keys(JSON.parse(ws.read(SNAPSHOT_RELATIVE)).entries).length, 1, 'a corrupt file is rebuilt, never fatal')

    ws.write(SNAPSHOT_RELATIVE, JSON.stringify({ version: 99, entries: { x: {} } }))
    const newer = openSnapshot(ws.cwd, { base: net.fetchJson })
    await newer.fetchJson(CR)
    newer.flush()
    assert.equal(JSON.parse(ws.read(SNAPSHOT_RELATIVE)).version, 99, 'a snapshot written by a newer version is not overwritten')
  } finally { ws.cleanup() }
}

/* ------------------------------------------------- integrity_check */

{
  const ws = makeWorkspace('ah-snap-')
  try {
    const net = network({ [CR]: crossrefWork(), [OA]: openalexWork() })
    const deps = { resolveEnv: async () => null, fetchJson: net.fetchJson, lookupSnapshot: true }
    const exec = fakeExec(ws.cwd)

    const cold = await runIntegrityCheck({ doi: DOI }, exec, deps)
    assert.equal(cold.verdict, 'clean')
    const coldCalls = net.calls.length
    assert.equal(coldCalls, 2)

    const warm = await runIntegrityCheck({ doi: DOI }, exec, deps)
    assert.equal(net.calls.length, coldCalls, 'the second check makes no network call')
    assert.equal(warm.verdict, cold.verdict)
    assert.equal(warm.lookup.hits, 2)
    assert.ok(warm.data_as_of)

    net.state.down = true
    const outage = await runIntegrityCheck({ doi: DOI, refresh_lookups: true }, exec, deps)
    assert.equal(outage.verdict, 'clean', 'a registry outage cannot change the verdict of a DOI already checked')
    assert.equal(outage.lookup.served_stale, 2)

    const fresh = makeWorkspace('ah-snap-')
    try {
      const unreached = await runIntegrityCheck({ doi: DOI }, fakeExec(fresh.cwd), deps)
      assert.equal(unreached.verdict, 'unknown', 'with nothing stored and no network the DOI is unknown, never clean')
    } finally { fresh.cleanup() }
  } finally { ws.cleanup() }
}

{
  const ws = makeWorkspace('ah-snap-')
  try {
    const net = network({ [CR]: crossrefWork(), [OA]: openalexWork() })
    await runIntegrityCheck({ doi: DOI }, fakeExec(ws.cwd), { resolveEnv: async () => null, fetchJson: net.fetchJson })
    assert.ok(!ws.exists('.ah'), 'an injected fetchJson is an override and leaves no snapshot behind')
  } finally { ws.cleanup() }
}

/* ------------------------------------------------- citation audit */

{
  const ws = makeWorkspace('ah-snap-')
  try {
    const net = network({ [CR]: crossrefWork(), [OA]: openalexWork() })
    const bib = `@article{smith2020,\n  title = {Target Paper},\n  author = {Smith, Jo},\n  year = {2020},\n  journal = {Journal of Tests},\n  doi = {${DOI}}\n}\n`
    const exec = fakeExec(ws.cwd)
    const run = (extra = {}) => runCitation({ action: 'audit', text: bib, input_format: 'bibtex', ...extra }, exec, { fetchJson: net.fetchJson })

    const first = await run()
    const calls = net.calls.length
    assert.ok(calls >= 2, 'the first audit asks both registries')
    assert.equal(first.references[0].status, 'no_issues_found')

    const second = await run()
    assert.equal(net.calls.length, calls, 'the second audit makes no network call')
    assert.deepEqual(second.references, first.references, 'same references, same findings')
    assert.equal(second.lookup.hits >= 2, true)

    net.state.down = true
    const outage = await run({ refresh_lookups: true })
    assert.deepEqual(outage.references, first.references, 'an outage during a refresh changes nothing')

    const cold = makeWorkspace('ah-snap-')
    try {
      const unverified = await runCitation({ action: 'audit', text: bib, input_format: 'bibtex' }, fakeExec(cold.cwd), { fetchJson: net.fetchJson })
      assert.equal(unverified.references[0].status, 'unverified', 'nothing stored and no network: unverified, not a pass and not a problem')
      assert.ok(unverified.references[0].findings.every((f) => f.severity === 'info'))
    } finally { cold.cleanup() }
  } finally { ws.cleanup() }
}

console.log('lookup snapshot: all passed')
