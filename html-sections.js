/**
 * Dependency-free section extraction for full-text context.
 *
 * The free tiers return HTML (arXiv LaTeXML), JATS XML (Springer), BioC JSON
 * (PMC/PubTator), or Markdown (pdf-inspector). Parsing is deliberately
 * targeted and capped: malformed or unexpected markup yields fewer sections,
 * never a thrown parse error. Callers fall back to the abstract.
 */

const MAX_SECTION_CHARS = 2000
const MAX_SECTIONS = 12

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

export function stripHtml(value) {
  return decodeEntities(String(value ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function cap(value, chars = MAX_SECTION_CHARS) {
  const text = String(value ?? '').trim()
  return text.length > chars ? `${text.slice(0, chars).trimEnd()}…` : text
}

function pushSection(sections, heading, content) {
  const body = stripHtml(content)
  if (body.length < 40) return
  const title = stripHtml(heading) || 'Section'
  sections.push({ heading: cap(title, 300), content: cap(body) })
}

/**
 * arXiv LaTeXML HTML uses ordinary headings and paragraphs. Walk them in
 * document order and group paragraphs under the latest heading.
 */
export function parseArxivHtml(html) {
  const raw = String(html ?? '')
  if (!raw) return []
  const article = raw.match(/<article\b[\s\S]*?<\/article>/i)?.[0] || raw
  const sections = []
  let heading = ''
  let paragraphs = []
  const flush = () => {
    if (heading && paragraphs.length) pushSection(sections, heading, paragraphs.join(' '))
    paragraphs = []
  }
  const token = /<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>|<p\b[^>]*>([\s\S]*?)<\/p>/gi
  for (const match of article.matchAll(token)) {
    if (match[1]) {
      flush()
      heading = stripHtml(match[2])
    } else {
      const text = stripHtml(match[3])
      if (text.length >= 30) paragraphs.push(text)
    }
  }
  flush()
  if (!sections.length) {
    const body = stripHtml(article)
    if (body.length >= 80) sections.push({ heading: 'Full text', content: cap(body) })
  }
  return sections.slice(0, MAX_SECTIONS)
}

/** JATS XML: one <sec> with a <title> and direct <p> children. */
export function parseJatsXml(xml) {
  const raw = String(xml ?? '')
  if (!raw) return []
  const sections = []
  for (const match of raw.matchAll(/<sec\b[^>]*>([\s\S]*?)<\/sec>/gi)) {
    const block = match[1]
    const title = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Section'
    const paragraphs = [...block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((entry) => entry[1])
    if (paragraphs.length) pushSection(sections, title, paragraphs.join(' '))
    if (sections.length >= MAX_SECTIONS) break
  }
  if (!sections.length) {
    const body = raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    if (body) pushSection(sections, 'Full text', body)
  }
  return sections
}

function biocDocuments(data) {
  if (Array.isArray(data)) {
    if (data[0]?.documents) return data.flatMap((entry) => entry.documents || [])
    return data.filter((entry) => entry?.passages)
  }
  if (Array.isArray(data?.documents)) return data.documents
  if (Array.isArray(data?.PubTator3)) return data.PubTator3
  if (data?.documents) return [data.documents]
  return []
}

/** NCBI PMC BioC JSON and PubTator3 BioC JSON. */
export function parseBiocJson(data) {
  const passages = biocDocuments(data).flatMap((doc) => doc?.passages || [])
  if (!passages.length) return []
  const buckets = new Map()
  const skip = new Set(['REF', 'ACK_FUND', 'COMP_INT', 'ABBR', 'AUTH_CONT'])
  for (const passage of passages) {
    const infons = passage?.infons || {}
    const section = String(infons.section_type || infons.type || 'BODY').toUpperCase()
    if (skip.has(section)) continue
    const text = String(passage?.text || '').trim()
    if (text.length < 25) continue
    const list = buckets.get(section) || []
    list.push(text)
    buckets.set(section, list)
  }
  const sections = []
  for (const [heading, texts] of buckets) {
    pushSection(sections, heading, texts.join(' '))
    if (sections.length >= MAX_SECTIONS) break
  }
  return sections
}

/** Split pdf-inspector Markdown into headings, or into paragraph blocks. */
export function splitMarkdownSections(markdown) {
  const raw = String(markdown ?? '').trim()
  if (!raw) return []
  const lines = raw.split(/\r?\n/)
  const sections = []
  let heading = ''
  let body = []
  const flush = () => {
    const text = body.join(' ').replace(/[ \t]+/g, ' ').trim()
    if (text.length >= 40) sections.push({ heading: heading || `Excerpt ${sections.length + 1}`, content: cap(text) })
    body = []
  }
  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/)
    if (match) {
      flush()
      heading = match[2].trim()
      continue
    }
    if (line.trim()) body.push(line.trim())
  }
  flush()
  if (sections.length) return sections.slice(0, MAX_SECTIONS)

  const paragraphs = raw.split(/\n{2,}/).map((entry) => entry.trim()).filter((entry) => entry.length >= 40)
  const grouped = []
  for (let index = 0; index < paragraphs.length; index += 3) {
    grouped.push({ heading: `Excerpt ${grouped.length + 1}`, content: cap(paragraphs.slice(index, index + 3).join(' ')) })
    if (grouped.length >= MAX_SECTIONS) break
  }
  return grouped
}

/** Rank sections against a focus query and return compact snippets. */
export function rankPassages(sections, focusQuery, {
  source = 'full_text',
  maxSnippets = 8,
  maxChars = 1200,
} = {}) {
  const terms = [...new Set(String(focusQuery || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
  const scored = (sections || []).map((section) => {
    const body = String(section.content || '')
    const haystack = `${section.heading || ''} ${body}`.toLowerCase()
    const hits = terms.filter((term) => haystack.includes(term)).length
    return {
      section: section.heading || null,
      text: cap(body, maxChars),
      source,
      score: terms.length ? hits / terms.length : 0,
    }
  })
  if (terms.length) scored.sort((a, b) => b.score - a.score)
  const useful = scored.filter((entry) => entry.text)
  const chosen = terms.length ? useful.filter((entry) => entry.score > 0) : useful
  return (chosen.length ? chosen : useful).slice(0, maxSnippets)
}

export function excerptFromSections(sections, maxChars = 12000) {
  const body = (sections || [])
    .map((section) => `### ${section.heading || 'Section'}\n${section.content || ''}`)
    .join('\n\n')
  return body.length > maxChars ? `${body.slice(0, maxChars).trimEnd()}…` : body
}
