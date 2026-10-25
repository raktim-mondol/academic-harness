import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

const {
  blocks,
  firstSentence,
  foldReply,
  foldStats,
  normalizeLevel,
  words,
  worthFolding,
} = await import('../fold-core.js')
const { MAX_CHARS, applyFoldText, foldText } = await import('../fold-text.js')

let passed = 0
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`)
  passed += 1
}

const REPLY = [
  'The bug was in the cache key, and it is fixed. Two requests for the same paper shared one key.',
  '',
  '## What changed',
  'The key now includes the language. That makes each translation its own entry. Old entries stay valid.',
  '',
  '- Updated `store.key()` to take a language. It falls back to English.',
  '- Added a test for two languages.',
  '',
  '```python',
  'def key(pid, lang="en"):',
  '    return f"{pid}:{lang}"',
  '```',
  '',
  '## What to check',
  'Run the tests once. They take about a minute, e.g. on a laptop.',
].join('\n')

const LONG = `${REPLY}

## Why it matters
The cache is shared by every reader of the paper. A collision therefore changes what two different readers see. The fix keeps the entries separate and leaves old entries readable.

The migration is deliberately lazy. An old entry is rewritten the next time it is opened, so the first read after the upgrade may be slower. No reader loses a note or a highlight.

We also added a regression test. It opens the same paper in two languages, checks that each language keeps its own key, and checks that a third language does not reuse either entry.`

// ── levels and sentences ──────────────────────────────────────────────────

ok('level names', normalizeLevel('brief') === 'brief' && normalizeLevel('4') === 'outline' && normalizeLevel(5) === 'gist')
assert.throws(() => normalizeLevel('medium'), /unknown fold level/)
ok('first sentence', firstSentence('It works. Then more.').head === 'It works.')
ok('abbreviation is not a stop', firstSentence('Use e.g. this one. Next.').head === 'Use e.g. this one.')
ok('inline code is not cut', firstSentence('Call `a.b()` first. Then go.').head === 'Call `a.b()` first.')
ok('version number is not a stop', firstSentence('Version 3.5 is out. Upgrade.').head === 'Version 3.5 is out.')
ok('bold span is balanced', firstSentence('**It is fixed.** The rest.').head === '**It is fixed.**')
ok('single sentence', firstSentence('One sentence only').more === false)
ok('CJK stop', firstSentence('缓存键有问题，已经修好。同一篇论文的两次请求共用了一个键。').head === '缓存键有问题，已经修好。')

// ── blocks ────────────────────────────────────────────────────────────────

ok('reply blocks', JSON.stringify(blocks(REPLY).map((b) => b.kind)) === JSON.stringify(['para', 'heading', 'para', 'list', 'code', 'heading', 'para']))
{
  const table = 'The options compare like this.\n| Option | Cost |\n| --- | --- |\n| A | free |\n| B | 5/mo |'
  ok('table after paragraph is its own block', JSON.stringify(blocks(table).map((b) => b.kind)) === JSON.stringify(['para', 'table']))
}
{
  const bare = 'Option | Cost\n:-- | --:\nA | free\nB | 5/mo'
  ok('table without leading pipes', JSON.stringify(blocks(bare).map((b) => b.kind)) === JSON.stringify(['table']))
  ok('setext-looking rule stays a paragraph', JSON.stringify(blocks('A heading\n---').map((b) => b.kind)) === JSON.stringify(['para']))
}
{
  const drawing = ['`┌────┐`  ', '`│ Pi │`  '].join('\n')
  ok('no Pi art block', blocks(drawing).every((b) => b.kind !== 'art'))
}

// ── fold levels ───────────────────────────────────────────────────────────

ok('full is exact', foldReply(REPLY, 'full').text === REPLY)
{
  const brief = foldReply(REPLY, 'brief').text
  ok('brief keeps two sentences', brief.includes('The key now includes the language. That makes each translation its own entry. …'))
  ok('brief drops the third sentence', !brief.includes('Old entries stay valid.'))
  ok('brief keeps short code', brief.includes('def key(pid, lang="en"):'))
}
{
  const points = foldReply(REPLY, 'points').text
  ok('points keeps one sentence', points.includes('The bug was in the cache key, and it is fixed. …'))
  ok('points keeps one item sentence', points.includes('- Updated `store.key()` to take a language. …'))
  ok('points keeps short code', points.includes('def key(pid, lang="en"):'))
}
{
  const outline = foldReply(REPLY, 'outline').text
  const expected = 'The bug was in the cache key, and it is fixed. …\n\n## What changed\n\nThe key now includes the language. …\n\n## What to check\n\nRun the tests once. …'
  ok('outline exact', outline === expected, JSON.stringify(outline))
}
ok('gist is the first sentence', foldReply(REPLY, 'gist').text === 'The bug was in the cache key, and it is fixed. …')
{
  const unheaded = [
    'The first paragraph states its point. It adds a detail or two.',
    'The second paragraph has a point of its own. It also explains it.',
    'The third paragraph closes the reply. Nothing else follows it.',
  ].join('\n\n')
  ok('outline without headings is points', foldReply(unheaded, 'outline').level === 'points')
  ok('outline without headings matches points', foldReply(unheaded, 'outline').text === foldReply(unheaded, 'points').text)
  ok('outline still shows the second paragraph', foldReply(unheaded, 'outline').text.includes('The second paragraph has a point of its own. …'))
  ok('gist of unheaded reply', foldReply(unheaded, 'gist').text === 'The first paragraph states its point. …')
}
{
  const table = ['| Option | Cost |', '| --- | --- |', ...Array.from({ length: 10 }, (_, i) => `| ${i} | ${i}/mo |`)].join('\n')
  const md = `The options compare like this. The cheapest is not the best.\n\n${table}\n\nPick the second one. It is the best value.`
  ok('table kept at brief', foldReply(md, 'brief').text.includes(table))
  ok('table kept at points', foldReply(md, 'points').text.includes(table))
  ok('table dropped at gist', !foldReply(md, 'gist').text.includes('| Option'))
  const folded = foldReply(md, 'points').blocks.find((b) => b.kind === 'table')
  ok('table rows are structured', JSON.stringify(folded.rows[0]) === JSON.stringify(['Option', 'Cost']))
}
{
  const code = ['```sh', ...Array.from({ length: 10 }, (_, i) => `echo ${i}`), '```'].join('\n')
  const long = `Run this to see it. It prints ten lines.\n\n${code}`
  ok('long code folds at brief', foldReply(long, 'brief').text.includes('`⋯ 10 lines of code`'))
  ok('long code folds at points', foldReply(long, 'points').text.includes('`⋯ 10 lines of code`'))
  ok('long code dropped at outline', !foldReply(long, 'outline').text.includes('echo 9'))
}
{
  const list = foldReply('- One. Two.\n- Three. Four.', 'points').blocks[0]
  ok('list block is ordered metadata', list.kind === 'list' && list.items.length === 2)
  ok('list item is one sentence', list.items[0].text === 'One.' && list.items[0].more === true)
}

// ── gate and stats ────────────────────────────────────────────────────────

ok('short reply is not worth folding', !worthFolding(REPLY, foldReply(REPLY, 'gist').text))
{
  const long = Array.from({ length: 12 }, (_, i) => `Sentence ${i} has a few words in it.`).join(' ')
  ok('long reply is worth folding', worthFolding(long, foldReply(long, 'points').text))
  ok('a small reduction is not worth folding', !worthFolding(long, long.slice(0, Math.round(long.length * 0.8))))
}
ok('CJK reading effort', worthFolding('缓'.repeat(140), '缓') && !worthFolding('缓'.repeat(120), '缓'))
ok('word count', words('缓存键 cache key') === 5)
{
  const stats = foldStats(REPLY, foldReply(REPLY, 'points').text)
  ok('stats counts', stats.words_before === 74 && stats.words_after > 0 && stats.words_after < stats.words_before)
  ok('stats ratio', stats.hidden_ratio > 0.4 && stats.hidden_ratio <= 1)
}

// ── tool ──────────────────────────────────────────────────────────────────

let tool
applyFoldText({ tools: { register(registered) { tool = registered } } })
ok('tool name', tool.name === 'fold_text')
ok('required text', JSON.stringify(tool.parameters.required) === JSON.stringify(['text']))
ok('tool description', /no model call/i.test(tool.description) && tool.description.includes('deletes'))
ok('present call', tool.presentCall({ text: REPLY, level: 'gist' }).title === 'Fold text → Gist')
ok('invalid args get no card', tool.presentCall({ level: 'gist' }) === undefined)

const ws = mkdtempSync(join(tmpdir(), 'ah-fold-'))
const outside = mkdtempSync(join(tmpdir(), 'ah-fold-outside-'))
const exec = { agent: { session: { header: { cwd: ws } } } }

try {
  const points = await tool.execute({ text: LONG, level: 'points' }, exec)
  ok('tool folds', points.ok === true && points.folded === true && points.level === 'points')
  ok('tool returns text', points.text.includes('The bug was in the cache key, and it is fixed. …'))
  ok('long text passes the gate', worthFolding(LONG, foldReply(LONG, 'points').text))

  const defaulted = await tool.execute({ text: LONG }, exec)
  ok('default level is brief', defaulted.ok === true && defaulted.level === 'brief')
  ok('default format is markdown', !tool.output.render({}, defaulted)[0].text.trim().startsWith('{'))

  const short = await tool.execute({ text: 'Done, the tests pass.', level: 'gist' }, exec)
  ok('short text unchanged', short.ok === true && short.folded === false && short.text === 'Done, the tests pass.')
  ok('short reason', short.reason === 'too-short-or-little-hidden')

  const full = await tool.execute({ text: LONG, level: 'full' }, exec)
  ok('full unchanged', full.text === LONG && full.folded === false && full.reason === 'full')

  const json = await tool.execute({ text: LONG, level: 'points', format: 'json' }, exec)
  const rendered = JSON.parse(tool.output.render({ format: 'json' }, json)[0].text)
  ok('json render', rendered.ok === true && rendered.stats.words_before > 80 && Array.isArray(rendered.blocks))

  const written = await tool.execute({ text: LONG, level: 'brief', write_to: 'notes/fold.md' }, exec)
  ok('write_to', written.ok === true && written.write_to === 'notes/fold.md' && !('text' in written))
  ok('write_to content', readFileSync(join(ws, 'notes/fold.md'), 'utf8').includes('The key now includes the language.'))
  ok('write render', /folded to brief: notes\/fold\.md/.test(tool.output.render({}, written)[0].text))

  const blocked = await tool.execute({ text: LONG, level: 'brief', write_to: '../escape.md' }, exec)
  ok('path escape blocked', blocked.ok === false && blocked.error_code === 'path-escapes-workspace')
  ok('no escaped file', !existsSync(join(ws, '..', 'escape.md')))

  if (process.platform !== 'win32') {
    symlinkSync(outside, join(ws, 'link'))
    const linked = await tool.execute({ text: LONG, level: 'brief', write_to: 'link/escape.md' }, exec)
    ok('symlink escape blocked', linked.ok === false && linked.error_code === 'path-escapes-workspace')
    ok('no linked file', !existsSync(join(outside, 'escape.md')))
    const nested = await tool.execute({ text: LONG, level: 'brief', write_to: 'link/sub/escape.md' }, exec)
    ok('nested symlink escape blocked', nested.ok === false && nested.error_code === 'path-escapes-workspace')
    ok('no outside directory created', !existsSync(join(outside, 'sub')))
  }

  ok('empty text', (await tool.execute({ text: '   ' }, exec)).error_code === 'empty')
  ok('too large', (await tool.execute({ text: 'x'.repeat(MAX_CHARS + 1) }, exec)).error_code === 'too-large')
  ok('bad level', foldText({ text: LONG, level: 'medium' }, ws).error_code === 'bad-level')
  ok('bad format', foldText({ text: LONG, format: 'html' }, ws).error_code === 'bad-format')
  await assert.rejects(() => tool.execute({ text: LONG, level: 'medium' }, exec), /level/)

  const direct = foldText({ text: LONG, level: 'points' }, ws)
  ok('direct foldText', direct.ok === true && direct.folded === true)
} finally {
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}

// ── wiring and docs ───────────────────────────────────────────────────────

ok('host registration', /applyFoldText\(ctx\)/.test(read('index.js')))
ok('package files', pkg.files.includes('fold-core.js') && pkg.files.includes('fold-text.js'))
ok('host tool is not a public export', pkg.exports?.['./fold-text'] === undefined)
ok('test script', pkg.scripts?.['test:fold'] === 'node scripts/test-fold.mjs')
ok('prompt shape text', read('prompt.js').includes('RESPONSE_SHAPE') && read('prompt.js').includes('Open with the answer or decision'))
ok('prompt shape section', read('prompt-section.js').includes("name: 'academic-harness-response-shape'") && read('prompt-section.js').includes('order: 21'))
{
  const { apply: applyPromptSection } = await import('../prompt-section.js')
  const sections = []
  applyPromptSection({ systemPrompt: { section(section) { sections.push(section) } } })
  ok('two prompt sections', sections.length === 2)
  ok('shape is scoped as its own section', sections[1]?.name === 'academic-harness-response-shape' && sections[1]?.order === 21)
  ok('shape section text', sections[1]?.text.includes('Open with the answer or decision'))
}
ok('README section', read('README.md').includes('## Reply folding') && read('README.md').includes('fold_text'))
ok('NOTICE attribution', read('NOTICE').includes('plugins/textfold/hooks/fold.ts') && read('NOTICE').includes('Apache License 2.0'))
ok('CI test', read('.github/workflows/verify.yml').includes('test-fold.mjs'))

console.log(`fold tests OK: ${passed} checks`)
