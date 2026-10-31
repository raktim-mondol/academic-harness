/**
 * paper_get: one merged paper record from the free bibliographic backbones.
 *
 * DOI/arXiv/PMID/PMCID/OpenAlex identifiers fan out to the providers that can
 * answer them; a title falls back to a small OpenAlex + Crossref search. The
 * merged record is enriched with an open-access URL and a canonical BibTeX
 * entry. This tool does not download files or write to PaperMemory.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import {
  canonicalArxivId,
  canonicalDoi,
  canonicalPmcid,
  fromOpenAlexWork,
  fromSemanticScholarPaper,
  identifierKind,
  mergePapers,
  normalizeTitle,
} from './search-normalize.js'
import { fetchOpenAlexWork, fetchSemanticScholarPaper, resolveIdentifier } from './paper-resolve.js'
import { runOpenAlexSearch } from './openalex-search.js'
import { runCrossrefQuery } from './crossref-lookup.js'
import { runArxivSearch } from './arxiv-search.js'
import { runPubMedSearch } from './pubmed-search.js'
import { resolveBibtexForPaper } from './bibtex-resolve.js'
import { resolveOpenAccess, resolveOpenAlex } from './paper-download.js'

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function collect(settled, warnings, label) {
  const papers = []
  for (const entry of settled) {
    if (entry.status === 'fulfilled') {
      const value = entry.value
      if (value?.error) warnings.push(`${label}: ${value.error}`)
      else if (Array.isArray(value?.results)) papers.push(...value.results.filter(Boolean))
      else if (value?.paper) papers.push(value.paper)
      else if (value?.title) papers.push(value)
    } else {
      warnings.push(`${label}: ${errorText(entry.reason)}`)
    }
  }
  return papers
}

async function fromOpenAlex(identifier, exec) {
  const raw = await fetchOpenAlexWork(identifier, {
    signal: exec?.signal,
    apiKey: await resolveEnv('OPENALEX_API_KEY'),
    email: await resolveEnv('CROSSREF_MAILTO').then((value) => value || resolveEnv('UNPAYWALL_EMAIL')),
  })
  return raw ? fromOpenAlexWork(raw) : null
}

async function fromS2(identifier, exec) {
  const raw = await fetchSemanticScholarPaper(identifier, {
    signal: exec?.signal,
    apiKey: await resolveEnv('S2_API_KEY'),
  })
  return raw ? fromSemanticScholarPaper(raw) : null
}

async function fromEuropePmc(query, exec) {
  return runPubMedSearch({ query, source: 'europepmc', result_type: 'core', max_results: 1 }, exec)
}

async function collectDoi(doi, exec, warnings) {
  const settled = await Promise.allSettled([
    fromOpenAlex(doi, exec),
    fromS2(`DOI:${doi}`, exec),
    runCrossrefQuery({ doi }, exec),
    fromEuropePmc(`DOI:"${doi.replace(/"/g, '\\"')}"`, exec),
  ])
  const papers = []
  for (const entry of settled) {
    if (entry.status === 'rejected') {
      warnings.push(`paper source failed: ${errorText(entry.reason)}`)
      continue
    }
    const value = entry.value
    if (!value) continue
    if (value.error) {
      warnings.push(`paper source: ${value.error}`)
      continue
    }
    if (Array.isArray(value.results)) papers.push(...value.results.filter(Boolean))
    else papers.push(value)
  }
  return mergePapers(papers)
}

async function collectArxiv(arxivId, exec, warnings) {
  const settled = await Promise.allSettled([
    runArxivSearch({ ids: [arxivId], max_results: 1 }, exec),
    fromOpenAlex(arxivId, exec),
    fromS2(`ARXIV:${arxivId}`, exec),
  ])
  const papers = collect(settled, warnings, 'arxiv')
  return mergePapers(papers)
}

async function collectPmid(pmid, exec, warnings) {
  const settled = await Promise.allSettled([
    fromEuropePmc(`EXT_ID:${pmid} AND SRC:MED`, exec),
    fromOpenAlex(pmid, exec),
    fromS2(`PMID:${pmid}`, exec),
  ])
  return mergePapers(collect(settled, warnings, 'pubmed'))
}

async function collectPmcid(pmcid, exec, warnings) {
  const settled = await Promise.allSettled([
    fromEuropePmc(`PMCID:${pmcid}`, exec),
    fromOpenAlex(pmcid, exec),
    fromS2(`PMCID:${pmcid}`, exec),
  ])
  return mergePapers(collect(settled, warnings, 'pmcid'))
}

async function collectOpenAlex(openalexId, exec, warnings) {
  const paper = await fromOpenAlex(openalexId, exec)
  if (!paper) return []
  const candidates = [paper]
  if (paper.doi) {
    try {
      const s2 = await fromS2(`DOI:${paper.doi}`, exec)
      if (s2) candidates.push(s2)
    } catch (error) {
      warnings.push(`semantic scholar: ${errorText(error)}`)
    }
    try {
      const crossref = await runCrossrefQuery({ doi: paper.doi }, exec)
      if (crossref?.results?.length) candidates.push(...crossref.results)
    } catch (error) {
      warnings.push(`crossref: ${errorText(error)}`)
    }
  }
  return mergePapers(candidates)
}

async function collectTitle(title, exec, warnings) {
  const settled = await Promise.allSettled([
    runOpenAlexSearch({ query: title, per_page: 5 }, exec),
    runCrossrefQuery({ query: title, rows: 5 }, exec),
  ])
  const papers = mergePapers(collect(settled, warnings, 'title search'))
  if (!papers.length) return { paper: null, ambiguous: false }
  const normalized = normalizeTitle(title)
  const exact = papers.filter((paper) => normalizeTitle(paper.title) === normalized)
  const candidates = exact.length ? exact : papers
  if (!exact.length) warnings.push('No exact title match; returning the top-ranked candidate.')
  if (candidates.length > 1) warnings.push(`${candidates.length} candidates match the title query; returning the top-ranked one.`)
  return { paper: candidates[0], ambiguous: candidates.length > 1 }
}

async function enrichOpenAccess(paper, exec, warnings) {
  if (!paper || paper.oa_url || paper.pdf_url) return paper
  if (!paper.doi) return paper
  const email = await resolveEnv('UNPAYWALL_EMAIL')
  if (email) {
    try {
      const unpaywall = await resolveOpenAccess(paper.doi, email, exec?.signal)
      if (unpaywall.found) {
        paper.oa_url = unpaywall.pdfUrl
        paper.pdf_url = unpaywall.pdfUrl
        paper.oa_status = unpaywall.oa_status || paper.oa_status
        if (!paper.sources.includes('unpaywall')) paper.sources.push('unpaywall')
        return paper
      }
    } catch (error) {
      warnings.push(`unpaywall: ${errorText(error)}`)
    }
  }
  try {
    const openalex = await resolveOpenAlex(paper.doi, { signal: exec?.signal })
    if (openalex.found) {
      paper.oa_url = openalex.pdfUrl
      paper.pdf_url = openalex.pdfUrl
      paper.oa_status = openalex.oa_status || paper.oa_status
      if (!paper.sources.includes('openalex')) paper.sources.push('openalex')
    }
  } catch (error) {
    warnings.push(`openalex OA: ${errorText(error)}`)
  }
  return paper
}

function renderPaperGet(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const paper = value.paper
  if (!paper) return [{ type: 'text', text: `No paper found for ${value.identifier}.` }]
  const bits = [
    `**${paper.title || '(untitled)'}**`,
    [paper.authors?.slice(0, 4).map((author) => author.name).filter(Boolean).join(', '), paper.year, paper.journal?.name || paper.venue]
      .filter(Boolean).join(' · '),
    [
      paper.doi && `doi: ${paper.doi}`,
      paper.pmid && `pmid: ${paper.pmid}`,
      paper.pmcid && paper.pmcid,
      paper.arxiv_id && `arXiv: ${paper.arxiv_id}`,
      paper.openalex_id && `openalex: ${paper.openalex_id}`,
    ].filter(Boolean).join(' · '),
    [
      paper.citation_count != null ? `${paper.citation_count} citations` : null,
      paper.oa_status || null,
      paper.oa_url ? `OA: ${paper.oa_url}` : null,
    ].filter(Boolean).join(' · '),
    `matched by: ${value.matched_by}`,
    `sources: ${(paper.sources || []).join(', ')}`,
  ]
  if (paper.abstract) bits.push(`${paper.abstract.slice(0, 1200).trimEnd()}${paper.abstract.length > 1200 ? '…' : ''}`)
  if (value.bibtex) bits.push(`BibTeX (${value.bibtex_source}):\n${value.bibtex.length > 900 ? `${value.bibtex.slice(0, 900)}…` : value.bibtex}`)
  if (value.warnings?.length) bits.push(`warnings: ${value.warnings.join('; ')}`)
  return [{ type: 'text', text: bits.filter(Boolean).join('\n\n') }]
}

export async function runPaperGet(args, exec) {
  const identifier = String(args.identifier || '').trim()
  if (!identifier) return { error: 'identifier is required' }
  const parsed = identifierKind(identifier)
  const warnings = []
  let papers = []
  let matchedBy = parsed.kind

  if (parsed.kind === 'doi') {
    papers = await collectDoi(canonicalDoi(parsed.value), exec, warnings)
  } else if (parsed.kind === 'arxiv') {
    papers = await collectArxiv(canonicalArxivId(parsed.value), exec, warnings)
  } else if (parsed.kind === 'pmid') {
    papers = await collectPmid(parsed.value, exec, warnings)
  } else if (parsed.kind === 'pmcid') {
    papers = await collectPmcid(canonicalPmcid(parsed.value), exec, warnings)
  } else if (parsed.kind === 'openalex') {
    papers = await collectOpenAlex(parsed.value, exec, warnings)
  } else if (parsed.kind === 's2') {
    const paper = await fromS2(parsed.value, exec)
    papers = paper ? mergePapers([paper]) : []
  } else if (['inspire', 'acl', 'bibcode', 'scopus', 'wos', 'wikidata'].includes(parsed.kind)) {
    try {
      const value = await resolveIdentifier(identifier, {
        signal: exec?.signal,
        apiKey: await resolveEnv('OPENALEX_API_KEY'),
        email: await resolveEnv('CROSSREF_MAILTO').then((entry) => entry || resolveEnv('UNPAYWALL_EMAIL')),
        s2Key: await resolveEnv('S2_API_KEY'),
      })
      if (value.resolved && value.paper) papers = [value.paper]
      else warnings.push(value.reason || 'identifier lookup failed')
    } catch (error) {
      warnings.push(errorText(error))
    }
  } else {
    const title = await collectTitle(identifier, exec, warnings)
    if (title.paper) {
      papers = [title.paper]
      matchedBy = 'title'
    }
  }

  if (!papers.length) {
    return {
      error: `No paper found for identifier: ${identifier}`,
      identifier,
      matched_by: matchedBy,
      warnings,
    }
  }

  const paper = papers[0]
  paper.sources = Array.isArray(paper.sources) ? paper.sources : [paper.source || 'unknown']
  if (!paper.arxiv_id && parsed.kind === 'arxiv') paper.arxiv_id = canonicalArxivId(parsed.value)
  if (!paper.arxiv_id && /^10\.48550\/arxiv\./i.test(paper.doi || '')) {
    paper.arxiv_id = canonicalArxivId(paper.doi.replace(/^10\.48550\/arxiv\./i, ''))
  }
  if (paper.arxiv_id) {
    paper.html_url = paper.html_url || `https://arxiv.org/html/${paper.arxiv_id}`
    paper.pdf_url = paper.pdf_url || `https://arxiv.org/pdf/${paper.arxiv_id}`
    paper.oa_url = paper.oa_url || paper.pdf_url
  }
  if (args.include_oa !== false) await enrichOpenAccess(paper, exec, warnings)
  let bibtex = null
  let bibtexSource = null
  if (args.include_bibtex !== false) {
    const resolved = await resolveBibtexForPaper(paper, { signal: exec?.signal })
    bibtex = resolved.bibtex
    bibtexSource = resolved.source
    if (bibtex) paper.bibtex = bibtex
  }

  return {
    identifier,
    matched_by: matchedBy,
    paper,
    bibtex,
    bibtex_source: bibtexSource,
    sources: paper.sources || [],
    warnings,
  }
}

export const name = 'academic-harness-paper-get'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'paper_get',
    description: [
      'Resolve one paper to a merged record: DOI, arXiv ID, PMID, PMCID, OpenAlex ID, S2 ID, INSPIRE/ACL/bibcode/Scopus/WoS/Wikidata identifier, or a title. Combines OpenAlex, Semantic Scholar, Crossref, Europe PMC, and arXiv where available; adds an OA URL and a canonical BibTeX entry.',
      'Use paper_resolve for batch identifier conversion, paper_download to save a PDF, paper_fold to read a whole paper locally, and paper_context to pull focused sections/snippets.',
      'Free sources need no key; OPENALEX_API_KEY/S2_API_KEY/CROSSREF_MAILTO only raise limits. Title lookups can be ambiguous and return the top-ranked candidate with a warning. Does not write files or ingest into PaperMemory.',
    ].join(' '),
    parameters: {
      identifier: { type: 'string', required: true, description: 'DOI, arXiv ID, PMID, PMCID, OpenAlex ID, S2 ID, or exact paper title.' },
      include_bibtex: { type: 'boolean', description: 'Resolve a canonical BibTeX entry (DOI → arXiv → INSPIRE → S2 → synthesized). Default true.' },
      include_oa: { type: 'boolean', description: 'Try Unpaywall/OpenAlex for an open-access PDF URL when the record has none. Default true.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderPaperGet(value),
    },
    async execute(args, exec) {
      try {
        return await runPaperGet(args, exec)
      } catch (error) {
        return { error: errorText(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Paper metadata: ${args.identifier || ''}`, kind: 'search' }
    },
  }))
}
