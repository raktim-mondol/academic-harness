/**
 * Phase 8: a compliance-violating analysis run is excluded from experiment
 * best/dominance and from repro_package build/deposit — never refined or shipped.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorkspace } from './helpers/test-workspace.mjs'
import { complianceAnalysisRun, excludedAnalysisRunIds, freezeAnalysisPlan, runAnalysis } from '../analysis-store.js'
import { linkExperimentRun, logExperimentRun, startExperiment, bestExperimentRun, compareExperiments, dominanceExperiment, exportExperiment } from '../experiment-store.js'
import { buildReproPackage, reproDepositPreview, saveReproPlan, verifyReproPackage } from '../repro-package-store.js'

const workspace = makeWorkspace('ah-phase8-compliance-')
const cwd = workspace.cwd

/** The compliance ledger for one analysis slug, as recorded events. */
const complianceLedger = (slug) => readFileSync(join(cwd, '.dsh', 'analysis', slug, 'compliance.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line))

/**
 * An exclusion has to cite the reading that violated the rule: the rule ids the
 * run actually broke, and a `compliance_id` whose ledger verdict is `violated` —
 * not the latest reading, which a sticky re-check can show as `not_checked`.
 */
const assertViolationCited = (excludedRuns, ruleId) => {
  for (const entry of excludedRuns) {
    const ledger = complianceLedger(entry.analysis_slug)
    assert.ok(entry.violated.includes(ruleId), `${entry.run_id} must name the violated rule id: ${JSON.stringify(entry)}`)
    const cited = ledger.find((event) => event.compliance_id === entry.compliance_id)
    assert.equal(cited?.verdict, 'violated', `${entry.run_id} cites ${entry.compliance_id}, which is not a violated reading`)
    assert.equal(cited.run_id, entry.analysis_run_id ?? entry.run_id, 'the cited reading is for the excluded run')
    assert.deepEqual(cited.rules.filter((rule) => rule.status === 'violated').map((rule) => rule.rule_id), entry.violated)
  }
}

try {
  mkdirSync(join(cwd, 'analysis'), { recursive: true })
  writeFileSync(join(cwd, 'analysis', 'bad.py'), 'import json\nwith open("r.json", "w") as fh:\n    json.dump({"ok": False}, fh)\n')
  await freezeAnalysisPlan({ cwd, slug: 'analysis', plan: {
    question: 'Is the rule satisfied?', outputs: ['r.json'],
    task_rules: [{ id: 'rule', statement: 'ok must be true', check: { path: 'r.json', format: 'json', key: 'ok', op: 'equals', value: true } }],
  } })
  const run = await runAnalysis({ cwd, slug: 'analysis', command: ['python3', 'analysis/bad.py'], notebookEntry: null })
  assert.equal(run.exit_code, 0)
  const compliance = await complianceAnalysisRun({ cwd, slug: 'analysis' })
  assert.equal(compliance.compliance.verdict, 'violated')

  await startExperiment({ cwd, slug: 'exp', experiment: { question: 'Which is best?', metrics: [{ name: 'acc', direction: 'higher' }] } })
  await logExperimentRun({ cwd, slug: 'exp', metrics: { acc: 0.99 } })
  await logExperimentRun({ cwd, slug: 'exp', metrics: { acc: 0.80 } })
  await linkExperimentRun({ cwd, slug: 'exp', runId: 'x0001', targetKind: 'analysis_run', targetId: run.run_id, note: 'the violating re-execution' })

  const comparison = compareExperiments(cwd, 'exp')
  assert.deepEqual(comparison.compliance.excluded_run_ids, ['x0001'])
  assert.equal(comparison.runs.find((entry) => entry.run_id === 'x0001').excluded.analysis_run_id, run.run_id)
  assert.equal(comparison.best.acc.run_id, 'x0002', 'the violating run is not the best')
  assert.equal(bestExperimentRun(cwd, 'exp', { metric: 'acc' }).run.run_id, 'x0002')
  assert.deepEqual(dominanceExperiment(cwd, 'exp').front.map((entry) => entry.run_id), ['x0002'])
  assert.deepEqual(dominanceExperiment(cwd, 'exp').excluded.map((entry) => entry.run_id), ['x0001'])

  // Exports are an audit trail: the row is kept, marked excluded.
  const exported = exportExperiment({ cwd, slug: 'exp', format: 'csv' })
  assert.match(readFileSync(join(cwd, exported.path), 'utf8'), /x0001,[^\n]*excluded/)

  // A later file cannot launder the violating run into compliance.
  writeFileSync(join(cwd, 'analysis', 'good.py'), 'import json\nwith open("r.json", "w") as fh:\n    json.dump({"ok": True}, fh)\n')
  await runAnalysis({ cwd, slug: 'analysis', command: ['python3', 'analysis/good.py'], notebookEntry: null })
  const recheck = await complianceAnalysisRun({ cwd, slug: 'analysis', runId: run.run_id })
  assert.equal(recheck.compliance.verdict, 'not_checked', 'a different run\'s file cannot satisfy the rule')
  assert.equal(excludedAnalysisRunIds(cwd, 'analysis').has(run.run_id), true, 'the recorded violation is sticky')
  assert.equal(bestExperimentRun(cwd, 'exp', { metric: 'acc' }).run.run_id, 'x0002')

  await saveReproPlan({ cwd, slug: 'pkg', plan: {
    name: 'Excluded-run package', authors: ['A. Author'],
    analyses: [{ slug: 'analysis' }], experiments: [{ slug: 'exp' }], output_dir: 'pkg-out',
  } })
  const built = buildReproPackage({ cwd, slug: 'pkg' })
  assert.ok(built.warnings.some((warning) => /excluded from the package/.test(warning)))
  assert.deepEqual(built.stale_files, [], 'a first build has nothing to purge')
  const manifest = JSON.parse(readFileSync(join(cwd, 'pkg-out', 'manifest.json'), 'utf8'))
  assert.equal(manifest.excluded_runs.length, 2, 'both the analysis run and the experiment run linked to it are excluded')
  assert.ok(manifest.excluded_runs.some((entry) => entry.run_id === run.run_id))
  assert.ok(manifest.excluded_runs.some((entry) => entry.run_id === 'x0001' && entry.experiment))
  for (const name of ['-manifest.json', '-stdout.log', '-stderr.log']) {
    assert.ok(!existsSync(join(cwd, 'pkg-out', 'analysis', 'analysis', `${run.run_id}${name}`)), `the violating run's ${name} is not packaged`)
  }

  // The citation must survive the sticky re-check above, which appended a
  // `not_checked` reading for this very run.
  assert.ok(complianceLedger('analysis').some((event) => event.run_id === run.run_id && event.verdict === 'not_checked'), 'the re-check is on the ledger')
  assertViolationCited(manifest.excluded_runs, 'rule')
  assert.equal(manifest.excluded_runs.find((entry) => entry.experiment).analysis_run_id, run.run_id)
  assert.match(readFileSync(join(cwd, 'pkg-out', 'README.md'), 'utf8'), /violated frozen task rules \(rule\)/, 'the README names the rule')
  const experimentRuns = readFileSync(join(cwd, 'pkg-out', 'experiments', 'exp-runs.jsonl'), 'utf8')
  assert.doesNotMatch(experimentRuns, /x0001/)
  assert.match(experimentRuns, /x0002/)
  assert.match(readFileSync(join(cwd, 'pkg-out', 'README.md'), 'utf8'), /Compliance exclusions/)

  // A package built before the verdict cannot be deposited unchanged.
  writeFileSync(join(cwd, 'analysis', 'late.py'), 'import json\nwith open("late.json", "w") as fh:\n    json.dump({"ok": True}, fh)\n')
  await freezeAnalysisPlan({ cwd, slug: 'late', plan: {
    question: 'Late rule?', outputs: ['late.json'],
    task_rules: [{ id: 'must-false', statement: 'ok must be false', check: { path: 'late.json', format: 'json', key: 'ok', op: 'equals', value: false } }],
  } })
  const lateRun = await runAnalysis({ cwd, slug: 'late', command: ['python3', 'analysis/late.py'], notebookEntry: null })
  await saveReproPlan({ cwd, slug: 'pkg-late', plan: {
    name: 'Late package', authors: ['A. Author'], analyses: [{ slug: 'late' }], output_dir: 'pkg-late-out',
  } })
  buildReproPackage({ cwd, slug: 'pkg-late' })
  assert.ok(!reproDepositPreview(cwd, 'pkg-late').blockers.some((blocker) => /now excluded/.test(blocker)))
  await complianceAnalysisRun({ cwd, slug: 'late' })
  const stalePreview = reproDepositPreview(cwd, 'pkg-late')
  assert.ok(stalePreview.blockers.some((blocker) => /now excluded/.test(blocker)), JSON.stringify(stalePreview.blockers))
  assert.ok(stalePreview.files.some((file) => file.path.includes(lateRun.run_id)), 'the stale package still contains the run; deposit is blocked')
  assert.match(stalePreview.blockers.find((blocker) => /now excluded/.test(blocker)), /overwrite: true/, 'the remedy names the guarantee the rebuild provides')

  // A rebuild with overwrite: true has to purge what the earlier build copied, or
  // the directory readers tar and ship still holds the excluded run's artifacts.
  const purgeOut = join(cwd, 'pkg-purge-out')
  const lateRun2 = await runAnalysis({ cwd, slug: 'late', command: ['python3', 'analysis/late.py'], notebookEntry: null })
  await saveReproPlan({ cwd, slug: 'pkg-purge', plan: {
    name: 'Purge package', authors: ['A. Author'], license: 'MIT',
    analyses: [{ slug: 'late', run_id: lateRun2.run_id }], manuscript: 'analysis/late.py', output_dir: 'pkg-purge-out',
  } })
  buildReproPackage({ cwd, slug: 'pkg-purge' })
  const shippedRun = ['-manifest.json', '-stdout.log', '-stderr.log'].map((suffix) => join(purgeOut, 'analysis', 'late', `${lateRun2.run_id}${suffix}`))
  assert.ok(shippedRun.every((file) => existsSync(file)), 'the first build ships the run')
  assert.ok(existsSync(join(purgeOut, 'manuscript', 'late.py')), 'the first build ships the manuscript')

  assert.equal((await complianceAnalysisRun({ cwd, slug: 'late', runId: lateRun2.run_id })).compliance.verdict, 'violated', 'the re-run still breaks the rule')
  rmSync(join(cwd, 'analysis', 'late.py'), { force: true }) // the rebuild cannot re-copy it: its earlier copy goes stale
  const userNotes = join(purgeOut, 'scratch', 'notes.txt')
  mkdirSync(join(purgeOut, 'scratch'), { recursive: true })
  writeFileSync(userNotes, 'the authors keep their own notes in the output directory\n')
  const userData = join(purgeOut, 'data', 'extra.csv')
  mkdirSync(join(purgeOut, 'data'), { recursive: true })
  writeFileSync(userData, 'v\n1\n')

  const rebuilt = buildReproPackage({ cwd, slug: 'pkg-purge', overwrite: true })
  assert.ok(shippedRun.every((file) => !existsSync(file)), 'the rebuild purges the excluded run from the package directory')
  assert.ok(!readFileSync(join(purgeOut, 'checksums.sha256'), 'utf8').includes(lateRun2.run_id), 'the checksum list no longer names them')
  assert.ok(existsSync(join(purgeOut, 'manuscript', 'late.py')), 'a stale file outside the builder-managed directories is left alone')
  assert.deepEqual(rebuilt.stale_files.map((stale) => stale.path), ['manuscript/late.py'], JSON.stringify(rebuilt.stale_files))
  assert.ok(rebuilt.warnings.some((warning) => /contains 1 file\(s\) from an earlier build that are no longer in the package: manuscript\/late\.py/.test(warning)), JSON.stringify(rebuilt.warnings))
  assert.ok(existsSync(userNotes), 'a user file is never deleted')
  assert.ok(existsSync(userData), 'a user file inside a managed directory is not build output, so it is never deleted either')
  assertViolationCited(JSON.parse(readFileSync(join(purgeOut, 'manifest.json'), 'utf8')).excluded_runs, 'must-false')

  // The stale leftovers are the check verify used to miss.
  const verified = verifyReproPackage({ cwd, slug: 'pkg-purge' })
  assert.deepEqual(verified.leftover_files, ['data/extra.csv'], JSON.stringify(verified))
  assert.match(verified.problems[0]?.status, /not in the package manifest/)

  // Another clean-looking re-check plus a rebuild cannot launder the citation.
  const launder = await complianceAnalysisRun({ cwd, slug: 'analysis', runId: run.run_id })
  assert.equal(launder.compliance.verdict, 'not_checked', 'the re-check shows no violation for this run')
  const relaundered = buildReproPackage({ cwd, slug: 'pkg', overwrite: true })
  assert.deepEqual(relaundered.stale_files, [], 'nothing of the earlier build survived to be reported')
  assertViolationCited(JSON.parse(readFileSync(join(cwd, 'pkg-out', 'manifest.json'), 'utf8')).excluded_runs, 'rule')

  // An unrelated corrupt ledger must not break a linked experiment, but a
  // corrupt ledger containing its own evidence must still fail closed.
  mkdirSync(join(cwd, '.dsh', 'analysis', 'unrelated'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'analysis', 'unrelated', 'compliance.jsonl'), '{ not json }\n')
  assert.doesNotThrow(() => bestExperimentRun(cwd, 'exp', { metric: 'acc' }))
  // Corrupt exclusion evidence fails closed, never open.
  writeFileSync(join(cwd, '.dsh', 'analysis', 'analysis', 'compliance.jsonl'), '{ not json }\n')
  assert.throws(() => bestExperimentRun(cwd, 'exp', { metric: 'acc' }), /cannot read the compliance ledger/)

  console.log('phase 8 compliance OK')
} finally {
  workspace.cleanup()
}
