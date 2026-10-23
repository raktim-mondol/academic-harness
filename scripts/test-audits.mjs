/**
 * Phase 7 fixtures: gating for the four local-audit tools, TEI parsing,
 * repo checklist, and (when scipy/Pillow exist) the real Python helpers.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply as applyStat, runStatAudit } from '../stat-audit.js'
import { apply as applyFigure, runFigureAudit } from '../figure-audit.js'
import { apply as applyPdf, parseTeiReferences, runPdfReferences } from '../pdf-references.js'
import { apply as applyRepo, runRepoAudit } from '../repo-audit.js'

function registered(apply) {
  const names = []
  apply({ tools: { register: (tool) => names.push(tool.name) } })
  return names
}

/* ------------------------------------------------------------------ gating */

{
  delete process.env.AH_ENABLE_OPTIONAL_TOOLS
  delete process.env.GROBID_BASE_URL
  assert.deepEqual(registered(applyStat), [])
  assert.deepEqual(registered(applyFigure), [])
  assert.deepEqual(registered(applyPdf), [])
  assert.deepEqual(registered(applyRepo), [])
}
{
  process.env.AH_ENABLE_OPTIONAL_TOOLS = '1'
  assert.deepEqual(registered(applyStat), ['stat_audit'])
  assert.deepEqual(registered(applyFigure), ['figure_audit'])
  assert.deepEqual(registered(applyRepo), ['repo_audit'])
  assert.deepEqual(registered(applyPdf), [], 'pdf_references needs GROBID_BASE_URL too')
  process.env.GROBID_BASE_URL = 'http://127.0.0.1:8070'
  assert.deepEqual(registered(applyPdf), ['pdf_references'])
  delete process.env.AH_ENABLE_OPTIONAL_TOOLS
  delete process.env.GROBID_BASE_URL
}

/* ----------------------------------------------------------------- stat_audit */

const pythonReady = spawnSync('python3', ['-c', 'import scipy'], { encoding: 'utf8' }).status === 0

{
  const data = await runStatAudit({ text: 't(23) = 2.45, p = 0.022' }, {}, {
    runHelper: async (script, request) => {
      assert.equal(script, 'stat_audit.py')
      assert.equal(request.grim, false)
      return { rows: [{ line: 1, issue: 'incompatible_statistic_and_p', statistic: 't(23) = 2.45', reported_p: '= 0.45', recomputed_p: 0.022316 }], summary: { flagged: 1, grim_checked: 0, grim_flagged: 0 }, notes: [] }
    },
  })
  assert.equal(data.rows[0].issue, 'incompatible_statistic_and_p')
  assert.equal(data.source, '(inline text)')
}

{
  const data = await runStatAudit({ path: '../outside.tex' }, { agent: { session: { header: { cwd: '/tmp' } } } })
  assert.match(data.error, /escapes the workspace/)
}

if (pythonReady) {
  const fixture = [
    'Consistent: t(23) = 2.45, p = 0.022; F(2, 45) = 3.12, p = .05.',
    'Inconsistent: t(23) = 2.45, p = 0.45.',
    'Impossible: t(10) = 2.00, p = 0.',
    'Means: M = 3.45, N = 40 and M = 3.45, N = 41.',
  ].join('\n')
  const data = await runStatAudit({ text: fixture, grim: true }, {})
  assert.equal(data.error, undefined)
  const issues = data.rows.map((row) => row.issue)
  assert.ok(issues.includes('incompatible_statistic_and_p'))
  assert.ok(issues.includes('p_reported_zero'))
  assert.ok(issues.includes('grim_inconsistent'))
  assert.equal(data.summary.grim_flagged, 1)
  assert.ok(!data.rows.some((row) => row.context?.includes('F(2, 45)')), 'consistent statistics stay unflagged')
} else {
  console.log('skip: scipy not available, stat_audit helper assertions skipped')
}

/* ---------------------------------------------------------------- figure_audit */

const pillowReady = spawnSync('python3', ['-c', 'from PIL import Image'], { encoding: 'utf8' }).status === 0

if (pillowReady) {
  const figDir = mkdtempSync(join(tmpdir(), 'ah-figures-'))
  try {
    const script = [
      'from PIL import Image, ImageDraw',
      'import sys',
      'root = sys.argv[1]',
      "for name, color in [('a.png', 'red'), ('b.png', 'red'), ('c.png', 'blue')]:",
      "    img = Image.new('RGB', (1200, 800), color)",
      "    d = ImageDraw.Draw(img); d.rectangle([100, 100, 500, 400], fill='white')",
      "    img.save(root + '/' + name, dpi=(72, 72))",
      "img = Image.new('RGB', (300, 200), 'green')",
      "img.save(root + '/small.png', dpi=(300, 300))",
    ].join('\n')
    const made = spawnSync('python3', ['-c', script, figDir], { encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    const exec = { agent: { session: { header: { cwd: figDir } } } }
    const data = await runFigureAudit({ dir: '.', min_dpi: 300 }, exec)
    assert.equal(data.error, undefined)
    assert.equal(data.summary.files, 4)
    assert.equal(data.summary.low_dpi, 3)
    assert.ok(data.duplicates.some((pair) => pair.a === 'a.png' && pair.b === 'b.png'))
    assert.ok(data.suggested_review_order.length >= 1)
  } finally {
    rmSync(figDir, { recursive: true, force: true })
  }
} else {
  console.log('skip: Pillow not available, figure_audit helper assertions skipped')
}

/* --------------------------------------------------------------- pdf_references */

const tei = `<TEI><text><body><listBibl>
<biblStruct xml:id="b0">
  <analytic>
    <title level="a" type="main">Nanometre-scale thermometry in a living cell</title>
    <author><persName><forename>G.</forename><surname>Kucsko</surname></persName></author>
    <idno type="DOI">10.1038/nature12373</idno>
  </analytic>
  <monogr><title level="j">Nature</title><imprint><date when="2013"/></imprint></monogr>
  <note type="raw_reference">Kucsko, G. et al. Nature 500, 54-58 (2013).</note>
</biblStruct>
<biblStruct xml:id="b1">
  <analytic><title level="a">A &amp; B: an <hi rend="italic">in vitro</hi> study</title></analytic>
  <monogr><imprint><date when="2020"/></imprint></monogr>
</biblStruct>
</listBibl></body></text></TEI>`

const parsed = parseTeiReferences(tei)
assert.equal(parsed.length, 2)
assert.equal(parsed[0].title, 'Nanometre-scale thermometry in a living cell')
assert.equal(parsed[0].doi, '10.1038/nature12373')
assert.equal(parsed[0].year, 2013)
assert.equal(parsed[0].venue, 'Nature')
assert.deepEqual(parsed[0].authors, ['G. Kucsko'])
assert.match(parsed[0].raw, /Kucsko/)
assert.equal(parsed[1].title, 'A & B: an in vitro study')

{
  process.env.GROBID_BASE_URL = 'http://grobid.test:8070'
  const exec = { agent: { session: { header: { cwd: tmpdir() } } } }
  writeFileSync(join(tmpdir(), 'ah-audit-fixture.pdf'), '%PDF-1.4 fixture')
  try {
    let requested
    const data = await runPdfReferences({ path: 'ah-audit-fixture.pdf' }, exec, {
      fetchText: async (url, options) => {
        requested = { url, method: options.method, type: options.headers['Content-Type'] }
        return { ok: true, status: 200, data: tei }
      },
    })
    assert.equal(requested.url, 'http://grobid.test:8070/api/processReferences')
    assert.equal(requested.method, 'POST')
    assert.equal(requested.type, 'application/pdf')
    assert.equal(data.reference_count, 2)
    assert.equal(data.references[0].doi, '10.1038/nature12373')

    const down = await runPdfReferences({ path: 'ah-audit-fixture.pdf' }, exec, {
      fetchText: async () => ({ ok: false, status: 0, error: 'network error: connect ECONNREFUSED' }),
    })
    assert.match(down.error, /GROBID service unavailable/)

    const noRefs = await runPdfReferences({ path: 'ah-audit-fixture.pdf' }, exec, {
      fetchText: async () => ({ ok: true, status: 200, data: '<TEI></TEI>' }),
    })
    assert.match(noRefs.error, /without any biblStruct/)
  } finally {
    rmSync(join(tmpdir(), 'ah-audit-fixture.pdf'), { force: true })
    delete process.env.GROBID_BASE_URL
  }
}

/* ------------------------------------------------------------------ repo_audit */

const repoDir = mkdtempSync(join(tmpdir(), 'ah-repo-'))
try {
  writeFileSync(join(repoDir, 'README.md'), '# Demo\n\nData availability: all data are available in the repository.\n')
  writeFileSync(join(repoDir, 'LICENSE'), 'MIT\n')
  writeFileSync(join(repoDir, 'requirements.txt'), 'numpy\n')
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
  mkdirSync(join(repoDir, 'tests'))
  writeFileSync(join(repoDir, 'tests', 'test_demo.py'), 'def test_ok():\n    assert True\n')
  mkdirSync(join(repoDir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'on: push\n')
  mkdirSync(join(repoDir, 'src'))
  writeFileSync(join(repoDir, 'src', 'main.py'), 'print("hi")\n')
  spawnSync('git', ['init', '-q'], { cwd: repoDir })
  spawnSync('git', ['add', '.'], { cwd: repoDir })
  spawnSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=T', 'commit', '-qm', 'init'], { cwd: repoDir })
  spawnSync('git', ['tag', 'v1.0.0'], { cwd: repoDir })

  const data = await runRepoAudit({ path: repoDir }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
  for (const check of ['readme', 'license', 'environment', 'tests', 'ci', 'entry_points', 'data_availability', 'release']) {
    assert.equal(data.checks[check].ok, true, `${check} should pass`)
  }
  assert.equal(data.run_tests.ran, false, 'tests must not run by default')
  assert.equal(data.github, null)
  assert.ok(data.reproducibility_notes.some((note) => /Tests were not executed/.test(note)))
} finally {
  rmSync(repoDir, { recursive: true, force: true })
}

{
  const emptyDir = mkdtempSync(join(tmpdir(), 'ah-empty-repo-'))
  try {
    const data = await runRepoAudit({ path: emptyDir }, {})
    assert.equal(data.checks.readme.ok, false)
    assert.equal(data.checks.license.ok, false)
    assert.ok(data.reproducibility_notes.length >= 5)
  } finally {
    rmSync(emptyDir, { recursive: true, force: true })
  }
}

{
  const data = await runRepoAudit({ repo_url: 'http://github.com/owner/repo' }, {})
  assert.match(data.error, /https:\/\//)
}

console.log('audits OK')
