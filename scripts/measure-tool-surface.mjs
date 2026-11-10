#!/usr/bin/env node
/**
 * How much of the model's tool schema budget each Academic Harness tool takes
 * (decision D40). Loads every plugin module with a recording context and sums
 * the wire size of each registered definition: name, description and parameters.
 *
 *   node scripts/measure-tool-surface.mjs [--top N] [--json]
 *
 * The number to watch is the total: it is resent on every step. A tool marked
 * `deferLoading` would leave that total, but only where the host can activate
 * it again (docs/DEFERRED-TOOLS.md says why nothing is deferred yet).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// index.js's apply() seeds skills and patches profiles under $DSH_HOME, and a few
// modules start managed installs on first use. Loading the plugin to count its
// tools must do none of that: point DSH_HOME at a scratch directory (under the
// cache, not the quota-limited tmpfs) and switch every installer off.
import { homedir } from 'node:os'
const scratchRoot = process.env.AH_TEST_HOME_ROOT || join(homedir(), '.cache', 'ah-test-homes')
mkdirSync(scratchRoot, { recursive: true })
const scratchHome = mkdtempSync(join(scratchRoot, 'measure-'))
process.env.DSH_HOME = scratchHome
for (const flag of ['ACADEMIC_HARNESS_SKIP_INSTALL', 'ACADEMIC_HARNESS_MODAL_SKIP_INSTALL', 'TEXTFOLD_SKIP_INSTALL', 'PAPERMEMORY_SKIP_INSTALL', 'ZVEC_GREP_SKIP_INSTALL']) process.env[flag] = '1'
process.on('exit', () => rmSync(scratchHome, { recursive: true, force: true }))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const topArg = process.argv.indexOf('--top')
const TOP = topArg === -1 ? 25 : Number(process.argv[topArg + 1])

/** A context that accepts any service access and records tool registrations. */
function recordingContext(sink) {
  const callable = new Proxy(function noop() {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : callable),
    apply: () => callable,
  })
  const tools = {
    register(definition) {
      sink.push(definition)
      return () => {}
    },
  }
  return new Proxy({}, { get: (_t, prop) => (prop === 'tools' ? tools : callable) })
}

export async function collectToolDefinitions() {
  const preset = readFileSync(join(ROOT, 'presets/academic-harness/agent.cordis.yml'), 'utf8')
  const exportsMap = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).exports
  const modules = new Set(['./index.js'])
  for (const m of preset.matchAll(/name:\s*academic-harness\/([a-z0-9-]+)/g)) modules.add(exportsMap[`./${m[1]}`] ?? `./${m[1]}.js`)
  const found = []
  const skipped = []
  for (const file of modules) {
    const sink = []
    try {
      const mod = await import(pathToFileURL(join(ROOT, file)).href)
      const apply = mod.apply ?? mod.default?.apply
      if (typeof apply === 'function') await apply(recordingContext(sink), {})
    } catch (error) {
      skipped.push(`${file}: ${error.message.split('\n')[0]}`)
    }
    for (const definition of sink) found.push({ module: file.slice(2), definition })
  }
  return { found, skipped }
}

export function wireSize(definition) {
  return JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters ?? {} }).length
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { found, skipped } = await collectToolDefinitions()
  const rows = found
    .map(({ module, definition }) => ({ tool: definition.name, module, chars: wireSize(definition), deferred: definition.deferLoading === true }))
    .sort((a, b) => b.chars - a.chars)
  const total = rows.reduce((n, r) => n + r.chars, 0)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ tools: rows.length, total_chars: total, top: rows.slice(0, TOP), skipped }, null, 2))
  } else {
    console.log(`${rows.length} tools, ${total} characters of tool schema (about ${Math.round(total / 4)} tokens) resent on every step`)
    for (const r of rows.slice(0, TOP)) console.log(`${String(r.chars).padStart(7)}  ${(100 * r.chars / total).toFixed(1).padStart(5)}%  ${r.tool}${r.deferred ? '  [deferred]' : ''}`)
    if (skipped.length) console.log(`\nnot measured (${skipped.length}): ${skipped.slice(0, 5).join('; ')}`)
  }
}
