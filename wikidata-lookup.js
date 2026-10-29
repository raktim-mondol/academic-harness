/**
 * Wikidata identity resolution: persons, institutions, journals, and papers to
 * QIDs with ORCID/ROR/ISSN/DOI cross-identifiers. Keyless; uses entity search,
 * entity claims, and a small allowlisted SPARQL template per external ID.
 */
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'

const WIKIDATA = 'https://www.wikidata.org/w/api.php'
const SPARQL = 'https://query.wikidata.org/sparql'
const TYPES = ['person', 'institution', 'journal', 'paper']
const PROPERTIES = {
  person: { claim: 'P496', key: 'orcid' },
  institution: { claim: 'P678', key: 'ror' },
  journal: { claim: 'P236', key: 'issn' },
  paper: { claim: 'P356', key: 'doi' },
}
const TYPE_QIDS = {
  person: new Set(['Q5']),
  institution: new Set(['Q3918', 'Q43229', 'Q327333', 'Q2385804', 'Q31855']),
  journal: new Set(['Q5633421', 'Q737498']),
  paper: new Set(['Q13442814', 'Q191067', 'Q7318358', 'Q580922']),
}

function limiter() {
  return getLimiter('wikidata', { minIntervalMs: 1000 })
}

function sparqlEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function qidOf(url) {
  const match = String(url || '').match(/(Q\d+)$/)
  return match ? match[1] : null
}

function firstClaim(entity, property) {
  const claims = entity?.claims?.[property] || []
  for (const claim of claims) {
    const value = claim?.mainsnak?.datavalue?.value
    if (typeof value === 'string') return value
    if (value?.id) return value.id
  }
  return null
}

function entitySummary(entity) {
  const labels = entity?.labels || {}
  const descriptions = entity?.descriptions || {}
  const aliases = entity?.aliases || {}
  return {
    qid: entity?.id || null,
    label: labels.en?.value || Object.values(labels)[0]?.value || null,
    description: descriptions.en?.value || Object.values(descriptions)[0]?.value || null,
    aliases: (aliases.en || Object.values(aliases)[0] || []).map((alias) => alias.value).filter(Boolean).slice(0, 8),
    url: entity?.id ? `https://www.wikidata.org/wiki/${entity.id}` : null,
    claims: {
      orcid: firstClaim(entity, 'P496'),
      ror: firstClaim(entity, 'P678'),
      issn: firstClaim(entity, 'P236'),
      doi: firstClaim(entity, 'P356'),
      instance_of: firstClaim(entity, 'P31'),
      title: firstClaim(entity, 'P1476'),
    },
  }
}

async function fetchEntity(qid, exec) {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    props: 'claims|labels|descriptions|aliases',
    languages: 'en',
    format: 'json',
  })
  const result = await limiter().run(() => fetchJson(`${WIKIDATA}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(), Accept: 'application/json' },
  }))
  if (!result.ok) return { error: result }
  return { entity: result.data?.entities?.[qid] || null }
}

async function searchEntities(query, limit, exec) {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: query,
    language: 'en',
    uselang: 'en',
    type: 'item',
    limit: String(Math.min(Math.max(Number(limit) || 10, 1), 50)),
    format: 'json',
  })
  const result = await limiter().run(() => fetchJson(`${WIKIDATA}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(), Accept: 'application/json' },
  }))
  if (!result.ok) return { error: result }
  return { hits: Array.isArray(result.data?.search) ? result.data.search : [] }
}

async function externalIdQuery(type, value, exec) {
  const property = PROPERTIES[type]
  if (!property) return { error: `type must be one of ${TYPES.join(', ')}` }
  const query = `SELECT ?item WHERE { ?item wdt:${property.claim} "${sparqlEscape(value)}" } LIMIT 5`
  const params = new URLSearchParams({ query, format: 'json' })
  const result = await limiter().run(() => fetchJson(`${SPARQL}?${params}`, {
    signal: exec?.signal,
    headers: { 'User-Agent': searchUserAgent(), Accept: 'application/sparql-results+json' },
  }))
  if (!result.ok) return { error: result }
  const bindings = result.data?.results?.bindings || []
  return { qids: bindings.map((binding) => qidOf(binding.item?.value)).filter(Boolean) }
}

export async function runWikidataLookup(args, exec) {
  const action = String(args.action || 'resolve').toLowerCase()
  if (action !== 'resolve') return { error: 'action must be resolve' }

  const qidInput = String(args.qid || args.id || '').match(/^Q\d+$/)?.[0] || null
  const external = {
    orcid: String(args.orcid || '').trim() || null,
    ror: String(args.ror || '').trim() || null,
    issn: String(args.issn || '').trim() || null,
    doi: String(args.doi || '').trim() || null,
  }
  const type = TYPES.includes(args.type)
    ? args.type
    : (external.orcid ? 'person' : external.ror ? 'institution' : external.issn ? 'journal' : external.doi ? 'paper' : null)
  if (!qidInput && args.id && type && PROPERTIES[type] && !external[PROPERTIES[type].key]) {
    external[PROPERTIES[type].key] = String(args.id).trim()
  }
  const query = String(args.query || '').trim()
  const externalValue = type ? external[PROPERTIES[type]?.key] : null
  const supplied = Object.entries(external).filter(([, value]) => value)

  if (type && supplied.some(([key]) => key !== PROPERTIES[type]?.key)) {
    return { error: `type ${type} does not match the supplied identifier` }
  }
  if (!qidInput && !query && !externalValue) {
    return { error: type ? `give a ${type} query or identifier` : 'give query, qid/id, or an orcid/ror/issn/doi' }
  }

  let qids = []
  if (qidInput) qids = [qidInput]
  else {
    if (externalValue) {
      const resolved = await externalIdQuery(type, externalValue, exec)
      if (resolved.error) {
        const result = resolved.error
        if (result.error === 'aborted') return { error: 'request cancelled' }
        return { error: `Wikidata API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
      }
      qids = resolved.qids
    } else {
      const searched = await searchEntities(query, args.limit, exec)
      if (searched.error) {
        const result = searched.error
        if (result.error === 'aborted') return { error: 'request cancelled' }
        return { error: `Wikidata API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
      }
      qids = searched.hits.map((hit) => hit.id).filter(Boolean)
    }
  }

  const entities = []
  const allowed = type ? TYPE_QIDS[type] : null
  for (const qid of qids) {
    const fetched = await fetchEntity(qid, exec)
    if (fetched.error) {
      const result = fetched.error
      if (result.error === 'aborted') return { error: 'request cancelled' }
      return { error: `Wikidata API error ${result.status}`, status: result.status, detail: result.detail ?? result.error }
    }
    if (!fetched.entity) continue
    const summary = entitySummary(fetched.entity)
    if (allowed && !allowed.has(summary.claims.instance_of)) continue
    entities.push(summary)
  }
  return {
    action,
    type,
    query: query || null,
    entities,
    ...(type && entities.length === 0 ? { note: `No Wikidata entity of type ${type} matched.` } : {}),
  }
}

export function renderWikidataDomain(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (!value.entities?.length) return [{ type: 'text', text: value.note || 'No Wikidata entity found.' }]
  const lines = value.entities.map((entity) => {
    const ids = [
      entity.claims.orcid && `ORCID ${entity.claims.orcid}`,
      entity.claims.ror && `ROR ${entity.claims.ror}`,
      entity.claims.issn && `ISSN ${entity.claims.issn}`,
      entity.claims.doi && `DOI ${entity.claims.doi}`,
      entity.claims.instance_of && `instance of ${entity.claims.instance_of}`,
    ].filter(Boolean)
    return [
      `**${entity.label || entity.qid}** (${entity.qid})`,
      entity.description || null,
      ids.length ? ids.join(' · ') : null,
      entity.url,
    ].filter(Boolean).join('\n')
  })
  return [{ type: 'text', text: [`Wikidata ${value.type || 'entities'}: ${value.entities.length}`, ...lines].join('\n\n') }]
}
