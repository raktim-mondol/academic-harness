/**
 * domain_search: source-specific lookups and ops that a generic literature
 * search cannot express. Router adapters add no tool schema; this is the one
 * new tool. Keyed sources return key_missing without making a network call.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  renderBiorxivDomain,
  runBiorxivDomain,
} from './biorxiv-search.js'
import {
  renderAclDomain,
  runAclDomain,
} from './acl-lookup.js'
import {
  renderInspireDomain,
  runInspireDomain,
} from './inspire-search.js'
import {
  renderAdsDomain,
  runAdsDomain,
} from './ads-search.js'
import {
  renderScopusDomain,
  runScopusDomain,
} from './scopus-search.js'
import {
  renderWosDomain,
  runWosDomain,
} from './wos-search.js'
import {
  renderWikidataDomain,
  runWikidataLookup,
} from './wikidata-lookup.js'

export const DOMAIN_SOURCES = ['biorxiv', 'acl', 'inspire', 'ads', 'scopus', 'wos', 'wikidata']

const HANDLERS = {
  biorxiv: { run: runBiorxivDomain, render: renderBiorxivDomain },
  acl: { run: runAclDomain, render: renderAclDomain },
  inspire: { run: runInspireDomain, render: renderInspireDomain },
  ads: { run: runAdsDomain, render: renderAdsDomain },
  scopus: { run: runScopusDomain, render: renderScopusDomain },
  wos: { run: runWosDomain, render: renderWosDomain },
  wikidata: { run: runWikidataLookup, render: renderWikidataDomain },
}

export async function runDomainSearch(args, exec) {
  const source = String(args.source || '').trim().toLowerCase()
  const handler = HANDLERS[source]
  if (!handler) return { error: `source must be one of ${DOMAIN_SOURCES.join(', ')}` }
  const value = await handler.run(args, exec)
  return { source, ...value }
}

function renderValue(value) {
  const handler = HANDLERS[value?.source]
  return handler ? handler.render(value) : [{ type: 'text', text: 'No domain result.' }]
}

export const name = 'academic-harness-domain-search'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'domain_search',
    description: [
      'Source-specific academic lookups beyond literature_search. Set `source` and a source-specific `action`.',
      'biorxiv: browse (start/end/category), doi, published. acl: record. inspire: record, citations, references, texkey, bibtex. ads: record, citations, references, export, metrics (ADS_API_TOKEN). scopus: record, author, cited_by (SCOPUS_API_KEY; institutional IP/VPN). wos: record, cited_by (WOS_API_KEY; Starter limits apply). wikidata: resolve a person, institution, journal, or paper (query, qid, or an orcid/ror/issn/doi).',
      'Keyed sources make no request when their key is unset; they return key_missing naming the Settings field. Scopus/WoS records are metadata-only. Use literature_search for ordinary discovery and this tool for source-specific actions.',
    ].join(' '),
    parameters: {
      source: {
        type: 'string',
        enum: DOMAIN_SOURCES,
        required: true,
        description: 'Domain source to query.',
      },
      action: {
        type: 'string',
        description: 'Source-specific action; see the tool description. Defaults: biorxiv=browse, acl=record, inspire=record, ads=record, scopus=record, wos=record, wikidata=resolve.',
      },
      query: { type: 'string', description: 'Free-text query (search, author, venue, or Wikidata entity search).' },
      id: { type: 'string', description: 'Source-specific identifier (DOI, ACL ID, INSPIRE recid, Scopus EID, WoS UID).' },
      doi: { type: 'string', description: 'DOI for biorxiv/Scopus/WoS/Wikidata lookups.' },
      bibcode: { type: 'string', description: 'ADS bibcode.' },
      bibcodes: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'ADS bibcodes for export or metrics.',
      },
      uid: { type: 'string', description: 'Web of Science UID.' },
      qid: { type: 'string', description: 'Wikidata QID.' },
      orcid: { type: 'string', description: 'ORCID iD for Wikidata resolution.' },
      ror: { type: 'string', description: 'ROR iD for Wikidata resolution.' },
      issn: { type: 'string', description: 'ISSN for Wikidata resolution.' },
      author_id: { type: 'string', description: 'Scopus author iD.' },
      recid: { type: 'string', description: 'INSPIRE record id.' },
      acl_id: { type: 'string', description: 'ACL Anthology id.' },
      server: { type: 'string', enum: ['biorxiv', 'medrxiv'], description: 'bioRxiv server. Default biorxiv.' },
      category: { type: 'string', description: 'bioRxiv subject category for browse.' },
      start: { type: 'string', description: 'bioRxiv browse start date (YYYY-MM-DD).' },
      end: { type: 'string', description: 'bioRxiv browse end date (YYYY-MM-DD).' },
      cursor: { type: 'number', description: 'bioRxiv browse cursor.' },
      offset: { type: 'number', description: 'Result offset where supported.' },
      limit: { type: 'number', description: 'Maximum results or records.' },
      page: { type: 'number', description: 'Page number where supported.' },
      sort: { type: 'string', description: 'Source-specific sort expression.' },
      type: { type: 'string', enum: ['person', 'institution', 'journal', 'paper'], description: 'Wikidata entity type.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      return runDomainSearch(args, exec)
    },
    presentCall(args) {
      const target = args.id || args.query || args.doi || args.bibcode || args.uid || args.qid || ''
      return { card: 'generic', title: `Domain search: ${args.source || ''} ${args.action || ''} ${target}`.trim(), kind: 'search' }
    },
  }))
}
