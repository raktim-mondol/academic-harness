import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, runDataProfile } from '../data-profile.js'
import { runHelper } from '../python-runtime.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const probe = runHelper('data_profile.py', { path: '/nonexistent.csv' })
if (probe?.code === 'pandas_missing' || !/could not read/.test(probe?.error || '')) {
  console.log(`data_profile helper skipped: ${probe?.error || JSON.stringify(probe)}`)
  process.exit(0)
}

const workspace = makeWorkspace('ah-profile-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)

try {
  // A CSV with planted defects: leakage-like ID, split overlap, duplicates,
  // constant column, missingness, small categorical cells.
  const rows = []
  for (let index = 0; index < 40; index += 1) {
    const outcome = index % 2
    rows.push([
      `P${index}`, // id-like, perfectly correlated with outcome via ordering
      outcome,
      outcome === 0 ? 1.1 + index * 0.01 : 5.0 + index * 0.01,
      'fixed', // constant
      index % 2 === 0 || index % 3 === 0 ? '' : index * 1.5, // >50% missingness
      index % 39 === 0 ? 'train' : index % 2 === 0 ? 'train' : 'test', // split
      index < 2 ? 'rare' : `cat${index % 9}`, // small cells
    ].join(','))
  }
  // A row duplicated verbatim, and one duplicated across splits (same fields,
  // different split value).
  rows.push('P1,1,5.01,fixed,1.5,test,rare')
  rows.push('P0,0,1.1,fixed,,test,rare')
  workspace.write('data/analysis.csv', [
    'patient_id,outcome,score,site,level,split,group',
    ...rows,
  ].join('\n'))

  let result = await run({ action: 'profile', path: 'data/analysis.csv', target: 'outcome', split: 'split' })
  assert.ok(!result.error, result.error)
  const profile = result.profile
  assert.equal(profile.rows, 42)
  assert.equal(profile.columns, 7)
  assert.equal(profile.sampled, false)
  assert.ok(profile.duplicate_rows >= 1)
  const kinds = profile.findings.map((finding) => finding.kind)
  assert.ok(kinds.includes('split_overlap'), `expected split_overlap in ${kinds.join(', ')}`)
  assert.ok(kinds.includes('possible_leakage'), `expected possible_leakage in ${kinds.join(', ')}`)
  const leakage = profile.findings.find((finding) => finding.kind === 'possible_leakage')
  assert.ok(leakage.columns.includes('score'))
  assert.ok(kinds.includes('constant_columns'))
  assert.ok(kinds.includes('high_missingness'))
  assert.ok(kinds.includes('small_categorical_cells'))
  assert.ok(profile.id_columns_flagged.includes('patient_id'))
  assert.ok(profile.column_profiles.find((column) => column.name === 'site').constant)
  assert.ok(profile.not_checked.some((entry) => /protected health information/i.test(entry)))
  assert.match(result.markdown, /# Data profile: data\/analysis\.csv/)
  assert.match(result.markdown, /not a PHI determination/)
  assert.match(result.markdown, /assoc\(target\)/)

  // Sampling is announced.
  result = await run({ action: 'profile', path: 'data/analysis.csv', max_rows: 10 })
  assert.equal(result.profile.sampled, true)
  assert.equal(result.profile.rows, 10)
  assert.match(result.markdown, /Sampled/)

  // Writing produces report, json, and dictionary; overwrite is refused.
  result = await run({ action: 'profile', path: 'data/analysis.csv', target: 'outcome', write: true, slug: 'analysis' })
  assert.equal(result.written.length, 3)
  assert.ok(result.written.every((path) => existsSync(join(cwd, path))))
  const dictionary = readFileSync(join(cwd, '.dsh', 'profiles', 'analysis', 'exports', 'data-dictionary.csv'), 'utf8')
  assert.match(dictionary.split('\n')[0], /^column,dtype,rows,missing,missing_pct,unique,id_like,date_like,/)
  assert.match(dictionary, /patient_id/)
  result = await run({ action: 'profile', path: 'data/analysis.csv', write: true, slug: 'analysis' })
  assert.match(result.error, /already exists/)
  result = await run({ action: 'profile', path: 'data/analysis.csv', write: true, slug: 'analysis', overwrite: true })
  assert.ok(!result.error)

  // Errors: escapes, missing columns, missing file.
  result = await run({ action: 'profile', path: '../outside.csv' })
  assert.match(result.error, /escapes the workspace/)
  result = await run({ action: 'profile', path: 'data/analysis.csv', target: 'ghost' })
  assert.match(result.error, /column 'ghost' is not in the file/)
  result = await run({ action: 'profile', path: 'data/missing.csv' })
  assert.match(result.error, /file not found/)
  result = await run({ action: 'profile' })
  assert.match(result.error, /path is required/)

  // JSONL input works too.
  workspace.write('data/rows.jsonl', [
    '{"a": 1, "b": "x"}',
    '{"a": 2, "b": "y"}',
    '{"a": 3, "b": "x"}',
  ].join('\n'))
  result = await run({ action: 'profile', path: 'data/rows.jsonl' })
  assert.equal(result.profile.rows, 3)

  // Direct runner throws.
  await assert.rejects(() => runDataProfile({ path: 'data/missing.csv' }, exec), /file not found/)

  console.log('data_profile OK')
} finally {
  workspace.cleanup()
}
