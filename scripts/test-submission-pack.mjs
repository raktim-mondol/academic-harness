import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { apply, runSubmissionAction } from '../submission-pack.js'
import { reproducibleZip } from '../submission-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-submission-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const shaFile = (rel) => `sha256:${createHash('sha256').update(readFileSync(join(cwd, rel))).digest('hex')}`

const manuscript = `# Widgets and Health

## Abstract

We studied 120 widgets and found a modest effect.

## Methods

We recruited N = 120 participants. The primary analysis used @smith2024.

## Results

The effect was t(28) = 2.05, p = .20. A rate of 45/100 (55%) was recorded.

## Data Availability

The data are available at example.org/data.

## Funding

Grant 123.

## Competing Interests

None.

## Author Contributions

A.L. designed and wrote the study.

## AI Use

No generative AI was used.
`

const bib = `@article{smith2024,
  author = {Smith, Jane},
  title = {Widgets},
  journal = {Journal of Widgets},
  year = {2024}
}
`

const baseArgs = {
  slug: 'widgets',
  manuscript: 'paper/main.md',
  manuscript_pdf: 'paper/final.pdf',
  bib: 'paper/refs.bib',
  journal: 'Journal of Widgets',
  title: 'Widgets and Health',
  article_type: 'research article',
  figures: ['figures/fig1.png'],
  requirements: {
    word_limit: 5000,
    abstract_limit: 250,
    reference_limit: 10,
    figure_limit: 5,
    table_limit: 3,
    figure_formats: ['png'],
    figure_max_width_mm: 50,
    citation_style: 'apa',
    required_statements: ['data_availability', 'funding', 'competing_interests'],
    required_sections: ['Methods', 'Results'],
    suggested_reviewers_limit: 3,
  },
  statements: { funding: 'This work was supported by Grant 123.' },
  suggested_reviewers: [{ name: 'Reviewer One', affiliation: 'University', email: 'r1@example.org', source: 'author list' }],
  highlights: ['Widgets matter for health.', 'The effect is modest.'],
}

try {
  workspace.write('paper/main.md', manuscript)
  workspace.write('paper/final.pdf', '%PDF-1.4\n% placeholder\n')
  workspace.write('paper/refs.bib', bib)
  workspace.write('figures/fig1.png', 'not-a-real-png')
  workspace.write('supp/supplement.md', '# Supplement\n\nExtra table.\n')

  let result = await run({ action: 'plan', ...baseArgs })
  assert.equal(result.error, undefined, result.error)
  const plan = result.plan
  assert.equal(plan.journal, 'Journal of Widgets')
  assert.equal(plan.counts.references, 1)
  assert.equal(plan.counts.figures, 1)
  const checkById = (id) => plan.checks.find((entry) => entry.id === id)
  assert.equal(checkById('word_count').status, 'pass')
  assert.equal(checkById('abstract_word_count').status, 'pass')
  assert.equal(checkById('reference_count').status, 'pass')
  assert.equal(checkById('citations').status, 'pass')
  assert.equal(checkById('citation_style').status, 'manual_check')
  assert.equal(checkById('figure_size').status, 'manual_check')
  assert.equal(checkById('statement_funding').status, 'pass')
  assert.equal(checkById('statement_data_availability').status, 'manual_check')
  assert.equal(checkById('section_methods').status, 'pass')
  assert.equal(checkById('suggested_reviewers').status, 'manual_check')
  assert.equal(checkById('numbers_audit').status, 'manual_check')
  assert.equal(plan.ready, false)

  result = await run({ action: 'plan', ...baseArgs, requirements: { ...baseArgs.requirements, word_limit: 5 } })
  assert.equal(result.plan.checks.find((entry) => entry.id === 'word_count').status, 'fail')
  assert.ok(result.plan.failed.includes('word_count'))

  result = await run({ action: 'build', ...baseArgs, supplementary: ['supp/supplement.md'] })
  assert.equal(result.error, undefined, result.error)
  const pack = result.pack
  assert.match(pack.pack_id, /^sub-/)
  assert.ok(existsSync(join(cwd, pack.zip)))
  const manifest = JSON.parse(workspace.read(`${pack.pack_dir}/manifest.json`))
  assert.ok(manifest.files.length >= 7)
  for (const file of manifest.files) {
    assert.equal(shaFile(`${pack.pack_dir}/${file.path}`), file.sha256, `manifest hash mismatch: ${file.path}`)
  }
  assert.ok(manifest.files.some((file) => file.role === 'manuscript_pdf'))
  assert.ok(manifest.files.some((file) => file.role === 'manuscript_source'))
  assert.ok(manifest.files.some((file) => file.role === 'bibliography'))
  assert.ok(manifest.files.some((file) => file.role === 'supplementary'))
  assert.ok(manifest.files.some((file) => file.role === 'cover_letter'))
  assert.ok(manifest.files.some((file) => file.role === 'highlights'))
  assert.ok(manifest.files.some((file) => file.role === 'checklist'))
  assert.ok(manifest.files.some((file) => file.path === 'statements/funding.md'))
  assert.match(workspace.read(`${pack.pack_dir}/cover-letter.md`), /Author approval required/)
  assert.match(workspace.read(`${pack.pack_dir}/highlights.md`), /Widgets matter/)
  assert.equal(manifest.ready_to_upload, false, 'manual checks keep upload readiness false')

  const entries = manifest.files.map((file) => ({ path: file.path }))
  entries.push({ path: 'manifest.json' })
  const zipA = reproducibleZip(workspace.path(pack.pack_dir), entries)
  const zipB = reproducibleZip(workspace.path(pack.pack_dir), entries)
  assert.ok(zipA.equals(zipB), 'zip bytes must be reproducible from the same manifest')
  const archive = new AdmZip(workspace.path(pack.zip))
  assert.ok(archive.getEntry('manifest.json'))
  assert.ok(archive.getEntry('checklist.md'))

  result = await run({ action: 'status', slug: 'widgets' })
  assert.equal(result.status.packs.length, 1)
  assert.equal(result.status.plan.slug, 'widgets')
  assert.ok(result.status.manual_check.includes('numbers_audit'))

  result = await run({ action: 'export', slug: 'widgets', pack_id: pack.pack_id })
  assert.equal(result.error, undefined, result.error)
  assert.match(result.result.path, /exports\/sub-.*\.zip$/)
  const exportedHash = shaFile(result.result.path)
  assert.equal(exportedHash, pack.zip_sha256, 'export must copy the recorded zip')
  result = await run({ action: 'export', slug: 'widgets', pack_id: pack.pack_id })
  assert.match(result.error, /already exists/)
  result = await run({ action: 'export', slug: 'widgets', pack_id: pack.pack_id, overwrite: true, format: 'dir' })
  assert.equal(result.result.format, 'dir')
  assert.ok(existsSync(join(cwd, result.result.path, 'manifest.json')))

  assert.throws(
    () => reproducibleZip(workspace.path(pack.pack_dir), [{ path: '../escape.md' }]),
    /unsafe archive path/,
  )

  result = await run({
    action: 'build', slug: 'traversal', manuscript: 'paper/main.md', manuscript_pdf: 'paper/final.pdf',
    journal: 'Journal of Widgets', requirements: { required_statements: ['../../escape'] },
    statements: { '../../escape': 'not allowed' },
  })
  assert.equal(result.error, undefined, result.error)
  const traversalManifest = JSON.parse(workspace.read(`${result.pack.pack_dir}/manifest.json`))
  assert.ok(traversalManifest.files.every((file) => !file.path.split('/').includes('..')))
  assert.ok(!existsSync(join(cwd, 'escape.md')))
  assert.ok(!existsSync(join(cwd, '.dsh', 'submission', 'escape.md')))

  workspace.write('paper/plain.md', '# Plain\n\nHello world.\n')
  result = await run({ action: 'plan', slug: 'plain', manuscript: 'paper/plain.md', journal: 'J' })
  assert.equal(result.error, undefined, result.error)
  assert.equal(result.plan.checks.find((entry) => entry.id === 'numbers_audit').status, 'not_checked')
  assert.equal(result.plan.checks.find((entry) => entry.id === 'citations').status, 'not_checked')

  // Without a manuscript PDF the pack records a failed build check.
  result = await run({ action: 'build', slug: 'no-pdf', manuscript: 'paper/main.md', bib: 'paper/refs.bib', journal: 'Journal of Widgets', compile: false })
  assert.equal(result.error, undefined, result.error)
  const noPdfManifest = JSON.parse(workspace.read(`${result.pack.pack_dir}/manifest.json`))
  assert.ok(noPdfManifest.failed.includes('pack_manuscript_pdf'))

  result = await run({ action: 'plan', slug: 'escape', manuscript: '../outside.md', journal: 'X' })
  assert.match(result.error, /escapes the workspace/)
  result = await run({ action: 'plan', slug: 'missing', manuscript: 'paper/nope.md', journal: 'X' })
  assert.match(result.error, /file not found/)
  result = await run({ action: 'status', slug: 'nothing' })
  assert.equal(result.status.plan, null)

  const direct = await runSubmissionAction({ action: 'plan', slug: 'direct', manuscript: 'paper/main.md', journal: 'J', compile: false }, exec)
  assert.equal(direct.plan.slug, 'direct')

  console.log('submission_pack OK')
} finally {
  workspace.cleanup()
}
