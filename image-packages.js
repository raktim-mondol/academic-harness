/**
 * Package lists for `modal_run` image builds (review A4, decision D31).
 *
 * `image_apt` and `image_pip` become `RUN` lines in a Dockerfile. An entry is data
 * from the model, so it must never be able to add an instruction or a shell
 * command: each one is checked against a strict package-name pattern and then
 * written single-quoted. The patterns accept what real packages look like and
 * nothing else: no whitespace, quotes, `;`, `&`, `|`, `$`, backticks, redirects,
 * option flags, URLs, local paths or direct references. Anything unusual (a VCS
 * install, a private index, environment markers) belongs in the sandbox command,
 * where the person asked for a shell on purpose.
 */

const MAX_ENTRIES = 100
const MAX_LENGTH = 120

// Debian names: lower-case letters, digits, '+', '-', '.'; at least two characters, start with a letter or digit.
// Optional '=version' (Debian version characters) and optional ':arch'.
const APT_NAME = /^[a-z0-9][a-z0-9+.-]+(?:=[A-Za-z0-9.+:~-]+)?(?::[a-z0-9]+)?$/

// PEP 508 subset: name, optional [extras], optional comma-separated version clauses. No markers, no '@' references.
const PIP_CLAUSE = '(?:===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9.*+!_-]+'
const PIP_SPEC = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*(?:\\[[A-Za-z0-9._,-]+\\])?(?:${PIP_CLAUSE}(?:,${PIP_CLAUSE})*)?$`)

function validate(list, pattern, kind) {
  if (list == null) return { ok: true, errors: [] }
  if (!Array.isArray(list)) return { ok: false, errors: [`${kind} must be a list of strings`] }
  if (list.length > MAX_ENTRIES) return { ok: false, errors: [`${kind} has ${list.length} entries (limit ${MAX_ENTRIES})`] }
  const errors = []
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_LENGTH || !pattern.test(entry)) {
      const shown = typeof entry === 'string' ? JSON.stringify(entry.length > 40 ? `${entry.slice(0, 40)}…` : entry) : String(entry)
      errors.push(`${shown} is not a valid ${kind === 'image_apt' ? 'apt package name' : 'pip requirement'}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

export const validateAptPackages = (list) => validate(list, APT_NAME, 'image_apt')
export const validatePipRequirements = (list) => validate(list, PIP_SPEC, 'image_pip')

/** Null when both lists are fine, otherwise one message naming the field and the entry. */
export function checkImagePackages(args) {
  const problems = [
    ...validateAptPackages(args?.image_apt).errors.map((e) => `image_apt: ${e}`),
    ...validatePipRequirements(args?.image_pip).errors.map((e) => `image_pip: ${e}`),
  ]
  if (problems.length === 0) return null
  return `${problems.join('; ')}. Package lists accept plain names, an optional version or extras, and nothing else; `
    + 'put anything more elaborate in the command.'
}

const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`

/** Dockerfile instructions for the validated lists. One instruction per line, every entry single-quoted. */
export function buildImageCommands({ apt, pip } = {}) {
  const lines = []
  if (apt?.length) lines.push(`RUN apt-get update && apt-get install -y ${apt.map(quote).join(' ')} && rm -rf /var/lib/apt/lists/*`)
  if (pip?.length) lines.push(`RUN pip install --no-cache-dir ${pip.map(quote).join(' ')}`)
  return lines
}
