/**
 * The `academic-harness` host entry Config: API keys for the MCP
 * connectors, image generation, and remote-compute tools, plus a handful of
 * non-secret preferences (IMAGE_MODEL, SUBAGENT_MODEL_COMPLEX,
 * SUBAGENT_MODEL_VISION, ZVEC_GREP_EMBEDDING, ZVEC_GREP_AUTO_INDEX) that ride
 * along in the same schema/UI section for convenience — editable from
 * Settings -> Academic Harness API keys.
 * Registered at plugin load; resolveEnv() (credential-env.js) reads the live
 * value on every call, so a value entered in Settings works without a
 * restart for fields read per-call (IMAGE_MODEL, ZVEC_GREP_AUTO_INDEX) —
 * process.env still wins when set. The two SUBAGENT_MODEL_* fields and
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
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** 0.1.x settings.yaml section. Import-only; never written. */
export const LEGACY_KEYS_NAMESPACE = 'dsh-researchcraft-keys'
/** Loader row id of the host plugin; 0.2.0 settings forms key by entry id. */
export const KEYS_ENTRY_ID = 'academic-harness'
/** Pre-v0.16.0 Loader row ids whose config may still hold API keys. */
export const LEGACY_ENTRY_IDS = ['researchcraft', 'dsh-researchcraft']

export const KEY_FIELDS = [
  'PARALLEL_API_KEY',
  'FIRECRAWL_API_KEY',
  'CONSENSUS_API_KEY',
  'SCITE_API_KEY',
  'UNPAYWALL_EMAIL',
  'GEMINI_API_KEY',
  'IMAGE_MODEL',
  'SUBAGENT_MODEL_COMPLEX',
  'SUBAGENT_MODEL_VISION',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  'RUNPOD_API_KEY',
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
let legacyKeys = {}

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

const SKIP_IMPORT_FIELDS = new Set(['ZVEC_GREP_INDEX_STATE', 'ZVEC_GREP_INDEX_CANCEL'])

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function migrationMarkerPath() {
  return join(dshHome(), 'academic-harness-migrations.json')
}

function migrationKey(ctx) {
  try {
    const path = ctx?.settings?.documentPath
    return typeof path === 'string' && path.length > 0 ? path : 'dsh-home'
  } catch {
    return 'dsh-home'
  }
}

function migrationDocuments() {
  try {
    const parsed = JSON.parse(readFileSync(migrationMarkerPath(), 'utf8'))
    return parsed && typeof parsed.documents === 'object' ? parsed.documents : {}
  } catch {
    return {}
  }
}

function alreadyMigrated(ctx) {
  return Boolean(migrationDocuments()[migrationKey(ctx)])
}

/** Mark this profile document as migrated so a cleared field stays cleared. */
function markMigrated(ctx) {
  const documents = migrationDocuments()
  documents[migrationKey(ctx)] = new Date().toISOString()
  const path = migrationMarkerPath()
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify({ version: 1, documents }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    // Best effort: migration still succeeded; worst case it retries next boot.
  }
}

function unquote(value) {
  const text = String(value || '').trim()
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1)
  }
  return text
}

/** Flat `dsh-researchcraft-keys:` mapping from a 0.1.x settings.yaml import. */
function parseImportedKeys(text) {
  const out = {}
  let inSection = false
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^[A-Za-z0-9_.-]+:\s*$/.test(line)) {
      inSection = line.startsWith(`${LEGACY_KEYS_NAMESPACE}:`)
      continue
    }
    if (!inSection) continue
    if (/^\S/.test(line)) {
      inSection = false
      continue
    }
    const match = line.match(/^\s+([A-Z0-9_]+):\s*(.*)$/)
    if (!match || !KEY_FIELDS.includes(match[1]) || SKIP_IMPORT_FIELDS.has(match[1])) continue
    const value = unquote(match[2])
    if (value) out[match[1]] = value
  }
  return out
}

/**
 * Read the flat config of a pre-v0.16.0 host row from the live profile patch.
 * This is a line scanner rather than a YAML parse so unrelated `!!js` tags in
 * the same document cannot make migration fail. Only plain `KEY: value` entries
 * inside that row's `config:` block are considered.
 */
function readLegacyEntryConfig(ctx) {
  let documentPath
  try {
    documentPath = ctx?.settings?.documentPath
  } catch {
    return {}
  }
  if (typeof documentPath !== 'string' || !documentPath || !existsSync(documentPath)) return {}

  let text
  try {
    text = readFileSync(documentPath, 'utf8')
  } catch {
    return {}
  }

  const out = {}
  let rowIndent = -1
  let inConfig = false
  for (const line of text.split(/\r?\n/)) {
    const row = line.match(/^(\s*)-\s+id:\s*(['"]?)([^'"]+)\2\s*$/)
    if (row) {
      const indent = row[1].length
      if (LEGACY_ENTRY_IDS.includes(row[3])) {
        rowIndent = indent
        inConfig = false
        continue
      }
      if (rowIndent >= 0 && indent <= rowIndent) {
        rowIndent = -1
        inConfig = false
      }
      continue
    }
    if (rowIndent < 0) continue
    if (/^\s*config:\s*$/.test(line)) {
      inConfig = true
      continue
    }
    if (!inConfig) continue
    const indent = line.match(/^(\s*)/)[1].length
    if (line.trim() && indent <= rowIndent) {
      rowIndent = -1
      inConfig = false
      continue
    }
    const field = line.match(/^\s+([A-Z0-9_]+):\s*(.*)$/)
    if (!field || !KEY_FIELDS.includes(field[1]) || SKIP_IMPORT_FIELDS.has(field[1])) continue
    const value = unquote(field[2])
    if (value) out[field[1]] = value
  }
  return out
}

/**
 * Collect legacy values once per profile document. Live Config wins; the old
 * host row wins over the 0.1.x `settings.yaml.imported` section. Only fields
 * that are currently empty are copied, so partially configured new rows do not
 * block the rest.
 */
function loadLegacyKeys(ctx) {
  legacyKeys = {}
  if (alreadyMigrated(ctx)) return
  const current = readSection()
  const sources = [readLegacyEntryConfig(ctx)]

  const importedPath = join(dshHome(), 'settings.yaml.imported')
  if (existsSync(importedPath)) {
    try {
      sources.push(parseImportedKeys(readFileSync(importedPath, 'utf8')))
    } catch {
      // Unreadable legacy file: keep going with the old host row only.
    }
  }

  for (const field of KEY_FIELDS) {
    if (SKIP_IMPORT_FIELDS.has(field) || current[field].trim()) continue
    for (const source of sources) {
      const value = typeof source[field] === 'string' ? source[field].trim() : ''
      if (value) {
        legacyKeys[field] = value
        break
      }
    }
  }
}

async function persistLegacyKeys(ctx) {
  if (Object.keys(legacyKeys).length === 0 || !ctx.settings?.update) return
  try {
    await ctx.settings.update(KEYS_ENTRY_ID, { ...legacyKeys })
    legacyKeys = {}
    markMigrated(ctx)
  } catch {
    // Keep the in-memory fallback for this session; values stay usable.
    console.warn('[academic-harness] could not persist migrated API-key fields; they remain active for this session')
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
  loadLegacyKeys(ctx)
  persistLegacyKeys(ctx).catch(() => {})
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
  if (typeof live === 'string' && live.length > 0) return live
  const legacy = legacyKeys[name]?.trim()
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : undefined
}
