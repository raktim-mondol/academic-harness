/**
 * Optional custom provider routes for delegated specialists, mounted
 * programmatically (like mcp-connectors.js) so the settings can come from the
 * host entry Config (Settings -> Academic Harness API keys) as well as the
 * matching env vars. Adds two subagent tools alongside the default `subagent`
 * and `subagent_fork` (presets/academic-harness/agent.cordis.yml):
 *
 * - `subagent_pro` — difficulty-bound delegated work. When its four custom
 *   fields (API type, endpoint, model, API key) are set, the plugin registers
 *   an OpenAI/Anthropic-compatible route with the host's `dsh-llm-pi-ai`
 *   adapter and routes this tool there. Otherwise the tool inherits the
 *   session model.
 * - `subagent_vision` — image-reading/visual-inspection work, with the same
 *   four optional fields. Otherwise it inherits the session model, which is
 *   DeepSeek-V4.1-Flash in the default deployment and accepts image input.
 *
 * The API key is stored in the host credential service under
 * AH_SUBAGENT_PRO_KEY / AH_SUBAGENT_VISION_KEY and referenced by the provider
 * profile as `apiKeyEnv`, so the pi-ai adapter resolves it per request. The
 * route definitions live on the `llm-pi-ai` profile entry; this plugin adds or
 * removes its two routes and never touches other providers. A partial custom
 * configuration is ignored and the tool inherits the session model.
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
import { getStoredKey } from './settings-keys.js'

export const name = 'academic-harness-subagent-models'
export const inject = [
  'tools', 'subagents', 'systemPrompt', 'sessionProjections', 'settings', 'credentials',
]

const ROUTER_ENTRY = 'llm-pi-ai'
const API_TYPES = new Set(['anthropic-messages', 'openai-completions', 'openai-responses'])
const SPECS = {
  pro: {
    toolName: 'subagent_pro',
    provider: 'academic-harness-pro',
    credential: 'AH_SUBAGENT_PRO_KEY',
    vision: false,
    fields: {
      api: 'SUBAGENT_PRO_API',
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
      api: 'SUBAGENT_VISION_API',
      baseURL: 'SUBAGENT_VISION_BASE_URL',
      model: 'SUBAGENT_VISION_MODEL',
      apiKey: 'SUBAGENT_VISION_API_KEY',
    },
  },
}

function resolveEnvSync(name) {
  return process.env[name]?.trim() || getStoredKey(name)
}

/** Validate a custom route; null means all four fields are blank. */
export function buildCustomRoute({ api, baseURL, model, apiKey } = {}) {
  const route = {
    api: String(api ?? '').trim(),
    baseURL: String(baseURL ?? '').trim(),
    model: String(model ?? '').trim(),
    apiKey: String(apiKey ?? '').trim(),
  }
  const filled = Object.values(route).filter(Boolean).length
  if (filled === 0) return null
  if (filled < 4) return { incomplete: true }
  if (!API_TYPES.has(route.api)) {
    return { invalid: `API type must be one of ${[...API_TYPES].join(', ')}` }
  }
  let endpoint
  try {
    endpoint = new URL(route.baseURL)
  } catch {
    return { invalid: 'endpoint must be an HTTP(S) URL' }
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    return { invalid: 'endpoint must be an HTTP(S) URL' }
  }
  return route
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
    api: resolveEnvSync(spec.fields.api),
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
        ctx.logger?.warn(`academic-harness: ${spec.toolName} custom route needs API type, endpoint, model, and API key; using the session model`)
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

  scheduleCustomRoutes(ctx, routes)
}
