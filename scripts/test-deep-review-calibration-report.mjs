// Offline integration test for the Phase 0 calibration report's score section.
// Builds six synthetic stores plus a decided sample and runs --report.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const tmp = mkdtempSync(join(tmpdir(), 'ah-calibration-report-'))

try {
  const storeRoot = join(tmp, '.dsh', 'deep-review')
  const rows = []
  const decisions = ['Accept', 'Accept', 'Accept', 'Reject', 'Reject', 'Reject']
  const scores = [5, 4.5, 4, 2, 1.5, 2.5]
  for (let index = 0; index < decisions.length; index += 1) {
    const key = `key-${index}`
    const dir = join(storeRoot, key)
    mkdirSync(join(dir, 'rounds'), { recursive: true })
    const sha = createHash('sha1').update(`paper-${index}`).digest('hex')
    const runId = `run-${index}`
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      schemaVersion: 2,
      key,
      input: { path: `paper-${index}.pdf`, file_name: `paper-${index}.pdf`, sha1: sha },
      engine: { provider: 'test', model: 'test-model', route: 'session-model' },
      params: {},
      review: { sha1: sha, params: {}, finished_at: '2026-01-01T00:00:00.000Z' },
      rounds: [{
        round: 1,
        run_id: runId,
        finished_at: '2026-01-01T00:00:00.000Z',
        input_sha1: sha,
        params: {},
        model: 'test-model',
        counts: { comments: 1, by_severity: { CRITICAL: 1 }, checklist_by_status: { NO: 0 }, flagged_citations: 0 },
        artifacts: {},
      }],
      latest_round: 1,
    }))
    writeFileSync(join(dir, 'rounds', `${runId}.json`), JSON.stringify({
      run_id: runId,
      input_sha1: sha,
      counts: { comments: 1, by_severity: { CRITICAL: 1 }, checklist_by_status: { NO: 0 }, flagged_citations: 0 },
      comments: [{ comment_id: `c-${index}`, severity: 'CRITICAL', summary: 'One finding', keys: ['summary:one finding'] }],
      claims: [],
      checklist: [],
      questions: [],
    }))
    writeFileSync(join(dir, 'score.json'), JSON.stringify({
      overall: { score: scores[index], state: 'ok' },
      review: { evaluator_kind: 'held_out', round: 1 },
      scale: { min: 1, max: 5 },
    }))
    rows.push({
      forum_id: `forum-${index}`,
      decision: decisions[index],
      manuscript_sha1: sha,
      manuscript_file: `paper-${index}.pdf`,
    })
  }
  const samplePath = join(tmp, 'sample.json')
  writeFileSync(samplePath, JSON.stringify({ rows }))
  const outDir = join(tmp, 'reports')
  execFileSync(process.execPath, [
    join(HERE, 'deep-review-calibration.mjs'),
    '--store', tmp,
    '--sample', samplePath,
    '--out-dir', outDir,
  ], { cwd: ROOT, stdio: 'pipe' })

  const jsonFile = readdirSync(outDir).find((file) => file.endsWith('.json'))
  const mdFile = readdirSync(outDir).find((file) => file.endsWith('.md'))
  assert.ok(jsonFile && mdFile)
  const report = JSON.parse(readFileSync(join(outDir, jsonFile), 'utf8'))
  const correlation = report.agreement.score_correlation
  assert.equal(correlation.scored, 6)
  assert.equal(correlation.accepts, 3)
  assert.equal(correlation.rejects, 3)
  assert.equal(correlation.held_out, 6)
  assert.equal(correlation.auc, 1, 'all accepted scores exceed all rejected scores')
  assert.ok(correlation.point_biserial_r > 0.9)
  assert.match(correlation.verdict, /^measured/)
  assert.equal(report.agreement.score_correlation_held_out.auc, 1)
  const markdown = readFileSync(join(outDir, mdFile), 'utf8')
  assert.match(markdown, /## Score correlation with real decisions/)
  assert.match(markdown, /mean accepted 4\.5, mean rejected 2/)
  console.log('deep-review calibration report tests passed')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
