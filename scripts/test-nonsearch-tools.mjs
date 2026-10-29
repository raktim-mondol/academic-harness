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

for (const modulePath of ['./citation', './citation-format', './manuscript-citations', './integrity-check', './review', './review-store', './clinicaltrials', './openfda', './dataset-search', './journal-policy', './funder-policy', './author-lookup', './openreview', './optional-tools', './pdf-references', './stat-audit', './figure-audit', './repo-audit', './python-runtime', './grant-search', './patent-search', './biorxiv-search', './acl-lookup', './inspire-search', './ads-search', './scopus-search', './wos-search', './wikidata-lookup', './domain-search']) {
  assert.ok(pkg.exports?.[modulePath], `package exports missing ${modulePath}`)
}
for (const file of ['citation.js', 'citation-format.js', 'manuscript-citations.js', 'integrity-check.js', 'review.js', 'review-store.js', 'clinicaltrials.js', 'openfda.js', 'dataset-search.js', 'journal-policy.js', 'funder-policy.js', 'author-lookup.js', 'openreview.js', 'optional-tools.js', 'pdf-references.js', 'stat-audit.js', 'figure-audit.js', 'repo-audit.js', 'python-runtime.js', 'grant-search.js', 'patent-search.js', 'biorxiv-search.js', 'acl-lookup.js', 'inspire-search.js', 'ads-search.js', 'scopus-search.js', 'wos-search.js', 'wikidata-lookup.js', 'domain-search.js']) {
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
assert.match(read('domain-search.js'), /name: 'domain_search'/)
assert.match(preset, /- id: domain-search\n  name: academic-harness\/domain-search/)
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

// ── hypothesis tournament (docs/CO-SCIENTIST-INTEGRATION-PLAN.md) ────────────
for (const modulePath of ['./coscientist', './coscientist-rank', './coscientist-verify', './coscientist-embed', './coscientist-store', './coscientist-models', './store-lock']) {
  assert.ok(pkg.exports?.[modulePath], `package exports missing ${modulePath}`)
}
for (const file of ['coscientist.js', 'coscientist-rank.js', 'coscientist-verify.js', 'coscientist-embed.js', 'coscientist-store.js', 'coscientist-models.js', 'store-lock.js']) {
  assert.ok(pkg.files?.includes(file), `package files missing ${file}`)
  assert.ok(existsSync(join(root, file)), `missing ${file}`)
}
for (const [id, tool] of [['coscientist', 'coscientist'], ['coscientist-rank', 'coscientist_rank']]) {
  assert.match(preset, new RegExp(`- id: ${id}\\n  name: academic-harness/${id}`), `preset row missing ${id}`)
  assert.ok(read(`${id}.js`).includes(`name: '${tool}'`), `${id}.js must register ${tool}`)
}
// The ledger and the ranker are preset-only and ungated: they must not
// early-return like the optional tools. Verification is the opposite — it
// reaches the network, so it stays behind AH_ENABLE_OPTIONAL_TOOLS.
for (const file of ['coscientist.js', 'coscientist-rank.js']) {
  assert.ok(!read(file).includes('optionalToolsEnabled'), `${file} must ship on by default`)
}
assert.match(read('coscientist-verify.js'), /optionalToolsEnabled\(\)/, 'coscientist-verify must stay gated')
assert.match(preset, /- id: coscientist-verify\n  name: academic-harness\/coscientist-verify/, 'preset row missing coscientist-verify')
assert.ok(read('coscientist-verify.js').includes("if (value?.error)"), 'a gated tool must still answer in band')
// The tournament is reachable from the template catalogue.
const templates = JSON.parse(read('workflows.json'))
const tournament = templates.find((w) => w.id === 'co-scientist-tournament')
assert.ok(tournament, 'workflows.json must carry the tournament template')
assert.equal(tournament.category, 'literature')
assert.ok(tournament.suggestedSkills.includes('co-scientist-tournament'), 'the template must route to the skill')
assert.deepEqual(tournament.placeholders.map((p) => p.key), ['goal', 'max_hypotheses'])
assert.match(tournament.prompt, /BOTH presentation orders/)
assert.match(tournament.prompt, /never invent a reference|Never invent a reference/)
// The lock is shared, not forked into a second implementation.
assert.match(read('review-store.js'), /from '.\/store-lock\.js'/, 'review-store must use the shared lock')
assert.match(read('coscientist-store.js'), /from '.\/store-lock\.js'/, 'coscientist-store must use the shared lock')
assert.ok(!read('review-store.js').includes('async function withLock'), 'the lock must live in one module')
// No new runtime dependency was pulled in for the port.
for (const banned of ['drizzle', 'sqlite', 'bun:', 'transformers', 'p-queue', 'handlebars', 'ink']) {
  assert.ok(!Object.keys(pkg.dependencies || {}).some((name) => name.includes(banned)), `dependency ${banned} must not be added`)
}
for (const key of ['CO_SCIENTIST_MAX_HYPOTHESES', 'CO_SCIENTIST_STEP_BUDGET', 'CO_SCIENTIST_DUP_THRESHOLD', 'CO_SCIENTIST_SEED']) {
  assert.ok(settings.includes(`'${key}'`), `settings-keys.js missing ${key}`)
  assert.ok(read('client/ApiKeysSection.jsx').includes(key), `Settings UI missing ${key}`)
}
for (const key of ['ADS_API_TOKEN', 'SCOPUS_API_KEY', 'WOS_API_KEY']) {
  assert.ok(settings.includes(`'${key}'`), `settings-keys.js missing ${key}`)
  assert.ok(read('client/ApiKeysSection.jsx').includes(key), `Settings UI missing ${key}`)
}
assert.ok(existsSync(join(root, 'skills/co-scientist-tournament/SKILL.md')), 'missing co-scientist-tournament skill')
for (const reference of ['briefs.md', 'tournament.md']) {
  assert.ok(existsSync(join(root, 'skills/co-scientist-tournament/references', reference)), `missing skill reference ${reference}`)
}
for (const marker of ['## Hypothesis tournaments', 'co-scientist-tournament', 'coscientist_rank', 'verdict_ba', 'recombine published knowledge']) {
  assert.ok(prompt.includes(marker), `prompt.js missing marker: ${marker}`)
}
assert.match(read('NOTICE'), /raktim-mondol\/co-scientist/, 'NOTICE must credit the upstream project')
assert.match(read('docs/RESEARCH.md'), /^## Hypothesis tournaments$/m, 'docs/RESEARCH.md needs a tournament section')
assert.ok(read('README.md').includes('docs/RESEARCH.md'), 'README must link the tournament docs')

const models = await import('../coscientist-models.js')
assert.equal(models.GLICKO2_DEFAULTS.rating, 1200, 'the ported defaults must match upstream')
assert.equal(models.computeGlicko2Update(
  { rating: 1200, rd: 350, volatility: 0.06 }, { rating: 1200, rd: 350, volatility: 0.06 }, 'A_wins',
).newB.rating, 1038, 'a first match must reproduce the upstream update')

const store = await import('../coscientist-store.js')
assert.equal(typeof store.deriveState, 'function', 'state is derived from the log')
assert.deepEqual(store.REVIEW_STAGES, ['initial', 'full', 'deep_verification', 'simulation', 'observation'])
assert.deepEqual(store.VETO_STAGES, ['initial', 'full'])

const coscientistTool = await import('../coscientist.js')
assert.equal(typeof coscientistTool.apply, 'function')
assert.equal(typeof coscientistTool.runCosc, 'function')

const rankTool = await import('../coscientist-rank.js')
assert.equal(typeof rankTool.apply, 'function')
assert.equal(typeof rankTool.runCoscRank, 'function')

// Phase 4: embeddings are opt-in, the graph renders, priors read siblings.
const tournamentRegistrations = []
coscientistTool.apply({ tools: { register: (tool) => tournamentRegistrations.push(tool) } })
assert.deepEqual(tournamentRegistrations.map((tool) => tool.name), ['coscientist'])
const tournamentParams = tournamentRegistrations[0].parameters.properties
assert.equal(tournamentParams.action.enum.length, 14)
for (const action of ['embed', 'priors', 'graph']) {
  assert.ok(tournamentParams.action.enum.includes(action), `coscientist must expose ${action}`)
}
assert.ok(tournamentParams.format.enum.includes('mermaid'), 'export must accept mermaid')
assert.ok(tournamentParams.query && tournamentParams.min_score, 'priors must be tunable from the tool')
assert.match(read('coscientist-embed.js'), /x-goog-api-key/, 'the embedding key travels in a header, never a URL')
assert.match(read('coscientist-embed.js'), /SEMANTIC_SIMILARITY/, 'embeddings compare like with like')
assert.match(read('coscientist-store.js'), /tokenOverlap/, 'priors retrieve order-free')
assert.match(read('coscientist-store.js'), /flowchart TD/, 'the graph is Mermaid')
// Small-pool defaults and the stop rule they depend on.
assert.match(read('coscientist-store.js'), /DEFAULT_MAX_HYPOTHESES = 5/, 'the default pool must survive two losses')
assert.match(read('coscientist-store.js'), /DEFAULT_STEP_BUDGET = 36/, 'the default budget must finish a 5-pool')
assert.match(read('coscientist-models.js'), /no_competitors/, 'a pool that cannot field a match must stop')
assert.match(read('skills/co-scientist-tournament/references/tournament.md'), /no_competitors/, 'the skill must document the fourth stop reason')
assert.match(read('prompt.js'), /ranked and kept/, 'the router must name the fork between one pass and a tournament')
assert.match(read('coscientist-models.js'), /Cosine and Jaccard are different scales/, 'the two measures stay distinguishable')
assert.match(read('coscientist-store.js'), /mixed embedding dimensions/, 'one tournament must use one embedding model')
for (const suite of ['models', 'store', 'tool', 'verify', 'embed', 'graph', 'routing']) {
  assert.ok(existsSync(join(root, `scripts/test-coscientist-${suite}.mjs`)), `missing test-coscientist-${suite}.mjs`)
}

const verifyTool = await import('../coscientist-verify.js')
assert.equal(typeof verifyTool.apply, 'function')
assert.equal(typeof verifyTool.runCoscVerify, 'function')
assert.equal(verifyTool.TITLE_MATCH_THRESHOLD, 0.7, 'the title-match rule stays upstream\'s')

console.log('nonsearch surface OK')
