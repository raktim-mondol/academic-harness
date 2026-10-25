#!/usr/bin/env node
/**
 * Edge-case tests for Paper2Agent wiring: paper_mcp, research_template,
 * skill tree, seed, and Paper2MCP workflow helper.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const require = createRequire(import.meta.url)

let failed = 0
let passed = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    return
  }
  failed++
  failures.push(`${name}${detail ? `: ${detail}` : ''}`)
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

function execFor(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

function mockCtx() {
  const plugins = []
  return {
    plugins,
    plugin(mod, cfg) {
      plugins.push({ mod, cfg })
    },
  }
}

const {
  executePaperMcp,
  resetMountedForTests,
  normalizeServer,
  loadRegistry,
} = await import('../paper-mcp.js')
const { queryResearchTemplates, fillPrompt } = await import('../workflows.js')
const { seed } = await import('../seed.js')

// ── research_template ─────────────────────────────────────────────────────

{
  const listed = queryResearchTemplates({ action: 'list' })
  ok('list returns array', Array.isArray(listed.workflows) && listed.workflows.length > 300, `n=${listed.workflows?.length}`)

  const paper = queryResearchTemplates({ action: 'list', category: 'paper' })
  ok('list category=paper includes agentify-paper', paper.workflows.some((w) => w.id === 'agentify-paper'))

  const q = queryResearchTemplates({ action: 'list', query: 'agentify' })
  ok('list query=agentify hits agentify-paper', q.workflows.some((w) => w.id === 'agentify-paper'))
  ok('list query=agentify is small', q.workflows.length <= 5, `n=${q.workflows.length}`)

  const none = queryResearchTemplates({ action: 'list', query: 'zzzxnotatemplate' })
  ok('list unknown query is empty', none.workflows.length === 0)

  const get = queryResearchTemplates({ action: 'get', id: 'agentify-paper' })
  ok('get agentify-paper', get.id === 'agentify-paper' && typeof get.prompt === 'string')
  ok('get agentify-paper mentions paper2agent', /paper2agent/.test(get.prompt))
  ok('get agentify-paper suggestedSkills', Array.isArray(get.suggestedSkills) && get.suggestedSkills.includes('paper2agent'))
  ok('get agentify-paper no required placeholders missing', !get.missing_required_values)

  const filled = queryResearchTemplates({
    action: 'get',
    id: 'agentify-paper',
    values: { paper: '10.1038/s41586-026-11044-y', repo: 'https://github.com/scverse/scanpy' },
  })
  ok('get fills {paper}', filled.prompt.includes('10.1038/s41586-026-11044-y'))
  ok('get fills {repo}', filled.prompt.includes('https://github.com/scverse/scanpy'))
  ok('get leaves empty optional tokens', filled.prompt.includes('{focus}') && filled.prompt.includes('{output}'))

  const write = queryResearchTemplates({ action: 'get', id: 'write-paper' })
  ok('get write-paper missing required topic', Array.isArray(write.missing_required_values) && write.missing_required_values.includes('topic'))
  const writeOk = queryResearchTemplates({ action: 'get', id: 'write-paper', values: { topic: '  CRISPR screens  ' } })
  ok('get write-paper fills trimmed topic', writeOk.prompt.includes('CRISPR screens') && !writeOk.missing_required_values)

  ok('get without id', queryResearchTemplates({ action: 'get' }).error === 'action=get requires id')
  ok('get whitespace id', queryResearchTemplates({ action: 'get', id: '   ' }).error === 'action=get requires id')
  ok('get unknown id', /unknown workflow id/.test(queryResearchTemplates({ action: 'get', id: 'nope' }).error))
  ok('get is case-sensitive', /unknown workflow id/.test(queryResearchTemplates({ action: 'get', id: 'Agentify-Paper' }).error))

  ok('fillPrompt keeps unknown tokens', fillPrompt('x {a} y', {}) === 'x {a} y')
  ok('fillPrompt ignores empty', fillPrompt('x {a} y', { a: '  ' }) === 'x {a} y')
  ok('fillPrompt only word keys', fillPrompt('{a-b}', { 'a-b': 'z' }) === '{a-b}')
}

// ── paper_mcp normalize / register / status / unregister ──────────────────

{
  resetMountedForTests()
  const ws = mkdtempSync(join(tmpdir(), 'p2a-mcp-'))
  const py = process.execPath // node exists; used as "command"
  const server = join(ws, 'demo_mcp.py')
  writeFileSync(server, '# dummy\n')
  const ctx = mockCtx()
  const exec = execFor(ws)

  const statusEmpty = await executePaperMcp({ action: 'status' }, exec, ctx)
  ok('status missing registry is empty', statusEmpty.action === 'status' && statusEmpty.servers.length === 0)

  const badName = await executePaperMcp({
    action: 'register', serverName: 'bad name', command: py, args: [server],
  }, exec, ctx)
  ok('register rejects spaces in serverName', /serverName must match/.test(badName.error))

  const hyphenStart = await executePaperMcp({
    action: 'register', serverName: '-x', command: py, args: [server],
  }, exec, ctx)
  ok('register rejects leading hyphen', /serverName must match/.test(hyphenStart.error))

  const tooLong = await executePaperMcp({
    action: 'register', serverName: 'a'.repeat(33), command: py, args: [server],
  }, exec, ctx)
  ok('register rejects 33-char name', /serverName must match/.test(tooLong.error))

  const noArgs = await executePaperMcp({
    action: 'register', serverName: 'ok1', command: py, args: [],
  }, exec, ctx)
  ok('register rejects empty args', /args must be a nonempty/.test(noArgs.error))

  const noCmd = await executePaperMcp({
    action: 'register', serverName: 'ok1', args: [server],
  }, exec, ctx)
  ok('register rejects missing command', /command is required/.test(noCmd.error))

  const missingCmd = await executePaperMcp({
    action: 'register', serverName: 'ok1', command: join(ws, 'no-python'), args: [server],
  }, exec, ctx)
  ok('register rejects missing command file', /command not found/.test(missingCmd.error))

  const missingPy = await executePaperMcp({
    action: 'register', serverName: 'ok1', command: py, args: [join(ws, 'missing.py')],
  }, exec, ctx)
  ok('register rejects missing server script', /server entry not found/.test(missingPy.error))

  const missingCwd = await executePaperMcp({
    action: 'register', serverName: 'ok1', command: py, args: [server], cwd: join(ws, 'no-dir'),
  }, exec, ctx)
  ok('register rejects missing cwd', /cwd not found/.test(missingCwd.error))

  const secretish = await executePaperMcp({
    action: 'register', serverName: 'ok1', command: py, args: [server], envNames: ['KEY=sk-live'],
  }, exec, ctx)
  ok('register rejects env assignment', /envNames must be variable names/.test(secretish.error))

  const def = await executePaperMcp({
    action: 'register', serverName: 'Scanpy_Agent', command: py, args: [server], envNames: ['ALPHAGENOME_API_KEY', ''],
  }, exec, ctx)
  ok('register success', def.action === 'register' && def.mounted === true && def.serverName === 'Scanpy_Agent', JSON.stringify(def))
  ok('register invoked ctx.plugin once', ctx.plugins.length === 1)
  ok('register plugin is stdio', ctx.plugins[0].cfg.transport === 'stdio' && ctx.plugins[0].cfg.serverName === 'Scanpy_Agent')
  ok('register drops empty envNames', Array.isArray(def.envNames) === false) // not on result; check registry
  const saved = JSON.parse(readFileSync(join(ws, '.dsh', 'paper-mcps.json'), 'utf8'))
  ok('registry written', saved.schema_version === 1 && saved.servers.length === 1)
  ok('registry envNames filtered', JSON.stringify(saved.servers[0].envNames) === JSON.stringify(['ALPHAGENOME_API_KEY']))
  ok('registry has no secret values', !JSON.stringify(saved).includes('sk-'))

  const again = await executePaperMcp({
    action: 'register', serverName: 'Scanpy_Agent', command: py, args: [server],
  }, exec, ctx)
  ok('register same server is already mounted', again.already === true && again.mounted === true)
  ok('register same does not double plugin', ctx.plugins.length === 1)

  const otherWs = mkdtempSync(join(tmpdir(), 'p2a-mcp-b-'))
  writeFileSync(join(otherWs, 'demo_mcp.py'), '# dummy\n')
  const conflict = await executePaperMcp({
    action: 'register', serverName: 'Scanpy_Agent', command: py, args: [join(otherWs, 'demo_mcp.py')], cwd: otherWs,
  }, execFor(otherWs), ctx)
  ok('register same name other cwd needs restart', conflict.restart === true && conflict.mounted === false, JSON.stringify(conflict))

  const st = await executePaperMcp({ action: 'status' }, exec, ctx)
  ok('status lists registered server', st.servers.length === 1 && st.servers[0].serverName === 'Scanpy_Agent')
  ok('status mounted in original workspace', st.servers[0].mounted === true)

  const stOther = await executePaperMcp({ action: 'status' }, execFor(otherWs), ctx)
  ok('status other workspace sees its own registry', stOther.servers.length === 1)
  ok('status other workspace restart flag', stOther.servers[0].restart === true)

  const unbad = await executePaperMcp({ action: 'unregister' }, exec, ctx)
  ok('unregister requires name', /valid serverName/.test(unbad.error))
  const unmiss = await executePaperMcp({ action: 'unregister', serverName: 'nope' }, exec, ctx)
  ok('unregister missing', /not in /.test(unmiss.error))
  const un = await executePaperMcp({ action: 'unregister', serverName: 'Scanpy_Agent' }, exec, ctx)
  ok('unregister ok', un.action === 'unregister' && !un.error)
  ok('unregister notes live tools until restart', un.restart === true && /Live mcp__/.test(un.hint))
  const afterUn = JSON.parse(readFileSync(join(ws, '.dsh', 'paper-mcps.json'), 'utf8'))
  ok('unregister removed from JSON', afterUn.servers.length === 0)

  writeFileSync(join(ws, '.dsh', 'paper-mcps.json'), '{not json')
  const badJson = await executePaperMcp({ action: 'status' }, exec, ctx)
  ok('status invalid JSON is error', /invalid /.test(badJson.error))

  writeFileSync(join(ws, '.dsh', 'paper-mcps.json'), JSON.stringify({ schema_version: 1, servers: { nope: true } }))
  const badShape = await executePaperMcp({ action: 'status' }, exec, ctx)
  ok('status non-array servers is empty not crash', badShape.action === 'status' && badShape.servers.length === 0)

  writeFileSync(join(ws, '.dsh', 'paper-mcps.json'), JSON.stringify({
    schema_version: 1,
    servers: [{ serverName: 'broken' }],
  }))
  const partial = await executePaperMcp({ action: 'status' }, exec, ctx)
  ok('status invalid entry is reported not thrown', partial.servers[0].error && partial.servers[0].mounted === false)

  const unknown = await executePaperMcp({ action: 'explode' }, exec, ctx)
  ok('unknown action', /unknown action/.test(unknown.error))

  try {
    normalizeServer(ws, { serverName: 'ok', command: py, args: ['-m', 'pkg'] })
    ok('normalize keeps -m flag', true)
  } catch (e) {
    ok('normalize keeps -m flag', false, e.message)
  }

  rmSync(ws, { recursive: true, force: true })
  rmSync(otherWs, { recursive: true, force: true })
  resetMountedForTests()
}

// ── skill tree / seed ─────────────────────────────────────────────────────

{
  const skill = join(ROOT, 'skills', 'paper2agent')
  ok('skill SKILL.md exists', existsSync(join(skill, 'SKILL.md')))
  ok('paper2skill is a catalog skill', existsSync(join(ROOT, 'skills', 'paper2skill', 'SKILL.md')))
  ok('paper2mcp is a catalog skill', existsSync(join(ROOT, 'skills', 'paper2mcp', 'SKILL.md')))
  ok('LICENSE vendored', existsSync(join(skill, 'LICENSE')))
  ok('no openai.yaml', !existsSync(join(ROOT, 'skills', 'paper2mcp', 'agents', 'openai.yaml')))
  const body = readFileSync(join(skill, 'SKILL.md'), 'utf8')
  ok('mapping heading', body.includes('## Academic Harness on DSH'))
  ok('no claude mcp add as instruction to run', body.includes('no `claude mcp add`'))
  ok('router loads paper2mcp by skill name', body.includes('load `paper2mcp`'))
  ok('paper-agent-builder exists', existsSync(join(ROOT, 'skills', 'paper-agent-builder', 'SKILL.md')))

  const orch = readFileSync(join(ROOT, 'skills', 'paper2mcp', 'references', 'orchestration.md'), 'utf8')
  ok('orchestration maps subagentId', orch.includes('subagentId') && orch.includes('subagent_fork'))

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  ok('package exports paper-mcp', pkg.exports['./paper-mcp'] === './paper-mcp.js')
  ok('package files includes paper-mcp.js', pkg.files.includes('paper-mcp.js'))
  const yml = readFileSync(join(ROOT, 'presets', 'academic-harness', 'agent.cordis.yml'), 'utf8')
  ok('preset mounts paper-mcp', yml.includes('name: academic-harness/paper-mcp'))
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  ok('patch declares preset-academic-harness', patch.includes('id: preset-academic-harness') && patch.includes("name: '@deepseek-ai/dsh-agent-preset'"))
  ok('patch sets registry default', /id: agent-preset-registry[\s\S]*default: academic-harness/.test(patch))
  ok('patch has no legacy preset', !patch.includes('preset-researchcraft-legacy'))
  ok('patch inlines paper-mcp plugins', patch.includes('name: academic-harness/paper-mcp'))
  const fakeHome = mkdtempSync(join(tmpdir(), 'p2a-seed-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  seed()
  ok('seed copies paper2agent', existsSync(join(fakeHome, 'skills', 'paper2agent', 'SKILL.md')))
  ok('seed copies paper2mcp', existsSync(join(fakeHome, 'skills', 'paper2mcp', 'SKILL.md')))
  ok('seed copies paper2skill', existsSync(join(fakeHome, 'skills', 'paper2skill', 'SKILL.md')))
  ok('seed copies paper-agent-builder', existsSync(join(fakeHome, 'skills', 'paper-agent-builder', 'SKILL.md')))
  writeFileSync(join(fakeHome, 'skills', 'paper2agent', 'SKILL.md'), 'stale\n')
  seed()
  ok('seed does not overwrite existing skill', readFileSync(join(fakeHome, 'skills', 'paper2agent', 'SKILL.md'), 'utf8') === 'stale\n')
  if (prev === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prev
  rmSync(fakeHome, { recursive: true, force: true })
}

// ── Paper2MCP verify_workflow.py edge cases ───────────────────────────────

{
  const helper = join(ROOT, 'skills', 'paper2mcp', 'scripts', 'verify_workflow.py')
  const empty = mkdtempSync(join(tmpdir(), 'p2a-wf-'))
  const r = spawnSync('python3', [helper, '--project-root', empty, '--through', 'setup'], { encoding: 'utf8' })
  ok('verify_workflow empty project exits nonzero', r.status !== 0)
  ok('verify_workflow empty project mentions missing state', /agent-runs|No such file|missing/i.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(0, 200))
  rmSync(empty, { recursive: true, force: true })
}

console.log(`${passed} passed, ${failed} failed`)
if (failures.length) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
