/**
 * PaperMemory MCP connector on the Academic Harness preset.
 *
 * First Academic Harness start installs the `papermemory` CLI (PATH, then a
 * plugin-managed venv under $DSH_HOME/papermemory from the vendored package)
 * and mounts `mcp__papermemory__*` over stdio (`papermemory mcp`). Stopping
 * DSH tears the child down with the MCP client. The SQLite store stays at
 * ~/.local/share/papermemory/papermemory.db (override PAPERMEMORY_DB) so a
 * standalone CLI and this preset share the same academic memory.
 *
 * Stdio rather than Streamable HTTP: PaperMemory's server is a JSON-RPC
 * stdio loop (`papermemory mcp`), and DSH's MCP client supports that
 * transport. Startup failures are loud: failOnStartupError is true so a
 * missing/broken memory server surfaces instead of looking like an empty store.
 */
import { homedir } from 'node:os'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import {
  bundledInstallDir,
  cliArgs,
  ensurePaperMemoryDb,
  ensurePaperMemoryInstalled,
  LOG,
  run,
} from './papermemory-cli.js'

// PaperMemory itself has 15 tools. The plugin hides the MCP copy of the reference library
// (`papermemory_library`) and offers it as the native `reference_library` tool instead, because only a
// native tool knows each session's workspace; an MCP server has one fixed working directory.
export const HIDDEN_MCP_TOOLS = ['papermemory_library']
const EXPECTED_TOOL_COUNT = 14

export const name = 'academic-harness-papermemory'
// Same as mcp-connectors.js / zvec-grep.js: this row only registers into the
// host `tools` registry. Declaring inject: ['tools'] on the standing preset
// fiber can stall apply() so the CLI is never installed.
export const inject = []

const TOOL_CALL_TIMEOUT_MS = 180_000

export {
  bundledInstallDir,
  dshHome,
  ensurePaperMemoryInstalled,
  ingestDownloadedPaper,
  resolvePaperMemoryLaunch,
} from './papermemory-cli.js'

function mcpEnv() {
  const extra = { PYTHONUNBUFFERED: '1', PAPERMEMORY_HIDE_TOOLS: HIDDEN_MCP_TOOLS.join(',') }
  const db = process.env.PAPERMEMORY_DB?.trim()
  const dataDir = process.env.PAPERMEMORY_DATA_DIR?.trim()
  if (db) extra.PAPERMEMORY_DB = db
  if (dataDir) extra.PAPERMEMORY_DATA_DIR = dataDir
  return extra
}

export async function apply(ctx) {
  const launch = await ensurePaperMemoryInstalled()
  if (!launch) {
    console.warn(
      `${LOG}: CLI not found; mcp__papermemory__* tools will be absent. `
      + `Set PAPERMEMORY_CLI or check ${bundledInstallDir()}.`,
    )
    return
  }

  await ensurePaperMemoryDb(launch)
  const probe = await run(launch.command, cliArgs(launch, ['tools', '--json']), { timeoutMs: 20_000, silent: true, env: { ...process.env, ...mcpEnv() } })
  try {
    const names = JSON.parse(probe.out)
    if (!Array.isArray(names) || names.length !== EXPECTED_TOOL_COUNT) {
      console.warn(`${LOG}: tool surface drift: expected ${EXPECTED_TOOL_COUNT} tools, got ${Array.isArray(names) ? names.length : 'unreadable'}`)
    }
  } catch {
    console.warn(`${LOG}: could not verify the tool surface (tools --json failed)`)
  }

  ctx.plugin(McpClient, {
    serverName: 'papermemory',
    transport: 'stdio',
    command: launch.command,
    args: [...launch.args, 'mcp'],
    env: mcpEnv(),
    cwd: homedir(),
    failOnStartupError: true,
    toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
  })
}
