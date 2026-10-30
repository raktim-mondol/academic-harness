/**
 * Optional custom provider routes for delegated specialists, mounted
 * programmatically (like mcp-connectors.js) so the settings can come from the
 * host entry Config (Settings -> Academic Harness API keys) as well as the
 * matching env vars. Adds two subagent tools alongside the default `subagent`
 * and `subagent_fork` (presets/academic-harness/agent.cordis.yml):
 *
 * - `subagent_pro` — difficulty-bound delegated work. When its three custom
 *   fields (endpoint, model, API key) are set, the plugin registers
 *   an OpenAI/Anthropic-compatible route with the host's `dsh-llm-pi-ai`
 *   adapter and routes this tool there. Otherwise the tool inherits the
 *   session model.
 * - `subagent_vision` — image-reading/visual-inspection work, with the same
 *   three optional fields. Otherwise it inherits the session model, which is
 *   DeepSeek-V4.1-Flash in the default deployment and accepts image input.
 *
 * The API key is stored in the host credential service under
 * AH_SUBAGENT_PRO_KEY / AH_SUBAGENT_VISION_KEY and referenced by the provider
 * profile as `apiKeyEnv`, so the pi-ai adapter resolves it per request. The
 * route definitions live on the `llm-pi-ai` profile entry; this plugin adds or
 * removes its two routes and never touches other providers. A partial custom
 * configuration is ignored and the tool inherits the session model.
 *
 * Image routing is enforced per top-level agent, not left to model choice: the
 * plugin registers an agent-scoped `tools.restrict({ deny: ['read_image'] })`
 * plus a guard that refuses any direct read_image call, so only the spawned
 * subagent_vision child (whose scope does not import the parent's restriction)
 * reads files. Promoting a tool through the child over the parent's own
 * `read_image` is otherwise stochastic — DSH's child scopes deliberately drop
 * agent-local tool restrictions and guards. Each Pro/Vision call is also
 * recorded in the session notebook from the agent's own `tools/result` /
 * `subagent/end` events, so the routing record does not depend on the model
 * remembering to call `notebook`.
 *
 * `@deepseek-ai/dsh-tool-subagent`'s `agentOptions` is read once when this
 * plugin instance mounts, not per call (unlike `resolveEnv()` fields such as
 * IMAGE_MODEL) — and the `academic-harness` preset mounts once as a standing
 * composition for the life of the running `dsh` process (see
 * mcp-connectors.js). So a value changed in Settings or the environment only
 * reaches these tools after `dsh` itself is stopped and restarted. Registering
 * a new route through the settings service also reloads the profile; the
 * first chat after saving should be made after that restart.
 *
 * `inject` must list every service a `ctx.plugin()`-mounted child reads, not
 * just what this module reads directly: Cordis gates `ctx.<service>` property
 * access per fiber, and mounting `@deepseek-ai/dsh-tool-subagent` (whose
 * 0.2.1 `inject` is `tools`/`subagents`/`systemPrompt`/`sessionProjections`)
 * from inside a fiber that never declared those itself throws `cannot get
 * property "subagents" without inject` the moment the child's `apply()` reads
 * `ctx.subagents.getProvider(...)` — a load-time failure, not a runtime one.
 *
 * This plugin pins `@deepseek-ai/dsh-tool-subagent` to the same line as
 * `npm install -g @deepseek-ai/dsh` (`latest`). 0.2.1 spawn-in-process
 * advertises `agentOptions`; a mismatched older spawn provider throws
 * `provider "spawn" does not support child agentOptions` and
 * `subagent_pro`/`subagent_vision` vanish as "unknown tool". DSH 0.2.1 also
 * removed `backgroundMode`: every delegation is a managed activation that
 * returns a subagent id immediately, with the final answer delivered as a
 * completion notice.
 */
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { appendNotebookEntryAt, notebookFile } from './notebook.js'
import { getStoredKey } from './settings-keys.js'

export const name = 'academic-harness-subagent-models'
export const inject = [
  'tools', 'subagents', 'systemPrompt', 'sessionProjections', 'settings', 'credentials',
]

const ROUTER_ENTRY = 'llm-pi-ai'
const SPECS = {
  pro: {
    toolName: 'subagent_pro',
    provider: 'academic-harness-pro',
    credential: 'AH_SUBAGENT_PRO_KEY',
    vision: false,
    fields: {
      baseURL: 'SUBAGENT_PRO_BASE_URL',
      model: 'SUBAGENT_PRO_MODEL',
      apiKey: 'SUBAGENT_PRO_API_KEY',
    },
  },
  vision: {
    toolName: 'subagent_vision',
    provider: 'academic-harness-vision',
    credential: 'AH_SUBAGENT_VISION_KEY',
    vision: true,
    fields: {
      baseURL: 'SUBAGENT_VISION_BASE_URL',
      model: 'SUBAGENT_VISION_MODEL',
      apiKey: 'SUBAGENT_VISION_API_KEY',
    },
  },
}

const READ_IMAGE_TOOL = 'read_image'
export const READ_IMAGE_DENIAL =
  'Direct read_image is disabled for the top-level Academic Harness agent. Delegate the image inspection to subagent_vision: pass the file path(s) and exactly what to look for.'

/** Whether this agent is the top-level Academic Harness session, not a child. */
export function topLevelPresetAgent(agent) {
  const header = agent?.session?.header
  if (!header || header.agentPreset !== 'academic-harness') return false
  if (header.origin === 'subagent') return false
  return (header.delegationDepth ?? 0) === 0
}

const ROUTING_TOOLS = new Set(['subagent_pro', 'subagent_vision'])

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function routeLabel(kind, route) {
  if (!route || route.incomplete || route.invalid) return 'session model (no complete custom route)'
  return `custom route ${SPECS[kind].provider}/${route.model} (${route.api})`
}

/** Automatic notebook decision entry for one Pro/Vision delegation. */
export function routingDecisionEntry({ callId, toolName, description, prompt, route, now = Date.now() }) {
  const task = clip(description, 120)
  const body = [
    `Automatic routing record for \`${toolName}\`.`,
    `Route: ${route}.`,
  ]
  if (prompt) body.push(`Task prompt excerpt: ${clip(prompt, 600)}`)
  return {
    id: `routing-${callId}-decision`,
    timestamp: now,
    type: 'decision',
    title: task ? `Routed to ${toolName}: ${task}` : `Routed to ${toolName}`,
    body: body.join('\n\n'),
    tags: ['routing'],
  }
}

function outputText(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
}

/** Automatic notebook observation linked to a routing decision. */
export function routingOutcomeEntry({
  callId, toolName, description, subagentId, stopReason, output, durationMs, now = Date.now(),
}) {
  const task = clip(description, 120)
  const seconds = Number.isFinite(durationMs) ? ` after ${(durationMs / 1000).toFixed(1)}s` : ''
  const body = [
    `Automatic routing outcome for \`${toolName}\`.`,
    `Child \`${subagentId}\` settled with stop reason \`${stopReason}\`${seconds}.`,
  ]
  const answer = clip(outputText(output), 600)
  if (answer) body.push(`Final answer excerpt: ${answer}`)
  return {
    id: `routing-${callId}-outcome`,
    timestamp: now,
    type: 'observation',
    title: task ? `Outcome: ${toolName}: ${task}` : `Outcome: ${toolName}`,
    body: body.join('\n\n'),
    tags: ['routing'],
    relatesTo: `routing-${callId}-decision`,
    stance: 'neutral',
  }
}

function installAgentHooks(agent, ctx, routes, scopedInstalls) {
  if (!topLevelPresetAgent(agent) || scopedInstalls.has(agent)) return
  let fiber
  try {
    fiber = agent.ctx.inject(['tools'], (runtimeCtx) => {
      const tools = runtimeCtx.tools
      try {
        if (tools.get(READ_IMAGE_TOOL) !== undefined) {
          tools.restrict({ deny: [READ_IMAGE_TOOL] })
        }
      } catch (error) {
        ctx.logger?.warn(`academic-harness: could not hide ${READ_IMAGE_TOOL} from the top-level agent: ${error instanceof Error ? error.message : String(error)}`)
      }
      tools.guard((exec) => (exec.name === READ_IMAGE_TOOL ? READ_IMAGE_DENIAL : undefined))

      const pending = new Map()
      runtimeCtx.on('tools/result', (exec, result) => {
        if (result.isError || !ROUTING_TOOLS.has(exec.name)) return
        const value = result.value
        const subagentId = value && typeof value === 'object' ? value.subagentId : undefined
        if (typeof subagentId !== 'string' || subagentId.length === 0) return
        const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
        const kind = exec.name === 'subagent_pro' ? 'pro' : 'vision'
        const now = Date.now()
        const decision = routingDecisionEntry({
          callId: exec.callId,
          toolName: exec.name,
          description: args.description,
          prompt: args.prompt,
          route: routeLabel(kind, routes[kind]),
          now,
        })
        try {
          const file = notebookFile(exec)
          appendNotebookEntryAt(file, decision)
          pending.set(subagentId, {
            callId: exec.callId,
            toolName: exec.name,
            description: args.description,
            file,
            startedAt: now,
          })
        } catch (error) {
          ctx.logger?.warn(`academic-harness: could not record ${exec.name} routing decision: ${error instanceof Error ? error.message : String(error)}`)
        }
      })

      runtimeCtx.on('subagent/end', (info) => {
        const record = pending.get(info.id)
        if (!record) return
        pending.delete(info.id)
        const outcome = routingOutcomeEntry({
          ...record,
          subagentId: info.id,
          stopReason: info.stopReason,
          output: info.lastAssistantMessage,
          durationMs: Date.now() - record.startedAt,
        })
        try {
          appendNotebookEntryAt(record.file, outcome)
        } catch (error) {
          ctx.logger?.warn(`academic-harness: could not record ${record.toolName} routing outcome: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    })
  } catch (error) {
    ctx.logger?.warn(`academic-harness: could not enforce image-routing policy: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  scopedInstalls.set(agent, fiber)
}

function disposeAgentHooks(agent, ctx, scopedInstalls) {
  const fiber = scopedInstalls.get(agent)
  if (!fiber) return
  scopedInstalls.delete(agent)
  const disposing = fiber.dispose?.()
  disposing?.catch?.((error) => {
    ctx.logger?.warn(`academic-harness: failed to remove image-routing policy for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

function resolveEnvSync(name) {
  return process.env[name]?.trim() || getStoredKey(name)
}

/** Infer the pi-ai wire protocol from the endpoint URL. */
export function inferApi(baseURL) {
  let endpoint
  try {
    endpoint = new URL(String(baseURL))
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) return null
  const text = `${endpoint.hostname}${endpoint.pathname}`.toLowerCase()
  return text.includes('anthropic') ? 'anthropic-messages' : 'openai-completions'
}

/** Validate a custom route; null means all three fields are blank. */
export function buildCustomRoute({ baseURL, model, apiKey } = {}) {
  const route = {
    baseURL: String(baseURL ?? '').trim(),
    model: String(model ?? '').trim(),
    apiKey: String(apiKey ?? '').trim(),
  }
  const filled = Object.values(route).filter(Boolean).length
  if (filled === 0) return null
  if (filled < 3) return { incomplete: true }
  const api = inferApi(route.baseURL)
  if (!api) return { invalid: 'endpoint must be an HTTP(S) URL' }
  return { ...route, api }
}

/** The pi-ai provider profile for one custom route. */
export function customRouteProfile(route, { vision = false } = {}) {
  const input = vision ? ['text', 'image'] : ['text']
  return {
    displayName: vision ? 'Academic Harness subagent_vision' : 'Academic Harness subagent_pro',
    api: route.api,
    baseURL: route.baseURL,
    apiKeyEnv: route.credential,
    models: [{ id: route.model, name: route.model, input }],
    defaultInput: input,
  }
}

function readCustomRoute(kind) {
  const spec = SPECS[kind]
  const route = buildCustomRoute({
    baseURL: resolveEnvSync(spec.fields.baseURL),
    model: resolveEnvSync(spec.fields.model),
    apiKey: resolveEnvSync(spec.fields.apiKey),
  })
  if (route && !route.incomplete && !route.invalid) return { ...route, credential: spec.credential }
  return route
}

function currentProviders(settings) {
  try {
    const form = settings.describe().find((row) => row.ns === ROUTER_ENTRY)
    const providers = form?.value?.providers
    return providers && typeof providers === 'object' ? providers : {}
  } catch {
    return {}
  }
}

function sameRoute(current, desired) {
  if (!current) return false
  if (current.api !== desired.api) return false
  if (current.baseURL !== desired.baseURL) return false
  if (current.apiKeyEnv !== desired.apiKeyEnv) return false
  if (!Array.isArray(current.models) || current.models.length !== 1) return false
  return current.models[0]?.id === desired.models[0].id
}

async function syncCustomRoutes(ctx, routes) {
  const settings = ctx.settings
  const credentials = ctx.credentials
  if (!settings || typeof settings.mutate !== 'function' || !credentials?.set) {
    ctx.logger?.warn('academic-harness: settings or credentials service unavailable; custom subagent routes are disabled')
    return { pro: false, vision: false }
  }
  const current = currentProviders(settings)
  const ops = []
  const ready = { pro: false, vision: false }

  for (const kind of ['pro', 'vision']) {
    const spec = SPECS[kind]
    const route = routes[kind]
    const exists = Object.hasOwn(current, spec.provider)
    if (!route || route.incomplete || route.invalid) {
      if (route?.incomplete) {
        ctx.logger?.warn(`academic-harness: ${spec.toolName} custom route needs endpoint, model, and API key; using the session model`)
      } else if (route?.invalid) {
        ctx.logger?.warn(`academic-harness: ${spec.toolName} custom route is invalid (${route.invalid}); using the session model`)
      }
      if (exists) {
        ops.push({ op: 'unset', path: ['providers', spec.provider] })
        if (typeof credentials.unset === 'function') {
          try { await credentials.unset(spec.credential) } catch { /* nothing stored */ }
        }
      }
      continue
    }
    try {
      await credentials.set(spec.credential, route.apiKey)
      const desired = customRouteProfile(route, { vision: spec.vision })
      if (!sameRoute(current[spec.provider], desired)) {
        ops.push({ op: 'set', path: ['providers', spec.provider], value: desired })
      }
      ready[kind] = true
      ctx.logger?.info(`academic-harness: ${spec.toolName} custom route ready (${route.api})`)
    } catch (error) {
      ctx.logger?.warn(`academic-harness: could not prepare ${spec.toolName} custom route: ${error instanceof Error ? error.message : String(error)}; using the session model`)
      if (exists) ops.push({ op: 'unset', path: ['providers', spec.provider] })
    }
  }

  if (ops.length) {
    try {
      await settings.mutate(ROUTER_ENTRY, ops)
    } catch (error) {
      ctx.logger?.warn(`academic-harness: could not update ${ROUTER_ENTRY} providers: ${error instanceof Error ? error.message : String(error)}; using the session model`)
      return { pro: false, vision: false }
    }
  }
  return ready
}

function scheduleCustomRoutes(ctx, routes) {
  ctx.effect(() => {
    const timer = setTimeout(() => {
      syncCustomRoutes(ctx, routes).catch((error) => {
        ctx.logger?.warn(`academic-harness: custom subagent route setup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, 0)
    return () => clearTimeout(timer)
  })
}

export function apply(ctx) {
  const routes = { pro: readCustomRoute('pro'), vision: readCustomRoute('vision') }
  const proOptions = routes.pro && !routes.pro.incomplete && !routes.pro.invalid
    ? { provider: SPECS.pro.provider, model: routes.pro.model }
    : undefined
  const visionOptions = routes.vision && !routes.vision.incomplete && !routes.vision.invalid
    ? { provider: SPECS.vision.provider, model: routes.vision.model }
    : undefined

  ctx.plugin(ToolSubagent, {
    provider: 'spawn',
    toolName: 'subagent_pro',
    ...(proOptions === undefined ? {} : { agentOptions: proOptions }),
  })

  ctx.plugin(ToolSubagent, {
    provider: 'spawn',
    toolName: 'subagent_vision',
    ...(visionOptions === undefined ? {} : { agentOptions: visionOptions }),
  })

  const scopedInstalls = new Map()
  const install = (agent) => installAgentHooks(agent, ctx, routes, scopedInstalls)
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => disposeAgentHooks(agent, ctx, scopedInstalls))
  ctx.effect(() => () => {
    for (const [agent, fiber] of scopedInstalls) {
      scopedInstalls.delete(agent)
      const disposing = fiber?.dispose?.()
      disposing?.catch?.(() => {})
    }
  })
  try {
    for (const agent of ctx.get('agents')?.list?.() ?? []) install(agent)
  } catch (error) {
    ctx.logger?.warn(`academic-harness: could not install image-routing policy on existing agents: ${error instanceof Error ? error.message : String(error)}`)
  }

  scheduleCustomRoutes(ctx, routes)
}
