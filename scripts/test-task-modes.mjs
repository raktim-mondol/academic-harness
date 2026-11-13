import assert from 'node:assert/strict'
import { readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { makeWorkspace } from './helpers/test-workspace.mjs'
import { TASK_MODES, TASK_EFFORTS, TASK_COMMAND, validateTaskRequest, taskCommandLine } from '../task-modes.js'
import { apply, submitAcademicTask, executeTaskTool } from '../academic-task.js'
import { createTaskModeStore } from '../client/task-mode-store.js'
import { TaskRunNotice, TaskSelectorView, TaskSelectorStatus } from '../client/task-selector.js'
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
  test('seven catalogue entries, only Deep Research enabled in Phase 1', () => {
    assert.equal(TASK_MODES.length, 7)
    assert.deepEqual(TASK_MODES.filter((mode) => mode.enabled).map((mode) => mode.id), ['deep_research'])
    assert.deepEqual(TASK_EFFORTS, ['auto', 'low', 'medium', 'high'])
  })
  test('wire roundtrip preserves prompt whitespace and rejects unknown fields/tasks', () => {
    assert.deepEqual(JSON.parse(taskCommandLine(request()).slice(`/${TASK_COMMAND} `.length)), request())
    for (const bad of [null, [], request('../escape'), request(undefined, { version: 2 }), request(undefined, { task: 'deep_review' }), request(undefined, { prompt: ' ' }), request(undefined, { options: { effort: 'maximum' } }), request(undefined, { options: { confirm_effort: true } }), { ...request(), run: true }]) {
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
  test('selector is one compact chip with an effort segment and menu, no native select', () => {
    const props = { selected: true, effort: 'auto', available: true, t: (key) => key, onSelect() {}, onEffort() {} }
    const html = renderToStaticMarkup(createElement(TaskSelectorView, props))
    assert.match(html, /aria-pressed="true"/u)
    assert.match(html, /--dsw-alias-button-primary-fill/u, 'the selected chip uses the theme primary fill')
    assert.match(html, /--dsw-alias-label-primary-foreground/u, 'the selected chip uses the contrasting foreground')
    assert.match(html, /✓ Deep Research|✓/u, 'the selected chip carries a visible check')
    assert.ok(!html.includes('<select'), 'effort must not reserve a separate native-select slot')
    assert.match(html, /aria-haspopup="menu"/u)
    assert.match(html, /data-ah-effort-menu/u)
    assert.ok(!html.includes('deep_review'))
    assert.match(renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: false, planActive: true })), /disabled/u)
    assert.ok(!renderToStaticMarkup(createElement(TaskSelectorView, { ...props, planActive: true })).includes('disabled'), 'a selected task can still be cleared in Plan mode')
    assert.ok(!renderToStaticMarkup(createElement(TaskSelectorView, { ...props, selected: false })).includes('data-ah-effort-menu'), 'effort is only offered once the task is selected')
    assert.equal(taskRequestId({ getRandomValues: (bytes) => bytes.fill(4) }), '04'.repeat(16))
    const status = renderToStaticMarkup(createElement(TaskSelectorStatus, { useInput: (fn) => fn({ claim: { token: '/research ' } }), useTaskMode: (fn) => fn({ error: 'Choose effort' }), t: (key) => key }))
    assert.match(status, /role="alert"/u)
    assert.match(status, /Choose effort/u)
    const runNotice = renderToStaticMarkup(createElement(TaskRunNotice, {
      useTaskMode: (fn) => fn({ lastTask: { prompt: 'A question', effort: 'low', jobId: 'deep-research-abc', runId: null } }),
      dismiss() {},
      t: (key) => key === 'started' ? 'Deep Research started' : key === 'backgroundHint' ? 'Background tasks' : key === 'effort.low' ? 'Low' : key,
    }))
    assert.match(runNotice, /data-ah-task-run/u)
    assert.match(runNotice, /Deep Research started/u)
    assert.match(runNotice, /A question/u)
    assert.match(runNotice, /deep-research-abc/u)
    assert.match(runNotice, /Background tasks/u)
    assert.ok(!html.includes('Multi-step research'), 'long guidance is not rendered in the compact toolbar')
    assert.ok(!html.includes('costNotice'), 'long guidance is not rendered in the compact toolbar')
    assert.deepEqual(TASK_EFFORTS, ['auto', 'low', 'medium', 'high'])
  })

  // Drive the real plugin's injected callbacks and claims, not a duplicate routing implementation.
  {
    const scoped = new Map(), sources = [], entries = [], sent = [], disposers = []
    let fail = true
    const ctx = {
      locale: { register: () => () => {}, bind: () => (key) => key },
      effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
      slots: { inject: (_name, fn) => fn(), register: (options) => { entries.push(options); return () => {} } },
      inputTriggers: { registerSource: (source) => { sources.push(source); return () => sources.splice(sources.indexOf(source), 1) } },
      sessions: { scope: (id) => scoped.get(id) },
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
    face.selectTask()
    assert.equal(one.claim, undefined)
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
