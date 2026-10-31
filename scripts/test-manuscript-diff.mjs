import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import AdmZip from 'adm-zip'
import { apply, parseUnifiedDiff, runManuscriptDiff } from '../manuscript-diff.js'
import { compileLatex } from '../latex-compile.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-manuscript-diff-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const sha = (rel) => createHash('sha256').update(readFileSync(join(cwd, rel))).digest('hex')

try {
  workspace.write('paper/old.md', '# Title\n\nWe had 10 participants.\n\nThe effect was small.\n')
  workspace.write('paper/new.md', '# Title\n\nWe had 12 participants.\n\nThe effect was small and consistent.\n')
  const oldHash = sha('paper/old.md')
  const newHash = sha('paper/new.md')

  let result = await run({ action: 'diff', slug: 'revision', old: 'paper/old.md', new: 'paper/new.md', compile: false })
  assert.equal(result.error, undefined, result.error)
  assert.match(result.out, /diff\.md$/)
  const diffBody = workspace.read(result.out)
  assert.match(diffBody, /^---/m)
  assert.match(diffBody, /-We had 10 participants\./)
  assert.match(diffBody, /\+We had 12 participants\./)
  assert.equal(sha('paper/old.md'), oldHash)
  assert.equal(sha('paper/new.md'), newHash)

  result = await run({ action: 'changes', slug: 'revision' })
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0].id, 'ch-001')
  assert.equal(result.changes[0].kind, 'modify')
  assert.match(workspace.read(result.markdown_path), /ch-001/)

  result = await run({ action: 'letter', slug: 'revision', items: [
    { id: 'R1.1', text: 'Increase the sample size.', response: 'We added two participants.', change_ids: ['ch-001'], status: 'addressed' },
    { id: 'R1.2', text: 'Discuss the effect.', response: 'Done.', change_ids: ['ch-999'] },
    { id: 'R1.3', text: 'Clarify the design.', response: 'We believe it is clear.', status: 'addressed' },
  ] })
  const letter = workspace.read(result.out)
  assert.match(letter, /R1\.1/)
  assert.match(letter, /We added two participants/)
  assert.match(letter, /ch-001/)
  const r11 = letter.split('## R1.2')[0]
  assert.doesNotMatch(r11, /WARNING: this item is marked responded/)
  assert.match(letter, /UNRESOLVED: change `ch-999`/)
  assert.deepEqual(result.unresolved.sort(), ['R1.2', 'R1.3'])
  assert.match(letter, /WARNING: this item is marked responded/)

  result = await run({ action: 'letter', slug: 'revision', format: 'latex', items: [
    { id: 'R1.1', text: 'Increase N.', response: 'Added.', change_ids: ['ch-001'] },
  ], out: '.dsh/manuscript-diff/revision/letter.tex', overwrite: true })
  const tex = workspace.read('.dsh/manuscript-diff/revision/letter.tex')
  assert.match(tex, /\\section\*\{Response to reviewers/)
  assert.match(tex, /\\begin\{verbatim\}/)

  result = await run({ action: 'diff', slug: 'escape', old: '../outside.md', new: 'paper/new.md' })
  assert.match(result.error, /escapes the workspace/)

  // A DOCX fixture with a tracked insertion, deletion, comment, and Zotero field.
  const zip = new AdmZip()
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>We recruited </w:t></w:r><w:ins w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:t>twelve</w:t></w:r></w:ins><w:del w:id="2" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>ten</w:delText></w:r></w:del><w:r><w:t> participants.</w:t></w:r></w:p><w:p><w:r><w:instrText> ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"abc"} </w:instrText></w:r></w:p></w:body></w:document>`))
  zip.addFile('word/comments.xml', Buffer.from(`<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Reviewer" w:date="2026-01-02T00:00:00Z"><w:p><w:r><w:t>Clarify the sample.</w:t></w:r></w:p></w:comment></w:comments>`))
  zip.writeZip(workspace.path('paper/revised.docx'))
  result = await run({ action: 'docx', slug: 'revision', path: 'paper/revised.docx' })
  assert.equal(result.tracked_changes.length, 2)
  assert.deepEqual(result.tracked_changes.map((change) => change.kind).sort(), ['deletion', 'insertion'])
  assert.equal(result.comments[0].text, 'Clarify the sample.')
  assert.equal(result.zotero_fields.length, 1)
  assert.match(result.zotero_fields[0], /ZOTERO_ITEM/)
  assert.match(result.notes.join(' '), /preserved/)

  // .tex diffs use latexdiff when it is installed and report not_installed otherwise.
  workspace.write('paper/old.tex', '\\documentclass{article}\n\\begin{document}\nTen.\n\\end{document}\n')
  workspace.write('paper/new.tex', '\\documentclass{article}\n\\begin{document}\nTwelve.\n\\end{document}\n')
  const hasLatexdiff = spawnSync('latexdiff', ['--version'], { encoding: 'utf8' }).error == null
  result = await run({ action: 'diff', slug: 'latex-revision', old: 'paper/old.tex', new: 'paper/new.tex', compile: false })
  if (hasLatexdiff) {
    assert.equal(result.not_installed, undefined)
    assert.match(workspace.read(result.out), /DIFdel|DIFadd|\\DIF/)
  } else {
    assert.equal(result.not_installed, true)
    assert.match(result.error, /latexdiff/)
  }

  const parsed = parseUnifiedDiff('@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+extra\n')
  assert.equal(parsed.length, 1)
  assert.deepEqual(parsed[0].removed, ['old'])
  assert.deepEqual(parsed[0].added, ['new', 'extra'])
  const markdownRules = parseUnifiedDiff('@@ -1,1 +1,1 @@\n---- old rule\n++++ new rule\n')
  assert.deepEqual(markdownRules[0].removed, ['--- old rule'])
  assert.deepEqual(markdownRules[0].added, ['+++ new rule'])

  workspace.write('paper/v1.md', 'One.\n')
  workspace.write('paper/v2.md', 'Two.\n')
  await run({ action: 'diff', slug: 'rebind', old: 'paper/v1.md', new: 'paper/v2.md', compile: false })
  await run({ action: 'changes', slug: 'rebind' })
  workspace.write('paper/v3.md', 'Three.\n')
  result = await run({ action: 'changes', slug: 'rebind', old: 'paper/v1.md', new: 'paper/v3.md' })
  assert.match(result.error, /different version pair/)
  result = await run({ action: 'changes', slug: 'rebind', old: 'paper/v1.md', new: 'paper/v3.md', overwrite: true })
  assert.equal(result.error, undefined, result.error)

  const hasTex = spawnSync('latexmk', ['-v'], { encoding: 'utf8' }).error == null
    || spawnSync('pdflatex', ['--version'], { encoding: 'utf8' }).error == null
  if (hasTex) {
    workspace.write('paper/bad.tex', '\\documentclass{article}\n\\begin{document}\n\\undefinedmacro\n\\end{document}\n')
    workspace.write('paper/bad.pdf', 'stale pdf')
    const compiled = await compileLatex(cwd, 'paper/bad.tex', 'pdflatex')
    assert.equal(compiled.success, false)
    assert.match(compiled.error, /older PDF|compile failed/i)
  }

  await assert.rejects(
    () => runManuscriptDiff({ action: 'diff', slug: 'bad-pair', old: 'paper/old.md', new: 'paper/revised.docx' }, exec),
    /two \.tex files|two \.md/,
  )

  console.log('manuscript_diff OK')
} finally {
  workspace.cleanup()
}
