/** Session-private interaction state, bound to React through the slot hooks compartment. */
import { validateTaskRequest } from '../task-modes.js'

export function createTaskModeStore({ sessionId, storage } = {}) {
  try { storage ??= globalThis.sessionStorage } catch { /* storage may be disabled by browser policy */ }
  const key = `academic-harness.task-draft.v1.${sessionId}`
  let restored
  try { restored = JSON.parse(storage?.getItem(key) ?? 'null') } catch { /* private mode or an invalid saved draft */ }
  let snapshot = { available: false, loading: true, effort: 'auto', error: null, lastTask: null }
  let request = null
  try {
    if (restored?.request) {
      request = validateTaskRequest(restored.request)
      snapshot.effort = request.options.effort
    }
  } catch { /* invalid or obsolete browser state must not become an executable request */ }
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of [...listeners]) listener()
    },
    getRequest: () => request,
    setRequest(value) {
      request = value
      try {
        if (value) storage?.setItem(key, JSON.stringify({ request: value }))
        else storage?.removeItem(key)
      } catch { /* unavailable storage only disables cross-refresh retry identity */ }
    },
  }
}
