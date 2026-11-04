/**
 * Batch reference audit behind `citation action=audit`.
 *
 * Per reference: DOI validity, Crossref metadata match, retraction / concern /
 * correction status (via integrity_check), missing fields, duplicates, uncited
 * entries, and whether the record formats cleanly. The audit says nothing about
 * whether a reference supports the claim it is cited for; a DOI that resolves
 * and matches only shows the reference exists as described. A check that could
 * not run is `unknown`, never clean.
 */
import { formatBibliography, validateRecords } from './citation-format.js'
import { canonicalDoi, normalizeTitle } from './search-normalize.js'

export const AUDIT_DEFAULT_MAX = 100

const SEVERITY_RANK = { problem: 3, review: 2, info: 1 }
// A check that could not run: the record is unverified, never clean.
const UNVERIFIED_CODES = [
  'no_doi', 'crossref_unavailable', 'integrity_unknown', 'not_checked',
  'title_uncomparable', 'venue_uncomparable', 'first_author_uncomparable',
]

function recordYear(record) {
  return Number(record.issued?.['date-parts']?.[0]?.[0]) || null
}

function label(record) {
  return record['citation-key'] || record.title || record.id || 'reference'
}

function firstFamily(record) {
  const author = record.author?.[0]
  return normalizeTitle(author?.family || author?.literal || '')
}

function crossrefYear(work) {
  const parts = work?.issued?.['date-parts']?.[0] || work?.['published-print']?.['date-parts']?.[0]
    || work?.['published-online']?.['date-parts']?.[0]
  return Number(parts?.[0]) || null
}

/**
 * Token overlap between two venue-like strings, or `null` when the pair cannot be
 * compared (either side normalizes to nothing, or neither has a token of its own).
 * Unknown is reported as unknown: it is never a perfect score.
 */
function tokenOverlap(a, b) {
  const left = new Set(normalizeTitle(a).split(/\s+/).filter((t) => t.length > 2))
  const right = normalizeTitle(b).split(/\s+/).filter((t) => t.length > 2)
  if (!left.size || !right.length) return null
  return right.filter((t) => left.has(t)).length / Math.max(left.size, right.length)
}

/** True when both strings exist but at least one of them has no comparable tokens. */
function incomparable(a, b) {
  const left = String(a || '').trim()
  const right = String(b || '').trim()
  if (!left || !right) return false
  return !normalizeTitle(left) || !normalizeTitle(right)
}

function finding(code, severity, detail, fix) {
  return { code, severity, detail, ...(fix ? { suggested_fix: fix } : {}) }
}

function compareToCrossref(record, work, titleMatches) {
  const out = []
  const published = work?.title?.[0] || work?.title || ''
  if (record.title && published) {
    if (incomparable(record.title, published)) {
      out.push(finding('title_uncomparable', 'info', `the cited title "${record.title}" and the Crossref title "${published}" could not be compared lexically`, 'Check by hand that this DOI belongs to the paper you cite; unknown is not a pass.'))
    } else if (!titleMatches(record.title, published)) {
      out.push(finding('title_mismatch', 'review', `Crossref title is "${published}"`, 'Check the DOI belongs to this paper, or correct the title.'))
    }
  }
  const have = recordYear(record)
  const want = crossrefYear(work)
  if (have && want && Math.abs(have - want) > 1) {
    out.push(finding('year_mismatch', 'review', `record says ${have}, Crossref says ${want}`, `Use ${want} unless you cite an earlier version.`))
  }
  const venue = work?.['container-title']?.[0]
  if (record['container-title'] && venue) {
    const overlap = tokenOverlap(record['container-title'], venue)
    if (overlap === null) {
      out.push(finding('venue_uncomparable', 'info', `the cited venue "${record['container-title']}" and the Crossref venue "${venue}" share no comparable token`, 'Check the venue by hand (abbreviation, translation, or non-Latin name); unknown is not a pass.'))
    } else if (overlap < 0.34) {
      out.push(finding('venue_mismatch', 'review', `record venue "${record['container-title']}" vs Crossref "${venue}"`, 'Check abbreviations; correct if it is a different venue.'))
    }
  }
  const family = firstFamily(record)
  const crossrefFamily = normalizeTitle(work?.author?.[0]?.family || '')
  if (incomparable(record.author?.[0]?.family || record.author?.[0]?.literal || '', work?.author?.[0]?.family || '')) {
    out.push(finding('first_author_uncomparable', 'info', `the cited first author and the Crossref first author could not be compared lexically ("${record.author?.[0]?.family || record.author?.[0]?.literal}" vs "${work?.author?.[0]?.family || ''}")`, 'Check the author by hand; unknown is not a pass.'))
  } else if (family && crossrefFamily && family !== crossrefFamily && !crossrefFamily.includes(family) && !family.includes(crossrefFamily)) {
    out.push(finding('first_author_mismatch', 'review', `first author "${family}" vs Crossref "${crossrefFamily}"`, 'Check author order and spelling.'))
  }
  return out
}

function integrityFindings(result) {
  if (!result || result.error) return [finding('integrity_unknown', 'info', result?.error || 'integrity check did not run')]
  const notice = result.signals?.find((s) => s.notice_doi)?.notice_doi
  const noticeLink = notice ? ` (notice: https://doi.org/${notice})` : ''
  switch (result.verdict) {
    case 'retracted': return [finding('retracted', 'problem', `flagged as retracted${noticeLink}`, 'Remove it, or cite it explicitly as a retracted paper.')]
    case 'expression_of_concern': return [finding('expression_of_concern', 'review', `expression of concern${noticeLink}`, 'Read the notice before relying on this reference.')]
    case 'corrected': return [finding('corrected', 'review', `a correction exists${noticeLink}`, 'Check whether the correction changes what you cite.')]
    case 'not_found': return [finding('integrity_unknown', 'info', 'no registry record found to check')]
    case 'unknown': return [finding('integrity_unknown', 'info', 'integrity status could not be determined; unknown is not clean')]
    default: return []
  }
}

/**
 * @param {object[]} records normalized CSL records
 * @param {object} deps fetchCrossref(doi) -> {ok,status,work,error}; integrity(doi) -> integrity result;
 *   titleMatches(a,b) — true only for a comparable pair that matches; citedKeys: Set|null (keys the
 *   manuscript cites); style
 */
export async function auditReferences(records, deps) {
  const { entries, errors, warnings, duplicates } = validateRecords(records)
  const maxAudit = Math.min(Math.max(Number(deps.maxAudit) || AUDIT_DEFAULT_MAX, 1), 500)
  const dupByLabel = new Map()
  for (const dup of duplicates) {
    for (const entry of dup.entries) {
      if (!dupByLabel.has(entry)) dupByLabel.set(entry, [])
      dupByLabel.get(entry).push(dup)
    }
  }
  const references = []
  let networkChecked = 0
  const doiSeen = new Map()
  for (const record of entries) {
    const key = label(record)
    const findings = []
    for (const message of [...errors, ...warnings]) {
      if (message.startsWith(`${key}:`)) findings.push(finding('missing_field', message.startsWith(`${key}: DOI does not`) ? 'problem' : 'review', message.slice(key.length + 2), 'Add the missing field from the publisher record.'))
    }
    for (const dup of dupByLabel.get(key) || []) {
      findings.push(finding('duplicate', 'review', `${dup.field} "${dup.value}" also in ${dup.entries.filter((e) => e !== key).join(', ')}`, 'Merge the entries and cite one key.'))
    }
    if (deps.citedKeys && !deps.citedKeys.has(record['citation-key'])) {
      findings.push(finding('uncited', 'review', 'not cited in the manuscript', 'Remove it from the bibliography or cite it.'))
    }
    try {
      const rendered = formatBibliography([record], { style: deps.style || 'apa' })
      if (!String(rendered).trim() || /undefined|NaN/.test(rendered)) findings.push(finding('style_issue', 'review', `does not format cleanly in ${deps.style || 'apa'}`, 'Fill in the fields the style needs.'))
    } catch (error) {
      findings.push(finding('style_issue', 'review', `formatting failed: ${error instanceof Error ? error.message : error}`))
    }

    const rawDoi = record.DOI
    const doi = canonicalDoi(rawDoi)
    let checked = false
    if (!rawDoi) {
      findings.push(finding('no_doi', 'info', 'no DOI, so metadata and retraction status were not checked', 'Add a DOI if one exists.'))
    } else if (!doi) {
      findings.push(finding('invalid_doi', 'problem', `"${rawDoi}" is not a valid DOI`, 'Correct the DOI.'))
    } else if (doiSeen.has(doi)) {
      findings.push(...doiSeen.get(doi).map((f) => ({ ...f })))
      checked = true
    } else if (networkChecked >= maxAudit) {
      findings.push(finding('not_checked', 'info', `over the ${maxAudit}-reference network cap`, 'Re-run with a higher max_audit or in batches.'))
    } else {
      networkChecked += 1
      checked = true
      const shared = []
      const crossref = await deps.fetchCrossref(doi)
      if (crossref.ok) shared.push(...compareToCrossref(record, crossref.work, deps.titleMatches))
      else if (crossref.status === 404) shared.push(finding('doi_not_registered', 'problem', 'Crossref has no record of this DOI', 'Check for a typo; the DOI may belong to another registry (DataCite, mEDRA).'))
      else shared.push(finding('crossref_unavailable', 'info', `Crossref lookup failed (${crossref.error || `HTTP ${crossref.status}`}); metadata unverified`))
      shared.push(...integrityFindings(await deps.integrity(doi)))
      doiSeen.set(doi, shared)
      findings.push(...shared)
    }
    const top = findings.reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity] || 0), 0)
    const unverified = findings.some((f) => UNVERIFIED_CODES.includes(f.code))
    references.push({
      key,
      doi: doi || null,
      status: top >= 3 ? 'problem' : top === 2 ? 'review' : (unverified || !checked ? 'unverified' : 'no_issues_found'),
      findings,
    })
  }
  const counts = { problem: 0, review: 0, unverified: 0, no_issues_found: 0 }
  for (const ref of references) counts[ref.status] += 1
  return {
    references,
    counts,
    network_checked: networkChecked,
    caveats: [
      'The audit checks that references exist and match their records; it does not check that a reference supports the claim it is cited for.',
      'no_issues_found means these checks found nothing, not that the reference is correct or appropriate.',
      'unverified means a check could not run (no DOI, lookup failed, over the cap, or a title/venue/author that cannot be compared lexically); it is not a pass.',
    ],
  }
}
