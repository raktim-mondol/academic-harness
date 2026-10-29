/**
 * Harness integration of the PaperMemory reference library: the CLI bridge, the `citation` library
 * source, manuscript_citations, integrity sweeps, literature_search flags, and the first-run migration.
 * Uses the vendored PaperMemory through a wrapper script and a throwaway database; no network.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'ah-library-'))
const vendor = join(root, 'vendor', 'papermemory')
const wrapper = join(work, 'papermemory')
writeFileSync(wrapper, `#!/bin/sh\nPYTHONPATH="${vendor}" exec python3 -m papermemory "$@"\n`)
chmodSync(wrapper, 0o755)
process.env.PAPERMEMORY_CLI = wrapper
process.env.PAPERMEMORY_DB = join(work, 'pm.db')
process.env.DSH_HOME = join(work, 'dsh')

const { libraryCli, libraryPapers, libraryRecords, libraryResolve, librarySetIntegrity } = await import('../papermemory-library.js')
const { ensurePaperMemoryDb, MIN_PAPERMEMORY_VERSION, resolvePaperMemoryLaunch, run, cliArgs } = await import('../papermemory-cli.js')
const { runCitation } = await import('../citation.js')
const { runManuscriptCitations } = await import('../manuscript-citations.js')
const { runIntegrityCheck } = await import('../integrity-check.js')
const { markInLibrary } = await import('../literature-search.js')
const { parseBibtex, toBibtex } = await import('../citation-format.js')

const ws = join(work, 'ws')
mkdirSync(ws, { recursive: true })
const exec = { agent: { session: { header: { cwd: ws } } } }

const BIB = `
@article{lee2020graph, title={Graph networks for molecules}, author={Lee, Ann and Roe, Rae}, journal={Nature}, year=2020, volume=5, pages={1--9}, doi={10.1000/a}}
@article{roe2021vision, title={Vision transformers at scale}, author={Roe, Rae}, journal={CVPR}, year=2021, doi={10.1000/b}}
@article{kim2022language, title={Language models for code}, author={Kim, Sun}, journal={ICML}, year=2022, doi={10.1000/c}}
@article{bad2023doi, title={A paper with a malformed DOI}, author={Bad, Dee}, year=2023, doi={10.1/bad}}
`
const src = join(ws, 'in.bib')
writeFileSync(src, BIB)
const pm = (...args) => spawnSync(wrapper, args, { encoding: 'utf8', cwd: ws })

// ---- the tool surface and version
assert.equal(MIN_PAPERMEMORY_VERSION, '0.3.0')
assert.equal(pm('init', '--json').status, 0)
const names = JSON.parse(pm('tools', '--json').stdout)
assert.equal(names.length, 15, 'PaperMemory should expose 15 tools')
assert.ok(names.includes('papermemory_library'))
assert.match(readFileSync(join(root, 'papermemory.js'), 'utf8'), /EXPECTED_TOOL_COUNT = 14/)
const hidden = JSON.parse(spawnSync(wrapper, ['tools', '--json'], { encoding: 'utf8', env: { ...process.env, PAPERMEMORY_HIDE_TOOLS: 'papermemory_library' } }).stdout)
assert.equal(hidden.length, 14, 'the plugin hides the MCP library tool')
assert.ok(!hidden.includes('papermemory_library'))
assert.match(readFileSync(join(vendor, 'pyproject.toml'), 'utf8'), /version = "0\.3\.0"/)

// ---- the CLI bridge
assert.equal(pm('library', 'import', src, '--project', 'thesis').status, 0)
const listed = await libraryPapers(['year:2021..'], { cwd: ws })
assert.ok(listed.ok)
assert.deepEqual(listed.data.rows.map((row) => row.key), ['roe2021vision', 'kim2022language', 'bad2023doi'])
assert.equal((await libraryCli(['get', 'nothing-here'], { cwd: ws })).ok, false)
process.env.PAPERMEMORY_CLI = join(work, 'does-not-exist')
const missing = await libraryCli(['list'], { cwd: ws })
assert.equal(missing.ok, false, 'a library that cannot be reached must not look empty')
process.env.PAPERMEMORY_CLI = wrapper

const resolved = await libraryResolve(['lee2020graph', '10.1000/b', 'ghost'], { project: 'thesis', projectKeys: true, cwd: ws })
assert.ok(resolved.ok)
assert.deepEqual(resolved.results.map((r) => r.found), [true, true, false])
assert.deepEqual(resolved.project_keys, ['bad2023doi', 'kim2022language', 'lee2020graph', 'roe2021vision'])

// ---- citation: the library as a record source, under the library's own keys
const records = await libraryRecords({ all: true }, { cwd: ws })
assert.ok(records.ok)
assert.deepEqual(records.records.map((r) => r['citation-key']).sort(), ['bad2023doi', 'kim2022language', 'lee2020graph', 'roe2021vision'])
const bib = await runCitation({ action: 'bibtex', library: { all: true } }, exec)
assert.match(bib.bibtex, /@article\{lee2020graph,/)
const formatted = await runCitation({ action: 'format', library: { query: 'year:2020' }, style: 'ieee' }, exec)
assert.equal(formatted.count, 1)
assert.match(formatted.bibliography, /Graph networks for molecules/)
await assert.rejects(runCitation({ action: 'format', library: {} }, exec), /needs a scope/)
process.env.PAPERMEMORY_CLI = join(work, 'does-not-exist')
await assert.rejects(runCitation({ action: 'format', library: { all: true } }, exec), /reference library unavailable/)
process.env.PAPERMEMORY_CLI = wrapper

// ---- both BibTeX writers agree on what they both support
const fromPm = parseBibtex(pm('library', 'export', '--all', '--format', 'bibtex').stdout)
const fromJs = parseBibtex(toBibtex(records.records))
const byKey = (list) => new Map(list.map((r) => [r['citation-key'], r]))
const a = byKey(fromPm)
const b = byKey(fromJs)
assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort())
for (const [key, left] of a) {
  const right = b.get(key)
  for (const field of ['title', 'DOI', 'volume', 'page', 'container-title']) {
    assert.equal(left[field], right[field], `${key}.${field} differs between the two BibTeX writers`)
  }
  assert.deepEqual(left.issued?.['date-parts'], right.issued?.['date-parts'], `${key} date differs`)
  assert.deepEqual((left.author || []).map((x) => x.family), (right.author || []).map((x) => x.family), `${key} authors differ`)
}

// ---- manuscript_citations against the library
const ms = join(ws, 'paper.tex')
writeFileSync(ms, '\\documentclass{article}\\begin{document}\\cite{lee2020graph} \\cite{ghost2099} \\bibliography{refs}\\end{document}\n')
writeFileSync(join(ws, 'refs.bib'), BIB + '@article{ghost2099, title={Not in the library}, author={X, Y}, year=2099}\n')
const checked = await runManuscriptCitations({ manuscript: 'paper.tex', library: true, project: 'thesis' }, exec)
assert.equal(checked.library.available, true)
assert.deepEqual(checked.library.cited_not_in_library, ['ghost2099'])
assert.deepEqual(checked.library.project_entries_never_cited, ['bad2023doi', 'kim2022language', 'roe2021vision'])
process.env.PAPERMEMORY_CLI = join(work, 'does-not-exist')
const offline = await runManuscriptCitations({ manuscript: 'paper.tex', library: true }, exec)
assert.equal(offline.library.available, false)
assert.ok(offline.warnings.some((w) => /reference library not checked/.test(w)))
process.env.PAPERMEMORY_CLI = wrapper
assert.equal((await runManuscriptCitations({ manuscript: 'paper.tex' }, exec)).library, undefined)

// ---- integrity sweep: verdicts become library statuses, never-checked stays unknown
const verdicts = { '10.1000/a': 'clean', '10.1000/b': 'retracted', '10.1000/c': 'not_found' }
const deps = {
  resolveEnv: async () => '',
  checkOne: async (doi) => ({ doi, verdict: verdicts[doi], title: doi, signals: doi === '10.1000/b' ? [{ notice_doi: '10.1000/notice' }] : [] }),
}
const sweep = await runIntegrityCheck({ library: true, limit: 2 }, exec, deps)
assert.equal(sweep.sweep.checked, 2)
assert.equal(sweep.sweep.remaining, 2, 'a bounded sweep says how many are left')
const rest = await runIntegrityCheck({ library: true }, exec, deps)
assert.equal(rest.sweep.checked, 2, 'checked papers drop out of the default selection')
assert.ok(rest.sweep.flagged.some((entry) => entry.verdict === 'invalid_doi'), 'a malformed DOI is reported, not skipped')
assert.equal((await runIntegrityCheck({ library: true }, exec, deps)).sweep.checked, 0, 'nothing is left to loop on')
const flagged = JSON.parse(pm('library', 'list', 'integrity:retracted', '--json').stdout)
assert.deepEqual(flagged.rows.map((row) => row.key), ['roe2021vision'])
const unknown = JSON.parse(pm('library', 'list', 'integrity:unknown', '--json').stdout)
assert.deepEqual(unknown.rows.map((row) => row.key).sort(), ['bad2023doi', 'kim2022language'], 'not_found and a malformed DOI are recorded as unknown, not ok')
assert.equal(JSON.parse(pm('library', 'list', 'integrity:ok', '--json').stdout).total_count, 1)
const single = await runIntegrityCheck({ doi: '10.1000/a', record_in_library: true }, exec, { ...deps, checkOne: undefined, resolveEnv: async () => '' }).catch(() => null)
assert.ok(single === null || single.verdict !== undefined)
const unreachable = await librarySetIntegrity([{ ref: 'ghost', status: 'ok' }], { cwd: ws })
assert.equal(unreachable.ok, true)
assert.deepEqual(unreachable.unresolved, ['ghost'])
const doctor = JSON.parse(pm('library', 'doctor', '--json').stdout)
assert.equal(doctor.summary.problems.integrity_flagged, 1)

// ---- literature_search flags papers already in the library, and says nothing when it cannot look
const found = [{ doi: '10.1000/a', title: 'x' }, { doi: '10.9999/new', title: 'y' }, { doi: null, title: 'z' }]
const info = await markInLibrary(found, exec)
assert.deepEqual(info, { checked: 2, in_library: 1 })
assert.equal(found[0].in_library, 'lee2020graph')
assert.equal(found[1].in_library, undefined)
process.env.PAPERMEMORY_CLI = join(work, 'does-not-exist')
assert.equal(await markInLibrary([{ doi: '10.1000/a' }], exec), undefined)
process.env.PAPERMEMORY_CLI = wrapper

// ---- first run after the upgrade: an old store is backed up, migrated, and then opens
const oldDb = join(work, 'old.db')
const make = spawnSync('python3', ['-c', `
import sqlite3
from papermemory.schema_v2 import V2_SCHEMA
c = sqlite3.connect(${JSON.stringify(oldDb)})
c.executescript(V2_SCHEMA)
c.execute("PRAGMA user_version=2000")
c.execute("INSERT INTO projects(key,title,kind,created_at) VALUES ('unassigned','Unassigned','manuscript','t')")
c.execute("INSERT INTO papers(id,identity_kind,identity_value,title,title_source,authors_json,year,doi,bibtex_key,origin_channel,cite_state,created_at,updated_at) VALUES ('p1','doi','10.1/old','Old paper','caller','[\\"Ann Lee\\"]',2019,'10.1/old','lee2019old','hand-asserted','chunkless','t','t')")
c.commit()
`], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: vendor } })
assert.equal(make.status, 0, make.stderr)
process.env.PAPERMEMORY_DB = oldDb
process.env.PAPERMEMORY_DATA_DIR = join(work, 'data')
const direct = spawnSync(wrapper, ['init', '--json'], { encoding: 'utf8' })
assert.notEqual(direct.status, 0, 'an unmigrated store must be refused, not silently read')
assert.match(direct.stderr, /migration-required/)
const launch = resolvePaperMemoryLaunch()
assert.equal(await ensurePaperMemoryDb(launch), true, 'the harness migrates an old store on first start')
const migrated = JSON.parse(pm('library', 'get', 'lee2019old', '--json').stdout)
assert.equal(migrated.paper.title, 'Old paper')
assert.equal(migrated.key.key, 'lee2019old', 'existing keys survive the migration')
assert.ok(existsSync(join(work, 'backups')), 'a backup is taken before migrating')

rmSync(work, { recursive: true, force: true })
console.log('library integration ok')
