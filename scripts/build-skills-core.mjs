#!/usr/bin/env node
/**
 * Derive skills-core.json: the bundled skills the harness names explicitly.
 *
 *   node scripts/build-skills-core.mjs          write skills-core.json
 *   node scripts/build-skills-core.mjs --check  exit 1 when the file is stale
 *
 * A skill is "core" when the system prompt, a workflow prompt, the preset or a
 * root module names it (in backticks, or as skills/<name>), or a core skill
 * tells the model to load it (followed to a fixed point). Core skills are the
 * only bundled skills seeded into the host catalog (decision D39); every other
 * bundled skill is found with skill_search and read with skill_load. Add a
 * skill that must stay in the catalog without being named anywhere to EXTRA.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// The four office skills are rewritten clean-room (docx, pdf, pptx, xlsx) and widely used by hand (/docx, /pdf ...), so they stay in the catalogue.
const EXTRA = ['docx', 'pdf', 'pptx', 'xlsx']

export function deriveCore(root = ROOT) {
  const skills = new Set(readdirSync(join(root, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name))
  const core = new Set(EXTRA)
  const sources = ['prompt.js', 'workflows.json', 'presets/academic-harness/agent.cordis.yml']
  for (const file of sources) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const m of text.matchAll(/\\?`([a-z0-9][a-z0-9-]+)\\?`/g)) if (skills.has(m[1])) core.add(m[1])
  }
  for (const file of readdirSync(root).filter((f) => f.endsWith('.js') && f !== 'prompt.js')) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const m of text.matchAll(/skills\/([a-z0-9][a-z0-9-]+)/g)) if (skills.has(m[1])) core.add(m[1])
    for (const m of text.matchAll(/['"`]([a-z0-9][a-z0-9-]+)['"`]\s*[,\]]/g)) if (skills.has(m[1]) && /^(ah-|academic-harness)/.test(m[1])) core.add(m[1])
  }
  // A core skill that says "load `x`" must find x in the same catalogue.
  const queue = [...core]
  while (queue.length) {
    const name = queue.pop()
    const text = readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8')
    for (const m of text.matchAll(/(?:load|use|invoke|call|skill)[^\n`]{0,40}`([a-z0-9][a-z0-9-]+)`/gi)) {
      if (skills.has(m[1]) && !core.has(m[1])) {
        core.add(m[1])
        queue.push(m[1])
      }
    }
  }
  return [...core].sort()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = join(ROOT, 'skills-core.json')
  const next = `${JSON.stringify(deriveCore(), null, 2)}\n`
  if (process.argv.includes('--check')) {
    let current = ''
    try { current = readFileSync(path, 'utf8') } catch { /* missing */ }
    if (current !== next) {
      console.error('skills-core.json is stale: run node scripts/build-skills-core.mjs')
      process.exit(1)
    }
    console.log('skills-core.json is current')
  } else {
    writeFileSync(path, next)
    console.log(`skills-core.json: ${JSON.parse(next).length} core skills`)
  }
}
