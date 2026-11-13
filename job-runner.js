/**
 * Run long work as an owned host job (the Web UI's jobs panel), so the chat stays
 * responsive, progress is visible while it works, and an abort or a kill from the
 * panel actually stops the work in flight.
 *
 * With no jobs service the same work runs inline on the call's own signal. With
 * one, the tool call still waits for the job and returns the work's value with
 * `job_id` added, so the model-facing result is the same either way.
 *
 * Extracted from two near-identical copies in deep-research.js and deep-review.js.
 */

/**
 * @param ctx   plugin context; `ctx.jobs` is the host job service when present
 * @param exec  the tool call (`signal`, `callId`, `rootCallId`, `agent.id`)
 * @param opts  { kind, label, timeoutMs, noun, resumeHint, resultClip }
 *              `noun` names the work in messages ("deep research"); `resumeHint` is appended to
 *              the timed-out / cancelled messages; `resultClip` limits the stored job result text;
 *              `detailFromStatus: false` always reports the detail as "completed".
 * @param work  async (job, signal) => value; `job` is null when there is no jobs service
 */
export async function runAsJob(ctx, exec, { kind, label, timeoutMs, noun = 'job', resumeHint = '', resultClip = Infinity, detailFromStatus = true }, work) {
  const jobs = ctx?.jobs
  if (!jobs) return work(null, exec?.signal ?? null)
  const owner = exec?.agent?.id
  const controller = new AbortController()
  const onAbort = () => controller.abort('tool call aborted')
  if (exec?.signal?.aborted) controller.abort('tool call aborted')
  else exec?.signal?.addEventListener?.('abort', onAbort, { once: true })

  let resolveResult
  let rejectResult
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  resultPromise.catch(() => {})
  let settleOutcome
  const done = new Promise((resolve) => {
    settleOutcome = resolve
  })

  let jobId
  try {
    jobId = jobs.start({
      kind,
      label,
      ...(owner ? { owner } : {}),
      toolCall: { callId: exec?.callId, rootCallId: exec?.rootCallId },
      run: (job) => {
        void (async () => {
          let outcome
          try {
            const value = await work(job, controller.signal)
            resolveResult(value)
            const text = JSON.stringify(value)
            outcome = { status: 'completed', detail: detailFromStatus ? (value?.status ?? 'completed') : 'completed', result: Number.isFinite(resultClip) ? text?.slice(0, resultClip) : text }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            rejectResult(error)
            outcome = { status: controller.signal.aborted ? 'killed' : 'failed', detail: message }
          } finally {
            exec?.signal?.removeEventListener?.('abort', onAbort)
            settleOutcome(outcome)
          }
        })()
        return { done, cancel: (reason) => controller.abort(reason || 'cancelled') }
      },
    })
  } catch (error) {
    exec?.signal?.removeEventListener?.('abort', onAbort)
    throw error
  }

  try {
    let view
    try {
      view = await jobs.wait(jobId, timeoutMs, owner, exec?.signal)
    } catch (error) {
      try { jobs.kill(jobId, owner, 'tool call aborted') } catch { /* already settled */ }
      throw error
    }
    if (view.status === 'running' || view.status === 'stopping') {
      try { jobs.kill(jobId, owner, `${noun} timed out`) } catch { /* already settled */ }
      try { await jobs.wait(jobId, 10_000, owner) } catch { /* already gone */ }
      throw new Error(`${noun} timed out after ${Math.round(timeoutMs / 60_000)} minutes${resumeHint}`)
    }
    if (view.status === 'killed') {
      throw new Error(`${noun} cancelled${view.detail ? `: ${view.detail}` : ''}${resumeHint}`)
    }
    const value = await resultPromise
    return { ...value, job_id: jobId }
  } finally {
    exec?.signal?.removeEventListener?.('abort', onAbort)
  }
}
