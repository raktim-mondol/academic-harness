/**
 * Academic search MCP connectors (Firecrawl, Scite), mounted
 * programmatically instead of as static cordis.yml rows so each server's
 * auth can come from the host entry Config (Settings -> Academic Harness API
 * keys) as well as the matching env var.
 * Resolved once when the `academic-harness` preset first mounts. That mount is
 * a STANDING composition shared by every session naming the preset for the
 * life of the running `dsh` process (see @deepseek-ai/dsh-agent-preset) —
 * a new chat session does NOT get a fresh mount, so a key entered or
 * changed in Settings only reaches these connectors after `dsh` itself is
 * stopped and restarted, not merely after starting a new session (verified
 * live: a freshly-saved key was still invisible to a brand-new session on
 * the correct preset). `dsh-mcp-client`'s own config is fixed per instance,
 * and env vars have the same restart requirement.
 *
 * Firecrawl now requires a key for its remote MCP calls (keyless calls return
 * an upgrade message), so the connector is mounted only when
 * FIRECRAWL_API_KEY is set. Parallel is not mounted here: native
 * `parallel_search` and `parallel_extract` cover its search and read-URL jobs
 * with per-call mode selection (see parallel-search.js).
 * Scite requires a key:
 * its hosted MCP server (https://api.scite.ai/mcp) has three access paths
 * (see https://docs.scite.ai/mcp) — the first-party ChatGPT/Claude
 * plugin/connector (OAuth, those platforms only), an interactive MCP client
 * doing OAuth 2.1 + PKCE (DSH has no such flow), and the documented
 * programmatic path: an `mcp`-scoped API key from the API Console
 * (scite.ai/users/me/api), sent as a bearer token to `/mcp` with no token
 * exchange. That third path is what SCITE_API_KEY uses below — it's Scite's
 * own first-class non-interactive credential, not a workaround.
 *
 * Consensus is NOT here: it moved off its MCP server to a plain REST API
 * with `x-api-key` auth, so it's now `consensus-search.js` — a native
 * per-call tool, not a standing MCP mount, which also means a
 * Settings-changed CONSENSUS_API_KEY takes effect on the next call rather
 * than needing a restart. See presets/academic-harness/agent.cordis.yml.
 */
import * as McpClient from 'ah-dsh-mcp-client'
import { resolveEnv } from './credential-env.js'

export const name = 'academic-harness-mcp-connectors'
export const inject = []

export async function apply(ctx) {
  const [firecrawlKey, sciteKey] = await Promise.all([
    resolveEnv('FIRECRAWL_API_KEY'),
    resolveEnv('SCITE_API_KEY'),
  ])

  if (firecrawlKey) {
    ctx.plugin(McpClient, {
      serverName: 'firecrawl',
      transport: 'streamable-http',
      url: `https://mcp.firecrawl.dev/${encodeURIComponent(firecrawlKey)}/v2/mcp`,
    })
  }

  if (sciteKey) {
    ctx.plugin(McpClient, {
      serverName: 'scite',
      transport: 'streamable-http',
      url: 'https://api.scite.ai/mcp',
      headers: { Authorization: `Bearer ${sciteKey}` },
    })
  }
}
