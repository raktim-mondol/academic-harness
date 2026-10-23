/**
 * Shared gate for optional Phase 6–8 tools. The preset rows always exist;
 * `apply()` returns without registering unless AH_ENABLE_OPTIONAL_TOOLS is
 * truthy, so the tool is absent from the prompt and tool list by default.
 * Changing the flag requires a dsh restart (mount-time decision).
 */
export function optionalToolsEnabled(env = process.env) {
  const value = String(env.AH_ENABLE_OPTIONAL_TOOLS ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}
