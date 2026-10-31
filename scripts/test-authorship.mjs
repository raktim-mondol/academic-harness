import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { apply, runAuthorshipAction } from '../authorship.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-authorship-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)

try {
  let result = await run({ action: 'start', slug: 'paper', manuscript: 'paper/main.tex', title: 'Widgets and Health' })
  assert.equal(result.created, true)
  assert.match(result.record.created_at, /^\d{4}-/)

  result = await run({ action: 'start', slug: 'paper', manuscript: 'paper/main.tex', title: 'Widgets and Health' })
  assert.equal(result.created, false)
  result = await run({ action: 'start', slug: 'paper', manuscript: 'paper/other.tex' })
  assert.match(result.error, /different metadata/)

  result = await run({ action: 'add', slug: 'paper', name: 'Ada Lovelace', position: 1, affiliation: 'Analytical Engine Lab', orcid: '0000-0002-1825-0097', corresponding: true, email: 'ada@example.org' })
  assert.equal(result.author_id, 'a001')
  result = await run({ action: 'add', slug: 'paper', name: 'Grace Hopper' })
  assert.equal(result.author_id, 'a002')
  assert.match(result.warning, /does not assign one/)
  result = await run({ action: 'add', slug: 'paper', name: 'Bad ORCID', orcid: '1234' })
  assert.match(result.error, /ORCID|orcid/)
  result = await run({ action: 'add', slug: 'paper', name: 'Second First', position: 1 })
  assert.equal(result.author_id, 'a003')

  result = await run({ action: 'credit', slug: 'paper', author: 'a001', roles: ['Conceptualization', 'writing original draft'], recorded_by: 'author' })
  assert.deepEqual(result.roles, ['Conceptualization', 'Writing – original draft'])
  result = await run({ action: 'credit', slug: 'paper', author: 'Ada Lovelace', roles: ['Software'] })
  assert.deepEqual(result.roles, ['Software'])
  result = await run({ action: 'credit', slug: 'paper', author: 'a001', roles: ['Mind reading'] })
  assert.match(result.error, /unknown CRediT role/)
  result = await run({ action: 'credit', slug: 'paper', author: 'missing', roles: ['Software'] })
  assert.match(result.error, /no author/)

  result = await run({ action: 'icmje', slug: 'paper', author: 'a001', criteria: {
    substantial_contributions: true, drafted_or_revised: true, final_approval: true, accountable: 'unknown',
  } })
  assert.deepEqual(result.missing, ['accountable'])
  result = await run({ action: 'icmje', slug: 'paper', author: 'a001', criteria: { substantial_contributions: 'maybe' } })
  assert.match(result.error, /must be true, false, or unknown/)

  result = await run({ action: 'statement', slug: 'paper', funding: 'Grant 123', competing_interests: 'None' })
  assert.match(result.path, /\.dsh\/authorship\/paper\/statement\.md$/)
  const statement = workspace.read('.dsh/authorship/paper/statement.md')
  assert.match(statement, /Ada Lovelace/)
  assert.match(statement, /Ada Lovelace:\*\* Software/)
  const creditLog = workspace.read('.dsh/authorship/paper/credit.jsonl')
  assert.match(creditLog, /Writing – original draft/)
  assert.match(creditLog, /Conceptualization/)
  assert.match(statement, /Author order not recorded for: Grace Hopper/)
  assert.match(statement, /duplicate_position/)
  assert.match(statement, /credit_disagreement/)
  assert.match(statement, /does not determine authorship order/)
  assert.match(statement, /Funding:\*\* Grant 123/)
  assert.match(statement, /Competing interests:\*\* None/)
  assert.ok(existsSync(join(cwd, '.dsh', 'authorship', 'paper', 'statement.json')))
  result = await run({ action: 'statement', slug: 'paper' })
  assert.match(result.error, /already exists/)

  result = await run({ action: 'export', slug: 'paper', format: 'csv', overwrite: true })
  assert.match(result.path, /authorship\.csv$/)
  const csv = workspace.read('.dsh/authorship/paper/exports/authorship.csv')
  assert.match(csv, /^author_id,name,position/)
  assert.match(csv, /Ada Lovelace/)
  assert.match(csv, /Software/)
  assert.ok(!csv.includes('Conceptualization'), 'the export shows the latest recorded role set')
  result = await run({ action: 'export', slug: 'paper', format: 'json', overwrite: true })
  const json = JSON.parse(workspace.read('.dsh/authorship/paper/exports/authorship.json'))
  assert.equal(json.authors.length, 3)
  assert.ok(json.conflicts.some((conflict) => conflict.kind === 'duplicate_position'))
  assert.ok(json.conflicts.some((conflict) => conflict.kind === 'credit_disagreement'))
  result = await run({ action: 'export', slug: 'missing' })
  assert.match(result.error, /has not been started/)

  const direct = await runAuthorshipAction({ action: 'add', slug: 'paper', name: 'Direct Call' }, exec)
  assert.equal(direct.author_id, 'a004')
  const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => run({ action: 'add', slug: 'paper', name: `Concurrent ${index}` })))
  assert.equal(new Set(concurrent.map((entry) => entry.author_id)).size, 5)
  assert.ok(concurrent.every((entry) => /^a\d{3}$/.test(entry.author_id)))

  await run({ action: 'add', slug: 'paper', name: '=HYPERLINK("http://example.org")', position: 9 })
  result = await run({ action: 'export', slug: 'paper', format: 'csv', overwrite: true })
  const guardedCsv = workspace.read('.dsh/authorship/paper/exports/authorship.csv')
  assert.match(guardedCsv, /'=HYPERLINK/)

  await assert.rejects(
    () => runAuthorshipAction({ action: 'add', slug: 'paper', name: 'No Record' }, fakeExec(join(cwd, 'elsewhere'))),
    /has not been started/,
  )

  console.log('authorship OK')
} finally {
  workspace.cleanup()
}
