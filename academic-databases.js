/**
 * database_catalog: what the academic-search stack can reach, which key it
 * needs, and which tool fronts it. Key values are never read into the result;
 * only a configured/unconfigured boolean is exposed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'

export const DATABASES = [
  {
    id: 'openalex',
    name: 'OpenAlex',
    category: 'Open scholarly graph',
    base_url: 'https://api.openalex.org',
    auth: 'Optional OPENALEX_API_KEY; mailto polite pool',
    rate_limit: '10 RPS keyless / 30 RPS keyed; semantic search 1 RPS',
    capabilities: ['works', 'sources', 'citations', 'topics', 'OA PDFs', 'abstract reconstruction'],
    key_field: 'OPENALEX_API_KEY',
    live_without_key: true,
    tools: ['openalex_search', 'openalex_citations', 'paper_get', 'journal_search', 'paper_context'],
  },
  {
    id: 'semantic_scholar',
    name: 'Semantic Scholar',
    category: 'Open scholarly graph',
    base_url: 'https://api.semanticscholar.org/graph/v1',
    auth: 'Optional S2_API_KEY',
    rate_limit: 'Shared keyless pool; 1 RPS with a key',
    capabilities: ['relevance search', 'bulk boolean search', '500-word snippets', 'TLDRs', 'citation counts', 'BibTeX'],
    key_field: 'S2_API_KEY',
    live_without_key: true,
    tools: ['s2_search', 'paper_get', 'paper_context'],
  },
  {
    id: 'crossref',
    name: 'Crossref',
    category: 'DOI registry',
    base_url: 'https://api.crossref.org/v1',
    auth: 'Optional CROSSREF_MAILTO polite pool',
    rate_limit: '1 RPS public list / 3 RPS polite',
    capabilities: ['works', 'journals', 'DOI metadata', 'publisher member search', 'DOI BibTeX'],
    key_field: 'CROSSREF_MAILTO',
    live_without_key: true,
    tools: ['crossref_lookup', 'journal_search', 'literature_search', 'paper_get', 'citation'],
  },
  {
    id: 'arxiv',
    name: 'arXiv',
    category: 'STEM preprints',
    base_url: 'https://export.arxiv.org/api/query',
    auth: 'None',
    rate_limit: '1 request / 3 s, 1 connection',
    capabilities: ['fielded search', 'BibTeX', 'LaTeXML HTML'],
    key_field: null,
    live_without_key: true,
    tools: ['arxiv_search', 'paper_get', 'paper_context', 'citation'],
  },
  {
    id: 'pubmed_europepmc',
    name: 'PubMed / Europe PMC',
    category: 'Biomedical literature',
    base_url: 'https://www.ebi.ac.uk/europepmc/webservices/rest',
    auth: 'Optional NCBI_API_KEY / NCBI_EMAIL',
    rate_limit: 'Europe PMC public; NCBI 3 RPS keyless / 10 RPS keyed',
    capabilities: ['search', 'DOI/PMID/PMCID lookup', 'MeSH', 'OA links', 'PMC BioC', 'PubTator3'],
    key_field: 'NCBI_API_KEY',
    live_without_key: true,
    tools: ['pubmed_search', 'paper_get', 'paper_context'],
  },
  {
    id: 'doaj',
    name: 'DOAJ',
    category: 'Open-access journals',
    base_url: 'https://doaj.org/api/v4',
    auth: 'None',
    rate_limit: 'Public REST',
    capabilities: ['journal search', 'article search', 'APC', 'licenses', 'OA status'],
    key_field: null,
    live_without_key: true,
    tools: ['journal_search', 'literature_search', 'journal_policy'],
  },
  {
    id: 'inspire',
    name: 'INSPIRE-HEP',
    category: 'High-energy physics',
    base_url: 'https://inspirehep.net/api',
    auth: 'None',
    rate_limit: '3 RPS',
    capabilities: ['papers', 'citations', 'references', 'texkeys', 'BibTeX'],
    key_field: null,
    live_without_key: true,
    tools: ['domain_search', 'literature_search', 'paper_get', 'citation'],
  },
  {
    id: 'opencitations',
    name: 'OpenCitations',
    category: 'Open citation graph',
    base_url: 'https://api.opencitations.net/index/v2',
    auth: 'None',
    rate_limit: 'Public',
    capabilities: ['citations', 'references', 'citation counts', 'OCI metadata'],
    key_field: null,
    live_without_key: true,
    tools: ['openalex_citations'],
  },
  {
    id: 'publisher_crossref_members',
    name: 'Publisher Crossref deposits',
    category: 'Publisher-scoped search (keyless)',
    base_url: 'https://api.crossref.org/v1/members/{id}/works',
    auth: 'Optional CROSSREF_MAILTO',
    rate_limit: '3 RPS polite / 1 RPS public',
    capabilities: ['publisher-scoped papers', 'OA links', 'metadata'],
    key_field: null,
    live_without_key: true,
    tools: ['literature_search (publishers source)', 'crossref_lookup'],
  },
  {
    id: 'elsevier',
    name: 'Elsevier Scopus / ScienceDirect / Serial Title',
    category: 'Keyed bibliometrics and full text',
    base_url: 'https://api.elsevier.com/content',
    auth: 'SCOPUS_API_KEY; optional ELSEVIER_INSTTOKEN',
    rate_limit: 'Institutional entitlement; quota applies',
    capabilities: ['Scopus search', 'abstract', 'CiteScore', 'SJR', 'SNIP', 'ScienceDirect full text'],
    key_field: 'SCOPUS_API_KEY',
    live_without_key: false,
    tools: ['literature_search (scopus)', 'domain_search', 'journal_search', 'paper_context'],
  },
  {
    id: 'wos',
    name: 'Web of Science / JCR',
    category: 'Keyed citation index and metrics',
    base_url: 'https://api.clarivate.com/apis/wos-starter/v1',
    auth: 'WOS_API_KEY',
    rate_limit: 'Starter quota/rate limits',
    capabilities: ['document search', 'cited-by', 'JIF', 'JCI', 'quartile', 'percentile'],
    key_field: 'WOS_API_KEY',
    live_without_key: false,
    tools: ['literature_search (wos)', 'domain_search', 'journal_search'],
  },
  {
    id: 'wiley_tdm',
    name: 'Wiley TDM',
    category: 'Keyed publisher full text',
    base_url: 'https://api.wiley.com/onlinelibrary/tdm/v1',
    auth: 'WILEY_TDM_TOKEN',
    rate_limit: 'Publisher entitlement; up to 3 RPS',
    capabilities: ['TDM PDF'],
    key_field: 'WILEY_TDM_TOKEN',
    live_without_key: false,
    tools: ['paper_context'],
  },
  {
    id: 'springer',
    name: 'Springer Nature',
    category: 'Keyed publisher search/full text',
    base_url: 'https://api.springernature.com',
    auth: 'SPRINGER_API_KEY',
    rate_limit: 'Developer-tier quota',
    capabilities: ['Meta v2 search', 'OA search', 'JATS full text'],
    key_field: 'SPRINGER_API_KEY',
    live_without_key: false,
    tools: ['literature_search (springer)', 'paper_context'],
  },
  {
    id: 'ieee',
    name: 'IEEE Xplore',
    category: 'Keyed publisher search',
    base_url: 'https://ieeexploreapi.ieee.org/api/v1',
    auth: 'IEEE_API_KEY',
    rate_limit: 'Developer-tier quota',
    capabilities: ['article search', 'OA links'],
    key_field: 'IEEE_API_KEY',
    live_without_key: false,
    tools: ['literature_search (ieee)'],
  },
  {
    id: 'ads',
    name: 'NASA ADS',
    category: 'Astronomy and physics',
    base_url: 'https://api.adsabs.harvard.edu/v1',
    auth: 'ADS_API_TOKEN',
    rate_limit: 'Daily key quota',
    capabilities: ['papers', 'citations', 'references', 'BibTeX export', 'metrics'],
    key_field: 'ADS_API_TOKEN',
    live_without_key: false,
    tools: ['literature_search (ads)', 'domain_search'],
  },
  {
    id: 'core',
    name: 'CORE',
    category: 'Open-access repository aggregator',
    base_url: 'https://api.core.ac.uk/v3',
    auth: 'Optional CORE_API_KEY',
    rate_limit: '~10 requests/minute keyless',
    capabilities: ['repository search', 'inline full text'],
    key_field: 'CORE_API_KEY',
    live_without_key: true,
    tools: ['core_search', 'paper_download'],
  },
  {
    id: 'consensus',
    name: 'Consensus',
    category: 'AI evidence search',
    base_url: 'https://api.consensus.app/v1',
    auth: 'CONSENSUS_API_KEY',
    rate_limit: '1 RPS',
    capabilities: ['study-design filters', 'journal quartile', 'sample size', 'takeaways'],
    key_field: 'CONSENSUS_API_KEY',
    live_without_key: false,
    tools: ['consensus_search'],
  },
  {
    id: 'parallel',
    name: 'Parallel',
    category: 'Web search and extraction',
    base_url: 'https://api.parallel.ai/v1',
    auth: 'PARALLEL_API_KEY',
    rate_limit: 'Plan quota',
    capabilities: ['web search', 'URL extraction'],
    key_field: 'PARALLEL_API_KEY',
    live_without_key: false,
    tools: ['parallel_search', 'parallel_extract'],
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: 'Web scraping',
    base_url: 'https://mcp.firecrawl.dev',
    auth: 'FIRECRAWL_API_KEY',
    rate_limit: 'Plan quota',
    capabilities: ['scrape', 'search', 'parse'],
    key_field: 'FIRECRAWL_API_KEY',
    live_without_key: false,
    tools: ['mcp__firecrawl__*'],
  },
  {
    id: 'scite',
    name: 'Scite',
    category: 'Smart citations',
    base_url: 'https://api.scite.ai/mcp',
    auth: 'SCITE_API_KEY',
    rate_limit: 'Plan quota',
    capabilities: ['supporting/contrasting citations', 'citation statements', 'evidence datasets'],
    key_field: 'SCITE_API_KEY',
    live_without_key: false,
    tools: ['mcp__scite__*'],
  },
  {
    id: 'elicit',
    name: 'Elicit',
    category: 'AI systematic review',
    base_url: 'https://elicit.com/api/v2',
    auth: 'ELICIT_API_KEY (Pro+)',
    rate_limit: '100 RPM',
    capabilities: ['paper search', 'trial search', 'study-type filters', 'retraction filter'],
    key_field: 'ELICIT_API_KEY',
    live_without_key: false,
    tools: ['elicit_search'],
  },
  {
    id: 'futurehouse',
    name: 'FutureHouse / Edison Scientific',
    category: 'AI research agents',
    base_url: 'https://api.platform.edisonscientific.com',
    auth: 'FUTUREHOUSE_API_KEY',
    rate_limit: 'Plan quota',
    capabilities: ['Crow', 'Falcon', 'Owl', 'PaperQA3'],
    key_field: 'FUTUREHOUSE_API_KEY',
    live_without_key: false,
    tools: ['futurehouse_agent'],
  },
  {
    id: 'datacite',
    name: 'DataCite / Zenodo / Figshare',
    category: 'Research data',
    base_url: 'https://api.datacite.org/dois',
    auth: 'Optional repository tokens',
    rate_limit: 'Public',
    capabilities: ['datasets', 'software', 'preprints', 'file listings'],
    key_field: null,
    live_without_key: true,
    tools: ['dataset_search'],
  },
  {
    id: 'orcid_ror',
    name: 'ORCID / ROR',
    category: 'Researcher and institution identity',
    base_url: 'https://pub.orcid.org/v3.0',
    auth: 'Optional ORCID_TOKEN; ROR public',
    rate_limit: 'Public',
    capabilities: ['author records', 'institutions'],
    key_field: 'ORCID_TOKEN',
    live_without_key: true,
    tools: ['author_lookup'],
  },
]

export const NOTE = 'Sources that require bot-challenge bypasses are not included.'

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const lines = value.databases.map((entry) => {
    const key = entry.key_field
      ? `${entry.key_field}: ${entry.configured ? 'configured' : 'not set'}`
      : 'no key'
    return [
      `**${entry.name}** — ${entry.category}`,
      `${entry.capabilities.join(', ')}`,
      `${key} · ${entry.rate_limit} · ${entry.tools.join(', ')}`,
    ].join('\n')
  })
  return [{ type: 'text', text: `${lines.join('\n\n')}\n\n${value.note}` }]
}

export async function catalogWithKeyStatus() {
  const keyFields = [...new Set(DATABASES.map((entry) => entry.key_field).filter(Boolean))]
  const values = await Promise.all(keyFields.map(async (field) => [field, Boolean(await resolveEnv(field))]))
  const configured = new Map(values)
  return DATABASES.map((entry) => ({
    ...entry,
    configured: entry.key_field ? Boolean(configured.get(entry.key_field)) : null,
  }))
}

export const name = 'academic-harness-academic-databases'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'database_catalog',
    description: [
      'List the academic-search sources this plugin can reach, each source\'s capabilities, key field, rate limit, and which tool fronts it. Key fields are reported only as configured/not set; values are never returned.',
      'Use this to choose a source or to explain why a keyed source is unavailable.',
    ].join(' '),
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute() {
      return { databases: await catalogWithKeyStatus(), note: NOTE }
    },
    presentCall() {
      return { card: 'generic', title: 'Academic database catalog', kind: 'search' }
    },
  }))
}
