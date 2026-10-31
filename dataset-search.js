/**
 * dataset_search: DataCite dataset discovery plus file listings for Zenodo
 * and Figshare records.
 *
 * DataCite is the DOI registration agency for datasets, so it covers Zenodo,
 * Figshare, Dryad, OSF, Dataverse, and institutional repositories in one API.
 * File listing is best-effort for the two repositories with public file APIs;
 * other repositories return the landing URL instead.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, getLimiter, searchUserAgent } from './search-http.js'
import { canonicalDoi } from './search-normalize.js'

const DATACITE = 'https://api.datacite.org/dois'
const ZENODO = 'https://zenodo.org/api/records'
const FIGSHARE = 'https://api.figshare.com/v2/articles'

function cap(value, chars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text
}

function doiPath(doi) {
  return encodeURIComponent(doi).replace(/%2F/gi, '/')
}

function licenseOf(rightsList) {
  const names = (Array.isArray(rightsList) ? rightsList : [])
    .map((right) => right?.rightsIdentifier || right?.rights)
    .filter(Boolean)
  return names.length ? [...new Set(names)].join('; ') : null
}

export function normalizeDataset(item) {
  const attributes = item?.attributes || item || {}
  const doi = canonicalDoi(attributes.doi) || canonicalDoi(item?.id)
  const titles = attributes.titles || []
  return {
    doi,
    title: cap(titles[0]?.title, 500),
    creators: (attributes.creators || []).slice(0, 8).map((creator) => {
      if (creator.name) return creator.name
      return [creator.givenName, creator.familyName].filter(Boolean).join(' ') || null
    }).filter(Boolean),
    publisher: attributes.publisher || null,
    year: attributes.publicationYear || null,
    resource_type: attributes.types?.resourceTypeGeneral || 'Dataset',
    resource_type_detail: attributes.types?.resourceType || null,
    version: attributes.version || null,
    license: licenseOf(attributes.rightsList),
    url: attributes.url || (doi ? `https://doi.org/${doi}` : null),
    description: cap(
      (attributes.descriptions || []).find((entry) => entry.descriptionType === 'Abstract')?.description
        ?? attributes.descriptions?.[0]?.description,
      500,
    ),
  }
}

function nextCursor(links) {
  const next = links?.next
  if (!next) return null
  try {
    return new URL(next).searchParams.get('page[cursor]')
  } catch {
    return null
  }
}

function dataciteQuery(args) {
  const parts = []
  if (String(args.query || '').trim()) parts.push(String(args.query).trim())
  if (String(args.repository || '').trim()) {
    const repository = String(args.repository).trim().replace(/"/g, '\\"')
    parts.push(`publisher:"${repository}"`)
  }
  return parts.join(' AND ')
}

export async function runDatasetSearch(args, exec, deps = {}) {
  const http = deps.fetchJson || fetchJson
  const readEnv = deps.resolveEnv || resolveEnv
  const action = args.action || 'search'
  if (!['search', 'get', 'files'].includes(action)) return { error: 'action must be search, get, or files' }

  if (action === 'files') {
    const doi = canonicalDoi(args.doi)
    if (!doi) return { error: 'give a dataset DOI' }
    const landing = `https://doi.org/${doi}`
    const zenodo = doi.match(/^10\.5281\/zenodo\.(\d+)(?:\.\d+)?$/i)
    const figshare = doi.match(/^10\.6084\/m9\.figshare\.(\d+)(?:\.v\d+)?$/i)
    if (!zenodo && !figshare) {
      return {
        doi,
        files_unavailable: true,
        reason: 'file listings are resolved only for Zenodo and Figshare DOIs; open the landing page',
        landing_url: landing,
      }
    }
    const limiter = getLimiter(zenodo ? 'zenodo' : 'figshare', { minIntervalMs: 500 })
    const key = await readEnv(zenodo ? 'ZENODO_API_KEY' : 'FIGSHARE_API_KEY')
    const url = zenodo
      ? `${ZENODO}/${zenodo[1]}/files?size=100`
      : `${FIGSHARE}/${figshare[1]}/files`
    let result = await limiter.run(() => http(url, {
      signal: exec?.signal,
      headers: authHeaders({ key, scheme: zenodo ? 'Bearer' : 'token' }),
    }))
    let entries = Array.isArray(result.data) ? result.data : (result.data?.entries || [])
    if (zenodo && (!result.ok || !entries.length)) {
      // Zenodo's newer API inlines the file list in the record payload and can
      // 404 the /files endpoint; fall back to it before declaring the record
      // unavailable.
      const record = await limiter.run(() => http(`${ZENODO}/${zenodo[1]}`, {
        signal: exec?.signal,
        headers: authHeaders({ key, scheme: 'Bearer' }),
      }))
      if (record.ok) {
        result = record
        entries = Array.isArray(record.data?.files) ? record.data.files : (record.data?.files?.entries || [])
      } else if (!result.ok) {
        if (result.status === 404 || record.status === 404) {
          return { doi, files_unavailable: true, reason: 'repository record not public or not found', landing_url: landing }
        }
        return { error: `Zenodo API error ${result.status}${result.detail ? `: ${result.detail}` : ''}` }
      }
    }
    if (!result.ok) {
      if (result.status === 404) {
        return { doi, files_unavailable: true, reason: 'repository record not public or not found', landing_url: landing }
      }
      return { error: `${zenodo ? 'Zenodo' : 'Figshare'} API error ${result.status}${result.detail ? `: ${result.detail}` : ''}` }
    }
    const files = entries.map((entry) => ({
      name: entry.key || entry.name || null,
      size: entry.size ?? null,
      checksum: entry.checksum || entry.supplied_md5 || entry.computed_md5 || null,
      download_url: entry.links?.self || entry.download_url || null,
    })).filter((file) => file.name)
    return {
      doi,
      repository: zenodo ? 'Zenodo' : 'Figshare',
      file_count: files.length,
      truncated: Boolean(!Array.isArray(result.data) && result.data?.links?.next),
      files,
      landing_url: landing,
    }
  }

  if (action === 'get') {
    const doi = canonicalDoi(args.doi)
    if (!doi) return { error: 'give a dataset DOI' }
    const dataciteKey = await readEnv('DATACITE_API_KEY')
    const limiter = getLimiter('datacite', { minIntervalMs: 500 })
    const result = await limiter.run(() => http(`${DATACITE}/${doiPath(doi)}`, {
      signal: exec?.signal,
      headers: authHeaders({ key: dataciteKey }),
    }))
    if (!result.ok) {
      if (result.status === 404) return { error: `dataset DOI not found in DataCite: ${doi}`, status: 404 }
      return { error: `DataCite API error ${result.status}${result.detail ? `: ${result.detail}` : ''}` }
    }
    return { dataset: normalizeDataset(result.data?.data) }
  }

  if (!String(args.query || '').trim() && !String(args.repository || '').trim() && !args.year) {
    return { error: 'give a query, repository, or year' }
  }
  const mailto = await readEnv('CROSSREF_MAILTO') || await readEnv('UNPAYWALL_EMAIL')
  const dataciteKey = await readEnv('DATACITE_API_KEY')
  const params = new URLSearchParams({
    'resource-type-id': 'dataset',
    'page[size]': String(Math.min(Math.max(Number(args.limit) || 10, 1), 100)),
  })
  const query = dataciteQuery(args)
  if (query) params.set('query', query)
  if (args.year) {
    const year = Number(args.year)
    if (!Number.isInteger(year) || year < 1900 || year > 2100) return { error: 'year must be a four-digit year' }
    params.set('published', String(year))
  }
  if (args.cursor) params.set('page[cursor]', String(args.cursor).trim())
  if (mailto) params.set('mailto', mailto)

  const limiter = getLimiter('datacite', { minIntervalMs: 500 })
  const result = await limiter.run(() => http(`${DATACITE}?${params}`, {
    signal: exec?.signal,
    headers: authHeaders({ key: dataciteKey, mailto }),
  }))
  if (!result.ok) {
    return { error: `DataCite API error ${result.status}${result.detail ? `: ${result.detail}` : ''}` }
  }
  const results = (result.data?.data || []).map(normalizeDataset).filter((dataset) => dataset.doi)
  return {
    total: result.data?.meta?.total ?? results.length,
    returned: results.length,
    next_cursor: nextCursor(result.data?.links),
    results,
  }
}

function authHeaders({ key, scheme = 'Bearer', mailto = null } = {}) {
  const headers = { 'User-Agent': searchUserAgent(mailto) }
  if (key) headers.Authorization = `${scheme} ${key}`
  return headers
}

function renderDataset(dataset, index) {
  const meta = [dataset.publisher, dataset.year, dataset.resource_type].filter(Boolean).join(' · ')
  const lines = [
    `${index ? `${index}. ` : ''}**${dataset.title || '(untitled)'}**`,
    `   ${dataset.doi ? `doi:${dataset.doi}` : '(no DOI)'}${meta ? ` · ${meta}` : ''}`,
  ]
  if (dataset.creators.length) lines.push(`   Creators: ${dataset.creators.join('; ')}`)
  if (dataset.version) lines.push(`   Version: ${dataset.version}`)
  if (dataset.license) lines.push(`   License: ${dataset.license}`)
  if (dataset.description) lines.push(`   ${dataset.description}`)
  if (dataset.url) lines.push(`   ${dataset.url}`)
  return lines.join('\n')
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.files || value.files_unavailable) {
    if (value.files_unavailable) {
      return [{ type: 'text', text: `Files unavailable for ${value.doi}: ${value.reason}\n${value.landing_url}` }]
    }
    const header = `${value.repository} files for ${value.doi}: ${value.file_count}${value.truncated ? '+ (first 100)' : ''}`
    const body = value.files.map((file) => `- ${file.name}${file.size != null ? ` (${formatBytes(file.size)})` : ''}${file.checksum ? ` · ${file.checksum}` : ''}`).join('\n')
    return [{ type: 'text', text: `${header}\n${body}\n${value.landing_url}` }]
  }
  if (value.dataset) return [{ type: 'text', text: renderDataset(value.dataset, 0) }]
  const header = `${value.total ?? value.returned} dataset(s)${value.next_cursor ? ` · next_cursor: ${value.next_cursor}` : ''}`
  const body = value.results.map((dataset, index) => renderDataset(dataset, index + 1)).join('\n\n') || 'No datasets matched.'
  return [{ type: 'text', text: `${header}\n\n${body}` }]
}

function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value)) return `${bytes} B`
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

export const name = 'academic-harness-dataset-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'dataset_search',
    description: [
      'Find research datasets by DOI metadata through DataCite, and list the files in Zenodo or Figshare records.',
      '`search` takes a full-text `query`, a `repository` name (e.g. Zenodo, Dryad, Figshare), and/or a publication `year`, and returns DOI, title, creators, publisher, version, license, and URL plus a `next_cursor`. `get` reads one dataset DOI. `files` lists names, sizes, and download URLs for Zenodo/Figshare DOIs; other repositories return the landing URL.',
      'Free and keyless. Use it for data-availability statements and dataset citations, and cite the dataset DOI rather than a generic repository URL. Never infer a license or version that the record does not state; nothing here downloads data.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['search', 'get', 'files'], description: 'search (default), get, or files.' },
      query: { type: 'string', description: 'Full-text dataset query, e.g. "single-cell RNA seq mouse cortex".' },
      repository: { type: 'string', description: 'Repository/publisher name filter, e.g. Zenodo, Dryad, Figshare.' },
      year: { type: 'number', description: 'Publication year filter.' },
      limit: { type: 'number', description: 'Results per page, 1-100. Default 10.' },
      cursor: { type: 'string', description: 'next_cursor from a previous DataCite response.' },
      doi: { type: 'string', description: 'Dataset DOI (get/files).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runDatasetSearch(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Datasets: ${args.query || args.doi || args.repository || ''}`, kind: 'search' }
    },
  }))
}
