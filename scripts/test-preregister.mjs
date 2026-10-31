import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { apply, runPreregisterAction } from '../preregister.js'
import { preregistrationStatus, verifyPreregistration } from '../preregister-store.js'
import { startReview } from '../review-store.js'
import { freezeAnalysisPlan } from '../analysis-store.js'
import { addHypothesis, saveExperimentProtocol, startTournament } from '../coscientist-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-preregister-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)

const basePlan = {
  title: 'Widget trial',
  question: 'Does widget A improve outcome Y?',
  design: 'Two-arm parallel randomized trial',
  sample_size: { n: 128, basis: 'power_analysis: two-sample t-test, d=0.5, power=0.8', power: 0.8, alpha: 0.05, dropout: 0.1 },
  hypotheses: [{ statement: 'Widget A increases Y at 12 weeks.', direction: 'greater' }],
  outcomes: [{ name: 'Y at 12 weeks', type: 'continuous', analysis: 'Welch t-test', timepoint: '12 weeks' }],
  exclusions: 'Missing baseline measurement.',
  stopping_rules: 'No interim efficacy analysis.',
  analysis_plan: 'Welch t-test on the intention-to-treat set; alpha 0.05.',
}

try {
  let result = await run({ action: 'start', slug: 'widget', plan: basePlan })
  assert.equal(result.created, true)
  assert.ok(existsSync(workspace.path('.dsh/preregister/widget/draft.json')))

  result = await run({ action: 'status', slug: 'widget' })
  assert.equal(result.status.latest, null)
  assert.ok(result.status.missing_required.includes('question') === false)
  assert.deepEqual(result.status.missing_required, [])

  result = await run({ action: 'freeze', slug: 'widget' })
  assert.equal(result.version, 1)
  assert.match(result.hash, /^sha256:/)
  assert.ok(existsSync(workspace.path('.dsh/preregister/widget/versions/v1.json')))

  result = await run({ action: 'freeze', slug: 'widget' })
  assert.equal(result.unchanged, true)
  assert.equal(result.version, 1)

  result = await run({ action: 'start', slug: 'widget', question: 'Changed after freeze?' })
  assert.match(result.error, /frozen|new_version/)
  result = await run({ action: 'start', slug: 'widget', question: 'Changed after freeze?', new_version: true, reason: 'clarify estimand' })
  assert.equal(result.frozen, true)
  result = await run({ action: 'freeze', slug: 'widget' })
  assert.equal(result.version, 2)
  assert.equal(result.data_collected, false)

  result = await run({ action: 'status', slug: 'widget' })
  assert.equal(result.status.latest.version, 2)
  assert.deepEqual(result.status.changed_fields, [])

  result = await run({ action: 'verify', slug: 'widget' })
  assert.equal(result.verification.status, 'verified')

  result = await run({ action: 'export', slug: 'widget', format: 'markdown', overwrite: true })
  assert.match(result.result.path, /preregistration\.md$/)
  const markdown = workspace.read('.dsh/preregister/widget/exports/preregistration.md')
  assert.match(markdown, /Widget A increases Y/)
  assert.match(markdown, /Welch t-test/)
  assert.match(markdown, /Version:\*\* 2/)
  assert.match(markdown, /clarify estimand/)

  result = await run({ action: 'export', slug: 'widget', format: 'json', overwrite: true })
  const json = JSON.parse(workspace.read('.dsh/preregister/widget/exports/preregistration.json'))
  assert.equal(json.version, 2)
  assert.equal(json.registry_fields.aspredicted.data_collected, 'not recorded')
  assert.ok(json.registry_fields.osf.title)

  // Tampering with a frozen version is detected.
  workspace.write('.dsh/preregister/widget/versions/v1.json', JSON.stringify({ ...JSON.parse(workspace.read('.dsh/preregister/widget/versions/v1.json')), plan: { ...basePlan, question: 'rewritten' } }, null, 2))
  const verify = verifyPreregistration(cwd, 'widget')
  assert.equal(verify.status, 'tampered')
  assert.ok(verify.checks.some((check) => check.check === 'v1:plan_hash' && check.status === 'fail'))

  // Power import fills only the sample-size basis and records the source.
  result = await run({ action: 'start', slug: 'imported', plan: { question: 'Q', design: 'D', hypotheses: ['H'], outcomes: ['O'] } })
  assert.equal(result.created, true)
  result = await run({
    action: 'import', slug: 'imported', from: 'power',
    power: { n: 64, test: 't_two_sample', effect_size: 0.5, power: 0.8, alpha: 0.05, effect_source: 'pilot' },
  })
  assert.deepEqual(result.imported_fields.sort(), ['notes', 'sample_size'])
  result = await run({ action: 'status', slug: 'imported' })
  assert.equal(result.status.sources[0].kind, 'power_analysis')
  assert.match(result.status.draft.plan.sample_size.basis, /power_analysis/)

  // Import from a workspace JSON plan.
  workspace.write('plans/study.json', JSON.stringify({ question: 'File question', design: 'File design', hypotheses: ['File H'], outcomes: ['File O'], analysis_plan: 'File analysis' }))
  result = await run({ action: 'import', slug: 'imported', from: 'file', file: 'plans/study.json', overwrite: true })
  assert.ok(result.imported_fields.includes('analysis_plan'))

  // Import from the review, analysis, and coscientist ledgers.
  await startReview({ cwd, slug: 'review-src', protocol: { question: 'Review question?', databases: ['PubMed'], inclusion: ['included'], exclusion: ['excluded'] } })
  result = await run({ action: 'start', slug: 'from-review', plan: {} })
  result = await run({ action: 'import', slug: 'from-review', from: 'review', source_slug: 'review-src' })
  result = await run({ action: 'status', slug: 'from-review' })
  assert.match(result.status.draft.plan.question, /Review question/)
  assert.equal(result.status.draft.plan.design, 'Systematic or scoping review')

  await freezeAnalysisPlan({ cwd, slug: 'analysis-src', plan: { question: 'Analysis question?', hypotheses: ['Analysis H'], primary_outcomes: ['Y'], methods: 't-test', alpha: 0.05 } })
  result = await run({ action: 'start', slug: 'from-analysis', plan: {} })
  result = await run({ action: 'import', slug: 'from-analysis', from: 'analysis', source_slug: 'analysis-src' })
  result = await run({ action: 'status', slug: 'from-analysis' })
  assert.match(result.status.draft.plan.question, /Analysis question/)
  assert.ok(result.status.draft.plan.outcomes.some((outcome) => outcome.name === 'Y'))

  await startTournament({ cwd, slug: 'tour-src', protocol: { goal: 'Find the widget mechanism' } })
  const hypothesis = await addHypothesis({ cwd, slug: 'tour-src', hypothesis: { title: 'Widget hypothesis', summary: 'A summary', content: 'The content' } })
  await saveExperimentProtocol({ cwd, slug: 'tour-src', id: hypothesis.hypothesis.id, steps: ['Measure baseline', 'Intervene', 'Measure outcome'] })
  result = await run({ action: 'start', slug: 'from-tournament', plan: {} })
  result = await run({ action: 'import', slug: 'from-tournament', from: 'coscientist', source_slug: 'tour-src', id: hypothesis.hypothesis.id })
  result = await run({ action: 'status', slug: 'from-tournament' })
  assert.match(result.status.draft.plan.question, /widget mechanism/)
  assert.match(result.status.draft.plan.analysis_plan, /Measure baseline/)

  // Data-collection guard.
  result = await run({ action: 'start', slug: 'late', plan: { ...basePlan, data_collected: true } })
  result = await run({ action: 'freeze', slug: 'late' })
  assert.match(result.error, /data collection|reason/)
  result = await run({ action: 'freeze', slug: 'late', reason: 'pilot data already collected' })
  assert.equal(result.data_collected, true)
  assert.match(result.warning, /after data collection/)

  // Incomplete plan guard.
  result = await run({ action: 'start', slug: 'thin', plan: { question: 'Only a question' } })
  result = await run({ action: 'freeze', slug: 'thin' })
  assert.match(result.error, /missing/)
  result = await run({ action: 'freeze', slug: 'thin', allow_incomplete: true, reason: 'freeze early draft' })
  assert.ok(result.incomplete.includes('design'))

  // Submit is explicitly disabled, never calls a registry.
  result = await run({ action: 'submit', slug: 'widget', confirm: true })
  assert.equal(result.status, 'not_supported')
  assert.match(result.message, /not implemented/)

  const status = preregistrationStatus(cwd, 'widget')
  assert.equal(status.latest.version, 2)

  console.log('preregister OK')
} finally {
  workspace.cleanup()
}
