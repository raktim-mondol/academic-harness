import { useEffect, useState } from 'react'
import { IndexProgressPanel } from './ZvecIndexProgress.jsx'

const IMAGE_MODEL_OPTIONS = [
  { value: 'gemini-2.5-flash-image', label: 'gemini-2.5-flash-image — nano banana' },
  { value: 'gemini-3.1-flash-image', label: 'gemini-3.1-flash-image — nano banana 2' },
  { value: 'gemini-3-pro-image', label: 'gemini-3-pro-image — nano banana pro' },
]
const SUBAGENT_API_OPTIONS = [
  { value: '', label: 'Inherit session model (default)' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
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
  { field: 'FIRECRAWL_API_KEY', label: 'Firecrawl', group: 'Literature search', hint: 'Required to mount Firecrawl (search/scrape/parse); the connector stays disabled without it. Restart dsh after saving.' },
  { field: 'CONSENSUS_API_KEY', label: 'Consensus', group: 'Literature search', hint: 'Required for consensus_search, a native REST tool — read per call, no restart.' },
  { field: 'SCITE_API_KEY', label: 'Scite', group: 'Literature search', hint: 'Required to enable the Scite MCP connector. Restart dsh after saving.' },
  { field: 'BRAVE_API_KEY', label: 'Brave Search', group: 'Web search', hint: 'Optional — enables brave_search as an independent web-index fallback (not a literature index). Read per call, no restart.' },
  { field: 'TAVILY_API_KEY', label: 'Tavily', group: 'Web search', hint: 'Required for tavily_search — AI-native web search with chunked content and topic modes.' },
  { field: 'EXA_API_KEY', label: 'Exa', group: 'Web search', hint: 'Required for exa_search — neural/entity web search with optional content extraction.' },
  { field: 'PERPLEXITY_API_KEY', label: 'Perplexity', group: 'Web search', hint: 'Required for perplexity_search — raw ranked web results (not the synthesized-answer API).' },
  { field: 'JINA_API_KEY', label: 'Jina', group: 'Web search', hint: 'Optional for jina_read (keyless Reader is 20 RPM); required for jina_read mode=search.' },
  { field: 'UNPAYWALL_EMAIL', label: 'Unpaywall contact email', group: 'Literature search', hint: 'Recommended for paper_download: enables the Unpaywall lookup, and the other open-access fallbacks still run without it. Unpaywall asks API callers to identify themselves with a real email.' },
  { field: 'OPENALEX_API_KEY', label: 'OpenAlex', group: 'Academic databases', hint: 'Optional — a free key raises the daily budget and rate limit (10 → 30 RPS) and enables cursor paging. Used by openalex_search, openalex_citations, paper_resolve, integrity_check, and funder_policy.' },
  { field: 'S2_API_KEY', label: 'Semantic Scholar', group: 'Academic databases', hint: 'Optional — a free key gives s2_search and paper_resolve a dedicated 1 RPS bucket. Unkeyed traffic shares a heavily throttled pool.' },
  { field: 'CROSSREF_MAILTO', label: 'Crossref contact email', group: 'Academic databases', hint: 'Optional — moves crossref_lookup, citation DOI checks, paper_resolve, and coscientist_verify into the polite pool. Falls back to the Unpaywall email.' },
  { field: 'NCBI_API_KEY', label: 'NCBI API key', group: 'Academic databases', hint: 'Optional — raises pubmed_search source="ncbi" from 3 to 10 requests per second.' },
  { field: 'NCBI_EMAIL', label: 'NCBI contact email', group: 'Academic databases', hint: 'Optional — NCBI asks API callers for a contact email. Falls back to the Unpaywall email.' },
  { field: 'CORE_API_KEY', label: 'CORE', group: 'Academic databases', hint: 'Optional — keyless CORE is limited to ~10 requests/minute; a registered key gives more stable access and is required for include_fulltext.' },
  { field: 'ADS_API_TOKEN', label: 'NASA ADS', group: 'Domain sources', hint: 'Required for ADS results in literature_search (sources=ads) and domain_search ADS actions. Create a token in your ADS account; a daily quota applies. Read per call, no restart.' },
  { field: 'SCOPUS_API_KEY', label: 'Scopus', group: 'Domain sources', hint: 'Required for Scopus results in literature_search (sources=scopus) and domain_search Scopus actions. Key from dev.elsevier.com; access follows institutional IP/VPN, so 401/403 means not entitled. Read per call, no restart.' },
  { field: 'WOS_API_KEY', label: 'Web of Science', group: 'Domain sources', hint: 'Required for Web of Science results in literature_search (sources=wos) and domain_search WoS actions. Key from the Clarivate Developer Portal; Starter has a low daily quota and field limits. Read per call, no restart.' },
  { field: 'ELICIT_API_KEY', label: 'Elicit', group: 'Academic databases', hint: 'Required for elicit_search — Elicit Pro plan or above. 100 requests/minute per IP, then a 5-minute block.' },
  { field: 'FUTUREHOUSE_API_KEY', label: 'FutureHouse / Edison', group: 'Research agents', hint: 'Required for futurehouse_agent (Crow/Falcon/Owl on the Edison Scientific platform). Tasks are asynchronous: start, then poll status in a later turn.' },
  { field: 'OPENFDA_API_KEY', label: 'openFDA', group: 'Regulatory data', hint: 'Optional — openFDA works keyless at a low shared daily limit; a free key raises the quota. Used by the openfda tool.' },
  { field: 'SHERPA_ROMERO_API_KEY', label: 'Sherpa Romeo', group: 'Data and compliance', hint: 'Optional — without it journal_policy returns DOAJ data only and notes that Sherpa Romeo was not checked. A free key adds per-version self-archiving policy.' },
  { field: 'DATACITE_API_KEY', label: 'DataCite', group: 'Data and compliance', hint: 'Optional — public DataCite reads need no key; set this only if your gateway requires a bearer token. Used by dataset_search.' },
  { field: 'ZENODO_API_KEY', label: 'Zenodo', group: 'Data and compliance', hint: 'Optional — a Zenodo personal access token (sent as a Bearer token) lets dataset_search files list restricted records you can access. Public records work keyless.' },
  { field: 'FIGSHARE_API_KEY', label: 'Figshare', group: 'Data and compliance', hint: 'Optional — a Figshare personal token (sent as "token …") lets dataset_search files access records available to your account. Public records work keyless.' },
  { field: 'PATENTSVIEW_API_KEY', label: 'PatentsView', group: 'Patents', hint: 'Required for patent_search (optional tool). Free key from search.patentsview.org; without it the tool returns a clear error.' },
  { field: 'ORCID_TOKEN', label: 'ORCID', group: 'Identity', hint: 'Optional — used by the optional author_lookup tool as a Bearer token for higher ORCID rate limits. Public reads work without it; ROR needs no key.' },
  { field: 'GEMINI_API_KEY', label: 'Gemini', group: 'Image generation', hint: 'Enables image_generate and coscientist embed.' },
  { field: 'IMAGE_MODEL', label: 'Image model', group: 'Image generation', type: 'select', options: IMAGE_MODEL_OPTIONS, hint: 'Which Gemini model image_generate uses by default. Defaults to nano banana if unset.' },
  { field: 'SUBAGENT_PRO_API', label: 'Pro API type', group: 'Subagent model routing', type: 'select', options: SUBAGENT_API_OPTIONS, hideCustom: true, hint: 'Anthropic Messages or an OpenAI-compatible API. Set all four Pro fields to activate a custom route; leave the API type unset to inherit the session model.' },
  { field: 'SUBAGENT_PRO_BASE_URL', label: 'Pro endpoint URL', group: 'Subagent model routing', type: 'text', hint: 'Endpoint root, for example https://api.deepseek.com/anthropic or https://api.openai.com/v1.' },
  { field: 'SUBAGENT_PRO_MODEL', label: 'Pro model', group: 'Subagent model routing', type: 'text', hint: 'Model id sent to this endpoint. Leave all four Pro fields blank to inherit the session model.' },
  { field: 'SUBAGENT_PRO_API_KEY', label: 'Pro API key', group: 'Subagent model routing', hint: 'Stored in the DSH credential store and used only for this route. Required with the other three Pro fields.' },
  { field: 'SUBAGENT_VISION_API', label: 'Vision API type', group: 'Subagent model routing', type: 'select', options: SUBAGENT_API_OPTIONS, hideCustom: true, hint: 'Anthropic Messages or an OpenAI-compatible API. Set all four Vision fields to activate a custom route; leave the API type unset to inherit the session model.' },
  { field: 'SUBAGENT_VISION_BASE_URL', label: 'Vision endpoint URL', group: 'Subagent model routing', type: 'text', hint: 'Endpoint root for the image-reading route, for example https://api.deepseek.com/anthropic or https://api.openai.com/v1.' },
  { field: 'SUBAGENT_VISION_MODEL', label: 'Vision model', group: 'Subagent model routing', type: 'text', hint: 'Image-capable model id sent to this endpoint. Leave all four Vision fields blank to inherit the session model.' },
  { field: 'SUBAGENT_VISION_API_KEY', label: 'Vision API key', group: 'Subagent model routing', hint: 'Stored in the DSH credential store and used only for this route. Required with the other three Vision fields.' },
  { field: 'MODAL_TOKEN_ID', label: 'Modal — token ID', group: 'Remote compute', hint: 'From modal.com/settings.' },
  { field: 'MODAL_TOKEN_SECRET', label: 'Modal — token secret', group: 'Remote compute', hint: 'From modal.com/settings.' },
  { field: 'RUNPOD_API_KEY', label: 'Runpod', group: 'Remote compute', hint: 'From console.runpod.io/user/settings.' },
  { field: 'VAST_API_KEY', label: 'Vast.ai', group: 'Remote compute', hint: 'From cloud.vast.ai/manage-keys.' },
  { field: 'CO_SCIENTIST_MAX_HYPOTHESES', label: 'Hypotheses per tournament', group: 'Hypothesis tournament', hint: 'Default cap for `coscientist` action=start (5). Chosen so one review veto plus one dual-use withholding still leaves three ideas competing — at 3 the tournament stalls. Past 5 the extra ideas buy breadth while each pair meets less than twice. Debate matches are the expensive part. A per-call max_hypotheses wins; read per call, no restart.' },
  { field: 'CO_SCIENTIST_STEP_BUDGET', label: 'Dispatch steps per tournament', group: 'Hypothesis tournament', hint: 'Default cap on dispatch rounds (36) — sized for the 5-hypothesis default: ~8 generations + 5 reviews + 15 matches ≈ 31, with slack. It is also the smallest budget where the Elo plateau can fire at all (needs 20 samples and 10 matches). Raise both together, or a bigger pool ends on budget instead of converged rankings. A per-call step_budget wins.' },
  { field: 'CO_SCIENTIST_DUP_THRESHOLD', label: 'Duplicate gate', group: 'Hypothesis tournament', hint: 'Similarity (0-1) at which `coscientist` add discards a near-duplicate hypothesis. Leave empty for the measure default (0.70 lexical, 0.92 cosine); set 1 to turn the gate off.' },
  { field: 'CO_SCIENTIST_SEED', label: 'Schedule seed', group: 'Hypothesis tournament', hint: 'Number that makes a tournament\'s sampled task schedule reproducible. Leave empty for a non-deterministic run.' },
  { field: 'CO_SCIENTIST_EMBED_MODEL', label: 'Embedding model', group: 'Hypothesis tournament', hint: 'Optional. Model for `coscientist embed`, which switches the duplicate gate to cosine. Defaults to text-embedding-004 and needs GEMINI_API_KEY; leave empty to keep the lexical gate, which needs no key and no network.' },
  { field: 'ZVEC_GREP_AUTO_INDEX', label: 'Index at session start', group: 'Workspace search (zvec-grep)', type: 'select', options: ZVEC_GREP_AUTO_INDEX_OPTIONS, hideCustom: true, hint: 'Default is No. When No, you can still ask in chat to index, and the agent will ask first when semantic search would help. When Yes, an Academic Harness session indexes that workspace in the background if no index exists yet. Applies to the next session — no restart. While indexing, a progress bar with estimated time and Cancel appear here and in the session header. There is no timeout.' },
  { field: 'ZVEC_GREP_EMBEDDING', label: 'zvec-grep embedding', group: 'Workspace search (zvec-grep)', type: 'select', options: ZVEC_GREP_EMBEDDING_OPTIONS, hint: 'Default local model for new zg indexes (potion-retrieval-32m, ~130 MB download, no API key). Existing indexes keep their stored model. A new index run uses the current value; restart dsh so the search daemon uses it too.' },
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
        {stored || (k.options[0].value ? `default (${k.options[0].value})` : k.options[0].label)}
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

/** A non-secret text field that shows its stored value and saves on demand. */
function TextField({ k, scope, snapshot, writable }) {
  const stored = snapshot.value?.[k.field] || ''
  const [draft, setDraft] = useState(stored)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState()

  useEffect(() => { setDraft(stored) }, [stored])

  const save = async () => {
    const value = draft.trim()
    setBusy(true)
    setError(undefined)
    try {
      await scope.set(k.field, value)
      setDraft(value)
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
      setDraft('')
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
        {stored || 'not set'}
      </label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          autoComplete="off"
          value={draft}
          disabled={busy || !writable}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" disabled={busy || !writable || !draft.trim() || draft.trim() === stored} onClick={save}>
          Save
        </button>
        <button type="button" disabled={busy || !writable || !stored} onClick={clear}>
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
        API keys for Academic Harness's academic- and web-search connectors, image generation, remote-compute tools, and optional zvec-grep remote embeddings.
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
              : k.type === 'text'
                ? <TextField key={k.field} k={k} scope={scope} snapshot={snapshot} writable={writable} />
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
