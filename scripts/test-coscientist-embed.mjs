import assert from 'node:assert/strict'
import {
  DEFAULT_EMBED_MODEL, EMBED_TASK_TYPE, MAX_TEXTS_PER_BATCH, buildEmbedBody, embedTexts, embedUrl, parseEmbeddings,
} from '../coscientist-embed.js'
import { contentTokens, tokenOverlap } from '../coscientist-models.js'
import { resetLimitersForTests } from '../search-http.js'

const noPacing = () => ({ run: (fn) => fn() })
const envStub = (values) => async (field) => values[field] ?? ''

const okResponse = (counts) => ({
  ok: true,
  status: 200,
  data: { embeddings: Array.from({ length: counts }, (_, index) => ({ values: [index, index + 1, index + 2] })) },
})

try {
  resetLimitersForTests()

  // ─── request shape ──────────────────────────────────────────────────────────
  assert.equal(DEFAULT_EMBED_MODEL, 'text-embedding-004')
  assert.equal(EMBED_TASK_TYPE, 'SEMANTIC_SIMILARITY')
  assert.match(embedUrl(undefined, DEFAULT_EMBED_MODEL), /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/text-embedding-004:batchEmbedContents$/)
  assert.equal(embedUrl('https://example.test/', 'gemini-embedding-001'), 'https://example.test/v1beta/models/gemini-embedding-001:batchEmbedContents')

  const body = buildEmbedBody(['  first idea  ', 'second idea', '', null], { model: 'm1' })
  assert.equal(body.requests.length, 2, 'blank texts are dropped, not embedded as empty strings')
  assert.equal(body.requests[0].model, 'models/m1')
  assert.deepEqual(body.requests[0].content.parts, [{ text: 'first idea' }])
  assert.equal(body.requests[1].taskType, EMBED_TASK_TYPE)
  assert.throws(() => buildEmbedBody([]), /nothing to embed/)
  assert.throws(() => buildEmbedBody(Array.from({ length: MAX_TEXTS_PER_BATCH + 1 }, (_, i) => `idea ${i}`)), /batch limit/)

  // ─── response parsing ───────────────────────────────────────────────────────
  assert.deepEqual(parseEmbeddings(okResponse(2).data, 2), { vectors: [[0, 1, 2], [1, 2, 3]] })
  assert.match(parseEmbeddings({}, 1).error, /no embeddings array/)
  assert.match(parseEmbeddings({ embeddings: [] }, 2).error, /0 of 2/)
  assert.match(parseEmbeddings({ embeddings: [{ values: [1, Number.NaN] }] }, 1).error, /finite numeric vector/)
  assert.match(parseEmbeddings({ embeddings: [{ values: [1] }, { values: [1, 2] }] }, 2).error, /has 2 dimensions, the first has 1/)

  // ─── credential and endpoint behaviour ─────────────────────────────────────
  await assert.rejects(
    () => embedTexts(['a'], { deps: { getLimiter: noPacing, resolveEnv: envStub({}) } }),
    /GEMINI_API_KEY is not set/,
    'a missing key is named, not swallowed into a silent lexical fallback',
  )

  const seen = []
  const viaImageKey = await embedTexts('one idea', {
    deps: {
      getLimiter: noPacing,
      resolveEnv: envStub({ IMAGE_API_KEY: 'image-key', CO_SCIENTIST_EMBED_MODEL: 'gemini-embedding-001' }),
      fetchJson: async (url, options) => {
        seen.push({ url, headers: options.headers, body: JSON.parse(options.body) })
        return okResponse(1)
      },
    },
  })
  assert.deepEqual(viaImageKey, [[0, 1, 2]])
  assert.equal(seen[0].headers['x-goog-api-key'], 'image-key', 'the image credential doubles as a Gemini key')
  assert.match(seen[0].url, /gemini-embedding-001/, 'CO_SCIENTIST_EMBED_MODEL overrides the default model')
  assert.equal(seen[0].url.includes('key='), false, 'the key never goes in the URL')

  await assert.rejects(
    () => embedTexts(['x'], { deps: { getLimiter: noPacing, resolveEnv: envStub({ GEMINI_API_KEY: 'k' }), fetchJson: async () => ({ ok: false, status: 403, detail: { message: 'permission denied' } }) } }),
    /Gemini embeddings error 403: permission denied.*Generative Language API/s,
  )

  await assert.rejects(
    () => embedTexts(['x'], { deps: { getLimiter: noPacing, resolveEnv: envStub({ GEMINI_API_KEY: 'k' }), fetchJson: async () => ({ ok: false, status: 0, error: 'aborted' }) } }),
    /request cancelled/,
  )

  await assert.rejects(
    () => embedTexts(['x', 'y'], { deps: { getLimiter: noPacing, resolveEnv: envStub({ GEMINI_API_KEY: 'k' }), fetchJson: async () => ({ ok: true, status: 200, data: { embeddings: [{ values: [1, 2] }] } }) } }),
    /1 of 2/,
    'a short response is an error, never a half-embedded pool',
  )

  // ─── order-free retrieval tokens ───────────────────────────────────────────
  assert.deepEqual(contentTokens('The Role of p53 in 2019 Studies'), ['role', 'p53'])
  assert.equal(tokenOverlap('chaperone triage of misfolded proteins', 'misfolded proteins are triaged by chaperones'), 0.5, 'word order is irrelevant to overlap')
  assert.equal(tokenOverlap('alpha beta gamma', 'alpha beta gamma delta epsilon'), 1, 'a subset is a strong match, not a dilution')
  assert.equal(tokenOverlap('nothing shared here', 'completely different subject matter'), 0)
  assert.equal(tokenOverlap('', 'anything'), 0, 'an empty query matches nothing')

  console.log('coscientist-embed OK')
} finally {
  resetLimitersForTests()
}
