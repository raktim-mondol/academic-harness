import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))
const preset = read('presets/academic-harness/agent.cordis.yml')
const prompt = read('prompt.js')
const settings = read('settings-keys.js')

for (const modulePath of ['./citation', './citation-format', './manuscript-citations', './integrity-check', './review', './review-store', './clinicaltrials', './openfda', './dataset-search', './journal-policy', './funder-policy', './author-lookup', './openreview', './optional-tools', './pdf-references', './stat-audit', './figure-audit', './repo-audit', './python-runtime', './grant-search', './patent-search']) {
  assert.ok(pkg.exports?.[modulePath], `package exports missing ${modulePath}`)
}
for (const file of ['citation.js', 'citation-format.js', 'manuscript-citations.js', 'integrity-check.js', 'review.js', 'review-store.js', 'clinicaltrials.js', 'openfda.js', 'dataset-search.js', 'journal-policy.js', 'funder-policy.js', 'author-lookup.js', 'openreview.js', 'optional-tools.js', 'pdf-references.js', 'stat-audit.js', 'figure-audit.js', 'repo-audit.js', 'python-runtime.js', 'grant-search.js', 'patent-search.js']) {
  assert.ok(pkg.files?.includes(file), `package files missing ${file}`)
  assert.ok(existsSync(join(root, file)), `missing ${file}`)
}
assert.ok(!existsSync(join(root, 'zotero.js')), 'Zotero integration must be removed')
assert.ok(!pkg.exports?.['./zotero'], './zotero export must be removed')
for (const file of ['styles/ieee.csl', 'styles/chicago-author-date.csl', 'styles/modern-language-association.csl', 'styles/README.md']) {
  assert.ok(existsSync(join(root, file)), `missing ${file}`)
}
assert.ok(pkg.dependencies?.['@citation-js/core'], 'citation-js core dependency missing')
assert.ok(pkg.dependencies?.['@citation-js/plugin-csl'], 'citation-js CSL plugin missing')

assert.match(read('citation.js'), /name: 'citation'/)
assert.match(preset, /- id: citation\n  name: academic-harness\/citation/)
assert.match(read('manuscript-citations.js'), /name: 'manuscript_citations'/)
assert.match(preset, /- id: manuscript-citations\n  name: academic-harness\/manuscript-citations/)
assert.match(read('funder-policy.js'), /name: 'funder_policy'/)
assert.match(preset, /- id: funder-policy\n  name: academic-harness\/funder-policy/)
assert.match(read('integrity-check.js'), /name: 'integrity_check'/)
assert.match(preset, /- id: integrity-check\n  name: academic-harness\/integrity-check/)
assert.match(read('review.js'), /name: 'review'/)
assert.match(preset, /- id: review\n  name: academic-harness\/review/)
assert.ok(existsSync(join(root, 'skills/systematic-review-ledger/SKILL.md')), 'missing systematic-review-ledger skill')
assert.ok(existsSync(join(root, 'skills/remove-ai-signs/SKILL.md')), 'missing remove-ai-signs skill')
assert.ok(existsSync(join(root, 'skills/remove-ai-signs/scripts/scan_ai_signs.py')), 'missing remove-ai-signs scanner')
assert.ok(!read('skills/remove-ai-signs/SKILL.md').includes('.qoder'), 'remove-ai-signs must not reference the Qoder skill path')
assert.match(read('clinicaltrials.js'), /name: 'clinicaltrials'/)
assert.match(preset, /- id: clinicaltrials\n  name: academic-harness\/clinicaltrials/)
assert.match(read('openfda.js'), /name: 'openfda'/)
assert.match(preset, /- id: openfda\n  name: academic-harness\/openfda/)
assert.match(read('dataset-search.js'), /name: 'dataset_search'/)
assert.match(preset, /- id: dataset-search\n  name: academic-harness\/dataset-search/)
assert.match(read('journal-policy.js'), /name: 'journal_policy'/)
assert.match(preset, /- id: journal-policy\n  name: academic-harness\/journal-policy/)
assert.match(read('author-lookup.js'), /name: 'author_lookup'/)
assert.match(preset, /- id: author-lookup\n  name: academic-harness\/author-lookup/)
assert.match(read('openreview.js'), /name: 'openreview'/)
assert.match(preset, /- id: openreview\n  name: academic-harness\/openreview/)
for (const [id, tool] of [['pdf-references', 'pdf_references'], ['stat-audit', 'stat_audit'], ['figure-audit', 'figure_audit'], ['repo-audit', 'repo_audit'], ['grant-search', 'grant_search'], ['patent-search', 'patent_search']]) {
  assert.match(preset, new RegExp(`- id: ${id}\\n  name: academic-harness/${id}`), `preset row missing ${id}`)
  assert.ok(existsSync(join(root, `${id}.js`)), `missing ${id}.js`)
  assert.ok(read(`${id}.js`).includes(`name: '${tool}'`), `${id}.js must register ${tool}`)
}
for (const helper of ['stat_audit.py', 'figure_audit.py']) {
  assert.ok(existsSync(join(root, 'python-helpers', helper)), `missing python helper ${helper}`)
}
assert.ok(read('client/ApiKeysSection.jsx').includes('OPENFDA_API_KEY'), 'Settings UI missing OPENFDA_API_KEY')
assert.ok(read('client/ApiKeysSection.jsx').includes('SHERPA_ROMERO_API_KEY'), 'Settings UI missing SHERPA_ROMERO_API_KEY')
assert.ok(read('client/ApiKeysSection.jsx').includes('PATENTSVIEW_API_KEY'), 'Settings UI missing PATENTSVIEW_API_KEY')
for (const key of ['DATACITE_API_KEY', 'ZENODO_API_KEY', 'FIGSHARE_API_KEY']) {
  assert.ok(read('client/ApiKeysSection.jsx').includes(key), `Settings UI missing ${key}`)
}
assert.ok(!/(^|[^a-z_])author_lookup\b/.test(prompt), 'optional tools must not be advertised in the base prompt')
assert.ok(!/(^|[^a-z_])openreview\b/.test(prompt), 'optional tools must not be advertised in the base prompt')
for (const name of ['pdf_references', 'stat_audit', 'figure_audit', 'repo_audit', 'grant_search', 'patent_search']) {
  assert.ok(!new RegExp(`(^|[^a-z_])${name}\\b`).test(prompt), `${name} must not be advertised in the base prompt`)
}
assert.match(prompt, /SRC:PPR/, 'preprint routing must be documented in the prompt')
assert.ok(!preset.includes('academic-harness/zotero'), 'Zotero preset row must be removed')

for (const marker of [
  '## References and citation', 'Chicago author-date', '### Paper integrity', '## Systematic reviews',
  '### Clinical and regulatory evidence', '### Data and journal policy',
  'manuscript_citations', 'funder_policy', '## Writing quality', 'remove-ai-signs',
  'after a draft or chapter exists',
]) {
  assert.ok(prompt.includes(marker), `prompt.js missing marker: ${marker}`)
}
assert.ok(!/zotero/i.test(prompt), 'prompt.js must not mention Zotero')

for (const key of [
  'SHERPA_ROMERO_API_KEY', 'OPENFDA_API_KEY', 'ORCID_TOKEN', 'PATENTSVIEW_API_KEY',
  'DATACITE_API_KEY', 'ZENODO_API_KEY', 'FIGSHARE_API_KEY',
]) {
  assert.ok(settings.includes(`'${key}'`), `settings-keys.js missing ${key}`)
}
for (const key of ['ZOTERO_API_KEY', 'ZOTERO_USER_ID', 'ZOTERO_GROUP_ID']) {
  assert.ok(!settings.includes(`'${key}'`), `Zotero key ${key} must be removed`)
}

const citation = await import('../citation-format.js')
assert.ok(citation.SUPPORTED_STYLES.ieee, 'IEEE style must be supported')
assert.ok(citation.SUPPORTED_STYLES.mla, 'MLA style must be supported')
assert.equal(citation.formatCitations([{ title: 'T', type: 'article', author: [{ family: 'Doe', given: 'J' }], issued: { 'date-parts': [[2024]] } }], { style: 'ieee' }), '[1]')

const review = await import('../review-store.js')
assert.equal(typeof review.deriveStatus, 'function')

const citationTool = await import('../citation.js')
assert.equal(typeof citationTool.apply, 'function')

const integrity = await import('../integrity-check.js')
assert.equal(typeof integrity.apply, 'function')
assert.equal(integrity.classifyIntegrity({
  crossrefSignals: [],
  openalexSignals: [],
  crossrefError: 'OpenAlex API error 500',
  openalexError: null,
}), 'unknown', 'a failed registry must never read as clean')

const reviewTool = await import('../review.js')
assert.equal(typeof reviewTool.apply, 'function')
assert.equal(typeof reviewTool.runReview, 'function')

if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-signs-'))
  try {
    writeFileSync(join(dir, 'sample.md'), 'This pivotal study delves into a rich tapestry.\n')
    const scan = spawnSync('python3', [
      join(root, 'skills/remove-ai-signs/scripts/scan_ai_signs.py'),
      join(dir, 'sample.md'),
    ], { encoding: 'utf8' })
    assert.equal(scan.status, 0, scan.stderr)
    assert.match(scan.stdout, /AI-vocabulary/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const modulePath of ['../clinicaltrials.js', '../openfda.js', '../dataset-search.js', '../journal-policy.js', '../funder-policy.js', '../author-lookup.js', '../openreview.js', '../manuscript-citations.js']) {
  const module = await import(modulePath)
  assert.equal(typeof module.apply, 'function', `${modulePath} must export apply`)
}

console.log('nonsearch surface OK')
