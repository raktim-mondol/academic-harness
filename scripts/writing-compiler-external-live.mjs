/** Opt-in real external audits on copied projects. Never run in an original manuscript. */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runExternal } from '../external-bridge.js'

const [manifest, output] = process.argv.slice(2)
if (!manifest || !output) throw new Error('usage: node scripts/writing-compiler-external-live.mjs RESULTS_JSON OUTPUT_JSON')
const engine = resolve(fileURLToPath(new URL('../vendor/academic-harness', import.meta.url)))
const rows = JSON.parse(readFileSync(manifest, 'utf8'))
const results = []
for (const row of rows) {
  if (row.error) continue
  const root = row.copy
  if (!root.startsWith('/tmp/opencode/')) throw new Error('refusing a non-scratch project')
  const planRun = spawnSync('python3', ['-m', 'ah', 'external', 'plan', '--project', root], {
    encoding: 'utf8', env: { ...process.env, PYTHONPATH: engine },
  })
  if (planRun.status !== 0) throw new Error(planRun.stderr)
  const started = Date.now()
  const result = await runExternal({ root, plan: JSON.parse(planRun.stdout), tools: row.tools || ['numbers_audit'],
    exec: { agent: { session: { header: { cwd: root } } } }, args: { grim: true } })
  results.push({ copy: root, ...result, seconds: (Date.now() - started) / 1000 })
  writeFileSync(output, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results.at(-1)))
}
