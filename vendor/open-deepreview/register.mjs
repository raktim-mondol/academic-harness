/**
 * TypeScript loader for installed layouts.
 *
 * Node's built-in type stripping refuses files under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), which is exactly where an npm
 * install of this plugin puts vendor/. This hook strips the vendored `.ts`
 * files synchronously with the same strip-only mode; every other module goes
 * through Node's normal loader. Loaded via `--import` by deep-review.js.
 */
import { readFileSync, realpathSync } from 'node:fs'
import module from 'node:module'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function real(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Compare real paths: npm link/pnpm and --preserve-symlinks can hand the loader
// symlinked URLs for the vendored tree.
const here = real(`${fileURLToPath(new URL('.', import.meta.url))}`).replace(/[\\/]$/, '')

function isVendoredTs(url) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return false
  let file
  try {
    file = real(fileURLToPath(url))
  } catch {
    return false
  }
  return file.startsWith(here + sep)
}

module.registerHooks({
  load(url, context, nextLoad) {
    if (isVendoredTs(url)) {
      const source = readFileSync(fileURLToPath(url), 'utf8')
      return {
        format: 'module',
        source: module.stripTypeScriptTypes(source, { mode: 'strip' }),
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})
