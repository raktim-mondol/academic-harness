import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchAcademicHarnessProfiles } from './pnpm-workspace.js'

const here = dirname(fileURLToPath(import.meta.url))

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function copyMissing(src, dest) {
  if (!existsSync(src)) return 0
  mkdirSync(dest, { recursive: true })
  let n = 0
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const from = join(src, ent.name)
    const to = join(dest, ent.name)
    if (existsSync(to)) continue
    if (!existsSync(join(from, 'SKILL.md'))) continue
    cpSync(from, to, { recursive: true })
    n++
  }
  return n
}

/** Carry a pre-v0.16.0 seeded notebook skill over to its new directory name. */
function migrateLegacyNotebookSkill(dest) {
  const oldDir = join(dest, 'researchcraft-notebook')
  const newDir = join(dest, 'academic-harness-notebook')
  if (!existsSync(oldDir) || existsSync(newDir)) return
  renameSync(oldDir, newDir)
  const skill = join(newDir, 'SKILL.md')
  if (!existsSync(skill)) return
  const text = readFileSync(skill, 'utf8')
  const next = text.replace(/^name: researchcraft-notebook$/m, 'name: academic-harness-notebook')
  if (next !== text) writeFileSync(skill, next)
}

/**
 * Refresh first-party/renamed skill briefs that shipped with known-stale
 * content. `copyMissing` never overwrites an existing directory, so without
 * this an upgraded install keeps the old brief forever. Only files carrying a
 * known stale marker are replaced, so local edits to other skills survive.
 */
const STALE_SKILLS = [
  { dir: 'runpod', stale: (text) => /ResearchCraft API keys/.test(text) || !text.includes('## API version') },
  { dir: 'modal', stale: (text) => /ResearchCraft API keys/.test(text) || !text.includes('modal-sdk') },
  { dir: 'vastai', stale: (text) => !text.includes('## Pitfalls that break agent runs') },
  { dir: 'modal-usage', stale: (text) => /^name: modal$/m.test(text) },
  { dir: 'academic-harness-notebook', stale: (text) => /ResearchCraft/.test(text) },
  { dir: 'papermemory', stale: (text) => !text.includes('its project scopes exports') },
]

function refreshStaleSkills(dest) {
  for (const { dir, stale } of STALE_SKILLS) {
    const from = join(here, 'skills', dir, 'SKILL.md')
    const to = join(dest, dir, 'SKILL.md')
    if (!existsSync(from) || !existsSync(to)) continue
    let shipped
    let installed
    try {
      shipped = readFileSync(from, 'utf8')
      installed = readFileSync(to, 'utf8')
    } catch {
      continue
    }
    if (shipped !== installed && stale(installed)) writeFileSync(to, shipped)
  }
}

/**
 * Install first-party skills into DSH home. The Academic Harness agent preset is
 * a `@deepseek-ai/dsh-agent-preset` declaration in `cordis.patch.yml` (DSH
 * 0.2.0+); `$DSH_HOME/.agent-presets/` is not read. Scientific catalogue
 * skills stay on disk (scientific-agent-skills or a fallback checkout) and
 * are wired through the preset's skill-filesystem row.
 */
export function seed() {
  const home = dshHome()
  const dest = join(home, 'skills')
  migrateLegacyNotebookSkill(dest)
  copyMissing(join(here, 'skills'), dest)
  refreshStaleSkills(dest)
  const patched = patchAcademicHarnessProfiles(home)
  if (patched.length) {
    console.warn(`[academic-harness] pnpm: set allowBuilds for the Modal SDK's optional native deps in ${patched.length} profile(s)`)
  }
}
