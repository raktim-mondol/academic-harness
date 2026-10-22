/**
 * Resolve an env-var-shaped secret: the launching shell's environment always
 * wins, otherwise fall back to the value stored in the
 * host plugin Config (Settings -> Academic Harness API keys), so a key entered
 * through the web UI works without exporting a shell variable. Settings
 * resolution is per-call (settings-keys.js's scope.get()),
 * so a key changed in Settings reaches the next tool call with no restart.
 */
import { getStoredKey } from './settings-keys.js'

export async function resolveEnv(name) {
  const fromEnv = process.env[name]?.trim()
  if (fromEnv) return fromEnv
  return getStoredKey(name)
}
