import assert from 'node:assert/strict'
import { readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeWorkspace } from './helpers/test-workspace.mjs'
import { TASK_MODES, TASK_EFFORTS, TASK_COMMAND, REVIEW_TOKEN, PAPERS_TOKEN, REFERENCES_TOKEN, WRITE_TOKEN, ANALYZE_TOKEN, HYPOTHESES_TOKEN, validateTaskRequest, taskCommandLine } from '../task-modes.js'
import { apply, referencePromptParts, revisionPaths, reviewPromptParts, slugAndBody, submitAcademicTask, executeTaskTool } from '../academic-task.js'
import { runAsJob } from '../job-runner.js'
import { createTaskModeStore } from '../client/task-mode-store.js'
import { TaskCommandReceipt, TaskRunNotice, TaskSelectorView, TaskSelectorStatus, taskReceiptFromCommand } from '../client/task-selector.js'
import { applyTaskModes, taskRequestId } from '../client/task-modes.js'
import { startRun, readQuery, assertGospel } from '../deep-research-store.js'

const workspace = makeWorkspace('ah-task-modes-')
let count = 0
function test(label, fn) { fn(); count++; console.log(`ok ${label}`) }
const request = (id = 'request_1234567890', overrides = {}) => ({ version: 1, request_id: id, task: 'deep_research', prompt: '  What evidence supports this approach?\n', options: { effort: 'low' }, ...overrides })

function host({ modern = false } = {}) {
  const records = []
  const calls = []
  let mode = { active: false }
  const ctx = {
    planMode: { get: () => mode },
    tools: {
      get: () => ({}),
      async execute(input) {
        const args = modern ? JSON.parse(input.calls[0].arguments) : input.arguments
        calls.push({ args, agent: input.agent, signal: input.signal })
        const value = args.action === 'start' ? { status: 'prepared', run_id: 'dr-0001', effort: 'low' } : { status: 'complete', run_id: 'dr-0001', job_id: 'engine-job' }
        return modern ? { results: [{ result: { isError: false, value } }] } : { isError: false, value }
      },
      ...(modern ? { resolve() {} } : {}),
    },
    jobs: {
      start(spec) {
        const record = { spec, id: `job-${records.length + 1}`, lines: [], progress: [] }
        record.hooks = spec.run({ id: record.id, append: (line) => record.lines.push(line), updateProgress: (line) => record.progress.push(line) })
        records.push(record)
        return record.id
      },
    },
    setMode: (next) => { mode = next }, records, calls,
  }
  return ctx
}
const agent = { id: 'session-one', session: { header: { cwd: workspace.cwd } } }
const invoke = (body, target = agent) => ({ agent: target, signal: new AbortController().signal, attachments: [], rawInput: JSON.stringify(body) })
const taskRecords = (target = agent) => {
  const root = join(workspace.cwd, '.dsh/tasks')
  return readdirSync(root).flatMap((dir) => readdirSync(join(root, dir)).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(join(root, dir, file), 'utf8')))).filter((record) => record.session_id === target.id)
}

try {
  test('seven catalogue entries, all enabled', () => {
    assert.equal(TASK_MODES.length, 7)
    assert.deepEqual(TASK_MODES.filter((mode) => mode.enabled).map((mode) => mode.id), ['deep_research', 'deep_review', 'find_papers', 'check_references', 'write_revise', 'analyze_data', 'generate_hypotheses'])
    assert.deepEqual(TASK_EFFORTS, ['auto', 'low', 'medium', 'high'])
  })
  test('wire roundtrip preserves prompt whitespace and rejects unknown fields/tasks', () => {
    assert.deepEqual(JSON.parse(taskCommandLine(request()).slice(`/${TASK_COMMAND} `.length)), request())
    const review = request('reviewwire_1234567890', { task: 'deep_review', prompt: 'paper/main.tex\nFocus on baselines\n' })
    assert.deepEqual(JSON.parse(taskCommandLine(review).slice(`/${TASK_COMMAND} `.length)), review)
    assert.deepEqual(reviewPromptParts(review.prompt), { path: 'paper/main.tex', focus: 'Focus on baselines' })
    const papers = request('paperswire_1234567890', { task: 'find_papers', prompt: '  sparse attention\n' })
    assert.deepEqual(JSON.parse(taskCommandLine(papers).slice(`/${TASK_COMMAND} `.length)), papers)
    const references = request('refswire_12345678901', { task: 'check_references', prompt: 'refs.bib\n paper/main.tex \n' })
    assert.deepEqual(JSON.parse(taskCommandLine(references).slice(`/${TASK_COMMAND} `.length)), references)
    assert.deepEqual(referencePromptParts(references.prompt), { path: 'refs.bib', manuscript: 'paper/main.tex' })
    assert.throws(() => referencePromptParts('paper/main.tex'), /bibliography path/u)
    assert.deepEqual(revisionPaths('old.tex\nnew.md\n'), { old: 'old.tex', next: 'new.md' })
    assert.throws(() => revisionPaths('only.tex'), /two manuscript/u)
    const named = slugAndBody('sleep-study\nDoes sleep help?\n', { empty: 'enter a research goal first', prefix: 'hypotheses' })
    assert.deepEqual(named, { slug: 'sleep-study', body: 'Does sleep help?' })
    for (const bad of [null, [], request('../escape'), request(undefined, { version: 2 }), request(undefined, { task: 'not_a_task' }), request(undefined, { prompt: ' ' }), request(undefined, { task: 'deep_review', prompt: ' ' }), request(undefined, { task: 'find_papers', prompt: ' ' }), request(undefined, { task: 'check_references', prompt: ' ' }), request(undefined, { task: 'write_revise', prompt: ' ' }), request(undefined, { task: 'analyze_data', prompt: ' ' }), request(undefined, { task: 'generate_hypotheses', prompt: ' ' }), request(undefined, { options: { effort: 'maximum' } }), request(undefined, { options: { confirm_effort: true } }), { ...request(), run: true }]) {
      assert.throws(() => validateTaskRequest(bad))
    }
  })
  for (const modern of [false, true]) {
    const ctx = host({ modern })
    const id = `request_${modern ? 'modern' : 'legacy'}_1234567890`
    const body = request(id)
    const result = submitAcademicTask(ctx, invoke(body))
    assert.equal(result.kind, 'success')
    assert.equal(ctx.calls.length, 0, 'work starts after acceptance, not inside jobs.start')
    assert.equal(submitAcademicTask(ctx, invoke(body)).kind, 'success')
    assert.equal(ctx.records.length, 1)
    assert.equal((await ctx.records[0].hooks.done).status, 'completed')
    assert.deepEqual(ctx.calls.map((call) => call.args.action), ['start', 'run'])
    assert.equal(ctx.calls[0].args.query, body.prompt)
    assert.equal(ctx.calls[0].agent, agent)
    assert.equal(ctx.calls[0].args.effort, 'low')
    assert.equal(taskRecords().find((record) => record.request.request_id === id).status, 'complete')
    assert.equal(submitAcademicTask(ctx, invoke({ ...body, prompt: 'another question' })).kind, 'error')
    // Simulated host restart: no in-memory records, but reservation still prevents another run.
    const restarted = host({ modern })
    assert.equal(submitAcademicTask(restarted, invoke(body)).kind, 'success')
    assert.equal(restarted.records.length, 0)
    count++; console.log(`ok ${modern ? '0.2.2 batch' : '0.2.1 invocation'} dispatch, durable duplicate prevention, exact question`)
  }
  {
    const ctx = host()
    const id = 'request_onejob_1234567890'
    const body = request(id, { prompt: 'metabolic syndrome and diabetic 2' })
    ctx.tools.execute = async (input) => {
      const args = input.arguments
      if (args.action === 'start') return { isError: false, value: { status: 'prepared', run_id: 'dr-0005', effort: 'low', expectation: 'abstracts' } }
      const value = await runAsJob(ctx, { callId: input.callId, signal: input.signal, rootCallId: input.callId }, {
        kind: 'deep-research', label: 'deep research dr-0005 (run)', timeoutMs: 60_000, noun: 'deep research',
      }, async (job) => {
        job.updateProgress('40% draft — model call')
        job.append('[40%] [draft] model call\n')
        return { status: 'complete', run_id: 'dr-0005' }
      })
      return { isError: false, value }
    }
    const result = submitAcademicTask(ctx, invoke(body))
    assert.equal(result.kind, 'success')
    assert.equal((await ctx.records[0].hooks.done).status, 'completed')
    assert.equal(ctx.records.length, 1, 'the research run reuses the task job')
    assert.ok(ctx.records[0].progress.includes('40% draft — model call'), ctx.records[0].progress.join(' | '))
    assert.ok(!ctx.records[0].progress.some((line) => /expand its research job/u.test(line)))
    const saved = taskRecords().find((record) => record.request.request_id === id)
    assert.equal(saved.engine_job_id, null)
    assert.equal(saved.job_id, 'job-1')
    count++; console.log('ok composer research keeps step progress on the one task job')
  }
  {
    workspace.write('paper/main.tex', '\\section{Method}\n')
    for (const modern of [false, true]) {
      const ctx = host({ modern })
      const seen = []
      ctx.tools.execute = async (input) => {
        const call = modern ? input.calls[0] : { name: input.name, arguments: JSON.stringify(input.arguments) }
        const args = JSON.parse(call.arguments)
        seen.push({ name: call.name, args, signal: input.signal })
        const value = { action: 'review', key: 'revkey', dir: '.dsh/deep-review/revkey', round: 1, job_id: 'engine-review' }
        return modern ? { results: [{ result: { isError: false, value } }] } : { isError: false, value }
      }
      const id = `review_${modern ? 'modern' : 'legacy'}_123456`
      const body = request(id, { task: 'deep_review', prompt: 'paper/main.tex\nFocus on the baselines.\n', options: { effort: 'high' } })
      const result = submitAcademicTask(ctx, invoke(body))
      assert.equal(result.kind, 'success')
      assert.match(result.text, /Deep Review/u)
      assert.equal(seen.length, 0, 'review starts after acceptance')
      assert.equal((await ctx.records[0].hooks.done).status, 'completed')
      assert.equal(seen.length, 1)
      assert.equal(seen[0].name, 'deep_review')
      assert.deepEqual(seen[0].args, { action: 'review', path: 'paper/main.tex', focus: 'Focus on the baselines.', topology: 'HIGH' })
      const stored = taskRecords().find((record) => record.request.request_id === id)
      assert.equal(stored.status, 'complete')
      assert.equal(stored.review_key, 'revkey')
      assert.equal(submitAcademicTask(ctx, invoke(body)).kind, 'success')
      assert.equal(ctx.records.length, 1)
      count++
      console.log(`ok deep review ${modern ? '0.2.2 batch' : '0.2.1 invocation'} submits one review`)
    }
    const ctx = host()
    const missing = submitAcademicTask(ctx, invoke(request('review_missing_123456', { task: 'deep_review', prompt: 'paper/missing.tex', options: { effort: 'auto' } })))
    assert.equal(missing.kind, 'error')
    assert.match(missing.text, /file not found/u)
    assert.equal(ctx.records.length, 0)
    const hugeFocus = submitAcademicTask(ctx, invoke(request('review_focus_12345678', { task: 'deep_review', prompt: `paper/main.tex\n${'x'.repeat(4001)}`, options: { effort: 'low' } })))
    assert.match(hugeFocus.text, /4000/u)
    assert.equal(ctx.records.length, 0)
    const auto = request('review_auto_123456789', { task: 'deep_review', prompt: 'paper/main.tex', options: { effort: 'auto' } })
    submitAcademicTask(ctx, invoke(auto))
    assert.equal((await ctx.records[0].hooks.done).status, 'completed')
    assert.equal(ctx.calls[0].args.topology, undefined, 'Auto leaves the engine default topology')
    assert.equal(ctx.calls[0].args.action, 'review')
    ctx.tools.get = () => undefined
    assert.match(submitAcademicTask(ctx, invoke(request('review_off_123456789', { task: 'deep_review', prompt: 'paper/main.tex' }))).text, /Deep Review is not available/u)
    count++
    console.log('ok deep review rejects a missing file and an oversized focus before spending, and Auto omits topology')
  }
  {
    for (const modern of [false, true]) {
      const ctx = host({ modern })
      const seen = []
      ctx.tools.execute = async (input) => {
        const call = modern ? input.calls[0] : { name: input.name, arguments: JSON.stringify(input.arguments) }
        const args = JSON.parse(call.arguments)
        seen.push({ name: call.name, args })
        const value = { query: args.query, papers: [{ title: 'Sparse attention', year: 2024 }], total_unique: 4, sources: ['openalex', 's2'] }
        return modern ? { results: [{ result: { isError: false, value } }] } : { isError: false, value }
      }
      const id = `papers_${modern ? 'modern' : 'legacy'}_123456`
      const body = request(id, { task: 'find_papers', prompt: '  sparse attention\n', options: { effort: 'high' } })
      const result = submitAcademicTask(ctx, invoke(body))
      assert.equal(result.kind, 'success')
      assert.match(result.text, /Find Papers/u)
      assert.equal((await ctx.records[0].hooks.done).status, 'completed')
      assert.equal(seen[0].name, 'literature_search')
      assert.deepEqual(seen[0].args, { query: 'sparse attention', max_results: 50 })
      assert.match(ctx.records[0].lines.join(''), /Sparse attention \(2024\)/u)
      const stored = taskRecords().find((record) => record.request.request_id === id)
      assert.equal(stored.paper_count, 1)
      assert.equal(stored.total_unique, 4)
      count++
      console.log(`ok find papers ${modern ? '0.2.2 batch' : '0.2.1 invocation'} searches once`)
    }
    const ctx = host()
    const long = submitAcademicTask(ctx, invoke(request('papers_long_123456789', { task: 'find_papers', prompt: 'q'.repeat(2001), options: { effort: 'low' } })))
    assert.match(long.text, /2000/u)
    assert.equal(ctx.records.length, 0)
    const ambiguous = request('papers_auto_123456789', { task: 'find_papers', prompt: 'Quickly give me a comprehensive systematic review', options: { effort: 'auto' } })
    assert.equal(submitAcademicTask(ctx, invoke(ambiguous)).kind, 'success')
    assert.equal((await ctx.records[0].hooks.done).status, 'completed')
    assert.equal(ctx.calls[0].args.max_results, undefined, 'Auto leaves the search default')
    assert.equal(ctx.calls[0].args.query, ambiguous.prompt.trim())
    ctx.tools.get = (name) => name === 'literature_search' ? undefined : {}
    assert.match(submitAcademicTask(ctx, invoke(request('papers_off_123456789', { task: 'find_papers', prompt: 'attention' }))).text, /Find Papers is not available/u)
    count++
    console.log('ok find papers rejects an oversized query before spending, and Auto does not ask about effort')
  }
  {
    workspace.write('refs.bib', '@article{smith2020, title={A paper}, author={Smith, Ada}, year={2020}, doi={10.1000/xyz}}\n')
    workspace.write('paper/main.tex', '\\section{Method}\\cite{smith2020}\n')
    for (const modern of [false, true]) {
      const ctx = host({ modern })
      const seen = []
      ctx.tools.execute = async (input) => {
        const call = modern ? input.calls[0] : { name: input.name, arguments: JSON.stringify(input.arguments) }
        const args = JSON.parse(call.arguments)
        seen.push({ name: call.name, args })
        const value = { action: 'audit', count: 3, counts: { problem: 1, review: 0, unverified: 1, no_issues_found: 1 }, references: [{ status: 'problem', key: 'smith2020' }] }
        return modern ? { results: [{ result: { isError: false, value } }] } : { isError: false, value }
      }
      const id = `refs_${modern ? 'modern' : 'legacy'}_123456`
      const body = request(id, { task: 'check_references', prompt: 'refs.bib\npaper/main.tex\n', options: { effort: 'low' } })
      const result = submitAcademicTask(ctx, invoke(body))
      assert.equal(result.kind, 'success')
      assert.match(result.text, /Check References/u)
      assert.equal((await ctx.records[0].hooks.done).status, 'completed')
      assert.equal(seen[0].name, 'citation')
      assert.deepEqual(seen[0].args, { action: 'audit', path: 'refs.bib', manuscript: 'paper/main.tex', max_audit: 25 })
      assert.match(ctx.records[0].lines.join(''), /problem smith2020/u)
      const stored = taskRecords().find((record) => record.request.request_id === id)
      assert.equal(stored.reference_count, 3)
      assert.equal(stored.finding_counts.problem, 1)
      count++
      console.log(`ok check references ${modern ? '0.2.2 batch' : '0.2.1 invocation'} audits once`)
    }
    const ctx = host()
    const missing = submitAcademicTask(ctx, invoke(request('refs_missing_1234567', { task: 'check_references', prompt: 'missing.bib', options: { effort: 'auto' } })))
    assert.match(missing.text, /file not found/u)
    assert.equal(ctx.records.length, 0)
    const manuscriptOnly = submitAcademicTask(ctx, invoke(request('refs_tex_1234567890', { task: 'check_references', prompt: 'paper/main.tex' })))
    assert.match(manuscriptOnly.text, /bibliography path/u)
    assert.equal(ctx.records.length, 0)
    const auto = request('refs_auto_1234567890', { task: 'check_references', prompt: 'refs.bib', options: { effort: 'auto' } })
    assert.equal(submitAcademicTask(ctx, invoke(auto)).kind, 'success')
    assert.equal((await ctx.records[0].hooks.done).status, 'completed')
    assert.equal(ctx.calls[0].args.max_audit, undefined, 'Auto leaves the audit default')
    assert.equal(ctx.calls[0].args.manuscript, undefined)
    ctx.tools.get = (name) => name === 'citation' ? undefined : {}
    assert.match(submitAcademicTask(ctx, invoke(request('refs_off_12345678901', { task: 'check_references', prompt: 'refs.bib' }))).text, /Check References is not available/u)
    count++
    console.log('ok check references rejects a missing bibliography before spending, and Auto omits max_audit')
  }
  {
    workspace.write('old.tex', '\\section{Old}\n')
    workspace.write('new.tex', '\\section{New}\n')
    const ctx = host()
    const seen = []
    ctx.tools.execute = async (input) => {
      seen.push(input.arguments)
      return { isError: false, value: { action: 'diff', out: '.dsh/manuscript-diff/new/diff.tex', bytes: 12 } }
    }
    const body = request('write_low_12345678901', { task: 'write_revise', prompt: 'old.tex\nnew.tex\n', options: { effort: 'low' } })
    assert.equal(submitAcademicTask(ctx, invoke(body)).kind, 'success')
    assert.equal((await ctx.records[0].hooks.done).status, 'completed')
    assert.deepEqual(seen[0], { action: 'diff', old: 'old.tex', new: 'new.tex', compile: false })
    assert.equal(taskRecords().find((record) => record.request.request_id === body.request_id).diff_path, '.dsh/manuscript-diff/new/diff.tex')
    const auto = host()
    submitAcademicTask(auto, invoke(request('write_auto_1234567890', { task: 'write_revise', prompt: 'old.tex\nnew.tex', options: { effort: 'auto' } })))
    assert.equal((await auto.records[0].hooks.done).status, 'completed')
    assert.equal(auto.calls[0].args.compile, undefined)
    const bad = submitAcademicTask(host(), invoke(request('write_bad_1234567890', { task: 'write_revise', prompt: 'notes.docx\nnotes2.docx' })))
    assert.match(bad.text, /\.tex, \.md, or \.txt/u)
    assert.match(submitAcademicTask(host(), invoke(request('write_miss_123456789', { task: 'write_revise', prompt: 'missing.tex\nold.tex' }))).text, /file not found/u)
    count++
    console.log('ok write / revise diffs two manuscripts and does not edit them')
  }
  {
    const ctx = host()
    const seen = []
    ctx.tools.execute = async (input) => {
      seen.push(input.arguments)
      return { isError: false, value: { action: 'plan', slug: input.arguments.slug, version: 1 } }
    }
    const body = request('analyze_123456789012', { task: 'analyze_data', prompt: 'sleep-study\nDid sleep change recall?\n', options: { effort: 'high' } })
    assert.equal(submitAcademicTask(ctx, invoke(body)).kind, 'success')
    assert.equal((await ctx.records[0].hooks.done).status, 'completed')
    assert.equal(seen[0].action, 'plan')
    assert.equal(seen[0].slug, 'sleep-study')
    assert.equal(seen[0].plan.question, 'Did sleep change recall?')
    assert.equal(seen[0].command, undefined, 'the composer does not run an analysis command')
    assert.equal(taskRecords().find((record) => record.request.request_id === body.request_id).analysis_slug, 'sleep-study')
    const derived = host()
    submitAcademicTask(derived, invoke(request('analyze_auto_12345678', { task: 'analyze_data', prompt: 'What changed?', options: { effort: 'auto' } })))
    assert.match((await derived.records[0].hooks.done).detail, /No command ran/u)
    assert.match(derived.calls[0].args.slug, /^analysis-[a-f0-9]{12}$/u)
    count++
    console.log('ok analyze data freezes a plan and runs no command')
  }
  {
    const ctx = host()
    const seen = []
    ctx.tools.execute = async (input) => {
      seen.push(input.arguments)
      return { isError: false, value: { action: 'start', slug: input.arguments.slug } }
    }
    const body = request('hypo_high_1234567890', { task: 'generate_hypotheses', prompt: 'Does sleep improve consolidation?', options: { effort: 'high' } })
    assert.equal(submitAcademicTask(ctx, invoke(body)).kind, 'success')
    assert.equal((await ctx.records[0].hooks.done).status, 'completed')
    assert.equal(seen[0].action, 'start')
    assert.equal(seen[0].goal, 'Does sleep improve consolidation?')
    assert.equal(seen[0].max_hypotheses, 8)
    assert.match(seen[0].slug, /^hypotheses-[a-f0-9]{12}$/u)
    assert.match(ctx.records[0].lines.join(''), /no hypothesis text was written/u)
    const auto = host()
    submitAcademicTask(auto, invoke(request('hypo_auto_1234567890', { task: 'generate_hypotheses', prompt: 'goal-one\nA shorter goal', options: { effort: 'auto' } })))
    assert.equal((await auto.records[0].hooks.done).status, 'completed')
    assert.equal(auto.calls[0].args.slug, 'goal-one')
    assert.equal(auto.calls[0].args.max_hypotheses, undefined)
    count++
    console.log('ok generate hypotheses opens a tournament and writes no hypothesis text')
  }
  test('plan mode, pending entry, malformed input, attachments, and unavailable engine spend nothing', () => {
    const ctx = host()
    ctx.setMode({ active: true })
    assert.match(submitAcademicTask(ctx, invoke(request('plan_12345678901234'))).text, /Plan mode/u)
    ctx.setMode({ active: false, pending: true })
    assert.equal(submitAcademicTask(ctx, invoke(request('plan_12345678901234'))).kind, 'error')
    ctx.setMode({ active: false })
    assert.equal(submitAcademicTask(ctx, { ...invoke(request()), rawInput: '{' }).kind, 'error')
    assert.match(submitAcademicTask(ctx, { ...invoke(request()), attachments: [{}] }).text, /Remove attachments/u)
    ctx.tools.get = () => undefined
    assert.match(submitAcademicTask(ctx, invoke(request())).text, /not available/u)
    assert.equal(ctx.records.length, 0)
  })
  test('Auto conflicts ask before any job; explicit effort resolves the same pending question', () => {
    const ctx = host()
    const body = request('conflict_12345678901234', { prompt: 'Quickly give me a comprehensive systematic review', options: { effort: 'auto' } })
    const result = submitAcademicTask(ctx, invoke(body))
    assert.equal(result.kind, 'error')
    assert.match(result.text, /Nothing has run/u)
    assert.equal(ctx.records.length, 0)
    assert.equal(ctx.calls.length, 0)
  })
  {
    const ctx = host()
    ctx.tools.execute = async () => ({ isError: true, error: { message: 'approval denied' } })
    const result = submitAcademicTask(ctx, invoke(request('denied_12345678901234')))
    assert.equal(result.kind, 'success')
    const outcome = await ctx.records[0].hooks.done
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.detail, /approval denied/u)
    count++; console.log('ok tool-policy denial is recorded as failed, never bypassed')
  }
  {
    const ctx = host()
    submitAcademicTask(ctx, invoke(request('cancel_12345678901234')))
    ctx.records[0].hooks.cancel('user cancelled')
    assert.equal((await ctx.records[0].hooks.done).status, 'killed')
    assert.equal(ctx.calls.length, 0)
    count++; console.log('ok job cancellation aborts the tool signal before work')
  }
  {
    const ctx = host()
    submitAcademicTask(ctx, invoke(request('lateplan_12345678901234')))
    ctx.setMode({ active: true })
    assert.equal((await ctx.records[0].hooks.done).status, 'failed')
    assert.equal(ctx.calls.length, 0)
    count++; console.log('ok Plan mode is rechecked inside the actual execution')
  }
  {
    const ctx = host()
    ctx.tools.execute = async () => ({ isError: false, value: { status: 'blocked', run_id: 'dr-0002' } })
    await assert.rejects(() => executeTaskTool({ ...ctx, tools: { execute: async () => ({ isError: false, value: { error: 'engine failed' } }) } }, agent, new AbortController().signal, {}), /engine failed/u)
    count++; console.log('ok structured engine errors are not reported as success')
  }
  {
    const ctx = host()
    const second = { ...agent, id: 'session-two' }
    const body = request('isolated_12345678901234')
    submitAcademicTask(ctx, invoke(body))
    submitAcademicTask(ctx, invoke(body, second))
    assert.equal(ctx.records.length, 2)
    await Promise.all(ctx.records.map((record) => record.hooks.done))
    count++; console.log('ok identical request ids in separate sessions remain isolated')
  }
  {
    const raw = '  A research question with whitespace?\n\n'
    const run = await startRun({ cwd: workspace.cwd, query: raw, brief: { topic: 'Whitespace', research_questions: ['Does the query stay exact?'] }, tier: 'light', plan: ['decompose'] })
    assert.equal(readQuery(workspace.cwd, run.run_id), raw)
    assert.equal(assertGospel(workspace.cwd, run.run_id, raw).ok, true)
    count++; console.log('ok the engine ledger preserves the verbatim question')
  }
  test('registration is an effect and command scope comes from the preset', () => {
    let definition, disposed = false
    const ctx = { effect: (fn) => { ctx.dispose = fn() }, commands: { register: (value) => { definition = value; return () => { disposed = true } } } }
    apply(ctx)
    assert.equal(definition.name, TASK_COMMAND)
    ctx.dispose()
    assert.equal(disposed, true)
    const yaml = readFileSync(new URL('../presets/academic-harness/agent.cordis.yml', import.meta.url), 'utf8')
    assert.match(yaml, /planMode: true[\s\S]*name: academic-harness\/academic-task/u)
  })
  test('session interaction state has stable snapshots and refresh-safe retry ids', () => {
    const values = new Map()
    const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
    const store = createTaskModeStore({ sessionId: 'one', storage })
    assert.equal(store.getSnapshot(), store.getSnapshot())
    assert.equal(store.getSnapshot().lastTask, null)
    let notifications = 0
    const stop = store.subscribe(() => notifications++)
    store.update({ effort: 'high' })
    assert.equal(notifications, 1)
    store.setRequest(request('persisted_1234567890', { options: { effort: 'high' } }))
    const restored = createTaskModeStore({ sessionId: 'one', storage })
    assert.equal(restored.getSnapshot().effort, 'high')
    assert.equal(restored.getRequest().request_id, 'persisted_1234567890')
    assert.equal(createTaskModeStore({ sessionId: 'two', storage }).getRequest(), null)
    restored.setRequest(null)
    assert.equal(createTaskModeStore({ sessionId: 'one', storage }).getRequest(), null)
    stop()
    store.update({ effort: 'low' })
    assert.equal(notifications, 1)
  })
  test('selector is one compact chip per enabled task, with an effort segment and menu, no native select', () => {
    const props = { selected: 'deep_research', effort: 'auto', available: true, t: (key) => key, onSelect() {}, onEffort() {} }
    const html = renderToStaticMarkup(createElement(TaskSelectorView, props))
    assert.match(html, /aria-pressed="true"/u)
    assert.match(html, /data-ah-task="deep_research"/u)
    assert.match(html, /data-ah-task="deep_review"/u)
    assert.match(html, /data-ah-task="find_papers"/u)
    assert.match(html, /data-ah-task="check_references"/u)
    assert.match(html, /data-ah-task="write_revise"/u)
    assert.match(html, /data-ah-task="analyze_data"/u)
    assert.match(html, /data-ah-task="generate_hypotheses"/u)
    assert.match(html, /font-size:11px/u, 'task chips stay small enough for several buttons')
    assert.match(html, /min-height:24px/u)
    assert.match(html, /--dsw-alias-button-primary-fill/u, 'the selected chip uses the theme primary fill')
    assert.match(html, /--dsw-alias-label-primary-foreground/u, 'the selected chip uses the contrasting foreground')
    assert.match(html, /✓/u, 'the selected chip carries a visible check')
    assert.ok(!html.includes('<select'), 'effort must not reserve a separate native-select slot')
    assert.match(html, /aria-haspopup="menu"/u)
    assert.match(html, /data-ah-effort-menu/u)
    assert.equal(html.match(/data-ah-effort-menu/gu).length, 1, 'only the selected chip offers effort')
    assert.match(renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: null, planActive: true })), /disabled/u)
    const planned = renderToStaticMarkup(createElement(TaskSelectorView, { ...props, planActive: true }))
    const researchChip = planned.split('data-ah-task="deep_review"')[0]
    assert.match(researchChip, /aria-pressed="true"/u)
    assert.ok(!researchChip.includes('disabled'), 'a selected task can still be cleared in Plan mode')
    assert.match(planned.slice(planned.indexOf('data-ah-task="deep_review"')), /disabled/u)
    assert.ok(!renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: null })).includes('data-ah-effort-menu'), 'effort is only offered once the task is selected')
    const review = renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: 'deep_review' }))
    assert.match(review, /depth\.current/u)
    assert.ok(!review.split('data-ah-task="deep_review"')[0].includes('data-ah-effort-menu'))
    const papers = renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: 'find_papers' }))
    assert.match(papers, /breadth\.current/u)
    assert.equal(papers.match(/data-ah-effort-menu/gu).length, 1)
    const references = renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: 'check_references' }))
    assert.match(references, /scope\.current/u)
    assert.equal(references.match(/data-ah-effort-menu/gu).length, 1)
    assert.ok(!renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: 'analyze_data' })).includes('data-ah-effort-menu'), 'Analyze Data has no effort scale')
    assert.match(renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: 'generate_hypotheses' })), /ideas\.current/u)
    assert.equal(taskRequestId({ getRandomValues: (bytes) => bytes.fill(4) }), '04'.repeat(16))
    const status = renderToStaticMarkup(createElement(TaskSelectorStatus, { useInput: (fn) => fn({ claim: { token: '/research ' } }), useTaskMode: (fn) => fn({ error: 'Choose effort' }), t: (key) => key }))
    assert.match(status, /role="alert"/u)
    assert.match(status, /Choose effort/u)
    assert.match(status, /align-self:center/u, 'chip guidance sits on the chat column')
    assert.match(status, /margin:6px auto/u)
    assert.match(status, /--dsh-composer-card-max-width/u, 'chip guidance uses the chat box width')
    assert.match(status, /--dsh-composer-side-clearance/u)
    assert.ok(!status.includes('align-self:flex-start'), 'chip guidance is not pinned to the left edge')
    assert.ok(!status.includes('36rem'), 'chip guidance is not a narrower left-aligned measure')
    const runNotice = renderToStaticMarkup(createElement(TaskRunNotice, {
      useTaskMode: (fn) => fn({ lastTask: { prompt: 'A question', effort: 'low', jobId: 'deep-research-abc', runId: null } }),
      dismiss() {},
      t: (key) => key === 'started' ? 'Deep Research started' : key === 'backgroundHint' ? 'Background tasks' : key === 'effort.low' ? 'Low' : key,
    }))
    assert.match(runNotice, /data-ah-task-run/u)
    assert.match(runNotice, /align-self:center/u, 'the start receipt sits on the chat column')
    assert.match(runNotice, /margin:6px auto/u)
    assert.match(runNotice, /--dsh-composer-card-max-width/u, 'the receipt uses the chat box width')
    assert.ok(!runNotice.includes('align-self:flex-start'), 'the receipt is not pinned to the left corner')
    assert.match(runNotice, /Deep Research started/u)
    assert.match(runNotice, /A question/u)
    assert.match(runNotice, /deep-research-abc/u)
    assert.match(runNotice, /Background tasks/u)
    assert.equal(renderToStaticMarkup(createElement(TaskRunNotice, {
      useTaskMode: (fn) => fn({ lastTask: { prompt: 'A question', effort: 'low' }, inTranscript: true }),
      dismiss() {},
      t: (key) => key,
    })), '', 'the dock copy leaves once the same receipt is in the transcript')
    const commandNode = {
      args: ` ${JSON.stringify({ task: 'deep_research', prompt: 'deep learning and dbt and breast cancer', options: { effort: 'low' } })}`,
      outcome: { kind: 'success', text: 'Deep Research — recorded task status: running.\nJob: deep-research-cff44088c22b46d9\nTask: ledger.json\nResearch run: dr-0009\nFollow progress and stop live work in Background jobs.' },
    }
    assert.deepEqual(taskReceiptFromCommand(commandNode), {
      task: 'deep_research', prompt: 'deep learning and dbt and breast cancer', effort: 'low', jobId: 'deep-research-cff44088c22b46d9', runId: 'dr-0009',
    })
    const transcript = renderToStaticMarkup(createElement(TaskCommandReceipt, {
      node: commandNode,
      t: (key) => key === 'started' ? 'Deep Research started' : key === 'backgroundHint' ? 'Follow live status in Background tasks' : key === 'effort.low' ? 'Low' : key,
    }))
    assert.match(transcript, /data-ah-task-transcript/u)
    assert.match(transcript, /align-self:center/u, 'the transcript receipt sits on the chat column')
    assert.match(transcript, /--dsh-composer-card-max-width/u)
    assert.match(transcript, /Deep Research started/u)
    assert.match(transcript, /deep learning and dbt and breast cancer/u)
    assert.match(transcript, /Low · dr-0009 · deep-research-cff44088c22b46d9/u)
    assert.match(transcript, /Follow live status in Background tasks/u)
    assert.ok(!transcript.includes('×'), 'a transcript receipt is history, not a dismissible toast')
    assert.ok(!html.includes('Multi-step research'), 'long guidance is not rendered in the compact toolbar')
    assert.ok(!html.includes('costNotice'), 'long guidance is not rendered in the compact toolbar')
    assert.deepEqual(TASK_EFFORTS, ['auto', 'low', 'medium', 'high'])
  })

  // Drive the real plugin's injected callbacks and claims, not a duplicate routing implementation.
  {
    const scoped = new Map(), sources = [], entries = [], sent = [], disposers = [], revealed = []
    let fail = true
    const ctx = {
      locale: { register: () => () => {}, bind: () => (key) => key },
      effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
      slots: { inject: (_name, fn) => fn(), register: (options) => { entries.push(options); return () => {} } },
      inputTriggers: { registerSource: (source) => { sources.push(source); return () => sources.splice(sources.indexOf(source), 1) } },
      sessions: {
        scope: (id) => scoped.get(id),
        binding: (id) => ({ session: { acceptPrompt() { revealed.push(id) } } }),
      },
      conversation: { input: { for: (actx) => actx.input } },
      remote: { commands: {
        list: async () => ({ ok: true, value: [{ name: TASK_COMMAND }] }),
        execute: async (id, line) => { sent.push({ id, line }); return { ok: true, value: { result: fail ? { kind: 'error', text: 'choose effort' } : { kind: 'success' } } } },
      } },
    }
    function scope(id) {
      const state = { phase: 'plain', draft: 'Research the evidence', draftRev: 1 }
      const actx = {
        input: { state: { getSnapshot: () => state }, focus() {} },
        effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
        bail(event, payload) {
          if (event === 'slash/input-begin-command') { state.claim = payload.claim; state.phase = 'claimed'; return true }
          if (event === 'slash/input-consume-token') {
            assert.equal(payload.guard.kind, 'span', 'bare-token guards cannot remove a command with arguments')
            assert.equal(payload.guard.span.end, 1, 'named command chip occupies one detect character')
            delete state.claim; state.phase = 'plain'; return true
          }
        },
      }
      scoped.set(id, actx)
      return state
    }
    const one = scope('one'), two = scope('two')
    applyTaskModes(ctx)
    const face = entries[0].inject('one')
    const other = entries[0].inject('two')
    await Promise.resolve()
    assert.equal(face.hooks.taskMode.getSnapshot().available, true)
    assert.equal(sources[0].matchSpace({ sessionId: 'one' }, '/other'), undefined)
    assert.equal(await sources[0].matchEnter({ sessionId: 'one' }, 'ordinary chat', null, {}), undefined)
    face.selectTask()
    assert.equal(one.claim.token, '/research ')
    assert.equal(one.draft, 'Research the evidence')
    assert.equal(two.claim, undefined)
    face.setEffort('high')
    const claim = one.claim
    assert.equal((await claim.submit('question', null, [{}])).kind, 'error')
    assert.equal(sent.length, 0)
    assert.equal((await claim.submit('question')).kind, 'error')
    assert.equal(face.hooks.taskMode.getSnapshot().error, 'choose effort', 'host clarifications remain visible even before the first chat turn')
    assert.deepEqual(revealed, [], 'a refusal stays on the hero and does not open an empty chat')
    assert.equal((await claim.submit('question')).kind, 'error')
    assert.equal(sent[0].line, sent[1].line, 'lost or failed acknowledgment retains request identity')
    assert.equal(face.hooks.taskMode.getSnapshot().effort, 'high')
    assert.equal(other.hooks.taskMode.getSnapshot().effort, 'auto')
    fail = false
    assert.equal((await claim.submit('question')).kind, 'success')
    assert.equal(face.hooks.taskMode.getSnapshot().effort, 'auto')
    assert.equal(face.hooks.taskMode.getRequest(), null)
    assert.equal(face.hooks.taskMode.getSnapshot().lastTask.prompt, 'question', 'the accepted run leaves an immediate receipt')
    assert.equal(face.hooks.taskMode.getSnapshot().lastTask.effort, 'high', 'the receipt preserves the effort actually used')
    assert.deepEqual(revealed, ['one'], 'acceptance opens the transcript without another user message')
    entries.find((entry) => entry.key === TASK_COMMAND).inject('one').markInTranscript()
    assert.equal(face.hooks.taskMode.getSnapshot().inTranscript, true)
    face.selectTask()
    assert.equal(one.claim, undefined)
    face.selectTask('deep_review')
    assert.equal(one.claim.token, `${REVIEW_TOKEN} `)
    assert.equal(one.claim.name, 'review')
    face.setEffort('high')
    face.selectTask()
    assert.equal(one.claim.token, '/research ', 'selecting the other task replaces the claim')
    assert.equal(face.hooks.taskMode.getSnapshot().effort, 'auto', 'switching tasks does not keep the previous effort')
    face.selectTask('deep_review')
    await assert.rejects(() => sources[0].matchEnter({ sessionId: 'one' }, '/review paper/main.tex', null, { attachments: 1 }), /attachments/u)
    assert.equal((await sources[0].matchEnter({ sessionId: 'one' }, '/review paper/main.tex', null, {})).claim.token, `${REVIEW_TOKEN} `)
    assert.equal((await sources[0].matchEnter({ sessionId: 'one' }, '/papers sparse attention', null, {})).claim.name, 'papers')
    assert.equal((await sources[0].matchEnter({ sessionId: 'one' }, '/papers sparse attention', null, {})).claim.token, `${PAPERS_TOKEN} `)
    await assert.rejects(() => sources[0].matchEnter({ sessionId: 'one' }, '/papers sparse attention', null, { images: 1 }), /attachments/u)
    assert.equal((await sources[0].matchEnter({ sessionId: 'one' }, '/references refs.bib', null, {})).claim.token, `${REFERENCES_TOKEN} `)
    assert.equal((await sources[0].matchEnter({ sessionId: 'one' }, '/references refs.bib', null, {})).claim.name, 'references')
    assert.equal((await sources[0].matchEnter({ sessionId: 'one' }, '/write old.tex', null, {})).claim.token, `${WRITE_TOKEN} `)
    assert.equal((await sources[0].matchEnter({ sessionId: 'one' }, '/analyze a question', null, {})).claim.token, `${ANALYZE_TOKEN} `)
    assert.equal((await sources[0].matchEnter({ sessionId: 'one' }, '/hypotheses a goal', null, {})).claim.token, `${HYPOTHESES_TOKEN} `)
    face.selectTask('deep_review')
    await assert.rejects(() => sources[0].matchEnter({ sessionId: 'one' }, '/research question', null, { attachments: 1 }), /attachments/u)
    for (const dispose of disposers.reverse()) dispose?.()
    assert.equal(sources.length, 0)
    count++; console.log('ok production composer wiring: selection, retry, effort, isolation, attachment refusal, disposal')
  }
  // A symlinked .dsh must never redirect a task reservation outside the workspace.
  {
    const target = makeWorkspace('ah-task-symlink-')
    const outside = makeWorkspace('ah-task-outside-')
    try {
      symlinkSync(outside.cwd, join(target.cwd, '.dsh'))
      const ctx = host()
      const foreign = { ...agent, session: { header: { cwd: target.cwd } } }
      assert.match(submitAcademicTask(ctx, invoke(request(), foreign)).text, /escapes the workspace/u)
      assert.equal(ctx.records.length, 0)
    } finally { target.cleanup(); outside.cleanup() }
    count++; console.log('ok task reservation paths reject escaping symlinks')
  }
  console.log(`\n${count} task-mode checks passed`)
} finally {
  workspace.cleanup()
}
