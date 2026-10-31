import assert from 'node:assert/strict'
import { symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import AdmZip from 'adm-zip'
import { apply, runNumbersAudit } from '../numbers-audit.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-numbers-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const hasScipy = spawnSync('python3', ['-c', 'import scipy'], { encoding: 'utf8' }).status === 0

try {
  workspace.write('paper/main.md', `# Abstract

The trial randomized N = 120 participants and analyzed n = 118.

# Methods

We enrolled N = 95 participants. The mean age was 45.2 years (SD 12.1).

# Results

The treatment increased response (45/100 (55%)), OR = 2.5, 95% CI 3.0 to 1.0.
The test was significant, t(28) = 2.05, p = .20. A second test reported p = 1.4.
We found p = 0.000.

| Treatment response | 45 |
|---|---|
| Control response | 30 |

The Treatment response rate was 40 in the text.
`)

  let result = await run({ path: 'paper/main.md' })
  assert.equal(result.error, undefined, result.error)
  assert.equal(result.mode, 'numbers')
  assert.ok(result.summary.flagged >= 4)
  const kinds = new Set(result.rows.map((row) => row.kind))
  assert.ok(kinds.has('n_inconsistent'), JSON.stringify(result.rows))
  assert.ok(kinds.has('percentage'))
  assert.ok(kinds.has('effect_ci'))
  assert.ok(result.rows.some((row) => /reversed/.test(row.detail)))
  assert.ok(result.rows.some((row) => /outside \[0, 1\]/.test(row.detail)))
  assert.ok(result.rows.some((row) => /p = 0/.test(row.detail)))
  assert.ok(result.rows.some((row) => row.kind === 'table_text'))
  assert.ok(result.not_checked.some((item) => /unit consistency/.test(item)))
  if (hasScipy) {
    assert.ok(result.rows.some((row) => /incompatible_statistic_and_p/.test(row.detail)))
  }

  result = await run({ text: 'Methods\n\nN = 10.\n\nResults\n\nN = 12.\np = 0.5 (95% CI 0.2 to 0.4).\n' })
  assert.equal(result.error, undefined, result.error)
  assert.ok(result.rows.some((row) => row.kind === 'n_inconsistent'))

  result = await run({ path: 'paper/missing.md' })
  assert.match(result.error, /file not found/)
  result = await run({ path: '../outside.md' })
  assert.match(result.error, /escapes the workspace/)
  result = await run({ path: 'paper/main.pdf' })
  assert.match(result.error, /file not found/)
  result = await run({ path: 'paper/main.md', text: 'N = 1' })
  assert.match(result.error, /not both/)

  workspace.write('paper/commented.tex', '% old value N = 250\nLive value N = 120.\n')
  result = await run({ path: 'paper/commented.tex' })
  assert.equal(result.error, undefined, result.error)
  assert.ok(!result.rows.some((row) => row.kind === 'n_inconsistent'), 'LaTeX comments must not be audited as live text')

  symlinkSync('/etc/hostname', workspace.path('paper/outside.md'))
  result = await run({ path: 'paper/outside.md' })
  assert.match(result.error, /escapes the workspace/)

  // DOCX text is read through the shared document_text helper.
  const zip = new AdmZip()
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>N = 50 participants.</w:t></w:r></w:p><w:p><w:r><w:t>N = 60 participants.</w:t></w:r></w:p></w:body></w:document>`))
  zip.writeZip(workspace.path('paper/main.docx'))
  result = await run({ path: 'paper/main.docx' })
  assert.equal(result.error, undefined, result.error)
  assert.ok(result.rows.some((row) => row.kind === 'n_inconsistent'))

  const direct = await runNumbersAudit({ text: 'p = 2.0' }, exec)
  assert.ok(direct.rows.some((row) => /outside \[0, 1\]/.test(row.detail)))

  console.log('numbers_audit OK')
} finally {
  workspace.cleanup()
}
