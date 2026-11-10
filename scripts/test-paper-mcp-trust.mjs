#!/usr/bin/env node
/**
 * Review A1 (decisions D15/D16): a `.dsh/paper-mcps.json` that arrives with a
 * folder must not start a program until a person approved that exact entry for
 * that workspace. Approvals live under $DSH_HOME, fail closed, and are
 * invalidated by any change to command, args, cwd or env names.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeApproval, fakeHost } from './helpers/fake-host.mjs'

const dshHome = mkdtempSync(join(tmpdir(), 'ah-mcp-trust-home-'))
process.env.DSH_HOME = dshHome
process.env.AH_TEST_ALLOWED_VAR = 'allowed-value'
process.env.AH_TEST_SECRET_VAR = 'secret-value'

const mcp = await import('../paper-mcp.js')
const trust = await import('../paper-mcp-trust.js')

let passed = 0
async function check(label, fn) {
  mcp.resetMountedForTests()
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}

function makeWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'ah-mcp-trust-ws-'))
  const server = join(cwd, 'server.py')
  writeFileSync(server, '# canary\n')
  return { cwd, server, command: process.execPath }
}

function writeRegistry(cwd, servers) {
  mkdirSync(join(cwd, '.dsh'), { recursive: true })
  writeFileSync(join(cwd, '.dsh', 'paper-mcps.json'), JSON.stringify({ schema_version: 1, servers }))
}

function setup({ approval } = {}) {
  const plugins = []
  const services = approval ? { approval } : {}
  const host = fakeHost({ services, extra: { plugin: (mod, cfg) => plugins.push({ mod, cfg }) } })
  return { host, plugins }
}

async function startSession(host, cwd, extra = {}) {
  await mcp.apply(host.ctx)
  host.run('session/created', { header: { cwd, ...extra } })
  await new Promise((r) => setTimeout(r, 50)) // mounts are fire-and-forget promises
}

const exec = (cwd, approvalAgent = true) => ({ agent: approvalAgent ? { session: { header: { cwd } } } : undefined, callId: 'call-1' })
const call = (host, args, cwd, withAgent = true) => mcp.executePaperMcp(args, exec(cwd, withAgent), host.ctx)

await check('a registry that arrives with the folder does not mount at session start', async () => {
  const ws = makeWorkspace()
  writeRegistry(ws.cwd, [{ serverName: 'Evil', command: ws.command, args: [ws.server], cwd: ws.cwd, envNames: ['AH_TEST_SECRET_VAR'] }])
  const { host, plugins } = setup({ approval: fakeApproval(['allowed-once']) })
  await startSession(host, ws.cwd)
  assert.equal(plugins.length, 0, 'nothing may be mounted before approval')
})

await check('a missing script is never mounted, even for an approved-looking entry', async () => {
  const ws = makeWorkspace()
  const entry = { serverName: 'Ghost', command: ws.command, args: [join(ws.cwd, 'nope.py')], cwd: ws.cwd, envNames: [] }
  writeRegistry(ws.cwd, [entry])
  await trust.recordApproval(ws.cwd, mcp.normalizeServer(ws.cwd, entry))
  const { host, plugins } = setup()
  await startSession(host, ws.cwd)
  assert.equal(plugins.length, 0)
})

await check('approve asks with the command and env names, records the approval, and mounts', async () => {
  const ws = makeWorkspace()
  writeRegistry(ws.cwd, [{ serverName: 'Good', command: ws.command, args: [ws.server], cwd: ws.cwd, envNames: ['AH_TEST_ALLOWED_VAR'] }])
  const approval = fakeApproval(['allowed-once'])
  const { host, plugins } = setup({ approval })
  const result = await call(host, { action: 'approve', serverName: 'Good' }, ws.cwd)
  assert.equal(result.error, undefined, JSON.stringify(result))
  assert.equal(result.mounted, true)
  assert.equal(approval.requests.length, 1)
  assert.equal(approval.requests[0].toolName, 'paper_mcp')
  assert.match(approval.requests[0].reason, new RegExp(ws.server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(approval.requests[0].reason, /AH_TEST_ALLOWED_VAR/)
  assert.equal(plugins.length, 1)
  assert.equal(plugins[0].cfg.env.AH_TEST_ALLOWED_VAR, 'allowed-value')
  assert.equal(plugins[0].cfg.env.AH_TEST_SECRET_VAR, undefined, 'an unapproved env name is not resolved')
})

await check('after approval, a later session start mounts the entry without asking again', async () => {
  const ws = makeWorkspace()
  const entry = { serverName: 'Again', command: ws.command, args: [ws.server], cwd: ws.cwd, envNames: [] }
  writeRegistry(ws.cwd, [entry])
  const approval = fakeApproval(['allowed-once'])
  const first = setup({ approval })
  await call(first.host, { action: 'approve', serverName: 'Again' }, ws.cwd)
  mcp.resetMountedForTests()
  const second = setup()
  await startSession(second.host, ws.cwd)
  assert.equal(second.plugins.length, 1)
  assert.equal(approval.requests.length, 1)
})

await check('a rejected or cancelled approval mounts nothing and records nothing', async () => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const ws = makeWorkspace()
    writeRegistry(ws.cwd, [{ serverName: 'No', command: ws.command, args: [ws.server], cwd: ws.cwd, envNames: [] }])
    const { host, plugins } = setup({ approval: fakeApproval([outcome]) })
    const result = await call(host, { action: 'approve', serverName: 'No' }, ws.cwd)
    assert.match(result.error, /not approved/)
    assert.equal(plugins.length, 0)
    const spec = mcp.normalizeServer(ws.cwd, JSON.parse(readFileSync(join(ws.cwd, '.dsh', 'paper-mcps.json'), 'utf8')).servers[0])
    assert.equal(trust.isApproved(ws.cwd, spec), false)
  }
})

await check('with no approval service or no agent, register and approve fail closed', async () => {
  const ws = makeWorkspace()
  const args = { action: 'register', serverName: 'Closed', command: ws.command, args: [ws.server] }
  const noService = setup()
  const a = await call(noService.host, args, ws.cwd)
  assert.match(a.error, /no approval channel/)
  assert.equal(noService.plugins.length, 0)
  assert.equal(existsSync(join(ws.cwd, '.dsh', 'paper-mcps.json')), false, 'nothing is written for an unapproved register')
  const noAgent = setup({ approval: fakeApproval(['allowed-once']) })
  const b = await call(noAgent.host, args, ws.cwd, false)
  assert.match(b.error, /no agent/)
  assert.equal(noAgent.plugins.length, 0)
})

await check('register asks first, then writes and mounts', async () => {
  const ws = makeWorkspace()
  const approval = fakeApproval(['allowed-once'])
  const { host, plugins } = setup({ approval })
  const result = await call(host, { action: 'register', serverName: 'Reg', command: ws.command, args: [ws.server], envNames: ['AH_TEST_ALLOWED_VAR'] }, ws.cwd)
  assert.equal(result.mounted, true, JSON.stringify(result))
  assert.equal(approval.requests.length, 1)
  assert.equal(plugins.length, 1)
})

await check('changing args, cwd or env names invalidates the approval', async () => {
  const ws = makeWorkspace()
  const other = join(ws.cwd, 'other.py')
  writeFileSync(other, '# other\n')
  const base = { serverName: 'Hash', command: ws.command, args: [ws.server], cwd: ws.cwd, envNames: ['AH_TEST_ALLOWED_VAR'] }
  const spec = mcp.normalizeServer(ws.cwd, base)
  await trust.recordApproval(ws.cwd, spec)
  assert.equal(trust.isApproved(ws.cwd, spec), true)
  for (const changed of [
    { ...base, args: [other] },
    { ...base, envNames: ['AH_TEST_ALLOWED_VAR', 'AH_TEST_SECRET_VAR'] },
    { ...base, serverName: 'Hash2' },
  ]) {
    assert.equal(trust.isApproved(ws.cwd, mcp.normalizeServer(ws.cwd, changed)), false)
  }
  // env name order is not significant
  assert.equal(trust.isApproved(ws.cwd, mcp.normalizeServer(ws.cwd, { ...base, envNames: ['AH_TEST_ALLOWED_VAR', 'AH_TEST_ALLOWED_VAR'] })), true)
  // approval is per workspace
  const elsewhere = makeWorkspace()
  assert.equal(trust.isApproved(elsewhere.cwd, spec), false)
})

await check('an edited registry entry stops mounting at the next session start', async () => {
  const ws = makeWorkspace()
  const entry = { serverName: 'Edit', command: ws.command, args: [ws.server], cwd: ws.cwd, envNames: [] }
  writeRegistry(ws.cwd, [entry])
  await call(setup({ approval: fakeApproval(['allowed-once']) }).host, { action: 'approve', serverName: 'Edit' }, ws.cwd)
  mcp.resetMountedForTests()
  writeRegistry(ws.cwd, [{ ...entry, envNames: ['AH_TEST_SECRET_VAR'] }])
  const { host, plugins } = setup()
  await startSession(host, ws.cwd)
  assert.equal(plugins.length, 0)
})

await check('status shows pending approval, and approvals are stored outside the workspace', async () => {
  const ws = makeWorkspace()
  writeRegistry(ws.cwd, [{ serverName: 'Pend', command: ws.command, args: [ws.server], cwd: ws.cwd, envNames: [] }])
  const { host } = setup({ approval: fakeApproval(['allowed-once']) })
  const before = await call(host, { action: 'status' }, ws.cwd)
  assert.equal(before.servers[0].approved, false)
  assert.match(before.servers[0].hint, /pending approval/)
  await call(host, { action: 'approve', serverName: 'Pend' }, ws.cwd)
  const after = await call(host, { action: 'status' }, ws.cwd)
  assert.equal(after.servers[0].approved, true)
  assert.ok(existsSync(trust.approvalsFile()))
  assert.ok(trust.approvalsFile().startsWith(dshHome))
  assert.equal(readdirNames(ws.cwd).includes('approvals.json'), false)
})

await check('unregister forgets the approval', async () => {
  const ws = makeWorkspace()
  const { host } = setup({ approval: fakeApproval(['allowed-once']) })
  await call(host, { action: 'register', serverName: 'Gone', command: ws.command, args: [ws.server] }, ws.cwd)
  const spec = mcp.normalizeServer(ws.cwd, { serverName: 'Gone', command: ws.command, args: [ws.server] })
  assert.equal(trust.isApproved(ws.cwd, spec), true)
  await call(host, { action: 'unregister', serverName: 'Gone' }, ws.cwd)
  assert.equal(trust.isApproved(ws.cwd, spec), false)
})

await check('a damaged approvals file approves nothing instead of throwing', async () => {
  const ws = makeWorkspace()
  const spec = mcp.normalizeServer(ws.cwd, { serverName: 'Bad', command: ws.command, args: [ws.server] })
  await trust.recordApproval(ws.cwd, spec)
  writeFileSync(trust.approvalsFile(), '{not json')
  assert.equal(trust.isApproved(ws.cwd, spec), false)
})

await check('subagent sessions are still skipped', async () => {
  const ws = makeWorkspace()
  const entry = { serverName: 'Sub', command: ws.command, args: [ws.server], cwd: ws.cwd, envNames: [] }
  writeRegistry(ws.cwd, [entry])
  await trust.recordApproval(ws.cwd, mcp.normalizeServer(ws.cwd, entry))
  const { host, plugins } = setup()
  await startSession(host, ws.cwd, { origin: 'subagent' })
  assert.equal(plugins.length, 0)
})

function readdirNames(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      out.push(entry.name)
      if (entry.isDirectory()) walk(join(d, entry.name))
    }
  }
  walk(dir)
  return out
}

rmSync(dshHome, { recursive: true, force: true })
if (process.exitCode) console.error('paper-mcp trust: FAILED')
else console.log(`paper-mcp trust: ${passed} checks passed`)
