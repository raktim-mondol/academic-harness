import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, runReview as runReviewDirect } from '../review.js'
import { fakeExec, makeWorkspace } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-grade-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)

const DOMAINS = ['risk_of_bias', 'inconsistency', 'indirectness', 'imprecision', 'publication_bias']
const verified = async () => ({
  found: true,
  occurrences: [{ is_bibliography: 0 }],
  checked_against: { sha256: 'grade-check' },
})

try {
  let result = await run({ action: 'grade_status', slug: 'not-started' })
  assert.match(result.error, /has not been started/)

  await run({ action: 'start', slug: 'grade-single', question: 'Does X improve Y?' })
  result = await run({ action: 'grade_status', slug: 'grade-single' })
  assert.match(result.status.note, /No GRADE outcomes/)
  result = await run({ action: 'grade_start', slug: 'grade-single', outcomes: [] })
  assert.match(result.error, /outcomes must be a non-empty array/)
  result = await run({
    action: 'grade_start',
    slug: 'grade-single',
    outcomes: [
      {
        id: 'mortality',
        name: 'All-cause mortality',
        comparison: 'X vs placebo',
        importance: 'critical',
        studies: ['S1', 'S2', 'S3'],
        participants: 400,
        effect: 0.75,
        effect_ci: [0.6, 0.9],
        measure: 'RR',
        notes: 'Follow-up 12 months',
      },
      {
        id: 'mortality',
        name: 'Duplicate',
      },
    ],
  })
  assert.match(result.error, /duplicate GRADE outcome/)
  result = await run({
    action: 'grade_start',
    slug: 'grade-single',
    outcomes: [
      {
        id: 'mortality',
        name: 'All-cause mortality',
        comparison: 'X vs placebo',
        importance: 'critical',
        studies: ['S1', 'S2', 'S3'],
        participants: 400,
        effect: 0.75,
        effect_ci: [0.6, 0.9],
        measure: 'RR',
        notes: 'Follow-up 12 months',
      },
    ],
  })
  assert.equal(result.resumed, false)
  assert.equal(result.grade.outcomes.length, 1)
  result = await run({
    action: 'grade_start',
    slug: 'grade-single',
    outcomes: [{ id: 'other', name: 'Other' }],
  })
  assert.match(result.error, /already exist/)
  result = await run({ action: 'grade_start', slug: 'grade-single', resume: true })
  assert.equal(result.resumed, true)

  result = await run({ action: 'grade_judge', slug: 'grade-single', outcome: 'missing', domain: 'risk_of_bias', rating: 'not_serious', reviewer: 'alice', reason: 'x' })
  assert.match(result.error, /not found/)
  result = await run({ action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain: 'not_a_domain', rating: 'not_serious', reviewer: 'alice', reason: 'x' })
  assert.match(result.error, /domain must be one of/)
  result = await run({ action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain: 'risk_of_bias', rating: 'nope', reviewer: 'alice', reason: 'x' })
  assert.match(result.error, /rating must be one of/)
  result = await run({ action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain: 'risk_of_bias', rating: 'not_serious', reviewer: 'alice' })
  assert.match(result.error, /reason is required/)
  result = await run({ action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain: 'risk_of_bias', rating: 'not_serious', reviewer: 'alice', reason: 'x', quote: 'a quote' })
  assert.match(result.error, /location is required/)

  for (const domain of DOMAINS) {
    result = await run({
      action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain,
      rating: 'not_serious', reviewer: 'alice', reason: `No serious ${domain}`,
    })
    assert.equal(result.event.rating, 'not_serious')
  }
  for (const domain of ['large_effect', 'dose_response', 'plausible_confounding']) {
    result = await run({
      action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain,
      rating: 'not_applicable', reviewer: 'alice', reason: 'Not applicable',
    })
    assert.equal(result.event.rating, 'not_applicable')
  }
  result = await run({ action: 'grade_status', slug: 'grade-single', outcome: 'mortality' })
  assert.equal(result.status.outcomes.length, 1)
  assert.equal(result.status.outcomes[0].suggestion.certainty, 'high')
  assert.equal(result.status.outcomes[0].overall.state, 'pending')
  assert.ok(result.status.outcomes[0].warnings.some((warning) => /no overall certainty/.test(warning)))

  result = await run({
    action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain: 'inconsistency',
    rating: 'serious', reviewer: 'alice', reason: 'Unexplained heterogeneity',
  })
  assert.match(result.error, /already has an inconsistency/)
  result = await run({
    action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain: 'inconsistency',
    rating: 'serious', reviewer: 'alice', reason: 'Unexplained heterogeneity', override: true,
  })
  assert.equal(result.event.override, true)
  assert.equal(result.outcomes[0].suggestion.certainty, 'moderate')

  result = await run({
    action: 'grade_overall', slug: 'grade-single', outcome: 'mortality',
    certainty: 'high', reviewer: 'alice', reason: 'Initial judgement',
  })
  assert.equal(result.event.certainty, 'high')
  assert.ok(result.outcomes[0].warnings.some((warning) => /differs from the suggestion/.test(warning)))
  result = await run({
    action: 'grade_overall', slug: 'grade-single', outcome: 'mortality',
    certainty: 'high', reviewer: 'alice', reason: 'No change',
  })
  assert.match(result.error, /already has an overall GRADE certainty/)
  result = await run({
    action: 'grade_overall', slug: 'grade-single', outcome: 'mortality',
    certainty: 'moderate', reviewer: 'alice', reason: 'Agreed after discussion', override: true,
  })
  assert.equal(result.event.certainty, 'moderate')
  assert.equal(result.outcomes[0].suggestion.certainty, 'moderate')
  assert.equal(result.outcomes[0].overall.value, 'moderate')

  result = await run({ action: 'export', slug: 'grade-single', format: 'grade-profile' })
  assert.match(result.path, /grade-profile\.md$/)
  const profile = readFileSync(join(cwd, result.path), 'utf8')
  assert.match(profile, /GRADE evidence profile/)
  assert.match(profile, /Stored overall: moderate/)
  result = await run({ action: 'export', slug: 'grade-single', format: 'grade-profile', table_format: 'csv' })
  assert.match(readFileSync(join(cwd, result.path), 'utf8'), /outcome,outcome_name,domain,rating/)
  result = await run({ action: 'export', slug: 'grade-single', format: 'sof-table' })
  assert.match(result.path, /sof-table\.md$/)
  const sof = readFileSync(join(cwd, result.path), 'utf8')
  assert.match(sof, /Summary of findings/)
  assert.match(sof, /All-cause mortality/)
  assert.match(sof, /0\.75 \(0\.6–0\.9\)/)
  assert.match(sof, /moderate/)
  result = await run({ action: 'export', slug: 'grade-single', format: 'sof-table', table_format: 'csv' })
  assert.match(readFileSync(join(cwd, result.path), 'utf8'), /outcome,studies,participants,effect,certainty,comments/)
  result = await run({ action: 'export', slug: 'grade-single', format: 'sof-table', table_format: 'latex' })
  assert.match(readFileSync(join(cwd, result.path), 'utf8'), /\\begin\{longtable\}/)
  result = await run({ action: 'export', slug: 'grade-single', format: 'sof-table', table_format: 'latex' })
  assert.match(result.error, /already exists/)
  result = await run({ action: 'export', slug: 'grade-single', format: 'grade-profile', table_format: 'latex' })
  assert.match(result.error, /table_format must be markdown or csv/)

  // Quote verification path: verified with a paper, rejected when absent.
  const quote = await runReviewDirect({
    action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain: 'risk_of_bias',
    rating: 'not_serious', reviewer: 'alice', reason: 'Checked against the trial report',
    quote: 'No serious risk of bias was identified.', location: 'Methods, p. 2', paper: 'pm:1',
    override: true,
  }, exec, { verifyQuote: verified })
  assert.equal(quote.event.quote_check.status, 'verified')
  const absent = await runReviewDirect({
    action: 'grade_judge', slug: 'grade-single', outcome: 'mortality', domain: 'indirectness',
    rating: 'not_serious', reviewer: 'alice', reason: 'Checked', quote: 'absent', location: 'Results', paper: 'pm:absent',
  }, exec, {
    verifyQuote: async () => ({ found: false, checked_against: { sha256: 'x' }, reason: 'not-found' }),
  })
  assert.match(absent.error, /not found in PaperMemory paper/)

  // Dual-reviewer conflict and incomplete-domain handling.
  await run({ action: 'start', slug: 'grade-dual', question: 'Dual GRADE?', reviewers: ['alice', 'bob'] })
  await run({
    action: 'grade_start', slug: 'grade-dual',
    outcomes: [{ id: 'pain', name: 'Pain', importance: 'important', studies: 2, participants: 180, effect: 0.8, effect_ci: [0.6, 1.1], measure: 'RR' }],
  })
  for (const domain of DOMAINS) {
    await run({
      action: 'grade_judge', slug: 'grade-dual', outcome: 'pain', domain,
      rating: 'not_serious', reviewer: 'alice', reason: 'alice judgement',
    })
  }
  result = await run({ action: 'grade_status', slug: 'grade-dual', outcome: 'pain' })
  assert.ok(result.status.outcomes[0].missing_domains.includes('inconsistency'))
  assert.equal(result.status.outcomes[0].suggestion.certainty, null)
  for (const domain of DOMAINS) {
    await run({
      action: 'grade_judge', slug: 'grade-dual', outcome: 'pain', domain,
      rating: 'not_serious', reviewer: 'bob', reason: 'bob judgement',
    })
  }
  result = await run({ action: 'grade_status', slug: 'grade-dual', outcome: 'pain' })
  assert.equal(result.status.outcomes[0].domains.inconsistency.state, 'recorded')
  assert.equal(result.status.outcomes[0].suggestion.certainty, 'high')
  await run({
    action: 'grade_judge', slug: 'grade-dual', outcome: 'pain', domain: 'inconsistency',
    rating: 'serious', reviewer: 'bob', reason: 'Conflicting effects', override: true,
  })
  result = await run({ action: 'grade_status', slug: 'grade-dual', outcome: 'pain' })
  assert.equal(result.status.outcomes[0].domains.inconsistency.state, 'conflict')
  assert.equal(result.status.outcomes[0].suggestion.certainty, null)
  await run({
    action: 'grade_overall', slug: 'grade-dual', outcome: 'pain', certainty: 'high', reviewer: 'alice', reason: 'alice overall',
  })
  await run({
    action: 'grade_overall', slug: 'grade-dual', outcome: 'pain', certainty: 'moderate', reviewer: 'bob', reason: 'bob overall',
  })
  result = await run({ action: 'grade_status', slug: 'grade-dual', outcome: 'pain' })
  assert.equal(result.status.outcomes[0].overall.state, 'conflict')
  result = await run({ action: 'export', slug: 'grade-dual', format: 'sof-table' })
  assert.match(readFileSync(join(cwd, result.path), 'utf8'), /conflict/)

  console.log('GRADE OK')
} finally {
  workspace.cleanup()
}
