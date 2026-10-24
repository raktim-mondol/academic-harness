/**
 * The lock shared by the append-only `.dsh` ledgers (`review-store.js`,
 * `coscientist-store.js`). Subagents write concurrently, so every ledger needs
 * the same mutual exclusion; two divergent lock implementations would be worse
 * than either.
 *
 * `mkdir` is the atomic primitive: it fails with EEXIST when another writer
 * holds the lock, and it needs no lock file created beforehand. A lock older
 * than `staleMs` is presumed to belong to a dead process and is stolen —
 * without that, a crashed writer would wedge the ledger permanently.
 */
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STALE_MS = 60_000
const GIVE_UP_MS = 10_000
const POLL_MS = 25

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `fn` while holding `<dir>/.lock`. `label` names the ledger in the busy
 * error so a retry message says which one.
 */
export async function withLock(dir, fn, { label = 'ledger', staleMs = STALE_MS, giveUpMs = GIVE_UP_MS } = {}) {
  const lock = join(dir, '.lock')
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      try {
        return await fn()
      } finally {
        rmSync(lock, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
      } catch {
        // lock disappeared between checks; retry
      }
      if (Date.now() - started > giveUpMs) throw new Error(`${label} is busy; retry the operation`)
      await sleep(POLL_MS)
    }
  }
}

/** Write `file` through a sibling temp rename, so a reader never sees a partial write. */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
  return file
}
