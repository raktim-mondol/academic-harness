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
    session: { header: { id, cwd, model, ...(parent ? { parentSession: parent.session?.header?.id } : {}) } },
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
