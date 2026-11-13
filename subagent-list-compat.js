/**
 * DSH 0.2.1 exposes list_agents as a separate plugin. In 0.2.2 the
 * subpath was removed and the control plugin registers it itself. Resolve
 * the host's export rather than guessing from a version string.
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'academic-harness-subagent-list-compat'
export const inject = ['tools', 'subagents', 'agents']

const LEGACY_LIST = '@deepseek-ai/dsh-tool-subagent-control/list-agents'

/** Linked plugins resolve from their source tree; DSH's healed host packages live beside profiles. */
export function resolveHostListAgents(
  localResolve = () => import.meta.resolve(LEGACY_LIST),
  hostResolve = () => createRequire(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'package.json')).resolve(LEGACY_LIST),
) {
  try { return localResolve() } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return hostResolve()
  }
}

export async function loadLegacyListAgents(
  resolve = resolveHostListAgents,
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
