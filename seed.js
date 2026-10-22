import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
}
