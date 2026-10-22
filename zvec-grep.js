/**
 * zvec-grep (zg) MCP connector on the Academic Harness preset.
 *
 * First Academic Harness start (after `dsh plugin add`) installs the zg CLI into
 * `$DSH_HOME/zvec-grep` if it is not already on PATH / ZVEC_GREP_CLI, then
 * starts `zg server on` and mounts `mcp__zvec_grep__zvec_grep_search` over
 * the daemon's loopback Streamable HTTP MCP — no second restart. Stopping
 * DSH (this fiber unloading) runs `zg server off` so the daemon does not
 * outlive the process. Indexing is opt-in: Settings "Index at session
 * start" defaults to no. The user can index later from chat (`zvec_index`)
 * or by answering yes when the agent asks. Progress and Cancel live in
 * Settings and the session header. Exact words/regex/filenames stay on
 * native `grep` / `glob`.
 *
 * HTTP rather than `zg server --stdio`: DSH's MCP client is Streamable HTTP.
 * Bundled zg is `@zvec/zvec-grep@^0.2.2` (upgraded on Academic Harness start
 * if the copy under $DSH_HOME/zvec-grep is older).
 */
import { isAbsolute } from 'node:path'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { resolveEnv } from './credential-env.js'
import { isPluginPreset } from './preset-ids.js'
import {
  bundledInstallDir,
  DEFAULT_EMBEDDING,
  ensureDaemonReady,
  ensureZgInstalled,
  isAutoIndexOn,
  LOG,
  shouldIndexRoot,
  stopDaemon,
} from './zvec-grep-cli.js'
import {
  ensureCancelWatch,
  resetStaleIndexState,
  startIndex,
  waitForIndex,
} from './zvec-index-engine.js'

export const name = 'academic-harness-zvec-grep'
// Same as mcp-connectors.js: this row only registers into the host `tools`
// registry. Declaring inject: ['tools'] on the standing preset fiber can
// stall apply() so the CLI is never installed.
export const inject = []

const SEARCH_TOOL = 'mcp__zvec_grep__zvec_grep_search'
const TOOL_CALL_TIMEOUT_MS = 600_000

export {
  bundledInstallDir,
  DEFAULT_EMBEDDING,
  dshHome,
  ensureZgInstalled,
  resolveZgLaunch,
} from './zvec-grep-cli.js'

function sessionCwd(session) {
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

function mountSearch(ctx, launch, embedding, daemon) {
  if (daemon?.serverUrl) {
    const headers = {}
    if (daemon.token) headers.Authorization = `Bearer ${daemon.token}`
    ctx.plugin(McpClient, {
      serverName: 'zvec_grep',
      transport: 'streamable-http',
      url: daemon.serverUrl,
      headers,
      failOnStartupError: false,
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    })
  }

  ctx.on('session/created', (session) => {
    if (session?.header?.origin === 'subagent') return
    const preset = session?.header?.agentPreset
    if (preset && !isPluginPreset(preset)) return
    const cwd = sessionCwd(session)
    if (!shouldIndexRoot(cwd)) return
    void (async () => {
      const auto = await resolveEnv('ZVEC_GREP_AUTO_INDEX')
      if (!isAutoIndexOn(auto)) return
      const liveEmbedding = (await resolveEnv('ZVEC_GREP_EMBEDDING')) || embedding
      await startIndex({
        root: cwd,
        launch,
        embedding: liveEmbedding,
        wait: false,
        skipIfReady: true,
      })
    })()
  }, { global: true })

  // Never *start* an index from a search. If the user already started one
  // (session-start or zvec_index), wait so the first search is not empty.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.name !== SEARCH_TOOL) return next()
    const argRoot = exec.arguments && typeof exec.arguments === 'object'
      ? exec.arguments.root
      : undefined
    const root = typeof argRoot === 'string' && isAbsolute(argRoot)
      ? argRoot
      : exec.agent?.session?.header?.cwd
    if (shouldIndexRoot(root)) await waitForIndex(root, exec.signal)
    return next()
  })
}

export async function apply(ctx) {
  const launch = await ensureZgInstalled()
  if (!launch) {
    console.warn(
      `${LOG}: CLI not found; mcp__zvec_grep__* tools will be absent. `
      + `Set ZVEC_GREP_CLI or check ${bundledInstallDir()}.`,
    )
    return
  }

  ensureCancelWatch()
  resetStaleIndexState()

  const [embedding, apiKey] = await Promise.all([
    resolveEnv('ZVEC_GREP_EMBEDDING'),
    resolveEnv('ZVEC_GREP_API_KEY'),
  ])
  const resolvedEmbedding = embedding || DEFAULT_EMBEDDING
  const daemon = await ensureDaemonReady(launch, { embedding: resolvedEmbedding, apiKey })
  if (!daemon) {
    console.warn(`${LOG}: daemon not ready; mcp__zvec_grep__* tools will be absent`)
  }
  // Register before the MCP child so unload closes HTTP first, then
  // `zg server off`. Cordis runs disposers in reverse registration order.
  ctx.effect(() => () => stopDaemon(launch), 'zvec-grep.daemon')
  mountSearch(ctx, launch, resolvedEmbedding, daemon)
}
