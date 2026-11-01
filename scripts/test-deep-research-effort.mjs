import { EFFORT_LEVELS, EFFORT_PRESETS, inferEffort, resolveEffort } from '../deep-research-effort.js'
import { apply, runDeepResearchAction } from '../deep-research.js'
import { listRuns } from '../deep-research-store.js'
import { makeWorkspace } from './helpers/test-workspace.mjs'

const checks = []
const ok = (label, condition, detail) => {
  checks.push({ label, pass: Boolean(condition) })
  if (!condition) console.error(`FAIL ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail.slice(0, 220) : JSON.stringify(detail).slice(0, 220)}`}`)
}

// ------------------------------------------------------------------ the three levels
ok('there are exactly three levels a caller can name', EFFORT_LEVELS.join(',') === 'low,medium,high', EFFORT_LEVELS)
for (const level of EFFORT_LEVELS) {
  const preset = EFFORT_PRESETS[level]
  ok(`${level} names a pipeline`, ['light', 'full', 'dissertation'].includes(preset?.tier), preset)
  ok(`${level} caps its model calls`, Number.isFinite(preset?.max_llm_calls) && preset.max_llm_calls > 0, preset)
  ok(`${level} states what to expect`, typeof preset?.expectation === 'string' && preset.expectation.length > 20, preset?.expectation)
}
ok('cost rises with the level',
  EFFORT_PRESETS.low.max_llm_calls < EFFORT_PRESETS.medium.max_llm_calls
  && EFFORT_PRESETS.medium.max_llm_calls < EFFORT_PRESETS.high.max_llm_calls,
  [EFFORT_PRESETS.low.max_llm_calls, EFFORT_PRESETS.medium.max_llm_calls, EFFORT_PRESETS.high.max_llm_calls])
ok('only the cheap level skips full text', EFFORT_PRESETS.low.fetch_full_text === false
  && EFFORT_PRESETS.medium.fetch_full_text === true && EFFORT_PRESETS.high.fetch_full_text === true)
ok('only the cheap level skips the web lane', EFFORT_PRESETS.low.web_lane === false && EFFORT_PRESETS.medium.web_lane === true)

// ------------------------------------------------------------------ inference from prose
ok('a quick ask is low', inferEffort('Quickly, what does the SELECT trial report?').effort === 'low')
ok('"just tell me" is low', inferEffort('Just tell me roughly how big the effect was').effort === 'low')
ok('a bare one-line lookup is low', inferEffort('Who first reported semaglutide cardiovascular benefit?').effort === 'low')
ok('a comprehensive ask is high', inferEffort('Give me a comprehensive review of the whole field of GLP-1 cardiovascular evidence').effort === 'high')
ok('naming a systematic review is high', inferEffort('Run a systematic review of SGLT2 inhibitor heart failure trials').effort === 'high')
ok('real consequences are high', inferEffort('What do the trials support before I commit to this as a clinical protocol?').effort === 'high')
ok('several questions is medium', inferEffort('Does it reduce MACE? Who was excluded? What is the effect size in the elderly?').effort === 'medium')
ok('an unmarked long request is medium', inferEffort('Describe what the current evidence says about this intervention in this population').effort === 'medium')
{
  const ambiguous = inferEffort('Give me a quick answer but make it a comprehensive systematic review')
  ok('contradictory signals do not silently pick a side', ambiguous.effort === 'medium' && Boolean(ambiguous.ask_user), ambiguous)
  ok('and the question it returns is answerable in one line',
    typeof ambiguous.ask_user === 'string' && ambiguous.ask_user.includes('?'), ambiguous.ask_user)
}
ok('inference always returns a usable level',
  EFFORT_LEVELS.includes(inferEffort('').effort) && EFFORT_LEVELS.includes(inferEffort('x'.repeat(500)).effort))

// ------------------------------------------------------------------ precedence
{
  const stated = resolveEffort({ effort: 'high', query: 'quick question' })
  ok('a named level beats what the prose implied', stated.effort === 'high' && stated.tier === 'full' && stated.effort_source === 'stated', stated)
  ok('a plain request with a named level asks nothing', stated.ask_user === null && stated.conflict === false, stated)

  const contradictory = 'Quickly, but make it a comprehensive systematic review of the whole field'
  const namedAnyway = resolveEffort({ effort: 'medium', query: contradictory })
  ok('naming a level does not erase a contradiction', namedAnyway.conflict === true && Boolean(namedAnyway.ask_user), namedAnyway)
  ok('but it does stop the blocking question', namedAnyway.effort === 'medium' && namedAnyway.effort_source === 'stated', namedAnyway.effort_source)
  const unresolved = resolveEffort({ query: contradictory })
  ok('an unnamed contradiction still asks', unresolved.conflict === true && Boolean(unresolved.ask_user), unresolved)

  const inferred = resolveEffort({ query: 'Give me a comprehensive review of the entire field' })
  ok('inference drives the whole shape', inferred.effort === 'high' && inferred.tier === 'full' && inferred.gear === 'premier', inferred)
  ok('and says why it chose', Array.isArray(inferred.effort_basis) && inferred.effort_basis.length > 0, inferred.effort_basis)

  const light = resolveEffort({ query: 'anything', explicitTier: 'light', explicitGear: 'scout' })
  ok('naming a light pipeline does not switch on downloads', light.fetch_full_text === false && light.web_lane === false, light)
  ok('a named pipeline is not second-guessed', light.ask_user === null && light.effort_source === 'explicit-pipeline', light)

  const full = resolveEffort({ query: 'a short phrase', explicitTier: 'full' })
  ok('a full pipeline is never starved by a guessed low budget', full.budget.max_llm_calls === EFFORT_PRESETS.medium.max_llm_calls, full.budget)

  const capped = resolveEffort({ effort: 'high', query: 'x', overrides: { max_llm_calls: 12 } })
  ok('an explicit budget beats the level', capped.budget.max_llm_calls === 12, capped.budget)
  ok('and is recorded as an override', capped.explicit.max_llm_calls === 12, capped.explicit)
  const untouched = resolveEffort({ effort: 'low', query: 'x' })
  ok('a level with no overrides records none', Object.keys(untouched.explicit).length === 0, untouched.explicit)

  const bogus = resolveEffort({ effort: 'extreme', query: 'quick question' })
  ok('an unknown level falls back to reading the request', bogus.effort === 'low', bogus.effort)
}

// ------------------------------------------------------------------ the tool honours it
const workspace = makeWorkspace('ah-deep-research-effort-')
const cwd = workspace.cwd
let tool
apply({ tools: { register: (registered) => { tool = registered } }, llm: { async *stream() { yield { type: 'text-delta', text: '{}' } } } })
const exec = { agent: { session: { header: { cwd } }, options: { provider: 'deepseek', model: 'test-model' } }, callId: 'c1', rootCallId: 'c1' }

try {
  ok('effort is a first-class parameter', tool.parameters.properties.effort?.enum?.join(',') === 'low,medium,high', tool.parameters.properties.effort)
  ok('the scale parameters say they are advanced', /Advanced override/iu.test(tool.parameters.properties.tier?.description ?? ''), tool.parameters.properties.tier?.description)

  let refused = null
  try {
    await runDeepResearchAction({ action: 'start', query: 'anything', effort: 'enormous' }, exec, { llm: {} }, {})
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  ok('an invented level is refused', /effort must be one of/.test(refused ?? ''), refused)

  // The important guarantee: an ambiguous, expensive-looking request asks instead
  // of spending, and asks before anything exists on disk.
  const before = listRuns(cwd).length
  const asked = await runDeepResearchAction(
    { action: 'start', query: 'Quickly, but make it a comprehensive systematic review of the whole field?', run: true },
    exec, { llm: {} }, { search: async () => [] },
  )
  ok('an ambiguous request is answered with a question, not a run', asked.status === 'needs_input', asked)
  ok('it says what it would do', asked.suggested_effort === 'medium' && Array.isArray(asked.effort_basis), asked)
  ok('it offers the levels in plain terms', Object.keys(asked.options ?? {}).length === 3, Object.keys(asked.options ?? {}))
  ok('nothing was created to ask the question', listRuns(cwd).length === before, { now: listRuns(cwd).length, before })
  ok('no model call was made to ask', !('run_id' in asked), Object.keys(asked))

  const driven = await runDeepResearchAction(
    { action: 'start', query: 'Quickly, but make it a comprehensive systematic review of the whole field?', effort: 'medium' },
    exec,
    { llm: { async *stream() { yield { type: 'text-delta', text: JSON.stringify({ topic: 't', research_questions: ['answered?'] }) } } } },
    { search: async () => [] },
  )
  ok('a run started over a contradiction says so', driven.status === 'prepared' && driven.effort_conflict === true, driven)
  ok('and hands the agent the question to relay', typeof driven.ask_user === 'string' && driven.ask_user.includes('?'), driven.ask_user)
  ok('the contradiction is recorded in the run', listRuns(cwd).find((run) => run.run_id === driven.run_id) || driven.run_id, driven.run_id)

  const confirmed = await runDeepResearchAction(
    { action: 'start', query: 'Quickly, but make it a comprehensive systematic review of the whole field?', effort: 'low', run: false },
    exec,
    { llm: { async *stream() { yield { type: 'text-delta', text: JSON.stringify({ topic: 't', research_questions: ['answered?'] }) } } } },
    { search: async () => [] },
  )
  ok('naming a level answers the question', confirmed.status === 'prepared' && confirmed.effort === 'low', confirmed)
  ok('the prepared run reports what it will do', typeof confirmed.expectation === 'string' && confirmed.expectation.length > 10, confirmed.expectation)
  const manifest = listRuns(cwd).find((run) => run.run_id === confirmed.run_id)
  ok('the level is frozen into the run', manifest?.tier === 'light', manifest)
} catch (error) {
  console.error(`THREW ${error instanceof Error ? error.stack : error}`)
  checks.push({ label: 'uncaught error', pass: false })
} finally {
  workspace.cleanup()
}

const failed = checks.filter((check) => !check.pass)
console.log(`${checks.length - failed.length}/${checks.length} effort checks passed`)
if (failed.length) {
  console.error(failed.map((check) => ` - ${check.label}`).join('\n'))
  process.exit(1)
}
