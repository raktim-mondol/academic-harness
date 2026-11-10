/**
 * repo_audit: local/static reproducibility audit of a code repository.
 * No code is executed unless `run_tests: true`. Advisory only — missing
 * metadata is not misconduct, and a passing test run is not full repro.
 */
import { spawnSync } from 'node:child_process'
import { baseEnv, repoTestEnv, runCommand } from './safe-process.js'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import vm from 'node:vm'
import { defineTool } from 'ah-dsh-tools'
import { fetchJson, searchUserAgent } from './search-http.js'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', '__pycache__', '.mypy_cache', '.pytest_cache', 'target', 'vendor'])
const README_NAMES = ['README.md', 'README.rst', 'README.txt', 'README', 'readme.md']
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'COPYING.md']
const ENV_NAMES = [
  'requirements.txt', 'pyproject.toml', 'environment.yml', 'environment.yaml', 'setup.py',
  'setup.cfg', 'package.json', 'renv.lock', 'Project.toml', 'Cargo.toml', 'go.mod', 'Dockerfile',
]
const CI_PATHS = [
  '.github/workflows', '.gitlab-ci.yml', '.travis.yml', 'azure-pipelines.yml', 'Jenkinsfile',
  '.circleci/config.yml', '.buildkite/pipeline.yml', '.drone.yml',
]
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'testdata'])
const TEST_FILE = /^(test_.*\.py|.*_test\.py|.*\.test\.(js|ts|jsx|tsx|mjs|cjs)|.*_test\.go|test_.*\.r|.*\.spec\.(js|ts)|\w+Test\.(java|kt|scala))$/

export const REPO_ACTIONS = ['audit', 'probe', 'align']
export const ANCHOR_KINDS = ['equation', 'symbol', 'constant', 'default', 'other']
const CODE_EXTS = new Set([
  '.py', '.pyx', '.r', '.jl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs',
  '.java', '.kt', '.scala', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cu', '.cuh',
  '.sql', '.sh', '.bash', '.yaml', '.yml', '.toml', '.json', '.cfg', '.ini',
])
const CODE_NAMES = new Set(['Makefile', 'makefile', 'Dockerfile', 'Justfile', 'justfile'])
const MAX_ALIGN_FILES = 4000
const MAX_ALIGN_FILE_BYTES = 1024 * 1024
const MAX_ALIGN_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_ANCHORS = 50
const MAX_MATCHES_PER_ANCHOR = 50
const MAX_PATTERN_LENGTH = 500
const MAX_PATTERN_MS = 2000

function text(value) {
  return String(value ?? '').trim()
}

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function existsAny(dir, names) {
  return names.find((name) => existsSync(join(dir, name))) || null
}

function listdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function findTests(dir, depth = 0, found = []) {
  if (depth > 3 || found.length >= 20) return found
  for (const entry of listdirSafe(dir)) {
    if (found.length >= 20) break
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (TEST_DIRS.has(entry.name)) found.push(join(dir, entry.name))
      else findTests(join(dir, entry.name), depth + 1, found)
    } else if (TEST_FILE.test(entry.name) && !found.includes(dir)) {
      found.push(dir)
    }
  }
  return [...new Set(found)].slice(0, 10)
}

function findEntryPoints(dir) {
  const entries = []
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.main) entries.push(`package.json main: ${pkg.main}`)
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') entries.push(`package.json bin: ${pkg.bin}`)
        else entries.push(...Object.values(pkg.bin).map((value) => `package.json bin: ${value}`))
      }
    } catch {
      // malformed package.json is reported by the environment check instead
    }
  }
  for (const name of ['src', 'src/main.py', '__main__.py', 'cli.py', 'main.py', 'main.go', 'cmd']) {
    if (existsSync(join(dir, name))) entries.push(name)
  }
  const pyproject = join(dir, 'pyproject.toml')
  if (existsSync(pyproject) && /\[project\.scripts\]|\[tool\.poetry\.scripts\]/.test(readFileSync(pyproject, 'utf8'))) {
    entries.push('pyproject script entry points')
  }
  return [...new Set(entries)].slice(0, 10)
}

function readmeText(dir, readme) {
  if (!readme) return ''
  try {
    return readFileSync(join(dir, readme), 'utf8')
  } catch {
    return ''
  }
}

const BENCHMARK_NAME = /(bench|benchmark|eval|evaluate|repro|reproduce|experiment|train)/i
const RUN_TARGET = /^(all|run|test|bench|benchmark|eval|evaluate|repro|reproduce|experiment|train)([-_:].*)?$/i

function packageScripts(dir) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {}
    return Object.entries(scripts)
      .filter(([name]) => RUN_TARGET.test(name) || BENCHMARK_NAME.test(name))
      .map(([name, body]) => ({
        kind: 'package-script',
        entrypoint: `package.json scripts.${name}`,
        command: `npm run ${name}`,
        benchmark: BENCHMARK_NAME.test(name) || BENCHMARK_NAME.test(String(body)),
        evidence: String(body).slice(0, 200),
      }))
  } catch {
    return []
  }
}

function pyprojectScripts(dir) {
  const file = join(dir, 'pyproject.toml')
  if (!existsSync(file)) return []
  try {
    const body = readFileSync(file, 'utf8')
    const section = body.match(/\[(?:project\.scripts|tool\.poetry\.scripts)\]([\s\S]*?)(?:\n\[|$)/)
    if (!section) return []
    return [...section[1].matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"/gm)]
      .map((match) => ({
        kind: 'pyproject-script',
        entrypoint: `pyproject.toml ${match[1]}`,
        command: match[1],
        benchmark: BENCHMARK_NAME.test(match[1]) || BENCHMARK_NAME.test(match[2]),
        evidence: match[2],
      }))
  } catch {
    return []
  }
}

function makeTargets(dir) {
  const makefile = existsAny(dir, ['Makefile', 'makefile'])
  if (!makefile) return []
  try {
    const body = readFileSync(join(dir, makefile), 'utf8')
    return [...body.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)]
      .map((match) => match[1])
      .filter((name) => RUN_TARGET.test(name))
      .map((name) => ({
        kind: 'make-target',
        entrypoint: `${makefile}:${name}`,
        command: `make ${name}`,
        benchmark: BENCHMARK_NAME.test(name),
      }))
  } catch {
    return []
  }
}

function scriptCandidates(dir) {
  const candidates = []
  const roots = [dir, join(dir, 'scripts'), join(dir, 'bin')]
  const names = ['main.py', 'run.py', 'train.py', 'eval.py', 'evaluate.py', 'benchmark.py', 'bench.py', 'reproduce.py', 'repro.py']
  for (const root of roots) {
    for (const name of names) {
      const abs = join(root, name)
      if (!existsSync(abs)) continue
      const rel = abs.slice(dir.length + 1)
      candidates.push({
        kind: 'script',
        entrypoint: rel,
        command: `python3 ${rel}`,
        benchmark: BENCHMARK_NAME.test(name),
      })
    }
    if (root === dir || !existsSync(root)) continue
    for (const entry of listdirSafe(root)) {
      if (!entry.isFile()) continue
      if (!/\.(sh|bash)$/.test(entry.name) && !/\.(py|r|R|jl)$/.test(entry.name)) continue
      if (entry.name.startsWith('test_') || /_test\.py$/.test(entry.name)) continue
      const rel = join(root, entry.name).slice(dir.length + 1)
      candidates.push({
        kind: 'script',
        entrypoint: rel,
        command: entry.name.endsWith('.py') ? `python3 ${rel}`
          : entry.name.endsWith('.R') || entry.name.endsWith('.r') ? `Rscript ${rel}`
            : entry.name.endsWith('.jl') ? `julia ${rel}`
              : `bash ${rel}`,
        benchmark: BENCHMARK_NAME.test(entry.name),
      })
    }
  }
  return candidates
}

function dockerCommand(dir) {
  const dockerfile = existsAny(dir, ['Dockerfile'])
  if (!dockerfile) return []
  try {
    const body = readFileSync(join(dir, dockerfile), 'utf8')
    const match = body.match(/^\s*(CMD|ENTRYPOINT)\s+(.+)$/m)
    if (!match) return []
    return [{
      kind: 'docker',
      entrypoint: `${dockerfile} ${match[1]}`,
      command: match[2].replace(/^\[|\]$/g, '').replace(/"/g, '').trim(),
      benchmark: BENCHMARK_NAME.test(match[2]),
    }]
  } catch {
    return []
  }
}

function readmeCommands(dir, readme) {
  const body = readmeText(dir, readme)
  if (!body) return []
  const out = []
  const seen = new Set()
  let fenced = false
  for (const raw of body.split('\n')) {
    const trimmed = raw.trim()
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced
      continue
    }
    const prompted = /^\$\s+/.test(trimmed)
    if (!fenced && !prompted) continue
    const line = trimmed.replace(/^\$\s+/, '')
    if (!line || line.length > 240) continue
    if (!/^(python3?|uv run|poetry run|pipenv run|pixi run|bash|sh|make|npm|pnpm|yarn|npx|Rscript|R CMD|julia)\b/.test(line)) continue
    // Require a command shape: a flag, a path/script, or a known target. Prose
    // such as "Python is ..." or "make sure ..." must not flip probe to yes.
    if (!/[\s](--?\S+|\.{0,2}\/\S+|\S+\.(py|sh|r|jl|ipynb|js|ts|mjs|cjs)\b|(bench|benchmark|eval|evaluate|repro|reproduce|experiment|train|test|run|all)\b)/i.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push({
      kind: 'readme-command',
      entrypoint: readme,
      command: line,
      benchmark: BENCHMARK_NAME.test(line),
      evidence: line,
    })
    if (out.length >= 20) break
  }
  return out
}

function probeRepo(dir, display) {
  const readme = existsAny(dir, README_NAMES)
  const candidates = [
    ...packageScripts(dir),
    ...pyprojectScripts(dir),
    ...makeTargets(dir),
    ...scriptCandidates(dir),
    ...dockerCommand(dir),
    ...readmeCommands(dir, readme),
  ]
  const seen = new Set()
  const unique = candidates.filter((candidate) => {
    const key = candidate.command
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const benchmark = unique.filter((candidate) => candidate.benchmark)
  const potential = findEntryPoints(dir)
  const runnable = unique.length ? 'yes' : (potential.length ? 'unknown' : 'no')
  const offers = benchmark.length ? 'yes' : unique.length ? 'maybe' : 'no'
  return {
    action: 'probe',
    repo: display,
    audit_dir: dir,
    commit: git(dir, ['rev-parse', '--short', 'HEAD']),
    runnable,
    has_benchmark_entrypoint: benchmark.length > 0,
    offers_re_execution: offers,
    candidates: unique.slice(0, 30),
    benchmark_candidates: benchmark.slice(0, 20),
    potential_entrypoints: potential,
    recommendation: offers === 'yes'
      ? 'A benchmark-like entrypoint exists; freeze an analysis plan and use action=expect + verify_scores to compare reported numbers with a re-execution.'
      : offers === 'maybe'
        ? 'A command entrypoint exists but none names a benchmark/evaluation; confirm which command reproduces the reported numbers before declaring expectations.'
        : 'No runnable command was found; verify_scores would be not_checked until the repository documents an entrypoint.',
    advisory: 'Static probe only: nothing was executed, and a detected command is not proof that it reproduces the reported numbers.',
  }
}

function within(root, target) {
  return target === root || target.startsWith(`${root}${sep}`)
}

/**
 * The single predicate for "is this align-scannable content?". Both the full
 * walk and a requested single file use it, so `file:` cannot widen the scan to
 * manuscript prose (a claim lifted from README.md is not evidence).
 */
function isCodeConfigFile(name) {
  return CODE_EXTS.has(`.${name.split('.').pop()}`.toLowerCase()) || CODE_NAMES.has(name)
}

function walkCodeFiles(dir, only = null) {
  if (only) {
    const root = resolve(dir)
    const target = resolve(root, only)
    if (!within(root, target)) return []
    if (!isCodeConfigFile(basename(target))) return []
    let real
    let realRoot
    try {
      real = realpathSync(target)
      realRoot = realpathSync(root)
    } catch {
      return []
    }
    if (!within(realRoot, real)) return []
    try {
      const info = lstatSync(target)
      return info.isFile() && !info.isSymbolicLink() ? [target] : []
    } catch {
      return []
    }
  }
  const found = []
  const visit = (current, depth) => {
    if (found.length >= MAX_ALIGN_FILES || depth > 8) return
    for (const entry of listdirSafe(current)) {
      if (found.length >= MAX_ALIGN_FILES) break
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        visit(join(current, entry.name), depth + 1)
        continue
      }
      if (entry.isSymbolicLink() || !entry.isFile()) continue
      if (isCodeConfigFile(entry.name)) {
        found.push(join(current, entry.name))
      }
    }
  }
  visit(dir, 0)
  return found
}

function normalizeAnchors(input) {
  let anchors = input
  if (typeof anchors === 'string') {
    try {
      anchors = JSON.parse(anchors)
    } catch (error) {
      throw new Error(`anchors is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!Array.isArray(anchors) || !anchors.length) throw new Error('align requires a non-empty anchors array')
  if (anchors.length > MAX_ANCHORS) throw new Error(`at most ${MAX_ANCHORS} anchors are accepted`)
  return anchors.map((raw, index) => {
    const name = `anchors[${index}]`
    const anchor = typeof raw === 'string' ? { text: raw } : raw
    if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) throw new Error(`${name} must be an object or string`)
    const literal = text(anchor.text)
    const pattern = text(anchor.pattern)
    if (!literal && !pattern) throw new Error(`${name} needs text (literal) or pattern (regular expression)`)
    if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`${name}.pattern is longer than ${MAX_PATTERN_LENGTH} characters`)
    const kind = text(anchor.kind).toLowerCase() || 'other'
    if (!ANCHOR_KINDS.includes(kind)) throw new Error(`${name}.kind must be one of ${ANCHOR_KINDS.join(', ')}`)
    const file = text(anchor.file)
    if (file && (file.startsWith('/') || file.includes('..'))) throw new Error(`${name}.file must be repository-relative without ".."`)
    return {
      id: text(anchor.id) || `a${index + 1}`,
      kind,
      label: text(anchor.label) || literal || pattern,
      text: literal || null,
      pattern: pattern || null,
      file: file || null,
      claim: text(anchor.claim) || null,
    }
  })
}

function readAlignFiles(dir, only) {
  const files = []
  let skipped = 0
  let total = 0
  for (const abs of walkCodeFiles(dir, only)) {
    let size
    try {
      size = statSync(abs).size
    } catch {
      skipped += 1
      continue
    }
    if (size > MAX_ALIGN_FILE_BYTES || total + size > MAX_ALIGN_TOTAL_BYTES) {
      skipped += 1
      continue
    }
    let body
    try {
      body = readFileSync(abs, 'utf8')
    } catch {
      skipped += 1
      continue
    }
    files.push({ rel: abs.slice(dir.length + 1).replace(/\\/g, '/'), lines: body.split('\n') })
    total += size
  }
  return { files, skipped }
}

function literalMatches(files, source, flags, limit) {
  const regex = new RegExp(source, flags)
  const out = []
  for (const file of files) {
    for (let index = 0; index < file.lines.length; index += 1) {
      if (out.length >= limit) return out
      const match = regex.exec(file.lines[index])
      if (!match) continue
      out.push({ file: file.rel, line: index + 1, column: match.index + 1, text: file.lines[index].trim().slice(0, 300) })
    }
  }
  return out
}

/**
 * Caller-supplied patterns run in a vm with a hard timeout: a catastrophic
 * backtracking pattern is not_checked, not a hung tool.
 */
function patternMatches(files, pattern, flags, limit) {
  const script = new vm.Script(`(() => {
    const re = new RegExp(pattern, flags);
    const out = [];
    for (const file of files) {
      for (let index = 0; index < file.lines.length; index += 1) {
        if (out.length >= limit) return out;
        const match = re.exec(file.lines[index]);
        if (match) out.push({ file: file.rel, line: index + 1, column: match.index + 1, text: file.lines[index].trim().slice(0, 300) });
      }
    }
    return out;
  })()`)
  const context = vm.createContext({ files, pattern, flags, limit })
  return script.runInContext(context, { timeout: MAX_PATTERN_MS })
}

function alignRepo(dir, args, display) {
  const anchors = normalizeAnchors(args.anchors)
  const flags = args.case_sensitive === true ? '' : 'i'
  const requestedFile = text(args.file) || null
  const { files, skipped } = readAlignFiles(dir, requestedFile)
  // A requested file that was never read (outside the repository, a symlink
  // escape, missing, unreadable, oversized, or not code/config) means no
  // content informed these anchors: report not_checked for every anchor rather
  // than asserting the method is absent from the code.
  const scanRefused = Boolean(requestedFile) && files.length === 0
  const results = anchors.map((anchor) => {
    if (scanRefused) {
      return {
        ...anchor, status: 'not_checked', matches: [],
        reason: `${requestedFile} was not scanned (not a code/config file, not found, unreadable, oversized, or outside the repository)`,
      }
    }
    const targetFiles = anchor.file ? files.filter((file) => file.rel === anchor.file) : files
    if (anchor.file && !targetFiles.length) {
      return {
        ...anchor, status: 'not_checked', matches: [],
        reason: `${anchor.file} was not scanned (not a code/config file, unreadable, oversized, or outside the repository)`,
      }
    }
    try {
      const matches = anchor.pattern
        ? patternMatches(targetFiles, anchor.pattern, flags, MAX_MATCHES_PER_ANCHOR)
        : literalMatches(targetFiles, anchor.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags, MAX_MATCHES_PER_ANCHOR)
      return { ...anchor, status: null, matches }
    } catch (error) {
      const timeout = error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      return {
        ...anchor, status: 'not_checked', matches: [],
        reason: timeout
          ? `pattern exceeded the ${MAX_PATTERN_MS}ms budget; simplify it`
          : `invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  })

  const bindCalls = []
  const anchorsOut = results.map((anchor) => {
    if (anchor.status === 'not_checked') return anchor
    const status = !anchor.matches.length ? 'missing' : anchor.matches.length === 1 ? 'verified' : 'ambiguous'
    if (status === 'verified') {
      const match = anchor.matches[0]
      bindCalls.push({
        claim: anchor.claim || anchor.label,
        kind: anchor.kind,
        anchor_id: anchor.id,
        source: match.file,
        lines: `${match.line}-${match.line}`,
        quote: match.text,
      })
    }
    return {
      ...anchor,
      status,
      reason: status === 'missing'
        ? 'the anchor text was not found in any scanned code/config file'
        : status === 'ambiguous'
          ? `${anchor.matches.length} matches; narrow with file or a longer text before binding`
          : null,
    }
  })
  const counts = {
    verified: anchorsOut.filter((entry) => entry.status === 'verified').length,
    ambiguous: anchorsOut.filter((entry) => entry.status === 'ambiguous').length,
    missing: anchorsOut.filter((entry) => entry.status === 'missing').length,
    not_checked: anchorsOut.filter((entry) => entry.status === 'not_checked').length,
  }
  return {
    action: 'align',
    repo: display,
    audit_dir: dir,
    commit: git(dir, ['rev-parse', '--short', 'HEAD']),
    scanned_files: files.length,
    skipped_files: skipped,
    counts,
    anchors: anchorsOut,
    bind_calls: bindCalls,
    next: 'Pass each bind_calls entry to ah_claims_bind as {claim, source, lines} (optionally with auto/fact); repo_audit writes nothing and never edits the manuscript.',
    advisory: 'Anchors are literal/regex matches at file:line, not a semantic proof that the code implements the method. A verified anchor still needs the author to confirm the mapping.',
  }
}

function git(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 30_000 })
  return result.status === 0 ? String(result.stdout || '').trim() : null
}

function detectTestCommand(dir, hasTests) {
  const pkgPath = join(dir, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.scripts?.test) return ['npm', 'test', '--silent']
    } catch {
      // fall through to Python
    }
  }
  if (hasTests && (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'requirements.txt')) || existsSync(join(dir, 'setup.py')))) {
    return ['python3', '-m', 'pytest', '-q']
  }
  if (existsSync(join(dir, 'Cargo.toml'))) return ['cargo', 'test', '--quiet']
  if (existsSync(join(dir, 'go.mod'))) return ['go', 'test', './...']
  return null
}

function parseRepoUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('repo_url must be an https:// URL')
  const [owner, repo] = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '').split('/')
  return { url: url.toString(), owner, repo }
}

async function githubMetadata(repoUrl, deps) {
  if (!repoUrl) return null
  let parsed
  try {
    parsed = parseRepoUrl(repoUrl)
  } catch {
    return { error: 'invalid repo_url' }
  }
  if (!parsed.owner || !parsed.repo) return { error: 'repo_url must look like https://github.com/owner/repo' }
  const http = deps.fetchJson || fetchJson
  const headers = { 'User-Agent': searchUserAgent(), Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const result = await http(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, { headers, timeoutMs: 15_000, retries: 1 })
  if (!result.ok) return { error: `GitHub API error ${result.status}`, status: result.status }
  return {
    full_name: result.data?.full_name || null,
    stars: result.data?.stargazers_count ?? null,
    license: result.data?.license?.spdx_id || null,
    open_issues: result.data?.open_issues_count ?? null,
    pushed_at: result.data?.pushed_at || null,
    url: result.data?.html_url || parsed.url,
  }
}

export async function runRepoAudit(args, exec, deps = {}) {
  const action = text(args.action) || 'audit'
  if (!REPO_ACTIONS.includes(action)) return { error: `action must be one of ${REPO_ACTIONS.join(', ')}` }
  const cwd = workspaceRoot(exec)
  const localPath = String(args.path || '').trim()
  const repoUrl = String(args.repo_url || '').trim()
  if (!localPath && !repoUrl) return { error: 'give a path or repo_url' }
  let dir = localPath ? (localPath.startsWith('/') ? resolve(localPath) : resolve(cwd, localPath)) : null
  let temp = null

  if (repoUrl) {
    try {
      parseRepoUrl(repoUrl)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    temp = mkdtempSync(join(tmpdir(), 'ah-repo-audit-'))
    const clone = await runCommand('git', ['clone', '--depth', '1', '--quiet', repoUrl, temp], {
      env: { ...baseEnv(true), GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: 120_000,
      signal: exec?.signal,
    })
    if (clone.status !== 0) {
      rmSync(temp, { recursive: true, force: true })
      const why = clone.timedOut ? 'timed out' : clone.aborted ? 'cancelled' : (clone.stderr || clone.stdout || clone.error || 'unknown error').trim()
      return { error: `git clone failed: ${String(why).slice(0, 500)}` }
    }
    dir = temp
  }

  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { error: `not a directory: ${localPath || repoUrl}` }
    if (action === 'probe') return probeRepo(dir, localPath || repoUrl)
    if (action === 'align') return alignRepo(dir, args, localPath || repoUrl)
    const readme = existsAny(dir, README_NAMES)
    const license = existsAny(dir, LICENSE_NAMES)
    const environment = existsAny(dir, ENV_NAMES)
    const ci = CI_PATHS.filter((name) => existsSync(join(dir, name)))
    const tests = findTests(dir)
    const entryPoints = findEntryPoints(dir)
    const readmeBody = readmeText(dir, readme)
    const dataAvailability = Boolean(
      /data availability|availability of data|data are available|data can be (found|obtained)/i.test(readmeBody)
      || existsAny(dir, ['DATA_AVAILABILITY.md', 'DataAvailability.md']),
    )
    const tags = git(dir, ['tag', '--list', '--sort=-creatordate'])
    const topTag = tags ? tags.split('\n').filter(Boolean)[0] || null : null
    const commit = git(dir, ['rev-parse', '--short', 'HEAD'])

    let testRun = { ran: false }
    if (args.run_tests) {
      const command = detectTestCommand(dir, tests.length > 0)
      if (!command) testRun = { ran: false, reason: 'no test command detected' }
      else {
        // The repository is not trusted code: run its tests with an allowlisted
        // environment (no API keys), asynchronously, and kill the whole process
        // group on timeout or cancel.
        const result = await runCommand(command[0], command.slice(1), {
          cwd: dir,
          env: repoTestEnv(true),
          timeoutMs: 300_000,
          signal: exec?.signal,
        })
        testRun = {
          ran: true,
          command: command.join(' '),
          exit_code: result.status,
          timed_out: result.timedOut,
          ...(result.aborted ? { cancelled: true } : {}),
          ...(result.error ? { error: result.error } : {}),
          stdout_tail: String(result.stdout || '').slice(-3000),
          stderr_tail: String(result.stderr || '').slice(-2000),
        }
      }
    }

    const reproducibility = []
    if (!readme) reproducibility.push('No README found (how to install/run is undocumented).')
    if (!license) reproducibility.push('No LICENSE file found.')
    if (!environment) reproducibility.push('No dependency/environment file found.')
    if (!tests.length) reproducibility.push('No test directory or test files found.')
    if (!ci.length) reproducibility.push('No CI configuration found.')
    if (!entryPoints.length) reproducibility.push('No obvious entry point found.')
    if (!dataAvailability) reproducibility.push('No data-availability statement found in the README.')
    if (!topTag) reproducibility.push('No git tag/release found.')
    if (!args.run_tests) reproducibility.push('Tests were not executed (run_tests: false).')

    return {
      action: 'audit',
      repo: localPath || repoUrl,
      audit_dir: temp ? '(temporary clone)' : dir,
      commit,
      checks: {
        readme: { ok: Boolean(readme), evidence: readme },
        license: { ok: Boolean(license), evidence: license },
        environment: { ok: Boolean(environment), evidence: environment },
        tests: { ok: tests.length > 0, evidence: tests },
        ci: { ok: ci.length > 0, evidence: ci },
        entry_points: { ok: entryPoints.length > 0, evidence: entryPoints },
        data_availability: { ok: dataAvailability },
        release: { ok: Boolean(topTag), evidence: topTag },
      },
      run_tests: testRun,
      github: await githubMetadata(repoUrl, deps),
      reproducibility_notes: reproducibility,
      advisory: 'Static checklist only; a passing test run does not prove full reproducibility.',
    }
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true })
  }
}

function renderProbe(value) {
  const lines = [
    `Repository probe: ${value.repo}${value.commit ? ` @ ${value.commit}` : ''}`,
    `Runnable: ${value.runnable} · benchmark entrypoint: ${value.has_benchmark_entrypoint ? 'yes' : 'no'} · offers re-execution: ${value.offers_re_execution}`,
  ]
  if (value.candidates.length) {
    lines.push('', 'Candidates:')
    for (const candidate of value.candidates) {
      lines.push(`- ${candidate.command}${candidate.benchmark ? ' [benchmark-like]' : ''} · ${candidate.kind} · ${candidate.entrypoint}${candidate.evidence ? ` — ${candidate.evidence}` : ''}`)
    }
  } else if (value.potential_entrypoints.length) {
    lines.push('', `Potential entrypoints (no documented command): ${value.potential_entrypoints.join(', ')}`)
  }
  lines.push('', value.recommendation, value.advisory)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderAlign(value) {
  const scan = value.scanned_files
    ? `${value.scanned_files} code/config file(s) scanned${value.skipped_files ? `, ${value.skipped_files} skipped by the size budget` : ''}`
    : `no code/config file was scanned${value.skipped_files ? ` (${value.skipped_files} skipped by the size budget)` : ''}`
  const lines = [
    `Method–code alignment: ${value.repo}${value.commit ? ` @ ${value.commit}` : ''} · ${scan}`,
    `${value.counts.verified} verified · ${value.counts.ambiguous} ambiguous · ${value.counts.missing} missing${value.counts.not_checked ? ` · ${value.counts.not_checked} not checked` : ''}.`,
  ]
  for (const anchor of value.anchors) {
    lines.push('', `- [${anchor.status}] ${anchor.id} (${anchor.kind}) ${anchor.label}${anchor.reason ? ` — ${anchor.reason}` : ''}`)
    for (const match of anchor.matches.slice(0, 5)) {
      lines.push(`    ${match.file}:${match.line}:${match.column} — ${match.text}`)
    }
    if (anchor.matches.length > 5) lines.push(`    …${anchor.matches.length - 5} more`)
  }
  if (value.bind_calls.length) {
    lines.push('', `Ready to bind (${value.bind_calls.length}):`)
    for (const call of value.bind_calls) lines.push(`- ${call.claim} → ${call.source}:${call.lines}`)
  }
  lines.push('', value.next, value.advisory)
  return [{ type: 'text', text: lines.join('\n') }]
}

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  if (value.action === 'probe') return renderProbe(value)
  if (value.action === 'align') return renderAlign(value)
  const lines = [`Repository audit: ${value.repo}${value.commit ? ` @ ${value.commit}` : ''}`]
  for (const [name, check] of Object.entries(value.checks)) {
    const evidence = Array.isArray(check.evidence) ? check.evidence.join(', ') : check.evidence
    lines.push(`- ${check.ok ? 'OK' : 'MISSING'} · ${name}${evidence ? ` — ${evidence}` : ''}`)
  }
  if (value.run_tests.ran) {
    lines.push('', `Tests: \`${value.run_tests.command}\` exited ${value.run_tests.exit_code}${value.run_tests.timed_out ? ' (timed out)' : ''}`)
    if (value.run_tests.stderr_tail) lines.push(`stderr (tail): ${value.run_tests.stderr_tail.slice(-800)}`)
  } else {
    lines.push('', `Tests: not run${value.run_tests.reason ? ` (${value.run_tests.reason})` : ''}.`)
  }
  if (value.github && !value.github.error) {
    lines.push('', `GitHub: ${value.github.full_name || ''} · ${value.github.stars ?? '?'} stars · ${value.github.license || 'no license'} · pushed ${value.github.pushed_at || 'unknown'}`)
  } else if (value.github?.error) {
    lines.push('', `GitHub metadata: ${value.github.error}`)
  }
  if (value.reproducibility_notes.length) {
    lines.push('', 'Reproducibility notes:')
    for (const note of value.reproducibility_notes) lines.push(`- ${note}`)
  }
  lines.push('', value.advisory)
  return [{ type: 'text', text: lines.join('\n') }]
}

export const name = 'academic-harness-repo-audit'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'repo_audit',
    description: [
      'Audit a code repository for reproducibility metadata: README, LICENSE, dependency/environment file, tests, CI, entry points, data-availability statement, and release tag. Use `path` for a local repo or `repo_url` (https) to clone a public repository into a temporary directory.',
      '`action: "probe"` is a cheap static check for a runnable benchmark entrypoint: package/pyproject scripts, Makefile targets, top-level run/eval/benchmark scripts, Docker CMD, and fenced README commands (prose is ignored). It reports runnable yes/no/unknown and offers_re_execution yes/maybe/no, and executes nothing — the precursor that decides whether `analysis_run action=expect` + `verify_scores` is worth declaring.',
      '`action: "align"` maps method-section anchors to verified `file:line` locations: pass `anchors` as `[{id?, kind: equation|symbol|constant|default|other, text|pattern, file?, claim?}]`; each anchor is reported verified (exactly one match), ambiguous (several), missing, or not_checked (invalid pattern, unscanned file, or a pattern over its time budget), and each verified match yields a `bind_calls` entry `{claim, source, lines}` for `ah_claims_bind`. Scans are repository-confined, skip symlinks and oversized files, and run patterns in a vm with a hard timeout. It writes nothing and never edits the manuscript; a match is a location, not proof that the code implements the method.',
      'Code is never executed unless `run_tests: true`; then the detected test command runs with a timeout and its exit status is reported. GITHUB_TOKEN (env only) is optional and only raises the GitHub API limit.',
      'Advisory checklist, not a reproducibility guarantee: a passing test run does not prove the paper can be reproduced, a probe hit is not proof the command works, and an alignment anchor is not a semantic proof.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: REPO_ACTIONS, description: 'audit (default), probe (benchmark entrypoint check), or align (method anchors to file:line).' },
      path: { type: 'string', description: 'Local repository path (workspace-relative or absolute).' },
      repo_url: { type: 'string', description: 'Public https repository URL to clone into a temp dir (e.g. https://github.com/owner/repo).' },
      run_tests: { type: 'boolean', description: 'Run the detected test command. Default false.' },
      anchors: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'align: method anchors, each {id?, kind: equation|symbol|constant|default|other, text (literal) or pattern (regex), file? (repository-relative), claim? (the manuscript claim to bind)}.',
      },
      file: { type: 'string', description: 'align: restrict the scan to one repository-relative code/config file. A file that is not code/config (e.g. a README) is not read, so its anchors are reported not_checked. Default: all code/config files.' },
      case_sensitive: { type: 'boolean', description: 'align: case-sensitive matching. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runRepoAudit(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Repository ${args.action || 'audit'}: ${args.path || args.repo_url || ''}`, kind: 'other' }
    },
  }))
}
