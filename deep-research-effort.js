/**
 * One knob instead of seven.
 *
 * `deep_research` has scale parameters that a researcher has no reason to learn:
 * tier, gear, max_llm_calls, max_sources, timeout_minutes, fetch_full_text, and
 * the web lane. This module collapses them into `low | medium | high`, infers the
 * level from the request when the caller did not state one, and says plainly when
 * it is guessing at something expensive enough to be worth asking about.
 *
 * Explicit arguments always win over the level, and the level wins over nothing:
 * a caller who passes `max_llm_calls` gets that number, not the preset.
 */

export const EFFORT_LEVELS = ['low', 'medium', 'high']

export const EFFORT_PRESETS = {
  low: {
    label: 'low',
    tier: 'light',
    gear: 'scout',
    fetch_full_text: false,
    web_lane: false,
    max_llm_calls: 8,
    max_sources: 250,
    timeout_minutes: 20,
    expectation: 'a bounded answer in a few minutes, from titles, abstracts, and metadata',
  },
  medium: {
    label: 'medium',
    tier: 'full',
    gear: 'standard',
    fetch_full_text: true,
    web_lane: true,
    max_llm_calls: 45,
    max_sources: null,
    timeout_minutes: 120,
    expectation: 'a cited report with loci, critics, and a cite check, reading full text where it legally can',
  },
  high: {
    label: 'high',
    tier: 'full',
    gear: 'premier',
    fetch_full_text: true,
    web_lane: true,
    max_llm_calls: 140,
    max_sources: null,
    timeout_minutes: 300,
    expectation: 'a thorough multi-perspective investigation; the widest sweep and the deepest critique',
  },
}

/** Words that mean "do not spend much on this." */
const LOW_SIGNALS = [
  [/\b(quick|quickly|brief|briefly|fast|rapid|rough(ly)?|approxim\w*|snap)\b/iu, 'said it should be quick'],
  [/\bjust (tell|know|check|want|need|ask)\b/iu, 'framed as a simple ask'],
  [/\b(one|single)[- ](line|paragraph|sentence|fact|number)\b/iu, 'asked for a one-line answer'],
  [/\b(what year|who (invented|discovered|proposed|wrote)|how many|define|what is the (definition|term))\b/iu, 'a single lookup question'],
]

/** Words that mean "this is the real investigation." */
const HIGH_SIGNALS = [
  [/\b(comprehensive|exhaustive|definitive|thorough|in[- ]depth|deep dive|full survey|complete survey)\b/iu, 'asked for depth'],
  [/\b(systematic review|meta[- ]analysis|state[- ]of[- ]the[- ]art|scoping review|literature review)\b/iu, 'named a review-grade task'],
  [/\b(dissertation|chapter|thesis|entire field|whole field|everything known)\b/iu, 'field-wide scope'],
  [/\b(before i (buy|invest|commit|decide|submit)|decision[- ]grade|for a grant|for submission|regulatory|clinical protocol)\b/iu, 'the answer carries real consequences'],
]

/** Worth a number rather than a guess: three or more distinct questions. */
const MANY_QUESTIONS = 3

function countSignals(query, table) {
  const hits = []
  for (const [pattern, why] of table) if (pattern.test(query)) hits.push(why)
  return hits
}

/**
 * Pick a level from the request itself.
 *
 * Returns the level plus `ask_user` when the choice is genuinely uncertain or
 * expensive: a high-cost run the user never asked for, or signals pointing in
 * opposite directions. Everything else proceeds and says why, because asking
 * about a plainly-worded question is its own kind of failure.
 */
export function inferEffort(query) {
  const text = String(query ?? '')
  const low = countSignals(text, LOW_SIGNALS)
  const high = countSignals(text, HIGH_SIGNALS)
  const questions = (text.match(/\?/gu) ?? []).length
  const basis = []

  if (low.length && high.length) {
    return {
      effort: 'medium',
      basis: [`conflicting signals (${low[0]}; ${high[0]})`],
      conflict: true,
      ask_user: 'I can answer this quickly from abstracts, or run the full investigation with full-text reading and adversarial critique — the second takes much longer. Which do you want?',
    }
  }
  if (high.length) {
    return { effort: 'high', basis: high, conflict: false, ask_user: null }
  }
  if (low.length) {
    return { effort: 'low', basis: low, conflict: false, ask_user: null }
  }
  if (questions >= MANY_QUESTIONS) {
    return { effort: 'medium', basis: [`${questions} distinct questions`], conflict: false, ask_user: null }
  }
  // Short is not the same as simple: "describe what the evidence says about X" is
  // short and genuinely wants reading done. Only a short *question* is a lookup.
  if (text.length < 90 && questions === 1 && /\?\s*$/u.test(text.trim())) {
    return { effort: 'low', basis: ['a single short question'], conflict: false, ask_user: null }
  }
  basis.push('no scale words in the request; defaulting to the balanced level')
  return { effort: 'medium', basis, conflict: false, ask_user: null }
}

/**
 * Resolve what a run will actually do.
 *
 * Precedence is explicit argument > effort level > nothing. `overrides` carries
 * whatever the caller passed, so a stated budget is never silently replaced.
 */
export function resolveEffort({ effort, query, overrides = {}, explicitTier = null, explicitGear = null } = {}) {
  const stated = effort && !EFFORT_LEVELS.includes(effort) ? null : effort
  // Inference runs even when a level was named: its reading of the request is
  // still the thing the caller should know about if it contradicts them.
  const inferred = inferEffort(query)
  const drivingExplicit = Boolean(explicitTier || explicitGear)
  // Three ways to arrive. A named level sets everything. A caller who named the
  // pipeline but no level is driving, so the balanced budget applies rather than
  // a guessed one — a full run starved at eight calls is a broken run. With
  // neither, the inferred level decides.
  const source = stated ? 'stated' : drivingExplicit ? 'explicit-pipeline' : 'inferred'
  const level = stated ?? inferred.effort
  // A named pipeline carries its own cost posture: `tier=light` must not switch on
  // full-text downloads the caller never asked for, and `tier=full` must not be
  // starved by a level the caller never chose.
  const preset = source === 'explicit-pipeline'
    ? (EFFORT_PRESETS[{ light: 'low', full: 'medium', dissertation: 'high' }[explicitTier] ?? 'medium'])
    : (EFFORT_PRESETS[level] ?? EFFORT_PRESETS.medium)
  const chosen = stated
    ? { basis: [`caller chose ${level}`], ask_user: null }
    : drivingExplicit
      ? { basis: [`caller named the pipeline directly (${[explicitTier, explicitGear].filter(Boolean).join(' + ')})`], ask_user: null }
      : inferred
  const pick = (key, arg) => (arg === undefined || arg === null || arg === '' ? preset[key] : arg)

  return {
    effort: level,
    effort_source: source,
    // A contradictory request stays visible even when the caller picked a level:
    // naming "medium" does not resolve "quickly, but make it comprehensive", it
    // just means someone is driving. The tool blocks only an unresolved guess.
    conflict: Boolean(inferred && inferred.conflict),
    ask_user: inferred ? inferred.ask_user : null,
    // `explicit` records what the caller overrode, so a run's real shape is
    // readable from the manifest without diffing it against a preset.
    explicit: Object.fromEntries(Object.entries({
      max_llm_calls: overrides.max_llm_calls,
      max_sources: overrides.max_sources,
      timeout_minutes: overrides.timeout_minutes,
      fetch_full_text: overrides.fetch_full_text,
      web_lane: overrides.web_lane,
    }).filter(([, value]) => value !== undefined && value !== null)),
    effort_basis: chosen.basis,
    expectation: preset.expectation,
    tier: explicitTier ?? preset.tier,
    gear: explicitGear ?? preset.gear,
    budget: {
      max_llm_calls: pick('max_llm_calls', overrides.max_llm_calls),
      max_sources: pick('max_sources', overrides.max_sources),
      timeout_minutes: pick('timeout_minutes', overrides.timeout_minutes),
    },
    fetch_full_text: pick('fetch_full_text', overrides.fetch_full_text),
    web_lane: pick('web_lane', overrides.web_lane),
  }
}
