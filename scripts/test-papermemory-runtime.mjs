import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
const work = mkdtempSync(join(tmpdir(), 'ah-pm-runtime-'))
const bin = join(work, 'papermemory')
process.env.DSH_HOME = join(work, 'dsh')
process.env.PAPERMEMORY_DB = join(work, 'pm.db')
process.env.PAPERMEMORY_SKIP_INSTALL = '1'
delete process.env.PAPERMEMORY_CLI
process.env.PATH = work

const { ensurePaperMemoryInstalled, resolvePaperMemoryLaunch } = await import('../papermemory-cli.js')
try {
  writeFileSync(bin, '#!/bin/sh\nprintf \'{"version":"0.3.1"}\\n\'\n')
  chmodSync(bin, 0o755)
  assert.equal(resolvePaperMemoryLaunch(), undefined, 'unvalidated PATH is never selected')
  assert.equal(await ensurePaperMemoryInstalled(), undefined, 'old PATH version must be rejected')
  assert.equal(resolvePaperMemoryLaunch(), undefined, 'failed validation must not be bypassed')

  writeFileSync(bin, `#!/bin/sh\nPYTHONPATH="${join(root, 'vendor', 'papermemory')}" exec "${python}" -m papermemory "$@"\n`)
  const launch = await ensurePaperMemoryInstalled()
  assert.equal(launch?.command, bin)
  assert.equal(launch?.readOnly, true)
  assert.equal(resolvePaperMemoryLaunch()?.command, bin)
  console.log('papermemory runtime fallback OK')
} finally {
  rmSync(work, { recursive: true, force: true })
}
