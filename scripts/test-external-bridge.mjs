/**
 * External-check bridge: numbers_audit, figure_audit and the citation audit become `.ah/external/<tool>.json`,
 * which the engine reads as tier TX. The tools are faked (they need SciPy, Pillow or the network); the engine is
 * the real one, so this pins the contract between the two languages: paths, hashes, check IDs, fingerprints.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  citationFindings, EXTERNAL_TOOLS, figureFindings, mergeManuscript, numbersFindings, renderExternalRun, reportingFindings, runExternal,
} from '../external-bridge.js'
import { runNumbersAudit } from '../numbers-audit.js'
import { makeWorkspace } from './helpers/test-workspace.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = resolve(HERE, '..', 'vendor', 'academic-harness')
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/* -------------------------------------------------------------- normalizers */

{
  const rows = [
    { kind: 'p_value', line: 12, detail: 'p_mismatch', statistic: 't(28) = 2.1', reported_p: '= 0.9', recomputed_p: 0.0449 },
    { kind: 'grim', line: 30, detail: 'grim_inconsistent', statistic: 'M = 3.47, N = 12' },
    { kind: 'flow_count', line: 40, detail: 'analyzed 80 exceeds randomized 60' },
    { kind: 'effect_ci', line: 50, detail: 'estimate 2.4 outside its CI [0.1, 1.2]' },
    { kind: 'table_text', line: 60, detail: 'Table 2 says 45%, text says 54%' },
  ]
  const found = numbersFindings(rows, 'sections/results.tex')
  assert.deepEqual(found.map((f) => f.check), ['STAT-01', 'STAT-02', 'STAT-03', 'STAT-04', 'STAT-05'])
  assert.ok(found.every((f) => f.file === 'sections/results.tex' && f.key && f.message))
  assert.ok(found.every((f) => !/\b(12|30|40|50|60)\b/.test(f.key.replace(/t\(28\)|2\.1|0\.9|3\.47|N = 12|80|60|2\.4|0\.1|1\.2|45|54|2/g, ''))), 'no line number in a key')
  const moved = numbersFindings(rows.map((r) => ({ ...r, line: r.line + 7 })), 'sections/results.tex')
  assert.deepEqual(moved.map((f) => f.key), found.map((f) => f.key), 'moving a line does not change a key')
  assert.throws(() => numbersFindings([{ kind: 'something_new', line: 1, detail: 'x' }], 'a.tex'), /unmapped kind "something_new"/)
}

{
  const result = {
    files: [
      { path: 'figures/a.png', dpi: [72, 72], flags: ['low_dpi'] },
      { path: 'figures/b.png', dpi: null, flags: ['dpi_missing'] },
      { path: 'figures/c.png', flags: ['unreadable'], error: 'cannot identify image file' },
    ],
    duplicates: [{ a: 'figures/z.png', b: 'figures/m.png', similarity: 0.9712 }],
  }
  const names = { 'figures/a.png': 'figures/a.png' }
  const found = figureFindings(result, (p) => names[p] || p, 300)
  assert.deepEqual(found.map((f) => f.check), ['FIG-01', 'FIG-03', 'FIG-04', 'FIG-02'])
  assert.equal(found[0].message, 'figures/a.png is 72×72 DPI, below 300')
  assert.deepEqual([found[3].file, found[3].key], ['figures/m.png', 'dup|figures/z.png'], 'a pair has one identity whichever way round it was found')
  assert.throws(() => figureFindings({ files: [{ path: 'a.png', flags: ['weird'] }] }, (p) => p, 300), /unmapped flag "weird"/)
}

{
  const audit = {
    references: [
      { key: 'smith2020', doi: '10.1/x', findings: [{ code: 'retracted', detail: 'flagged as retracted' }, { code: 'uncited', detail: 'not cited' }, { code: 'year_mismatch', detail: 'year 2019 vs Crossref 2020' }] },
      { key: 'lee2021', doi: null, findings: [{ code: 'no_doi', detail: 'no DOI' }, { code: 'missing_field', detail: 'missing journal' }, { code: 'missing_field', detail: 'missing volume' }] },
    ],
  }
  const found = citationFindings(audit, 'refs/references.bib')
  assert.deepEqual(found.map((f) => f.check), ['CIT-01', 'CIT-04', 'CIT-06', 'CIT-05', 'CIT-05'], 'uncited is left to BIB-05')
  assert.equal(new Set(found.map((f) => f.key)).size, found.length, 'two missing fields are two findings')
  assert.throws(() => citationFindings({ references: [{ key: 'k', findings: [{ code: 'brand_new', detail: 'x' }] }] }, 'a.bib'), /unmapped code "brand_new"/)
}

{
  const merged = mergeManuscript([{ file: 'a.tex', text: 'One 50\\% real % comment\nTwo' }, { file: 'b.tex', text: 'Three\nFour\n' }])
  assert.equal(merged.text, 'One 50\\% real \nTwo\n\nThree\nFour\n\n', 'a comment is cut, an escaped percent sign is not, every newline stays')
  assert.deepEqual([1, 2, 3, 4, 5, 99].map((n) => merged.locate(n)), [
    { file: 'a.tex', line: 1 }, { file: 'a.tex', line: 2 }, { file: 'a.tex', line: 2 },
    { file: 'b.tex', line: 1 }, { file: 'b.tex', line: 2 }, { file: 'b.tex', line: 2 },
  ], 'the separator line and anything past the end land on the file before them')
  assert.deepEqual(merged.locate(null), { file: 'a.tex', line: null })
}

{
  const status = {
    slug: 'consort-main',
    guideline: { id: 'consort', name: 'CONSORT 2010' },
    items: [
      { item_id: '1a', short_prompt: 'Randomised in the title', verdict: 'not_reported', searched: ['title', 'abstract'], stale: false, evidence_mismatch: false },
      { item_id: '2a', short_prompt: 'Background', verdict: 'partial', stale: false, evidence_mismatch: false },
      { item_id: '3a', short_prompt: 'Trial design', verdict: 'reported', stale: false, evidence_mismatch: true },
      { item_id: '3b', short_prompt: 'Changes to design', verdict: 'not_reported', stale: true, evidence_mismatch: false },
      { item_id: '4a', short_prompt: 'Eligibility', verdict: 'unassessed', stale: false, evidence_mismatch: false },
      { item_id: '5', short_prompt: 'Interventions', verdict: 'reported', stale: false, evidence_mismatch: false },
      { item_id: '6', short_prompt: 'Not relevant', verdict: 'not_applicable', stale: false, evidence_mismatch: false },
    ],
  }
  const found = reportingFindings(status, 'main.tex')
  assert.deepEqual(found.map((f) => [f.check, f.key]), [
    ['RPT-01', 'consort-main|1a|not_reported'],
    ['RPT-01', 'consort-main|2a|partial'],
    ['RPT-02', 'consort-main|3a|quote-gone'],
    ['RPT-01', 'consort-main|3b|not_reported'],
    ['RPT-03', 'consort-main|3b|recheck'],
    ['RPT-03', 'consort-main|4a|unassessed'],
  ], 'reported and not-applicable items say nothing; a stale absence claim is a prompt to re-judge, not a failure')
  assert.ok(found.every((f) => f.file === 'main.tex' && f.line === null))
  assert.match(found[0].message, /CONSORT 2010 item 1a \(Randomised in the title\) is recorded as not reported; searched title, abstract/)
}

/* ------------------------------------------------------------------ runner */

{
  const ws = makeWorkspace('ah-ext-')
  try {
    ws.write('src/a.tex', 'Alpha 1.\n')
    ws.write('src/b.tex', 'Beta 2.\n')
    ws.write('src/refs.bib', '@article{k,title={T}}\n')
    const plan = {
      numbers_audit: { files: [{ path: 'src/a.tex', file: 'a.tex' }, { path: 'src/b.tex', file: 'b.tex' }] },
      figure_audit: { files: [] },
      citation: { files: [{ path: 'src/refs.bib', file: 'refs.bib' }] },
    }
    const calls = []
    const deps = {
      // one run on both files joined: a.tex is lines 1-2 of the joined text (one blank line after it), b.tex starts at 3
      runNumbersAudit: async (args) => { calls.push(['numbers', args.text]); return { rows: [{ kind: 'p_value', line: 3, detail: 'p_mismatch', statistic: 't = 2' }] } },
      runCitation: async () => { calls.push(['citation']); return { references: [{ key: 'k', doi: null, findings: [{ code: 'no_doi', detail: 'no DOI' }] }], lookup: { asof: '2026-11-01T00:00:00Z', max_age_days: 30, served_stale: 0, failed: 0 } } },
      runFigureAudit: async () => { throw new Error('should not run: no figures') },
    }
    const exec = { agent: { session: { header: { cwd: ws.cwd } } } }
    const first = await runExternal({ root: ws.cwd, plan, exec, deps })
    assert.deepEqual(first.written.map((w) => [w.tool, w.findings]), [['numbers_audit', 1], ['citation', 1]])
    assert.deepEqual(first.skipped.map((s) => s.tool), ['figure_audit', 'reporting_check'])
    assert.deepEqual(first.errors, [])

    const numbers = JSON.parse(ws.read('.ah/external/numbers_audit.json'))
    assert.equal(numbers.schema, 1)
    assert.deepEqual(numbers.inputs, { 'src/a.tex': sha256(ws.path('src/a.tex')), 'src/b.tex': sha256(ws.path('src/b.tex')) })
    assert.deepEqual(numbers.findings[0], { check: 'STAT-01', file: 'b.tex', line: 1, key: 'p_value|p_mismatch|t = 2|', message: 'p_value: p_mismatch (t = 2)' }, 'a line of the joined text is mapped back to its own file')
    assert.equal(calls.filter(([kind]) => kind === 'numbers').length, 1, 'one run for the whole manuscript')
    assert.ok(calls[0][1].includes('Alpha 1.') && calls[0][1].includes('Beta 2.'), 'both files were in it')
    assert.equal(JSON.parse(ws.read('.ah/external/citation.json')).lookup.asof, '2026-11-01T00:00:00Z')

    const strip = (text) => JSON.stringify({ ...JSON.parse(text), generated_at: '' })
    const before = strip(ws.read('.ah/external/numbers_audit.json'))
    await runExternal({ root: ws.cwd, plan, exec, deps })
    assert.equal(strip(ws.read('.ah/external/numbers_audit.json')), before, 'running again on the same text writes the same file (but for the time)')

    // one tool failing leaves the others written and its own previous file alone
    const failing = { ...deps, runNumbersAudit: async () => ({ error: 'scipy is not installed' }) }
    const partial = await runExternal({ root: ws.cwd, plan, exec, deps: failing })
    assert.match(partial.errors[0].error, /scipy is not installed/)
    assert.equal(partial.written.map((w) => w.tool).join(), 'citation')
    assert.equal(strip(ws.read('.ah/external/numbers_audit.json')), before)
    assert.match(renderExternalRun(partial), /numbers_audit: FAILED, previous result kept/)

    // the hash is taken before the run: an edit made while a tool runs makes the result stale, not fresh
    const racing = { ...deps, runNumbersAudit: async (args) => { writeFileSync(ws.path('src/a.tex'), 'Alpha 1 edited mid-run.\n'); return { rows: [] } } }
    const oldHash = sha256(ws.path('src/a.tex'))
    await runExternal({ root: ws.cwd, plan, tools: ['numbers_audit'], exec, deps: racing })
    assert.equal(JSON.parse(ws.read('.ah/external/numbers_audit.json')).inputs['src/a.tex'], oldHash)

    // a run that could not recompute p-values is a failure, not an empty result
    const noScipy = { ...deps, runNumbersAudit: async () => ({ rows: [], notes: ['scipy is not installed; p-value recomputation was skipped.'] }) }
    const degradedRun = await runExternal({ root: ws.cwd, plan, tools: ['numbers_audit'], exec, deps: noScipy })
    assert.match(degradedRun.errors[0].error, /scipy is not installed/i)
    assert.deepEqual(degradedRun.written, [])

    // reporting_check: one status read per recorded check, findings tied to the manuscript file
    const reporting = { ...plan, reporting_check: { files: [{ path: 'src/a.tex', file: 'a.tex' }], checks: [{ slug: 'consort-main', file: 'a.tex' }] } }
    const seen = []
    const readsStatus = { ...deps, runReportingCheck: async (args) => { seen.push(args); return { status: { slug: args.slug, guideline: { name: 'CONSORT 2010' }, items: [{ item_id: '1a', verdict: 'not_reported', stale: false, evidence_mismatch: false }] } } } }
    const rpt = await runExternal({ root: ws.cwd, plan: reporting, tools: ['reporting_check'], exec, deps: readsStatus })
    assert.deepEqual(rpt.written.map((w) => [w.tool, w.findings]), [['reporting_check', 1]])
    assert.deepEqual(seen, [{ action: 'status', slug: 'consort-main' }])
    assert.equal(JSON.parse(ws.read('.ah/external/reporting_check.json')).findings[0].check, 'RPT-01')
    const unreadable = await runExternal({ root: ws.cwd, plan: reporting, tools: ['reporting_check'], exec, deps: { ...deps, runReportingCheck: async () => ({ error: 'checklist data changed' }) } })
    assert.match(unreadable.errors[0].error, /consort-main: checklist data changed/)

    const unknown = await runExternal({ root: ws.cwd, plan, tools: ['nope'], exec, deps })
    assert.match(unknown.errors[0].error, /unknown external tool/)
    assert.deepEqual(EXTERNAL_TOOLS, ['numbers_audit', 'figure_audit', 'citation', 'reporting_check'])
  } finally { ws.cleanup() }
}

/* ------------------------------ cross-section totals, with the real helper */

{
  const hasScipy = spawnSync('python3', ['-c', 'import scipy'], { encoding: 'utf8' }).status === 0
  if (!hasScipy) {
    console.warn('SKIP cross-section totals (python3 with scipy not available)')
  } else {
    const ws = makeWorkspace('ah-ext-merge-')
    try {
      ws.write('src/methods.tex', '\\section{Methods}\n\nWe enrolled N = 95 participants at three sites.\n')
      ws.write('src/results.tex', '\\section{Results}\n\nAmong N = 120 participants the primary outcome improved.\n')
      const exec = { agent: { session: { header: { cwd: ws.cwd } } } }
      const files = [{ path: 'src/methods.tex', file: 'methods.tex' }, { path: 'src/results.tex', file: 'results.tex' }]
      for (const entry of files) {
        const alone = await runNumbersAudit({ path: entry.path }, exec)
        assert.deepEqual((alone.rows || []).filter((r) => r.kind === 'n_inconsistent'), [], `${entry.file} on its own agrees with itself`)
      }
      const summary = await runExternal({ root: ws.cwd, plan: { numbers_audit: { files } }, tools: ['numbers_audit'], exec })
      assert.deepEqual(summary.errors, [])
      const written = JSON.parse(ws.read('.ah/external/numbers_audit.json'))
      const total = written.findings.filter((f) => f.check === 'STAT-03' && /different total sample sizes/.test(f.message))
      assert.equal(total.length, 1, 'N = 95 in Methods against N = 120 in Results is found once the files are read together')
      assert.equal(total[0].file, 'methods.tex', 'attributed to the first mention')
      assert.match(total[0].message, /N=95 in methods.*N=120 in results|N=120 in results.*N=95 in methods/)
    } finally { ws.cleanup() }
  }
}

/* ------------------------------------------------- against the real engine */

const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.warn('SKIP engine contract (python3 with pyyaml not available)')
} else {
  const ah = (...args) => spawnSync('python3', ['-c', 'import sys; from ah.cli import main; sys.exit(main(sys.argv[1:]))', ...args], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: ENGINE }, timeout: 120_000,
  })
  const ws = makeWorkspace('ah-ext-engine-')
  try {
    const root = ws.path('paper')
    assert.equal(ah('init', '--profile', 'paper/conference', root).status, 0)
    const intro = join(root, 'src/sections/01_introduction/index.tex')
    writeFileSync(intro, '\\section{Introduction}\n\nWe evaluate on 1240 documents and report t(28) = 2.1, p = 0.9 in the results.\n')
    assert.equal(ah('units', '--project', root, 'sync').status, 0)

    // a reporting-guideline check the agent recorded with reporting_check (manifest + append-only verdict log)
    const store = join(root, '.dsh/reporting/consort-main')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'check.json'), JSON.stringify({ slug: 'consort-main', guideline: { id: 'consort', name: 'CONSORT 2010' }, manuscript: { kind: 'file', path: 'src/sections/01_introduction/index.tex', sha256: 'x' }, item_ids: ['1a'] }))
    writeFileSync(join(store, 'verdicts.jsonl'), `${JSON.stringify({ item_id: '1a', verdict: 'not_reported' })}\n`)

    const plan = JSON.parse(ah('external', 'plan', '--project', root).stdout)
    assert.deepEqual(plan.reporting_check.checks, [{ slug: 'consort-main', file: 'sections/01_introduction/index.tex' }])
    assert.ok(plan.numbers_audit.files.some((e) => e.file === 'sections/01_introduction/index.tex' && e.path === 'src/sections/01_introduction/index.tex'))
    const deps = {
      runNumbersAudit: async (args) => ({
        rows: args.text.includes('1240')
          ? [{ kind: 'p_value', line: args.text.split('\n').findIndex((l) => l.includes('1240')) + 1, detail: 'p_mismatch', statistic: 't(28) = 2.1', reported_p: '= 0.9', recomputed_p: 0.0449 }]
          : [],
      }),
      runCitation: async () => ({ references: [{ key: 'smith2020', doi: '10.1/x', findings: [{ code: 'retracted', detail: 'flagged as retracted' }] }] }),
      runReportingCheck: async () => ({ status: { slug: 'consort-main', guideline: { id: 'consort', name: 'CONSORT 2010' }, items: [{ item_id: '1a', short_prompt: 'Identification as a randomised trial in the title', verdict: 'not_reported', searched: ['title'], stale: false, evidence_mismatch: false }] } }),
      runFigureAudit: async () => ({ files: [], duplicates: [] }),
    }
    const exec = { agent: { session: { header: { cwd: root } } } }
    const summary = await runExternal({ root, plan, exec, deps })
    assert.deepEqual(summary.errors, [])

    const audit = () => JSON.parse(ah('audit', '--project', root, '--external', '--json').stdout)
    const first = audit()
    const tx = first.findings.filter((f) => f.tier === 'TX')
    assert.deepEqual(tx.map((f) => [f.check, f.level]).sort(), [['CIT-01', 'blocker'], ['RPT-01', 'minor'], ['STAT-01', 'minor']])
    const rpt = tx.find((f) => f.check === 'RPT-01')
    assert.equal(rpt.file, 'sections/01_introduction/index.tex')
    assert.equal(rpt.unit, null, 'a guideline item belongs to the manuscript, not to a paragraph')
    const stat = tx.find((f) => f.check === 'STAT-01')
    assert.ok(stat.unit && !stat.unit.includes('#'), 'the line became an anchored unit')
    assert.equal(first.gate.passed, false, 'a retracted reference is a blocker')
    assert.deepEqual(first.unexplained, [])
    assert.equal(first.external.tools.numbers_audit.status, 'fresh')

    const second = audit()
    assert.equal(second.report_hash, first.report_hash)
    assert.equal(second.ledger.new, 0)

    // recording one more verdict makes the stored reporting result stale until it is read again
    writeFileSync(join(store, 'verdicts.jsonl'), `${readFileSync(join(store, 'verdicts.jsonl'), 'utf8')}${JSON.stringify({ item_id: '2a', verdict: 'reported' })}\n`)
    const afterVerdict = audit()
    assert.equal(afterVerdict.external.tools.reporting_check.status, 'stale')
    assert.match(afterVerdict.external.tools.reporting_check.detail, /verdicts\.jsonl changed/)
    assert.equal(afterVerdict.findings.find((f) => f.check === 'RPT-01').state, 'open', 'carried, not fixed')
    await runExternal({ root, plan, tools: ['reporting_check'], exec, deps })
    assert.equal(audit().external.tools.reporting_check.status, 'fresh')

    writeFileSync(intro, readFileSync(intro, 'utf8').replace('1240', '1250'))
    const stale = audit()
    assert.equal(stale.external.tools.numbers_audit.status, 'stale')
    assert.ok(stale.findings.some((f) => f.check === 'EXT-00' && /out of date/.test(f.message)))
    assert.equal(stale.findings.find((f) => f.check === 'STAT-01').state, 'open', 'carried, not fixed by its absence')

    await runExternal({ root, plan, exec, deps: { ...deps, runNumbersAudit: async () => ({ rows: [] }) } })
    const rerun = audit()
    assert.equal(rerun.external.tools.numbers_audit.status, 'fresh')
    assert.equal(rerun.findings.some((f) => f.check === 'STAT-01'), false, 'the tool no longer reports it')
    assert.ok(rerun.ledger.fixed >= 1, 'so the ledger closes it')
    assert.deepEqual(rerun.unexplained, [])
    assert.ok(existsSync(join(root, '.ah/external/citation.json')))
  } finally { ws.cleanup() }
}

console.log('external bridge: all passed')
