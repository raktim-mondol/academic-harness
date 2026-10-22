/**
 * Agent preset identities. `academic-harness` is the current preset; the
 * `researchcraft` preset remains registered in v0.16.x so sessions created
 * before the rename still resolve. Remove the legacy id in v0.17.0.
 */
export const PRESET_ID = 'academic-harness'
export const LEGACY_PRESET_ID = 'researchcraft'

export function isPluginPreset(id) {
  return id === PRESET_ID || id === LEGACY_PRESET_ID
}
