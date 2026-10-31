/**
 * Reproducibility packages: environment, code/data manifest, container spec,
 * metadata, and a reader-facing README for a paper, analysis, or experiment.
 *
 * State lives under `<cwd>/.dsh/repro/<slug>/` (the frozen inventory); the
 * package itself is written to a workspace-relative output directory
 * (default `package/<slug>/`). Building never uploads anything.
 */
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  ensureDir, exportText, hashFile, nowIso, readJson, slug as slugify,
  stableStringify, writeOnceJson, sha256,
} from './ledger-kit.js'
import { resolveWorkspacePath } from './workspace-path.js'

function text(value) {
  return String(value ?? '').trim()
}

function listValue(value, name) {
  if (value == null || value === '') return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function files(cwd, slugValue) {
  const dir = join(cwd, '.dsh', 'repro', slugify(slugValue))
  return { dir, plan: join(dir, 'plan.json') }
}

export function normalizeReproPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('plan must be an object')
  const name = text(input.name || input.title)
  if (!name) throw new Error('plan.name is required (the package title)')
  const authors = listValue(input.authors, 'authors').map((author, index) => {
    if (typeof author === 'string') return { name: author.trim() }
    const given = text(author?.givenNames || author?.given)
    const family = text(author?.familyName || author?.family)
    const display = text(author?.name) || [given, family].filter(Boolean).join(' ')
    if (!display) throw new Error(`authors[${index}] needs a name`)
    return {
      name: display,
      ...(given ? { given } : {}),
      ...(family ? { family } : {}),
      ...(text(author?.orcid) ? { orcid: text(author.orcid) } : {}),
    }
  })
  const refs = (value, key, label) => listValue(value, label).map((entry, index) => {
    if (typeof entry === 'string') return { slug: entry }
    if (!entry || typeof entry !== 'object') throw new Error(`${label}[${index}] must be a slug or object`)
    return { ...entry, [key]: text(entry[key] ?? entry.slug), slug: text(entry.slug ?? entry[key]) }
  })
  const plan = {
    name,
    authors,
    analyses: refs(input.analyses, 'tool', 'analyses'),
    experiments: refs(input.experiments, 'tool', 'experiments'),
    datasets: listValue(input.datasets, 'datasets').map((entry, index) => {
      if (typeof entry === 'string') return { slug: entry }
      if (!entry || typeof entry !== 'object') throw new Error(`datasets[${index}] must be a slug or object`)
      return entry
    }),
    code_files: listValue(input.code_files ?? input.code, 'code_files').map((entry) => {
      const path = typeof entry === 'string' ? entry : text(entry?.path)
      if (!path) throw new Error('code_files entries need a path')
      return path
    }),
    manuscript: text(input.manuscript) || null,
    repo: text(input.repo) || null,
    license: text(input.license) || null,
    funder: text(input.funder) || null,
    citation: text(input.citation) || null,
    output_dir: text(input.output_dir) || join('package', slugify(input.slug || name)),
    include_data: Boolean(input.include_data),
    notes: text(input.notes) || null,
  }
  if (!plan.authors.length) throw new Error('plan.authors needs at least one author')
  return plan
}

export function saveReproPlan({ cwd, slug: slugValue, plan }) {
  const f = files(cwd, slugValue)
  const normalized = { slug: slugify(slugValue), ...normalizeReproPlan({ ...plan, slug: slugValue }), created_at: nowIso() }
  writeOnceJson(f.plan, normalized)
  return normalized
}

export function readReproPlan(cwd, slugValue) {
  const f = files(cwd, slugValue)
  const stored = readJson(f.plan)
  if (!stored) throw new Error(`no reproducibility plan for "${slugify(slugValue)}"`)
  return stored
}

function fileEntry(cwd, abs, rel, role, source) {
  const body = readFileSync(abs)
  return { path: rel, role, bytes: body.length, sha256: `sha256:${hashFile(abs)}`, source }
}

function copyInto(cwd, srcRel, destRel, packageDir, role, source, warnings, entries, capBytes = 1024 * 1024) {
  let abs
  try {
    abs = resolveWorkspacePath(cwd, srcRel)
  } catch (error) {
    warnings.push(`${srcRel}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    warnings.push(`${srcRel}: not found`)
    return null
  }
  if (statSync(abs).size > capBytes) {
    warnings.push(`${srcRel}: larger than ${capBytes} bytes, not copied`)
    return null
  }
  const dest = join(packageDir, destRel)
  ensureDir(dirname(dest))
  copyFileSync(abs, dest)
  const entry = fileEntry(cwd, dest, destRel, role, source)
  entries.push(entry)
  return entry
}

function repoInfo(cwd, declared) {
  if (declared) return declared
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', timeout: 10_000, shell: false })
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000, shell: false })
  const url = remote.status === 0 ? text(remote.stdout) : null
  const sha = commit.status === 0 ? text(commit.stdout) : null
  if (!url && !sha) return null
  return [url, sha && `commit ${sha}`].filter(Boolean).join(' @ ')
}

function dockerfile(environment) {
  return [
    '# Generated by academic-harness repro_package. Evidence of the recorded',
    '# environment — not a guarantee that this image reproduces the analysis.',
    'FROM python:3.13-slim',
    'WORKDIR /work',
    'COPY . /work',
    ...(environment.packages_file
      ? ['RUN pip install --no-deps -r analysis/' + environment.packages_file.split('/').slice(-2).join('/')]
      : ['# no pip freeze captured; install the recorded packages manually']),
    '# Run order is documented in README.md.',
    '',
  ].join('\n')
}

function citationCff(plan, environment) {
  return [
    'cff-version: 1.2.0',
    `title: ${JSON.stringify(plan.name)}`,
    'type: software',
    'authors:',
    ...plan.authors.map((author) => `  - name: ${JSON.stringify(author.name)}`),
    ...(plan.license ? [`license: ${plan.license}`] : ['# license: NOT STATED — resolve before distribution']),
    ...(plan.repo ? [`repository-code: ${JSON.stringify(plan.repo)}`] : []),
    `date-released: ${JSON.stringify(new Date().toISOString().slice(0, 10))}`,
    `references:`,
    `  - note: ${JSON.stringify(`Recorded environment: node ${environment.node}, ${environment.os}`)}`,
    '',
  ].join('\n')
}

function codemetaJson(plan, environment) {
  return {
    '@context': 'https://doi.org/10.5063/schema/codemeta-2.0',
    '@type': 'SoftwareSourceCode',
    name: plan.name,
    author: plan.authors.map((author) => ({ '@type': 'Person', name: author.name, ...(author.orcid ? { identifier: author.orcid } : {}) })),
    license: plan.license || null,
    codeRepository: plan.repo || null,
    funder: plan.funder || null,
    datePublished: new Date().toISOString().slice(0, 10),
    softwareVersion: environment.git_commit || null,
  }
}

function roCrateJson(plan, entries) {
  const parts = entries.map((entry) => ({ '@id': `./${entry.path}`, '@type': 'File', name: entry.path, contentSize: String(entry.bytes), sha256: entry.sha256, 'about': entry.role }))
  return {
    '@context': 'https://w3id.org/ro/crate/1.1/context',
    '@graph': [
      { '@id': './', '@type': 'Dataset', name: plan.name, author: plan.authors.map((author) => ({ '@type': 'Person', name: author.name })), license: plan.license || null, hasPart: parts.map((part) => ({ '@id': part['@id'] })) },
      { '@id': './ro-crate-metadata.json', '@type': 'CreativeWork', conformsTo: 'https://w3id.org/ro/crate/1.1', about: { '@id': './' } },
      ...parts,
    ],
  }
}

export function buildReproPackage({ cwd, slug: slugValue, overwrite = false }) {
  const plan = readReproPlan(cwd, slugValue)
  const outRel = plan.output_dir
  const outAbs = resolveWorkspacePath(cwd, outRel, { forWrite: true })
  if (existsSync(outAbs) && readdirSync(outAbs).length && !overwrite) {
    throw new Error(`${outRel} exists and is not empty; pass overwrite: true to rebuild`)
  }
  ensureDir(outAbs)
  const entries = []
  const warnings = []
  const includedRuns = []
  const includedExperiments = []
  const includedDatasets = []

  for (const reference of plan.analyses) {
    const ledgerDir = join(cwd, '.dsh', 'analysis', slugify(reference.slug))
    if (!existsSync(ledgerDir)) { warnings.push(`analysis "${reference.slug}" not found`); continue }
    const runs = existsSync(join(ledgerDir, 'runs.jsonl'))
      ? readFileSync(join(ledgerDir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []
    const selected = reference.run_id ? runs.filter((run) => run.run_id === reference.run_id) : runs.slice(-1)
    if (!selected.length) { warnings.push(`analysis "${reference.slug}": no matching runs`); continue }
    for (const run of selected) {
      if (run.exit_code !== 0 || run.timed_out) warnings.push(`run ${run.run_id} did not succeed (exit ${run.exit_code ?? 'n/a'}${run.timed_out ? ', timed out' : ''}); included as recorded`)
      const manifestRel = join('analysis', run.slug, `${run.run_id}-manifest.json`)
      const manifestAbs = join(ledgerDir, 'runs', run.run_id, 'manifest.json')
      if (existsSync(manifestAbs)) copyInto(cwd, relative(cwd, manifestAbs), manifestRel, outAbs, 'analysis-manifest', `analysis_run/${run.slug}`, warnings, entries)
      copyInto(cwd, run.stdout, join('analysis', run.slug, `${run.run_id}-stdout.log`), outAbs, 'run-log', `analysis_run/${run.slug}`, warnings, entries, 256 * 1024)
      copyInto(cwd, run.stderr, join('analysis', run.slug, `${run.run_id}-stderr.log`), outAbs, 'run-log', `analysis_run/${run.slug}`, warnings, entries, 256 * 1024)
      if (run.environment?.packages_file) {
        copyInto(cwd, run.environment.packages_file, join('environment', `${run.slug}-packages.txt`), outAbs, 'environment', `analysis_run/${run.slug}`, warnings, entries)
      }
      includedRuns.push({ slug: run.slug, run_id: run.run_id, plan_hash: run.plan_hash, exit_code: run.exit_code, command: run.command })
    }
  }

  for (const reference of plan.experiments) {
    const ledgerDir = join(cwd, '.dsh', 'experiments', slugify(reference.slug))
    if (!existsSync(join(ledgerDir, 'experiment.json'))) { warnings.push(`experiment "${reference.slug}" not found`); continue }
    copyInto(cwd, relative(cwd, join(ledgerDir, 'experiment.json')), join('experiments', `${slugify(reference.slug)}-experiment.json`), outAbs, 'experiment-definition', `experiment_log/${reference.slug}`, warnings, entries)
    if (existsSync(join(ledgerDir, 'runs.jsonl'))) {
      copyInto(cwd, relative(cwd, join(ledgerDir, 'runs.jsonl')), join('experiments', `${slugify(reference.slug)}-runs.jsonl`), outAbs, 'experiment-runs', `experiment_log/${reference.slug}`, warnings, entries)
    }
    includedExperiments.push({ slug: slugify(reference.slug) })
  }

  for (const reference of plan.datasets) {
    const slug = slugify(reference.slug || reference.doi || '')
    const manifest = join(cwd, '.dsh', 'data', slug, 'manifest.jsonl')
    if (!existsSync(manifest)) { warnings.push(`dataset "${slug}": no dataset_get manifest found`); continue }
    const events = readFileSync(manifest, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const latest = events.at(-1)
    includedDatasets.push({ slug, doi: latest?.doi ?? null, license: latest?.license ?? null, files: (latest?.files || []).filter((file) => file.status === 'downloaded').length })
    if (plan.include_data) {
      for (const file of (latest?.files || []).filter((entry) => entry.status === 'downloaded')) {
        copyInto(cwd, file.path, join('data', slug, file.name), outAbs, 'data', `dataset_get/${slug}`, warnings, entries, 64 * 1024 * 1024)
      }
    } else {
      warnings.push(`dataset "${slug}": data not copied (include_data is false); readers download from ${latest?.doi ? `https://doi.org/${latest.doi}` : 'the recorded landing page'}`)
    }
  }

  for (const path of plan.code_files) {
    copyInto(cwd, path, join('code', path), outAbs, 'code', 'workspace', warnings, entries)
  }
  if (plan.manuscript) copyInto(cwd, plan.manuscript, join('manuscript', plan.manuscript.split('/').pop()), outAbs, 'manuscript', 'workspace', warnings, entries)

  const environment = {
    captured_at: nowIso(),
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    git_commit: (() => {
      const probe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000, shell: false })
      return probe.status === 0 ? text(probe.stdout) : null
    })(),
    packages_file: entries.find((entry) => entry.role === 'environment')?.path || null,
    runs: includedRuns,
  }
  const repo = repoInfo(cwd, plan.repo)
  if (!plan.license) warnings.push('no license stated — flag for the authors before distribution')
  if (!repo) warnings.push('no repository recorded and no git remote found')

  const manifest = {
    slug: plan.slug,
    name: plan.name,
    created_at: nowIso(),
    authors: plan.authors,
    license: plan.license || null,
    funder: plan.funder || null,
    citation: plan.citation || null,
    repo,
    environment,
    experiments: includedExperiments,
    datasets: includedDatasets,
    include_data: plan.include_data,
    files: entries,
    warnings,
    note: 'Reproducibility evidence: recorded environment, manifests, and hashes. Not a guarantee that the result is correct or that this package reproduces it.',
  }
  const writeMeta = (name, body) => {
    const abs = join(outAbs, name)
    const written = exportText(abs, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`, { overwrite: true })
    entries.push({ path: name, role: 'package-metadata', bytes: written.bytes, sha256: `sha256:${hashFile(abs)}`, source: 'repro_package' })
  }
  const readme = [
    `# ${plan.name} — reproducibility package`,
    '',
    `Built ${manifest.created_at} by academic-harness \`repro_package\`.`,
    '',
    '## Run order',
    '',
    ...(includedRuns.length ? includedRuns.map((run) => `1. \`${run.command.join(' ')}\` (analysis "${run.slug}", ${run.run_id}, recorded exit ${run.exit_code ?? 'n/a'})`) : ['1. _no analysis runs included_']),
    '',
    '## Expected outputs',
    '',
    ...(entries.filter((entry) => entry.role === 'analysis-manifest').length
      ? ['See `analysis/*-manifest.json`: each records the command, hashed inputs/outputs, environment, and exit status of one run.']
      : ['_none recorded_']),
    '',
    '## Data availability',
    '',
    ...(includedDatasets.length
      ? includedDatasets.map((dataset) => `- ${dataset.slug}: ${dataset.doi ? `https://doi.org/${dataset.doi}` : '(no DOI)'} · license ${dataset.license || 'not stated'}${plan.include_data ? ' · files copied under data/' : ' · download required'}`)
      : ['_no dataset_get records included_']),
    '',
    `## License`,
    '',
    plan.license || 'NOT STATED — resolve before redistribution.',
    '',
    ...(plan.citation ? ['## Citation', '', plan.citation, ''] : []),
    '## Caveats',
    '',
    '- This package is evidence of the recorded environment and artifacts, not a guarantee of replication or correctness.',
    '- `Dockerfile` is generated from the recorded environment and is not built or tested by the tool.',
    '- Checks the tool cannot run (external service versions, hardware nondeterminism) are not covered.',
  ].join('\n')
  writeMeta('README.md', readme)
  writeMeta('CITATION.cff', citationCff(plan, environment))
  writeMeta('codemeta.json', codemetaJson(plan, environment))
  writeMeta('ro-crate-metadata.json', roCrateJson(plan, entries))
  writeMeta('Dockerfile', dockerfile(environment))
  writeMeta('environment/environment.json', environment)
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`
  writeMeta('manifest.json', manifestBody)
  const checksums = entries
    .filter((entry) => entry.path !== 'checksums.sha256')
    .map((entry) => `${entry.sha256.slice(7)}  ${entry.path}`)
    .sort()
    .join('\n')
  const checksumsAbs = join(outAbs, 'checksums.sha256')
  exportText(checksumsAbs, `${checksums}\n`, { overwrite: true })
  entries.push({ path: 'checksums.sha256', role: 'package-metadata', bytes: Buffer.byteLength(`${checksums}\n`), sha256: `sha256:${hashFile(checksumsAbs)}`, source: 'repro_package' })

  return {
    slug: plan.slug,
    path: outRel,
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    warnings,
    manifest_hash: `sha256:${sha256(stableStringify(manifest))}`,
  }
}

export function verifyReproPackage({ cwd, slug: slugValue }) {
  const plan = readReproPlan(cwd, slugValue)
  const outAbs = resolveWorkspacePath(cwd, plan.output_dir)
  const manifestPath = join(outAbs, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`no built package at ${plan.output_dir}; run build first`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const results = manifest.files.map((entry) => {
    const abs = join(outAbs, entry.path)
    if (!existsSync(abs)) return { path: entry.path, status: 'missing' }
    return { path: entry.path, status: `sha256:${hashFile(abs)}` === entry.sha256 ? 'ok' : 'changed' }
  })
  return {
    slug: plan.slug,
    path: plan.output_dir,
    built_at: manifest.created_at,
    files: results.length,
    ok: results.filter((entry) => entry.status === 'ok').length,
    problems: results.filter((entry) => entry.status !== 'ok'),
    warnings: manifest.warnings || [],
  }
}

export function reproStatus(cwd, slugValue) {
  const plan = readReproPlan(cwd, slugValue)
  const outAbs = resolveWorkspacePath(cwd, plan.output_dir)
  const built = existsSync(join(outAbs, 'manifest.json'))
  return {
    slug: plan.slug,
    name: plan.name,
    output_dir: plan.output_dir,
    built,
    analyses: plan.analyses.length,
    experiments: plan.experiments.length,
    datasets: plan.datasets.length,
    code_files: plan.code_files.length,
    license: plan.license,
    include_data: plan.include_data,
  }
}

export function reproDepositPreview(cwd, slugValue) {
  const plan = readReproPlan(cwd, slugValue)
  const outAbs = resolveWorkspacePath(cwd, plan.output_dir)
  const manifestPath = join(outAbs, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`no built package at ${plan.output_dir}; run build first`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const files = manifest.files.map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }))
  const metadata = {
    title: manifest.name,
    creators: manifest.authors.map((author) => ({ name: author.name })),
    description: `Reproducibility package for ${manifest.name}. Built by academic-harness; evidence of the recorded environment and artifacts, not a guarantee of replication.`,
    license: manifest.license || null,
    keywords: ['reproducibility', 'academic-harness'],
    upload_type: 'other',
  }
  const previewHash = `sha256:${sha256(stableStringify({ metadata, files }))}`
  const blockers = []
  if (!metadata.license) blockers.push('license is not stated; Zenodo requires one')
  if (manifest.warnings?.some((warning) => /did not succeed/.test(warning))) blockers.push('an included run did not succeed')
  return {
    slug: plan.slug,
    target: 'zenodo',
    metadata,
    files,
    total_bytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    blockers,
    preview_hash: previewHash,
    note: 'Deposit creates a DRAFT deposition only; publishing stays a deliberate human action on zenodo.org.',
  }
}

export async function depositReproPackage({
  cwd, slug: slugValue, confirm, previewHash, http = (url, options) => fetch(url, options), token,
}) {
  const preview = reproDepositPreview(cwd, slugValue)
  if (!token) {
    const error = new Error('ZENODO_API_KEY is not configured; nothing was uploaded')
    error.code = 'key_missing'
    throw error
  }
  if (!confirm || previewHash !== preview.preview_hash) {
    const error = new Error('deposit needs confirm: true and the unchanged preview_hash from the preview (pass preview: true first)')
    error.code = 'confirmation_required'
    error.preview = preview
    throw error
  }
  if (preview.blockers.length) {
    const error = new Error(`deposit blocked: ${preview.blockers.join('; ')}`)
    error.code = 'blocked'
    throw error
  }
  const outAbs = resolveWorkspacePath(cwd, readReproPlan(cwd, slugValue).output_dir)
  const created = await http('https://zenodo.org/api/deposit/depositions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ metadata: preview.metadata }),
  })
  const createdJson = await created.json().catch(() => null)
  if (!created.ok) throw new Error(`zenodo deposition create failed: HTTP ${created.status}${createdJson?.message ? ` — ${createdJson.message}` : ''}`)
  const depositionId = createdJson?.id
  const uploaded = []
  for (const entry of preview.files) {
    const body = readFileSync(join(outAbs, entry.path))
    const response = await http(`https://zenodo.org/api/deposit/depositions/${depositionId}/files?name=${encodeURIComponent(entry.path)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body,
    })
    if (!response.ok) throw new Error(`zenodo upload failed for ${entry.path}: HTTP ${response.status}`)
    uploaded.push(entry.path)
  }
  return {
    slug: preview.slug,
    target: 'zenodo',
    deposition_id: depositionId,
    files_uploaded: uploaded,
    html_url: createdJson?.links?.html || null,
    published: false,
    note: 'Draft deposited. Review it at html_url and publish manually; this tool never publishes for you.',
  }
}
