/**
 * Promote-to-rule, across the two languages: a stored deep_review round is read by the plugin (rebuttal-store) and
 * triaged by the real engine; a rule is proposed, accepted by the author and then found on every run.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deepReviewComments, toolArgv } from '../academic-harness.js'
import { EXPLORATORY_NOTE } from '../deep-review.js'
import { makeWorkspace } from './helpers/test-workspace.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = resolve(HERE, '..', 'vendor', 'academic-harness')
const sha1 = (v) => createHash('sha1').update(v).digest('hex')

assert.match(EXPLORATORY_NOTE, /Exploratory, never gating/)
assert.match(readFileSync(resolve(HERE, '..', 'deep-review.js'), 'utf8'), /lines\.push\(EXPLORATORY_NOTE\)/, 'the summary carries the label')

const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' })
if (probe.status !== 0) {
  console.warn('SKIP promote contract (python3 with pyyaml not available)')
} else {
  const ah = (...args) => spawnSync('python3', ['-c', 'import sys; from ah.cli import main; sys.exit(main(sys.argv[1:]))', ...args], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: ENGINE }, timeout: 120_000,
  })
  const ws = makeWorkspace('ah-promote-')
  try {
    const root = ws.path('paper')
    assert.equal(ah('init', '--profile', 'paper/conference', root).status, 0)
    const SPAN = 'We evaluate on 1240 documents drawn from three corpora and report the results in a later section of the paper.'
    writeFileSync(join(root, 'src/sections/01_introduction/index.tex'),
      `\\section{Introduction}\n\nOur method proves that adaptive retrieval improves recall on every benchmark we tried, as shown above.\n\n${SPAN}\n`)
    assert.equal(ah('units', '--project', root, 'sync').status, 0)

    // a stored deep_review round (digest only), laid out the way deep-review.js stores it
    const key = sha1('paper/main.tex').slice(0, 16)
    ws.write('paper/main.tex', '% x\n')
    const dir = join(ws.path('.'), '.dsh/deep-review', key)
    mkdirSync(join(dir, 'rounds'), { recursive: true })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({
      schemaVersion: 2, key, latest_round: 1, input: { path: 'paper/main.tex', file_name: 'main.tex', sha1: sha1('% x\n'), format: 'tex' },
      rounds: [{ round: 1, run_id: 'rev-0001', input_sha1: sha1('% x\n'), model: 'm', evaluator_kind: 'held_out' }],
    }))
    writeFileSync(join(dir, 'rounds/rev-0001.json'), JSON.stringify({
      run_id: 'rev-0001', counts: { comments: 3, questions: 1 },
      comments: [
        { comment_id: 'c-1', severity: 'MAJOR', summary: 'It says the results come in a later section, which does not help the reader.', quote: 'report the results in a later section of the paper', keys: [] },
        { comment_id: 'c-2', severity: 'MINOR', summary: 'The abstract is hard to read.', quote: '', keys: [] },
        { comment_id: 'section-1', severity: 'MAJOR', summary: 'Narrative.', keys: [] },
      ],
      questions: [{ number: 1, question: 'Why?', keys: [] }], claims: [], checklist: [],
    }))

    const comments = await deepReviewComments(ws.path('.'), key)
    assert.deepEqual(comments.map((c) => c.id.split(':').pop()), ['c-1', 'c-2'], 'comments only: no section narrative, no questions')

    // nothing covers it yet
    const text = (cs) => ah('triage', '--project', root, '--data', JSON.stringify(cs)).stdout
    assert.match(text(comments), /c-1\s+same-unit|c-1\s+exploratory/, 'before the rule exists, c-1 is not covered')
    assert.doesNotMatch(text(comments), /covered-by/)

    // propose: a pattern checked against the sentence it came from
    const spec = { kind: 'pattern', id: 'PRM-LATER', pattern: '\\ba later section\\b', message: 'say which section', why: 'fixed wording',
      comment: comments[0].text, span: SPAN, source: `deep_review:${comments[0].id}` }
    const proposed = ah('rule', 'propose', '--project', root, '--data', JSON.stringify(spec))
    assert.equal(proposed.status, 0, proposed.stderr)
    assert.match(proposed.stdout, /fires on 1 unit/)
    assert.equal(ah('check', '--project', root, '--json').stdout.includes('PRM-01'), false, 'a proposal checks nothing')
    // an agent cannot accept: no terminal and no --yes means no
    assert.notEqual(ah('rule', 'accept', 'PRM-LATER', '--project', root).status, 0)
    const accepted = ah('rule', 'accept', 'PRM-LATER', '--project', root, '--yes')
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.ok(existsSync(join(root, 'rules/promoted.yaml')))

    // now the checks find it, and the same review comment is recognised as covered
    const rep = JSON.parse(ah('check', '--project', root, '--json').stdout)
    const hit = rep.findings.filter((f) => f.check === 'PRM-01')
    assert.equal(hit.length, 1)
    assert.match(hit[0].message, /a later section/)
    assert.match(text(comments), /c-1\s+covered-by:PRM-01/)
    assert.match(text(comments), /c-2\s+exploratory/)

    // the argv the tool builds is what the engine takes
    const viaTool = toolArgv('ah_triage', { comments })
    assert.equal(ah(...[viaTool[0], '--project', root, ...viaTool.slice(1)]).status, 0)
  } finally { ws.cleanup() }
}
console.log('promote: ok')

// Live: given the choice, the model imported the report with ah_review, which drops each comment's quote, so triage could not find 13 of 15 passages.
assert.match(EXPLORATORY_NOTE, /ah_triage source=deep_review/)
assert.match(readFileSync(resolve(HERE, '..', 'deep-review.js'), 'utf8'), /ah_triage source=deep_review deep_review_key=\$\{key\}/, 'a finished review names the exact triage call')
console.log('deep_review points at the triage call that keeps quotes OK')
