/**
 * Workspace trust for Paper2MCP stdio servers (review A1, decisions D15/D16).
 *
 * `<workspace>/.dsh/paper-mcps.json` is data that travels with a folder: a
 * cloned repository can ship one. Mounting an entry runs its `command` and can
 * hand it named environment variables, so a registry entry only mounts after a
 * person approved that exact entry for that workspace. Approvals live under
 * `$DSH_HOME`, outside the folder, keyed by a hash of the normalised entry:
 * changing the command, arguments, working directory or env names invalidates
 * the approval.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withLock, writeJsonAtomic } from './store-lock.js'

const SCHEMA_VERSION = 1

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function approvalsFile() {
  return join(dshHome(), 'paper-mcp', 'approvals.json')
}

/** Stable hash of what actually runs: name, command, args, cwd and env *names*. */
export function entryHash(spec) {
  const canonical = JSON.stringify({
    serverName: spec.serverName,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    envNames: [...new Set(spec.envNames)].sort(),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function readApprovals() {
  const file = approvalsFile()
  if (!existsSync(file)) return { schema_version: SCHEMA_VERSION, workspaces: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object') {
      return { schema_version: SCHEMA_VERSION, workspaces: parsed.workspaces }
    }
  } catch {
    // A damaged file approves nothing; the person is simply asked again.
  }
  return { schema_version: SCHEMA_VERSION, workspaces: {} }
}

export function isApproved(workspaceCwd, spec) {
  const entries = readApprovals().workspaces[workspaceCwd]
  return Boolean(entries && Object.hasOwn(entries, entryHash(spec)))
}

export async function recordApproval(workspaceCwd, spec) {
  const file = approvalsFile()
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  await withLock(dir, () => {
    const data = readApprovals()
    const entries = data.workspaces[workspaceCwd] ?? {}
    entries[entryHash(spec)] = { serverName: spec.serverName, approved_at: new Date().toISOString() }
    data.workspaces[workspaceCwd] = entries
    writeJsonAtomic(file, data)
  }, { label: 'paper-mcp approvals' })
}

/** Drop every approval a server name holds in one workspace (used on unregister). */
export async function forgetApprovals(workspaceCwd, serverName) {
  const file = approvalsFile()
  if (!existsSync(file)) return
  const dir = dirname(file)
  await withLock(dir, () => {
    const data = readApprovals()
    const entries = data.workspaces[workspaceCwd]
    if (!entries) return
    for (const [hash, record] of Object.entries(entries)) {
      if (record?.serverName === serverName) delete entries[hash]
    }
    if (Object.keys(entries).length === 0) delete data.workspaces[workspaceCwd]
    writeJsonAtomic(file, data)
  }, { label: 'paper-mcp approvals' })
}

/** What the person is shown when asked to approve an entry. */
export function approvalReason(spec, workspaceCwd) {
  const env = spec.envNames.length
    ? `It will be given these environment variables from your settings or shell: ${spec.envNames.join(', ')}.`
    : 'It will be given no secret environment variables.'
  return [
    `Start a Paper2MCP server "${spec.serverName}" for workspace ${workspaceCwd}.`,
    `This runs the program ${spec.command} ${spec.args.join(' ')} in ${spec.cwd}.`,
    env,
    'Approve only if you recognise this program; a registry file inside a cloned folder can name anything.',
  ].join(' ')
}
