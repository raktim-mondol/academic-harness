import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

const {
  FOLD_LEVELS,
  FOLD_TAB_ID,
  FoldContent,
  ReplyFoldView,
  closingAssistantText,
  readFoldLevel,
  writeFoldLevel,
} = await import('../client/reply-fold.js')
const { FoldPane } = await import('../client/FoldPane.js')

let passed = 0
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`)
  passed += 1
}

const LONG = [
  'The answer is the cache key, and it is fixed. Two requests for the same paper shared one key.',
  '',
  '## What changed',
  'The key now includes the language. That makes each translation its own entry. Old entries stay valid.',
  '',
  '- Updated `store.key()` to take a language. It falls back to English.',
  '- Added a test for two languages.',
  '',
  '| Option | Cost |',
  '| --- | --- |',
  '| A | free |',
  '| B | 5/mo |',
  '',
  '```python',
  'def key(pid, lang="en"):',
  '    return f"{pid}:{lang}"',
  '```',
  '',
  '## What to check',
  'Run the tests once. They take about a minute, e.g. on a laptop. The cache is shared by every reader of the paper, so a collision changes what two readers see.',
  '',
  'The migration is lazy. An old entry is rewritten when it is opened. No reader loses a note or a highlight. A regression test opens the same paper in two languages and checks that each keeps its own key.',
].join('\n')

function render(text, level) {
  return renderToStaticMarkup(createElement(ReplyFoldView, { text, level, onSelect() {} }))
}

// ── selector ──────────────────────────────────────────────────────────────

{
  const snapshot = {
    locations: { getTurn: (turn) => (turn === 3 ? ['tail', 'reasoning', 'answer'] : []) },
    nodes: {
      get: (key) => ({
        tail: { kind: 'turn-tail' },
        reasoning: { kind: 'assistant-step', data: { blocks: [{ kind: 'reasoning', text: 'hidden reasoning' }] } },
        answer: { kind: 'assistant-step', data: { finalNode: { blocks: [{ kind: 'text', text: LONG }] } } },
      })[key],
    },
  }
  ok('selector finds the closing assistant text', closingAssistantText(snapshot, 3) === LONG)
  ok('selector ignores another turn', closingAssistantText(snapshot, 9) === '')
  ok('selector rejects a non-integer turn', closingAssistantText(snapshot, 'three') === '')
  ok('selector tolerates a missing snapshot', closingAssistantText(undefined, 3) === '')
}

// ── view ──────────────────────────────────────────────────────────────────

const full = render(LONG, 'full')
ok('full shows the row', full.includes('data-ah-fold-row') && full.includes('Read folded:'))
ok('full hides the panel', !full.includes('data-ah-fold-panel'))
ok('full has all five levels', FOLD_LEVELS.every((level) => full.includes(`>${level[0].toUpperCase()}${level.slice(1)}<`)))

const brief = render(LONG, 'brief')
ok('brief opens the panel', brief.includes('data-ah-fold-panel'))
ok('brief keeps two sentences', brief.includes('The key now includes the language. That makes each translation its own entry.'))
ok('brief drops the third sentence', !brief.includes('Old entries stay valid.'))
ok('brief renders a table', brief.includes('<table'))
ok('brief renders code', brief.includes('<pre'))
ok('brief footer', brief.includes('words'))

const points = render(LONG, 'points')
ok('points opens the panel', points.includes('data-ah-fold-panel'))
ok('points keeps one sentence', points.includes('The answer is the cache key, and it is fixed.'))
ok('points keeps the table and code', points.includes('<table') && points.includes('<pre'))
ok('points marks the selected button', points.includes('aria-pressed="true"'))
ok('points expands the panel', points.includes('aria-expanded="true"') && points.includes('aria-controls='))
ok('points uses theme variables', points.includes('var(--color-surface-secondary'))
ok('points keeps a list item', points.includes('Updated <code'))
{
  const nested = render(`${LONG}\n\nUse **\`store.key()\`** for the key. It is the same key.`, 'points')
  ok('nested inline code inside bold', nested.includes('<strong><code') && nested.includes('store.key()</code></strong>'))
}

const outline = render(LONG, 'outline')
ok('outline opens the panel', outline.includes('data-ah-fold-panel'))
ok('outline keeps headings', outline.includes('role="heading"') && outline.includes('What changed'))
ok('outline drops code and tables', !outline.includes('<table') && !outline.includes('<pre'))

const gist = render(LONG, 'gist')
ok('gist opens the panel', gist.includes('data-ah-fold-panel'))
ok('gist is the first sentence', gist.includes('The answer is the cache key, and it is fixed.'))
ok('gist drops the later section', !gist.includes('What changed'))

ok('short text has no row', render('Done, the tests pass.', 'points') === '')
ok('empty text has no row', render('', 'points') === '')
{
  const cjk = '缓存键有问题，已经修好。同一篇论文的两次请求共用了一个键。'.repeat(8)
  const html = render(cjk, 'points')
  ok('CJK text folds', html.includes('data-ah-fold-panel') && html.includes('缓存键有问题'))
}

ok('unknown level falls back to full', render(LONG, 'nope').includes('data-ah-fold-row') && !render(LONG, 'nope').includes('data-ah-fold-panel'))

// ── sidebar pane ──────────────────────────────────────────────────────────

{
  const withPane = renderToStaticMarkup(createElement(ReplyFoldView, {
    text: LONG,
    level: 'brief',
    onSelect() {},
    onOpenPane() {},
  }))
  ok('inline row offers the sidebar', withPane.includes('Open in sidebar'))

  const fullContent = renderToStaticMarkup(createElement(FoldContent, { text: LONG, level: 'full' }))
  ok('content at full keeps everything', fullContent.includes('Old entries stay valid.') && fullContent.includes('Full ·'))
  const pointsContent = renderToStaticMarkup(createElement(FoldContent, { text: LONG, level: 'points' }))
  ok('content at points folds', pointsContent.includes('The answer is the cache key') && !pointsContent.includes('Old entries stay valid.'))

  const tabInfo = (params) => () => ({ tab: { navigation: { params, revision: 1 } } })
  const pane = renderToStaticMarkup(createElement(FoldPane, { useTabInfo: tabInfo({ text: LONG, level: 'points' }) }))
  ok('pane header', pane.includes('Read folded') && pane.includes('Level:'))
  ok('pane content', pane.includes('data-ah-fold-pane') && pane.includes('The answer is the cache key'))
  ok('pane drops later text', !pane.includes('Old entries stay valid.'))
  ok('pane has no sidebar action', !pane.includes('Open in sidebar'))
  const paneFull = renderToStaticMarkup(createElement(FoldPane, { useTabInfo: tabInfo({ text: LONG, level: 'full' }) }))
  ok('pane full keeps everything', paneFull.includes('Old entries stay valid.'))
  const emptyPane = renderToStaticMarkup(createElement(FoldPane, { useTabInfo: tabInfo({}) }))
  ok('empty pane explains the action', emptyPane.includes('Open in sidebar'))
}

// ── persisted level ───────────────────────────────────────────────────────

ok('default level is full', readFoldLevel() === 'full')
writeFoldLevel('points')
ok('write unknown level is ignored', (() => { writeFoldLevel('nope'); return readFoldLevel() === 'full' })())
{
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let stored = 'points'
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => stored,
        setItem: (_key, value) => { stored = value },
      },
    })
    ok('reads a persisted level', readFoldLevel() === 'points')
    writeFoldLevel('gist')
    ok('writes a persisted level', stored === 'gist')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
}

// ── wiring and docs ───────────────────────────────────────────────────────

ok('client registration', read('client/index.js').includes("'conversation.chat.turnTail'") && read('client/index.js').includes('academic-harness-reply-fold'))
ok('sidebar registration', read('client/index.js').includes('sidebarRightTabs.register') && read('client/index.js').includes("'sidebar.right.pane.tab'") && read('client/index.js').includes('openFoldPane'))
ok('container imports the view', read('client/ReplyFold.jsx').includes("from './reply-fold.js'"))
ok('pane imports the shared content', read('client/FoldPane.js').includes('FoldContent') && read('client/FoldPane.js').includes("from './reply-fold.js'"))
ok('built bundle has the registration', read('lib/client.js').includes('academic-harness-reply-fold'))
ok('built bundle has the pane', read('lib/client.js').includes(FOLD_TAB_ID))
ok('test script', pkg.scripts?.['test:reply-fold'] === 'node scripts/test-reply-fold.mjs')
ok('React test deps', Boolean(pkg.devDependencies?.react) && Boolean(pkg.devDependencies?.['react-dom']))
ok('sidebar client inject', pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
ok('docs row', read('docs/WORKSPACE.md').includes('Read folded:') && read('docs/WORKSPACE.md').includes('turnTail') && read('docs/WORKSPACE.md').includes('Open in sidebar'))
ok('CI test', read('.github/workflows/verify.yml').includes('test-reply-fold.mjs'))

console.log(`reply-fold tests OK: ${passed} checks`)
