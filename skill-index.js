/**
 * The bundled skills, searchable and loadable on demand (decision D39).
 *
 * The host's `tool-skill` publishes every skill it can see as a durable
 * catalogue message, so seeding all 790 bundled skills cost about 280k
 * characters of context on every step. Now only the core skills (the ones the
 * system prompt, the workflows and the preset name explicitly; see
 * skills-core.json) are seeded into the host catalogue. Every other bundled
 * skill stays inside this package and is reached through `skill_search` and
 * `skill_load` (skill-on-demand.js), so it costs context only when it is used.
 *
 * Pure and offline: reads the package's own `skills/` directory.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { rankWithBm25 } from './bm25-rank.js'

const here = dirname(fileURLToPath(import.meta.url))
export const BUNDLED_SKILLS_DIR = join(here, 'skills')
const NAME = /^[a-z0-9][a-z0-9-]{0,80}$/
const DESCRIPTION_CHARS = 240
const HEAD_BYTES = 12_288

export function coreSkillNames() {
  try {
    return new Set(JSON.parse(readFileSync(join(here, 'skills-core.json'), 'utf8')))
  } catch {
    return new Set()
  }
}

/** `AH_EXCLUDE_NONCOMMERCIAL=1` hides CC-BY-NC skills, as the packaging option does. */
export function isNonCommercialLicense(license) {
  return /^(cc[- ]by[- ]nc|non-?commercial)/i.test(String(license ?? '').trim())
}

function frontmatterOf(path) {
  let head
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    head = buffer.toString('utf8', 0, readSync(fd, buffer, 0, HEAD_BYTES, 0))
  } finally {
    closeSync(fd)
  }
  const match = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  try {
    const fields = YAML.parse(match[1])
    return fields && typeof fields === 'object' ? fields : null
  } catch {
    return null
  }
}

const indexCache = new Map()

/** Every bundled skill with a readable name and description; cached per directory. */
export function bundledSkills(dir = BUNDLED_SKILLS_DIR) {
  if (indexCache.has(dir)) return indexCache.get(dir)
  const out = []
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue
      const file = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      const fields = frontmatterOf(file)
      if (!fields || typeof fields.description !== 'string') continue
      out.push({
        name: entry.name,
        description: fields.description.replace(/\s+/g, ' ').trim(),
        license: typeof fields.license === 'string' ? fields.license : '',
        path: join(dir, entry.name),
      })
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  indexCache.set(dir, out)
  return out
}

export function resetSkillIndexForTests() {
  indexCache.clear()
}

function visible(skills, env) {
  return env.AH_EXCLUDE_NONCOMMERCIAL === '1' ? skills.filter((s) => !isNonCommercialLicense(s.license)) : skills
}

function clip(text, max = DESCRIPTION_CHARS) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/**
 * Rank bundled skills against a task description.
 * @returns {{ results: Array<{ name: string, description: string, in_catalog: boolean }>, total: number }}
 */
export function searchSkills(query, { limit = 8, dir = BUNDLED_SKILLS_DIR, env = process.env, core = coreSkillNames() } = {}) {
  const skills = visible(bundledSkills(dir), env)
  const cap = Math.max(1, Math.min(Number(limit) || 8, 25))
  const text = String(query ?? '').trim()
  if (!text) return { results: [], total: skills.length }
  const exact = skills.find((s) => s.name === text.toLowerCase())
  const ranked = rankWithBm25(text, skills.map((s) => ({ title: `${s.name.replace(/-/g, ' ')} ${s.name}`, abstract: s.description })))
  const order = []
  if (exact) order.push(exact)
  if (ranked.ok) {
    skills
      .map((skill, i) => ({ skill, score: ranked.scores[i] }))
      .filter((r) => r.score > 0 && r.skill !== exact)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .forEach((r) => order.push(r.skill))
  }
  if (order.length === 0) {
    const needle = text.toLowerCase()
    for (const s of skills) if (s.name.includes(needle)) order.push(s)
  }
  return {
    results: order.slice(0, cap).map((s) => ({ name: s.name, description: clip(s.description), in_catalog: core.has(s.name) })),
    total: skills.length,
  }
}

/** Instructions for one bundled skill, in the shape the host's `skill` tool returns. */
export function loadSkill(name, { dir = BUNDLED_SKILLS_DIR, env = process.env } = {}) {
  const wanted = String(name ?? '').trim()
  if (!NAME.test(wanted)) return { error: `invalid skill name "${wanted}"` }
  const skill = visible(bundledSkills(dir), env).find((s) => s.name === wanted)
  if (!skill) return { error: `skill "${wanted}" is unknown or not bundled; use skill_search to find the right name` }
  const raw = readFileSync(join(skill.path, 'SKILL.md'), 'utf8')
  const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart()
  return { name: skill.name, base_directory: skill.path, content }
}

/** The text the model sees for a loaded skill; mirrors the host's `<skill_content>` block. */
export function renderLoadedSkill(value) {
  const escaped = value.name.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  return [
    `<skill_content name="${escaped}">`,
    '<skill_resources>',
    `Base directory for this skill: ${value.base_directory}`,
    'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    value.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}
