// Plain module (no JSX) so it can be unit-tested in Node and bundled into the page.
/** Loader entry id of this plugin's settings namespace. */
const KEYS_NAMESPACE = 'academic-harness'

/**
 * Which credential fields hold a value, from the host's redaction sidecar.
 * Credential fields carry role('secret'), so the host strips them from every
 * snapshot and reports `secrets: [{ path: [field], set }]` beside the value
 * instead. Returns undefined when the host sent no sidecar for this namespace
 * (an older or non-redacting host); the caller then reads the value.
 */
export function secretPresence(view) {
  const row = view?.namespaces?.find((entry) => entry.ns === KEYS_NAMESPACE)
  if (!row || !Array.isArray(row.secrets) || row.secrets.length === 0) return undefined
  const present = new Map()
  for (const secret of row.secrets) {
    if (Array.isArray(secret?.path) && secret.path.length === 1) present.set(String(secret.path[0]), secret.set === true)
  }
  return present
}
