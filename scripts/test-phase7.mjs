import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const EXPECTED = [
  'papermemory_search', 'papermemory_ingest', 'papermemory_get', 'papermemory_cite',
  'papermemory_cite_check', 'papermemory_remember', 'papermemory_claim', 'papermemory_recap',
  'papermemory_lesson', 'papermemory_quote_check', 'papermemory_trace',
  'papermemory_register_to_ah', 'papermemory_outline', 'papermemory_list', 'papermemory_library',
]
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

// Test the vendored package (what the plugin installs), not whatever copy happens to be installed.
const vendored = join(root, 'vendor', 'papermemory')
const tools = process.env.PM_CLI
  ? spawnSync(process.env.PM_CLI, ['tools', '--json'], { encoding: 'utf8' })
  : spawnSync('python3', ['-m', 'papermemory', 'tools', '--json'], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: vendored } })
if (tools.status !== 0) failures.push(`tools --json failed: ${tools.stderr || tools.status}`)
else {
  const names = JSON.parse(tools.stdout)
  check(Array.isArray(names) && names.length === EXPECTED.length, `tool count ${names.length} != ${EXPECTED.length}`)
  check(JSON.stringify(names) === JSON.stringify(EXPECTED), 'tool names differ from the golden surface')
}

const prompt = readFileSync(join(root, 'prompt.js'), 'utf8')
for (const marker of ['papermemory_quote_check', 'papermemory_trace', 'empty_reason', 'absence-not-licensable', 'register_to_ah', 'channel-capped:ocr-recovered', 'supports_statement']) {
  check(prompt.includes(marker), `prompt.js missing marker: ${marker}`)
}
const skill = readFileSync(join(root, 'skills/papermemory/SKILL.md'), 'utf8')
for (const name of EXPECTED) check(skill.includes(name), `SKILL.md missing tool: ${name}`)
check(skill.includes('quote-not-verbatim'), 'SKILL.md missing quote refusal rule')
check(skill.includes('Contradicted claims leave cite/recap/list'), 'SKILL.md missing contradiction gating')

const zgSkill = readFileSync(join(root, 'skills/zvec-grep/SKILL.md'), 'utf8')
for (const marker of ['workspace context, not evidence', 'never a citable source', 'does not satisfy the verbatim-quote rule', 'fails soft']) {
  check(prompt.includes(marker), `prompt.js missing zg boundary marker: ${marker}`)
  check(zgSkill.includes(marker), `zvec-grep SKILL.md missing claim-boundary marker: ${marker}`)
}
check(zgSkill.includes('## Boundary with PaperMemory'), 'zvec-grep SKILL.md missing Boundary with PaperMemory section')

const zvecIndex = readFileSync(join(root, 'zvec-index.js'), 'utf8')
check(zvecIndex.includes('exclude: {'), 'zvec_index does not declare an exclude parameter')
check(zvecIndex.includes('PaperMemory runtime paths under the index root'), 'zvec_index description does not document automatic PaperMemory exclusions')
check(zvecIndex.includes('globs: Array.isArray(args.exclude)'), 'zvec_index does not forward exclude globs to startIndex')

const mount = readFileSync(join(root, 'papermemory.js'), 'utf8')
check(mount.includes('failOnStartupError: true'), 'papermemory.js must fail loudly on startup')
check(mount.includes('EXPECTED_TOOL_COUNT = 15'), 'papermemory.js missing tool-count drift check')

const pdf = readFileSync(join(root, 'pdf-to-markdown.js'), 'utf8')
check(pdf.includes('converter:'), 'pdf-to-markdown.js does not forward converter signals')
check(pdf.includes('originChannel'), 'pdf-to-markdown.js does not forward originChannel')
check(pdf.includes('page-subset conversion is not ingested'), 'pdf-to-markdown.js still ingests page subsets')
check(pdf.includes('degradation'), 'pdf-to-markdown.js does not render degradation')

const download = readFileSync(join(root, 'paper-download.js'), 'utf8')
check(download.includes('cite_state'), 'paper-download.js does not surface cite_state')
check(download.includes('degradation'), 'paper-download.js does not surface degradation')

const cliSrc = readFileSync(join(root, 'papermemory-cli.js'), 'utf8')
check(cliSrc.includes('probeNdjson'), 'papermemory-cli.js missing NDJSON probe')
check(cliSrc.includes('--converter-json'), 'papermemory-cli.js missing converter forwarding')
check(cliSrc.includes("'--cwd'"), 'papermemory-cli.js does not forward --cwd to ingest')
for (const [file, source] of [['paper-download.js', download], ['pdf-to-markdown.js', pdf]]) {
  check(source.includes('cwd,'), `${file} does not pass cwd to auto-ingest`)
  check(source.includes('PAPERMEMORY_PROJECT'), `${file} lost the PAPERMEMORY_PROJECT override`)
  check(!source.includes('projectSlugFromCwd'), `${file} still writes a cwd-derived project slug`)
}
check(prompt.includes('PAPERMEMORY_PROJECT'), 'prompt.js does not document the PAPERMEMORY_PROJECT override')

check(existsSync(join(root, 'scripts/test-search-execute.mjs')), 'missing scripts/test-search-execute.mjs')

const searchModules = {
  'search-normalize.js': null,
  'search-http.js': null,
  'paper-resolve.js': 'paper_resolve',
  'openalex-search.js': 'openalex_search',
  'openalex-cite.js': 'openalex_citations',
  'semantic-scholar-search.js': 's2_search',
  'crossref-lookup.js': 'crossref_lookup',
  'arxiv-search.js': 'arxiv_search',
  'pubmed-search.js': 'pubmed_search',
  'literature-search.js': 'literature_search',
}
for (const [file, tool] of Object.entries(searchModules)) {
  const path = join(root, file)
  check(existsSync(path), `missing search module: ${file}`)
  if (!existsSync(path)) continue
  const source = readFileSync(path, 'utf8')
  if (tool) {
    check(source.includes('export const name'), `${file} does not export a plugin name`)
    check(source.includes(`name: '${tool}'`), `${file} does not register ${tool}`)
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const [file, tool] of Object.entries(searchModules)) {
  if (!tool) continue
  const slug = file.replace(/\.js$/, '')
  check(pkg.exports?.[`./${slug}`] === `./${file}`, `package.json missing export ${slug}`)
  check(pkg.files?.includes(file), `package.json files missing ${file}`)
}

const presetSource = readFileSync(join(root, 'presets/academic-harness/agent.cordis.yml'), 'utf8')
for (const slug of ['paper-resolve', 'openalex-search', 'openalex-cite', 'semantic-scholar-search', 'crossref-lookup', 'arxiv-search', 'pubmed-search', 'literature-search', 'parallel-extract', 'brave-search', 'tavily-search', 'exa-search', 'perplexity-search', 'jina-reader', 'core-search', 'elicit-search', 'futurehouse-agent']) {
  check(presetSource.includes(`academic-harness/${slug}`), `preset missing row ${slug}`)
}

for (const marker of ['literature_search', 'openalex_search', 's2_search', 'pubmed_search', 'arxiv_search', 'crossref_lookup', 'paper_resolve', 'openalex_citations', 'brave_search', 'parallel_extract', 'tavily_search', 'exa_search', 'perplexity_search', 'jina_read', 'core_search', 'elicit_search', 'futurehouse_agent', 'Academic databases']) {
  check(prompt.includes(marker), `prompt.js missing search marker: ${marker}`)
}

const arxivSource = readFileSync(join(root, 'arxiv-search.js'), 'utf8')
check(arxivSource.includes('minIntervalMs: 3000, maxConcurrent: 1'), 'arxiv_search lost its 3s / single-connection limiter')

const webModules = {
  'parallel-extract.js': 'parallel_extract',
  'brave-search.js': 'brave_search',
  'tavily-search.js': 'tavily_search',
  'exa-search.js': 'exa_search',
  'perplexity-search.js': 'perplexity_search',
  'jina-reader.js': 'jina_read',
}
const gatedModules = {
  'core-search.js': 'core_search',
  'elicit-search.js': 'elicit_search',
  'futurehouse-agent.js': 'futurehouse_agent',
}
for (const [file, tool] of Object.entries({ ...webModules, ...gatedModules })) {
  const path = join(root, file)
  check(existsSync(path), `missing search module: ${file}`)
  if (!existsSync(path)) continue
  const source = readFileSync(path, 'utf8')
  check(source.includes('export const name'), `${file} does not export a plugin name`)
  check(source.includes(`name: '${tool}'`), `${file} does not register ${tool}`)
  const slug = file.replace(/\.js$/, '')
  check(pkg.exports?.[`./${slug}`] === `./${file}`, `package.json missing export ${slug}`)
  check(pkg.files?.includes(file), `package.json files missing ${file}`)
}

const settingsSource = readFileSync(join(root, 'settings-keys.js'), 'utf8')
for (const key of ['OPENALEX_API_KEY', 'S2_API_KEY', 'CROSSREF_MAILTO', 'NCBI_API_KEY', 'NCBI_EMAIL', 'BRAVE_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PERPLEXITY_API_KEY', 'JINA_API_KEY', 'CORE_API_KEY', 'ELICIT_API_KEY', 'FUTUREHOUSE_API_KEY']) {
  check(settingsSource.includes(key), `settings-keys.js missing ${key}`)
}

if (failures.length) {
  console.error('Phase 7 surface check FAILED:')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log(`Phase 7 surface OK: ${EXPECTED.length} tools, prompt/skill/golden wiring verified`)
