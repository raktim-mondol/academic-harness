import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  DREAM_TIMEOUT_MS, MIN_INTERVAL_MS, dreamDue, dreamMode, dreamOnce, parseDreamSummary,
} from '../papermemory-dream.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (label, cond) => { if (cond) console.log(`ok - ${label}`); else { console.error(`FAIL - ${label}`); failed++ } }
const tmp = () => mkdtempSync(join(tmpdir(), 'pm-dream-'))

// mode parsing: an unreadable value reports, it never applies
ok('default mode is apply', dreamMode({}) === 'apply')
ok('off / report / apply parse', ['off', 'report', 'apply'].every((m) => dreamMode({ PAPERMEMORY_DREAM: ` ${m.toUpperCase()} ` }) === m))
ok('garbage mode falls back to report', dreamMode({ PAPERMEMORY_DREAM: 'yes please' }) === 'report')

// throttle
{
  const dir = tmp()
  const stamp = join(dir, 'dream-stamp')
  ok('due with no stamp', dreamDue({ stampPath: stamp, now: 1_000 }))
  writeFileSync(stamp, '1000')
  ok('not due inside the interval', !dreamDue({ stampPath: stamp, now: 1_000 + MIN_INTERVAL_MS - 1 }))
  ok('due after the interval', dreamDue({ stampPath: stamp, now: 1_000 + MIN_INTERVAL_MS }))
  writeFileSync(stamp, 'garbage')
  ok('garbage stamp counts as due', dreamDue({ stampPath: stamp, now: 5 }))
}

ok('summary parser reads --json output', parseDreamSummary('noise {"applied":true,"summary":{"duplicates":2}}')?.duplicates === 2)
ok('summary parser rejects junk', parseDreamSummary('nope') === null && parseDreamSummary('{"x":1}') === null)

// skip paths never call the CLI
{
  let calls = 0
  const runner = async () => { calls++; return { code: 0, out: '{}', err: '' } }
  const base = { stateDir: tmp(), launch: { command: 'pm', args: [] }, env: {}, runner }
  ok('off skips', (await dreamOnce({ ...base, mode: 'off' })).reason === 'off')
  ok('no CLI skips', (await dreamOnce({ ...base, mode: 'apply', launch: null })).reason === 'no-managed-cli')
  ok('PATH (read-only) CLI skips', (await dreamOnce({ ...base, mode: 'apply', launch: { command: 'pm', args: [], readOnly: true } })).reason === 'no-managed-cli')
  ok('skips never spawn', calls === 0)
}

// ran / failed / too old, with arguments checked
{
  const seen = []
  const good = async (cmd, args) => { seen.push(args); return { code: 0, out: '{"applied":true,"summary":{"duplicates":1,"stale":0,"recovered_claims":0}}', err: '' } }
  const dir = tmp()
  const r = await dreamOnce({ mode: 'apply', stateDir: dir, launch: { command: 'pm', args: ['-m', 'papermemory'] }, env: {}, runner: good, now: 1_700_000_000_000 })
  ok('apply passes --apply --json', r.status === 'ran' && seen[0].join(' ') === '-m papermemory dream --apply --json')
  ok('log line written', JSON.parse(readFileSync(join(dir, 'dream-log.jsonl'), 'utf8').trim()).duplicates === 1)
  const again = await dreamOnce({ mode: 'apply', stateDir: dir, launch: { command: 'pm', args: [] }, env: {}, runner: good, now: 1_700_000_000_000 + 1000 })
  ok('second pass inside the hour is skipped', again.reason === 'ran-recently')
  const rep = await dreamOnce({ mode: 'report', stateDir: tmp(), launch: { command: 'pm', args: [] }, env: {}, runner: good })
  ok('report mode never passes --apply', !seen.at(-1).includes('--apply') && rep.status === 'ran')

  const dir2 = tmp()
  const old = await dreamOnce({ mode: 'apply', stateDir: dir2, launch: { command: 'pm', args: [] }, env: {}, runner: async () => ({ code: 2, out: '', err: 'invalid choice' }) })
  ok('older CLI is skipped, not an error', old.status === 'skipped' && old.reason === 'cli-too-old')
  const locked = await dreamOnce({ mode: 'apply', stateDir: dir2, launch: { command: 'pm', args: [] }, env: {}, runner: async () => ({ code: 1, out: '', err: 'database is locked' }) })
  ok('a failure is reported and writes no stamp (retried next time)', locked.status === 'failed' && !existsSync(join(dir2, 'dream-stamp')))
  const slow = await dreamOnce({ mode: 'apply', stateDir: dir2, launch: { command: 'pm', args: [] }, env: {}, runner: async () => ({ code: 124, out: '', err: '' }) })
  ok('timeout is reported', slow.reason === 'timeout' && DREAM_TIMEOUT_MS > 0)
}

// real CLI: the vendored package against a throwaway database
{
  const dir = tmp()
  const db = join(dir, 'pm.db')
  const env = { ...process.env, PYTHONPATH: join(root, 'vendor', 'papermemory'), PAPERMEMORY_DB: db, PYTHONDONTWRITEBYTECODE: '1' }
  const py = process.env.PYTHON || 'python3'
  const seed = spawnSync(py, ['-c', `
from papermemory.db import Store
s = Store(${JSON.stringify(db)})
t = "We decided that the related work is organised by method family rather than by year because reviewers found the chronological order hid which approaches compete with ours on the benchmark."
s.remember(t, project_id="p", tier="episodic"); s.remember(t, project_id="p", tier="episodic")
`], { env, encoding: 'utf8' })
  ok('seeded a throwaway store', seed.status === 0)
  const launch = { command: py, args: ['-m', 'papermemory'] }
  const stateDir = join(dir, 'state')
  mkdirSync(stateDir)
  const rep = await dreamOnce({ mode: 'report', stateDir, launch, env })
  ok('real report finds the duplicate and changes nothing', rep.status === 'ran' && rep.summary.duplicates === 1 && rep.summary.applied === false)
  const count = () => spawnSync(py, ['-c', `import sqlite3;print(sqlite3.connect(${JSON.stringify(db)}).execute("select count(*) from observations where status='active'").fetchone()[0])`], { encoding: 'utf8' }).stdout.trim()
  ok('still 2 active notes after the dry run', count() === '2')
  const app = await dreamOnce({ mode: 'apply', stateDir, launch, env, now: Date.now() + MIN_INTERVAL_MS + 1 })
  ok('real apply supersedes one copy', app.status === 'ran' && app.summary.applied === true && count() === '1')
}

// wiring
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  ok('package exports the module', pkg.exports['./papermemory-dream'] === './papermemory-dream.js')
  ok('package ships the file', pkg.files.includes('papermemory-dream.js'))
  const preset = readFileSync(join(root, 'presets/academic-harness/agent.cordis.yml'), 'utf8')
  ok('preset mounts the module', /- id: papermemory-dream\n\s+name: academic-harness\/papermemory-dream\n/.test(preset))
  ok('patch regenerated', /name: academic-harness\/papermemory-dream/.test(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')))
  ok('prompt tells the agent about dream', readFileSync(join(root, 'prompt.js'), 'utf8').includes('papermemory dream --project SLUG'))
  const mod = await import('../papermemory-dream.js')
  ok('module shape (name, inject, apply)', mod.name === 'academic-harness-papermemory-dream' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
  const handlers = {}
  mod.apply({ on: (ev, fn) => { handlers[ev] = fn } })
  ok('hooks agent/disposed', typeof handlers['agent/disposed'] === 'function')
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1) }
console.log('papermemory dream OK')
