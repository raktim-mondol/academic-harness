/**
 * Per-workspace Paper2MCP stdio mounts plus a native `paper_mcp` tool.
 *
 * Generated FastMCP servers are registered in `<cwd>/.dsh/paper-mcps.json`
 * (python, server entry, env *names*, serverName). Secrets stay in
 * Settings/env via resolveEnv — never in that JSON.
 *
 * On Academic Harness `session/created`, this row attempts a stdio mount
 * (`@deepseek-ai/dsh-mcp-client`) so tools surface as `mcp__<serverName>__*`.
 * Those mounts are standing for the life of `dsh` (same as Parallel/Scite):
 * the first workspace to claim a serverName keeps it until restart. Status
 * reports that caveat instead of silently sharing another workspace's tools.
 *
 * Native `paper_mcp` (status / register / unregister) edits the JSON and
 * tries to mount immediately; if the catalog does not pick up the tools,
 * restart `dsh`. Skip subagent-origin sessions.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { isPluginPreset } from './preset-ids.js'

export const name = 'academic-harness-paper-mcp'
export const inject = ['tools']

const LOG = '[academic-harness] paper-mcp'
const SCHEMA_VERSION = 1
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const DEFAULT_TIMEOUT_MS = 300_000
const REGISTRY_REL = join('.dsh', 'paper-mcps.json')

/** serverName → { cwd, command } for this process's standing mounts. */
const mounted = new Map()

/** Test-only: drop in-process mount records. */
export function resetMountedForTests() {
  mounted.clear()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function sessionCwd(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function registryPath(cwd) {
  return join(cwd, REGISTRY_REL)
}

function emptyRegistry() {
  return { schema_version: SCHEMA_VERSION, servers: [] }
}

export function loadRegistry(cwd) {
  const path = registryPath(cwd)
  if (!existsSync(path)) return emptyRegistry()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`invalid ${REGISTRY_REL}: ${error.message}`)
  }
  const servers = Array.isArray(parsed?.servers) ? parsed.servers : []
  return { schema_version: SCHEMA_VERSION, servers }
}

function saveRegistry(cwd, registry) {
  const path = registryPath(cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`)
  return path
}

function absUnder(cwd, value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`)
  }
  const target = isAbsolute(value.trim()) ? resolve(value.trim()) : resolve(cwd, value.trim())
  return target
}

export function normalizeServer(cwd, raw) {
  const serverName = typeof raw.serverName === 'string' ? raw.serverName.trim() : ''
  if (!NAME_RE.test(serverName)) {
    throw new Error('serverName must match [A-Za-z0-9][A-Za-z0-9_-]{0,31}')
  }
  const command = absUnder(cwd, raw.command, 'command')
  const args = Array.isArray(raw.args)
    ? raw.args.map((a, i) => {
        if (typeof a !== 'string' || !a.trim()) throw new Error(`args[${i}] must be a nonempty string`)
        return a.includes('/') || a.endsWith('.py') ? absUnder(cwd, a, `args[${i}]`) : a
      })
    : []
  if (!args.length) throw new Error('args must be a nonempty array (server entry point)')
  const serverCwd = absUnder(cwd, raw.cwd || cwd, 'cwd')
  const envNames = Array.isArray(raw.envNames)
    ? raw.envNames.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim())
    : []
  const toolCallTimeoutMs = Number.isFinite(raw.toolCallTimeoutMs) && raw.toolCallTimeoutMs > 0
    ? Math.floor(raw.toolCallTimeoutMs)
    : DEFAULT_TIMEOUT_MS
  return { serverName, command, args, cwd: serverCwd, envNames, toolCallTimeoutMs }
}

async function envFor(spec) {
  const env = { PYTHONUNBUFFERED: '1' }
  for (const name of spec.envNames) {
    const value = await resolveEnv(name)
    if (value) env[name] = value
  }
  return env
}

async function mountServer(ctx, spec) {
  const existing = mounted.get(spec.serverName)
  if (existing) {
    if (existing.cwd === spec.cwd && existing.command === spec.command) {
      return { mounted: true, already: true, serverName: spec.serverName }
    }
    return {
      mounted: false,
      serverName: spec.serverName,
      restart: true,
      hint: `serverName "${spec.serverName}" is already mounted from ${existing.cwd} for this dsh process. Restart dsh to pick up this workspace's server.`,
    }
  }

  const env = await envFor(spec)
  try {
    ctx.plugin(McpClient, {
      serverName: spec.serverName,
      transport: 'stdio',
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env,
      failOnStartupError: false,
      toolCallTimeoutMs: spec.toolCallTimeoutMs,
    })
    mounted.set(spec.serverName, { cwd: spec.cwd, command: spec.command })
    return { mounted: true, already: false, serverName: spec.serverName }
  } catch (error) {
    return {
      mounted: false,
      serverName: spec.serverName,
      restart: true,
      error: error.message,
      hint: 'Standing MCP mounts may require a dsh restart after the first register in this workspace.',
    }
  }
}

function lossless(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => (v === undefined ? null : v)))
}

function render(value) {
  if (value.error && !value.action) {
    return [{ type: 'text', text: `Error: ${value.error}` }]
  }
  const lines = []
  if (value.action) lines.push(`action: ${value.action}`)
  if (value.path) lines.push(`registry: ${value.path}`)
  if (value.hint) lines.push(value.hint)
  if (Array.isArray(value.servers)) {
    if (!value.servers.length) lines.push('no paper MCP servers registered in this workspace')
    for (const s of value.servers) {
      const bits = [`${s.serverName}`, s.mounted ? 'mounted' : 'not-mounted']
      if (s.restart) bits.push('restart-dsh')
      if (s.command) bits.push(s.command)
      lines.push(`- ${bits.join(' · ')}`)
      if (s.hint) lines.push(`  ${s.hint}`)
    }
  }
  if (value.serverName && !value.servers) {
    lines.push(`serverName: ${value.serverName}`)
    if (value.mounted != null) lines.push(`mounted: ${value.mounted}`)
    if (value.already) lines.push('already mounted')
    if (value.restart) lines.push('restart dsh to apply')
  }
  if (value.error) lines.push(`error: ${value.error}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export async function apply(ctx) {
  ctx.on('session/created', (session) => {
    if (session?.header?.origin === 'subagent') return
    const preset = session?.header?.agentPreset
    if (preset && !isPluginPreset(preset)) return
    const cwd = sessionCwd(session)
    if (!cwd) return
    let registry
    try {
      registry = loadRegistry(cwd)
    } catch (error) {
      console.warn(`${LOG}: ${error.message}`)
      return
    }
    for (const raw of registry.servers) {
      let spec
      try {
        spec = normalizeServer(cwd, raw)
      } catch (error) {
        console.warn(`${LOG}: skip invalid server: ${error.message}`)
        continue
      }
      mountServer(ctx, spec).then((result) => {
        if (result.error) console.warn(`${LOG}: ${result.error}`)
        else if (result.hint && !result.mounted) console.warn(`${LOG}: ${result.hint}`)
      }).catch((error) => {
        console.warn(`${LOG}: mount failed: ${error.message}`)
      })
    }
  })

  ctx.tools.register(defineTool({
    name: 'paper_mcp',
    description: [
      'Register, list, or drop Paper2MCP stdio servers for this workspace.',
      'Registry is <cwd>/.dsh/paper-mcps.json (python, server script, env *names* — never secrets).',
      'action=status lists registered servers and whether they are mounted as mcp__<serverName>__* tools.',
      'action=register adds a server (from Paper2MCP USAGE.md after a verified ZIP) and tries to mount it.',
      'action=unregister removes it from the JSON; dropping live tools may need a dsh restart.',
      'Connect only when the user asked. Do not put API keys in the JSON.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'register', 'unregister'],
        description: 'status (default) lists; register adds a stdio server; unregister removes one.',
      },
      serverName: {
        type: 'string',
        description: 'MCP namespace (mcp__<serverName>__*). Required for register/unregister. [A-Za-z0-9_-], 1–32 chars.',
      },
      command: {
        type: 'string',
        description: 'Absolute (or workspace-relative) Python interpreter that runs the FastMCP server. Required for register.',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments, including the absolute server script path (src/<repo>_mcp.py). Required for register.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the server process (extracted package or project root). Defaults to the session workspace.',
      },
      envNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Environment variable *names* the server reads (values from Settings/env). Never pass secret values.',
      },
      toolCallTimeoutMs: {
        type: 'number',
        description: 'Per-tool-call timeout in ms (default 300000).',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return render(value)
      },
    },
    async execute(args, exec) {
      return executePaperMcp(args, exec, ctx)
    },
  }))
}

export async function executePaperMcp(args, exec, ctx) {
  const cwd = workspaceRoot(exec)
  const action = args.action ?? 'status'

  try {
    if (action === 'status') {
      const registry = loadRegistry(cwd)
      const servers = registry.servers.map((raw) => {
        try {
          const spec = normalizeServer(cwd, raw)
          const live = mounted.get(spec.serverName)
          const mountedHere = live && live.cwd === spec.cwd && live.command === spec.command
          const conflict = live && !mountedHere
          return {
            serverName: spec.serverName,
            command: spec.command,
            args: spec.args,
            cwd: spec.cwd,
            envNames: spec.envNames,
            mounted: Boolean(mountedHere),
            restart: Boolean(conflict),
            hint: conflict
              ? `mounted from ${live.cwd}; restart dsh to use this workspace's server`
              : (mountedHere ? undefined : 'not mounted in this dsh process — register, or restart dsh'),
          }
        } catch (error) {
          return { serverName: raw.serverName ?? '(invalid)', error: error.message, mounted: false }
        }
      })
      return lossless({
        action: 'status',
        path: registryPath(cwd),
        servers,
      })
    }

    if (action === 'unregister') {
      const serverName = typeof args.serverName === 'string' ? args.serverName.trim() : ''
      if (!NAME_RE.test(serverName)) {
        return lossless({ action: 'unregister', error: 'unregister requires a valid serverName' })
      }
      const registry = loadRegistry(cwd)
      const before = registry.servers.length
      registry.servers = registry.servers.filter((s) => s.serverName !== serverName)
      if (registry.servers.length === before) {
        return lossless({ action: 'unregister', serverName, error: `not in ${REGISTRY_REL}` })
      }
      const path = saveRegistry(cwd, registry)
      const live = mounted.has(serverName)
      return lossless({
        action: 'unregister',
        serverName,
        path,
        mounted: live,
        restart: live,
        hint: live
          ? 'Removed from the registry. Live mcp__* tools remain until dsh restarts.'
          : 'Removed from the registry.',
      })
    }

    if (action === 'register') {
      const spec = normalizeServer(cwd, {
        serverName: args.serverName,
        command: args.command,
        args: args.args,
        cwd: args.cwd,
        envNames: args.envNames,
        toolCallTimeoutMs: args.toolCallTimeoutMs,
      })
      if (!existsSync(spec.command)) {
        return lossless({ action: 'register', serverName: spec.serverName, error: `command not found: ${spec.command}` })
      }
      if (!existsSync(spec.cwd)) {
        return lossless({ action: 'register', serverName: spec.serverName, error: `cwd not found: ${spec.cwd}` })
      }
      const missingArg = spec.args.find((a) => a.startsWith('/') && !existsSync(a))
      if (missingArg) {
        return lossless({ action: 'register', serverName: spec.serverName, error: `server entry not found: ${missingArg}` })
      }
      const badEnv = spec.envNames.find((n) => /[=\s]/.test(n) || n.length > 128)
      if (badEnv) {
        return lossless({ action: 'register', serverName: spec.serverName, error: `envNames must be variable names, not values: ${badEnv}` })
      }
      const registry = loadRegistry(cwd)
      const idx = registry.servers.findIndex((s) => s.serverName === spec.serverName)
      const record = {
        serverName: spec.serverName,
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        envNames: spec.envNames,
        toolCallTimeoutMs: spec.toolCallTimeoutMs,
      }
      if (idx >= 0) registry.servers[idx] = record
      else registry.servers.push(record)
      const path = saveRegistry(cwd, registry)
      const mount = await mountServer(ctx, spec)
      return lossless({
        action: 'register',
        path,
        ...mount,
        hint: mount.mounted && !mount.already
          ? `Tools should appear as mcp__${spec.serverName}__*. If they do not, restart dsh.`
          : mount.hint,
      })
    }

    return lossless({ error: `unknown action "${action}"` })
  } catch (error) {
    return lossless({ action, error: error.message })
  }
}
