/**
 * HTTP clients for the OpenAI Images API and Gemini image generation
 * ("nano banana" — gemini-2.5-flash-image and successors). Raw fetch only,
 * no SDK dependency.
 */

import { NetGuardError, guardedDownload } from './net-guard.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

/**
 * Download an image an image API returned by URL. The URL comes from a remote
 * response, so it is fetched through the network guard: public hosts only, each
 * redirect re-checked, a deadline that covers the body and a size cap counted on
 * real bytes. `fetch`, `lookup` and `maxBytes` are injectable for tests.
 */
export async function downloadGeneratedImage(url, { signal, fetch: fetchImpl, lookup, maxBytes = MAX_IMAGE_BYTES, deadlineMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { buffer, headers } = await guardedDownload(url, { signal, fetch: fetchImpl, lookup, maxBytes, deadlineMs })
    const contentType = headers.get('content-type') || 'image/png'
    return { buffer, mimeType: contentType.split(';')[0].trim() || 'image/png' }
  } catch (error) {
    if (!(error instanceof NetGuardError)) throw error
    if (error.code === 'http') throw new Error(`failed to download generated image URL (HTTP ${error.status})`)
    throw new Error(`generated image URL refused or failed: ${error.message}`)
  }
}

function withTimeout(signal, timeoutMs) {
  const ctrl = new AbortController()
  const onParent = () => ctrl.abort()
  signal?.addEventListener('abort', onParent, { once: true })
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', onParent)
    },
  }
}

function openaiImagesUrl(baseUrl) {
  const b = baseUrl.replace(/\/+$/, '')
  if (b.endsWith('/images/generations')) return b
  if (b.endsWith('/v1')) return `${b}/images/generations`
  return `${b}/v1/images/generations`
}

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }
  return { ok: res.ok, status: res.status, data, text }
}

function errorMessage(data, status, fallback) {
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string') return data.error
    if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
      return data.error.message
    }
    if (typeof data.message === 'string') return data.message
  }
  return `${fallback} (HTTP ${status})`
}

/** True for GPT Image family (gpt-image-2, gpt-image-1.5, gpt-image-1, gpt-image-1-mini). */
export function isGptImageModel(model) {
  return /^gpt-image/i.test(model.trim())
}

async function generateOpenAI(req) {
  if (!req.baseUrl) {
    throw new Error('OpenAI image generation needs IMAGE_BASE_URL (e.g. https://api.openai.com/v1).')
  }
  if (req.references?.length) {
    throw new Error(
      'reference images are not supported on the OpenAI Images API path — use a Gemini image model '
      + '(the default) for multi-image compose, or generate then re-prompt.',
    )
  }

  const url = openaiImagesUrl(req.baseUrl)
  const body = { model: req.model, prompt: req.prompt }
  if (req.size) body.size = req.size
  if (req.quality) body.quality = req.quality
  if (req.n && req.n > 1) body.n = Math.min(8, Math.floor(req.n))
  // gpt-image-* always return b64_json and reject response_format; DALL·E still needs it.
  if (!isGptImageModel(req.model)) body.response_format = 'b64_json'

  const { signal, cleanup } = withTimeout(req.signal, req.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const { ok, status, data } = await fetchJson(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.apiKey || 'no-key'}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!ok) {
      let msg = errorMessage(data, status, 'OpenAI image generation failed')
      if (/verif|organization|not available|does not have access/i.test(msg)) {
        msg += ' GPT Image models may require API Organization Verification in the OpenAI developer console.'
      }
      throw new Error(msg)
    }
    const list = data && typeof data === 'object' && Array.isArray(data.data) ? data.data : []
    if (!list.length) throw new Error('OpenAI image API returned no images')

    const images = []
    for (const item of list) {
      if (typeof item.b64_json === 'string' && item.b64_json) {
        images.push({
          buffer: Buffer.from(item.b64_json, 'base64'),
          mimeType: 'image/png',
          revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
        })
        continue
      }
      if (typeof item.url === 'string' && item.url) {
        const downloaded = await downloadGeneratedImage(item.url, { signal })
        images.push({
          buffer: downloaded.buffer,
          mimeType: downloaded.mimeType,
          revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
        })
      }
    }
    if (!images.length) throw new Error('OpenAI image API response had neither b64_json nor url')
    return { images, provider: 'openai', model: req.model }
  } finally {
    cleanup()
  }
}

function mimeOf(o) {
  if (typeof o.mime_type === 'string') return o.mime_type
  if (typeof o.mimeType === 'string') return o.mimeType
  return 'image/png'
}

function pushImage(out, seen, b64, mime) {
  if (!b64) return
  const key = b64.slice(0, 64) + String(b64.length)
  if (seen.has(key)) return
  seen.add(key)
  out.push({ buffer: Buffer.from(b64, 'base64'), mimeType: mime || 'image/png' })
}

/**
 * Walk Gemini Interactions / generateContent JSON for image bytes.
 *
 * Prefers the Interactions convenience field `output_image` (the final
 * image) so interim "thought" composition previews aren't also saved. Falls
 * back to model_output steps, then any remaining image parts (generateContent).
 */
export function extractGeminiImages(data) {
  const out = []
  const seen = new Set()
  if (!data || typeof data !== 'object') return out

  if (data.output_image && typeof data.output_image === 'object') {
    const img = data.output_image
    if (typeof img.data === 'string' && img.data) {
      pushImage(out, seen, img.data, mimeOf(img))
      return out
    }
  }

  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (!step || typeof step !== 'object') continue
      if (step.type === 'thought') continue
      if (step.type === 'model_output' || Array.isArray(step.content)) {
        const content = Array.isArray(step.content) ? step.content : []
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          if (block.type === 'image' && typeof block.data === 'string') {
            pushImage(out, seen, block.data, mimeOf(block))
          }
          const inline = block.inlineData ?? block.inline_data
          if (inline && typeof inline.data === 'string') {
            pushImage(out, seen, inline.data, mimeOf(inline))
          }
        }
      }
    }
    if (out.length) return out
  }

  const visit = (node, depth = 0) => {
    if (!node || depth > 12) return
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    if (node.type === 'thought') return
    if (
      (node.type === 'image' || node.type === 'inline_data' || node.type === 'inlineData')
      && typeof node.data === 'string' && node.data
    ) {
      pushImage(out, seen, node.data, mimeOf(node))
    }
    const inline = node.inlineData ?? node.inline_data
    if (inline && typeof inline.data === 'string' && inline.data) {
      pushImage(out, seen, inline.data, mimeOf(inline))
    }
    for (const v of Object.values(node)) visit(v, depth + 1)
  }
  visit(data)
  return out
}

async function generateGeminiInteractions(req, signal) {
  const input = [{ type: 'text', text: req.prompt }]
  for (const ref of req.references ?? []) {
    input.push({ type: 'image', mime_type: ref.mimeType, data: ref.dataBase64 })
  }

  const responseFormat = { type: 'image', mime_type: 'image/png' }
  if (req.aspectRatio) responseFormat.aspect_ratio = req.aspectRatio
  const sizeRaw = (req.imageSize || req.size || '').trim()
  // Docs require uppercase K: "0.5K" | "1K" | "2K" | "4K".
  if (sizeRaw && /^[\d.]+[kK]$/.test(sizeRaw)) responseFormat.image_size = sizeRaw.replace(/k$/i, 'K')

  const body = { model: req.model, input, response_format: responseFormat }
  const url = `${req.baseUrl.replace(/\/+$/, '')}/v1beta/interactions`
  const { ok, status, data } = await fetchJson(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': req.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (status === 404 || status === 405) return null
  if (!ok) {
    if (status === 400) return null
    throw new Error(errorMessage(data, status, 'Gemini image generation failed'))
  }
  const images = extractGeminiImages(data)
  if (!images.length) return null
  return { images, provider: 'gemini', model: req.model, rawNote: 'interactions' }
}

async function generateGeminiContent(req, signal) {
  const parts = [{ text: req.prompt }]
  for (const ref of req.references ?? []) {
    parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.dataBase64 } })
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
  }
  const modelPath = encodeURIComponent(req.model)
  const url = `${req.baseUrl.replace(/\/+$/, '')}/v1beta/models/${modelPath}:generateContent`
  const { ok, status, data } = await fetchJson(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': req.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!ok) throw new Error(errorMessage(data, status, 'Gemini generateContent image failed'))
  const images = extractGeminiImages(data)
  if (!images.length) {
    throw new Error(
      'Gemini returned no image parts. Confirm IMAGE_MODEL is an image model (e.g. gemini-2.5-flash-image).',
    )
  }
  return { images, provider: 'gemini', model: req.model, rawNote: 'generateContent' }
}

async function generateGemini(req) {
  if (!req.apiKey) {
    throw new Error('Gemini image generation needs GEMINI_API_KEY (or IMAGE_API_KEY).')
  }
  const { signal, cleanup } = withTimeout(req.signal, req.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    try {
      const viaInteractions = await generateGeminiInteractions(req, signal)
      if (viaInteractions) return viaInteractions
    } catch (err) {
      if (req.signal?.aborted || signal.aborted) throw err
    }
    return await generateGeminiContent(req, signal)
  } finally {
    cleanup()
  }
}

/** Generate one or more images via the configured provider. */
export async function generateImages(req) {
  if (!req.model?.trim()) throw new Error('an image model is required (IMAGE_MODEL or the model tool param)')
  if (!req.prompt?.trim()) throw new Error('prompt is required')
  if (req.provider === 'gemini') return generateGemini(req)
  return generateOpenAI(req)
}
