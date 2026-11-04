import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply, runAnalysisAction } from '../analysis-run.js'
import { entrypointFingerprint } from '../analysis-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-analysis-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)

try {
  workspace.write('analysis/main.py', [
    'import os, sys',
    'print("hello from the analysis")',
    'print("token-line api_key=plainsecretvalue12345")',
    'print("env-token:", os.environ.get("E2E_TEST_TOKEN", ""))',
    'print("ambient:", os.environ.get("E2E_AMBIENT_SECRET", ""))',
    'print("no_proxy:", os.environ.get("no_proxy", ""))',
    'with open(os.path.join("results", "table1.csv"), "w") as fh:',
    '    fh.write("a,b\\n1,2\\n")',
  ].join('\n'))
  workspace.write('data/raw.csv', 'x,y\n1,2\n')
  workspace.write('results/.keep', '')
  process.env.E2E_AMBIENT_SECRET = 'ambient-should-not-leak'

  // Plan freeze and versioning.
  let result = await run({ action: 'plan', slug: 'primary', plan: {
    question: 'Does X raise Y?', hypotheses: ['H1'], inputs: ['data/raw.csv'],
    outputs: ['results/table1.csv'], methods: 'OLS', alpha: 0.05, seed: 42,
  } })
  assert.equal(result.version, 1)
  assert.match(result.hash, /^sha256:/)
  result = await run({ action: 'plan', slug: 'primary', plan: {
    question: 'Does X raise Y?', hypotheses: ['H1'], inputs: ['data/raw.csv'],
    outputs: ['results/table1.csv'], methods: 'OLS', alpha: 0.05, seed: 42,
  } })
  assert.equal(result.unchanged, true)
  result = await run({ action: 'plan', slug: 'primary', plan: { question: 'Changed?' } })
  assert.match(result.error, /plan is frozen/)
  result = await run({ action: 'plan', slug: 'primary', plan: { question: 'Changed?' }, new_version: true })
  assert.match(result.error, /requires a reason/)
  result = await run({ action: 'plan', slug: 'primary', plan: { question: 'Changed?', seed: 42, inputs: ['data/raw.csv'], outputs: ['results/table1.csv'] }, new_version: true, reason: 'protocol amendment' })
  assert.equal(result.version, 2)
  assert.equal(result.supersedes, 1)
  result = await run({ action: 'plan', slug: 'bad', plan: { question: 'Escape?', inputs: ['../outside.csv'] } })
  assert.match(result.error, /workspace-relative/)
  result = await run({ action: 'plan', slug: 'bad', plan: {} })
  assert.match(result.error, /question is required/)

  // A successful run with hashes, logs, redaction, and env isolation.
  result = await run({ action: 'run', slug: 'primary', kind: 'python', command: ['python3', 'analysis/main.py'], env: { E2E_TEST_TOKEN: 'supersecretvalue987' } })
  assert.equal(result.run.exit_code, 0, JSON.stringify(result.run.spawn_error || result.run.stderr))
  const first = result.run
  assert.ok(first.duration_ms >= 0)
  assert.equal(first.seed, 42, 'plan seed is inherited')
  assert.equal(first.inputs[0].path, 'data/raw.csv')
  assert.match(first.inputs[0].sha256, /^sha256:/)
  const output = first.outputs.find((entry) => entry.path === 'results/table1.csv')
  assert.match(output.sha256, /^sha256:/)
  assert.ok(first.artifacts.includes('results/table1.csv'))
  assert.ok(existsSync(join(cwd, first.stdout)))
  assert.ok(existsSync(join(cwd, first.stderr)))
  assert.ok(existsSync(join(cwd, '.dsh', 'analysis', 'primary', 'runs', first.run_id, 'manifest.json')))
  const stdoutBody = readFileSync(join(cwd, first.stdout), 'utf8')
  assert.match(stdoutBody, /hello from the analysis/)
  assert.ok(!stdoutBody.includes('supersecretvalue987'), 'explicit env values are redacted')
  assert.match(stdoutBody, /\[redacted:E2E_TEST_TOKEN\]/)
  assert.ok(!stdoutBody.includes('plainsecretvalue12345'), 'key-like text is redacted')
  assert.match(stdoutBody, /api_key=\[redacted\]/)
  assert.ok(!stdoutBody.includes('ambient-should-not-leak'), 'ambient secrets are not forwarded')
  assert.match(stdoutBody, /no_proxy: \*/, 'network is off by default')
  assert.equal(first.environment.network, 'discouraged (no_proxy=* set; not a firewall)')
  assert.ok(first.environment.python, 'python interpreter version captured')
  assert.ok(first.environment.node)

  // A network-allowed run records the choice.
  result = await run({ action: 'run', slug: 'primary', kind: 'python', command: ['python3', 'analysis/main.py'], network: true })
  assert.equal(result.run.spawn_error, null)
  assert.equal(result.run.environment.network, 'allowed')

  // Nonzero exits and timeouts are recorded, not hidden.
  workspace.write('analysis/fail.py', 'import sys\nprint("failing", file=sys.stderr)\nsys.exit(3)\n')
  result = await run({ action: 'run', slug: 'primary', kind: 'python', command: ['python3', 'analysis/fail.py'], outputs: [] })
  assert.equal(result.run.exit_code, 3)
  assert.equal(result.run.outputs.length, 0)
  workspace.write('analysis/slow.py', 'import time\ntime.sleep(5)\n')
  result = await run({ action: 'run', slug: 'primary', kind: 'python', command: ['python3', 'analysis/slow.py'], timeout_ms: 500, outputs: [] })
  assert.equal(result.run.timed_out, true)
  assert.equal(result.run.exit_code, null)

  // A path escape is recorded per output and never written outside the workspace.
  result = await run({ action: 'run', slug: 'primary', kind: 'python', command: ['python3', '-c', 'print(1)'], outputs: ['../escaped.csv', 'results/table1.csv'] })
  const escaped = result.run.outputs.find((entry) => entry.path === '../escaped.csv')
  assert.match(escaped.error, /escapes the workspace/)
  assert.ok(!existsSync(join(cwd, '..', 'escaped.csv')))

  // Runs require a plan.
  result = await run({ action: 'run', slug: 'no-plan', command: ['python3', '-c', 'print(1)'] })
  assert.match(result.error, /call plan first/)
  await assert.rejects(
    run({ action: 'run', slug: 'primary', command: 'python3 analysis/main.py' }),
    /must be an array/,
  )

  // Notebook kind reports a clear not_installed error when no engine exists.
  const hasJupyter = spawnSync('jupyter', ['--version'], { encoding: 'utf8' }).error == null
  const hasPapermill = spawnSync('papermill', ['--version'], { encoding: 'utf8' }).error == null
  if (!hasJupyter && !hasPapermill) {
    workspace.write('analysis/blank.ipynb', JSON.stringify({
      cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5,
    }))
    result = await run({ action: 'run', slug: 'primary', kind: 'notebook', command: ['jupyter'], notebook: 'analysis/blank.ipynb' })
    assert.match(result.error, /not_installed/)
  }

  // status, list, show, diff, export.
  result = await run({ action: 'status', slug: 'primary' })
  assert.equal(result.status.plan.version, 2)
  assert.ok(result.status.runs >= 5)
  assert.ok(result.status.failed >= 2)
  result = await run({ action: 'list', slug: 'primary' })
  assert.ok(result.runs.length >= 5)
  result = await run({ action: 'show', slug: 'primary', run_id: first.run_id })
  assert.equal(result.run.run_id, first.run_id)
  assert.match(result.run.stdout_tail, /hello from the analysis/)
  result = await run({ action: 'show', slug: 'primary', run_id: 'run-missing' })
  assert.match(result.error, /not found/)

  workspace.write('data/raw.csv', 'x,y\n1,2\n3,4\n')
  const second = (await run({ action: 'run', slug: 'primary', kind: 'python', command: ['python3', 'analysis/main.py'] })).run
  result = await run({ action: 'diff', slug: 'primary', run_id: first.run_id, compare_run_id: second.run_id })
  assert.equal(result.diff.changed.some((change) => change.field === 'input_changed' && change.path === 'data/raw.csv'), true)
  result = await run({ action: 'diff', slug: 'primary', run_id: second.run_id, compare_run_id: second.run_id })
  assert.deepEqual(result.diff.changed.filter((change) => change.field !== 'duration' && change.field !== 'timed_out'), [])

  result = await run({ action: 'export', slug: 'primary', run_id: first.run_id })
  assert.match(result.path, /\.dsh\/analysis\/primary\/exports\/run-.*\.md$/)
  const report = readFileSync(join(cwd, result.path), 'utf8')
  assert.match(report, /# Analysis run/)
  assert.match(report, /reproducibility evidence/)
  assert.match(report, /data\/raw\.csv/)
  result = await run({ action: 'export', slug: 'primary', run_id: first.run_id })
  assert.match(result.error, /already exists/)
  result = await run({ action: 'export', slug: 'primary', run_id: first.run_id, overwrite: true })
  assert.ok(!result.error)
  result = await run({ action: 'export', slug: 'primary', run_id: first.run_id, format: 'json', overwrite: true })
  assert.match(result.path, /\.json$/)

  // The lab notebook recorded each run.
  const notebookBody = readFileSync(join(cwd, '.dsh', 'notebook', 'default.jsonl'), 'utf8')
  assert.match(notebookBody, /analysis run run-/)
  assert.match(notebookBody, /"analysis_run"/)
  assert.ok(!notebookBody.includes('supersecretvalue987'))

  // A notebook_entry: false run skips the lab-notebook append.
  const before = readFileSync(join(cwd, '.dsh', 'notebook', 'default.jsonl'), 'utf8').split('\n').length
  await run({ action: 'run', slug: 'primary', kind: 'python', command: ['python3', '-c', 'print(1)'], outputs: [], notebook_entry: false })
  const after = readFileSync(join(cwd, '.dsh', 'notebook', 'default.jsonl'), 'utf8').split('\n').length
  assert.equal(after, before)

  /* ------------------------------------------------ Phase 8 re-execution */

  workspace.write('analysis/repro.py', [
    'import json',
    'with open("repro.json", "w") as fh:',
    '    json.dump({"metrics": {"auroc": 0.82, "fpr95": 0.24}, "uses_external": False}, fh)',
  ].join('\n'))
  result = await run({ action: 'plan', slug: 'repro', plan: {
    question: 'Do the reported numbers reproduce?', outputs: ['repro.json'],
    task_rules: [
      { id: 'no-external', statement: 'the solution uses no external data', check: { path: 'repro.json', format: 'json', key: 'uses_external', op: 'equals', value: false } },
      'the paper reports FPR95',
    ],
  } })
  assert.equal(result.version, 1)

  let reproRun = (await run({ action: 'run', slug: 'repro', kind: 'python', command: ['python3', 'analysis/repro.py'] })).run
  assert.equal(reproRun.exit_code, 0, JSON.stringify(reproRun.spawn_error || reproRun.stderr))

  const reported = [
    { name: 'AUROC', value: 0.82, path: 'repro.json', format: 'json', key: 'metrics.auroc' },
    { name: 'FPR95', value: 0.25, path: 'repro.json', format: 'json', key: 'metrics.fpr95', tolerance: 0.01 },
  ]
  result = await run({ action: 'expect', slug: 'repro', expected: reported, expected_reference: 'reported' })
  assert.equal(result.expectation.expectation_id, 'e0001')
  assert.equal(result.expectation.reference, 'reported')
  assert.equal(result.expectation.metrics.length, 2)
  result = await run({ action: 'expect', slug: 'repro', expected: reported })
  assert.equal(result.unchanged, true, 'an identical expectation is not versioned again')

  result = await run({ action: 'verify_scores', slug: 'repro' })
  assert.equal(result.check.reproduction, true)
  assert.deepEqual(result.check.counts, { match: 2, mismatch: 0, not_checked: 0 })
  const reproCheck = JSON.parse(readFileSync(join(cwd, '.dsh', 'analysis', 'repro', 'runs', reproRun.run_id, 'repro_check.json'), 'utf8'))
  assert.equal(reproCheck.reproduction, true)
  assert.equal(reproCheck.expectation_id, 'e0001')

  // A different reported value is a mismatch, not an error.
  result = await run({ action: 'expect', slug: 'repro', expected: [{ name: 'AUROC', value: 0.9, path: 'repro.json', format: 'json', key: 'metrics.auroc' }] })
  assert.equal(result.expectation.version, 2)
  result = await run({ action: 'verify_scores', slug: 'repro' })
  assert.equal(result.check.reproduction, false)
  assert.equal(result.check.counts.mismatch, 1)

  // An existence rule needs a path, not a parse format.
  result = await run({ action: 'plan', slug: 'rules', plan: {
    question: 'Does the report exist?',
    task_rules: [{ id: 'report', statement: 'the report exists', check: { op: 'exists', path: 'reports/report.txt' } }],
  } })
  assert.ok(!result.error, JSON.stringify(result))

  // A blank or boolean reported value is a validation error, not a zero.
  for (const bad of [null, '', '   ', false, true, [], [5]]) {
    result = await run({ action: 'expect', slug: 'repro', expected: [
      { name: 'bad', value: bad, path: 'repro.json', format: 'json', key: 'metrics.auroc' },
    ] })
    assert.match(result.error, /value must be a finite number/, `rejected ${JSON.stringify(bad)}`)
  }

  // Notebook commands differ only by their per-run output path.
  const notebookA = entrypointFingerprint({ kind: 'notebook', command: ['jupyter', 'nbconvert', '--to', 'notebook', '--output=/w/.dsh/analysis/x/runs/run-1/artifacts/executed.ipynb', '/w/nb.ipynb'] })
  const notebookB = entrypointFingerprint({ kind: 'notebook', command: ['jupyter', 'nbconvert', '--to', 'notebook', '--output=/w/.dsh/analysis/x/runs/run-2/artifacts/executed.ipynb', '/w/nb.ipynb'] })
  assert.deepEqual(notebookA, notebookB)
  assert.notDeepEqual(notebookA, entrypointFingerprint({ kind: 'notebook', command: ['jupyter', 'nbconvert', '--to', 'notebook', '--output=/w/.dsh/analysis/x/runs/run-3/artifacts/executed.ipynb', '/w/other.ipynb'] }))

  // A failed re-execution is not_checked, never a mismatch.
  const failedRepro = (await run({ action: 'run', slug: 'repro', kind: 'python', command: ['python3', 'analysis/does-not-exist.py'] })).run
  result = await run({ action: 'verify_scores', slug: 'repro', run_id: failedRepro.run_id })
  assert.equal(result.check.reproduction, null)
  assert.match(result.check.reason, /exited 2/)

  // Compliance: one machine-checked rule and one caller-supplied rule.
  result = await run({ action: 'compliance', slug: 'repro', run_id: reproRun.run_id, evidence: [{ rule_id: 'r2', satisfied: true }] })
  assert.equal(result.compliance.verdict, 'compliant')
  assert.deepEqual(result.compliance.counts, { satisfied: 2, violated: 0, not_checked: 0 })

  workspace.write('analysis/repro.py', [
    'import json',
    'with open("repro.json", "w") as fh:',
    '    json.dump({"metrics": {"auroc": 0.82, "fpr95": 0.24}, "uses_external": True}, fh)',
  ].join('\n'))
  const violating = (await run({ action: 'run', slug: 'repro', kind: 'python', command: ['python3', 'analysis/repro.py'] })).run
  result = await run({ action: 'compliance', slug: 'repro', run_id: violating.run_id })
  assert.equal(result.compliance.verdict, 'violated')
  assert.equal(result.compliance.counts.violated, 1)
  assert.equal(result.compliance.rules.find((rule) => rule.rule_id === 'no-external').status, 'violated')

  result = await run({ action: 'status', slug: 'repro' })
  assert.deepEqual(result.status.checks.compliance.violated, [violating.run_id])
  result = await run({ action: 'show', slug: 'repro', run_id: violating.run_id })
  assert.equal(result.run.compliance.verdict, 'violated')
  result = await run({ action: 'show', slug: 'repro', run_id: reproRun.run_id })
  assert.ok(result.run.repro_check, 'show carries the stored repro_check')

  result = await run({ action: 'compliance', slug: 'primary' })
  assert.match(result.error, /no task_rules/)
  result = await run({ action: 'expect', slug: 'repro', expected: [{ name: 'x', path: 'repro.json', format: 'json', key: 'x' }] })
  assert.match(result.error, /value must be a finite number/)
  // Changed bytes are not_checked for the run that recorded the old hash.
  const truthRun = (await run({ action: 'run', slug: 'repro', kind: 'python', command: ['python3', 'analysis/repro.py'] })).run
  result = await run({ action: 'verify_scores', slug: 'repro', run_id: truthRun.run_id })
  assert.equal(result.check.reproduction, false)
  workspace.write('repro.json', JSON.stringify({ metrics: { auroc: 0.9, fpr95: 0.24 }, uses_external: true }))
  result = await run({ action: 'verify_scores', slug: 'repro', run_id: truthRun.run_id })
  assert.equal(result.check.reproduction, null)
  assert.match(result.check.metrics[0].reason, /changed after this run/)
  assert.equal(result.check.metrics[0].status, 'not_checked')
  result = await run({ action: 'compliance', slug: 'repro', run_id: truthRun.run_id, evidence: [{ rule_id: 'r2', satisfied: true }] })
  assert.equal(result.compliance.verdict, 'not_checked', 'a changed or foreign file cannot satisfy a machine rule')

  // A vanished interpreter key is drift, not "unchanged".
  const runsFile = join(cwd, '.dsh', 'analysis', 'repro', 'runs.jsonl')
  const manifests = readFileSync(runsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const baseRun = manifests.find((manifest) => manifest.run_id === truthRun.run_id)
  manifests.push({
    ...baseRun,
    run_id: 'run-drift',
    environment: { node: baseRun.environment.node, os: baseRun.environment.os },
  })
  writeFileSync(runsFile, `${manifests.map((manifest) => JSON.stringify(manifest)).join('\n')}\n`)
  result = await run({ action: 'verify_scores', slug: 'repro', run_id: 'run-drift' })
  assert.equal(result.check.reproduction, null)
  assert.match(result.check.reason, /environment changed \(python\)|environment changed/)

  // Direct runner throws instead of returning {error}.
  await assert.rejects(
    () => runAnalysisAction({ action: 'run', slug: 'primary', command: [] }, exec),
    /non-empty array/,
  )

  // An expectation declared before any run has no environment baseline to drift
  // from: the metric comparison decides, not a phantom blocker.
  workspace.write('analysis/noref.py', 'import json\nwith open("noref.json", "w") as fh:\n    json.dump({"score": 0.4}, fh)\n')
  await run({ action: 'plan', slug: 'noref', plan: { question: 'Declared first?', outputs: ['noref.json'] } })
  result = await run({ action: 'expect', slug: 'noref', expected: [{ name: 'score', value: 0.4, path: 'noref.json', format: 'json', key: 'score' }] })
  assert.equal(result.expectation.environment, null, 'no reference run, so no recorded environment')
  await run({ action: 'run', slug: 'noref', kind: 'python', command: ['python3', 'analysis/noref.py'] })
  result = await run({ action: 'verify_scores', slug: 'noref' })
  assert.equal(result.check.reproduction, true, 'a first re-execution is not blocked by an absent baseline')
  assert.equal(result.check.environment.baseline, false)
  assert.match(result.check.environment.note, /no reference run/)

  // Bytes that were already there are not this run's output.
  workspace.write('stale.json', JSON.stringify({ score: 0.99 }))
  workspace.write('analysis/noop.py', 'print("wrote nothing")\n')
  await run({ action: 'plan', slug: 'stale', plan: { question: 'Did it write?', outputs: ['stale.json'] } })
  result = await run({ action: 'expect', slug: 'stale', expected: [{ name: 'score', value: 0.99, path: 'stale.json', format: 'json', key: 'score' }] })
  const noopRun = (await run({ action: 'run', slug: 'stale', kind: 'python', command: ['python3', 'analysis/noop.py'] })).run
  assert.equal(noopRun.outputs[0].written_by_run, false, 'a file untouched by the run is not credited to it')
  assert.equal(noopRun.outputs[0].write_status, 'unchanged')
  assert.equal(noopRun.artifacts.includes('stale.json'), true, 'the artifact is still recorded as present')
  result = await run({ action: 'verify_scores', slug: 'stale', run_id: noopRun.run_id })
  assert.equal(result.check.reproduction, null, 'an unowned file can never confirm the reported value')
  assert.match(result.check.metrics[0].reason, /cannot be credited with writing it/)

  // A named column that is absent is refused, never substituted; a negative data
  // row is refused where it is declared.
  workspace.write('wide.csv', 'metric,other\nauc,0.71\n')
  workspace.write('analysis/wide.py', 'with open("wide.csv", "w") as fh:\n    fh.write("metric,other\\nauc,0.71\\n")\n')
  await run({ action: 'plan', slug: 'wide', plan: { question: 'Which column?', outputs: ['wide.csv'] } })
  result = await run({ action: 'expect', slug: 'wide', expected: [{ name: 'auc', value: 0.71, path: 'wide.csv', format: 'csv', key_column: 'metric', column: 'value' }] })
  const wideRun = (await run({ action: 'run', slug: 'wide', kind: 'python', command: ['python3', 'analysis/wide.py'] })).run
  result = await run({ action: 'verify_scores', slug: 'wide', run_id: wideRun.run_id })
  assert.match(result.check.metrics[0].reason, /has no "value" column/, 'the missing column is named rather than guessed')
  result = await run({ action: 'expect', slug: 'wide', expected: [{ name: 'auc', value: 0.71, path: 'wide.csv', format: 'csv', row: -1 }] })
  assert.match(result.error, /zero-based index/, 'a negative row cannot reach the header')
  result = await run({ action: 'expect', slug: 'wide', expected: [{ name: 'auc', value: 0.71, path: 'wide.csv', format: 'csv', row: 1.5 }] })
  assert.match(result.error, /zero-based index/, 'a fractional row is refused')

  // An output path that cannot be resolved has unknown presence, not absence.
  symlinkSync(dirname(cwd), join(cwd, 'escape.json'))
  await run({ action: 'plan', slug: 'escaped', plan: {
    question: 'Does the escaped output exist?',
    outputs: ['escape.json'],
    task_rules: [{ id: 'escape', statement: 'the escaped output was written', check: { op: 'exists', path: 'escape.json' } }],
  } })
  const escapedRun = (await run({ action: 'run', slug: 'escaped', kind: 'python', command: ['python3', 'analysis/noop.py'] })).run
  assert.ok(escapedRun.outputs[0].error, 'the manifest records why the path was not hashed')
  result = await run({ action: 'compliance', slug: 'escaped', run_id: escapedRun.run_id })
  assert.equal(result.compliance.verdict, 'not_checked', 'an unresolvable path is not read as absent, so "absent" cannot pass it')
  assert.match(result.compliance.rules[0].reason, /could not be resolved|presence is unknown/)

  // A failed pre-run snapshot is not proof that the output was absent.
  symlinkSync(dirname(cwd), join(cwd, 'unknown-prior.json'))
  workspace.write('analysis/replace.py', 'import os, json\nos.unlink("unknown-prior.json")\nwith open("unknown-prior.json", "w") as fh:\n    json.dump({"score": 1}, fh)\n')
  await run({ action: 'plan', slug: 'unknown-prior', plan: { question: 'Was there a prior output?', outputs: ['unknown-prior.json'] } })
  await run({ action: 'expect', slug: 'unknown-prior', expected: [{ name: 'score', value: 1, path: 'unknown-prior.json', key: 'score' }] })
  const unknownPrior = (await run({ action: 'run', slug: 'unknown-prior', kind: 'python', command: ['python3', 'analysis/replace.py'] })).run
  assert.equal(unknownPrior.outputs[0].write_status, 'unknown')
  assert.equal(unknownPrior.outputs[0].written_by_run, false)
  result = await run({ action: 'verify_scores', slug: 'unknown-prior', run_id: unknownPrior.run_id })
  assert.equal(result.check.reproduction, null)

  // Only this run's own artifacts directory is normalised away.
  const ownFingerprint = entrypointFingerprint({
    kind: 'notebook',
    run_id: 'run-9',
    command: ['papermill', '/w/nb.ipynb', '/w/.dsh/analysis/x/runs/run-9/artifacts/executed.ipynb'],
  })
  assert.deepEqual(ownFingerprint, ['papermill', '/w/nb.ipynb'])
  assert.notDeepEqual(ownFingerprint, entrypointFingerprint({
    kind: 'notebook',
    run_id: 'run-9',
    command: ['papermill', '/w/nb.ipynb', '/w/.dsh/analysis/x/runs/run-8/artifacts/executed.ipynb'],
  }), 'another run artifact as the entrypoint is a real change')
  assert.notDeepEqual(ownFingerprint, entrypointFingerprint({
    kind: 'notebook', run_id: 'run-9', command: ['papermill', '/w/other.ipynb', '/w/.dsh/analysis/x/runs/run-9/artifacts/executed.ipynb'],
  }), 'a different notebook is a real change')

  delete process.env.E2E_AMBIENT_SECRET
  console.log('analysis_run OK')
} finally {
  workspace.cleanup()
}
