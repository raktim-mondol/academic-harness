import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyModalRun } from '../modal-run.js'
import { DEFAULT_MODAL_INSTANCE_ID, MODAL_INSTANCES, MODAL_INSTANCE_IDS, resolveModalInstance } from '../modal-instances.js'
import { applyRunpodRun } from '../runpod-run.js'
import {
  DEFAULT_RUNPOD_INSTANCE_ID,
  RUNPOD_INSTANCES,
  RUNPOD_INSTANCE_IDS,
  buildRunpodCreateBody,
  resolveRunpodInstance,
} from '../runpod-instances.js'
import { applyVastaiRun } from '../vastai-run.js'
import {
  DEFAULT_VASTAI_INSTANCE_ID,
  VASTAI_INSTANCES,
  VASTAI_INSTANCE_IDS,
  buildVastCreateBody,
  buildVastSearchBody,
  resolveVastaiInstance,
} from '../vastai-instances.js'
import { KEY_FIELDS } from '../settings-keys.js'
import { resolveWorkspacePath } from '../workspace-path.js'
import { tarDownloadDir, tarUploadDir } from '../ssh-client.js'
import { patchAcademicHarnessProfiles, patchAllowBuilds } from '../pnpm-workspace.js'

const here = dirname(fileURLToPath(import.meta.url))
let checks = 0
async function check(name, fn) {
  await fn()
  checks++
  console.log(`ok ${checks} - ${name}`)
}

function assertCatalogs(instances, ids, defaultId, resolver) {
  assert.equal(ids.length, instances.length)
  assert.equal(new Set(ids).size, ids.length, 'instance ids are unique')
  assert.ok(ids.includes(defaultId), 'default instance is in the catalog')
  for (const spec of instances) {
    assert.ok(spec.label, `${spec.id} has a label`)
    assert.ok(spec.defaultImage, `${spec.id} has a default image`)
    assert.equal(resolver(spec.id), spec)
  }
}

await check('runpod catalog is consistent', () => assertCatalogs(RUNPOD_INSTANCES, RUNPOD_INSTANCE_IDS, DEFAULT_RUNPOD_INSTANCE_ID, resolveRunpodInstance))
await check('modal catalog is consistent', () => assertCatalogs(MODAL_INSTANCES, MODAL_INSTANCE_IDS, DEFAULT_MODAL_INSTANCE_ID, resolveModalInstance))
await check('vastai catalog is consistent', () => assertCatalogs(VASTAI_INSTANCES, VASTAI_INSTANCE_IDS, DEFAULT_VASTAI_INSTANCE_ID, resolveVastaiInstance))
await check('vastai defaults to an SSH-capable official image', () => {
  for (const spec of VASTAI_INSTANCES) assert.match(spec.defaultImage, /^vastai\//, `${spec.id} image`)
})

await check('every modal GPU instance defaults to CUDA image, CPU stays slim', () => {
  for (const spec of MODAL_INSTANCES) {
    if (spec.gpu) assert.match(spec.defaultImage, /cuda/i, `${spec.id} needs a CUDA image`)
    else assert.match(spec.defaultImage, /^python:/i, `${spec.id} should stay a slim Python image`)
  }
  for (const spec of MODAL_INSTANCES) {
    if (!spec.gpu) continue
    assert.ok(!/^python:/.test(spec.defaultImage), `${spec.id} must not default to a CUDA-free python image`)
  }
})

await check('runpod GPU create body uses the v2 nested gpu shape', () => {
  const spec = resolveRunpodInstance('h100')
  const body = buildRunpodCreateBody({
    spec,
    imageName: spec.defaultImage,
    publicKey: 'ssh-ed25519 AAAA test',
    cloudType: 'SECURE',
    podName: 'dshrc-test',
    volume: null,
  })
  assert.deepEqual(body.gpu, { id: 'NVIDIA H100 80GB HBM3', count: 1 })
  assert.equal(body.cpu, undefined)
  assert.equal(body.disk, spec.containerDiskInGb)
  assert.deepEqual(body.ports, ['22/tcp'])
  assert.equal(body.startSsh, true)
  assert.equal(body.cloud, 'SECURE')
  assert.equal(body.imageName, undefined, 'v1 field name must not leak')
  assert.equal(body.containerDiskInGb, undefined, 'v1 field name must not leak')
  assert.equal(body.gpuTypeIds, undefined, 'v1 field name must not leak')
})

await check('runpod CPU create body uses a valid v2 flavor and vcpu count', () => {
  const spec = resolveRunpodInstance('cpu')
  const body = buildRunpodCreateBody({
    spec,
    imageName: spec.defaultImage,
    publicKey: 'ssh-ed25519 AAAA test',
    cloudType: 'COMMUNITY',
    podName: 'dshrc-test',
    volume: null,
  })
  assert.deepEqual(body.cpu, { id: 'cpu5c', vcpuCount: 2 })
  assert.equal(body.gpu, undefined)
  assert.equal(body.computeType, undefined, 'v1 field name must not leak')
  assert.equal(body.cpuFlavorIds, undefined, 'v1 field name must not leak')
  assert.ok([2, 4, 8, 16].includes(body.cpu.vcpuCount), 'vcpuCount must be a power of two')
  assert.match(body.image, /^runpod\/base:/)
  assert.ok(!body.image.includes('0.6.2-ubuntu2204'), 'the nonexistent runpod/base tag must not be used')
})

await check('runpod network volume pins placement and mounts at /workspace', () => {
  const spec = resolveRunpodInstance('rtx4090')
  const body = buildRunpodCreateBody({
    spec,
    imageName: spec.defaultImage,
    publicKey: 'ssh-ed25519 AAAA test',
    cloudType: 'COMMUNITY',
    podName: 'dshrc-test',
    volume: { id: 'vol_123', dataCenter: 'EU-RO-1', created: false },
  })
  assert.deepEqual(body.mounts, { network: [{ volumeId: 'vol_123', path: '/workspace' }] })
  assert.deepEqual(body.dataCenterIds, ['EU-RO-1'])
})

await check('vast search body encodes filters, spot type, and pricing cap', () => {
  const spec = resolveVastaiInstance('h100')
  const body = buildVastSearchBody({ spec, numGpus: 2, maxPricePerHour: 3.5, spot: true })
  assert.deepEqual(body.gpu_name, { in: ['H100_SXM', 'H100_PCIE'] })
  assert.deepEqual(body.num_gpus, { eq: 2 })
  assert.deepEqual(body.verified, { eq: true })
  assert.deepEqual(body.rentable, { eq: true })
  assert.equal(body.type, 'bid')
  assert.deepEqual(body.order, [['dph_total', 'asc']])
  assert.deepEqual(body.dph_total, { lte: 3.5 })
  assert.equal(body.limit, 8)
})

await check('vast create body uses ssh_direct and only sends price for spot', () => {
  const spec = resolveVastaiInstance('rtx4090')
  const onDemand = buildVastCreateBody({ spec, image: spec.defaultImage, diskGb: 50, label: 'x' })
  assert.equal(onDemand.runtype, 'ssh_direct')
  assert.equal(onDemand.disk, 50)
  assert.equal(onDemand.price, undefined)
  assert.equal(onDemand.target_state, 'running')
  assert.equal(onDemand.cancel_unavail, true)

  const spot = buildVastCreateBody({ spec, image: spec.defaultImage, diskGb: 50, label: 'x', spotPrice: 0.22 })
  assert.equal(spot.price, 0.22)

  const withVolume = buildVastCreateBody({ spec, image: spec.defaultImage, diskGb: 50, label: 'x', volumeId: 12345 })
  assert.deepEqual(withVolume.volume_info, { create_new: false, volume_id: 12345, mount_path: '/workspace' })
})

await check('all three tools register with distinct names and a required command', () => {
  const tools = []
  const ctx = { tools: { register: (tool) => tools.push(tool) } }
  applyModalRun(ctx)
  applyRunpodRun(ctx)
  applyVastaiRun(ctx)
  assert.deepEqual(tools.map((t) => t.name), ['modal_run', 'runpod_run', 'vastai_run'])
  assert.equal(new Set(tools.map((t) => t.name)).size, 3)
  for (const tool of tools) {
    const props = tool.parameters.properties
    assert.equal(props.command.type, 'string', `${tool.name} command is a string`)
    assert.ok(tool.parameters.required.includes('command'), `${tool.name} requires command`)
    assert.ok(props.instance.enum.length > 1, `${tool.name} exposes an instance enum`)
    assert.ok(props.files_in && props.files_out, `${tool.name} supports files`)
    assert.ok(String(tool.description).length > 80)
  }
  const vast = tools.find((t) => t.name === 'vastai_run').parameters.properties
  assert.ok(vast.bid_price, 'vastai_run exposes spot bidding')
  assert.ok(vast.volume_id, 'vastai_run exposes volumes')
  const modal = tools.find((t) => t.name === 'modal_run').parameters.properties
  assert.ok(modal.volume_name, 'modal_run exposes persistent volumes')
})

await check('workspace paths reject the root, traversal, and symlink escapes', () => {
  const base = mkdtempSync(join(tmpdir(), 'ah-path-test-'))
  const ws = join(base, 'ws')
  const outside = join(base, 'outside')
  mkdirSync(ws)
  mkdirSync(outside)
  writeFileSync(join(ws, 'ok.txt'), 'ok')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  symlinkSync(outside, join(ws, 'link'))
  try {
    assert.equal(resolveWorkspacePath(ws, 'ok.txt'), join(ws, 'ok.txt'))
    assert.equal(resolveWorkspacePath(ws, 'sub/new.txt', { forWrite: true }), join(ws, 'sub/new.txt'))
    for (const rel of ['.', '', '..', '../outside/secret.txt', 'sub/..']) {
      assert.throws(() => resolveWorkspacePath(ws, rel), /workspace/, `must reject ${JSON.stringify(rel)}`)
    }
    assert.throws(() => resolveWorkspacePath(ws, 'link/secret.txt'), /workspace/, 'must reject symlink escape')
    assert.throws(() => resolveWorkspacePath(ws, 'link/new.txt', { forWrite: true }), /workspace/, 'must reject symlink escape on write')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

await check('failed transfers reject and leave the previous output intact', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ah-transfer-test-'))
  const localDir = join(base, 'out')
  const uploadDir = join(base, 'in')
  mkdirSync(localDir)
  mkdirSync(uploadDir)
  writeFileSync(join(localDir, 'keep.txt'), 'keep')
  writeFileSync(join(uploadDir, 'data.txt'), 'data')
  const ssh = { host: '127.0.0.1', port: 1, username: 'root' }
  try {
    await assert.rejects(tarDownloadDir(join(base, 'missing-key'), ssh, '/workspace/out', localDir, undefined, 10_000))
    assert.equal(readFileSync(join(localDir, 'keep.txt'), 'utf8'), 'keep', 'previous output must survive a failed download')
    await assert.rejects(tarUploadDir(join(base, 'missing-key'), ssh, uploadDir, '/workspace/in', undefined, 10_000))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

await check('pnpm allowBuilds patch handles block, inline, and idempotent cases', () => {
  const empty = patchAllowBuilds('')
  assert.match(empty.text, /cbor-extract: false/)
  assert.match(empty.text, /protobufjs: false/)

  const block = patchAllowBuilds('packages:\n  - .\n\nallowBuilds:\n  cbor-extract: true\n')
  assert.match(block.text, /cbor-extract: true/, 'existing decision is preserved')
  assert.match(block.text, /protobufjs: false/)
  assert.equal(patchAllowBuilds(block.text).changed, false, 'block patch is idempotent')

  const inline = patchAllowBuilds('allowBuilds: { cbor-extract: false }\n')
  assert.match(inline.text, /cbor-extract: false/)
  assert.match(inline.text, /protobufjs: false/)
  assert.equal(patchAllowBuilds(inline.text).changed, false, 'inline patch is idempotent')

  const fourSpace = patchAllowBuilds('allowBuilds:\n    cbor-extract: false\n')
  assert.match(fourSpace.text, /^    protobufjs: false$/m, 'inserted entries follow the existing indentation')

  const unrelated = patchAllowBuilds('packages:\n  - .\n')
  assert.match(unrelated.text, /^packages:/)
  assert.match(unrelated.text, /allowBuilds:/)
})

await check('profile patch touches only academic-harness profiles and is idempotent', () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-pnpm-profiles-'))
  try {
    mkdirSync(join(home, 'profiles', 'ah'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'other'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'ah', 'package.json'), JSON.stringify({
      dependencies: { 'academic-harness': 'github:raktim-mondol/academic-harness' },
    }))
    writeFileSync(join(home, 'profiles', 'other', 'package.json'), JSON.stringify({ dependencies: { other: '1.0.0' } }))
    const first = patchAcademicHarnessProfiles(home)
    assert.deepEqual(first, [join(home, 'profiles', 'ah')])
    assert.ok(existsSync(join(home, 'profiles', 'ah', 'pnpm-workspace.yaml')))
    assert.ok(!existsSync(join(home, 'profiles', 'other', 'pnpm-workspace.yaml')))
    assert.deepEqual(patchAcademicHarnessProfiles(home), [], 'second pass is a no-op')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await check('managed Modal runtime respects the skip-install switch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ah-modal-runtime-'))
  const prevHome = process.env.DSH_HOME
  const prevSkip = process.env.ACADEMIC_HARNESS_MODAL_SKIP_INSTALL
  process.env.DSH_HOME = home
  process.env.ACADEMIC_HARNESS_MODAL_SKIP_INSTALL = '1'
  try {
    const { ensureModalSdk } = await import('../modal-runtime.js')
    try {
      const sdk = await ensureModalSdk()
      assert.equal(typeof sdk.ModalClient, 'function', 'profile-installed SDK is used when present')
    } catch (error) {
      assert.equal(error.code, 'sdk_missing', 'skip switch reports sdk_missing, not an install')
    }
    assert.ok(!existsSync(join(home, 'modal-sdk')), 'skip switch must not install anything')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    if (prevSkip === undefined) delete process.env.ACADEMIC_HARNESS_MODAL_SKIP_INSTALL
    else process.env.ACADEMIC_HARNESS_MODAL_SKIP_INSTALL = prevSkip
    rmSync(home, { recursive: true, force: true })
  }
})

await check('remote-compute credentials are registered in settings', () => {
  for (const field of ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'RUNPOD_API_KEY', 'VAST_API_KEY']) {
    assert.ok(KEY_FIELDS.includes(field), `${field} missing from Settings`)
  }
})

await check('package.json ships every compute module and exports the tools', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  for (const file of [
    'modal-run.js', 'modal-instances.js',
    'runpod-run.js', 'runpod-client.js', 'runpod-instances.js',
    'vastai-run.js', 'vastai-client.js', 'vastai-instances.js',
    'ssh-client.js', 'workspace-path.js', 'modal-runtime.js', 'pnpm-workspace.js',
  ]) {
    assert.ok(pkg.files.includes(file), `${file} missing from files[]`)
  }
  for (const key of ['./modal-run', './runpod-run', './vastai-run', './ssh-client', './workspace-path', './modal-runtime', './pnpm-workspace']) {
    assert.ok(pkg.exports[key], `${key} missing from exports`)
  }
  assert.ok(pkg.peerDependencies.modal.startsWith('^0.11'), 'modal peer dependency is stale')
})

await check('runpod client targets the v2 API and parses problem errors', () => {
  const src = readFileSync(join(here, '..', 'runpod-client.js'), 'utf8')
  assert.match(src, /'https:\/\/api\.runpod\.io\/v2'/, 'v2 base URL is the default')
  assert.ok(!/REST_BASE\s*=\s*process\.env[^\n]*rest\.runpod\.io\/v1/.test(src), 'v1 must not be the default base')
  assert.match(src, /problem|detail|errors/i)
})

console.log(`\n${checks} compute checks passed`)
