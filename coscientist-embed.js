/**
 * Optional text embeddings for the hypothesis tournament's duplicate gate.
 *
 * The plan assumed `zg` could supply local embeddings. It cannot: `zg query
 * --vector <text>` embeds a query to search an *index* and never returns the
 * vector, so there is no text → embedding path through it. Gemini's embedding
 * endpoint is the reachable one, and the plugin already carries
 * `GEMINI_API_KEY` for image generation — so this reuses that credential rather
 * than introducing a provider, a model download, or a dependency.
 *
 * Embedding is strictly opt-in (`coscientist embed`). Without it the tournament
 * runs the lexical gate, which needs no network, no key, and no download. When
 * vectors are present the gate switches to upstream's cosine thresholds, because
 * a 0.70-similar cosine pair is not a 0.70-Jaccard pair (coscientist-models.js
 * `defaultThresholds`).
 */
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const GEMINI_HOST = 'https://generativelanguage.googleapis.com'

/** 768-dimension default; `gemini-embedding-001` also works via the override. */
export const DEFAULT_EMBED_MODEL = 'text-embedding-004'

/** Comparing like with like: mixed RETRIEVAL_DOCUMENT/QUERY roles skew cosine. */
export const EMBED_TASK_TYPE = 'SEMANTIC_SIMILARITY'

/** One batch per call keeps a tournament's cost bounded. */
export const MAX_TEXTS_PER_BATCH = 96

export function embedUrl(baseUrl, model) {
  const base = String(baseUrl || GEMINI_HOST).replace(/\/+$/, '')
  return `${base}/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`
}

/** The Gemini batch body: one request per text, same task type for all. */
export function buildEmbedBody(texts, { model = DEFAULT_EMBED_MODEL, taskType = EMBED_TASK_TYPE } = {}) {
  const clean = texts.map((value) => String(value ?? '').trim()).filter(Boolean)
  if (!clean.length) throw new Error('nothing to embed')
  if (clean.length > MAX_TEXTS_PER_BATCH) {
    throw new Error(`${clean.length} texts exceeds the ${MAX_TEXTS_PER_BATCH}-per-call batch limit`)
  }
  return {
    requests: clean.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType,
    })),
  }
}

/**
 * Read vectors out of a batch response, positionally. A short or malformed
 * response is an error rather than a silent gap: an unembedded hypothesis left
 * in the pool would be compared lexically while its neighbours are compared by
 * cosine, and the ledger could not tell the two apart afterwards.
 */
export function parseEmbeddings(payload, expected) {
  const embeddings = Array.isArray(payload?.embeddings) ? payload.embeddings : null
  if (!embeddings) return { error: 'embedding response had no embeddings array' }
  if (embeddings.length !== expected) {
    return { error: `embedding response returned ${embeddings.length} of ${expected} vectors` }
  }
  const vectors = []
  for (const [index, entry] of embeddings.entries()) {
    const values = Array.isArray(entry?.values) ? entry.values.map(Number) : null
    if (!values || !values.length || values.some((value) => !Number.isFinite(value))) {
      return { error: `embedding ${index + 1} was not a finite numeric vector` }
    }
    if (index > 0 && values.length !== vectors[0].length) {
      return { error: `embedding ${index + 1} has ${values.length} dimensions, the first has ${vectors[0].length}` }
    }
    vectors.push(values)
  }
  return { vectors }
}

/**
 * Embed texts in one batch. Throws with the reason — a missing key, a rejected
 * request, a malformed response — so the caller reports why vectors are absent
 * instead of falling back quietly and labelling the result a semantic check.
 */
/** The model id this call would use, for reporting and ledger provenance. */
export async function resolveEmbedModel({ model, deps = {} } = {}) {
  const explicit = String(model ?? '').trim()
  if (explicit) return explicit
  const readEnv = deps.resolveEnv || resolveEnv
  return String(await readEnv('CO_SCIENTIST_EMBED_MODEL') ?? '').trim() || DEFAULT_EMBED_MODEL
}

export async function embedTexts(texts, { signal, apiKey, baseUrl, model, deps = {} } = {}) {
  const list = Array.isArray(texts) ? texts : [texts]
  const clean = list.map((value) => String(value ?? '').trim()).filter(Boolean)
  const readEnv = deps.resolveEnv || resolveEnv
  const key = String(apiKey || await readEnv('GEMINI_API_KEY') || await readEnv('IMAGE_API_KEY') || '').trim()
  if (!key) throw new Error('GEMINI_API_KEY is not set (Settings → Academic Harness API keys). Without a key, keep the lexical duplicate gate — it needs none.')
  const modelId = String(model || await readEnv('CO_SCIENTIST_EMBED_MODEL') || DEFAULT_EMBED_MODEL).trim()

  let body
  try {
    body = buildEmbedBody(clean, { model: modelId })
  } catch (error) {
    throw new Error(error.message)
  }

  const http = deps.fetchJson || fetchJson
  const limiter = (deps.getLimiter || getLimiter)('coscientist-embed', { minIntervalMs: 250 })
  const result = await limiter.run(() => http(embedUrl(baseUrl, modelId), {
    method: 'POST',
    signal,
    timeoutMs: 60_000,
    headers: {
      'Content-Type': 'application/json',
      // Header rather than ?key= so the credential stays out of URLs and logs.
      'x-goog-api-key': key,
      'User-Agent': searchUserAgent(),
    },
    body: JSON.stringify(body),
  }))

  if (result.error === 'aborted') throw new Error('embedding request cancelled')
  if (!result.ok) {
    const detail = typeof result.detail === 'string' ? result.detail : result.detail?.message || result.error || ''
    throw new Error(`Gemini embeddings error ${result.status}${detail ? `: ${detail}` : ''}${result.status === 403 ? ' (check GEMINI_API_KEY has the Generative Language API enabled)' : ''}`)
  }

  const parsed = parseEmbeddings(result.data, clean.length)
  if (parsed.error) throw new Error(parsed.error)
  return parsed.vectors
}
