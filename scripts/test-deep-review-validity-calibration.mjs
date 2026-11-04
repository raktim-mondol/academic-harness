// Offline test for the Phase 0 validity corpus harness. Uses the committed
// fixture corpus; no PDFs, no network, no model call.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const CORPUS = join(HERE, 'fixtures', 'deep-review', 'validity', 'corpus.json')
const out = mkdtempSync(join(tmpdir(), 'ah-validity-calibration-'))

try {
  execFileSync(process.execPath, [
    join(HERE, 'deep-review-validity-calibration.mjs'),
    '--corpus', CORPUS,
    '--out-dir', out,
  ], { cwd: ROOT, stdio: 'pipe' })

  const jsonFile = readdirSync(out).find((file) => file.endsWith('.json'))
  const mdFile = readdirSync(out).find((file) => file.endsWith('.md'))
  assert.ok(jsonFile, 'the harness writes a JSON report')
  assert.ok(mdFile, 'the harness writes a Markdown report')
  const report = JSON.parse(readFileSync(join(out, jsonFile), 'utf8'))

  assert.equal(report.validity.papers, 5)
  assert.equal(report.validity.evaluated, 5)
  assert.equal(report.validity.labels_complete, 5)
  assert.equal(report.validity.overall_agreement.matched, 20, 'every fixture state matches its designed label')
  assert.equal(report.validity.overall_agreement.total, 20)
  assert.equal(report.validity.false_positive_papers.length, 0, 'the well-formed fixture raises no flag')
  assert.equal(report.validity.determinism_mismatches.length, 0, 'identical bytes reproduce identical states and evidence')

  for (const id of ['attribution', 'evaluator_drift', 'benchmark_coverage', 'unmeasured_trade_off']) {
    const metric = report.validity.per_check[id]
    assert.equal(metric.verdict, 'measured', `${id} has enough labels in the fixture corpus`)
    assert.equal(metric.state_agreement.rate, 1, `${id} matches every fixture label`)
    assert.equal(metric.false_alarm, 0, `${id} has no false alarm on the fixture corpus`)
    assert.equal(metric.missed_clear, 0, `${id} has no wrong clear on the fixture corpus`)
  }

  const markdown = readFileSync(join(out, mdFile), 'utf8')
  assert.match(markdown, /evaluation-validity calibration/)
  assert.match(markdown, /False positives on well-formed papers: 0/)
  assert.match(markdown, /none on the labeled checks/)

  // The fixture corpus is below the six-paper reporting floor, so the overall
  // verdict must say so rather than claiming a measured agreement.
  assert.match(report.validity.verdict, /not_checked \(5\/6 evaluable papers\)/)
  console.log('deep-review validity calibration tests passed')
} finally {
  rmSync(out, { recursive: true, force: true })
}
