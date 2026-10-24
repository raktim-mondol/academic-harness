/**
 * In-process bus for the Academic Harness gate. The existing `ah-hooks` module
 * emits the gate decision here; the RSI hooks consume it without running the
 * `ah hook stop` command a second time.
 */
const gateListeners = new Set()

export function onGate(listener) {
  gateListeners.add(listener)
  return () => gateListeners.delete(listener)
}

export function emitGate(event) {
  for (const listener of [...gateListeners]) {
    try {
      listener(event)
    } catch {
      // A reporting hook must never break the writing loop.
    }
  }
}
