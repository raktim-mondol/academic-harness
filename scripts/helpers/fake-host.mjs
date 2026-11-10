/**
 * Reusable fake DSH host for plugin listener tests.
 *
 * Records every `ctx.on(event, handler)` and `ctx.tools.register(tool)` call so
 * a test can drive a listener the way the host pipeline would, without booting
 * DSH. This is a test double: it proves the plugin answers the way it should,
 * not that a real host routes the answer (that needs the live harness).
 *
 *   const host = fakeHost({ services: { approval: fakeApproval(['allowed-once']) } })
 *   hooks.apply(host.ctx)
 *   const decision = await host.run('tools/pre-execute', { name: 'modal_run', arguments: {}, agent }, async () => ({ kind: 'allow' }))
 */

/** Minimal agent shape the plugin reads: session header, optional depth/parent/origin. */
export function fakeAgent({ cwd, id = 'fake-session', model = 'test-model', depth = 0, parent = null, origin } = {}) {
  const steered = []
  const agent = {
    id,
    depth,
    parent,
    origin,
    session: { header: { id, cwd, model, ...(origin ? { origin } : {}), ...(parent ? { parentSession: parent.session?.header?.id } : {}) } },
    steer(message) {
      steered.push(message)
    },
    steered,
  }
  return agent
}

/**
 * Fake approval service. `outcomes` are consumed in order; once exhausted the
 * last one repeats. Every request is kept in `requests` for assertions.
 */
export function fakeApproval(outcomes = ['allowed-once']) {
  const queue = [...outcomes]
  const requests = []
  return {
    requests,
    async request(req) {
      requests.push(req)
      // The real service resolves to the outcome string itself.
      return queue.length > 1 ? queue.shift() : queue[0]
    },
  }
}

export function fakeHost({ services = {}, extra = {} } = {}) {
  const handlers = new Map()
  const tools = new Map()
  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => {}
      },
    },
    get(name) {
      return services[name]
    },
    ...services,
    ...extra,
  }
  return {
    ctx,
    handlers,
    tools,
    /** First handler registered for an event. */
    handler(event) {
      const list = handlers.get(event)
      if (!list || list.length === 0) throw new Error(`no handler registered for ${event}`)
      return list[0]
    },
    /** Invoke the first handler for an event with the given arguments. */
    run(event, ...args) {
      return this.handler(event)(...args)
    },
  }
}

/**
 * Fake host job service (`ctx.jobs`): start / wait / kill with the same shapes the
 * plugin uses. `started` records every job (kind, label, owner, panel lines).
 */
export function fakeJobs() {
  const started = []
  const find = (id) => started.find((job) => job.id === id)
  return {
    started,
    start({ kind, label, owner, toolCall, run }) {
      const record = { id: `job-${started.length + 1}`, kind, label, owner, toolCall, lines: [], progress: [], status: 'running', outcome: null, killed: null }
      started.push(record)
      const job = {
        append: (text, options) => record.lines.push({ text: String(text), channel: options?.channel ?? null }),
        updateProgress: (label) => record.progress.push(label),
      }
      record.handle = run(job)
      record.handle.done.then((outcome) => {
        record.outcome = outcome
        record.status = outcome?.status ?? 'completed'
      })
      return record.id
    },
    async wait(id, timeoutMs, owner, signal) {
      const record = find(id)
      if (!record) throw new Error(`no job ${id}`)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, timeoutMs)
        const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')) }
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        record.handle.done.then(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve() })
      })
      return { status: record.status, detail: record.outcome?.detail }
    },
    kill(id, owner, reason) {
      const record = find(id)
      if (!record) return
      record.killed = reason
      record.handle.cancel(reason)
    },
  }
}
