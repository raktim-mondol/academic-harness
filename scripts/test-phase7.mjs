import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const EXPECTED = [
  'papermemory_search', 'papermemory_ingest', 'papermemory_get', 'papermemory_cite',
  'papermemory_cite_check', 'papermemory_remember', 'papermemory_claim', 'papermemory_recap',
  'papermemory_lesson', 'papermemory_quote_check', 'papermemory_trace',
  'papermemory_register_to_ah', 'papermemory_outline', 'papermemory_list',
]
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const cli = process.env.PM_CLI || join(homedir(), '.dsh/papermemory/.venv/bin/papermemory')
const tools = spawnSync(cli, ['tools', '--json'], { encoding: 'utf8' })
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
check(mount.includes('EXPECTED_TOOL_COUNT = 14'), 'papermemory.js missing tool-count drift check')

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

if (failures.length) {
  console.error('Phase 7 surface check FAILED:')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log(`Phase 7 surface OK: ${EXPECTED.length} tools, prompt/skill/golden wiring verified`)
