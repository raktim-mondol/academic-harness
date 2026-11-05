/**
 * DSH 0.2.1 exposes list_agents as a separate plugin. In 0.2.2 the
 * subpath was removed and the control plugin registers it itself. Resolve
 * the host's export rather than guessing from a version string.
 */
export const name = 'academic-harness-subagent-list-compat'
export const inject = ['tools', 'subagents', 'agents']

export async function loadLegacyListAgents(
  resolve = () => import.meta.resolve('@deepseek-ai/dsh-tool-subagent-control/list-agents'),
  load = (specifier) => import(specifier),
) {
  let specifier
  try {
    specifier = resolve()
  } catch (error) {
    // Node uses this specific code when the installed control package exists
    // but no longer exports the legacy subpath. Other errors must fail loudly.
    if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null
    throw error
  }
  // A failure inside the legacy module is not a missing host subpath.
  return load(specifier)
}

export async function apply(ctx) {
  const legacy = await loadLegacyListAgents()
  if (legacy) ctx.plugin(legacy)
}
