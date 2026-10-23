/**
 * openfda: openFDA (https://api.fda.gov) adverse events, recalls, 510(k)
 * clearances, labels, and food events.
 *
 * OpenFDA's search syntax is passed through unchanged after the endpoint is
 * allowlisted. A 404 means "no matches", not an error.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const API = 'https://api.fda.gov'
const ENDPOINTS = [
  'drug/event', 'drug/enforcement', 'device/event', 'device/510k', 'drug/label', 'food/event',
]
const MAX_RESULTS = 100

function first(value) {
  if (Array.isArray(value)) return value.find((item) => item != null && item !== '') ?? null
  return value ?? null
}

function cap(value, chars = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text
}

function list(value, limit = 8) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => item != null && item !== '').slice(0, limit)
}

const NORMALIZERS = {
  'drug/event': (row) => {
    const patient = row.patient || {}
    return {
      id: row.safetyreportid || null,
      received: row.receivedate || null,
      serious: row.serious === '1',
      death: row.seriousnessdeath === '1',
      country: patient.primarysource?.reportercountry || null,
      reactions: list((patient.reaction || []).map((item) => item.reactionmeddrapt)),
      drugs: list((patient.drug || []).map((item) => item.medicinalproduct)),
    }
  },
  'drug/enforcement': (row) => ({
    id: row.recall_number || null,
    event_id: row.event_id || null,
    classification: row.classification || null,
    status: row.status || null,
    product: cap(row.product_description, 300),
    reason: cap(row.reason_for_recall, 300),
    firm: row.recalling_firm || null,
    report_date: row.report_date || null,
    recall_initiation_date: row.recall_initiation_date || null,
    voluntary_mandated: row.voluntary_mandated || null,
    distribution: cap(row.distribution_pattern, 200),
  }),
  'device/event': (row) => {
    const device = (row.device || [])[0] || {}
    return {
      id: row.mdr_report_key || null,
      event_type: row.event_type || null,
      received: row.date_received || null,
      event_date: row.date_of_event || null,
      manufacturer: row.manufacturer_name || device.manufacturer_d_name || null,
      brand_name: device.brand_name || null,
      generic_name: device.generic_name || null,
      product_code: device.device_report_product_code || null,
      problems: list(row.product_problems),
      adverse_event: row.adverse_event_flag === '1',
    }
  },
  'device/510k': (row) => ({
    id: row.k_number || null,
    device_name: row.device_name || null,
    applicant: row.applicant || null,
    decision_date: row.decision_date || null,
    decision: row.decision_description || null,
    clearance_type: row.clearance_type || null,
    product_code: row.product_code || null,
    advisory_committee: row.advisory_committee_description || null,
    summary: row.statement_or_summary ? cap(row.statement_or_summary, 200) : null,
  }),
  'drug/label': (row) => {
    const openfda = row.openfda || {}
    return {
      id: row.id || null,
      set_id: row.set_id || null,
      effective_time: row.effective_time || null,
      brand_name: first(openfda.brand_name),
      generic_name: first(openfda.generic_name),
      manufacturer: first(openfda.manufacturer_name),
      product_type: first(openfda.product_type),
      indications: cap(first(row.indications_and_usage), 600),
      warnings: cap(first(row.warnings), 600),
    }
  },
  'food/event': (row) => {
    const consumer = row.consumer || {}
    return {
      id: row.report_number || null,
      created: row.date_created || null,
      started: row.date_started || null,
      outcomes: list(row.outcomes),
      reactions: list(row.reactions),
      products: list((row.products || []).map((product) => product.name_brand || product.name)),
      consumer: {
        age: consumer.age ? `${consumer.age} ${consumer.age_unit || ''}`.trim() : null,
        gender: consumer.gender || null,
      },
    }
  },
}

function endpointUrl(endpoint, args, key) {
  const params = new URLSearchParams()
  if (args.search != null && String(args.search).trim()) params.set('search', String(args.search).trim())
  params.set('limit', String(Math.min(Math.max(Number(args.limit) || 10, 1), MAX_RESULTS)))
  if (args.skip != null) params.set('skip', String(Math.max(0, Number(args.skip) || 0)))
  if (args.sort) params.set('sort', String(args.sort).trim())
  if (key) params.set('api_key', key)
  return `${API}/${endpoint}.json?${params}`
}

export async function runOpenFda(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const readEnv = deps.resolveEnv || resolveEnv
  const endpoint = String(args.endpoint || '').trim()
  if (!ENDPOINTS.includes(endpoint)) {
    return { error: `endpoint must be one of ${ENDPOINTS.join(', ')}` }
  }
  if (!String(args.search || '').trim()) {
    return { error: 'give an openFDA search expression, e.g. patient.drug.medicinalproduct:"aspirin"' }
  }
  const key = await readEnv('OPENFDA_API_KEY')
  const limiter = getLimiter('openfda', { minIntervalMs: key ? 250 : 1000 })
  const url = endpointUrl(endpoint, args, key)
  const result = await limiter.run(() => http(url, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent() },
  }))
  if (!result.ok) {
    if (result.error === 'aborted') return { error: 'request cancelled' }
    if (result.status === 404) {
      return { endpoint, total: 0, results: [], note: 'no matches for this search', source_url: url.replace(/([?&])api_key=[^&]*&?/, '$1').replace(/[?&]$/, '') }
    }
    const hint = result.status === 429 ? ' (rate limited; set OPENFDA_API_KEY for a larger quota)' : ''
    if (result.status === 400) return { error: `openFDA rejected the search expression${result.detail ? `: ${result.detail}` : ''}` }
    return { error: `openFDA API error ${result.status}${hint}${result.detail ? `: ${result.detail}` : ''}` }
  }
  const normalize = NORMALIZERS[endpoint]
  const rows = Array.isArray(result.data?.results) ? result.data.results : []
  return {
    endpoint,
    total: result.data?.meta?.results?.total ?? rows.length,
    skip: result.data?.meta?.results?.skip ?? 0,
    limit: result.data?.meta?.results?.limit ?? rows.length,
    last_updated: result.data?.meta?.last_updated || null,
    results: rows.map(normalize),
    source_url: url.replace(/([?&])api_key=[^&]*&?/, '$1').replace(/[?&]$/, ''),
  }
}

function describeRow(endpoint, row) {
  switch (endpoint) {
    case 'drug/event':
      return [
        `${row.received || 'date?'}${row.serious ? ' · serious' : ''}${row.death ? ' · death' : ''}${row.country ? ` · ${row.country}` : ''}`,
        row.reactions.length ? `   Reactions: ${row.reactions.join('; ')}` : null,
        row.drugs.length ? `   Drugs: ${row.drugs.join('; ')}` : null,
      ]
    case 'drug/enforcement':
      return [
        `${row.report_date || 'date?'} · ${row.classification || 'classification?'} · ${row.status || 'status?'}`,
        row.product ? `   ${row.product}` : null,
        row.reason ? `   Reason: ${row.reason}` : null,
        row.firm ? `   Firm: ${row.firm}` : null,
      ]
    case 'device/event':
      return [
        `${row.received || 'date?'} · ${row.event_type || 'event?'}${row.adverse_event ? ' · adverse event' : ''}`,
        row.generic_name || row.brand_name ? `   Device: ${[row.generic_name, row.brand_name].filter(Boolean).join(' — ')}` : null,
        row.manufacturer ? `   Manufacturer: ${row.manufacturer}` : null,
        row.problems.length ? `   Problems: ${row.problems.join('; ')}` : null,
      ]
    case 'device/510k':
      return [
        `${row.decision_date || 'date?'} · ${row.decision || 'decision?'}`,
        row.device_name ? `   ${row.device_name}` : null,
        row.applicant ? `   Applicant: ${row.applicant}` : null,
        row.product_code ? `   Product code: ${row.product_code}${row.advisory_committee ? ` · ${row.advisory_committee}` : ''}` : null,
      ]
    case 'drug/label':
      return [
        `${row.effective_time || 'date?'}${row.product_type ? ` · ${row.product_type}` : ''}`,
        row.brand_name || row.generic_name ? `   ${[row.brand_name, row.generic_name].filter(Boolean).join(' — ')}` : null,
        row.manufacturer ? `   Manufacturer: ${row.manufacturer}` : null,
        row.indications ? `   Indications: ${row.indications}` : null,
      ]
    case 'food/event':
      return [
        `${row.created || 'date?'}${row.consumer?.gender ? ` · ${row.consumer.gender}` : ''}`,
        row.products.length ? `   Products: ${row.products.join('; ')}` : null,
        row.reactions.length ? `   Reactions: ${row.reactions.join('; ')}` : null,
      ]
    default:
      return []
  }
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const rows = value.results || []
  const header = `${value.endpoint}: ${value.total ?? rows.length} match(es)${value.results?.length ? `, showing ${rows.length} from skip ${value.skip}` : ''}`
  if (!rows.length) return [{ type: 'text', text: `${header}\n\n${value.note || 'No records.'}\n${value.source_url}` }]
  const lines = [header]
  rows.forEach((row, index) => {
    const bits = describeRow(value.endpoint, row).filter(Boolean)
    lines.push('', `${index + 1}. ${bits[0] || '(record)'}${row.id ? ` · ${row.id}` : ''}`)
    for (const bit of bits.slice(1)) lines.push(bit)
  })
  if (value.source_url) lines.push('', `Source: ${value.source_url}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-openfda'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'openfda',
    description: [
      'Query openFDA for drug and device adverse events, recalls, 510(k) clearances, drug labels, and food adverse events.',
      'Pick an `endpoint` and pass an openFDA `search` expression unchanged, e.g. `patient.drug.medicinalproduct:"semaglutide"` on drug/event, `classification:"Class I"` on drug/enforcement, `device_name:"infusion pump"` on device/510k. Results include the source query URL for verification.',
      'Free and keyless; OPENFDA_API_KEY is optional and raises the rate limit (`429` means the quota is exhausted). A no-match search returns an empty result, not an error. Informational only: it is not medical or legal advice, and it is not a literature search.',
    ].join(' '),
    parameters: {
      endpoint: {
        type: 'string',
        enum: ENDPOINTS,
        description: `Dataset to search: ${ENDPOINTS.join(', ')}.`,
      },
      search: {
        type: 'string',
        description: 'openFDA search expression, e.g. patient.drug.medicinalproduct:"aspirin" AND serious:"1".',
      },
      limit: { type: 'number', description: 'Records per page, 1-100. Default 10.' },
      skip: { type: 'number', description: 'Pagination offset.' },
      sort: { type: 'string', description: 'Sort expression, e.g. receivedate:desc.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runOpenFda(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `openFDA: ${args.endpoint || ''}`, kind: 'search' }
    },
  }))
}
