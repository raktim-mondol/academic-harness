import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchAcademicHarnessProfiles } from './pnpm-workspace.js'
import { excludeNonCommercial, isNonCommercial, readLicense } from './skill-licenses.js'
import { coreSkillNames } from './skill-index.js'

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

function copyMissing(src, dest, only = null, skip = null) {
  if (!existsSync(src)) return 0
  mkdirSync(dest, { recursive: true })
  let n = 0
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    if (only && !only.has(ent.name)) continue
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

/** SHA-256 over relative paths and bytes; `__pycache__` is ignored so a skill that was run still compares equal. */
function treeHash(dir) {
  const hash = createHash('sha256')
  const walk = (current, rel) => {
    for (const ent of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name === '__pycache__') continue
      const path = join(current, ent.name)
      const here = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(path, here)
      else if (ent.isFile()) hash.update(`${here}\0`).update(readFileSync(path)).update('\0')
      else hash.update(`${here}\0other\0`)
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

const SEED_STATE = '.ah-skill-seed.json'
const SEED_STATE_VERSION = 1
const SKILL_DIR_NAME = /^[a-z0-9][a-z0-9-]{0,80}$/

/**
 * Seed the bundled skills the host catalogue should list (decision D39).
 *
 * The host publishes every skill under `$DSH_HOME/skills` as a durable
 * catalogue message on every step, so seeding all bundled skills cost about
 * 280k characters of context. By default only the core skills are seeded; the
 * rest are reached through `skill_search` / `skill_load` (skill-on-demand.js).
 * `AH_SKILLS_SEED=all` restores the old behaviour.
 *
 * Copies of non-core bundled skills left by earlier versions are removed once,
 * and only when they are byte-identical to the bundled skill, so a skill the
 * user edited is never touched. A small state file records that the clean-up
 * ran, so later starts do not re-hash the directory.
 */
export function seedSkills({ home = dshHome(), bundled = join(here, 'skills'), env = process.env, core = coreSkillNames() } = {}) {
  const dest = join(home, 'skills')
  const mode = env.AH_SKILLS_SEED === 'all' ? 'all' : 'core'
  // Anthropic's old docx/pdf/pptx/xlsx copies must go before the clean-up below, which only
  // removes copies that equal the bundled skill (the rewrites differ from them).
  for (const { name, to } of retireRestrictedSkills(dest)) {
    console.warn(`[academic-harness] skill "${name}": moved the previously installed copy to ${to}; the bundled rewrite replaces it`)
  }
  // AH_EXCLUDE_NONCOMMERCIAL=1 leaves the CC BY-NC skills out (see NOTICE).
  const copied = copyMissing(bundled, dest, mode === 'core' ? core : null, excludeNonCommercial(env) ? skillIsNonCommercial : null)
  let pruned = []
  if (mode === 'core' && core.size > 0) {
    const statePath = join(dest, SEED_STATE)
    let state = null
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch { /* first run or unreadable: clean up */ }
    if (!state || state.version !== SEED_STATE_VERSION || state.mode !== 'core') {
      for (const ent of readdirSync(dest, { withFileTypes: true })) {
        if (!ent.isDirectory() || core.has(ent.name) || !SKILL_DIR_NAME.test(ent.name)) continue
        const installed = join(dest, ent.name)
        const shipped = join(bundled, ent.name)
        if (!existsSync(join(shipped, 'SKILL.md'))) continue // not a bundled skill: the user's own
        try {
          if (treeHash(installed) !== treeHash(shipped)) continue // edited by the user: keep
          rmSync(installed, { recursive: true, force: true })
          pruned.push(ent.name)
        } catch { /* leave it in place */ }
      }
      try {
        writeFileSync(statePath, `${JSON.stringify({ version: SEED_STATE_VERSION, mode: 'core', pruned: pruned.length }, null, 2)}\n`)
      } catch { /* the clean-up simply repeats next start */ }
    }
  } else if (mode === 'all') {
    try {
      rmSync(join(dest, SEED_STATE), { force: true })
    } catch { /* ignore */ }
  }
  refreshStaleSkills(dest)
  return { mode, copied, pruned }
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
  { dir: 'co-scientist-tournament', stale: (text) => !text.includes('as the direction of the reward') },
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
 * Install the core bundled skills into `$DSH_HOME/skills` (see seedSkills). The
 * Academic Harness agent preset is a `@deepseek-ai/dsh-agent-preset` declaration
 * in `cordis.patch.yml` (DSH 0.2.0+); `$DSH_HOME/.agent-presets/` is not read.
 * The preset's skill-filesystem row can point at a different catalogue with
 * `ACADEMIC_HARNESS_SKILLS_DIR`.
 */
export function seed() {
  const home = dshHome()
  seedSkills({ home })
  const patched = patchAcademicHarnessProfiles(home)
  if (patched.length) {
    console.warn(`[academic-harness] pnpm: set allowBuilds for the Modal SDK's optional native deps in ${patched.length} profile(s)`)
  }
}
