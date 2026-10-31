import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { apply, runPresentationAction } from '../presentation-build.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-presentation-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const hasPptx = spawnSync('python3', ['-c', 'import pptx'], { encoding: 'utf8' }).status === 0

try {
  workspace.write('figures/result.png', 'not-really-a-png-but-copyable')
  workspace.write('talk.md', '# A Talk\n\n## Introduction\n\n- First point\n- Second point\n\n## Results\n\n- Main result\n')

  let result = await run({
    action: 'slides', slug: 'talk', manuscript: 'talk.md', compile: false,
    sections: [
      { heading: 'Introduction', bullets: ['Widgets matter', 'Prior work is thin'], figures: ['figures/result.png'], notes: 'Keep this short.' },
      { heading: 'Results', bullets: ['Effect was small'] },
    ],
  })
  assert.equal(result.error, undefined, result.error)
  assert.match(result.source, /slides\.tex$/)
  const slides = workspace.read(result.source)
  assert.match(slides, /\\documentclass\[aspectratio=169,11pt\]\{beamer\}/)
  assert.match(slides, /Widgets matter/)
  assert.match(slides, /figures\/result\.png/)
  assert.ok(existsSync(workspace.path(`.dsh/presentation/talk/builds/${result.build_id}/figures/result.png`)))
  assert.equal(result.missing_figures.length, 0)
  const buildId = result.build_id

  result = await run({ action: 'status', slug: 'talk' })
  assert.equal(result.builds.length, 1)
  assert.equal(result.builds[0].build_id, buildId)
  result = await run({ action: 'qa', slug: 'talk' })
  assert.match(result.markdown, /subagent_vision/)
  assert.match(result.markdown, /does not claim the visual check passed/)
  assert.match(result.markdown, /Text overflow/)
  assert.ok(existsSync(workspace.path(result.qa_path)))

  result = await run({ action: 'poster', slug: 'poster', manuscript: 'talk.md', template: 'tikzposter', compile: false })
  assert.equal(result.error, undefined, result.error)
  assert.match(workspace.read(result.source), /\\documentclass\[.*\]\{tikzposter\}/)
  assert.match(workspace.read(result.source), /\\block\{Introduction\}/)

  result = await run({
    action: 'slides', slug: 'missing-figure', compile: false,
    sections: [{ heading: 'One', bullets: ['A'], figures: ['figures/nope.png'] }],
  })
  assert.deepEqual(result.missing_figures, ['figures/nope.png'])
  assert.match(result.warnings.join(' '), /figure not found/)

  result = await run({ action: 'slides', slug: 'pptx', engine: 'pptx', sections: [{ heading: 'One', bullets: ['A'] }] })
  if (hasPptx) {
    assert.equal(result.artifact.kind, 'pptx')
    assert.ok(existsSync(workspace.path(result.artifact.path)))
  } else {
    assert.equal(result.not_installed, true)
    assert.match(result.error, /python-pptx/)
  }

  result = await run({ action: 'slides', slug: 'escape', manuscript: '../outside.md' })
  assert.match(result.error, /escapes the workspace/)
  result = await run({ action: 'slides', slug: 'empty' })
  assert.match(result.error, /give manuscript or sections/)
  result = await run({ action: 'qa', slug: 'no-build' })
  assert.match(result.error, /no build/)
  result = await run({ action: 'qa', slug: 'talk', build_id: '../../escape' })
  assert.match(result.error, /invalid build_id/)

  workspace.write('unsafe.tex', '\\title{Unsafe}\n\\section{One}\n\\begin{itemize}\n\\item \\input{/etc/passwd}\n\\item Visible point\n\\end{itemize}\n')
  result = await run({ action: 'slides', slug: 'unsafe', manuscript: 'unsafe.tex', compile: false })
  assert.equal(result.error, undefined, result.error)
  const unsafeSource = workspace.read(result.source)
  assert.doesNotMatch(unsafeSource, /\\input\{/)
  assert.doesNotMatch(unsafeSource, /\\write18/)
  assert.match(unsafeSource, /Visible point/)

  const direct = await runPresentationAction({ action: 'slides', slug: 'direct', sections: [{ heading: 'One', bullets: ['A'] }], compile: false }, exec)
  assert.equal(direct.artifact.kind, 'tex')

  console.log('presentation_build OK')
} finally {
  workspace.cleanup()
}
