import { useEffect, useState } from 'react'
import { IndexProgressPanel } from './ZvecIndexProgress.jsx'

const IMAGE_MODEL_OPTIONS = [
  { value: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image — nano banana' },
  { value: 'gemini-3.1-flash-image', label: 'gemini-3.1-flash-image — nano banana 2' },
  { value: 'gemini-3-pro-image', label: 'gemini-3-pro-image — nano banana pro' },
]
const SUBAGENT_MODEL_COMPLEX_OPTIONS = [
  { value: 'deepseek-flash', label: 'deepseek-flash (default)' },
]
const SUBAGENT_MODEL_VISION_OPTIONS = [
  { value: 'deepseek-flash', label: 'deepseek-flash (default)' },
]
const ZVEC_GREP_EMBEDDING_OPTIONS = [
  { value: 'local/potion-retrieval-32m', label: 'local/potion-retrieval-32m — papers / notes (default)' },
  { value: 'local/potion-code-16m-v2', label: 'local/potion-code-16m-v2 — code' },
  { value: 'local/potion-multilingual-128m', label: 'local/potion-multilingual-128m — multilingual docs' },
]
const ZVEC_GREP_AUTO_INDEX_OPTIONS = [
  { value: 'no', label: 'No — ask in chat when semantic search would help (default)' },
  { value: 'yes', label: 'Yes — index this workspace when an Academic Harness session opens' },
]
const CUSTOM_MODEL = '__custom__'

/** The settings fields this section manages, grouped for display. */
const KEYS = [
  { field: 'PARALLEL_API_KEY', label: 'Parallel', group: 'Literature search', hint: 'Required for mcp__parallel__* and parallel_search — sent as a Bearer token so search is not rate-limited. Restart dsh after saving.' },
  { field: 'FIRECRAWL_API_KEY', label: 'Firecrawl', group: 'Literature search', hint: 'Optional — raises the keyless rate limit.' },
  { field: 'CONSENSUS_API_KEY', label: 'Consensus', group: 'Literature search', hint: 'Required to enable this connector.' },
  { field: 'SCITE_API_KEY', label: 'Scite', group: 'Literature search', hint: 'Required to enable this connector.' },
  { field: 'UNPAYWALL_EMAIL', label: 'Unpaywall contact email', group: 'Literature search', hint: 'Required for paper_download to resolve a DOI to an open-access PDF — Unpaywall asks API callers to identify themselves with a real email.' },
  { field: 'GEMINI_API_KEY', label: 'Gemini', group: 'Image generation', hint: 'Enables the image_generate tool.' },
  { field: 'IMAGE_MODEL', label: 'Image model', group: 'Image generation', type: 'select', options: IMAGE_MODEL_OPTIONS, hint: 'Which Gemini model image_generate uses by default. Defaults to nano banana if unset.' },
  { field: 'SUBAGENT_MODEL_COMPLEX', label: 'Complex-task model', group: 'Subagent model routing', type: 'select', options: SUBAGENT_MODEL_COMPLEX_OPTIONS, hint: 'Model for the subagent_pro delegation tool (unusually heavy reasoning). Requires restarting dsh to apply — same as the MCP connector keys above, not like Image model.' },
  { field: 'SUBAGENT_MODEL_VISION', label: 'Image-reading model', group: 'Subagent model routing', type: 'select', options: SUBAGENT_MODEL_VISION_OPTIONS, hint: 'Model for the subagent_vision delegation tool (reads images via read_image). Requires restarting dsh to apply — same as the MCP connector keys above, not like Image model.' },
  { field: 'MODAL_TOKEN_ID', label: 'Modal — token ID', group: 'Remote compute', hint: 'From modal.com/settings.' },
  { field: 'MODAL_TOKEN_SECRET', label: 'Modal — token secret', group: 'Remote compute', hint: 'From modal.com/settings.' },
  { field: 'RUNPOD_API_KEY', label: 'Runpod', group: 'Remote compute', hint: 'From console.runpod.io/user/settings.' },
  { field: 'ZVEC_GREP_AUTO_INDEX', label: 'Index at session start', group: 'Workspace search (zvec-grep)', type: 'select', options: ZVEC_GREP_AUTO_INDEX_OPTIONS, hideCustom: true, hint: 'Default is No. When No, you can still ask in chat to index, and the agent will ask first when semantic search would help. When Yes, an Academic Harness session indexes that workspace in the background if no index exists yet. Applies to the next session — no restart. While indexing, a progress bar with estimated time and Cancel appear here and in the session header. There is no timeout.' },
  { field: 'ZVEC_GREP_EMBEDDING', label: 'zvec-grep embedding', group: 'Workspace search (zvec-grep)', type: 'select', options: ZVEC_GREP_EMBEDDING_OPTIONS, hint: 'Default local model for new zg indexes (potion-retrieval-32m, ~130 MB download, no API key). Existing indexes keep their stored model. Restart dsh after changing.' },
  { field: 'ZVEC_GREP_API_KEY', label: 'zvec-grep remote embedding key', group: 'Workspace search (zvec-grep)', hint: 'Leave empty. Only needed for a remote (Qwen) embedding model, not for the default local Potion models.' },
]

const GROUPS = [...new Set(KEYS.map((k) => k.group))]

const errorText = { color: 'var(--color-danger, #c0392b)', margin: 0, fontSize: '0.85em' }
const hintText = { margin: 0, opacity: 0.6, fontSize: '0.8em' }
const fieldLabel = { fontSize: '0.85em' }

/** A non-secret select field: shows and applies its current value immediately on change. */
function SelectField({ k, scope, snapshot, writable }) {
  const stored = snapshot.value?.[k.field] || ''
  const known = k.options.some((o) => o.value === stored)
  const [customMode, setCustomMode] = useState(Boolean(stored) && !known)
  const [customDraft, setCustomDraft] = useState(known ? '' : stored)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState()

  const apply = async (value) => {
    setBusy(true)
    setError(undefined)
    try {
      if (value) await scope.set(k.field, value)
      else await scope.unset(k.field)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const onSelectChange = (e) => {
    const value = e.target.value
    if (value === CUSTOM_MODEL) {
      setCustomMode(true)
      return
    }
    setCustomMode(false)
    apply(value)
  }

  return (
    <div key={k.field} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <label style={fieldLabel}>
        {k.label}
        {' — '}
        {stored || `default (${k.options[0].value})`}
      </label>
      <select
        value={customMode ? CUSTOM_MODEL : (stored || k.options[0].value)}
        disabled={busy || !writable}
        onChange={onSelectChange}
        style={{ flex: 1 }}
      >
        {k.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
        {!k.hideCustom && <option value={CUSTOM_MODEL}>Custom…</option>}
      </select>
      {customMode && (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            autoComplete="off"
            placeholder="model id, e.g. gemini-2.0-flash-exp"
            value={customDraft}
            disabled={busy || !writable}
            onChange={(e) => setCustomDraft(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="button" disabled={busy || !writable || !customDraft.trim()} onClick={() => apply(customDraft.trim())}>
            Apply
          </button>
        </div>
      )}
      {error && <p style={errorText}>{error}</p>}
      {k.hint && <p style={hintText}>{k.hint}</p>}
    </div>
  )
}

/** A secret field: write-only draft input, never populated from the stored value. */
function SecretField({ k, scope, snapshot, writable }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState()
  const configured = Boolean(snapshot.value?.[k.field])

  const save = async () => {
    const value = draft.trim()
    if (!value) return
    setBusy(true)
    setError(undefined)
    try {
      await scope.set(k.field, value)
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await scope.unset(k.field)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div key={k.field} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <label style={fieldLabel}>
        {k.label}
        {' — '}
        {configured ? 'configured' : 'not set'}
      </label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="password"
          autoComplete="off"
          placeholder={configured ? 'leave blank to keep' : 'not set'}
          value={draft}
          disabled={busy || !writable}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" disabled={busy || !writable || !draft.trim()} onClick={save}>
          Save
        </button>
        <button type="button" disabled={busy || !writable || !configured} onClick={clear}>
          Clear
        </button>
      </div>
      {error && <p style={errorText}>{error}</p>}
      {k.hint && <p style={hintText}>{k.hint}</p>}
    </div>
  )
}

/** Props supplied by our own client/index.js registration: { scope }. */
export function ApiKeysSection(props) {
  const { scope } = props
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())

  useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope])

  if (snapshot.status === 'loading') {
    return (
      <div style={{ padding: '4px 0' }}>
        <p style={{ margin: 0, opacity: 0.75, fontSize: '0.9em' }}>Connecting…</p>
      </div>
    )
  }
  if (snapshot.status === 'unavailable') {
    return (
      <div style={{ padding: '4px 0' }}>
        <p style={{ margin: 0, opacity: 0.75, fontSize: '0.9em' }}>
          Settings storage is unavailable in this browser session (non-loopback connections don't get durable
          settings). Set the matching environment variables before starting DSH instead.
        </p>
      </div>
    )
  }

  const writable = snapshot.writable !== false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', padding: '4px 0' }}>
      <p style={{ margin: 0, opacity: 0.75, fontSize: '0.9em' }}>
        API keys for Academic Harness's academic-search connectors, image generation, remote-compute tools, and optional zvec-grep remote embeddings.
        A key set here is used only when the matching environment variable isn't already set when DSH starts.
      </p>
      {!writable && (
        <p style={errorText}>Settings storage is read-only in this session.</p>
      )}
      {GROUPS.map((group) => (
        <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h3 style={{ margin: 0, fontSize: '0.95em' }}>{group}</h3>
          {KEYS.filter((k) => k.group === group).map((k) => (
            k.type === 'select'
              ? <SelectField key={k.field} k={k} scope={scope} snapshot={snapshot} writable={writable} />
              : <SecretField key={k.field} k={k} scope={scope} snapshot={snapshot} writable={writable} />
          ))}
          {group === 'Workspace search (zvec-grep)' && (
            <IndexProgressPanel scope={scope} />
          )}
        </div>
      ))}
    </div>
  )
}
