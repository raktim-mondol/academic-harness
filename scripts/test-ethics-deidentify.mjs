import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { apply as applyEthics, runEthicsAction } from '../ethics-protocol.js'
import { apply as applyDeidentify, runDeidentifyAction } from '../deidentify.js'
import { startPreregistration, freezePreregistration } from '../preregister-store.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-ethics-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let ethicsTool
let deidentifyTool
applyEthics({ tools: { register: (registered) => { ethicsTool = registered } } })
applyDeidentify({ tools: { register: (registered) => { deidentifyTool = registered } } })
const ethics = (args) => ethicsTool.execute(args, exec)
const deid = (args) => deidentifyTool.execute(args, exec)

try {
  let result = await ethics({
    action: 'start', slug: 'trial', title: 'Widget trial', study_type: 'human_subjects',
    institution: 'Example University', principal_investigator: 'Ada Lovelace',
    population: 'Adults with widgets', risks: 'Mild discomfort.', data_handling: 'Coded IDs stored on an encrypted server.',
    data_types: ['identifiable'], jurisdiction: 'us', retention: 'Destroy after 7 years.', funding: 'Grant 123',
  })
  assert.equal(result.created, true)
  assert.match(result.hash, /^sha256:/)

  result = await ethics({ action: 'start', slug: 'trial', title: 'Widget trial v2', study_type: 'human_subjects' })
  assert.match(result.error, /reason/)
  result = await ethics({ action: 'start', slug: 'trial', title: 'Widget trial v2', study_type: 'human_subjects', reasons: 'x', reason: 'clarify title' })
  assert.equal(result.updated, true)

  result = await ethics({ action: 'section', slug: 'trial', id: 'consent-process', title: 'Consent process', body: 'Written consent is obtained by trained staff.' })
  assert.match(result.section.hash, /^sha256:/)
  result = await ethics({ action: 'section', slug: 'trial', id: 'consent-process', title: 'Consent process', body: 'Written consent is obtained by trained staff; de-identified exports are reviewed.' })
  result = await ethics({ action: 'status', slug: 'trial' })
  assert.match(result.status.sections['consent-process'].text, /de-identified exports/)

  result = await ethics({ action: 'consent', slug: 'trial', consent: { purpose: 'To test widgets.', procedures: 'Two visits.', contacts: 'study@example.edu' } })
  assert.ok(existsSync(workspace.path('.dsh/ethics/trial/consents/consent.md')))
  assert.ok(result.placeholders > 0)
  const consent = workspace.read('.dsh/ethics/trial/consents/consent.md')
  assert.match(consent, /Two visits/)
  assert.match(consent, /TO BE COMPLETED/)
  result = await ethics({ action: 'consent', slug: 'trial' })
  assert.match(result.error, /already exists/)
  result = await ethics({ action: 'consent', slug: 'trial', overwrite: true })
  assert.ok(result.bytes > 0)

  result = await ethics({ action: 'check', slug: 'trial' })
  assert.ok(result.checklist.counts.missing > 0)
  assert.ok(result.checklist.items.some((entry) => entry.id === 'ethics_approval' && entry.status === 'missing'))
  assert.ok(result.checklist.items.some((entry) => entry.id === 'deidentification' && entry.status === 'manual_check'))
  assert.ok(result.checklist.items.some((entry) => entry.id === 'hipaa' && entry.status === 'manual_check'))
  assert.match(result.checklist.note, /not legal advice|not a compliance/i)

  result = await ethics({ action: 'export', slug: 'trial', format: 'markdown', overwrite: true })
  assert.match(workspace.read('.dsh/ethics/trial/exports/ethics.md'), /Concept checklist/)
  result = await ethics({ action: 'export', slug: 'trial', format: 'json', overwrite: true })
  const ethicsJson = JSON.parse(workspace.read('.dsh/ethics/trial/exports/ethics.json'))
  assert.equal(ethicsJson.protocol.title, 'Widget trial v2')
  assert.ok(ethicsJson.checklist.items.length > 0)

  // Link a pre-registration with the same slug.
  await startPreregistration({ cwd, slug: 'trial', patch: { question: 'Q', design: 'RCT', hypotheses: ['H'], outcomes: ['O'], analysis_plan: 'A' } })
  await freezePreregistration({ cwd, slug: 'trial' })
  result = await ethics({ action: 'status', slug: 'trial' })
  assert.equal(result.status.preregister.version, 1)

  // Animal and EU/GDPR branches.
  result = await ethics({ action: 'start', slug: 'animal', title: 'Mouse study', study_type: 'animal', institution: 'Example', data_types: ['animal'], jurisdiction: 'eu' })
  result = await ethics({ action: 'check', slug: 'animal' })
  assert.ok(result.checklist.items.some((entry) => entry.id === 'animal_welfare' && entry.status === 'manual_check'))
  assert.ok(result.checklist.items.some((entry) => entry.id === 'gdpr' && entry.status === 'manual_check'))
  assert.ok(result.checklist.items.some((entry) => entry.id === 'consent' && entry.status === 'not_applicable'))

  /* ---------------------------------------------------------- deidentify */

  workspace.write('notes/patient.txt', [
    'Patient: Ada Lovelace',
    'DOB 1980-05-01',
    'Email ada@example.org',
    'Phone (555) 123-4567',
    'SSN 123-45-6789',
    'MRN: A123456',
    'She is 94 years old.',
    'Address: 123 Analytical Engine Way',
    'IP 192.168.1.10',
    'Custom identifier PROJECT-ALPHA.',
    '',
  ].join('\n'))
  result = await deid({ action: 'scan', slug: 'notes', file: 'notes/patient.txt', terms: ['PROJECT-ALPHA'] })
  assert.equal(result.scan.scan_id, 'd0001')
  assert.equal(result.scan.match_count, 10)
  for (const type of ['name', 'date', 'email', 'phone', 'ssn', 'mrn', 'age_over_89', 'address', 'ip', 'custom']) {
    assert.ok(result.scan.by_type[type], `missing ${type}`)
  }
  const ledger = workspace.read('.dsh/deidentify/notes/scans.jsonl')
  for (const raw of ['Ada Lovelace', 'ada@example.org', '123-45-6789', 'PROJECT-ALPHA']) {
    assert.ok(!ledger.includes(raw), `scan ledger leaked ${raw}`)
  }

  result = await deid({ action: 'redact', slug: 'notes', file: 'notes/patient.txt', out: 'notes/patient.redacted.txt', terms: ['PROJECT-ALPHA'], overwrite: true })
  assert.equal(result.redaction.residual.match_count, 0)
  const redacted = workspace.read('notes/patient.redacted.txt')
  for (const raw of ['Ada Lovelace', 'ada@example.org', '123-45-6789', 'PROJECT-ALPHA', '123 Analytical Engine Way']) {
    assert.ok(!redacted.includes(raw), `redacted file still contains ${raw}`)
  }
  assert.match(redacted, /\*\*\*/)

  result = await deid({ action: 'verify', slug: 'notes', file: 'notes/patient.redacted.txt', terms: ['PROJECT-ALPHA'] })
  assert.equal(result.verification.status, 'clean')
  result = await deid({ action: 'verify', slug: 'notes', redaction_id: 'r0001' })
  assert.match(result.error, /custom terms|same terms/)
  result = await deid({ action: 'verify', slug: 'notes', redaction_id: 'r0001', terms: ['PROJECT-ALPHA'] })
  assert.equal(result.verification.status, 'clean')

  result = await deid({ action: 'redact', slug: 'notes', file: 'notes/patient.txt', out: 'notes/patient.second.txt', scan_id: 'd0001', terms: ['PROJECT-ALPHA'], overwrite: true })
  assert.equal(result.redaction.redaction_id, 'r0002')
  result = await deid({ action: 'verify', slug: 'notes', redaction_id: 'r0002', terms: ['PROJECT-ALPHA'] })
  assert.equal(result.verification.file, 'notes/patient.second.txt')
  assert.equal(result.verification.status, 'clean')
  workspace.write('notes/patient.second.txt', `${workspace.read('notes/patient.second.txt')}changed after redaction\n`)
  result = await deid({ action: 'verify', slug: 'notes', redaction_id: 'r0002', terms: ['PROJECT-ALPHA'] })
  assert.equal(result.verification.status, 'modified')

  result = await deid({ action: 'redact', slug: 'notes', file: 'notes/patient.txt', out: 'notes/drop.txt', policy: { default_action: 'drop' } })
  assert.match(result.error, /drop/)
  result = await deid({ action: 'redact', slug: 'notes', file: 'notes/patient.txt', out: 'notes/patient.txt' })
  assert.match(result.error, /differ|in place/)
  result = await deid({ action: 'redact', slug: 'notes', file: 'notes/patient.txt', out: 'notes/patient.redacted.txt', terms: ['PROJECT-ALPHA'] })
  assert.match(result.error, /already exists/)
  result = await deid({ action: 'redact', slug: 'notes', file: 'notes/patient.txt', out: 'notes/again.txt', scan_id: 'd0001' })
  assert.match(result.error, /custom terms/)

  result = await deid({ action: 'report', slug: 'notes', format: 'markdown', overwrite: true })
  assert.match(workspace.read('.dsh/deidentify/notes/reports/d0001.md'), /De-identification scan/)
  result = await deid({ action: 'report', slug: 'notes', format: 'json', overwrite: true })
  const reportJson = JSON.parse(workspace.read('.dsh/deidentify/notes/reports/d0001.json'))
  assert.equal(reportJson.scan.scan_id, 'd0001')
  assert.ok(!JSON.stringify(reportJson).includes('ada@example.org'))

  // CSV: detect columns, drop email, hash name, mask the note.
  workspace.write('notes/table.csv', [
    'name,email,note',
    'Ada Lovelace,ada@example.org,Follow up 2024-01-05',
    'Grace Hopper,grace@example.org,She is 94 years old',
    '',
  ].join('\n'))
  result = await deid({ action: 'scan', slug: 'table', file: 'notes/table.csv', names: ['Ada Lovelace', 'Grace Hopper'] })
  assert.ok(result.scan.columns.some((column) => column.name === 'email' && column.matches >= 2))
  assert.ok(result.scan.columns.some((column) => column.name === 'name' && column.matches >= 2))
  result = await deid({
    action: 'redact', slug: 'table', file: 'notes/table.csv', out: 'notes/table.redacted.csv',
    names: ['Ada Lovelace', 'Grace Hopper'],
    policy: { columns: { email: 'drop', name: 'hash', note: 'mask' } }, overwrite: true,
  })
  assert.equal(result.redaction.residual.match_count, 0)
  const table = workspace.read('notes/table.redacted.csv')
  assert.match(table, /"name"/)
  assert.ok(!table.includes('email'))
  assert.ok(!table.includes('ada@example.org'))
  assert.ok(!table.includes('Ada Lovelace'))
  assert.ok(!table.includes('2024-01-05'))

  // JSON stays valid when values are strings and types are replaced.
  workspace.write('notes/data.json', JSON.stringify({ email: 'ada@example.org', date: '2024-01-05', note: 'ok' }))
  result = await deid({ action: 'scan', slug: 'json', file: 'notes/data.json' })
  assert.ok(result.scan.by_type.email)
  result = await deid({ action: 'redact', slug: 'json', file: 'notes/data.json', out: 'notes/data.redacted.json', policy: { types: { email: 'type', date: 'type' } }, overwrite: true })
  assert.equal(result.redaction.residual.match_count, 0)
  const json = JSON.parse(workspace.read('notes/data.redacted.json'))
  assert.equal(json.email, '[EMAIL]')
  assert.equal(json.date, '[DATE]')

  // A file with more matches than the report cap is refused for redaction, never
  // partially redacted.
  workspace.write('notes/many.txt', Array.from({ length: 1001 }, (_value, index) => `user${index}@example.org`).join('\n'))
  result = await deid({ action: 'scan', slug: 'many', file: 'notes/many.txt' })
  assert.equal(result.scan.truncated, true)
  result = await deid({ action: 'redact', slug: 'many', file: 'notes/many.txt', out: 'notes/many.redacted.txt' })
  assert.match(result.error, /too many candidate matches/)
  assert.ok(!existsSync(workspace.path('notes/many.redacted.txt')))

  result = await deid({ action: 'status', slug: 'notes' })
  assert.equal(result.status.scans.length, 1)
  assert.equal(result.status.redactions.length, 2)

  console.log('ethics_protocol and deidentify OK')
} finally {
  workspace.cleanup()
}
