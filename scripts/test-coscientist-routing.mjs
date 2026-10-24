/**
 * Routing regression test: can the plugin tell that a user's problem is a
 * hypothesis ask, and send it to the right place?
 *
 * Routing itself is a language-model decision made over the whole skill
 * description plus the triage table in `skills/co-scientist-tournament/SKILL.md`
 * and the `## Research discipline` prose in `prompt.js`. What this script can
 * check is everything that decision depends on, so a future edit that quietly
 * removes a trigger, a destination, or the disambiguation rule fails here:
 *
 *   1. each skill's description still names the phrasings it claims to trigger on,
 *      and names the *other* skills where the non-matching asks belong;
 *   2. every destination the triage table routes to is a real shipped skill;
 *   3. `prompt.js` carries the same split, including problem-shaped asks;
 *   4. for the asks whose vocabulary really is in one description and not the
 *      other, the overlap measure picks the right one — and the asks it cannot
 *      separate are exactly the ones the skill says to ask about first.
 *
 * (4) deliberately does not assert a universal score threshold: a bag-of-words
 * overlap between a one-line ask and a paragraph of prose scores 0.14–0.29 for
 * pure function-word noise, so a single cut-off would enshrine noise as a rule.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenOverlap } from '../coscientist-models.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

/** The invitation half of a skill's frontmatter description, without its "Do not use" clauses. */
function descriptionOf(skillDir) {
  const frontmatter = read(join('skills', skillDir, 'SKILL.md')).split('\n---\n')[0]
  const lines = frontmatter.split('\n')
  const start = lines.findIndex((line) => line.startsWith('description:'))
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    if (/^(license|metadata|version):/.test(line)) continue
    body.push(line.trim())
  }
  return body.join(' ').split(/Do not use/i)[0]
}

const negativeClauseOf = (skillDir) => {
  const frontmatter = read(join('skills', skillDir, 'SKILL.md')).split('\n---\n')[0]
  return frontmatter.slice(frontmatter.search(/Do not use/i))
}

const oneShot = descriptionOf('generating-scientific-hypotheses')
const tournament = descriptionOf('co-scientist-tournament')
const prompt = read('prompt.js')

try {
  // ─── 1. triggers each skill claims are present in its description ──────────
  const ONE_SHOT_TRIGGERS = [
    'propose or brainstorm hypotheses', 'explain a mechanism', 'what to test',
    'why does', 'what could explain', 'expected', 'test next', 'falsify',
    'novel target',
  ]
  for (const trigger of ONE_SHOT_TRIGGERS) {
    assert.ok(oneShot.toLowerCase().includes(trigger.toLowerCase()),
      `generating-scientific-hypotheses must trigger on "${trigger}"`)
  }

  const TOURNAMENT_TRIGGERS = [
    'ranked', 'shortlist', 'leaderboard', 'head-to-head', 'evolve', 'resume',
    'tournament', 'Glicko', 'Co-Scientist', 'strongest',
  ]
  for (const trigger of TOURNAMENT_TRIGGERS) {
    assert.ok(tournament.toLowerCase().includes(trigger.toLowerCase()),
      `co-scientist-tournament must trigger on "${trigger}"`)
  }
  // The distinguishing words, not just shared ones: ranking and persistence are
  // what separates a tournament ask from a one-pass ask.
  for (const distinguishing of ['kept', 'resume', 'leaderboard', 'head-to-head']) {
    assert.ok(!oneShot.toLowerCase().includes(distinguishing),
      `the one-pass skill must not claim "${distinguishing}"`)
  }

  // ─── 2. every routing destination exists ───────────────────────────────────
  const skillDirs = new Set(readdirSync(join(root, 'skills')))
  const triage = read(join('skills', 'co-scientist-tournament', 'SKILL.md'))
  const destinations = [...triage.matchAll(/`([a-z][a-z0-9-]+)`/g)].map(([, name]) => name)
  const ROUTING_DESTINATIONS = [
    'generating-scientific-hypotheses', 'co-scientist-tournament',
    'framing-research-questions', 'designing-the-analysis', 'literature-review',
  ]
  for (const name of ROUTING_DESTINATIONS) {
    assert.ok(skillDirs.has(name), `the triage table routes to "${name}", which is not a shipped skill`)
    assert.ok(destinations.includes(name), `the triage table must mention "${name}"`)
  }

  // ─── 3. prompt.js carries the same split, problem-shaped asks included ─────
  for (const phrase of [
    'generate, critique, rank, or plan tests for scientific hypotheses',
    'why does this happen', 'what could account', 'expected A and got B',
    'what should I test next', 'how would I falsify', 'novel target or mechanism',
    'co-scientist-tournament', 'ranked and kept',
  ]) {
    assert.ok(prompt.includes(phrase), `prompt.js routing must say "${phrase}"`)
  }
  assert.ok(!/never need a skill|no skill is needed/.test(prompt), 'the router must not disclaim itself')

  // ─── 4. the measure agrees where vocabulary genuinely differs ──────────────
  const DECISIVE = [
    ['what could explain the result we got, we expected no effect', 'one'],
    ['what should I test next to falsify this mechanism', 'one'],
    ['brainstorm hypotheses for why the assay drifts with passage number', 'one'],
    ['rank these five candidate mechanisms by which is strongest', 'tour'],
    ['run another round and evolve the best two ideas', 'tour'],
    ['do a head-to-head comparison of these hypotheses on a leaderboard', 'tour'],
    ['set up a co-scientist style tournament for this goal', 'tour'],
    ['more candidates than one pass should hold, then which to pursue', 'tour'],
  ]
  for (const [ask, want] of DECISIVE) {
    const one = tokenOverlap(ask, oneShot)
    const tour = tokenOverlap(ask, tournament)
    const winner = one === tour ? 'tie' : (one > tour ? 'one' : 'tour')
    assert.equal(winner, want, `"${ask}" scored one=${one.toFixed(2)} tour=${tour.toFixed(2)}`)
    const [best, second] = one > tour ? [one, tour] : [tour, one]
    assert.ok(best >= 0.4 && best >= second * 1.4, `"${ask}" is not separated: ${best.toFixed(2)} vs ${second.toFixed(2)}`)
  }

  // Asks a bag-of-words measure cannot separate are the ones the skill tells the
  // agent to ask about — that is the documented behavior, not a test failure.
  const AMBIGUOUS = [
    'why does TDP-43 mislocalise before aggregation in these cells',
    'a shortlist I can defend and keep for next month',
  ]
  assert.ok(/one question|ask one question|clarifying question/i.test(triage), 'the skill must give a disambiguation rule')
  assert.ok(/Do you want these ranked and kept/i.test(triage), 'the disambiguating question must name the real fork')
  for (const ask of AMBIGUOUS) {
    const best = Math.max(tokenOverlap(ask, oneShot), tokenOverlap(ask, tournament))
    assert.ok(best > 0, `"${ask}" matched neither hypothesis skill at all`)
  }

  // ─── 5. non-hypothesis asks are refused by both descriptions ──────────────
  // The negative clauses are what tell the router "not here", so they must name
  // each family of near-miss and where it belongs instead.
  const oneNeg = negativeClauseOf('generating-scientific-hypotheses')
  const tourNeg = negativeClauseOf('co-scientist-tournament')
  for (const [clause, mustName] of [[oneNeg, ['confirmatory', 'literature review', 'manuscript']], [tourNeg, ['one pass', 'generating-scientific-hypotheses', 'framing-research-questions', 'literature review']]]) {
    for (const name of mustName) {
      assert.ok(clause.toLowerCase().includes(name.toLowerCase()), `the exclusion clause must name "${name}"`)
    }
  }
  for (const ask of [
    'does the treatment effect differ by subgroup in this dataset',
    'is this result statistically significant given multiple comparisons',
  ]) {
    assert.ok(tokenOverlap(ask, tournament) < 0.2, `"${ask}" must not pull the tournament in`)
  }

  console.log('coscientist-routing OK')
} catch (error) {
  console.error('coscientist-routing FAILED')
  throw error
}
