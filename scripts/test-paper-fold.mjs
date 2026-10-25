import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

if (process.platform === 'win32') {
  console.log('paper_fold fake-runtime tests are POSIX-only; static checks run in CI/Linux')
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'ah-paper-fold-'))
const ws = mkdtempSync(join(tmpdir(), 'ah-paper-fold-ws-'))
const outside = mkdtempSync(join(tmpdir(), 'ah-paper-fold-outside-'))
const fake = join(root, 'scripts', 'fixtures', 'fake-textfold.mjs')
const docPath = join(tmp, 'fixture.json')
const logPath = join(tmp, 'calls.log')

const FIXTURE = {
  format: 'textfold/doc',
  version: 0,
  id: 'fixture-paper',
  lang: 'en',
  title: 'Fixture Paper',
  authors: ['Ada Lovelace', 'Alan Turing'],
  date: '2026-01-01',
  source: { kind: 'markdown', url: '', label: 'fixture.md', license: '' },
  levels: ['topic', 'takeaway', 'key', 'brief', 'full'],
  written: ['topic', 'takeaway', 'key'],
  provenance: {
    made_with: 'TextFold 0.10.31',
    exported: '2026-10-25T00:00:00Z',
    ai_generated: false,
    model: '',
    levels_made: '',
    local: true,
  },
  sections: [
    {
      id: 'S1',
      num: '1',
      title: 'Introduction',
      depth: 1,
      takeaway: '',
      topic: '',
      units: [
        {
          id: 'S1.p1',
          kind: 'paragraph',
          role: 'context',
          full: 'Papers are long. Readers need a map.',
          sentences: ['Papers are long.', 'Readers need a map.'],
          brief: ['Papers are long.'],
          evidence: [0],
          key: 'Papers are long.',
          takeaway: 'Papers are long',
          topic: 'Papers',
        },
        {
          id: 'S1.p2',
          kind: 'paragraph',
          role: 'claim',
          full: 'A map helps. It is not evidence.',
          sentences: ['A map helps.', 'It is not evidence.'],
          brief: ['A map helps.', 'It is not evidence.'],
          evidence: [0, 1],
          key: 'A map helps.',
          takeaway: 'A map helps',
          topic: 'A map',
        },
        {
          id: 'S1.l1',
          kind: 'list item',
          role: 'context',
          full: 'First item. More detail.',
          sentences: ['First item.', 'More detail.'],
          brief: ['First item.'],
          evidence: [0],
          key: 'First item.',
          takeaway: 'First item',
          topic: 'First item',
        },
      ],
    },
    {
      id: 'S2',
      num: '2',
      title: 'Method',
      depth: 1,
      takeaway: '',
      topic: '',
      units: [
        {
          id: 'S2.p1',
          kind: 'paragraph',
          role: 'method',
          full: 'We split the paper. We read the map.',
          sentences: ['We split the paper.', 'We read the map.'],
          brief: ['We split the paper.'],
          evidence: [0],
          key: 'We split the paper.',
          takeaway: 'We split the paper',
          topic: 'We split',
        },
        {
          id: 'S2.c1',
          kind: 'caption',
          role: 'method',
          full: 'Figure 1 shows the setup.',
          sentences: ['Figure 1 shows the setup.'],
          brief: ['Figure 1 shows the setup.'],
          evidence: [0],
          key: 'Figure 1 shows the setup.',
          takeaway: 'Figure 1 shows the setup',
          topic: 'Figure 1',
        },
      ],
    },
    {
      id: 'S2.SS1',
      num: '2.1',
      title: 'Setup',
      depth: 2,
      takeaway: '',
      topic: '',
      units: [
        {
          id: 'S2.SS1.p1',
          kind: 'paragraph',
          role: 'setup',
          full: 'The sample is small. The papers are from one field.',
          sentences: ['The sample is small.', 'The papers are from one field.'],
          brief: ['The sample is small.'],
          evidence: [0],
          key: 'The sample is small.',
          takeaway: 'The sample is small',
          topic: 'The sample',
        },
      ],
    },
  ],
  links: [],
}

writeFileSync(docPath, JSON.stringify(FIXTURE))
writeFileSync(join(ws, 'fixture.md'), '# Fixture\n')
writeFileSync(join(ws, 'scanned.pdf'), '%PDF-1.4\n')
writeFileSync(join(outside, 'fixture.md'), '# Outside\n')
chmodSync(fake, 0o755)

process.env.TEXTFOLD_CLI = fake
process.env.TEXTFOLD_SKIP_INSTALL = '1'
process.env.TEXTFOLD_DATA = join(tmp, 'data')
process.env.FAKE_DOC = docPath
process.env.FAKE_LOG = logPath
process.env.FAKE_MODE = ''

const { apply, buildTextfoldArgs, paperFold, renderPaperView, resolveRef } = await import('../paper-fold.js')
const { TEXTFOLD_VERSION, runProcess } = await import('../textfold-runtime.js')

let passed = 0
function ok(name, condition, detail = '') {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ''}`)
  passed += 1
}

function calls() {
  try {
    return readFileSync(logPath, 'utf8').trim()
  } catch {
    return ''
  }
}

try {
  // ── argument and ref handling ────────────────────────────────────────────

  ok('args map', JSON.stringify(buildTextfoldArgs({ ref: '10.1/x', lang: 'en', generate: false })) === JSON.stringify(['get', '10.1/x', '--json', '--lang', 'en', '--no-generate']))
  ok('args generate', JSON.stringify(buildTextfoldArgs({ ref: '10.1/x', lang: 'en', generate: true })) === JSON.stringify(['get', '10.1/x', '--json', '--lang', 'en']))
  ok('args status', JSON.stringify(buildTextfoldArgs({ action: 'status' })) === JSON.stringify(['--version']))

  ok('ref URL', resolveRef('https://arxiv.org/abs/2501.12345', ws).value === 'https://arxiv.org/abs/2501.12345')
  ok('ref DOI', resolveRef('10.1234/example', ws).value === '10.1234/example')
  ok('ref arXiv', resolveRef('2501.12345', ws).value === '2501.12345')
  ok('ref bare host becomes URL', resolveRef('arxiv.org/abs/2501.12345', ws).value === 'https://arxiv.org/abs/2501.12345')
  const fileRef = resolveRef('fixture.md', ws)
  ok('ref file', fileRef.ok === true && fileRef.value === join(ws, 'fixture.md'))
  ok('ref missing file', resolveRef('missing.md', ws).error_code === 'bad-ref')
  ok('ref escape', resolveRef('../fixture.md', ws).error_code === 'path-escapes-workspace')
  symlinkSync(outside, join(ws, 'link'))
  ok('ref symlink escape', resolveRef('link/fixture.md', ws).error_code === 'path-escapes-workspace')

  // ── renderer ─────────────────────────────────────────────────────────────

  const map = renderPaperView(FIXTURE, { action: 'map' })
  ok('render map ok', map.ok === true && map.level === 'takeaway' && map.truncated === false)
  ok('render map heading', map.markdown.includes('## 1 Introduction  `[S1]`'))
  ok('render map bullets', map.markdown.includes('- Papers are long'))
  ok('render map hint', map.markdown.includes('action=section level=key section=<id>'))
  ok('render local note', map.markdown.includes("author's own first sentences"))
  ok('render by id', renderPaperView(FIXTURE, { action: 'section', section: 'S2.SS1' }).markdown.includes('### 2.1 Setup'))
  ok('render by number', renderPaperView(FIXTURE, { action: 'section', section: '2' }).markdown.includes('## 2 Method'))
  ok('render by index', renderPaperView(FIXTURE, { action: 'section', section: '3' }).markdown.includes('### 2.1 Setup'))
  ok('render key', renderPaperView(FIXTURE, { action: 'section', section: 'S2', level: 'key' }).markdown.includes('We split the paper.'))
  ok('render topic', renderPaperView(FIXTURE, { action: 'map', level: 'topic' }).markdown.includes('Papers; A map; First item'))
  ok('render brief', renderPaperView(FIXTURE, { action: 'section', section: 'S1', level: 'brief' }).markdown.includes('A map helps. … It is not evidence.'))
  ok('render full prefixes', renderPaperView(FIXTURE, { action: 'section', section: 'S2', level: 'full' }).markdown.includes('*Figure 1 shows the setup.*'))
  ok('render full list', renderPaperView(FIXTURE, { action: 'section', section: 'S1', level: 'full' }).markdown.includes('- First item. More detail.'))
  ok('render bad level', renderPaperView(FIXTURE, { action: 'map', level: 'nope' }).error_code === 'bad-level')
  const badSection = renderPaperView(FIXTURE, { action: 'section', section: 'NOPE' })
  ok('render bad section', badSection.error_code === 'bad-section' && badSection.sections.some((s) => s.id === 'S1'))
  ok('render truncation', renderPaperView(FIXTURE, { action: 'map', maxChars: 200 }).truncated === true)
  const generatedDoc = { ...FIXTURE, provenance: { ...FIXTURE.provenance, local: false, ai_generated: true, model: 'fake-model' } }
  ok('render generated note', renderPaperView(generatedDoc, { action: 'map' }).markdown.includes('Written by fake-model'))

  // ── tool registration ────────────────────────────────────────────────────

  let tool
  apply({ tools: { register(registered) { tool = registered } } }, { prepare: false })
  ok('tool name', tool.name === 'paper_fold')
  ok('tool action enum', JSON.stringify(tool.parameters.properties.action.enum) === JSON.stringify(['map', 'section', 'doc', 'export', 'status']))
  ok('tool level enum', JSON.stringify(tool.parameters.properties.level.enum) === JSON.stringify(['topic', 'takeaway', 'key', 'brief', 'full']))
  ok('tool ref optional', !tool.parameters.required || tool.parameters.required.length === 0)
  ok('tool description', /map-first/i.test(tool.description) && /scanned PDF/i.test(tool.description))
  ok('present call', tool.presentCall({ ref: 'fixture.md', action: 'map' }).title.includes('fixture.md'))
  const toolMap = await tool.execute({ action: 'map', ref: 'fixture.md' }, { agent: { session: { header: { cwd: ws } } } })
  ok('tool execute', toolMap.ok === true && toolMap.markdown.includes('[S1]'))
  ok('tool render map', tool.output.render({}, toolMap)[0].text.includes('## 1 Introduction'))

  // ── managed fake CLI ─────────────────────────────────────────────────────

  const status = await paperFold({ action: 'status' })
  ok('status ready', status.ok === true && status.ready === true && status.version === TEXTFOLD_VERSION)
  ok('status install kind', status.install === 'cli')

  const mapResult = await paperFold({ action: 'map', ref: 'fixture.md' }, { cwd: ws })
  ok('map result', mapResult.ok === true && mapResult.level === 'takeaway' && mapResult.generated === false)
  ok('map doc id', mapResult.doc_id === 'fixture-paper' && mapResult.sections === 3)
  ok('map textfold version', mapResult.textfold_version === TEXTFOLD_VERSION)

  const byId = await paperFold({ action: 'section', ref: 'fixture.md', section: 'S2.SS1' }, { cwd: ws })
  ok('section by id', byId.ok === true && byId.level === 'key' && byId.markdown.includes('### 2.1 Setup'))
  const byNumber = await paperFold({ action: 'section', ref: 'fixture.md', section: '2' }, { cwd: ws })
  ok('section by number', byNumber.ok === true && byNumber.markdown.includes('## 2 Method'))
  const byIndex = await paperFold({ action: 'section', ref: 'fixture.md', section: '3' }, { cwd: ws })
  ok('section by index', byIndex.ok === true && byIndex.markdown.includes('### 2.1 Setup'))
  const badSectionResult = await paperFold({ action: 'section', ref: 'fixture.md', section: 'NOPE' }, { cwd: ws })
  ok('section error', badSectionResult.ok === false && badSectionResult.error_code === 'bad-section')
  ok('section error ids', badSectionResult.sections.some((s) => s.id === 'S2'))

  const doc = await paperFold({ action: 'doc', ref: 'fixture.md', write_to: 'out/paper.json' }, { cwd: ws })
  ok('doc write', doc.ok === true && doc.write_to === 'out/paper.json' && !('markdown' in doc))
  ok('doc render', !tool.output.render({}, doc)[0].text.includes('undefined'))
  ok('doc content', JSON.parse(readFileSync(join(ws, 'out/paper.json'), 'utf8')).format === 'textfold/doc')
  const exported = await paperFold({ action: 'export', ref: 'fixture.md', write_to: 'out/paper.md' }, { cwd: ws })
  ok('export write', exported.ok === true && exported.level === 'full' && exported.write_to === 'out/paper.md')
  ok('export render', tool.output.render({}, exported)[0].text.includes('level: full'))
  ok('export content', readFileSync(join(ws, 'out/paper.md'), 'utf8').includes('## 1 Introduction'))
  const docNoPath = await paperFold({ action: 'doc', ref: 'fixture.md' }, { cwd: ws })
  ok('doc requires write_to', docNoPath.error_code === 'bad-request')

  const escaped = await paperFold({ action: 'map', ref: 'fixture.md', write_to: '../escaped.md' }, { cwd: ws })
  ok('write escape blocked', escaped.ok === false && escaped.error_code === 'path-escapes-workspace')
  const linked = await paperFold({ action: 'doc', ref: 'fixture.md', write_to: 'link/sub/paper.json' }, { cwd: ws })
  ok('write symlink escape blocked', linked.ok === false && linked.error_code === 'path-escapes-workspace')
  ok('no outside directory', !existsSync(join(outside, 'sub')))

  const shortMap = await paperFold({ action: 'map', ref: 'fixture.md', max_chars: 200 }, { cwd: ws })
  ok('tool truncation', shortMap.ok === true && shortMap.truncated === true && shortMap.markdown.includes('[truncated'))

  writeFileSync(logPath, '')
  const zh = await paperFold({ action: 'map', ref: 'fixture.md', lang: 'zh' }, { cwd: ws })
  ok('translation precheck', zh.error_code === 'model-required')
  ok('translation precheck spawns nothing', calls() === '')

  process.env.FAKE_MODE = ''
  const localGenerate = await paperFold({ action: 'map', ref: 'fixture.md', generate: true }, { cwd: ws })
  ok('local generate blocked', localGenerate.error_code === 'model-required')

  process.env.FAKE_MODE = 'generated'
  const generated = await paperFold({ action: 'map', ref: 'fixture.md', generate: true }, { cwd: ws })
  ok('generated levels', generated.ok === true && generated.generated === true && generated.markdown.includes('Written by fake-model'))
  const translatedWithEnglish = await paperFold({ action: 'map', ref: 'fixture.md', generate: true, lang: 'zh' }, { cwd: ws })
  ok('translation mismatch blocked', translatedWithEnglish.error_code === 'translation-unavailable')

  process.env.FAKE_MODE = 'generated-zh'
  const translated = await paperFold({ action: 'map', ref: 'fixture.md', generate: true, lang: 'zh' }, { cwd: ws })
  ok('translated generated', translated.ok === true && translated.lang === 'zh')

  for (const [mode, code, ref] of [
    ['scanned', 'scanned-pdf', 'scanned.pdf'],
    ['nohtml', 'no-html', 'fixture.md'],
    ['garbage', 'bad-output', 'fixture.md'],
    ['empty', 'textfold-failed', 'fixture.md'],
  ]) {
    process.env.FAKE_MODE = mode
    const result = await paperFold({ action: 'map', ref }, { cwd: ws })
    ok(`failure mode ${mode}`, result.error_code === code, JSON.stringify(result))
  }
  process.env.FAKE_MODE = ''

  const savedCli = process.env.TEXTFOLD_CLI
  process.env.TEXTFOLD_CLI = join(tmp, 'missing-cli')
  const missing = await paperFold({ action: 'status' })
  ok('status missing', missing.ok === true && missing.ready === false && missing.install === 'cli' && Boolean(missing.error))
  process.env.TEXTFOLD_CLI = savedCli

  process.env.FAKE_MODE = 'sleep'
  const timedOut = await runProcess(fake, ['get', 'x'], { timeoutMs: 100, maxBytes: 1024 })
  ok('runtime timeout', timedOut.timedOut === true)
  const controller = new AbortController()
  const aborting = runProcess(fake, ['get', 'x'], { signal: controller.signal, timeoutMs: 5_000, maxBytes: 1024 })
  setTimeout(() => controller.abort(), 50)
  const abortResult = await aborting
  ok('runtime abort', abortResult.aborted === true)
  process.env.FAKE_MODE = 'huge'
  const enormous = await runProcess(fake, ['get', 'x'], { timeoutMs: 5_000, maxBytes: 10 })
  ok('runtime size cap', enormous.tooLarge === true)
  process.env.FAKE_MODE = ''

  // ── static wiring and docs ───────────────────────────────────────────────

  ok('package export', pkg.exports?.['./paper-fold'] === './paper-fold.js' && pkg.exports?.['./textfold-runtime'] === './textfold-runtime.js')
  ok('package files', pkg.files.includes('paper-fold.js') && pkg.files.includes('textfold-runtime.js'))
  ok('test script', pkg.scripts?.['test:paper-fold'] === 'node scripts/test-paper-fold.mjs')
  ok('preset row', read('presets/academic-harness/agent.cordis.yml').includes('- id: paper-fold\n  name: academic-harness/paper-fold'))
  ok('patch row', read('cordis.patch.yml').includes('name: academic-harness/paper-fold'))
  ok('prompt section', read('prompt.js').includes('## Reading papers at the right level') && read('prompt.js').includes('paper_fold'))
  ok('literature skill', read('skills/literature-researcher/SKILL.md').includes('paper_fold'))
  ok('memory skill', read('skills/papermemory/SKILL.md').includes('paper_fold'))
  ok('README section', read('README.md').includes('### Read at the right level') && read('README.md').includes('TEXTFOLD_SKIP_INSTALL'))
  ok('NOTICE runtime', read('NOTICE').includes('paper_fold') && read('NOTICE').includes('textfold==0.10.31'))
  ok('CI fake test', read('.github/workflows/verify.yml').includes('test-paper-fold.mjs'))
  ok('CI live test', read('.github/workflows/verify.yml').includes('test-paper-fold-live.mjs'))
  ok('runtime pin', read('textfold-runtime.js').includes("TEXTFOLD_VERSION = '0.10.31'"))
  ok('tool registration', read('paper-fold.js').includes("name: 'paper_fold'"))

  console.log(`paper_fold tests OK: ${passed} checks`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
}
