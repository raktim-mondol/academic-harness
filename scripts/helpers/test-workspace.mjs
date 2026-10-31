import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Temporary workspace fixture shared by the newer tool tests. */
export function makeWorkspace(prefix = 'ah-test-') {
  const cwd = mkdtempSync(join(tmpdir(), prefix))
  const path = (rel) => join(cwd, rel)
  return {
    cwd,
    path,
    exists(rel) {
      return existsSync(path(rel))
    },
    write(rel, body) {
      const target = path(rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, body)
      return target
    },
    read(rel) {
      return readFileSync(path(rel), 'utf8')
    },
    cleanup() {
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

/** Minimal DSH execution context shape used by tool tests. */
export function fakeExec(cwd) {
  return { agent: { session: { header: { cwd } } } }
}
