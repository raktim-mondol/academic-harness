/**
 * Provenance link conventions shared by the cross-ledger audit and the newer
 * scientific ledgers. A link is only a reference: it does not assert support.
 */
import { sha256, shortHash } from './ledger-kit.js'

export const PROVENANCE_SCHEMA_VERSION = '1'

export const PROVENANCE_PREFIXES = Object.freeze({
  paper: 'paper',
  quote: 'quote',
  unit: 'unit',
  claim: 'claim',
  record: 'record',
  run: 'run',
  result: 'result',
  review: 'review',
  prereg: 'prereg',
  export: 'export',
})

export function provenanceKind(value) {
  const kind = String(value ?? '').trim().toLowerCase()
  if (!Object.prototype.hasOwnProperty.call(PROVENANCE_PREFIXES, kind)) {
    throw new Error(`unknown provenance kind "${value}"; expected one of ${Object.keys(PROVENANCE_PREFIXES).join(', ')}`)
  }
  return kind
}

export function provenanceId(value) {
  const id = String(value ?? '').trim()
  if (!id) throw new Error('provenance id is required')
  return id
}

export function provenanceLink(kind, id, extra = {}) {
  return { ...extra, kind: provenanceKind(kind), id: provenanceId(id) }
}

export function contentHash(value) {
  return `sha256:${sha256(value)}`
}

export function shortContentHash(value, length = 16) {
  return shortHash(value, length)
}

export function assertProvenanceLink(link) {
  if (!link || typeof link !== 'object') throw new Error('provenance link must be an object')
  provenanceKind(link.kind)
  provenanceId(link.id)
  return link
}
