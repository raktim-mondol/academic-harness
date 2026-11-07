import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  apply, backfillOne, backfillText, bodyLength, cleanWebMarkdown, fetchPageMarkdown, qualityGate, readLedger, resolveDoiByTitle, shouldSkip,
} from '../papermemory-backfill.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (label, cond) => { if (cond) console.log(`ok - ${label}`); else { console.error(`FAIL - ${label}`); failed++ } }
const tmp = () => mkdtempSync(join(tmpdir(), 'pm-backfill-'))

const TITLE = 'Deep learning for coal spoil classification in open cast mines'
const para = 'The classifier was trained on labelled spoil imagery and evaluated against held out sites. '.repeat(12)
const article = (extra = '') => `# ${TITLE}\n\n## Abstract\n\n${para}\n\n## Introduction\n\n${para.repeat(3)}\n\n## Methods\n\n${para.repeat(3)}\n\n## Results\n\n${para.repeat(2)}\n\n## Discussion\n\n${para}\n\n## References\n\n1. A. Author. Something. 2020.\n${extra}`
const wrongArticle = article().replaceAll(TITLE, 'Glacial sediment transport rates in alpine catchments').replaceAll('classifier was trained on labelled spoil imagery and evaluated against held out sites', 'moraine deposits were surveyed across several valleys and compared between seasons')
const abstractPage = `# ${TITLE}\n\n## Abstract\n\n${para}\n\n## Authors\n\nA. B.\n\n## Topics\n\nGeology\n\n## References\n\n${'1. A reference line. 2019.\n'.repeat(300)}`

// ---- quality gate
ok('a real article passes', qualityGate(article(), { title: TITLE, kind: 'html' }).ok)
ok('an abstract page with a long reference list is rejected', /abstract-or-stub/.test(qualityGate(abstractPage, { title: TITLE, kind: 'html' }).reason))
ok('body length stops at the references', bodyLength('x'.repeat(100) + '\n## References\n' + 'r'.repeat(900)) === 101 || bodyLength('x'.repeat(100) + '\n## References\n' + 'r'.repeat(900)) === 100)
ok('a short stub is rejected', /too-short/.test(qualityGate('Please log in', { title: TITLE, kind: 'html' }).reason))
ok('a paywall stub is rejected', qualityGate(`Access through your institution\n\n${article()}`, { title: TITLE, kind: 'html' }).reason === 'paywall-stub')
ok('the wrong paper is rejected', /title-mismatch/.test(qualityGate(wrongArticle, { title: TITLE, kind: 'html' }).reason))
ok('an unknown title skips the title check', qualityGate(article(), { title: 'Untitled', kind: 'html' }).ok)

// ---- cleaner
{
  const dirty = `[Skip to main content](https://x/#main)\n\n![logo](https://x/a.svg)\n\nOfficial websites use .gov\n\n# ${TITLE}\n\n![fig](https://x/f.png)\n\nBody text here.\n`
  const clean = cleanWebMarkdown(dirty, TITLE)
  ok('cleaner cuts the preamble before the title heading', clean.startsWith(`# ${TITLE}`) && !clean.includes('Official websites'))
  ok('cleaner drops images and skip links', !clean.includes('![') && !clean.includes('Skip to main'))
  ok('cleaner leaves text alone when no title heading', cleanWebMarkdown('Plain body', 'x').trim() === 'Plain body')
}

// ---- reading a page: a stub from one provider falls through to the next
{
  const calls = []
  const fetchImpl = async () => { calls.push('exa'); return { ok: true, data: { results: [{ text: 'tiny stub' }] } } }
  const mcpImpl = async () => { calls.push('firecrawl'); return { ok: true, structured: { markdown: article() }, text: '' } }
  const page = await fetchPageMarkdown('https://www.nature.com/articles/x', {
    exaKey: 'k', firecrawlKey: 'k', fetchImpl, mcpImpl, accept: (t) => qualityGate(t, { title: TITLE, kind: 'html' }).ok,
  })
  ok('Exa stub is rejected and Firecrawl is used', page.source === 'firecrawl' && calls.join() === 'exa,firecrawl' && page.tried[0].source === 'exa')
  let blocked = false
  try { await fetchPageMarkdown('http://127.0.0.1/secret', { exaKey: 'k' }) } catch { blocked = true }
  ok('a private URL is refused before any provider sees it', blocked)
}

// ---- one paper, every route (network-free)
const paper = { id: 'pap_1', doi: '10.1234/spoil', title: TITLE, year: 2024 }
const mkDeps = (over = {}) => {
  const log = { ingested: [], pages: [], pdfs: [] }
  const deps = {
    resolveSources: async function* () { yield { candidate: { source: 'unpaywall', pdfUrl: 'https://repo.example.org/a.pdf' } } },
    fetchPdf: async (url) => { log.pdfs.push(url); return Buffer.from('%PDF-1.7 fake') },
    convert: async () => ({ success: true, markdown: article(), page_count: 9, pdf_type: 'text', pages_needing_ocr: [] }),
    fetchPage: async (url, opts) => { log.pages.push(url); return { markdown: article(), source: 'exa', tried: [] } },
    ingest: async (args) => { log.ingested.push(args); return { ok: true, cite_state: 'citable', bibtex_key: 'spoil2024' } },
    write: () => {},
    ...over,
  }
  return { deps, log }
}
const oaYes = new Map([['10.1234/spoil', { is_oa: true, has_pdf: true, landing_urls: ['https://pmc.example.org/art'] }]])
const oaNo = new Map([['10.1234/spoil', { is_oa: false, has_pdf: false, landing_urls: [] }]])
const base = { dir: tmp(), project: 'p', email: 'x@y.z', exaKey: 'k', firecrawlKey: 'k' }

{
  const { deps, log } = mkDeps()
  const r = await backfillOne(paper, { ...base, oa: oaYes, deps })
  ok('open-access PDF is ingested as oa-pdf', r.outcome === 'ingested' && log.ingested[0].originChannel === 'oa-pdf' && log.ingested[0].doi === '10.1234/spoil' && !!log.ingested[0].pdfPath)
}
{
  const { deps, log } = mkDeps({ fetchPdf: async () => { throw new Error('fetch failed: HTTP 403 for https://pub.example.org/a.pdf') } })
  const r = await backfillOne(paper, { ...base, oa: oaYes, deps })
  ok('a blocked PDF (403) is read through the page reader', r.outcome === 'ingested' && log.pages[0] === 'https://repo.example.org/a.pdf' && log.ingested[0].originChannel === 'oa-html')
}
{
  const { deps, log } = mkDeps({ resolveSources: async function* () { yield { attempt: { source: 'unpaywall', error: 'no open-access copy' } } } })
  const r = await backfillOne(paper, { ...base, oa: oaYes, deps })
  ok('no PDF falls back to the open-access page', r.outcome === 'ingested' && log.pages[0] === 'https://pmc.example.org/art')
}
{
  const { deps, log } = mkDeps({ resolveSources: async function* () { yield { attempt: { source: 'unpaywall', error: 'none' } } } })
  const r = await backfillOne(paper, { ...base, oa: oaNo, deps })
  ok('a paper that is not open access is paywalled and never scraped', r.outcome === 'paywalled' && log.pages.length === 0 && log.ingested.length === 0)
}
{
  const { deps } = mkDeps({
    resolveSources: async function* () { yield { attempt: { source: 'unpaywall', error: 'none' } } },
    fetchPage: async () => ({ markdown: null, source: null, tried: [{ source: 'exa', error: 'no text returned' }] }),
  })
  const r = await backfillOne(paper, { ...base, oa: oaYes, deps })
  ok('open access but unreadable is "unreachable", not "paywalled"', r.outcome === 'unreachable')
}
{
  const { deps, log } = mkDeps({ resolveSources: async function* () { yield { attempt: { source: 'unpaywall', error: 'none' } } }, fetchPage: async () => ({ markdown: abstractPage, source: 'exa', tried: [] }) })
  const r = await backfillOne(paper, { ...base, oa: oaYes, deps })
  ok('an abstract-only page is never ingested', r.outcome === 'gate-failed' && log.ingested.length === 0)
}
{
  const { deps, log } = mkDeps({ convert: async () => ({ success: true, markdown: wrongArticle, page_count: 8, pages_needing_ocr: [] }), fetchPage: async () => ({ markdown: null, source: null, tried: [] }) })
  const r = await backfillOne(paper, { ...base, oa: oaYes, deps })
  ok('the wrong paper behind a DOI is not ingested', r.outcome === 'gate-failed' && log.ingested.length === 0)
}
{
  const { deps } = mkDeps()
  const r = await backfillOne({ id: 'pap_2', title: TITLE }, { ...base, deps: { ...deps, resolveIdentity: async () => ({ reason: 'no exact title match' }) } })
  ok('no DOI, no arXiv id and no strict title match is skipped, not guessed', r.outcome === 'no-identifier')
}

// ---- identity by title: strict or nothing
{
  const mk = (results, ok = true, status = 200) => async () => ({ ok, status, data: { results } })
  const w = (title, year, doi) => ({ title, publication_year: year, doi: `https://doi.org/${doi}` })
  const P = { title: 'Deep Residual Learning for Image Recognition', year: 2016 }
  const one = await resolveDoiByTitle(P, { fetchImpl: mk([w(P.title, 2015, '10.48550/arXiv.1512.03385')]) })
  ok('an exact title with the year within one resolves', one.doi === '10.48550/arxiv.1512.03385')
  ok('a different year (more than one apart) is refused', !(await resolveDoiByTitle(P, { fetchImpl: mk([w(P.title, 2010, '10.1/x1234')]) })).doi)
  ok('a fuzzy title is refused', !(await resolveDoiByTitle(P, { fetchImpl: mk([w('Deep Residual Learning for Image Recognition: A Survey', 2016, '10.1234/survey')]) })).doi)
  const amb = await resolveDoiByTitle(P, { fetchImpl: mk([w(P.title, 2016, '10.1109/cvpr.2016.90'), w(P.title, 2016, '10.1234/other')]) })
  ok('two exact matches with no single arXiv version are ambiguous', !amb.doi && /ambiguous/.test(amb.reason))
  const pref = await resolveDoiByTitle(P, { fetchImpl: mk([w(P.title, 2016, '10.1109/cvpr.2016.90'), w(P.title, 2015, '10.48550/arXiv.1512.03385')]) })
  ok('preprint and published version: the single arXiv one is used', pref.doi === '10.48550/arxiv.1512.03385')
  ok('a website name is not a title', !(await resolveDoiByTitle({ title: 'elife.elifesciences.org', year: 2020 }, { fetchImpl: mk([]) })).doi)
  ok('a rate limit is reported', (await resolveDoiByTitle(P, { fetchImpl: mk([], false, 429) })).rate_limited === true)
  ok('a short famous title still resolves', (await resolveDoiByTitle({ title: 'Attention is All You Need', year: 2017 }, { fetchImpl: mk([w('Attention is All You Need', 2017, '10.48550/arXiv.1706.03762')]) })).doi === '10.48550/arxiv.1706.03762')
}
{
  const promoted = []
  const { deps, log } = mkDeps({
    resolveIdentity: async () => ({ doi: '10.1234/spoil', via: 'openalex-title' }),
    promote: async (id, doi) => { promoted.push([id, doi]); return { ok: true } },
  })
  const r = await backfillOne({ id: 'pap_9', title: TITLE, year: 2024 }, { ...base, oa: new Map(oaYes), deps })
  ok('a title-resolved DOI is attached to the same record, then the text is ingested', r.outcome === 'ingested' && promoted[0].join() === 'pap_9,10.1234/spoil' && log.ingested[0].doi === '10.1234/spoil' && r.identity.via === 'openalex-title')
  const { deps: d2, log: l2 } = mkDeps({ resolveIdentity: async () => ({ doi: '10.1234/spoil', via: 'x' }), promote: async () => ({ ok: false, error: 'identity owned by pap_2' }) })
  const r2 = await backfillOne({ id: 'pap_9', title: TITLE, year: 2024 }, { ...base, oa: new Map(oaYes), deps: d2 })
  ok('if another record already owns that DOI nothing is ingested', r2.outcome === 'no-identifier' && l2.ingested.length === 0 && /owned by/.test(r2.reason))
}

// ---- ledger + batch (network-free)
{
  const dir = tmp()
  const rows = [paper, { id: 'pap_3', doi: '10.1234/other', title: 'Another paper about glacial sediment transport rates', year: 2023 }]
  const oaMap = new Map([['10.1234/spoil', oaYes.get('10.1234/spoil')], ['10.1234/other', { is_oa: false, has_pdf: false, landing_urls: [] }]])
  const { deps, log } = mkDeps({
    listTextless: async () => ({ rows, total: 2 }),
    openAccessBatch: async () => ({ results: oaMap }),
    resolveSources: async function* ({ doi }) { if (doi === '10.1234/spoil') yield { candidate: { source: 'unpaywall', pdfUrl: 'https://repo.example.org/a.pdf' } }; else yield { attempt: { source: 'unpaywall', error: 'none' } } },
  })
  const dry = await backfillText({ project: 'p', limit: 10, dryRun: true, dir, deps })
  ok('dry run reports routes and writes nothing', dry.dry_run && dry.expected.pdf === 1 && dry.expected.paywalled === 1 && log.ingested.length === 0 && !existsSync(join(dir, 'ledger.jsonl')))
  const run1 = await backfillText({ project: 'p', limit: 10, dryRun: false, dir, deps })
  ok('real run ingests the open one and records the paywalled one', run1.ingested === 1 && run1.paywalled === 1 && run1.citable_now === 1)
  const ledger = readLedger(dir)
  ok('ledger holds both outcomes', ledger.get('pap_1').outcome === 'ingested' && ledger.get('pap_3').outcome === 'paywalled')
  ok('paywalled is skipped for 30 days, ingested never retried', shouldSkip('pap_3', ledger) && !shouldSkip('pap_3', ledger, Date.now() + 31 * 86_400_000) && !shouldSkip('pap_1', ledger))
  const run2 = await backfillText({ project: 'p', limit: 10, dryRun: false, dir, deps })
  ok('a second run skips the recently paywalled paper', run2.skipped_recently_failed === 1 && run2.considered === 1)
  const run3 = await backfillText({ project: 'p', limit: 10, dryRun: false, retry: true, dir, deps })
  ok('retry bypasses the ledger', run3.considered === 2)
}
{
  const { deps } = mkDeps({
    listTextless: async () => ({ rows: [paper, { ...paper, id: 'p2', doi: '10.1234/b' }, { ...paper, id: 'p3', doi: '10.1234/c' }, { ...paper, id: 'p4', doi: '10.1234/d' }], total: 4 }),
    openAccessBatch: async () => ({ results: new Map() }),
    resolveSources: async function* () { yield { attempt: { source: 'openalex', error: 'OpenAlex API error 429' } } },
  })
  const r = await backfillText({ project: 'p', limit: 10, dryRun: false, concurrency: 1, dir: tmp(), deps: { ...deps, sleep: async () => {} } })
  ok('three rate-limit answers in a row stop the run early', r.stopped === 'rate_limited' && r.results.length < 4)
}

{
  // a 429 in the middle does not stop the run; only three in a row do
  let n = 0
  const { deps } = mkDeps({
    listTextless: async () => ({ rows: [paper, { ...paper, id: 'p2', doi: '10.1234/b' }, { ...paper, id: 'p3', doi: '10.1234/c' }, { ...paper, id: 'p4', doi: '10.1234/d' }], total: 4 }),
    openAccessBatch: async () => ({ results: new Map() }),
    resolveSources: async function* () { n += 1; yield { attempt: { source: 'openalex', error: n === 2 ? 'OpenAlex API error 429' : 'none' } } },
    sleep: async () => {},
  })
  const r = await backfillText({ project: 'p', limit: 10, dryRun: false, concurrency: 1, dir: tmp(), deps })
  ok('an isolated 429 does not stop the run', !r.stopped && r.results.length === 4)
}
{
  // a failed title lookup is a transient error, not a 30-day "no identifier"
  const dir = tmp()
  const { deps } = mkDeps({
    listTextless: async () => ({ rows: [{ id: 'pap_n', title: TITLE, year: 2024 }], total: 1 }),
    openAccessBatch: async () => ({ results: new Map() }),
    resolveIdentity: async () => ({ reason: 'OpenAlex API error 429', rate_limited: true }),
    sleep: async () => {},
  })
  const r = await backfillText({ project: 'p', limit: 5, dryRun: false, dir, deps })
  ok('a rate-limited title lookup is recorded as a retryable error', r.errors === 1 && r.no_identifier === 0 && readLedger(dir).get('pap_n').outcome === 'error')
  ok('and is retried after a day, not thirty', !shouldSkip('pap_n', readLedger(dir), Date.now() + 2 * 86_400_000))
}

// ---- real CLI: the vendored package, a throwaway database, a real ingest
{
  const dir = tmp()
  const wrapper = join(dir, 'pm-cli.sh')
  writeFileSync(wrapper, `#!/usr/bin/env bash\nexec env PYTHONPATH=${join(root, 'vendor', 'papermemory')} python3 -m papermemory "$@"\n`)
  chmodSync(wrapper, 0o755)
  const db = join(dir, 'pm.db')
  process.env.PAPERMEMORY_CLI = wrapper
  process.env.PAPERMEMORY_DB = db
  process.env.EXA_API_KEY = 'test-key-not-used'
  const env = { ...process.env, PYTHONPATH: join(root, 'vendor', 'papermemory'), PYTHONDONTWRITEBYTECODE: '1' }
  const seed = spawnSync('python3', ['-c', `
from papermemory.db import Store
s = Store(${JSON.stringify(db)}); s.ensure_project("p")
p = s.upsert_paper({"title": ${JSON.stringify(TITLE)}, "doi": "10.1234/spoil", "year": 2024}); s.add_membership(p["id"], "p"); s.conn.commit()
`], { env, encoding: 'utf8' })
  ok('seeded a chunkless paper', seed.status === 0)
  const { deps } = mkDeps({
    // real listTextless and real ingest; only the network is faked
    ingest: undefined, listTextless: undefined,
    openAccessBatch: async () => ({ results: oaYes }),
    resolveSources: async function* () { yield { attempt: { source: 'unpaywall', error: 'none' } } },
    fetchPage: async () => ({ markdown: article(), source: 'exa', tried: [] }),
    write: writeFileSync,
  })
  delete deps.ingest; delete deps.listTextless
  const { ingestConvertedMarkdown } = await import('../papermemory-cli.js')
  deps.ingest = ingestConvertedMarkdown
  const r = await backfillText({ project: 'p', limit: 5, dryRun: false, dir: join(dir, 'work'), deps })
  if (r.ingested !== 1) console.error(JSON.stringify(r).slice(0, 700))
  ok('real ingest makes the paper citable', r.ingested === 1 && r.citable_now === 1)
  const q = spawnSync('python3', ['-c', `
import sqlite3; c = sqlite3.connect(${JSON.stringify(db)})
print(c.execute("select count(*) from papers").fetchone()[0], c.execute("select cite_state from papers").fetchone()[0], c.execute("select origin_channel from raw_documents where is_current=1").fetchone()[0], c.execute("select count(*) from chunks").fetchone()[0] > 3)
`], { encoding: 'utf8' })
  ok('one paper (no duplicate), citable, oa-html, with chunks', q.stdout.trim() === '1 citable oa-html True')
}

// ---- wiring
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  ok('package exports and ships the module', pkg.exports['./papermemory-backfill'] === './papermemory-backfill.js' && pkg.files.includes('papermemory-backfill.js'))
  const preset = readFileSync(join(root, 'presets/academic-harness/agent.cordis.yml'), 'utf8')
  ok('preset mounts the tool', /- id: papermemory-backfill\n\s+name: academic-harness\/papermemory-backfill\n/.test(preset))
  ok('patch regenerated', /name: academic-harness\/papermemory-backfill/.test(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')))
  ok('prompt mentions paper_backfill', readFileSync(join(root, 'prompt.js'), 'utf8').includes('paper_backfill'))
  const tools = []
  apply({ tools: { register: (t) => tools.push(t) } })
  ok('registers paper_backfill, dry run by default', tools[0]?.name === 'paper_backfill' && /Dry run by default/.test(tools[0].description))
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1) }
console.log('papermemory backfill OK')
