#!/usr/bin/env node
/**
 * The writing gate across one host turn (review B1/B2/B3, decisions D19-D22),
 * driven through the REAL listeners in academic-harness-hooks.js and
 * rsi-hooks.js with a scripted engine (scripts/helpers/fake-ah-engine.mjs).
 *
 * B1: the plugin's own steer messages come back in the next step's inbox. They
 *     must not look like a new user prompt and wipe the gate's state.
 * B2: a handoff must survive the closing "none" event in the learning loop.
 * B3: a delegated sub-agent task prompt is not the user's voice.
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeAgent, fakeApproval, fakeHost } from './helpers/fake-host.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(homedir(), '.cache', 'ah-gate-test-'))
process.env.AH_RSI_STORE = join(scratch, 'rsi-store')
process.env.AH_RSI = 'auto'
process.env.ACADEMIC_HARNESS_CLI = `${process.execPath} ${join(HERE, 'helpers', 'fake-ah-engine.mjs')}`
process.env.FAKE_AH_LOG = join(scratch, 'engine.log.jsonl')
process.env.FAKE_AH_SCRIPT = join(scratch, 'script.json')
process.env.FAKE_AH_STATE = join(scratch, 'state.json')

const hooks = await import('../academic-harness-hooks.js')
const { onGate, emitGate } = await import('../rsi-bus.js')
const rsi = await import('../rsi-hooks.js')
const { readJsonl, currentLessons } = await import('../rsi-store.js')

const CONTINUE = { decision: 'block', reason: 'AH gate (attempt 1/3): your edits introduced blocking findings.' }
const HANDOFF = { systemMessage: 'AH gate: stopped after 3 attempts with 2 blocking finding(s)\nThe author decides what to do next.' }
const CARD = { hookSpecificOutput: { additionalContext: 'Paper state: 2 open findings.' } }

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function resetEngine(script) {
  writeFileSync(process.env.FAKE_AH_SCRIPT, JSON.stringify(script))
  for (const file of [process.env.FAKE_AH_LOG, process.env.FAKE_AH_STATE]) rmSync(file, { force: true })
}

function engineCalls(event) {
  if (!existsSync(process.env.FAKE_AH_LOG)) return []
  return readFileSync(process.env.FAKE_AH_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !event || c.event === event)
}

/** A session in an Academic Harness project, plus helpers that drive the listeners like the host would. */
function session(id, { approval } = {}) {
  const cwd = mkdtempSync(join(scratch, 'project-'))
  writeFileSync(join(cwd, 'ah.yaml'), 'profile: test\n')
  const host = fakeHost({ services: approval ? { approval } : {} })
  hooks.apply(host.ctx)
  const agent = fakeAgent({ cwd, id })
  const gate = []
  const off = onGate((event) => { if (event.sessionId === id) gate.push(event.kind) })
  const next = async () => ({ kind: 'enter', messages: [] })
  return {
    agent, gate, host, cwd,
    /** The host claims the inbox and runs a step. `messages` defaults to whatever the plugin steered. */
    async step(turn, messages) {
      const inbox = messages ?? agent.steered.splice(0)
      return host.run('agent/pre-step', { agent, messages: inbox, turn, step: 1, signal: undefined }, next)
    },
    async stop(turn = 1) {
      await host.run('agent/turn-stopping', { agent, turn, signal: undefined })
    },
    dispose: () => { off() },
  }
}

await check('B1: a gate steer coming back in the next inbox does not re-run the userprompt hook', async () => {
  resetEngine({ userprompt: [CARD], stop: [CONTINUE, CONTINUE, CONTINUE, HANDOFF, null] })
  const s = session('b1-userprompt')
  await s.step(1, [userMessage('fix the references')])
  assert.equal(engineCalls('userprompt').length, 1)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await s.stop()
    assert.equal(s.agent.steered.length, 1, `stop ${attempt + 1} should steer once`)
    await s.step(1) // the steer message comes back as the inbox
  }
  assert.equal(engineCalls('userprompt').length, 1, 'userprompt must run once for the whole host turn')
  s.dispose()
})

await check('B1: after a handoff, the same turn does not hand off again or report "none"', async () => {
  resetEngine({ userprompt: [CARD], stop: [CONTINUE, CONTINUE, CONTINUE, HANDOFF, HANDOFF, null] })
  const s = session('b1-handoff')
  await s.step(1, [userMessage('fix the references')])
  for (let i = 0; i < 4; i += 1) {
    await s.stop()
    await s.step(1)
  }
  assert.deepEqual(s.gate, ['continue', 'continue', 'continue', 'handoff'])
  // the engine keeps reporting the handoff; the model has already been told once
  await s.stop()
  assert.equal(s.agent.steered.length, 0, 'no second handoff steer')
  await s.step(1)
  await s.stop() // engine now silent
  assert.deepEqual(s.gate, ['continue', 'continue', 'continue', 'handoff'], 'no closing "none" after a handoff')
  s.dispose()
})

await check('B1: a new host turn does reset, and the gate can hand off again', async () => {
  resetEngine({ userprompt: [CARD], stop: [HANDOFF, HANDOFF] })
  const s = session('b1-newturn')
  await s.step(1, [userMessage('first request')])
  await s.stop(1)
  assert.equal(s.agent.steered.length, 1)
  s.agent.steered.splice(0)
  await s.step(2, [userMessage('second request')])
  assert.equal(engineCalls('userprompt').length, 2, 'the second user turn re-baselines')
  await s.stop(2)
  assert.equal(s.agent.steered.length, 1, 'a handoff is allowed again in the new turn')
  assert.deepEqual(s.gate, ['handoff', 'handoff'])
  s.dispose()
})

await check('B1: with no turn number, only a user-sourced message counts as a new prompt', async () => {
  resetEngine({ userprompt: [CARD], stop: [CONTINUE, CONTINUE] })
  const s = session('b1-noturn')
  await s.step(undefined, [userMessage('first request')])
  await s.stop()
  await s.step(undefined) // our own steer comes back
  assert.equal(engineCalls('userprompt').length, 1)
  await s.step(undefined, [userMessage('a new instruction')])
  assert.equal(engineCalls('userprompt').length, 2)
  s.dispose()
})

await check('B1: the plugin marks its steers so they can be told apart from the user', async () => {
  resetEngine({ userprompt: [CARD], stop: [CONTINUE] })
  const s = session('b1-source')
  await s.step(1, [userMessage('go')])
  await s.stop()
  assert.match(s.agent.steered[0].source.kind, /^plugin:/)
  s.dispose()
})

await check('B1: per-session gate state is released when the agent is disposed', async () => {
  resetEngine({ userprompt: [CARD], stop: [HANDOFF] })
  const s = session('b1-dispose')
  await s.step(1, [userMessage('go')])
  await s.stop()
  assert.equal(s.agent.steered.length, 1)
  s.agent.steered.splice(0)
  await s.host.run('agent/disposed', { agent: s.agent })
  // a fresh session with the same id starts clean: handoff is allowed again
  resetEngine({ userprompt: [CARD], stop: [HANDOFF] })
  await s.step(1, [userMessage('go again')])
  await s.stop()
  assert.equal(s.agent.steered.length, 1)
  s.dispose()
})

// ── B2: the learning loop keeps a handoff ───────────────────────────────────────
/** A learning-loop session that has done some work, so its turn counts as substantive. */
const rsiHost = fakeHost()
rsi.apply(rsiHost.ctx) // once, like the real host: each apply adds a listener to the shared gate bus
async function rsiSession(id) {
  const host = rsiHost
  const agent = fakeAgent({ cwd: scratch, id })
  const next = async () => ({ kind: 'enter', messages: [] })
  await host.run('agent/pre-step', { agent, messages: [userMessage('fix the references in section 2')], turn: 1, step: 1 }, next)
  await host.run('tools/post-execute', { name: 'ah_check', arguments: {}, agent }, { isError: false, content: [{ type: 'text', text: '{}' }] }, async () => ({}))
  const emit = (kind) => emitGate({ sessionId: id, cwd: scratch, kind, at: Date.now() + 1 })
  const finish = async () => {
    await host.run('agent/disposed', { agent })
    return readJsonl(process.env.AH_RSI_STORE, 'episodes.jsonl').filter((e) => e.session_id === id).at(-1)
  }
  return { emit, finish }
}

await check('B2: continue then handoff then the closing "none" still ends as a handoff', async () => {
  const s = await rsiSession('b2-handoff')
  s.emit('continue')
  s.emit('handoff')
  s.emit('none')
  const episode = await s.finish()
  assert.equal(episode.gate?.kind, 'handoff', 'the closing none must not erase the handoff')
  assert.equal(episode.success, false)
  assert.ok(episode.quality <= 0.8, `quality ${episode.quality} should carry the handoff penalty`)
  assert.ok(episode.signals.some((x) => x.kind === 'handoff'))
  assert.deepEqual(episode.gate_history, ['continue', 'handoff', 'none'])
})

await check('B2: a gate that asked to continue and then settled is a resolved turn, with the history kept', async () => {
  const s = await rsiSession('b2-resolved')
  s.emit('continue')
  s.emit('none')
  const episode = await s.finish()
  assert.equal(episode.gate, null)
  assert.deepEqual(episode.gate_history, ['continue', 'none'])
})

await check('B2: a turn the gate never touched has an empty history', async () => {
  const s = await rsiSession('b2-clean')
  const episode = await s.finish()
  assert.equal(episode.gate, null)
  assert.deepEqual(episode.gate_history, [])
})

// ── B3: a delegated task prompt is not the user's voice ────────────────────────
async function promptAs(agent, text) {
  const host = rsiHost
  await host.run('agent/pre-step', { agent, messages: [userMessage(text)], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  await host.run('agent/disposed', { agent })
  return readJsonl(process.env.AH_RSI_STORE, 'episodes.jsonl').filter((e) => e.session_id === agent.session.header.id).at(-1)
}
const lessonTexts = () => currentLessons(process.env.AH_RSI_STORE).map((l) => l.text)

await check('B3: a standing preference in a sub-agent task prompt is not learned', async () => {
  const main = fakeAgent({ cwd: scratch, id: 'b3-main' })
  const sub = fakeAgent({ cwd: scratch, id: 'b3-sub', depth: 1, parent: main, origin: 'subagent' })
  await promptAs(sub, 'Always use hedged wording for causal claims in every manuscript.')
  assert.ok(!lessonTexts().some((t) => /hedged wording/i.test(t)), 'delegated prompt became a lesson')
})

await check('B3: the same sentence typed by the user in the main session is learned', async () => {
  const main = fakeAgent({ cwd: scratch, id: 'b3-main2' })
  await promptAs(main, 'Always use hedged wording for causal claims in every manuscript.')
  assert.ok(lessonTexts().some((t) => /hedged wording/i.test(t)), 'the control: a real user preference should still be learned')
})

await check('B3: sub-agent detection works from depth, parent, or the session origin alone', async () => {
  const main = fakeAgent({ cwd: scratch, id: 'b3-main3' })
  const variants = [
    fakeAgent({ cwd: scratch, id: 'b3-depth', depth: 2 }),
    fakeAgent({ cwd: scratch, id: 'b3-parent', parent: main }),
    fakeAgent({ cwd: scratch, id: 'b3-origin', origin: 'subagent' }),
  ]
  const phrases = ['Always cite the dataset DOI in every figure caption.', 'Never use the passive voice in the methods section.', 'Always report exact p-values in every results table.']
  for (const [index, agent] of variants.entries()) await promptAs(agent, phrases[index])
  const texts = lessonTexts().join('\n')
  for (const needle of [/dataset DOI/i, /passive voice/i, /exact p-values/i]) assert.ok(!needle.test(texts), `${needle} leaked from a sub-agent`)
})

await check('B3: a "forget" or a correction phrase in a sub-agent prompt changes nothing', async () => {
  const main = fakeAgent({ cwd: scratch, id: 'b3-main4' })
  await promptAs(main, 'Always prefer short section titles in every paper.')
  const before = lessonTexts().filter((t) => /short section titles/i.test(t)).length
  assert.ok(before >= 1)
  const sub = fakeAgent({ cwd: scratch, id: 'b3-sub4', depth: 1, parent: main, origin: 'subagent' })
  const episode = await promptAs(sub, "Forget the preference about short section titles. That's wrong, try again.")
  assert.equal(lessonTexts().filter((t) => /short section titles/i.test(t)).length, before, 'a sub-agent prompt retired a lesson')
  assert.equal(episode?.corrections ?? 0, 0, 'a sub-agent prompt counted as a user correction')
})

// ── D23: the evidence check asks first, once per session ───────────────────────
const PENDING = { t3Pending: { units: 3, files: ['src/sections/01_introduction/index.tex'], backend: 'http' } }
const ADVISORY = { systemMessage: 'AH evidence check (advisory, a model read the cited sources): 1 clause(s) in the text this session changed are not confirmed by their cited sources:\n- clause\nRead them against the sources before you rely on them.' }
const modes = () => engineCalls('stop').map((c) => c.mode)

async function t3Session(id, outcomes, script, env = {}) {
  resetEngine({ userprompt: [CARD], ...script })
  const approval = outcomes === null ? null : fakeApproval(outcomes)
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  const s = session(id, { approval: approval ?? undefined })
  await s.step(1, [userMessage('add the related-work paragraph')])
  await s.stop()
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  s.dispose()
  return { s, approval }
}

await check('D23: the plugin asks, then runs the check when allowed, and steers the advisory', async () => {
  const { s, approval } = await t3Session('t3-allow', ['allowed-once'], { 'stop:defer': [PENDING], 'stop:run': [ADVISORY] })
  assert.deepEqual(modes(), ['defer', 'run'])
  assert.equal(approval.requests.length, 1)
  const request = approval.requests[0]
  assert.equal(request.toolName, 'ah_evidence_check')
  assert.match(request.reason, /3 paragraph/)
  assert.match(request.reason, /http/)
  assert.match(request.reason, /once per session/)
  assert.equal(request.agent, s.agent)
  assert.equal(s.agent.steered.length, 1)
  assert.match(s.agent.steered[0].content[0].text, /evidence check/)
  assert.match(s.agent.steered[0].content[0].text, /advisory/)
})

await check('D23: a refusal skips the check and steers nothing', async () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const { s } = await t3Session(`t3-${outcome}`, [outcome], { 'stop:defer': [PENDING], 'stop:skip': [null] })
    assert.deepEqual(modes(), ['defer', 'skip'], outcome)
    assert.equal(s.agent.steered.length, 0, outcome)
  }
})

await check('D23: with no approval service the check is skipped, not run silently', async () => {
  const { s } = await t3Session('t3-noservice', null, { 'stop:defer': [PENDING], 'stop:skip': [null] })
  assert.deepEqual(modes(), ['defer', 'skip'])
  assert.equal(s.agent.steered.length, 0)
})

await check('D23: the question is asked once per session, even if the engine reports pending again', async () => {
  resetEngine({ userprompt: [CARD], 'stop:defer': [PENDING, PENDING], 'stop:run': [null], 'stop:skip': [null] })
  const approval = fakeApproval(['allowed-once'])
  const s = session('t3-once', { approval })
  await s.step(1, [userMessage('go')])
  await s.stop()
  await s.stop()
  assert.equal(approval.requests.length, 1)
  assert.deepEqual(modes(), ['defer', 'run', 'defer', 'skip'])
  s.dispose()
})

await check('D23: AH_T3_MODE=run skips the question for unattended setups; =skip turns the check off', async () => {
  const run = await t3Session('t3-env-run', ['rejected'], { 'stop:run': [ADVISORY] }, { AH_T3_MODE: 'run' })
  assert.deepEqual(modes(), ['run'])
  assert.equal(run.approval.requests.length, 0)
  assert.equal(run.s.agent.steered.length, 1)
  const skip = await t3Session('t3-env-skip', ['allowed-once'], { 'stop:skip': [null] }, { AH_T3_MODE: 'skip' })
  assert.deepEqual(modes(), ['skip'])
  assert.equal(skip.approval.requests.length, 0)
})

await check('D23: a blocking gate decision is never held up by the question', async () => {
  const { s, approval } = await t3Session('t3-block', ['allowed-once'], { 'stop:defer': [CONTINUE] })
  assert.deepEqual(modes(), ['defer'])
  assert.equal(approval.requests.length, 0)
  assert.equal(s.agent.steered.length, 1)
  assert.equal(s.gate.at(-1), 'continue')
})

await check('D23: only the stop hook is told the mode', async () => {
  await t3Session('t3-scope', ['allowed-once'], { 'stop:defer': [PENDING], 'stop:run': [null] })
  assert.ok(engineCalls('userprompt').every((c) => c.mode === null), 'userprompt must not see AH_T3_MODE')
})

rmSync(scratch, { recursive: true, force: true })
if (process.exitCode) console.error('gate lifecycle: FAILED')
else console.log(`gate lifecycle: ${passed} checks passed`)
