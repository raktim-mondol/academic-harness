/**
 * Ethics/IRB protocol ledger under `<cwd>/.dsh/ethics/<slug>/`.
 *
 * The protocol is append-only; sections are versioned events and the latest
 * value per section is derived. The checklist is a set of concepts to review,
 * not legal advice or a compliance verdict, and institutional requirements
 * always stay manual_check.
 */
import { join } from 'node:path'
import {
  appendJsonl, ensureDir, exportText, mdCell, nowIso, readJsonl,
  sha256, slug as slugify, stableStringify,
} from './ledger-kit.js'
import { withLock } from './store-lock.js'
import { resolveWorkspacePath } from './workspace-path.js'

export const ETHICS_ACTIONS = ['start', 'section', 'consent', 'check', 'status', 'export']
export const ETHICS_EXPORT_FORMATS = ['markdown', 'json']
export const STUDY_TYPES = ['human_subjects', 'animal', 'data_only', 'mixed', 'not_recorded']
export const JURISDICTIONS = ['us', 'eu', 'uk', 'other', 'not_recorded']

const PLACEHOLDER = '[TO BE COMPLETED]'

function text(value) {
  return String(value ?? '').trim()
}

function list(value) {
  if (value == null || value === '') return []
  return (Array.isArray(value) ? value : String(value).split(/[;,]/)).map(text).filter(Boolean)
}

export function ethicsSlug(value) {
  const slug = slugify(value, 80)
  if (!slug) throw new Error('slug must contain at least one letter or digit')
  return slug
}

export function ethicsDir(cwd, value) {
  return join(cwd, '.dsh', 'ethics', ethicsSlug(value))
}

function files(cwd, value) {
  const dir = ethicsDir(cwd, value)
  return {
    dir,
    protocol: join(dir, 'protocol.jsonl'),
    consents: join(dir, 'consents.jsonl'),
    consentDir: join(dir, 'consents'),
    exports: join(dir, 'exports'),
  }
}

function normalizeStudyType(value) {
  const raw = text(value).toLowerCase().replace(/\s+/g, '_')
  if (!raw) return 'not_recorded'
  const aliases = { human: 'human_subjects', humans: 'human_subjects', animal: 'animal', data: 'data_only', secondary_data: 'data_only', mixed: 'mixed' }
  const resolved = aliases[raw] || raw
  if (!STUDY_TYPES.includes(resolved)) throw new Error(`study_type must be one of ${STUDY_TYPES.join(', ')}`)
  return resolved
}

function normalizeJurisdiction(value) {
  const raw = text(value).toLowerCase().replace(/\s+/g, '_')
  if (!raw) return 'not_recorded'
  const aliases = { usa: 'us', united_states: 'us', europe: 'eu', european_union: 'eu', gdpr: 'eu', uk: 'uk', other: 'other' }
  const resolved = aliases[raw] || raw
  if (!JURISDICTIONS.includes(resolved)) throw new Error(`jurisdiction must be one of ${JURISDICTIONS.join(', ')}`)
  return resolved
}

function normalizeApproval(value) {
  if (value == null || value === '') return null
  if (typeof value === 'string') return { reference: text(value) || null, committee: null, date: null }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('approval must be a string or an object')
  return {
    reference: text(value.reference || value.number || value.id) || null,
    committee: text(value.committee || value.irb) || null,
    date: text(value.date) || null,
  }
}

export function normalizeEthicsProtocol(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('protocol must be an object')
  const protocol = {
    title: text(input.title) || null,
    study_type: normalizeStudyType(input.study_type),
    institution: text(input.institution) || null,
    principal_investigator: text(input.principal_investigator || input.pi) || null,
    population: text(input.population) || null,
    vulnerable_populations: list(input.vulnerable_populations),
    risk_level: text(input.risk_level) || null,
    risks: text(input.risks) || null,
    benefits: text(input.benefits) || null,
    consent_process: text(input.consent_process) || null,
    data_handling: text(input.data_handling || input.privacy) || null,
    data_types: list(input.data_types),
    jurisdiction: normalizeJurisdiction(input.jurisdiction),
    retention: text(input.retention) || null,
    sharing: text(input.sharing || input.data_sharing) || null,
    compensation: text(input.compensation) || null,
    incidental_findings: text(input.incidental_findings) || null,
    conflicts: text(input.conflicts || input.conflicts_of_interest) || null,
    funding: text(input.funding) || null,
    approval: normalizeApproval(input.approval),
    notes: text(input.notes) || null,
  }
  for (const [key, value] of Object.entries(input)) {
    if (key in protocol || value === undefined) continue
    protocol[key] = value
  }
  return protocol
}

function protocolEvents(cwd, slug) {
  return readJsonl(files(cwd, slug).protocol)
}

export function readEthicsProtocol(cwd, slug) {
  const events = protocolEvents(cwd, slug)
  const start = [...events].reverse().find((event) => event.event === 'start')
  if (!start) return { protocol: null, sections: {}, events, consents: readJsonl(files(cwd, slug).consents) }
  const sections = {}
  for (const event of events) {
    if (event.event === 'section') {
      sections[event.id] = { id: event.id, title: event.title || null, text: event.text, ts: event.ts, hash: event.hash }
    }
  }
  return { protocol: start.protocol, sections, events, consents: readJsonl(files(cwd, slug).consents), started_at: start.ts }
}

export async function startEthicsProtocol({ cwd, slug, protocol = {}, reason = null, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const events = protocolEvents(cwd, slug)
    const latest = [...events].reverse().find((event) => event.event === 'start')
    const normalized = normalizeEthicsProtocol(latest ? { ...latest.protocol, ...protocol } : protocol)
    if (!normalized.title) throw new Error('title is required')
    const hash = `sha256:${sha256(stableStringify(normalized))}`
    if (latest?.hash === hash) return { slug: ethicsSlug(slug), protocol: latest.protocol, hash, unchanged: true }
    if (latest && !text(reason)) throw new Error('changing the ethics protocol requires a reason; the earlier start event stays')
    const event = { event: 'start', ts: nowIso(), protocol: normalized, hash, reason: text(reason) || null, recorded_by: text(recordedBy) || null }
    appendJsonl(f.protocol, [event])
    return { slug: ethicsSlug(slug), protocol: normalized, hash, created: true, updated: Boolean(latest), reason: event.reason }
  }, { label: 'ethics protocol ledger' })
}

export async function recordEthicsSection({ cwd, slug, id, title = null, body, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.dir)
  return withLock(f.dir, async () => {
    const state = readEthicsProtocol(cwd, slug)
    if (!state.protocol) throw new Error(`ethics protocol "${ethicsSlug(slug)}" has not been started`)
    const sectionId = text(id)
    if (!sectionId) throw new Error('id is required')
    const value = text(body)
    if (!value) throw new Error('body is required')
    const hash = `sha256:${sha256(stableStringify({ id: sectionId, title: text(title) || null, body: value }))}`
    const event = { event: 'section', ts: nowIso(), id: sectionId, title: text(title) || null, text: value, hash, recorded_by: text(recordedBy) || null }
    appendJsonl(f.protocol, [event])
    return { slug: ethicsSlug(slug), section: { id: sectionId, title: event.title, text: value, hash, ts: event.ts } }
  }, { label: 'ethics protocol ledger' })
}

function field(value) {
  return text(value) || PLACEHOLDER
}

function renderConsent(protocol, inputs = {}) {
  const merged = { ...protocol, ...inputs }
  const title = field(merged.title)
  const lines = [
    `# Informed consent: ${title}`,
    '',
    `**Version:** ${field(inputs.version || '1.0')}  `,
    `**Date:** ${field(inputs.date)}`,
    '',
    'This form is a draft assembled from recorded protocol fields. Every bracketed item must be completed by the research team before use; the tool does not invent procedures, contacts, or approvals.',
    '',
    '## Purpose of the study',
    '',
    field(merged.purpose || merged.question || inputs.purpose),
    '',
    '## Why you are being invited',
    '',
    field(merged.population),
    '',
    '## What will happen if you take part',
    '',
    field(merged.procedures || inputs.procedures || merged.design),
    '',
    '## Risks and discomforts',
    '',
    field(merged.risks),
    '',
    '## Possible benefits',
    '',
    field(merged.benefits),
    '',
    '## Alternatives to taking part',
    '',
    field(inputs.alternatives),
    '',
    '## Confidentiality and data use',
    '',
    field(merged.data_handling || merged.privacy || inputs.confidentiality),
    '',
    `Data types recorded by the protocol: ${merged.data_types?.length ? merged.data_types.join(', ') : PLACEHOLDER}.`,
    '',
    `Retention: ${field(merged.retention)}  `,
    `Sharing: ${field(merged.sharing)}  `,
    `Incidental findings: ${field(merged.incidental_findings)}`,
    '',
    '## Compensation',
    '',
    field(merged.compensation),
    '',
    '## Voluntary participation and withdrawal',
    '',
    field(inputs.voluntary || 'Taking part is voluntary. You may decline or withdraw at any time; the protocol must state how withdrawal affects already-collected data.'),
    '',
    '## Contacts and questions',
    '',
    field(inputs.contacts || merged.contacts),
    '',
    '## Injury or complaints',
    '',
    field(inputs.injury || merged.injury_contact),
    '',
  ]
  if (merged.vulnerable_populations?.length) {
    lines.push('## Vulnerable participants', '', `The protocol lists: ${merged.vulnerable_populations.join(', ')}. ${field(inputs.vulnerable_safeguards)}`, '')
  }
  if (merged.study_type === 'human_subjects' || merged.study_type === 'mixed') {
    lines.push('## Consent and assent', '', 'The consent conversation must use language the participant can understand. Where children or decisionally impaired participants are involved, the protocol must add an assent form and guardian permission. [TO BE COMPLETED]', '')
  }
  lines.push(
    '## Signatures',
    '',
    'Participant name: ______________________  Signature: ______________________  Date: ____________',
    '',
    'Person obtaining consent: ______________________  Signature: ______________________  Date: ____________',
    '',
    '> This draft is not approval. Institution-specific wording, translation, and consent requirements remain the research team’s and the reviewing committee’s responsibility.',
    '',
  )
  return lines.join('\n')
}

export async function generateConsent({ cwd, slug, inputs = {}, overwrite = false, recordedBy = null }) {
  const f = files(cwd, slug)
  ensureDir(f.consentDir)
  return withLock(f.dir, async () => {
    const state = readEthicsProtocol(cwd, slug)
    if (!state.protocol) throw new Error(`ethics protocol "${ethicsSlug(slug)}" has not been started`)
    const body = renderConsent(state.protocol, inputs)
    const target = join(f.consentDir, 'consent.md')
    const result = exportText(target, body, { overwrite })
    const hash = `sha256:${sha256(body)}`
    appendJsonl(f.consents, [{ ts: nowIso(), path: target, hash, bytes: result.bytes, recorded_by: text(recordedBy) || null, fields: Object.keys(inputs) }])
    return { slug: ethicsSlug(slug), path: target, bytes: result.bytes, hash, placeholders: (body.match(/\[TO BE COMPLETED\]/g) || []).length }
  }, { label: 'ethics protocol ledger' })
}

function has(value) {
  return Boolean(text(value)) || (Array.isArray(value) && value.length > 0)
}

function item(id, label, status, detail, evidence = null) {
  return { id, label, status, detail, evidence }
}

export function ethicsChecklist(protocol, sections = {}, consents = []) {
  const items = []
  const sectionText = Object.values(sections).map((section) => section.text).join('\n')
  const combined = `${protocol.notes || ''}\n${sectionText}`.toLowerCase()
  const animal = ['animal', 'mixed'].includes(protocol.study_type)
  const identifiable = protocol.data_types.some((type) => /identif|phi|personal|linked/i.test(type))
  const human = ['human_subjects', 'mixed'].includes(protocol.study_type) || (protocol.study_type === 'data_only' && identifiable)

  items.push(item('ethics_approval', 'Ethics/IRB approval or exemption', protocol.approval?.reference || protocol.approval?.committee ? 'manual_check' : 'missing', protocol.approval?.reference || protocol.approval?.committee ? 'An approval reference is recorded but was not verified against the reviewing body.' : 'No approval reference is recorded. Do not represent the study as approved.', protocol.approval))
  items.push(item('institutional_requirements', 'Institution-specific requirements', 'manual_check', 'The tool cannot know local forms, signatures, or submission systems; check the institution’s current requirements.'))
  if (animal) items.push(item('animal_welfare', 'Animal welfare / IACUC and the 3Rs', 'manual_check', 'Record IACUC approval, humane endpoints, replacement/refinement/reduction, and housing/husbandry review.'))
  else items.push(item('animal_welfare', 'Animal welfare / IACUC and the 3Rs', 'not_applicable', 'The protocol is not recorded as animal or mixed research.'))

  if (!human) {
    items.push(item('consent', 'Informed consent', 'not_applicable', animal ? 'No human-subjects component is recorded; animal-welfare review applies instead.' : 'No human-subjects component is recorded.'))
  } else if (protocol.consent_process || sectionText.toLowerCase().includes('consent') || consents.length) {
    items.push(item('consent', 'Informed consent', 'manual_check', 'Consent language exists, but completeness, comprehension, translation, and approval require human review.', consents.at(-1)?.path || null))
  } else {
    items.push(item('consent', 'Informed consent', 'missing', 'No consent process or consent draft is recorded.'))
  }

  items.push(item('risk_benefit', 'Risk/benefit assessment', protocol.risks && protocol.benefits ? 'present' : protocol.risks ? 'manual_check' : 'missing', protocol.risks && protocol.benefits ? 'Risks and benefits are recorded; the committee must judge acceptability.' : protocol.risks ? 'Risks are recorded but benefits are missing.' : 'Risks are not recorded.'))
  items.push(item('privacy_confidentiality', 'Privacy and confidentiality', protocol.data_handling ? 'present' : 'missing', protocol.data_handling ? 'A data-handling/confidentiality description is recorded.' : 'No data-handling or confidentiality description is recorded.'))
  items.push(item('retention', 'Data retention and destruction', protocol.retention ? 'present' : 'missing', protocol.retention ? 'A retention statement is recorded.' : 'No retention/destruction statement is recorded.'))
  items.push(item('sharing', 'Data sharing and access', protocol.sharing ? 'present' : 'manual_check', protocol.sharing ? 'A sharing description is recorded; confirm it matches consent and funder requirements.' : 'No sharing/access description is recorded.'))
  items.push(item('compensation', 'Compensation and undue inducement', protocol.compensation ? 'present' : 'manual_check', protocol.compensation ? 'Compensation is recorded; the committee should assess whether it is undue.' : 'Compensation is not recorded; confirm whether any is offered.'))
  items.push(item('incidental_findings', 'Incidental findings plan', protocol.incidental_findings ? 'present' : 'manual_check', protocol.incidental_findings ? 'An incidental-findings plan is recorded.' : 'No incidental-findings plan is recorded; confirm whether one is required.'))
  items.push(item('vulnerable_populations', 'Vulnerable populations and safeguards', protocol.vulnerable_populations.length ? 'manual_check' : 'manual_check', protocol.vulnerable_populations.length ? `The protocol lists ${protocol.vulnerable_populations.join(', ')}; safeguards and assent/permission need review.` : 'No vulnerable group is listed; confirm this is accurate and record the basis.'))
  if (protocol.jurisdiction === 'eu' || protocol.jurisdiction === 'uk') {
    items.push(item('gdpr', 'GDPR/UK GDPR lawful basis and rights', 'manual_check', 'Record the lawful basis, transparency information, rights process, DPIA if required, and international-transfer safeguards.'))
  } else if (protocol.jurisdiction === 'us' && (human || identifiable)) {
    items.push(item('hipaa', 'HIPAA authorization or waiver', 'manual_check', 'If protected health information is involved, record the authorization or the IRB/privacy-board waiver basis.'))
  } else {
    items.push(item('data_protection', 'Data-protection law', 'manual_check', `Jurisdiction is ${protocol.jurisdiction}; confirm which privacy and data-protection rules apply.`))
  }
  if (identifiable) {
    items.push(item('deidentification', 'De-identification check', combined.includes('deidentif') || combined.includes('de-identif') ? 'manual_check' : 'missing', combined.includes('deidentif') || combined.includes('de-identif') ? 'A de-identification approach is mentioned; run `deidentify` on the actual files and review the report.' : 'The protocol records identifiable data but no de-identification approach.'))
  } else {
    items.push(item('deidentification', 'De-identification check', 'not_applicable', 'No identifiable data type is recorded; confirm that classification.'))
  }
  items.push(item('conflicts_funding', 'Funding and conflicts of interest', protocol.funding || protocol.conflicts ? 'present' : 'manual_check', protocol.funding || protocol.conflicts ? 'Funding/conflicts are recorded; disclosure wording still needs review.' : 'Funding and conflicts are not recorded.'))

  const counts = { present: 0, missing: 0, manual_check: 0, not_applicable: 0 }
  for (const entry of items) counts[entry.status] += 1
  return {
    items,
    counts,
    ready_for_review: counts.missing === 0,
    note: 'This is a concept checklist, not legal advice or a compliance verdict. Institutional requirements and all manual_check items require a human decision.',
  }
}

export function ethicsStatus(cwd, slug) {
  const state = readEthicsProtocol(cwd, slug)
  const checklist = state.protocol ? ethicsChecklist(state.protocol, state.sections, state.consents) : null
  let preregister = null
  try {
    const dir = join(cwd, '.dsh', 'preregister', slugify(slug))
    const versions = readJsonl(join(dir, 'versions.jsonl'))
    if (versions.length) preregister = versions.at(-1)
  } catch {
    preregister = null
  }
  return {
    slug: ethicsSlug(slug), dir: files(cwd, slug).dir, started: Boolean(state.protocol),
    protocol: state.protocol, sections: state.sections, consents: state.consents,
    checklist, preregister,
  }
}

function protocolMarkdown(state, checklist) {
  const protocol = state.protocol
  const lines = [
    `# Ethics protocol: ${protocol.title}`,
    '',
    `**Study type:** ${protocol.study_type} · **Jurisdiction:** ${protocol.jurisdiction} · **Institution:** ${protocol.institution || 'not recorded'}`,
    `**Principal investigator:** ${protocol.principal_investigator || 'not recorded'}`,
    '',
    '## Study description',
    '',
    `**Population:** ${protocol.population || 'not recorded'}`,
    `**Vulnerable populations:** ${protocol.vulnerable_populations.length ? protocol.vulnerable_populations.join(', ') : 'none recorded'}`,
    `**Risk level:** ${protocol.risk_level || 'not recorded'}`,
    '',
    '## Risks and benefits',
    '',
    `**Risks:** ${protocol.risks || 'not recorded'}`,
    `**Benefits:** ${protocol.benefits || 'not recorded'}`,
    '',
    '## Consent',
    '',
    protocol.consent_process || protocol.consent || 'not recorded',
    '',
    '## Data handling and privacy',
    '',
    `**Data types:** ${protocol.data_types.length ? protocol.data_types.join(', ') : 'not recorded'}`,
    `**Handling:** ${protocol.data_handling || 'not recorded'}`,
    `**Retention:** ${protocol.retention || 'not recorded'}`,
    `**Sharing:** ${protocol.sharing || 'not recorded'}`,
    `**Incidental findings:** ${protocol.incidental_findings || 'not recorded'}`,
    '',
    '## Approval and oversight',
    '',
    protocol.approval ? `**Recorded approval reference:** ${protocol.approval.reference || 'not recorded'} · ${protocol.approval.committee || 'committee not recorded'} · ${protocol.approval.date || 'date not recorded'}` : '**No approval reference recorded.**',
    '',
  ]
  if (Object.keys(state.sections).length) {
    lines.push('## Recorded sections', '')
    for (const section of Object.values(state.sections)) lines.push(`### ${section.title || section.id}`, '', section.text, '')
  }
  if (state.consents.length) lines.push('## Consent drafts', '', ...state.consents.map((consent) => `- ${consent.path} (${consent.hash})`), '')
  lines.push('## Concept checklist', '')
  lines.push('| Item | Status | Detail |', '|---|---|---|')
  for (const entry of checklist.items) lines.push(`| ${mdCell(entry.label)} | ${entry.status} | ${mdCell(entry.detail)} |`)
  lines.push('', `Present ${checklist.counts.present} · missing ${checklist.counts.missing} · manual ${checklist.counts.manual_check} · not applicable ${checklist.counts.not_applicable}.`)
  lines.push('', `> ${checklist.note}`, '')
  return lines.join('\n')
}

export function exportEthicsProtocol({ cwd, slug, format = 'markdown', out = null, overwrite = false }) {
  const state = ethicsStatus(cwd, slug)
  if (!state.protocol) throw new Error(`ethics protocol "${ethicsSlug(slug)}" has not been started`)
  const kind = text(format).toLowerCase() || 'markdown'
  if (!ETHICS_EXPORT_FORMATS.includes(kind)) throw new Error(`format must be one of ${ETHICS_EXPORT_FORMATS.join(', ')}`)
  const dir = files(cwd, slug).exports
  ensureDir(dir)
  const target = out ? resolveWorkspacePath(cwd, out, { forWrite: true }) : join(dir, `ethics.${kind === 'json' ? 'json' : 'md'}`)
  if (kind === 'json') {
    const body = `${JSON.stringify({
      slug: state.slug, protocol: state.protocol, sections: state.sections, consents: state.consents,
      checklist: state.checklist, preregister: state.preregister,
      note_text: 'Concept checklist, not a compliance verdict or legal advice.',
    }, null, 2)}\n`
    const result = exportText(target, body, { overwrite })
    return { ...result, format: 'json' }
  }
  const result = exportText(target, protocolMarkdown(state, state.checklist), { overwrite })
  return { ...result, format: 'markdown' }
}
