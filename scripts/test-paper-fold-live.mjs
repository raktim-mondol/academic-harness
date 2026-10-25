/**
 * Live paper_fold integration: uses an already-installed TextFold, never the
 * managed install. CI installs the pinned package and requires this to run;
 * a local checkout without TextFold skips unless TEXTFOLD_LIVE_REQUIRED=1.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env.TEXTFOLD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const required = process.env.TEXTFOLD_LIVE_REQUIRED === '1'

const probe = spawnSync(python, ['-m', 'textfold', '--version'], { encoding: 'utf8', timeout: 30_000 })
if (probe.status !== 0) {
  const message = `paper_fold live test skipped: ${python} -m textfold is not installed`
  if (required) {
    console.error(message)
    process.exit(1)
  }
  console.log(message)
  process.exit(0)
}

const data = mkdtempSync(join(tmpdir(), 'ah-paper-fold-live-data-'))
const ws = mkdtempSync(join(tmpdir(), 'ah-paper-fold-live-ws-'))
const paper = `# A Live Fixture

## 1 Introduction

Papers are long. Readers need a map. A map helps them choose what to read.

## 2 Method

We split the paper. We keep the first sentence of each paragraph. The map is not evidence.
`
writeFileSync(join(ws, 'fixture.md'), paper)

delete process.env.TEXTFOLD_CLI
process.env.TEXTFOLD_SKIP_INSTALL = '1'
process.env.TEXTFOLD_PYTHON = python
process.env.TEXTFOLD_DATA = data

const { paperFold } = await import('../paper-fold.js')

let passed = 0
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`)
  passed += 1
}

try {
  const status = await paperFold({ action: 'status' }, { cwd: ws })
  ok('status ready', status.ok === true && status.ready === true, JSON.stringify(status))
  ok('status version', /^\d+\.\d+\.\d+/.test(status.version), status.version)

  const map = await paperFold({ action: 'map', ref: 'fixture.md' }, { cwd: ws })
  ok('map ok', map.ok === true, JSON.stringify(map))
  ok('map local levels', map.generated === false && map.level === 'takeaway')
  ok('map section ids', /\[[^\]]+\]/.test(map.markdown), map.markdown.slice(0, 300))
  ok('map heading', map.markdown.includes('## 1 Introduction'))
  const id = /\[([^\]]+)\]/.exec(map.markdown)?.[1]
  ok('map has a section id', Boolean(id), map.markdown.slice(0, 300))

  const section = await paperFold({ action: 'section', ref: 'fixture.md', section: id, level: 'key' }, { cwd: ws })
  ok('section ok', section.ok === true, JSON.stringify(section))
  ok('section level', section.level === 'key')
  ok('section text', section.markdown.includes('Papers are long.'))

  const doc = await paperFold({ action: 'doc', ref: 'fixture.md', write_to: 'out/paper.json' }, { cwd: ws })
  ok('doc write', doc.ok === true && doc.write_to === 'out/paper.json')
  const parsed = JSON.parse(readFileSync(join(ws, 'out/paper.json'), 'utf8'))
  ok('doc format', parsed.format === 'textfold/doc' && Array.isArray(parsed.sections) && parsed.sections.length >= 2)

  const exported = await paperFold({ action: 'export', ref: 'fixture.md', write_to: 'out/paper.md' }, { cwd: ws })
  ok('export write', exported.ok === true && exported.level === 'full')
  ok('export text', readFileSync(join(ws, 'out/paper.md'), 'utf8').includes('## 2 Method'))

  console.log(`paper_fold live OK: ${passed} checks (TextFold ${status.version})`)
} finally {
  rmSync(data, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
}
