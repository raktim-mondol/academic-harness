/**
 * Phase 3: the read-only experiment branch view. The same ledger is the only
 * source of truth; the view must not invent a second one, must not execute or
 * write unless a Mermaid export is explicitly requested, and must keep missing
 * evidence visibly missing.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../experiment-log.js'
import { renderExperimentBranchesMermaid } from '../experiment-store.js'
import { complianceAnalysisRun, freezeAnalysisPlan, runAnalysis } from '../analysis-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const ws = makeWorkspace('ah-branches-')
const cwd = ws.cwd
let tool
apply({ tools: { register(value) { tool = value } } })
const call = (args) => tool.execute(args, fakeExec(cwd))
const ledger = (slug) => join(cwd, '.dsh', 'experiments', slug)
const ledgerBytes = (slug) => Object.fromEntries(
  ['experiment.json', 'runs.jsonl', 'links.jsonl', 'verdicts.jsonl'].map((name) => [name, readFileSync(join(ledger(slug), name), 'utf8')]),
)
const branches = async (args) => {
  const result = await call({ action: 'branches', ...args })
  assert.equal(result.error, undefined, JSON.stringify(result))
  return result
}
const node = (report, runId) => {
  const found = report.nodes.find((entry) => entry.run_id === runId)
  assert.ok(found, `run ${runId} is in the report`)
  return found
}
const anomalyKinds = (report) => report.anomalies.map((entry) => entry.kind)
const jsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const appendJsonl = (file, row) => writeFileSync(file, `${readFileSync(file, 'utf8').replace(/\n?$/, '\n')}${JSON.stringify(row)}\n`)

try {
  ws.write('eval.py', 'print(1)\n')
  ws.write('artifact.bin', 'hashed artifact\n')
  await call({ action: 'start', slug: 'tree', question: 'Does the branch view keep evidence honest?', experiment: {
    metrics: [{ name: 'loss', direction: 'lower' }],
    benchmark: { datasets: ['d'], splits: ['test'], baseline_arm: 'base', task_rules: ['fixed'] },
    protocol: { eval_script: 'eval.py', metric_params: { x: 1 } },
  } })

  const log = (args) => call({ action: 'log', slug: 'tree', ...args })
  const r1 = (await log({ params: { SECRET_TOKEN: 'super-secret-value', method: 'root' }, metrics: { loss: 1.5 }, seed: 1, notes: 'private note super-secret-value', artifacts: ['artifact.bin'] })).run
  const r2 = (await log({ parent: r1.run_id, metrics: { loss: 1.2 }, seed: 2 })).run
  const r3 = (await log({ parent: r2.run_id, metrics: {} })).run
  const r4 = (await log({ metrics: { loss: 0.9 } })).run
  const r5 = (await log({ parent: r1.run_id, metrics: { loss: 1.1 }, seed: 3 })).run
  const r6 = (await log({ parent: r1.run_id, metrics: { loss: 2 } })).run
  const r7 = (await log({ parent: r1.run_id, metrics: { loss: 3 } })).run
  const r8 = (await log({ parent: r1.run_id, metrics: { loss: 4 } })).run
  const r9 = (await log({ metrics: { loss: 5 } })).run
  const r10 = (await log({ metrics: { loss: 6 } })).run
  const baseline = (await log({ role: 'baseline', baseline_ref: 'reproduced', stage: 'full', metrics: { loss: 7 }, protocol: { eval_script: 'eval.py', metric_params: { x: 1 } } })).run
  const drifted = (await log({ role: 'variant', baseline_ref: 'reproduced', stage: 'full', baseline_run_id: baseline.run_id, metrics: { loss: 8 }, protocol: { eval_script: 'eval.py', metric_params: { x: 2 } } })).run

  // Verdicts: good, pruned, engineer, and a budget-exhausted engineer forced bad.
  await call({ action: 'verdict', slug: 'tree', run_id: r2.run_id, verdict: 'good', reason: 'better than the root' })
  await call({ action: 'verdict', slug: 'tree', run_id: r4.run_id, verdict: 'bad', reason: 'leaked the test split' })
  await call({ action: 'verdict', slug: 'tree', run_id: r5.run_id, verdict: 'engineer', reason: 'try another schedule', engineering_round: 1, budget: { max_rounds: 2, used: 1 } })
  await call({ action: 'verdict', slug: 'tree', run_id: r6.run_id, verdict: 'engineer', reason: 'no budget left', engineering_round: 3, budget: { max_rounds: 2, used: 2 } })

  // Linked execution evidence: success, non-zero exit, timeout, and dangling.
  await freezeAnalysisPlan({ cwd, slug: 'ok', plan: { question: 'successful re-execution?' } })
  const ok = await runAnalysis({ cwd, slug: 'ok', command: ['python3', '-c', 'print(1)'], notebookEntry: null })
  await freezeAnalysisPlan({ cwd, slug: 'fail', plan: { question: 'failed re-execution?' } })
  const failed = await runAnalysis({ cwd, slug: 'fail', command: ['python3', '-c', 'raise SystemExit(3)'], notebookEntry: null })
  await freezeAnalysisPlan({ cwd, slug: 'slow', plan: { question: 'timed-out re-execution?' } })
  const timedOut = await runAnalysis({ cwd, slug: 'slow', command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 150, notebookEntry: null })
  assert.equal(ok.exit_code, 0)
  assert.equal(failed.exit_code, 3)
  assert.equal(timedOut.timed_out, true)

  await call({ action: 'link', slug: 'tree', run_id: r2.run_id, target_kind: 'analysis_run', target_id: `ok:${ok.run_id}` })
  await call({ action: 'link', slug: 'tree', run_id: r3.run_id, target_kind: 'analysis_run', target_id: `fail:${failed.run_id}` })
  await call({ action: 'link', slug: 'tree', run_id: r7.run_id, target_kind: 'analysis_run', target_id: `slow:${timedOut.run_id}` })

  // Notebook, review, paper, scientific_result, and cross-ledger experiment links.
  ws.write('.dsh/notebook/session.jsonl', `${JSON.stringify({ id: 'nb-1', type: 'observation', title: 'notebook' })}\n`)
  ws.write('.dsh/review/review-a/records.jsonl', `${JSON.stringify({ id: 'r0001', title: 'record' })}\n`)
  await call({ action: 'start', slug: 'other', question: 'another ledger', experiment: { metrics: [{ name: 'loss', direction: 'lower' }] } })
  const otherRun = (await call({ action: 'log', slug: 'other', metrics: { loss: 0 } })).run
  await call({ action: 'link', slug: 'tree', run_id: r9.run_id, target_kind: 'notebook', target_id: 'nb-1' })
  await call({ action: 'link', slug: 'tree', run_id: r9.run_id, target_kind: 'review', target_id: 'review-a:r0001' })
  await call({ action: 'link', slug: 'tree', run_id: r9.run_id, target_kind: 'paper', target_id: 'doi:10.0000/example' })
  await call({ action: 'link', slug: 'tree', run_id: r9.run_id, target_kind: 'scientific_result', target_id: 'card-1' })
  await call({ action: 'link', slug: 'tree', run_id: r9.run_id, target_kind: 'experiment_run', target_id: `other:${otherRun.run_id}` })

  // A dangling analysis link and a duplicate link record are ledger corruption
  // the view must report, not hide.
  appendJsonl(join(ledger('tree'), 'links.jsonl'), { run_id: r8.run_id, ts: '2026-01-01T00:00:00.000Z', target: { kind: 'analysis_run', id: 'gone:run-missing' }, note: null })
  appendJsonl(join(ledger('tree'), 'links.jsonl'), { run_id: r10.run_id, ts: '2026-01-01T00:00:00.000Z', target: { kind: 'notebook', id: 'nb-1' }, note: null })
  await call({ action: 'link', slug: 'tree', run_id: r10.run_id, target_kind: 'notebook', target_id: 'nb-1' })

  let before = ledgerBytes('tree')
  const textResult = await branches({ slug: 'tree' })
  assert.equal(textResult.format, 'text')
  const report = textResult.branches
  assert.equal(report.read_only, true)
  assert.equal(report.experiment, 'tree')
  assert.equal(report.source_snapshot.files.length, 4)
  assert.equal(report.source_snapshot.changed_during_read, false)
  assert.ok(report.source_snapshot.digest.startsWith('sha256:'))
  assert.ok(report.source_snapshot.files.every((file) => file.exists && /^sha256:/.test(file.sha256)))
  assert.equal(report.counts.runs_total, 12)
  assert.equal(report.counts.runs_included, 12)
  assert.equal(report.counts.duplicate_run_ids, 0)
  assert.deepEqual(report.roots.sort(), [r1.run_id, r4.run_id, r9.run_id, r10.run_id, baseline.run_id, drifted.run_id].sort())

  // Status is evidence-only.
  const n1 = node(report, r1.run_id)
  assert.equal(n1.status, 'not_recorded', 'metrics alone never mean failed')
  assert.equal(n1.execution.state, 'not_recorded')
  assert.equal(n1.metrics_state, 'recorded')
  assert.equal(n1.artifact_count, 1)
  assert.equal(n1.artifacts[0].path, 'artifact.bin')
  assert.match(n1.artifacts[0].sha256, /^sha256:[0-9a-f]{64}$/)
  assert.equal(node(report, r2.run_id).status, 'good')
  assert.equal(node(report, r2.run_id).status_source, 'verdict')
  assert.equal(node(report, r3.run_id).status, 'failed')
  assert.equal(node(report, r3.run_id).metrics_state, 'not_recorded')
  assert.equal(node(report, r3.run_id).execution.failed_run_ids[0], failed.run_id)
  assert.match(node(report, r3.run_id).status_reason, /exited 3/)
  assert.equal(node(report, r4.run_id).status, 'pruned')
  assert.equal(node(report, r5.run_id).status, 'engineering')
  assert.equal(node(report, r6.run_id).status, 'pruned')
  assert.equal(node(report, r6.run_id).verdict.forced, true)
  assert.equal(node(report, r6.run_id).verdict.requested_verdict, 'engineer')
  assert.equal(node(report, r7.run_id).status, 'failed')
  assert.match(node(report, r7.run_id).status_reason, /timed out/)
  assert.equal(node(report, r8.run_id).status, 'unknown')
  assert.equal(node(report, r8.run_id).compliance.state, 'unknown')
  assert.equal(node(report, r9.run_id).status, 'not_recorded')
  assert.equal(node(report, drifted.run_id).spec_drift_state, 'drift')
  assert.deepEqual(node(report, drifted.run_id).spec_drift.changed, ['metric_params'])

  // Link resolution is labelled; no target is silently treated as valid.
  const r2Links = node(report, r2.run_id).links
  assert.equal(r2Links.length, 1)
  assert.equal(r2Links[0].resolution.state, 'resolved')
  assert.equal(r2Links[0].resolution.exit_code, 0)
  assert.equal(r2Links[0].resolution.manifest_state, 'present')
  assert.match(r2Links[0].resolution.manifest_path, /^\.dsh\/analysis\/ok\/runs\//)
  const r8Links = node(report, r8.run_id).links
  assert.equal(r8Links[0].resolution.state, 'not_found')
  assert.match(r8Links[0].resolution.reason, /no analysis run/)
  const r9Links = Object.fromEntries(node(report, r9.run_id).links.map((link) => [link.target.kind, link.resolution]))
  assert.equal(r9Links.notebook.state, 'resolved')
  assert.equal(r9Links.notebook.entry_type, 'observation')
  assert.equal(r9Links.review.state, 'resolved')
  assert.equal(r9Links.review.review_slug, 'review-a')
  assert.equal(r9Links.paper.state, 'not_checked')
  assert.equal(r9Links.scientific_result.state, 'unknown')
  assert.equal(r9Links.experiment_run.state, 'resolved')
  assert.equal(r9Links.experiment_run.experiment_slug, 'other')
  const r10Links = node(report, r10.run_id).links
  assert.equal(r10Links.length, 2)
  assert.equal(r10Links.filter((link) => link.duplicate).length, 1)
  assert.ok(anomalyKinds(report).includes('duplicate_link'))

  // Secrets and free text are not part of the branch view.
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /super-secret-value/)
  assert.doesNotMatch(serialized, /private note/)
  assert.equal(n1.params, undefined)
  assert.equal(n1.notes, undefined)
  assert.equal(n1.environment, undefined)

  // Text is a concise tree and surfaces anomalies and the read-only note.
  const text = tool.output.render({ action: 'branches', slug: 'tree' }, textResult)[0].text
  assert.match(text, /read-only branch view/)
  assert.match(text, /status failed/)
  assert.match(text, /status good/)
  assert.match(text, /SPEC DRIFT/)
  assert.match(text, /link: analysis_run:/)
  assert.match(text, /Parent cycles|Anomalies/)
  assert.match(text, /read-only unless Mermaid output was explicitly written/)

  // JSON is the structured report, not a second representation.
  const jsonResult = await branches({ slug: 'tree', format: 'json' })
  assert.deepEqual({ ...jsonResult.branches, generated_at: report.generated_at }, report)
  assert.equal(jsonResult.branches.mermaid, undefined)
  const jsonText = tool.output.render({ action: 'branches', slug: 'tree', format: 'json' }, jsonResult)[0].text
  assert.equal(JSON.parse(jsonText).counts.runs_total, 12)

  // A later ledger change is distinguishable from the snapshot just read.
  await log({ metrics: { loss: 9 } })
  const later = await branches({ slug: 'tree', format: 'json' })
  assert.notEqual(later.branches.source_snapshot.digest, report.source_snapshot.digest)
  assert.equal(later.branches.source_snapshot.changed_during_read, false)

  // Text/JSON calls and Mermaid without write are read-only.
  before = ledgerBytes('tree')
  assert.deepEqual(ledgerBytes('tree'), before)
  assert.equal(existsSync(join(ledger('tree'), 'exports')), false)
  const mermaidOnly = await branches({ slug: 'tree', format: 'mermaid' })
  assert.match(mermaidOnly.mermaid, /^flowchart TD\n/)
  assert.equal(existsSync(join(ledger('tree'), 'exports')), false)
  assert.deepEqual(ledgerBytes('tree'), before)
  assert.equal(tool.output.render({ action: 'branches', slug: 'tree', format: 'mermaid' }, mermaidOnly)[0].text, mermaidOnly.mermaid)

  // Only an explicitly requested export changes the workspace.
  const written = await branches({ slug: 'tree', format: 'mermaid', write: true })
  assert.equal(written.format, 'mermaid')
  assert.equal(written.path, '.dsh/experiments/tree/exports/branches.mmd')
  assert.equal(written.bytes, Buffer.byteLength(written.mermaid))
  assert.equal(readFileSync(join(cwd, written.path), 'utf8'), written.mermaid)
  assert.deepEqual(readdirSync(join(ledger('tree'), 'exports')), ['branches.mmd'])
  assert.deepEqual(ledgerBytes('tree'), before)
  assert.match((await call({ action: 'branches', slug: 'tree', format: 'mermaid', write: true })).error, /already exists/)
  const overwritten = await branches({ slug: 'tree', format: 'mermaid', write: true, overwrite: true })
  assert.equal(overwritten.path, written.path)
  assert.match((await call({ action: 'branches', slug: 'tree', format: 'text', write: true })).error, /only supported with format: mermaid/)
  assert.match((await call({ action: 'branches', slug: 'tree', format: 'csv' })).error, /format must be one of text, json, mermaid/)

  // Bounds are explicit and never silently ignored.
  assert.match((await call({ action: 'branches', slug: 'tree', max_nodes: 0 })).error, /max_nodes must be an integer/)
  assert.match((await call({ action: 'branches', slug: 'tree', max_nodes: 5001 })).error, /max_nodes must be an integer/)
  await assert.rejects(async () => call({ action: 'branches', slug: 'tree', max_edges: 1.5 }), /max_edges.*integer/)
  assert.match((await call({ action: 'branches', slug: 'tree', max_links_per_run: 501 })).error, /max_links_per_run must be an integer/)

  // Compliance exclusion is inherited from the linked analysis ledger.
  ws.write('bad.py', 'import json\nwith open("r.json", "w") as fh:\n    json.dump({"ok": False}, fh)\n')
  await freezeAnalysisPlan({ cwd, slug: 'bad', plan: {
    question: 'Is the rule satisfied?', outputs: ['r.json'],
    task_rules: [{ id: 'rule', statement: 'ok must be true', check: { path: 'r.json', format: 'json', key: 'ok', op: 'equals', value: true } }],
  } })
  const badRun = await runAnalysis({ cwd, slug: 'bad', command: ['python3', 'bad.py'], notebookEntry: null })
  assert.equal(badRun.exit_code, 0)
  assert.equal((await complianceAnalysisRun({ cwd, slug: 'bad' })).compliance.verdict, 'violated')
  await call({ action: 'start', slug: 'compliance', question: 'excluded?', experiment: {
    metrics: [{ name: 'loss', direction: 'lower' }],
    benchmark: { datasets: ['d'], splits: ['test'], baseline_arm: 'base', task_rules: ['rule'] },
    protocol: { eval_script: 'bad.py', metric_params: {} },
  } })
  const badExperimentRun = (await call({ action: 'log', slug: 'compliance', metrics: { loss: 0.1 } })).run
  await call({ action: 'link', slug: 'compliance', run_id: badExperimentRun.run_id, target_kind: 'analysis_run', target_id: `bad:${badRun.run_id}` })
  const complianceReport = (await branches({ slug: 'compliance' })).branches
  const excluded = node(complianceReport, badExperimentRun.run_id)
  assert.equal(excluded.excluded, true)
  assert.equal(excluded.compliance.state, 'excluded')
  assert.deepEqual(excluded.compliance.detail.violated, ['rule'])
  assert.equal(excluded.status, 'not_recorded', 'a compliance exclusion is not a scientific failure status')

  // Broken ancestry: multiple roots, self, missing, invalid, cycle, duplicate.
  await call({ action: 'start', slug: 'graph', question: 'broken ancestry?', experiment: { metrics: [{ name: 'loss', direction: 'lower' }] } })
  const g1 = (await call({ action: 'log', slug: 'graph', metrics: { loss: 1 } })).run
  const g2 = (await call({ action: 'log', slug: 'graph', parent: g1.run_id, metrics: { loss: 2 } })).run
  const g3 = (await call({ action: 'log', slug: 'graph', parent: g2.run_id, metrics: { loss: 3 } })).run
  const g4 = (await call({ action: 'log', slug: 'graph', metrics: { loss: 4 } })).run
  const runsFile = join(ledger('graph'), 'runs.jsonl')
  const rows = jsonl(runsFile)
  const byId = new Map(rows.map((row) => [row.run_id, row]))
  byId.get(g1.run_id).parent = g3.run_id
  byId.get(g4.run_id).parent = g4.run_id
  const maliciousId = 'evil"]\nclick n0 "owned'
  rows.push({ ...byId.get(g2.run_id) }) // duplicate run id
  rows.push({ run_id: 'g-missing', ts: '2026-01-01T00:00:00.000Z', parent: 'nope', params: {}, metrics: {}, artifacts: [] })
  rows.push({ run_id: 'g-invalid', ts: '2026-01-01T00:00:00.000Z', parent: 42, params: {}, metrics: {}, artifacts: [] })
  rows.push({ run_id: maliciousId, ts: '2026-01-01T00:00:00.000Z', parent: null, params: {}, metrics: { loss: 9 }, artifacts: [] })
  writeFileSync(runsFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const graph = (await branches({ slug: 'graph' })).branches
  assert.equal(graph.counts.cycles, 1)
  assert.deepEqual(graph.cycles[0], [g1.run_id, g2.run_id, g3.run_id].sort())
  assert.deepEqual(graph.orphans.map((entry) => entry.run_id).sort(), [g4.run_id, 'g-invalid', 'g-missing'].sort())
  assert.equal(node(graph, g4.run_id).parent_state, 'self')
  assert.equal(node(graph, 'g-missing').parent_state, 'missing')
  assert.equal(node(graph, 'g-invalid').parent_state, 'invalid')
  assert.equal(node(graph, g1.run_id).parent_state, 'cycle')
  for (const kind of ['parent_cycle', 'parent_self', 'parent_missing', 'parent_invalid', 'duplicate_run_id']) {
    assert.ok(anomalyKinds(graph).includes(kind), `graph reports ${kind}`)
  }
  const graphMermaid = renderExperimentBranchesMermaid(graph)
  assert.match(graphMermaid, /evil&quot;\]<br\/>click n0 &quot;owned/)
  assert.doesNotMatch(graphMermaid, /evil"\]/)
  assert.ok(!graphMermaid.split('\n').some((line) => /^\s*click\s/.test(line)), 'no Mermaid click directive is injected')
  assert.match(graphMermaid, /parent cycle/)
  assert.match(graphMermaid, /self-parent/)
  assert.match(graphMermaid, /missing parent: nope/)

  // Bounded output keeps the omitted counts visible.
  await call({ action: 'start', slug: 'wide', question: 'bounded?', experiment: { metrics: [{ name: 'loss', direction: 'lower' }] } })
  let previous = null
  const wideRuns = []
  for (let index = 0; index < 6; index += 1) {
    const run = (await call({ action: 'log', slug: 'wide', ...(previous ? { parent: previous } : {}), metrics: { loss: index } })).run
    wideRuns.push(run.run_id)
    previous = run.run_id
  }
  await call({ action: 'link', slug: 'wide', run_id: wideRuns[0], target_kind: 'notebook', target_id: 'nb-1' })
  await call({ action: 'link', slug: 'wide', run_id: wideRuns[0], target_kind: 'paper', target_id: 'doi:10.0000/two' })
  const bounded = (await branches({ slug: 'wide', max_nodes: 3, max_edges: 1, max_links_per_run: 1 })).branches
  assert.equal(bounded.nodes.length, 3)
  assert.equal(bounded.counts.runs_total, 6)
  assert.equal(bounded.counts.runs_included, 3)
  assert.equal(bounded.counts.runs_omitted, 3)
  assert.equal(bounded.counts.edges_included, 1)
  assert.equal(bounded.counts.edges_omitted, 4)
  assert.equal(bounded.counts.links_included, 1)
  assert.equal(bounded.counts.links_omitted, 1)
  assert.equal(bounded.truncated, true)
  assert.deepEqual(bounded.limits, { max_nodes: 3, max_edges: 1, max_links_per_run: 1 })
  assert.equal(node(bounded, wideRuns[0]).links_truncated, true)
  for (const kind of ['node_limit_reached', 'edge_limit_reached', 'link_limit_reached']) {
    assert.ok(anomalyKinds(bounded).includes(kind), `bounded view reports ${kind}`)
  }
  const boundedMermaid = renderExperimentBranchesMermaid(bounded)
  assert.match(boundedMermaid, /3 run\(s\) and 4 edge\(s\) omitted/)

  // Corrupt JSONL is reported and does not take down the whole view.
  await call({ action: 'start', slug: 'corrupt', question: 'corrupt?', experiment: { metrics: [{ name: 'loss', direction: 'lower' }] } })
  await call({ action: 'log', slug: 'corrupt', metrics: { loss: 1 } })
  writeFileSync(join(ledger('corrupt'), 'links.jsonl'), `${JSON.stringify({ run_id: 'x0001', target: { kind: 'notebook', id: 'nb-1' } })}\n{not json\n`)
  const corrupt = (await branches({ slug: 'corrupt' })).branches
  assert.equal(corrupt.source_snapshot.files.find((file) => file.path.endsWith('links.jsonl')).corrupt_lines, 1)
  assert.ok(anomalyKinds(corrupt).includes('links_line_corrupt'))
  assert.ok(anomalyKinds(corrupt).includes('comparison_eligibility_unavailable'))
  assert.equal(node(corrupt, 'x0001').comparison_state, 'unknown')
  assert.equal(node(corrupt, 'x0001').compliance.state, 'unknown')
  assert.equal(node(corrupt, 'x0001').status, 'not_recorded')

  console.log('experiment branches OK')
} finally {
  ws.cleanup()
}
