#!/usr/bin/env node
/**
 * Review A8 (decision D33): SSH to rented machines ran with
 * StrictHostKeyChecking=no and known-hosts sent to /dev/null, so nothing was
 * ever checked. Now each run trusts a host key on first use and holds it for the
 * rest of that run: StrictHostKeyChecking=accept-new with a per-run known_hosts
 * file, so a different key for the same host mid-run is a hard failure.
 *
 * Fake ssh / scp binaries on PATH record their arguments; no network is used.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(homedir(), '.cache', 'ah-ssh-test-'))
const bin = join(scratch, 'bin')
const log = join(scratch, 'calls.jsonl')
mkdirSync(bin)
for (const name of ['ssh', 'scp']) {
  const file = join(bin, name)
  writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: ${JSON.stringify(name)}, args: process.argv.slice(2) }) + '\\n')
if (process.env.FAKE_SSH_STDERR) process.stderr.write(process.env.FAKE_SSH_STDERR)
process.stdin.resume(); process.stdin.on('end', () => process.exit(Number(process.env.FAKE_SSH_EXIT || 0)))
if (process.stdin.isTTY) process.exit(Number(process.env.FAKE_SSH_EXIT || 0))
setTimeout(() => process.exit(Number(process.env.FAKE_SSH_EXIT || 0)), 400)
`)
  chmodSync(file, 0o755)
}
process.env.PATH = `${bin}:${process.env.PATH}`

const client = await import('../ssh-client.js')
const { sshExec, scpUpload, scpDownload, tarUploadDir, tarDownloadDir, knownHostsFile, forgetHostKeys } = client

let passed = 0
async function check(label, fn) {
  rmSync(log, { force: true })
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL  ${label}\n${error.stack}`)
    process.exitCode = 1
  }
}
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const optionOf = (args, name) => args.filter((a, i) => args[i - 1] === '-o' && a.startsWith(`${name}=`)).map((a) => a.slice(name.length + 1))
const keyPath = join(scratch, 'id_ed25519')
writeFileSync(keyPath, 'not a real key')

await check('ssh exec trusts on first use with a per-run known_hosts file', async () => {
  const ssh = { host: '203.0.113.9', port: 2222, username: 'root' }
  await sshExec(keyPath, ssh, 'echo hi', { timeoutMs: 5000, retries: 1 })
  const [call] = calls()
  assert.deepEqual(optionOf(call.args, 'StrictHostKeyChecking'), ['accept-new'])
  assert.deepEqual(optionOf(call.args, 'UserKnownHostsFile'), [knownHostsFile(ssh)])
  assert.deepEqual(optionOf(call.args, 'GlobalKnownHostsFile'), ['/dev/null'])
  assert.ok(!call.args.includes('StrictHostKeyChecking=no'))
  forgetHostKeys(ssh)
})

await check('scp, directory upload and directory download use the same options', async () => {
  const ssh = { host: '203.0.113.9', port: 2222, username: 'root' }
  const local = join(scratch, 'payload')
  mkdirSync(local, { recursive: true })
  writeFileSync(join(local, 'f.txt'), 'x')
  await scpUpload(keyPath, ssh, join(local, 'f.txt'), '/workspace/f.txt', { timeoutMs: 5000 }).catch(() => {})
  await scpDownload(keyPath, ssh, '/workspace/f.txt', join(scratch, 'f.out'), { timeoutMs: 5000 }).catch(() => {})
  await tarUploadDir(keyPath, ssh, local, '/workspace/payload', undefined, 5000).catch(() => {})
  await tarDownloadDir(keyPath, ssh, '/workspace/out', join(scratch, 'out'), undefined, 5000).catch(() => {})
  const seen = calls()
  assert.deepEqual(seen.map((c) => c.tool).sort(), ['scp', 'scp', 'ssh', 'ssh'])
  const file = knownHostsFile(ssh)
  for (const call of seen) {
    assert.deepEqual(optionOf(call.args, 'StrictHostKeyChecking'), ['accept-new'], `${call.tool}`)
    assert.deepEqual(optionOf(call.args, 'UserKnownHostsFile'), [file], `${call.tool}`)
    assert.ok(!call.args.some((a) => /StrictHostKeyChecking=no$/.test(a)), `${call.tool} still disables checking`)
    assert.ok(!optionOf(call.args, 'UserKnownHostsFile').includes('/dev/null'), `${call.tool} still discards known hosts`)
  }
  forgetHostKeys(ssh)
})

await check('a supplied known_hosts file wins over the generated one', async () => {
  const mine = join(scratch, 'mine_known_hosts')
  const ssh = { host: 'h', port: 22, knownHostsFile: mine }
  await sshExec(keyPath, ssh, 'true', { timeoutMs: 5000, retries: 1 })
  assert.deepEqual(optionOf(calls()[0].args, 'UserKnownHostsFile'), [mine])
})

await check('the generated file is private, empty, per endpoint, and removed on request', () => {
  const a = { host: 'a', port: 22 }
  const b = { host: 'a', port: 22 }
  const fileA = knownHostsFile(a)
  const fileB = knownHostsFile(b)
  assert.notEqual(fileA, fileB, 'two runs must never share trust')
  assert.equal(knownHostsFile(a), fileA, 'stable within one run')
  assert.equal(readFileSync(fileA, 'utf8'), '')
  assert.equal(statSync(fileA).mode & 0o077, 0, 'known_hosts must not be group/world accessible')
  assert.equal(statSync(join(fileA, '..')).mode & 0o077, 0, 'its directory must be private')
  forgetHostKeys(a)
  assert.equal(existsSync(fileA), false)
  assert.equal(existsSync(fileB), true)
  forgetHostKeys(b)
  assert.doesNotThrow(() => forgetHostKeys(b), 'forgetting twice is harmless')
})

await check('a changed host key is a clear, non-retried failure, not a command result', async () => {
  process.env.FAKE_SSH_EXIT = '255'
  process.env.FAKE_SSH_STDERR = '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n'
  try {
    const ssh = { host: '203.0.113.9', port: 22 }
    await assert.rejects(sshExec(keyPath, ssh, 'whoami', { timeoutMs: 5000, retries: 5 }), /host key/i)
    assert.equal(calls().length, 1, 'must not retry a host-key failure')
    forgetHostKeys(ssh)
  } finally {
    delete process.env.FAKE_SSH_EXIT
    delete process.env.FAKE_SSH_STDERR
  }
})

await check('an ordinary non-zero exit from the remote command is still just a result', async () => {
  process.env.FAKE_SSH_EXIT = '3'
  try {
    const ssh = { host: 'h', port: 22 }
    const result = await sshExec(keyPath, ssh, 'false', { timeoutMs: 5000, retries: 1 })
    assert.equal(result.exitCode, 3)
    forgetHostKeys(ssh)
  } finally {
    delete process.env.FAKE_SSH_EXIT
  }
})

rmSync(scratch, { recursive: true, force: true })
if (process.exitCode) console.error('ssh host keys: FAILED')
else console.log(`ssh host keys: ${passed} checks passed`)
