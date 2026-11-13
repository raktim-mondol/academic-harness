/** Browser-only fixture: production task plugin and views with a deterministic DSH input/command adapter. */
import { createElement as h, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTaskModes } from '../../client/task-modes.js'

function observable(value) {
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(next) { value = next; for (const listener of listeners) listener() },
  }
}
const sessions = new Map()
const entries = []
const dictionaries = {}
const submissions = []
const screen = observable({ sessionId: 'one', plan: false, fail: false })
let source
const translate = (key) => dictionaries.en?.[key] ?? key

function session(id) {
  if (sessions.has(id)) return sessions.get(id)
  const state = observable({ phase: 'plain', draft: '', draftRev: 0 })
  const input = { state, focus: () => document.querySelector('textarea')?.focus() }
  const actx = {
    input, effect: (fn) => fn(),
    bail(event, payload) {
      const current = state.getSnapshot()
      if (event === 'slash/input-begin-command') {
        if (payload.span.draftRev !== current.draftRev) return undefined
        state.set({ ...current, claim: payload.claim, phase: 'claimed' })
      } else if (event === 'slash/input-consume-token') {
        state.set({ ...current, claim: undefined, phase: 'plain' })
      }
      return true
    },
  }
  const value = { state, input, actx, faces: new Map() }
  sessions.set(id, value)
  return value
}

const ctx = {
  effect: (fn) => fn(),
  locale: { bind: () => translate, register: (_ns, dicts) => { Object.assign(dictionaries, dicts); return () => {} } },
  sessions: { scope: (id) => session(id).actx },
  conversation: { input: { for: (actx) => actx.input } },
  inputTriggers: { registerSource: (value) => { source = value; return () => {} } },
  slots: { inject: (_name, fn) => fn(), register: (options, component) => { entries.push({ options, component }); return () => {} } },
  remote: { commands: {
    list: async () => ({ ok: true, value: [{ name: 'academic-task' }] }),
    execute: async (id, line) => {
      submissions.push({ sessionId: id, request: JSON.parse(line.slice(line.indexOf(' ') + 1)) })
      return { ok: true, value: { result: screen.getSnapshot().fail ? { kind: 'error', text: 'Choose an explicit effort; nothing has run.' } : { kind: 'success', text: 'Research task accepted' } } }
    },
  } },
}
applyTaskModes(ctx)

function hook(source, selector) {
  return selector(useSyncExternalStore(source.subscribe, source.getSnapshot))
}

function Fixture() {
  const selected = useSyncExternalStore(screen.subscribe, screen.getSnapshot)
  const current = session(selected.sessionId)
  const input = useSyncExternalStore(current.state.subscribe, current.state.getSnapshot)
  const [notice, setNotice] = useState('')
  async function send(event) {
    event.preventDefault()
    setNotice('')
    let claim = input.claim
    if (!claim && input.draft.startsWith('/research ')) claim = (await source.matchEnter({ sessionId: selected.sessionId }, input.draft, null, {}))?.claim
    if (!claim) {
      setNotice(`Chat: ${input.draft}`)
      current.state.set({ ...input, draft: '', draftRev: input.draftRev + 1 })
      return
    }
    current.state.set({ ...input, phase: 'submitting' })
    const result = await claim.submit(input.draft.replace(/^\/research /u, ''), current.actx, [])
    if (result.kind === 'error') {
      current.state.set({ ...input, claim, phase: 'claimed' })
      setNotice(result.text)
    } else {
      current.state.set({ ...input, draft: '', claim: undefined, phase: 'plain', draftRev: input.draftRev + 1 })
      setNotice('Research task accepted')
    }
  }
  return h('main', { style: { maxWidth: 720, margin: '30px auto', padding: 16, fontFamily: 'sans-serif' } }, [
    h('h1', { key: 'title' }, 'Academic Harness task selector'),
    h('p', { key: 'scope' }, `Session ${selected.sessionId} · ${selected.plan ? 'Plan mode' : 'Execution mode'} · keyless fixture`),
    h('form', { key: 'composer', onSubmit: send }, [
      input.claim ? h('p', { key: 'claim', 'data-testid': 'claim' }, input.claim.token) : null,
      h('label', { key: 'label', htmlFor: 'prompt' }, 'Prompt'),
      h('textarea', { key: 'prompt', id: 'prompt', value: input.draft, rows: 5, style: { width: '100%', boxSizing: 'border-box', margin: '8px 0' },
        onChange: (event) => current.state.set({ ...input, draft: event.target.value, draftRev: input.draftRev + 1 }),
        onKeyDown: (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event) } },
      }),
      ...entries.map(({ options, component: Component }) => {
        if (!current.faces.has(options.id)) current.faces.set(options.id, options.inject(selected.sessionId))
        const face = current.faces.get(options.id)
        return h(Component, { key: `${options.id}-${selected.sessionId}`, ...face, t: translate,
          useInput: (selector) => hook(current.state, selector),
          useTaskMode: (selector) => hook(face.hooks.taskMode, selector),
          useProjection: () => ({ active: selected.plan, pending: false }),
        })
      }),
      h('button', { key: 'send', type: 'submit', style: { marginTop: 12, minHeight: 32 } }, 'Send'),
    ]),
    h('p', { key: 'notice', role: 'status', 'data-testid': 'notice' }, notice),
  ])
}
window.fixture = {
  submissions,
  setPlan: (plan) => screen.set({ ...screen.getSnapshot(), plan }),
  setFailure: (fail) => screen.set({ ...screen.getSnapshot(), fail }),
  switchSession: (sessionId) => screen.set({ ...screen.getSnapshot(), sessionId }),
}
createRoot(document.getElementById('root')).render(h(Fixture))
