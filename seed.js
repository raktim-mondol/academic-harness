import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchAcademicHarnessProfiles } from './pnpm-workspace.js'
import { excludeNonCommercial, isNonCommercial, readLicense } from './skill-licenses.js'

const here = dirname(fileURLToPath(import.meta.url))

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** True when the skill directory's licence label is a non-commercial one. */
function skillIsNonCommercial(dir) {
  try {
    return isNonCommercial(readLicense(readFileSync(join(dir, 'SKILL.md'), 'utf8')))
  } catch {
    return false
  }
}

function copyMissing(src, dest, { skip } = {}) {
  if (!existsSync(src)) return 0
  mkdirSync(dest, { recursive: true })
  let n = 0
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const from = join(src, ent.name)
    const to = join(dest, ent.name)
    if (existsSync(to)) continue
    if (!existsSync(join(from, 'SKILL.md'))) continue
    if (skip && skip(from)) continue
    cpSync(from, to, { recursive: true })
    n++
  }
  return n
}

/**
 * Refresh first-party/renamed skill briefs that shipped with known-stale
 * content. `copyMissing` never overwrites an existing directory, so without
 * this an upgraded install keeps the old brief forever. Only files carrying a
 * known stale marker are replaced, so local edits to other skills survive.
 */
const SUPERVISOR_SKILLS = [
  'benchmark-paper-template',
  'deep-research',
  'drawio-reconstruction',
  'figure-designer',
  'idea-evaluator',
  'intro-drafter',
  'paper-polish',
  'paper-writer',
  'pre-submission-reviewer',
  'rebuttal-guidance',
  'tech-paper-template',
  'vibe-research-workflow',
]

// Existing skills that now carry a reciprocal Supervisor-Skills routing note.
const RELATED_SKILLS = [
  'academic-harness',
  'abstract-writer',
  'agentic-data-science-pipeline',
  'ah-plan-section',
  'ah-write-unit',
  'diagram-design',
  'generating-scientific-hypotheses',
  'literature-researcher',
  'literature-review',
  'manuscript-editor',
  'peer-reviewer',
  'remove-ai-signs',
  'scientific-figure-making',
  'surveying-prior-work',
  'systematic-review-ledger',
]

const STALE_SKILLS = [
  { dir: 'runpod', stale: (text) => !text.includes('## API version') },
  { dir: 'modal', stale: (text) => !text.includes('modal-sdk') },
  { dir: 'vastai', stale: (text) => !text.includes('## Pitfalls that break agent runs') },
  { dir: 'modal-usage', stale: (text) => /^name: modal$/m.test(text) },
  { dir: 'papermemory', stale: (text) => !text.includes('its project scopes exports') },
  { dir: 'systematic-review-ledger', stale: (text) => !text.includes('risk-of-bias-appraisal') },
  ...SUPERVISOR_SKILLS.map((dir) => ({ dir, stale: (text) => !text.includes('Routing in Academic Harness') })),
  ...RELATED_SKILLS.map((dir) => ({ dir, stale: (text) => !text.includes('Supervisor-Skills') })),
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
 * The docx, pdf, pptx and xlsx skills were rewritten from scratch after 0.50.0. Earlier
 * releases shipped Anthropic's versions, whose all-rights-reserved LICENSE.txt
 * does not allow redistribution, and `copyMissing` never replaces an installed
 * directory, so an upgraded install would keep them. A seeded copy is recognised
 * by that LICENSE.txt (SHA-256 below, the same file in all four) and moved to
 * `$DSH_HOME/skills-retired/`, out of the catalogue, instead of deleted. A
 * directory without that file, or with a different one, is the user's own and is
 * left alone. The bundled rewrite is then copied in by `copyMissing`.
 */
const RESTRICTED_SKILLS = ['docx', 'pdf', 'pptx', 'xlsx']
const RESTRICTED_LICENSE_SHA256 = '79f6d8f5b427252fa3b1c11ecdbdb6bf610b944f7530b4de78f770f38741cfaa'

export function retireRestrictedSkills(dest, retiredRoot = join(dirname(dest), 'skills-retired')) {
  const moved = []
  for (const name of RESTRICTED_SKILLS) {
    const dir = join(dest, name)
    const license = join(dir, 'LICENSE.txt')
    if (!existsSync(license)) continue
    let digest
    try {
      digest = createHash('sha256').update(readFileSync(license)).digest('hex')
    } catch {
      continue
    }
    if (digest !== RESTRICTED_LICENSE_SHA256) continue
    mkdirSync(retiredRoot, { recursive: true })
    let target = join(retiredRoot, name)
    for (let i = 2; existsSync(target); i += 1) target = join(retiredRoot, `${name}-${i}`)
    renameSync(dir, target)
    moved.push({ name, to: target })
  }
  return moved
}

/**
 * Install the bundled skills into `$DSH_HOME/skills`. The Academic Harness
 * agent preset is a `@deepseek-ai/dsh-agent-preset` declaration in
 * `cordis.patch.yml` (DSH 0.2.0+); `$DSH_HOME/.agent-presets/` is not read.
 * The preset's skill-filesystem row can point at a different catalogue with
 * `ACADEMIC_HARNESS_SKILLS_DIR`, but the default install seeds every bundled
 * skill here.
 */
export function seed() {
  const home = dshHome()
  const dest = join(home, 'skills')
  for (const { name, to } of retireRestrictedSkills(dest)) {
    console.warn(`[academic-harness] skill "${name}": moved the previously installed copy to ${to}; the bundled rewrite replaces it`)
  }
  // AH_EXCLUDE_NONCOMMERCIAL=1 leaves the CC BY-NC skills out (see NOTICE).
  copyMissing(join(here, 'skills'), dest, { skip: excludeNonCommercial() ? skillIsNonCommercial : undefined })
  refreshStaleSkills(dest)
  const patched = patchAcademicHarnessProfiles(home)
  if (patched.length) {
    console.warn(`[academic-harness] pnpm: set allowBuilds for the Modal SDK's optional native deps in ${patched.length} profile(s)`)
  }
}
