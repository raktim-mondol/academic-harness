/**
 * reference_library: the native tool. Argument translation for every action, workspace confinement,
 * inline imports, and an end-to-end run against the vendored PaperMemory (no network).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

// ---- registration
assert.ok(pkg.exports?.['./reference-library'] && pkg.files.includes('reference-library.js'))
assert.match(read('reference-library.js'), /name: 'reference_library'/)
assert.match(read('reference-library.js'), /export const inject = \['tools'\]/)
assert.match(read('presets/academic-harness/agent.cordis.yml'), /- id: reference-library\n  name: academic-harness\/reference-library/)
assert.match(read('cordis.patch.yml'), /academic-harness\/reference-library/, 'cordis.patch.yml was not regenerated')
assert.match(read('papermemory.js'), /HIDDEN_MCP_TOOLS = \['papermemory_library'\]/)
const prompt = read('prompt.js')
assert.match(prompt, /reference_library/)
assert.ok(!/mcp__papermemory__papermemory_library/.test(prompt), 'the prompt must point at the native tool')
assert.ok(!/pass \\`cwd\\`/.test(prompt), 'the model should not be told to pass cwd')
assert.ok(!/Zotero/.test(prompt))
assert.match(read('skills/papermemory/SKILL.md'), /`reference_library`/)

const { buildCliArgs, runReferenceLibrary, ACTIONS } = await import('../reference-library.js')

const work = mkdtempSync(join(tmpdir(), 'ah-reflib-'))
const ws = join(work, 'ws')
mkdirSync(ws, { recursive: true })
writeFileSync(join(ws, 'refs.bib'), '@article{a1, title={One}, author={Lee, Ann}, year=2020, doi={10.1000/a}}\n')
writeFileSync(join(work, 'secret.bib'), '@article{s1, title={Secret}, year=2020}\n')
symlinkSync(join(work, 'secret.bib'), join(ws, 'sneaky.bib'))
const argv = (args) => buildCliArgs({ ...args }, ws).argv

// ---- argument translation
assert.deepEqual(argv({ action: 'list', query: 'tag:ml year:2020..', sort: 'year', desc: true, limit: 5 }), ['list', 'tag:ml', 'year:2020..', '--sort', 'year', '--desc', '--limit', '5'])
assert.deepEqual(argv({ action: 'get', ref: 'smith2020', project: 'thesis' }), ['get', 'smith2020', '--project', 'thesis'])
assert.deepEqual(argv({ action: 'resolve', refs: ['a', '10.1/b'], project: 'p', project_keys: true }), ['resolve', 'a', '10.1/b', '--project', 'p', '--project-keys'])
assert.deepEqual(argv({ action: 'tag', op: 'add', tags: ['ml', 'to-read'], refs: ['a', 'b'] }), ['tag', 'add', 'ml,to-read', 'a', 'b'])
assert.deepEqual(argv({ action: 'tag', op: 'list', query: 'year:2020' }), ['tag', 'list', 'year:2020'])
assert.deepEqual(argv({ action: 'collection', op: 'create', slug: 'thesis', title: 'T', parent: 'all', project: 'p', bib_path: 'refs.bib' }), ['collection', 'create', 'thesis', '--title', 'T', '--parent', 'all', '--project', 'p', '--bib-path', 'refs.bib'])
assert.deepEqual(argv({ action: 'collection', op: 'add', slug: 'thesis', refs: ['a'] }), ['collection', 'add', 'thesis', 'a'])
assert.deepEqual(argv({ action: 'collection', op: 'list' }), ['collection', 'list'])
assert.deepEqual(argv({ action: 'note', op: 'add', ref: 'a', text: 'read the appendix' }), ['note', 'add', 'a', 'read the appendix'])
assert.deepEqual(argv({ action: 'keys', op: 'rekey', ref: 'a', to: 'b', reason: 'clearer', apply: true }), ['keys', 'rekey', 'a', '--to', 'b', '--reason', 'clearer', '--apply'])
assert.deepEqual(argv({ action: 'keys', op: 'rekey', ref: 'a', to: 'b' }), ['keys', 'rekey', 'a', '--to', 'b'], 'rekey is a dry run unless apply is set')
assert.deepEqual(argv({ action: 'keys', op: 'freeze', ref: 'a', label: 'export:x.bib' }), ['keys', 'freeze', 'a', '--label', 'export:x.bib'])
assert.deepEqual(argv({ action: 'merge', keep: 'a', drop: 'b' }), ['merge', 'a', 'b'], 'merge is a preview unless apply is set')
assert.deepEqual(argv({ action: 'merge', keep: 'a', drop: 'b', apply: true, reason: 'same', prefer: 'drop' }), ['merge', 'a', 'b', '--prefer', 'drop', '--apply', '--reason', 'same'])
assert.deepEqual(argv({ action: 'dedupe', limit: 10 }), ['dedupe', '--limit', '10'])
assert.deepEqual(argv({ action: 'set_integrity', items: [{ ref: '10.1/a', status: 'ok' }, 'junk'] }), ['integrity', 'set', '--items-json', '[{"ref":"10.1/a","status":"ok"}]'])
const exp = argv({ action: 'export', cited_only: 'thesis', out: 'references.bib', check: true, format: 'biblatex', variant: 'canonical' })
assert.deepEqual(exp, ['export', '--format', 'biblatex', '--out', 'references.bib', '--cited-only', 'thesis', '--variant', 'canonical', '--check', '--cwd', ws], 'the session workspace is always supplied to export')
assert.deepEqual(argv({ action: 'doctor' }), ['doctor', '--cwd', ws])
assert.equal(ACTIONS.length, 13)

// ---- the workspace is the model's boundary
const imp = buildCliArgs({ action: 'import', path: 'refs.bib', project: 'thesis' }, ws)
assert.deepEqual(imp.argv.slice(1), [join(ws, 'refs.bib'), '--project', 'thesis', '--cwd', ws])
for (const bad of ['../secret.bib', join(work, 'secret.bib'), 'sneaky.bib']) {
  assert.throws(() => buildCliArgs({ action: 'import', path: bad }, ws), /escapes the workspace/, bad)
}
const inline = buildCliArgs({ action: 'import', text: '@misc{x, title={Inline}}' }, ws)
assert.equal(readFileSync(inline.argv[1], 'utf8'), '@misc{x, title={Inline}}')
inline.cleanup()
assert.ok(!existsSync(dirname(inline.argv[1])), 'the temporary import file is removed')
for (const [args, pattern] of [
  [{ action: 'explode' }, /action must be one of/], [{ action: 'get' }, /needs: ref/], [{ action: 'tag', op: 'add' }, /needs: tags, refs/],
  [{ action: 'tag' }, /needs op/], [{ action: 'keys', op: 'rekey' }, /needs: ref/], [{ action: 'merge', keep: 'a' }, /needs: drop/],
  [{ action: 'import' }, /needs: path/], [{ action: 'note', op: 'add', ref: 'a' }, /needs: text/],
]) {
  assert.throws(() => buildCliArgs(args, ws), pattern, JSON.stringify(args))
}

// ---- end to end against the vendored PaperMemory
const wrapper = join(work, 'papermemory')
writeFileSync(wrapper, `#!/bin/sh\nPYTHONPATH="${join(root, 'vendor', 'papermemory')}" exec python3 -m papermemory "$@"\n`)
chmodSync(wrapper, 0o755)
process.env.PAPERMEMORY_CLI = wrapper
process.env.PAPERMEMORY_DB = join(work, 'pm.db')
const exec = { agent: { session: { header: { cwd: ws } } } }
const call = (args) => runReferenceLibrary(args, exec)

assert.ok(spawnSync(wrapper, ['init', '--json']).status === 0)
const imported = await call({ action: 'import', path: 'refs.bib', project: 'thesis' })
assert.equal(imported.counts.added, 1, JSON.stringify(imported))
const outside = await call({ action: 'import', path: '../secret.bib' })
assert.equal(outside.code, 'invalid-argument')
assert.match(outside.error, /escapes the workspace/)
assert.equal((await call({ action: 'import', text: '@article{b1, title={Two}, author={Roe, Rae}, year=2021, doi={10.1000/b}}' })).counts.added, 1)
const listed = await call({ action: 'list', query: 'year:2020..' })
assert.deepEqual(listed.rows.map((r) => r.key), ['a1', 'b1'])
assert.equal((await call({ action: 'get', ref: '10.1000/b' })).key.key, 'b1')
assert.equal((await call({ action: 'tag', op: 'add', tags: ['ML'], refs: ['a1'] })).added, 1)
assert.equal((await call({ action: 'collection', op: 'create', slug: 'refs', project: 'thesis', bib_path: 'out/thesis.bib' })).slug, 'refs')
await call({ action: 'collection', op: 'add', slug: 'refs', refs: ['a1', 'b1'] })

// export: inline, then into the workspace, then the confinement and sync rules
const inlineExport = await call({ action: 'export', all: true })
assert.match(inlineExport.text, /@article\{a1,/)
const written = await call({ action: 'export', all: true, out: 'references.bib' })
assert.equal(written.written, true)
assert.ok(existsSync(join(ws, 'references.bib')), 'the file is written inside the session workspace')
assert.equal((await call({ action: 'export', all: true, out: 'references.bib', check: true })).status, 'in_sync')
const escaped = await call({ action: 'export', all: true, out: '../escape.bib' })
assert.equal(escaped.code, 'path-outside-workspace')
assert.ok(!existsSync(join(work, 'escape.bib')))
const bound = await call({ action: 'export', collection: 'refs' })
assert.equal(bound.written, true, 'a collection bound to a .bib exports there by default')
assert.ok(existsSync(join(ws, 'out', 'thesis.bib')))
writeFileSync(join(ws, 'references.bib'), readFileSync(join(ws, 'references.bib'), 'utf8').replace('One', 'ONE'))
const handEdited = await call({ action: 'export', all: true, out: 'references.bib' })
assert.equal(handEdited.code, 'hand-edited', 'a hand edit is refused, not overwritten')
assert.match(readFileSync(join(ws, 'references.bib'), 'utf8'), /ONE/)
assert.equal((await call({ action: 'export', all: true, out: 'references.bib', force: true })).status, 'overwritten')
assert.ok(readdirSync(ws).some((f) => f.startsWith('references.bib.bak-')), 'forcing keeps a backup')

// the rest of the surface runs through the same bridge
const plan = await call({ action: 'keys', op: 'rekey', ref: 'a1', to: 'lee2020one' })
assert.equal(plan.applied, false)
assert.equal((await call({ action: 'keys', op: 'rekey', ref: 'a1', to: 'lee2020one', apply: true })).code, 'reason-required')
assert.equal((await call({ action: 'keys', op: 'rekey', ref: 'a1', to: 'lee2020one', apply: true, reason: 'clearer' })).applied, true)
assert.equal((await call({ action: 'resolve', refs: ['a1'] })).results[0].key, 'lee2020one', 'the retired key still resolves')
assert.equal((await call({ action: 'doctor' })).summary.papers, 2)
assert.equal((await call({ action: 'dedupe' })).total_groups, 0)
assert.equal((await call({ action: 'set_integrity', items: [{ ref: '10.1000/a', status: 'retracted', source: 'test' }] })).written, 1)
assert.equal((await call({ action: 'list', query: 'integrity:retracted' })).rows[0].key, 'lee2020one')
assert.equal((await call({ action: 'note', op: 'add', ref: 'b1', text: 'check the appendix' })).paper_id.startsWith('pap_'), true)

// an unreachable library is reported, not shown as empty
process.env.PAPERMEMORY_CLI = join(work, 'does-not-exist')
const down = await call({ action: 'list' })
assert.ok(down.error && /not installed|unavailable|exit|ENOENT|papermemory/i.test(down.error), JSON.stringify(down))
assert.equal(down.rows, undefined)

rmSync(work, { recursive: true, force: true })
console.log('reference_library ok')
