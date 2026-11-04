/**
 * Phase 7 fixtures: gating for the four local-audit tools, TEI parsing,
 * repo checklist, and (when scipy/Pillow exist) the real Python helpers.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  delete process.env.GROBID_BASE_URL
  assert.deepEqual(registered(applyPdf), [], 'pdf_references needs GROBID_BASE_URL')
}
{
  assert.deepEqual(registered(applyStat), ['stat_audit'])
  assert.deepEqual(registered(applyFigure), ['figure_audit'])
  assert.deepEqual(registered(applyRepo), ['repo_audit'])
  process.env.GROBID_BASE_URL = 'http://127.0.0.1:8070'
  assert.deepEqual(registered(applyPdf), ['pdf_references'])
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

  // Phase 8: probe finds a runnable benchmark entrypoint without executing it.
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', bench: 'node bench.js' } }))
  writeFileSync(join(repoDir, 'README.md'), '# Demo\n\nRun the benchmark:\n\nnpm run bench\n')
  const probe = await runRepoAudit({ action: 'probe', path: repoDir }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
  assert.equal(probe.runnable, 'yes')
  assert.equal(probe.has_benchmark_entrypoint, true)
  assert.equal(probe.offers_re_execution, 'yes')
  assert.ok(probe.candidates.some((candidate) => candidate.command === 'npm run bench'))
  assert.match(probe.advisory, /nothing was executed/i)

  // Phase 8: align maps method anchors to file:line and emits ah_claims_bind calls.
  writeFileSync(join(repoDir, 'src', 'config.py'), 'THRESHOLD = 0.05\nimport os\n')
  writeFileSync(join(repoDir, 'src', 'other.py'), 'THRESHOLD = 0.05\n')
  const aligned = await runRepoAudit({
    action: 'align',
    path: repoDir,
    anchors: [
      { id: 'threshold', kind: 'constant', text: '0.05', file: 'src/config.py', claim: 'the threshold is 0.05' },
      { id: 'missing', kind: 'equation', pattern: 'softmax\\(x\\)' },
      { id: 'ambiguous', kind: 'symbol', text: 'THRESHOLD' },
    ],
  }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
  assert.deepEqual(aligned.counts, { verified: 1, ambiguous: 1, missing: 1, not_checked: 0 })
  assert.equal(aligned.bind_calls.length, 1)
  assert.equal(aligned.bind_calls[0].source, 'src/config.py')
  assert.equal(aligned.bind_calls[0].lines, '1-1')
  assert.equal(aligned.anchors.find((anchor) => anchor.id === 'ambiguous').matches.length > 1, true)
  const unfiltered = await runRepoAudit({
    action: 'align', path: repoDir, anchors: [{ id: 'threshold', text: '0.05' }],
  }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
  assert.equal(unfiltered.anchors[0].status, 'ambiguous', 'two files match without a file filter')

  // A catastrophic regex is bounded by the vm time budget.
  writeFileSync(join(repoDir, 'src', 'slow.py'), `${'a'.repeat(40)}!\n`)
  const slow = await runRepoAudit({
    action: 'align', path: repoDir, anchors: [{ id: 'slow', pattern: '(a+)+$' }],
  }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
  assert.equal(slow.anchors[0].status, 'not_checked')
  assert.match(slow.anchors[0].reason, /budget/)

  // An anchor naming a non-code file is not_checked, not missing.
  const unscanned = await runRepoAudit({
    action: 'align', path: repoDir, anchors: [{ id: 'readme', text: 'Demo', file: 'README.md' }],
  }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
  assert.equal(unscanned.anchors[0].status, 'not_checked')
  assert.match(unscanned.anchors[0].reason, /was not scanned/)

  // A refused top-level `file` scan reads nothing, so no anchor may be reported
  // `missing` (which would assert the method is absent from the code) and no
  // bind_calls entry may point at content that was never looked at.
  let repoTool
  applyRepo({ tools: { register: (tool) => { repoTool = tool } } })
  writeFileSync(join(repoDir, 'README.md'), '# Demo\n\nRun the benchmark:\n\nnpm run bench\n\nWe use a cosine schedule.\n')
  for (const [name, escaped] of [['lexical escape', '../outside.py'], ['absolute escape', join(tmpdir(), 'outside.py')], ['nonexistent', 'src/nope.py']]) {
    const refused = await runRepoAudit({
      action: 'align',
      path: repoDir,
      file: escaped,
      anchors: [
        { id: 'literal', text: 'THRESHOLD', claim: 'the threshold is 0.05' },
        { id: 'pattern', pattern: 'THRESHOLD' },
      ],
    }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
    assert.equal(refused.scanned_files, 0, `align file ${name} scans nothing`)
    assert.deepEqual(refused.anchors.map((anchor) => anchor.status), ['not_checked', 'not_checked'], `align file ${name} is not_checked, not missing`)
    assert.equal(refused.counts.missing, 0)
    assert.match(refused.anchors[0].reason, /was not scanned/)
    assert.equal(refused.bind_calls.length, 0, 'nothing is bound from unread content')
    assert.match(repoTool.output.render({}, refused)[0].text, /no code\/config file was scanned/)
  }

  // `file` is confined to code/config content: prose yields no scanned content,
  // so a claim cannot be bound to the manuscript text it was lifted from.
  const proseScan = await runRepoAudit({
    action: 'align',
    path: repoDir,
    file: 'README.md',
    anchors: [{ id: 'prose', text: 'cosine schedule', claim: 'we use a cosine schedule' }],
  }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
  assert.equal(proseScan.scanned_files, 0, 'a prose file is not scanned')
  assert.equal(proseScan.anchors[0].status, 'not_checked')
  assert.match(proseScan.anchors[0].reason, /not a code\/config file/)
  assert.equal(proseScan.bind_calls.length, 0, 'prose never reaches ah_claims_bind')

  // A legitimate code file still scans, matches, and offers a bind call.
  const singleFile = await runRepoAudit({
    action: 'align',
    path: repoDir,
    file: 'src/config.py',
    anchors: [{ id: 'threshold', text: 'THRESHOLD', claim: 'the threshold constant is 0.05' }],
  }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
  assert.equal(singleFile.scanned_files, 1)
  assert.deepEqual(singleFile.counts, { verified: 1, ambiguous: 0, missing: 0, not_checked: 0 })
  assert.equal(singleFile.bind_calls.length, 1)
  assert.equal(singleFile.bind_calls[0].source, 'src/config.py')
  assert.match(repoTool.output.render({}, singleFile)[0].text, /1 code\/config file\(s\) scanned/)

  // Symlinked files are not followed.
  const outsideDir = mkdtempSync(join(tmpdir(), 'ah-outside-'))
  try {
    writeFileSync(join(outsideDir, 'secret.py'), 'SECRET_CONSTANT = 42\n')
    symlinkSync(join(outsideDir, 'secret.py'), join(repoDir, 'src', 'linked.py'))
    const linked = await runRepoAudit({
      action: 'align', path: repoDir, anchors: [{ id: 'secret', text: 'SECRET_CONSTANT' }],
    }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
    assert.equal(linked.anchors[0].status, 'missing', 'a symlink outside the repository is not read')

    // Requesting that symlink by name is a refused scan, not an absent anchor.
    const linkedFile = await runRepoAudit({
      action: 'align', path: repoDir, file: 'src/linked.py', anchors: [{ id: 'secret', text: 'SECRET_CONSTANT' }],
    }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
    assert.equal(linkedFile.scanned_files, 0, 'a symlink escape reads no content')
    assert.equal(linkedFile.anchors[0].status, 'not_checked')
    assert.match(linkedFile.anchors[0].reason, /was not scanned/)
    assert.equal(linkedFile.bind_calls.length, 0)
  } finally {
    rmSync(outsideDir, { recursive: true, force: true })
  }
} finally {
  rmSync(repoDir, { recursive: true, force: true })
}

{
  // README prose is not a command; a fenced command is.
  const proseDir = mkdtempSync(join(tmpdir(), 'ah-probe-prose-'))
  try {
    writeFileSync(join(proseDir, 'README.md'), '# Demo\n\nPython is a language. Make sure to cite the data.\n')
    const prose = await runRepoAudit({ action: 'probe', path: proseDir }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
    assert.equal(prose.runnable, 'no', 'prose is not a command')
    assert.equal(prose.has_benchmark_entrypoint, false)

    writeFileSync(join(proseDir, 'README.md'), '# Demo\n\n```bash\npython3 eval.py --split test\n```\n')
    const fenced = await runRepoAudit({ action: 'probe', path: proseDir }, {}, { fetchJson: async () => ({ ok: false, status: 404 }) })
    assert.ok(fenced.candidates.some((candidate) => candidate.command === 'python3 eval.py --split test'))
    assert.equal(fenced.has_benchmark_entrypoint, true)
  } finally {
    rmSync(proseDir, { recursive: true, force: true })
  }
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
