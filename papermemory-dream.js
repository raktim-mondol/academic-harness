/**
 * PaperMemory "dreaming" at session end.
 *
 * Claims are checked when they are written; the free-text notes around them
 * (observations, lessons) are not, so copies pile up and notes outlive the
 * files they came from. `papermemory dream` consolidates them offline. This
 * module runs it when an agent is disposed, off the model's attention, at most
 * once an hour, on the plugin-managed CLI only.
 *
 *   PAPERMEMORY_DREAM=apply   (default) consolidate. Status flips only, nothing is
 *                             deleted, every change is a SWEEP event, and
 *                             `papermemory dream --restore NOTE_ID` undoes one.
 *   PAPERMEMORY_DREAM=report  dry run: write the report to the log, change nothing.
 *   PAPERMEMORY_DREAM=off     do nothing.
 *
 * Each run appends one line to $DSH_HOME/papermemory/dream-log.jsonl.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bundledInstallDir,
  cliArgs,
  LOG,
  papermemoryEnv,
  resolvePaperMemoryLaunch,
  run,
} from './papermemory-cli.js'

export const name = 'academic-harness-papermemory-dream'
// Same as papermemory.js: registers into the host only; no injected services.
export const inject = []

export const MIN_INTERVAL_MS = 60 * 60 * 1000
export const DREAM_TIMEOUT_MS = 30_000

/** An unreadable value reports rather than changes anything. */
export function dreamMode(env = process.env) {
  const raw = String(env.PAPERMEMORY_DREAM ?? 'apply').trim().toLowerCase()
  return ['off', 'report', 'apply'].includes(raw) ? raw : 'report'
}

export function dreamDue({ stampPath, now = Date.now(), minIntervalMs = MIN_INTERVAL_MS }) {
  try {
    const last = Number(readFileSync(stampPath, 'utf8').trim())
    return !Number.isFinite(last) || now - last >= minIntervalMs
  } catch {
    return true
  }
}

export function parseDreamSummary(stdout) {
  const text = String(stdout || '')
  const i = text.indexOf('{')
  if (i < 0) return null
  try {
    const report = JSON.parse(text.slice(i))
    return report && typeof report.summary === 'object' ? { applied: Boolean(report.applied), ...report.summary } : null
  } catch {
    return null
  }
}

function changed(summary) {
  return Boolean(summary && (summary.duplicates || summary.stale || summary.recovered_claims))
}

/**
 * One dream pass. Never throws. `runner`, `launch` and `env` are injectable for tests.
 * Returns { status: 'skipped' | 'ran' | 'failed', reason?, summary? }.
 */
export async function dreamOnce({
  mode = dreamMode(),
  now = Date.now(),
  stateDir = bundledInstallDir(),
  launch = resolvePaperMemoryLaunch(),
  env = papermemoryEnv(),
  runner = run,
  minIntervalMs = MIN_INTERVAL_MS,
  timeoutMs = DREAM_TIMEOUT_MS,
} = {}) {
  if (mode === 'off') return { status: 'skipped', reason: 'off' }
  // A CLI picked up from PATH may be older than the vendored one and is marked read-only.
  if (!launch || launch.readOnly) return { status: 'skipped', reason: 'no-managed-cli' }
  const stampPath = join(stateDir, 'dream-stamp')
  if (!dreamDue({ stampPath, now, minIntervalMs })) return { status: 'skipped', reason: 'ran-recently' }

  const args = cliArgs(launch, ['dream', ...(mode === 'apply' ? ['--apply'] : []), '--json'])
  const result = await runner(launch.command, args, { timeoutMs, env, silent: true })
  const summary = result.code === 0 ? parseDreamSummary(result.out) : null
  if (!summary) {
    // exit 2 is argparse rejecting `dream`: an older CLI. Anything else (locked database,
    // timeout) is retried at the next disposal because no stamp is written.
    const reason = result.code === 2 ? 'cli-too-old' : result.code === 124 ? 'timeout' : 'error'
    return { status: result.code === 2 ? 'skipped' : 'failed', reason, detail: String(result.err || '').slice(0, 200) }
  }
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(stampPath, String(now))
    appendFileSync(join(stateDir, 'dream-log.jsonl'), `${JSON.stringify({ at: new Date(now).toISOString(), mode, ...summary })}\n`)
  } catch (error) {
    console.warn(`${LOG}: dream ran but its log could not be written: ${error?.message || error}`)
  }
  return { status: 'ran', summary }
}

let inFlight = null

export function apply(ctx) {
  ctx.on('agent/disposed', async () => {
    // Subagents are disposed too; one pass at a time, and the hourly stamp does the rest.
    if (inFlight) return
    inFlight = dreamOnce()
      .then((outcome) => {
        if (outcome.status === 'ran' && changed(outcome.summary)) {
          const s = outcome.summary
          console.log(`${LOG}: dream ${s.applied ? 'applied' : 'found'} ${s.duplicates} duplicate and ${s.stale} stale notes, `
            + `${s.recovered_claims} claims recovered (${s.claims_awaiting_markdown} still waiting on markdown)`)
        } else if (outcome.status === 'failed') {
          console.warn(`${LOG}: dream ${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''}`)
        }
      })
      .catch((error) => console.warn(`${LOG}: dream failed: ${error?.message || error}`))
      .finally(() => { inFlight = null })
    await inFlight
  })
}

