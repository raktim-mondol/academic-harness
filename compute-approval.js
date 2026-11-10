/**
 * Approval text for the paid-compute tools (modal_run, runpod_run, vastai_run).
 *
 * The plugin asks the user before any of these provisions rented hardware. The
 * reason shown with the prompt carries the provider, instance, maximum run time
 * and a cost ceiling, so the person approving sees what they are agreeing to.
 * Estimates come from the same instance catalogs the run tools use; Vast.ai is
 * a marketplace, so its price is only known when the caller sets a ceiling.
 */
import { DEFAULT_MODAL_INSTANCE_ID, resolveModalInstance } from './modal-instances.js'
import { DEFAULT_RUNPOD_INSTANCE_ID, resolveRunpodInstance } from './runpod-instances.js'
import { DEFAULT_VASTAI_INSTANCE_ID, resolveVastaiInstance } from './vastai-instances.js'

export const PAID_COMPUTE_TOOLS = new Set(['modal_run', 'runpod_run', 'vastai_run'])

const DEFAULT_TIMEOUT_S = 600
const MAX_TIMEOUT_S = 3600
const COMMAND_PREVIEW_CHARS = 300

function clampTimeout(value) {
  const n = Number(value ?? DEFAULT_TIMEOUT_S)
  const secs = Number.isFinite(n) ? Math.floor(n) : DEFAULT_TIMEOUT_S
  return Math.min(Math.max(secs, 1), MAX_TIMEOUT_S)
}

function money(value) {
  return `$${value.toFixed(2)}`
}

/**
 * Describe one paid-compute call. Returns plain data so tests (and a later
 * spend-cap check) can reuse the same numbers:
 * `{ provider, instance, timeoutS, pricePerHour, maxUsd, priceNote }`.
 * `pricePerHour` is null when it cannot be known before provisioning.
 */
export function describeComputeCall(name, args = {}) {
  const timeoutS = clampTimeout(args.timeout_sec)
  const hours = timeoutS / 3600
  if (name === 'modal_run') {
    const id = args.instance ?? DEFAULT_MODAL_INSTANCE_ID
    const spec = resolveModalInstance(id)
    return finish('Modal', id, timeoutS, spec?.pricePerHour ?? null, hours, spec ? null : 'unknown instance, price unknown')
  }
  if (name === 'runpod_run') {
    const id = args.instance ?? DEFAULT_RUNPOD_INSTANCE_ID
    const spec = resolveRunpodInstance(id)
    return finish('Runpod', id, timeoutS, spec?.pricePerHour ?? null, hours, spec ? null : 'unknown instance, price unknown')
  }
  if (name === 'vastai_run') {
    const id = args.instance ?? DEFAULT_VASTAI_INSTANCE_ID
    resolveVastaiInstance(id)
    const pinned = args.offer_id != null
    const bid = Number(args.bid_price)
    const ceiling = Number(args.max_price_dph)
    if (!pinned && Number.isFinite(bid) && bid > 0) {
      return finish('Vast.ai', id, timeoutS, bid, hours, `interruptible bid of ${money(bid)}/h`)
    }
    if (!pinned && Number.isFinite(ceiling) && ceiling > 0) {
      return finish('Vast.ai', id, timeoutS, ceiling, hours, `marketplace price, capped at ${money(ceiling)}/h`)
    }
    return finish(
      'Vast.ai',
      id,
      timeoutS,
      null,
      hours,
      pinned
        ? `pinned offer ${args.offer_id}: its price is not checked before renting, so no ceiling applies`
        : 'marketplace price is chosen at rental time and no ceiling was set',
    )
  }
  return null
}

function finish(provider, instance, timeoutS, pricePerHour, hours, priceNote) {
  return {
    provider,
    instance,
    timeoutS,
    pricePerHour,
    maxUsd: pricePerHour == null ? null : pricePerHour * hours,
    priceNote: priceNote ?? null,
  }
}

/** One sentence about the session budget for the approval prompt. `budget` comes from describeSessionBudget(). */
function budgetSentence(budget) {
  if (!budget) return null
  const parts = []
  if (budget.cap == null) {
    parts.push(`No session spend cap is set (spent or reserved so far: ${money(budget.spent)}).`)
  } else {
    const projected = budget.estUsd == null ? null : budget.spent + budget.estUsd
    parts.push(`Session spend so far: ${money(budget.spent)} of a ${money(budget.cap)} session cap (estimates for unfinished runs included)${projected == null ? '' : `; this run could bring it to ${money(projected)}`}.`)
  }
  if (budget.unpriced > 0) parts.push(`${budget.unpriced} earlier run(s) had no known price and are not counted.`)
  return parts.join(' ')
}

/** Human-readable reason for the approval prompt. Null for non-compute tools. */
export function computeApprovalReason(name, args = {}, budget = null) {
  const info = describeComputeCall(name, args)
  if (!info) return null
  const parts = [`${info.provider} will rent paid hardware: instance "${info.instance}", up to ${info.timeoutS}s of command time plus provisioning.`]
  if (info.maxUsd != null) {
    parts.push(`Estimated ceiling for the run: ${money(info.maxUsd)} (${money(info.pricePerHour)}/h${info.priceNote ? `, ${info.priceNote}` : ''}).`)
  } else {
    parts.push(`Cost cannot be estimated up front: ${info.priceNote}.`)
  }
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (command) {
    const preview = command.length > COMMAND_PREVIEW_CHARS ? `${command.slice(0, COMMAND_PREVIEW_CHARS)}…` : command
    parts.push(`Command: ${preview}`)
  }
  const budgetLine = budgetSentence(budget)
  if (budgetLine) parts.push(budgetLine)
  parts.push('Confirm to start the run.')
  return parts.join(' ')
}
