/**
 * Spend ledger and per-session cap for the paid-compute tools (decisions D26,
 * D28; review A7).
 *
 * `modal_run`, `runpod_run` and `vastai_run` rent hardware that bills by the
 * hour. Every run writes an intent to one append-only ledger BEFORE anything is
 * rented, under a lock, so two sub-agents cannot both pass a cap only one fits
 * under. When the run ends, whatever happened, it writes a settlement with the
 * actual cost. A session's spend is the sum of its runs' settled costs, plus the
 * estimated ceiling of any run that has not settled (a crash keeps counting).
 *
 *   $DSH_HOME/compute-ledger/spend.jsonl      one file for all providers and workspaces
 *
 * The cap is per ROOT session (a sub-agent shares its parent's budget). Default
 * USD 10; set COMPUTE_SESSION_CAP_USD in Settings or the environment, or "off".
 *
 * What it does not do: a run whose price cannot be known before it starts (a
 * Vast.ai marketplace rental with no `max_price_dph`, or a pinned `offer_id`) is
 * recorded as unpriced and cannot be refused up front; it is counted at its actual
 * cost once it ends. Price caps per provider are a separate, later decision (D27).
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { describeComputeCall } from './compute-approval.js'
import { resolveEnv } from './credential-env.js'
import { sessionKey } from './notebook.js'
import { withLock } from './store-lock.js'

export const DEFAULT_SESSION_CAP_USD = 10
/** Seconds added to the command time when estimating a ceiling: provisioning, file transfer and teardown are billed too. */
export const PROVISION_ALLOWANCE_S = 600

const money = (value) => Math.round(value * 10_000) / 10_000
const EPSILON = 1e-9

export function ledgerFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'compute-ledger', 'spend.jsonl')
}

// ── the cap ──────────────────────────────────────────────────────────────────

/** Parse the COMPUTE_SESSION_CAP_USD value. `cap: null` means no cap. Bad values fall back to the default and say so. */
export function parseSessionCap(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { cap: DEFAULT_SESSION_CAP_USD }
  const text = String(raw).trim()
  if (/^(off|none|unlimited)$/i.test(text)) return { cap: null }
  const value = Number(text)
  if (Number.isFinite(value) && value >= 0) return { cap: value }
  return {
    cap: DEFAULT_SESSION_CAP_USD,
    warning: `COMPUTE_SESSION_CAP_USD="${text}" is not a non-negative number or "off"; using the default of $${DEFAULT_SESSION_CAP_USD}.`,
  }
}

let warnedAboutCap = false
export async function resolveSessionCap() {
  const { cap, warning } = parseSessionCap(await resolveEnv('COMPUTE_SESSION_CAP_USD'))
  if (warning && !warnedAboutCap) {
    warnedAboutCap = true
    console.warn(`[academic-harness] compute: ${warning}`)
  }
  return cap
}

/** Conservative ceiling for one run, rounded UP to the cent. Null when the price is not known. */
export function estimateRunUsd({ pricePerHour, timeoutS }) {
  if (pricePerHour == null || !Number.isFinite(Number(pricePerHour))) return null
  const raw = Math.round(((Number(pricePerHour) * (Number(timeoutS) + PROVISION_ALLOWANCE_S)) / 3600) * 1e6) / 1e6
  return Math.max(0, Math.ceil(raw * 100 - EPSILON) / 100)
}

// ── reading ──────────────────────────────────────────────────────────────────

/** Read the ledger tolerantly: a damaged line is counted and skipped, never fatal and never a reason to lose the cap. */
function readLedger(file = ledgerFile()) {
  if (!existsSync(file)) return { rows: [], skipped: 0 }
  const rows = []
  let skipped = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object') rows.push(row)
      else skipped += 1
    } catch {
      skipped += 1
    }
  }
  return { rows, skipped }
}

/** { spent, unpriced, runs, skipped } for one root session. */
export function sessionSpend(rootSession, { file = ledgerFile() } = {}) {
  const { rows, skipped } = readLedger(file)
  const settled = new Map()
  for (const row of rows) if (row.kind === 'settled' && !settled.has(row.id)) settled.set(row.id, row)
  let spent = 0
  let unpriced = 0
  let runs = 0
  for (const row of rows) {
    if (row.kind !== 'intent' || row.root_session !== rootSession) continue
    runs += 1
    const done = settled.get(row.id)
    const actual = done && typeof done.actual_usd === 'number' ? done.actual_usd : null
    const estimate = typeof row.est_usd === 'number' ? row.est_usd : null
    const counted = actual ?? estimate
    if (counted == null) unpriced += 1
    else spent += counted
  }
  return { spent: money(spent), unpriced, runs, skipped }
}

// ── reserving and settling ───────────────────────────────────────────────────

/**
 * Check the cap and, if the run fits, record its intent, in one locked step.
 * `estUsd: null` (price unknown) never blocks. Returns { ok: true, id, spentBefore, cap, estUsd }
 * or { ok: false, spent, cap, estUsd, remaining } and writes nothing.
 */
export async function reserveSpend({ file = ledgerFile(), rootSession, session, tool, provider, instance, estUsd, capUsd, timeoutS, note }) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const estimate = estUsd == null ? null : money(estUsd)
  return withLock(dir, async () => {
    const { spent } = sessionSpend(rootSession, { file })
    if (capUsd != null && estimate != null && spent + estimate > capUsd + EPSILON) {
      return { ok: false, spent, cap: capUsd, estUsd: estimate, remaining: money(Math.max(0, capUsd - spent)) }
    }
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    appendFileSync(file, `${JSON.stringify({
      kind: 'intent', id, ts: new Date().toISOString(), root_session: rootSession, session: session ?? rootSession,
      tool, provider, instance, est_usd: estimate, timeout_s: timeoutS ?? null, cap_usd: capUsd ?? null, ...(note ? { note } : {}),
    })}\n`)
    return { ok: true, id, spentBefore: spent, cap: capUsd ?? null, estUsd: estimate }
  }, { label: 'compute spend ledger' })
}

/** Record how a run ended. The first settlement for an id is the one that counts. */
export async function settleSpend({ file = ledgerFile(), id, rootSession, actualUsd, status, durationS, note }) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify({
    kind: 'settled', id, ts: new Date().toISOString(), ...(rootSession ? { root_session: rootSession } : {}),
    actual_usd: actualUsd == null ? null : money(actualUsd), status, duration_s: durationS == null ? null : Math.round(durationS), ...(note ? { note } : {}),
  })}\n`)
}

// ── what the tools call ──────────────────────────────────────────────────────

export function refusalText({ provider, estUsd, spent, cap, remaining }) {
  return `Session spend cap reached: this ${provider} run could cost up to $${estUsd.toFixed(2)} (its time limit plus ${PROVISION_ALLOWANCE_S / 60} minutes for provisioning and transfers), `
    + `but this session has already spent or reserved $${spent.toFixed(2)} of its $${cap.toFixed(2)} cap (remaining $${remaining.toFixed(2)}). `
    + 'Nothing was rented. Lower timeout_sec or pick a cheaper instance, or raise the cap with COMPUTE_SESSION_CAP_USD in Settings (Academic Harness API keys) or the environment; "off" removes it.'
}

/**
 * Where the session stands before a paid run starts: for the approval prompt and the up-front refusal.
 * Reads the ledger only; reserves nothing.
 */
export async function describeSessionBudget(exec, name, args) {
  const info = describeComputeCall(name, args)
  if (!info) return null
  const cap = await resolveSessionCap()
  const { spent, unpriced } = sessionSpend(sessionKey(exec))
  const estUsd = estimateRunUsd({ pricePerHour: info.pricePerHour, timeoutS: info.timeoutS })
  const wouldExceed = cap != null && estUsd != null && spent + estUsd > cap + EPSILON
  return { provider: info.provider, spent, unpriced, cap, estUsd, wouldExceed, remaining: cap == null ? null : money(Math.max(0, cap - spent)) }
}

/**
 * Reserve budget for one paid run. Returns { refused } (a tool result to hand back, nothing rented)
 * or { reservation } to pass to endPaidRun. `capUsd` and `rootSession` default to the setting and the session tree.
 */
export async function beginPaidRun(exec, { tool, provider, instance, pricePerHour, timeoutS, capUsd, rootSession }) {
  const cap = capUsd === undefined ? await resolveSessionCap() : capUsd
  const root = rootSession ?? sessionKey(exec)
  const estUsd = estimateRunUsd({ pricePerHour, timeoutS })
  const file = ledgerFile()
  const result = await reserveSpend({ file, rootSession: root, session: exec?.agent?.session?.header?.id, tool, provider, instance, estUsd, capUsd: cap, timeoutS })
  if (!result.ok) {
    return {
      refused: {
        error: 'spend_cap_exceeded',
        text: refusalText({ provider, estUsd: result.estUsd, spent: result.spent, cap: result.cap, remaining: result.remaining }),
        spend: { estimated_max_usd: result.estUsd, session_spent_usd: result.spent, session_cap_usd: result.cap, ledger: file },
      },
    }
  }
  return {
    reservation: {
      id: result.id, file, rootSession: root, provider, tool, instance, pricePerHour, estUsd,
      startedAt: Date.now(),
      spend: { estimated_max_usd: estUsd, session_spent_usd: result.spentBefore, session_cap_usd: cap, ledger: file, ...(estUsd == null ? { price_known: false } : {}) },
    },
  }
}

export async function endPaidRun(reservation, { costUsd, status, durationMs }) {
  try {
    await settleSpend({
      file: reservation.file, id: reservation.id, rootSession: reservation.rootSession,
      actualUsd: costUsd, status, durationS: durationMs == null ? null : durationMs / 1000,
    })
  } catch (error) {
    console.warn(`[academic-harness] compute: could not settle spend ledger entry ${reservation.id}: ${error?.message || error}`)
  }
}

/** Result errors that mean nothing was rented, so the reservation costs nothing. */
const NOTHING_RENTED = new Set([
  'aborted', 'not_configured', 'unknown_instance', 'invalid_package', 'invalid_path', 'invalid_ssh_key', 'sdk_missing', 'sdk_install_failed',
])

/**
 * Run a paid tool under the spend cap: reserve, run, settle, and attach a `spend` block to the result.
 * `run` does the real work. The settlement is written whatever happens, including a thrown error.
 */
export async function withSpendGuard({ tool, provider, args, exec, run }) {
  const info = describeComputeCall(tool, args)
  if (!info) return run()
  const begun = await beginPaidRun(exec, { tool, provider, instance: info.instance, pricePerHour: info.pricePerHour, timeoutS: info.timeoutS })
  if (begun.refused) return begun.refused
  const { reservation } = begun
  const started = Date.now()
  let result
  let thrown = null
  try {
    result = await run()
  } catch (error) {
    thrown = error
  }
  const elapsedMs = Date.now() - started
  const failed = thrown || result?.error
  const status = !failed ? 'ok' : thrown ? 'failed' : NOTHING_RENTED.has(result.error) ? 'not_started' : 'failed'
  let actual = null
  if (status === 'not_started') actual = 0
  else if (typeof result?.cost_usd === 'number') actual = result.cost_usd
  else if (status === 'failed' && reservation.pricePerHour != null) {
    const accrued = (reservation.pricePerHour * elapsedMs) / 3_600_000
    actual = Math.min(accrued, reservation.estUsd ?? accrued)
  }
  await endPaidRun(reservation, { costUsd: actual, status, durationMs: elapsedMs })
  if (thrown) throw thrown
  if (result && typeof result === 'object') {
    return { ...result, spend: { ...reservation.spend, actual_usd: actual == null ? null : money(actual) } }
  }
  return result
}

/** Wrap a registered tool so every call goes through withSpendGuard. */
export function guardSpend(tool, provider) {
  return {
    ...tool,
    execute: (args, exec) => withSpendGuard({ tool: tool.name, provider, args, exec, run: () => tool.execute(args, exec) }),
  }
}
