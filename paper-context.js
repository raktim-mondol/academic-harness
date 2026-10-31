/**
 * paper_context: focused sections and snippets instead of a whole PDF.
 *
 * Free tiers, in order: Semantic Scholar snippets, arXiv LaTeXML HTML,
 * PMC BioC / PubTator3, then OA PDF via pdf-inspector. Keyed publisher TDM
 * tiers sit before PDF for Wiley, Elsevier, and Springer. No file is written
 * and nothing is ingested into PaperMemory; paper_download/pdf_to_markdown own
 * persistence.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveEnv } from './credential-env.js'
import { fetchJson, fetchText, searchUserAgent } from './search-http.js'
import { fetchPdf } from './paper-download.js'
import { convertPdfMarkdown } from './pdf-to-markdown.js'
import { runPaperGet } from './paper-get.js'
import { searchSnippets } from './semantic-scholar-search.js'
import {
  excerptFromSections,
  parseArxivHtml,
  parseBiocJson,
  rankPassages,
  splitMarkdownSections,
} from './html-sections.js'
import {
  fetchScienceDirectFull,
  fetchSpringerJats,
  fetchWileyPdf,
} from './publisher-tdm.js'

const BIOC_BASE = 'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json'
const PUBTATOR_BASE = 'https://www.ncbi.nlm.nih.gov/research/pubtator3-api'

function cap(value, chars) {
  const text = String(value ?? '').trim()
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text
}

function addSections(target, sections, source, snippets, focusQuery) {
  if (!sections?.length) return
  for (const section of sections) {
    target.push({ heading: section.heading || 'Section', content: cap(section.content, 2000) })
  }
  snippets.push(...rankPassages(sections, focusQuery, { source }))
}

function addSnippets(target, snippets) {
  const seen = new Set(target.map((entry) => entry.text))
  for (const snippet of snippets) {
    const text = cap(snippet.text, 1200)
    if (!text || seen.has(text)) continue
    seen.add(text)
    target.push({ section: snippet.section || null, text, source: snippet.source || 'full_text', score: snippet.score ?? null })
  }
}

async function arxivTier(arxivId, focusQuery, { fetchTextImpl, signal, warnings }) {
  if (!arxivId) return null
  try {
    const result = await fetchTextImpl(`https://arxiv.org/html/${encodeURIComponent(arxivId)}`, {
      signal,
      headers: { 'User-Agent': searchUserAgent(), Accept: 'text/html' },
    })
    if (!result.ok) return null
    const sections = parseArxivHtml(result.data)
    return sections.length ? { sections, source: 'arxiv_html' } : null
  } catch (error) {
    warnings.push(`arxiv_html: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function biocTier(paper, focusQuery, { fetchJsonImpl, signal, warnings }) {
  let sections = []
  let source = null
  for (const target of [paper.pmcid, paper.pmid]) {
    if (!target) continue
    try {
      const result = await fetchJsonImpl(`${BIOC_BASE}/${encodeURIComponent(target)}/unicode`, {
        signal,
        headers: { 'User-Agent': searchUserAgent(), Accept: 'application/json' },
      })
      if (!result.ok) continue
      const parsed = parseBiocJson(result.data)
      if (parsed.length > sections.length) {
        sections = parsed
        source = 'ncbi_pmc_bioc_json'
      }
    } catch (error) {
      warnings.push(`ncbi bioc: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (sections.length <= 2 && paper.pmid) {
    try {
      const result = await fetchJsonImpl(`${PUBTATOR_BASE}/publications/export/biocjson?pmids=${encodeURIComponent(paper.pmid)}&full=true`, {
        signal,
        headers: { 'User-Agent': searchUserAgent(), Accept: 'application/json' },
      })
      if (result.ok) {
        const parsed = parseBiocJson(result.data)
        if (parsed.length > sections.length) {
          sections = parsed
          source = 'ncbi_pubtator3_biocjson'
        }
      }
    } catch (error) {
      warnings.push(`pubtator3: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return sections.length ? { sections, source: source || 'ncbi_pmc_bioc_json' } : null
}

async function tdmTier(paper, focusQuery, { convertPdfImpl, signal, warnings }) {
  if (!paper.doi) return null
  const doi = paper.doi
  try {
    if (/^10\.(?:1002|1111)\//i.test(doi)) {
      const result = await fetchWileyPdf(doi, { signal })
      if (result?.buffer) {
        const converted = await convertPdfImpl(result.buffer)
        if (converted?.success && converted.markdown) {
          const sections = splitMarkdownSections(converted.markdown)
          if (sections.length) return { sections, source: 'wiley_tdm_pdf_api' }
        } else if (converted?.error) {
          warnings.push(`wiley TDM: ${converted.error}`)
        }
      } else if (result?.error) warnings.push(`wiley TDM: ${result.error}`)
    } else if (/^10\.1016\//i.test(doi)) {
      const result = await fetchScienceDirectFull(doi, { signal })
      if (result?.sections?.length) return { sections: result.sections, source: result.source }
      if (result?.error) warnings.push(`sciencedirect: ${result.error}`)
    } else if (/^10\.(?:1038|1007)\//i.test(doi)) {
      const result = await fetchSpringerJats(doi, { signal })
      if (result?.sections?.length) return { sections: result.sections, source: result.source }
      if (result?.error) warnings.push(`springer: ${result.error}`)
    }
  } catch (error) {
    warnings.push(`publisher TDM: ${error instanceof Error ? error.message : String(error)}`)
  }
  return null
}

async function pdfTier(paper, focusQuery, { fetchPdfImpl, convertPdfImpl, signal, warnings }) {
  const url = paper.pdf_url || paper.oa_url
  if (!url) return null
  try {
    const email = await resolveEnv('UNPAYWALL_EMAIL')
    const buffer = await fetchPdfImpl(url, email, signal)
    const converted = await convertPdfImpl(buffer)
    if (!converted?.success || !converted.markdown) {
      warnings.push(converted?.error || 'PDF conversion produced no text (the PDF may be scanned)')
      return null
    }
    const sections = splitMarkdownSections(converted.markdown)
    return sections.length ? { sections, source: 'open_access_pdf_pdf_inspector' } : null
  } catch (error) {
    warnings.push(`OA PDF: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function renderPaperContext(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const bits = [`**${value.title || value.identifier}**`]
  const ids = [
    value.doi && `doi: ${value.doi}`,
    value.arxiv_id && `arXiv: ${value.arxiv_id}`,
    value.pmid && `pmid: ${value.pmid}`,
    value.pmcid && value.pmcid,
  ].filter(Boolean)
  if (ids.length) bits.push(ids.join(' · '))
  if (value.extraction_sources?.length) bits.push(`extraction sources: ${value.extraction_sources.join(', ')}`)
  if (value.abstract) bits.push(`Abstract: ${cap(value.abstract, 1200)}`)
  if (value.tldr) bits.push(`TLDR: ${cap(value.tldr, 600)}`)
  for (const section of value.sections || []) {
    bits.push(`### ${section.heading}\n${cap(section.content, 900)}`)
  }
  if (value.snippets?.length) {
    for (const snippet of value.snippets.slice(0, 10)) {
      bits.push(`> ${snippet.section ? `[${snippet.section}] ` : ''}${cap(snippet.text, 600)}`)
    }
  }
  if (!value.sections?.length && !value.snippets?.length) bits.push('No full text could be extracted; see the abstract/warnings above.')
  if (value.warnings?.length) bits.push(`warnings: ${value.warnings.join('; ')}`)
  return [{ type: 'text', text: bits.join('\n\n') }]
}

export async function runPaperContext(args, exec, deps = {}) {
  const identifier = String(args.identifier || '').trim()
  if (!identifier) return { error: 'identifier is required' }
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 12000, 1000), 50000)
  const includePdf = args.include_pdf !== false
  const paperGet = deps.paperGet || runPaperGet
  const snippetSearch = deps.searchSnippets || searchSnippets
  const fetchTextImpl = deps.fetchText || fetchText
  const fetchJsonImpl = deps.fetchJson || fetchJson
  const fetchPdfImpl = deps.fetchPdf || fetchPdf
  const convertPdfImpl = deps.convertPdf || convertPdfMarkdown

  const lookedUp = await paperGet({
    identifier,
    include_bibtex: args.include_bibtex !== false,
    include_oa: true,
  }, exec)
  if (lookedUp?.error || !lookedUp?.paper) {
    return { error: lookedUp?.error || `No paper found for identifier: ${identifier}` }
  }
  const paper = lookedUp.paper
  const focusQuery = String(args.focus_query || '').trim() || paper.title || ''
  const warnings = []
  const sections = []
  const snippets = []
  const extractionSources = new Set(paper.sources || [])

  try {
    const values = await snippetSearch({
      query: focusQuery,
      paperIds: paper.s2_id ? [paper.s2_id] : undefined,
      limit: 6,
      signal: exec?.signal,
    })
    if (values?.length) {
      addSnippets(snippets, values)
      extractionSources.add('semantic_scholar_snippet')
    }
  } catch (error) {
    warnings.push(`semantic scholar snippets: ${error instanceof Error ? error.message : String(error)}`)
  }

  const arxiv = await arxivTier(paper.arxiv_id, focusQuery, { fetchTextImpl, signal: exec?.signal, warnings })
  if (arxiv) {
    addSections(sections, arxiv.sections, arxiv.source, snippets, focusQuery)
    extractionSources.add(arxiv.source)
  }

  const bioc = await biocTier(paper, focusQuery, { fetchJsonImpl, signal: exec?.signal, warnings })
  if (bioc) {
    addSections(sections, bioc.sections, bioc.source, snippets, focusQuery)
    extractionSources.add(bioc.source)
  }

  if (sections.length <= 2) {
    const tdm = await tdmTier(paper, focusQuery, { convertPdfImpl, signal: exec?.signal, warnings })
    if (tdm) {
      addSections(sections, tdm.sections, tdm.source, snippets, focusQuery)
      extractionSources.add(tdm.source)
    }
  }

  if (includePdf && sections.length <= 2) {
    const pdf = await pdfTier(paper, focusQuery, { fetchPdfImpl, convertPdfImpl, signal: exec?.signal, warnings })
    if (pdf) {
      addSections(sections, pdf.sections, pdf.source, snippets, focusQuery)
      extractionSources.add(pdf.source)
    }
  }

  if (!sections.length && !snippets.length) {
    warnings.push('no_full_text: returning abstract/TLDR only')
  }

  const excerpt = sections.length
    ? excerptFromSections(sections, maxChars)
    : [
      paper.abstract,
      paper.tldr,
      ...snippets.slice(0, 5).map((snippet) => snippet.text),
    ].filter(Boolean).join('\n\n').slice(0, maxChars)

  return {
    identifier,
    title: paper.title || null,
    doi: paper.doi || null,
    arxiv_id: paper.arxiv_id || null,
    pmid: paper.pmid || null,
    pmcid: paper.pmcid || null,
    abstract: paper.abstract || null,
    tldr: paper.tldr || null,
    bibtex: lookedUp.bibtex || null,
    pdf_url: paper.pdf_url || paper.oa_url || null,
    html_url: paper.html_url || null,
    sections: sections.slice(0, 12),
    snippets: snippets.slice(0, 10),
    full_text_excerpt: excerpt || null,
    extraction_sources: [...extractionSources],
    warnings,
  }
}

export const name = 'academic-harness-paper-context'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'paper_context',
    description: [
      'Get focused full-text context for one paper without downloading it: Semantic Scholar ~500-word snippets, arXiv HTML sections, PMC BioC/PubTator3 sections, keyed Wiley/Elsevier/Springer TDM, then OA PDF extraction via pdf-inspector. `focus_query` ranks passages; `max_chars` caps the excerpt.',
      'Use this for verifying a specific method, number, or claim. Use paper_fold for map-first whole-paper reading, pdf_to_markdown for a local PDF, and paper_download to save the PDF. Paywalled, scanned, or unavailable full text returns the abstract/TLDR with warnings instead of invented content. Does not write files or ingest into PaperMemory.',
      'Free tiers need no key. SCOPUS_API_KEY/ELSEVIER_INSTTOKEN, WILEY_TDM_TOKEN, and SPRINGER_API_KEY enable optional publisher TDM tiers.',
    ].join(' '),
    parameters: {
      identifier: { type: 'string', required: true, description: 'DOI, arXiv ID, PMID, PMCID, OpenAlex ID, or paper title.' },
      focus_query: { type: 'string', description: 'Question, method, or keywords used to rank sections/snippets. Defaults to the paper title.' },
      max_chars: { type: 'number', description: 'Maximum full-text excerpt characters, 1,000-50,000. Default 12,000.' },
      include_pdf: { type: 'boolean', description: 'Try the OA PDF tier when structured sections are unavailable. Default true.' },
      include_bibtex: { type: 'boolean', description: 'Include the canonical BibTeX entry in the result. Default true.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderPaperContext(value),
    },
    async execute(args, exec) {
      try {
        return await runPaperContext(args, exec)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Paper context: ${args.identifier || ''}`, kind: 'search' }
    },
  }))
}
