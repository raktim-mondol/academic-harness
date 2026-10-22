/**
 * Image-generation endpoint config (OpenAI Images API + Gemini "nano banana").
 *
 * Separate from the chat LLM endpoint on purpose: chat may run any
 * OpenAI-compatible model, while image generation needs a real Images API
 * (OpenAI) or Gemini — never inherit the chat route's base URL / key.
 *
 * Gemini path (default): IMAGE_MODEL (defaults to gemini-2.5-flash-image,
 * i.e. "nano banana") + GEMINI_API_KEY (or IMAGE_API_KEY override).
 * OpenAI path: IMAGE_MODEL + IMAGE_BASE_URL + IMAGE_API_KEY.
 */

const GEMINI_HOST = 'https://generativelanguage.googleapis.com'
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-image'

/** Infer provider from model id when IMAGE_PROVIDER is unset. */
export function inferImageProvider(model) {
  const m = model.trim().toLowerCase()
  if (
    m.startsWith('gemini-')
    || m.includes('nano-banana')
    || m.includes('flash-image')
    || m.includes('pro-image')
  ) {
    return 'gemini'
  }
  return 'openai'
}

export function parseImageProvider(raw, model) {
  const p = (raw ?? '').trim().toLowerCase()
  if (p === 'openai' || p === 'gemini') return p
  if (!model) return 'gemini'
  return inferImageProvider(model)
}

/** Read live image-gen config from the environment. */
export function getImageGenConfig(overrides = {}) {
  const provider = parseImageProvider(
    overrides.provider ?? process.env.IMAGE_PROVIDER,
    overrides.model?.trim() || process.env.IMAGE_MODEL || '',
  )

  if (provider === 'gemini') {
    const model = (
      overrides.model?.trim()
      || process.env.IMAGE_MODEL
      // Nano banana needs only GEMINI_API_KEY to work out of the box.
      || DEFAULT_GEMINI_MODEL
    ).trim()
    // overrides.imageApiKey/geminiApiKey come from the credentials store
    // (Settings -> Academic Harness API keys) — process.env still wins when set.
    const apiKey = (
      process.env.IMAGE_API_KEY
      || process.env.GEMINI_API_KEY
      || overrides.imageApiKey
      || overrides.geminiApiKey
      || ''
    ).trim()
    return { provider: 'gemini', model, baseUrl: GEMINI_HOST, apiKey }
  }

  const model = (overrides.model?.trim() || process.env.IMAGE_MODEL || '').trim()
  // Dedicated image endpoint only — do not reuse the chat LLM's base/key.
  const baseUrl = (process.env.IMAGE_BASE_URL || '').trim().replace(/\/+$/, '')
  const apiKey = (process.env.IMAGE_API_KEY || overrides.imageApiKey || '').trim()
  return { provider: 'openai', model, baseUrl, apiKey }
}

/**
 * True when the agent can attempt image generation without further setup.
 * Gemini needs only an API key (model defaults to nano banana); OpenAI needs
 * its own base URL, key, and an explicit IMAGE_MODEL.
 */
export function imageGenConfigured(overrides = {}) {
  const cfg = getImageGenConfig(overrides)
  if (cfg.provider === 'gemini') return Boolean(cfg.apiKey)
  return Boolean(cfg.model && cfg.baseUrl && cfg.apiKey)
}
