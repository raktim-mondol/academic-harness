/**
 * repo_audit: local/static reproducibility audit of a code repository.
 * No code is executed unless `run_tests: true`. Advisory only — missing
 * metadata is not misconduct, and a passing test run is not full repro.
 *
 * Optional tool: registers only with AH_ENABLE_OPTIONAL_TOOLS=1.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { optionalToolsEnabled } from './optional-tools.js'
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
    const clone = spawnSync('git', ['clone', '--depth', '1', '--quiet', repoUrl, temp], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    if (clone.status !== 0) {
      rmSync(temp, { recursive: true, force: true })
      return { error: `git clone failed: ${String(clone.stderr || clone.stdout || 'unknown error').trim().slice(0, 500)}` }
    }
    dir = temp
  }

  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { error: `not a directory: ${localPath || repoUrl}` }
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
        const result = spawnSync(command[0], command.slice(1), {
          cwd: dir,
          encoding: 'utf8',
          timeout: 300_000,
          maxBuffer: 8 * 1024 * 1024,
        })
        testRun = {
          ran: true,
          command: command.join(' '),
          exit_code: result.status,
          timed_out: result.status === null,
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

function render(value) {
  if (value.error) return [{ type: 'text', text: `Error: ${value.error}` }]
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
  if (!optionalToolsEnabled()) return
  ctx.tools.register(defineTool({
    name: 'repo_audit',
    description: [
      'Audit a code repository for reproducibility metadata: README, LICENSE, dependency/environment file, tests, CI, entry points, data-availability statement, and release tag. Use `path` for a local repo or `repo_url` (https) to clone a public repository into a temporary directory.',
      'Code is never executed unless `run_tests: true`; then the detected test command runs with a timeout and its exit status is reported. GITHUB_TOKEN (env only) is optional and only raises the GitHub API limit.',
      'Advisory checklist, not a reproducibility guarantee: a passing test run does not prove the paper can be reproduced. Optional tool: present only when AH_ENABLE_OPTIONAL_TOOLS=1.',
    ].join(' '),
    parameters: {
      path: { type: 'string', description: 'Local repository path (workspace-relative or absolute).' },
      repo_url: { type: 'string', description: 'Public https repository URL to clone into a temp dir (e.g. https://github.com/owner/repo).' },
      run_tests: { type: 'boolean', description: 'Run the detected test command. Default false.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      return runRepoAudit(args, exec)
    },
    presentCall(args) {
      return { card: 'generic', title: `Repository audit: ${args.path || args.repo_url || ''}`, kind: 'other' }
    },
  }))
}
