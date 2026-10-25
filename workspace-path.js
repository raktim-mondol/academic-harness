/**
 * Workspace path confinement shared by the remote-compute tools.
 *
 * A lexical `..` check is not enough: a symlink inside the workspace can point
 * anywhere, so both the lexical target and its real path must stay under the
 * workspace root. The root itself is rejected — `files_out: "."` would
 * otherwise replace the entire workspace with the remote /workspace.
 */
import fs from 'node:fs'
import path from 'node:path'

function assertUnder(root, target, rel) {
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`path escapes the workspace: ${rel}`)
  }
}

/**
 * Resolve a workspace-relative path for a read or write.
 *
 * For writes the target usually does not exist yet, so the deepest existing
 * ancestor is realpath'd and the remaining segments are appended, keeping the
 * check meaningful through symlinked parent directories.
 */
export function resolveWorkspacePath(root, rel, { forWrite = false } = {}) {
  if (typeof rel !== 'string' || rel.trim() === '') throw new Error('empty workspace path')
  const rootAbs = path.resolve(root)
  const rootReal = fs.realpathSync(rootAbs)
  const target = path.resolve(rootAbs, rel)

  assertUnder(rootAbs, target, rel)
  if (target === rootAbs) throw new Error(`refusing the workspace root as a path: ${rel}`)

  let probe = target
  const rest = []
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    rest.unshift(path.basename(probe))
    probe = parent
  }
  const probeReal = fs.realpathSync(probe)
  const resolved = path.join(probeReal, ...rest)

  assertUnder(rootReal, resolved, rel)
  if (resolved === rootReal) throw new Error(`refusing the workspace root as a path: ${rel}`)
  if (!forWrite && !fs.existsSync(resolved)) return resolved
  return resolved
}
