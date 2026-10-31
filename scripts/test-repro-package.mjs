import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, runReproPackage } from '../repro-package.js'
import { freezeAnalysisPlan, runAnalysis } from '../analysis-store.js'
import { startExperiment, logExperimentRun } from '../experiment-store.js'
import { appendJsonl, hashFile } from '../ledger-kit.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-repro-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)
let tool
apply({ tools: { register: (registered) => { tool = registered } } })
const run = (args) => tool.execute(args, exec)
const direct = (args, deps = {}) => runReproPackage(args, exec, deps)

try {
  // A real analysis ledger with one successful run.
  workspace.write('analysis/main.py', 'import os\nos.makedirs("results", exist_ok=True)\nwith open("results/out.csv","w") as fh: fh.write("a\\n1\\n")\nprint("done")\n')
  workspace.write('data/in.csv', 'x\n1\n')
  await freezeAnalysisPlan({ cwd, slug: 'primary', plan: { question: 'Q?', inputs: ['data/in.csv'], outputs: ['results/out.csv'] } })
  const manifest = await runAnalysis({ cwd, slug: 'primary', kind: 'python', command: ['python3', 'analysis/main.py'], notebookEntry: null })
  assert.equal(manifest.exit_code, 0)

  // A real experiment ledger.
  await startExperiment({ cwd, slug: 'sweep', experiment: { question: 'Which lr?', metrics: [{ name: 'acc', direction: 'higher' }] } })
  await logExperimentRun({ cwd, slug: 'sweep', params: { lr: 0.1 }, metrics: { acc: 0.9 } })

  // A dataset_get manifest (fixture, no network).
  const datasetDir = join(cwd, '.dsh', 'data', 'zenodo-123')
  const dataRel = join('data', 'zenodo-123', 'values.csv')
  workspace.write(dataRel, 'v\n1\n2\n')
  appendJsonl(join(datasetDir, 'manifest.jsonl'), [{
    kind: 'download', ts: new Date().toISOString(), slug: 'zenodo-123', doi: '10.5281/zenodo.123',
    version: 'v1', license: 'CC0-1.0', license_stated: true, landing_page: 'https://doi.org/10.5281/zenodo.123',
    repository: 'Zenodo',
    files: [{ name: 'values.csv', path: dataRel, url: 'https://example.invalid/values.csv', bytes: 6, sha256: `sha256:${hashFile(join(cwd, dataRel))}`, source_checksum: null, verification: 'no_checksum', status: 'downloaded' }],
  }])

  workspace.write('src/model.py', 'print("model")\n')
  workspace.write('paper.md', '# Paper\n')

  // Plan validation and freeze.
  let result = await run({ action: 'plan', slug: 'paper1', plan: { name: 'Paper One' } })
  assert.match(result.error, /authors needs at least one/)
  result = await run({ action: 'plan', slug: 'paper1', plan: {
    name: 'Paper One', authors: [{ given: 'A', family: 'Researcher', orcid: '0000-0001-0000-0000' }, 'B Person'],
    analyses: [{ slug: 'primary', run_id: manifest.run_id }], experiments: ['sweep'], datasets: [{ slug: 'zenodo-123' }],
    code_files: ['src/model.py'], manuscript: 'paper.md', license: 'MIT', funder: 'Test Council', citation: 'Researcher et al. 2026',
    include_data: true,
  } })
  assert.equal(result.plan.slug, 'paper1')
  result = await run({ action: 'plan', slug: 'paper1', plan: { name: 'Again', authors: ['x'] } })
  assert.match(result.error, /write-once|already exists/)

  // Build.
  result = await run({ action: 'build', slug: 'paper1' })
  assert.equal(result.package.files > 10, true, JSON.stringify(result.package))
  const packageDir = join(cwd, 'package', 'paper1')
  for (const name of ['manifest.json', 'README.md', 'CITATION.cff', 'codemeta.json', 'ro-crate-metadata.json', 'Dockerfile', 'checksums.sha256', 'environment/environment.json']) {
    assert.ok(existsSync(join(packageDir, name)), `missing ${name}`)
  }
  assert.ok(existsSync(join(packageDir, 'analysis', 'primary', `${manifest.run_id}-manifest.json`)))
  assert.ok(existsSync(join(packageDir, 'code', 'src', 'model.py')))
  assert.ok(existsSync(join(packageDir, 'data', 'zenodo-123', 'values.csv')), 'include_data copies dataset files')
  assert.ok(existsSync(join(packageDir, 'experiments', 'sweep-runs.jsonl')))
  const built = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'))
  assert.equal(built.license, 'MIT')
  assert.equal(built.datasets[0].doi, '10.5281/zenodo.123')
  assert.equal(built.environment.runs[0].run_id, manifest.run_id)
  const readme = readFileSync(join(packageDir, 'README.md'), 'utf8')
  assert.match(readme, /## Run order/)
  assert.match(readme, /python3 analysis\/main\.py/)
  assert.match(readme, /## Data availability/)
  assert.match(readme, /doi.org\/10.5281\/zenodo.123/)
  assert.match(readme, /evidence of the recorded environment and artifacts, not a guarantee/)
  assert.ok(!readme.includes('\n\n\n\n'), 'README keeps its blank lines')
  const roCrate = JSON.parse(readFileSync(join(packageDir, 'ro-crate-metadata.json'), 'utf8'))
  assert.equal(roCrate['@context'], 'https://w3id.org/ro/crate/1.1/context')
  assert.ok(roCrate['@graph'].some((node) => node['@id'] === './' && node['@type'] === 'Dataset'))
  const cff = readFileSync(join(packageDir, 'CITATION.cff'), 'utf8')
  assert.match(cff, /cff-version: 1.2.0/)
  assert.match(cff, /license: MIT/)
  const codemeta = JSON.parse(readFileSync(join(packageDir, 'codemeta.json'), 'utf8'))
  assert.equal(codemeta['@type'], 'SoftwareSourceCode')

  // Rebuild is refused without overwrite; verify passes.
  result = await run({ action: 'build', slug: 'paper1' })
  assert.match(result.error, /exists and is not empty/)
  result = await run({ action: 'build', slug: 'paper1', overwrite: true })
  assert.ok(!result.error)
  result = await run({ action: 'verify', slug: 'paper1' })
  assert.equal(result.result.problems.length, 0)
  assert.equal(result.result.ok, result.result.files)

  // Tampering is detected.
  writeFileSync(join(packageDir, 'code', 'src', 'model.py'), 'print("tampered")\n')
  result = await run({ action: 'verify', slug: 'paper1' })
  assert.equal(result.result.problems[0].status, 'changed')
  writeFileSync(join(packageDir, 'code', 'src', 'model.py'), 'print("model")\n')
  result = await run({ action: 'verify', slug: 'paper1' })
  assert.equal(result.result.problems.length, 0)

  // Status.
  result = await run({ action: 'status', slug: 'paper1' })
  assert.equal(result.status.built, true)
  assert.equal(result.status.analyses, 1)
  result = await run({ action: 'status', slug: 'ghost' })
  assert.match(result.error, /no reproducibility plan/)

  // A failed run and a missing license are surfaced as warnings, not hidden.
  workspace.write('analysis/bad.py', 'import sys\nsys.exit(2)\n')
  await freezeAnalysisPlan({ cwd, slug: 'broken', plan: { question: 'Q?' } })
  const failed = await runAnalysis({ cwd, slug: 'broken', kind: 'python', command: ['python3', 'analysis/bad.py'], outputs: [], notebookEntry: null })
  assert.equal(failed.exit_code, 2)
  await run({ action: 'plan', slug: 'paper2', plan: { name: 'Paper Two', authors: ['Solo Author'], analyses: [{ slug: 'broken' }], code_files: ['analysis/bad.py'] } })
  result = await run({ action: 'build', slug: 'paper2' })
  assert.ok(result.package.warnings.some((warning) => /did not succeed/.test(warning)))
  assert.ok(result.package.warnings.some((warning) => /no license stated/i.test(warning)))

  // Deposit: preview first, blockers, confirmation gate, key gate, fake upload.
  let preview = await direct({ action: 'deposit', slug: 'paper1' })
  assert.equal(preview.action, 'preview')
  assert.equal(preview.preview.metadata.license, 'MIT')
  assert.equal(preview.preview.blockers.length, 0)
  const previewHash = preview.preview.preview_hash
  await assert.rejects(
    () => direct({ action: 'deposit', slug: 'paper1', confirm: true, preview_hash: 'stale' }, { resolveEnv: async () => 'tok' }),
    /confirm: true and the unchanged preview_hash/,
  )
  await assert.rejects(
    () => direct({ action: 'deposit', slug: 'paper1', confirm: true, preview_hash: previewHash }, { resolveEnv: async () => null }),
    /ZENODO_API_KEY is not configured/,
  )
  const calls = []
  const fakeHttp = async (url, options) => {
    calls.push({ url, method: options.method })
    if (url === 'https://zenodo.org/api/deposit/depositions') return { ok: true, json: async () => ({ id: 42, links: { html: 'https://zenodo.org/deposit/42' } }) }
    return { ok: true, json: async () => ({}) }
  }
  result = await direct({ action: 'deposit', slug: 'paper1', confirm: true, preview_hash: previewHash }, { resolveEnv: async () => 'tok', http: fakeHttp })
  assert.equal(result.deposition.published, false)
  assert.equal(result.deposition.deposition_id, 42)
  assert.ok(result.deposition.files_uploaded.length > 10)
  assert.equal(calls[0].url, 'https://zenodo.org/api/deposit/depositions')
  assert.equal(calls[0].method, 'POST')
  // Blocked deposit: paper2 has no license.
  preview = await direct({ action: 'deposit', slug: 'paper2' })
  assert.ok(preview.preview.blockers.some((blocker) => /license/.test(blocker)))
  await assert.rejects(
    () => direct({ action: 'deposit', slug: 'paper2', confirm: true, preview_hash: preview.preview.preview_hash }, { resolveEnv: async () => 'tok' }),
    /deposit blocked/,
  )

  // Direct runner throws.
  await assert.rejects(() => runReproPackage({ action: 'status', slug: 'ghost' }, exec), /no reproducibility plan/)

  console.log('repro_package OK')
} finally {
  workspace.cleanup()
}
