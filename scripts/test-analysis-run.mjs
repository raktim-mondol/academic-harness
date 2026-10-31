import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { apply, runAnalysisAction } from '../analysis-run.js'
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

  // Direct runner throws instead of returning {error}.
  await assert.rejects(
    () => runAnalysisAction({ action: 'run', slug: 'primary', command: [] }, exec),
    /non-empty array/,
  )

  delete process.env.E2E_AMBIENT_SECRET
  console.log('analysis_run OK')
} finally {
  workspace.cleanup()
}
