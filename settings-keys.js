/**
 * The `academic-harness` host entry Config: API keys for the MCP
 * connectors, image generation, and remote-compute tools, plus a handful of
 * non-secret preferences (IMAGE_MODEL, SUBAGENT_PRO_BASE_URL,
 * SUBAGENT_PRO_MODEL, SUBAGENT_VISION_BASE_URL, SUBAGENT_VISION_MODEL,
 * ZVEC_GREP_EMBEDDING, ZVEC_GREP_AUTO_INDEX) that ride
 * along in the same schema/UI section for convenience — editable from
 * Settings -> Academic Harness API keys.
 * Registered at plugin load; resolveEnv() (credential-env.js) reads the live
 * value on every call, so a value entered in Settings works without a
 * restart for fields read per-call (IMAGE_MODEL, ZVEC_GREP_AUTO_INDEX) —
 * process.env still wins when set. The SUBAGENT_* custom-route fields and
 * ZVEC_GREP_EMBEDDING / ZVEC_GREP_API_KEY feed standing preset mounts (see
 * subagent-models.js and zvec-grep.js) and need a `dsh` restart to apply,
 * same as the MCP connector keys below. ZVEC_GREP_INDEX_STATE /
 * ZVEC_GREP_INDEX_CANCEL are ephemeral progress/cancel wires, not user
 * credentials — hidden from the Settings form, written by the indexer.
 *
 * DSH 0.2.0 dropped `ctx.settings.register(namespace, schema)`. Keys live on
 * this plugin's Cordis Config (volatile strings) and persist through the
 * profile patch on Loader entry id `academic-harness`. The browser page uses
 * `ctx.configForms.get(KEYS_ENTRY_ID)`.
 *
 * Fields are deliberately NOT `role('secret')`: that role strips the field
 * from every client-facing snapshot unconditionally (the write still lands,
 * but no reader, including this plugin's own settings page, can ever read
 * it back to show "configured"). The web UI's own write-only design (blank
 * input, Save/Clear, never populating the field from the stored value) is
 * this plugin's actual protection against displaying a stored key.
 */
import z from '@deepseek-ai/schemastery'

/** Loader row id of the host plugin; 0.2.0 settings forms key by entry id. */
export const KEYS_ENTRY_ID = 'academic-harness'

export const KEY_FIELDS = [
  'PARALLEL_API_KEY',
  'FIRECRAWL_API_KEY',
  'CONSENSUS_API_KEY',
  'SCITE_API_KEY',
  'BRAVE_API_KEY',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'PERPLEXITY_API_KEY',
  'JINA_API_KEY',
  'UNPAYWALL_EMAIL',
  'OPENALEX_API_KEY',
  'S2_API_KEY',
  'CROSSREF_MAILTO',
  'NCBI_API_KEY',
  'NCBI_EMAIL',
  'CORE_API_KEY',
  'ADS_API_TOKEN',
  'SCOPUS_API_KEY',
  'ELSEVIER_INSTTOKEN',
  'WOS_API_KEY',
  'WILEY_TDM_TOKEN',
  'SPRINGER_API_KEY',
  'IEEE_API_KEY',
  'ELICIT_API_KEY',
  'FUTUREHOUSE_API_KEY',
  'SHERPA_ROMERO_API_KEY',
  'OPENFDA_API_KEY',
  'DATACITE_API_KEY',
  'ZENODO_API_KEY',
  'FIGSHARE_API_KEY',
  'ORCID_TOKEN',
  'PATENTSVIEW_API_KEY',
  'GEMINI_API_KEY',
  'IMAGE_MODEL',
  'SUBAGENT_PRO_BASE_URL',
  'SUBAGENT_PRO_MODEL',
  'SUBAGENT_PRO_API_KEY',
  'SUBAGENT_VISION_BASE_URL',
  'SUBAGENT_VISION_MODEL',
  'SUBAGENT_VISION_API_KEY',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  'RUNPOD_API_KEY',
  'VAST_API_KEY',
  'CO_SCIENTIST_MAX_HYPOTHESES',
  'CO_SCIENTIST_STEP_BUDGET',
  'CO_SCIENTIST_DUP_THRESHOLD',
  'CO_SCIENTIST_SEED',
  'CO_SCIENTIST_EMBED_MODEL',
  'ZVEC_GREP_EMBEDDING',
  'ZVEC_GREP_API_KEY',
  'ZVEC_GREP_AUTO_INDEX',
  'ZVEC_GREP_INDEX_STATE',
  'ZVEC_GREP_INDEX_CANCEL',
]

function fieldSchema() {
  const field = z.string().default('')
  return typeof field.volatile === 'function' ? field.volatile() : field
}

const shape = {}
for (const field of KEY_FIELDS) shape[field] = fieldSchema()
export const KeysSettingsSchema = z.object(shape)

let keysCtx
let keysConfig
let scope

function unwrapField(raw) {
  if (raw && typeof raw === 'object' && typeof raw.get === 'function') return raw.get()
  return raw
}

function readSection() {
  const out = {}
  if (!keysConfig) return out
  for (const field of KEY_FIELDS) {
    const value = unwrapField(keysConfig[field])
    out[field] = typeof value === 'string' ? value : ''
  }
  return out
}

function makeScope(ctx) {
  return {
    get() {
      return readSection()
    },
    async update(patch) {
      if (!ctx?.settings?.update) return
      await ctx.settings.update(KEYS_ENTRY_ID, patch)
    },
    watch(callback) {
      if (!ctx?.on) return () => {}
      let prev = readSection()
      const dispose = ctx.on('settings/document-updated', (id) => {
        if (id !== KEYS_ENTRY_ID) return
        const next = readSection()
        const prevSnap = prev
        prev = next
        try {
          const result = callback(next, prevSnap)
          if (result && typeof result.then === 'function') result.catch(() => {})
        } catch {
          // same containment as 0.1.x SettingsScope.watch
        }
      })
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
}

/** Bind the live Config; call once, at plugin apply(). */
export function registerKeysSettings(ctx, config) {
  keysCtx = ctx
  keysConfig = config ?? {}
  scope = makeScope(ctx)
  if (typeof ctx.settings?.configure === 'function') {
    ctx.effect(() => ctx.settings.configure({ auto: false }))
  }
  return scope
}

/** Owner handle for this entry, or undefined before registration. */
export function getKeysScope() {
  return scope
}

/**
 * Read one key's current stored value, or undefined if unset/unregistered.
 * Trimmed the same way resolveEnv() trims process.env — otherwise a stray
 * leading/trailing space or newline from copy-pasting a token into the
 * Settings field (e.g. a trailing newline copied from a terminal or a
 * dashboard's "copy" button) is stored and returned verbatim: the UI shows
 * "configured" but the credential silently fails to authenticate.
 */
export function getStoredKey(name) {
  const live = scope?.get()?.[name]?.trim()
  return typeof live === 'string' && live.length > 0 ? live : undefined
}
