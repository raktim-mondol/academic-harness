/**
 * Skill licence labels: reading them, mapping the unambiguous ones to SPDX
 * identifiers, and recognising the non-commercial ones.
 *
 * Skills come from many upstream catalogues and arrived with about thirty
 * spellings of the same few licences. `normalize` maps only the spellings whose
 * meaning is not in doubt. Anything else (a link to a library's LICENSE, an
 * unversioned "BSD", "Unknown", a GPL label that names the *library* a skill
 * teaches) is returned as `unresolved` with a reason, because choosing for the
 * owner would put a guess in a legal field.
 */

const MAP = new Map([
  ['mit', 'MIT'],
  ['mit license', 'MIT'],
  ['bsd-3-clause', 'BSD-3-Clause'],
  ['bsd-3-clause license', 'BSD-3-Clause'],
  ['3-clause bsd license', 'BSD-3-Clause'],
  ['3 clause bsd license', 'BSD-3-Clause'],
  ['bsd-2-clause license', 'BSD-2-Clause'],
  ['bsd-2-clause', 'BSD-2-Clause'],
  ['apache-2.0', 'Apache-2.0'],
  ['apache-2.0 license', 'Apache-2.0'],
  ['apache license, version 2.0', 'Apache-2.0'],
  ['cc-by-4.0', 'CC-BY-4.0'],
  ['https://creativecommons.org/licenses/by/4.0/', 'CC-BY-4.0'],
  ['cc-by-nc-sa-4.0', 'CC-BY-NC-SA-4.0'],
  ['cc by-nc-sa 4.0', 'CC-BY-NC-SA-4.0'],
])

/** The `license:` value from a SKILL.md's frontmatter, or null when absent. */
export function readLicense(skillMd) {
  const front = String(skillMd).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!front) return null
  const line = front[1].match(/^license:[ \t]*(.*)$/m)
  if (!line) return null
  return line[1].trim().replace(/^["']|["']$/g, '')
}

/**
 * @returns {{ spdx: string, changed: boolean } | { unresolved: string }}
 * `changed` is true when the stored label differs from the SPDX identifier.
 */
export function normalize(raw) {
  if (raw == null) return { unresolved: 'no license field' }
  const key = raw.trim().toLowerCase()
  if (MAP.has(key)) {
    const spdx = MAP.get(key)
    return { spdx, changed: raw.trim() !== spdx }
  }
  if (key === 'unknown') return { unresolved: 'label is "Unknown"' }
  if (/^gpl|general public license/.test(key)) return { unresolved: 'GPL label, probably the licence of the library the skill teaches, not of the skill text (see NOTICE)' }
  if (/^https?:\/\//.test(key)) return { unresolved: 'a link to a library licence file, not a licence identifier' }
  if (/proprietary/.test(key)) return { unresolved: 'proprietary label' }
  if (/^bsd( license)?$/.test(key)) return { unresolved: 'BSD with no clause count' }
  if (/cecill/.test(key)) return { unresolved: 'CeCILL with no version' }
  return { unresolved: 'free text, not a licence identifier' }
}

/** True for any Creative Commons "NonCommercial" licence label. */
export function isNonCommercial(raw) {
  return raw != null && /\bcc[- ]by[- ]nc\b/i.test(raw)
}

/** Environment switch honoured by the skill seeder and the skill index. */
export function excludeNonCommercial(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.AH_EXCLUDE_NONCOMMERCIAL || ''))
}
