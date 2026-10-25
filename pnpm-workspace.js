/**
 * pnpm 11 build-script policy for DSH profiles.
 *
 * pnpm 11 rejects installs with ERR_PNPM_IGNORED_BUILDS when a dependency's
 * lifecycle script has not been explicitly allowed or denied in the root
 * workspace's `allowBuilds` map. The Modal SDK pulls two optional native
 * packages (cbor-extract, protobufjs) whose scripts are not needed — cbor-x
 * has a JS fallback — so deny those builds in the profile config instead of
 * weakening strictDepBuilds for everything.
 *
 * Only profiles that already depend on academic-harness are touched, and the
 * patch is idempotent, so a mount never rewrites unrelated profiles.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_ALLOW_BUILDS = ['cbor-extract', 'protobufjs']

const ALLOW_HEADER = /^([ \t]*)allowBuilds\s*:(.*)$/

function indentOf(line) {
  return line.match(/^[ \t]*/)[0]
}

/**
 * Add missing package entries to an `allowBuilds` map.
 * Returns the original text when nothing changes (so callers can skip writes).
 * Supports block style (pnpm's output) and inline flow maps.
 */
export function patchAllowBuilds(text, packages = DEFAULT_ALLOW_BUILDS) {
  const lines = String(text ?? '').split(/\r?\n/)
  const index = lines.findIndex((line) => ALLOW_HEADER.test(line))

  if (index < 0) {
    const base = String(text ?? '').replace(/\s+$/, '')
    const block = ['allowBuilds:', ...packages.map((pkg) => `  ${pkg}: false`)].join('\n')
    return { text: `${base ? `${base}\n\n` : ''}${block}\n`, changed: true }
  }

  const [, headerIndent, rest] = lines[index].match(ALLOW_HEADER)
  const trimmed = rest.trim()

  if (trimmed.startsWith('{')) {
    const close = trimmed.lastIndexOf('}')
    if (close < 0) return { text, changed: false }
    const inner = trimmed.slice(1, close)
    const existing = new Set(
      inner.split(',').map((entry) => entry.split(':')[0].trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
    )
    const missing = packages.filter((pkg) => !existing.has(pkg))
    if (!missing.length) return { text, changed: false }
    const prefix = inner.trim() ? `${inner.replace(/\s+$/, '')}${inner.trim().endsWith(',') ? '' : ','} ` : ''
    const addition = missing.map((pkg) => `${pkg}: false`).join(', ')
    lines[index] = `${headerIndent}allowBuilds: { ${prefix}${addition} }`
    return { text: lines.join('\n'), changed: true }
  }

  if (trimmed !== '') return { text, changed: false }

  let end = index + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() && indentOf(line).length <= headerIndent.length) break
    end++
  }
  const existing = new Set()
  for (let i = index + 1; i < end; i++) {
    const match = lines[i].match(/^[ \t]+['"]?([A-Za-z0-9_.-]+)['"]?\s*:/)
    if (match) existing.add(match[1])
  }
  const missing = packages.filter((pkg) => !existing.has(pkg))
  if (!missing.length) return { text, changed: false }
  let entryIndent = `${headerIndent}  `
  for (let i = index + 1; i < end; i++) {
    if (lines[i].trim()) {
      entryIndent = indentOf(lines[i])
      break
    }
  }
  lines.splice(index + 1, 0, ...missing.map((pkg) => `${entryIndent}${pkg}: false`))
  return { text: lines.join('\n'), changed: true }
}

/** Patch one profile's pnpm-workspace.yaml. Returns true when it changed. */
export function patchProfileWorkspace(profileDir, packages = DEFAULT_ALLOW_BUILDS) {
  const file = join(profileDir, 'pnpm-workspace.yaml')
  const before = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const { text, changed } = patchAllowBuilds(before, packages)
  if (changed) writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
  return changed
}

function dependsOnAcademicHarness(profileDir) {
  const file = join(profileDir, 'package.json')
  if (!existsSync(file)) return false
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    if (Object.prototype.hasOwnProperty.call(deps, 'academic-harness')) return true
    return Array.isArray(pkg.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('academic-harness')
  } catch {
    return false
  }
}

/**
 * Patch every DSH profile that installs or bundles Academic Harness.
 * New profiles created later are handled by the managed Modal runtime, which
 * writes its own workspace config before installing.
 */
export function patchAcademicHarnessProfiles(home) {
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) return []
  const patched = []
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const profileDir = join(profilesDir, entry.name)
    if (!dependsOnAcademicHarness(profileDir)) continue
    try {
      if (patchProfileWorkspace(profileDir)) patched.push(profileDir)
    } catch {
      // A read-only or malformed profile must not break seeding.
    }
  }
  return patched
}
