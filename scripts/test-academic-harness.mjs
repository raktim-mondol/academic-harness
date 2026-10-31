#!/usr/bin/env node
/**
 * Academic Harness DSH adapter: tool argv mapping, hook translation,
 * vendor tree, skills, and a live engine smoke if uv/python can install.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

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

const {
  findAhRoot,
  vendoredVersion,
  vendorDir,
  bundledInstallDir,
  cliArgs,
  DSH_STATE_FOOTER,
} = await import('../academic-harness-cli.js')
const { toolArgv, truncate } = await import('../academic-harness.js')
const { mapDshTool, parseHookStdout, isHandoffMessage, gateDecision } = await import('../academic-harness-hooks.js')

// ── vendor ────────────────────────────────────────────────────────────────

ok('vendor pyproject exists', existsSync(join(vendorDir(), 'pyproject.toml')))
ok('vendor ah package exists', existsSync(join(vendorDir(), 'ah', 'cli.py')))
ok('engine venv lives in the plugin vendor tree', bundledInstallDir() === vendorDir())
ok('vendor dir is the plugin vendor tree', /vendor[/\\]academic-harness$/.test(vendorDir()))
ok('vendor SOURCE.txt names commit', /dbc7414/.test(readFileSync(join(vendorDir(), 'SOURCE.txt'), 'utf8')))
ok('vendoredVersion is 0.1.0', vendoredVersion() === '0.1.0')
ok('engine has no earendil import', !readFileSync(join(vendorDir(), 'ah', 'cli.py'), 'utf8').includes('earendil'))
ok('engine README does not require Pi', !/you use it through \*\*\[Pi\]/.test(readFileSync(join(vendorDir(), 'README.md'), 'utf8')))

// ── skill catalogue ───────────────────────────────────────────────────────

{
  const skillsDir = join(ROOT, 'skills')
  const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const names = new Map()
  for (const dir of dirs) {
    const name = readFileSync(join(skillsDir, dir, 'SKILL.md'), 'utf8').match(/^name:\s*(.+)$/m)?.[1]?.trim()
    if (name) names.set(name, (names.get(name) || 0) + 1)
  }
  ok('skill catalogue has 747 entries', dirs.length === 747, String(dirs.length))
  ok('skill names are unique', names.size === dirs.length, `${names.size} names`)
  for (const name of [
    'deep-research',
    'idea-evaluator',
    'tech-paper-template',
    'benchmark-paper-template',
    'intro-drafter',
    'paper-writer',
    'paper-polish',
    'figure-designer',
    'drawio-reconstruction',
    'pre-submission-reviewer',
    'rebuttal-guidance',
    'vibe-research-workflow',
  ]) {
    const file = join(skillsDir, name, 'SKILL.md')
    ok(`Supervisor-Skills ${name} is present`, existsSync(file))
    ok(
      `Supervisor-Skills ${name} has routing`,
      existsSync(file) && readFileSync(file, 'utf8').includes('Routing in Academic Harness'),
    )
  }
  const related = [
    'academic-harness',
    'abstract-writer',
    'agentic-data-science-pipeline',
    'ah-plan-section',
    'ah-write-unit',
    'diagram-design',
    'generating-scientific-hypotheses',
    'literature-researcher',
    'literature-review',
    'manuscript-editor',
    'peer-reviewer',
    'remove-ai-signs',
    'scientific-figure-making',
    'surveying-prior-work',
    'systematic-review-ledger',
  ]
  ok(
    'existing skills carry reciprocal Supervisor-Skills routing',
    related.every((name) => existsSync(join(skillsDir, name, 'SKILL.md'))
      && readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8').includes('Supervisor-Skills')),
  )
}

// ── findAhRoot ────────────────────────────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'ah-root-'))
  const nested = join(dir, 'src', 'sections')
  mkdirSync(nested, { recursive: true })
  ok('findAhRoot misses a tree without ah.yaml', findAhRoot(nested) === null)
  writeFileSync(join(dir, 'ah.yaml'), 'project: t\n')
  ok('findAhRoot walks up to ah.yaml', findAhRoot(nested) === dir)
  ok('findAhRoot at the root', findAhRoot(dir) === dir)
  rmSync(dir, { recursive: true, force: true })
}

// ── tool argv ─────────────────────────────────────────────────────────────

ok('ah_check brief json', JSON.stringify(toolArgv('ah_check', { files: ['a.tex'], evidence: true })) === JSON.stringify(['check', '--files', 'a.tex', '--evidence', '--brief', '--json']))
ok('ah_state --unit', JSON.stringify(toolArgv('ah_state', { unit: 'u1' })) === JSON.stringify(['state', '--unit', 'u1']))
ok('ah_fact list', JSON.stringify(toolArgv('ah_fact', {})) === JSON.stringify(['facts', 'list', '--json']))
ok('ah_fact build', JSON.stringify(toolArgv('ah_fact', { action: 'build' })) === JSON.stringify(['facts', 'build']))
ok('ah_source list', JSON.stringify(toolArgv('ah_source', { action: 'list' })) === JSON.stringify(['source', 'list']))
ok('ah_source add needs path', Boolean(toolArgv('ah_source', { action: 'add' }).error))
ok('ah_source add argv', JSON.stringify(toolArgv('ah_source', { action: 'add', path: 's.md', key: 'k1', doi: '10.1/x' })).includes('source'))
ok('ah_inventory', JSON.stringify(toolArgv('ah_inventory', {})) === JSON.stringify(['inventory', '--json']))
ok('ah_units sync', JSON.stringify(toolArgv('ah_units', {})) === JSON.stringify(['units', 'sync']))
ok('ah_review import', JSON.stringify(toolArgv('ah_review', { action: 'import', id: 'R1', file: 'c.md' })) === JSON.stringify(['review', 'import', 'R1', '--file', 'c.md']))
ok('ah_profile list', JSON.stringify(toolArgv('ah_profile', {})) === JSON.stringify(['profile', 'list']))
ok('ah_author verify', JSON.stringify(toolArgv('ah_author', { action: 'verify', id: 'c1' })) === JSON.stringify(['claims', 'verify', 'c1', '--yes']))
ok('ah_author decline', JSON.stringify(toolArgv('ah_author', { action: 'decline', id: 'R1.2' })).includes('declined'))
ok('ah_author disclosure', JSON.stringify(toolArgv('ah_author', { action: 'disclosure-approve' })) === JSON.stringify(['disclosure', 'approve', '--yes']))
ok('ah_provenance record', toolArgv('ah_provenance', { action: 'record', files: ['a.tex'] })[0] === 'provenance')
ok('ah_source_search', toolArgv('ah_source_search', { key: 'k', query: 'auc', k: 2 }).includes('--id'))
ok('ah_sweep needs value or fact', Boolean(toolArgv('ah_sweep', {}).error))
ok('ah_sweep value', JSON.stringify(toolArgv('ah_sweep', { value: '79' })) === JSON.stringify(['sweep', '--value', '79']))
ok('ah_plan approve blocked', toolArgv('ah_plan', { action: 'approve' }).error)
ok('ah_plan propose needs id', toolArgv('ah_plan', { action: 'propose' }).error)
ok('ah_plan propose argv', Array.isArray(toolArgv('ah_plan', { action: 'propose', id: 'p1', thesis: 'T' })))
ok('ah_migrate apply without confirm blocked', toolArgv('ah_migrate', { apply: true }).error)
ok('ah_migrate dry-run', JSON.stringify(toolArgv('ah_migrate', { dir: '/tmp/p' })) === JSON.stringify(['migrate', '/tmp/p']))
ok('ah_author waive', JSON.stringify(toolArgv('ah_author', { action: 'waive', id: 'abc', reason: 'ok' })).includes('finding'))
ok('ah_author bad action', toolArgv('ah_author', { action: 'delete', id: 'x' }).error)
ok('ah_review_set declined blocked', toolArgv('ah_review_set', { item: 'R1.1', status: 'declined' }).error)
ok('ah_init uses dir', toolArgv('ah_init', { dir: '/tmp/paper', profile: 'thesis' }, '/cwd')[0] === 'init')
ok('unknown tool errors', toolArgv('ah_nope', {}).error)
ok('truncate short', truncate('abc') === 'abc')
ok('truncate long', truncate('x'.repeat(10), 4).includes('more characters'))

{
  const launch = { command: 'ah', args: [] }
  ok('cliArgs prefixes', JSON.stringify(cliArgs(launch, ['check'])) === JSON.stringify(['check']))
  ok('cliArgs with prefix', JSON.stringify(cliArgs({ command: 'uv', args: ['run', 'ah'] }, ['check'])) === JSON.stringify(['run', 'ah', 'check']))
}

// ── hook translation ──────────────────────────────────────────────────────

{
  const w = mapDshTool('write', { file_path: '/p/a.tex', content: 'hi' })
  ok('write → Write', w.tool_name === 'Write' && w.tool_input.file_path === '/p/a.tex')
  const e = mapDshTool('edit', { file_path: 'a.tex', old_string: 'a', new_string: 'b' })
  ok('edit → Edit', e.tool_name === 'Edit' && e.tool_input.old_string === 'a')
  const b = mapDshTool('bash', { command: 'sed -i s/x/y/ a.tex' })
  ok('bash → Bash', b.tool_name === 'Bash' && b.tool_input.command.includes('sed'))
  ok('other tools ignored', mapDshTool('grep', { pattern: 'x' }) === null)
}

{
  const deny = parseHookStdout(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'AH guard: protected',
    },
  }))
  ok('parse deny', deny.deny && deny.reason.includes('protected'))
  const ctx = parseHookStdout('noise\n' + JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'CARD' },
  }))
  ok('parse additionalContext after noise', ctx.additionalContext === 'CARD' && !ctx.deny)
  const gate = parseHookStdout(JSON.stringify({
    decision: 'block',
    reason: 'AH gate (attempt 1/3): blockers',
  }))
  ok('parse gate continue', gate.deny && gate.decision === 'block')
  const empty = parseHookStdout('')
  ok('parse empty', empty === null)
  ok('handoff detects stopped-after', isHandoffMessage('AH gate: stopped after 3 attempts with 2 blocking finding(s)\nThe author decides what to do next.'))
  ok('gate continue is not handoff', !isHandoffMessage('AH gate (attempt 1/3): your edits introduced blocking findings.'))
  const cont = gateDecision({ decision: 'block', reason: 'AH gate (attempt 1/3): blockers' })
  ok('gateDecision continue', cont.kind === 'continue')
  const ho = gateDecision({ systemMessage: 'AH gate: stopped after 3 attempts\nThe author decides what to do next.' })
  ok('gateDecision handoff', ho.kind === 'handoff' && /STOP/.test(ho.text))
  const ho2 = gateDecision({ systemMessage: 'AH gate: stopped after 3 attempts\nThe author decides what to do next.' }, { alreadyHandedOff: true })
  ok('gateDecision second handoff is none', ho2.kind === 'none')
  const t3 = gateDecision({ systemMessage: 'AH evidence check (advisory): 2 clause(s)' })
  ok('gateDecision t3', t3.kind === 't3' && /advisory/.test(t3.text))
  ok('gateDecision t3 once', gateDecision({ systemMessage: 'AH evidence check (advisory): 2 clause(s)' }, { alreadyT3: true }).kind === 'none')
  ok('DSH footer names inventory', /ah_inventory/.test(DSH_STATE_FOOTER) && /ah_source/.test(DSH_STATE_FOOTER))
}

// ── skills + preset + package ─────────────────────────────────────────────

const skills = ['academic-harness', 'ah-write-unit', 'ah-plan-section', 'ah-fix-findings', 'ah-audit-section', 'ah-revise-from-review']
for (const s of skills) {
  const p = join(ROOT, 'skills', s, 'SKILL.md')
  ok(`skill ${s}`, existsSync(p) && /DeepSeek Harness/.test(readFileSync(p, 'utf8')))
}

const yml = readFileSync(join(ROOT, 'presets/academic-harness/agent.cordis.yml'), 'utf8')
ok('preset mounts academic-harness', /name: academic-harness\/ah\b/.test(yml))
ok('preset mounts hooks', /name: academic-harness\/ah-hooks\b/.test(yml))
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
ok('patch inlines academic-harness', /name: academic-harness\/ah\b/.test(patch))
ok('patch inlines hooks', /name: academic-harness\/ah-hooks\b/.test(patch))
ok('patch has no legacy preset', !patch.includes('preset-researchcraft-legacy') && !patch.includes('id: researchcraft'))
ok('preset uses workflow-ptc', /name: '@deepseek-ai\/dsh-workflow-ptc'/.test(yml))

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
ok('package is academic-harness with a semver version', pkg.name === 'academic-harness' && /^\d+\.\d+\.\d+$/.test(pkg.version))
ok('package export ah', pkg.exports['./ah'] === './academic-harness.js')
ok('package export ah-hooks', pkg.exports['./ah-hooks'] === './academic-harness-hooks.js')
ok('package export academic-harness alias', pkg.exports['./academic-harness'] === './academic-harness.js')
ok('package export hooks alias', pkg.exports['./academic-harness-hooks'] === './academic-harness-hooks.js')
ok('package files include engine JS', pkg.files.includes('academic-harness.js') && pkg.files.includes('academic-harness-hooks.js'))
const promptSource = readFileSync(join(ROOT, 'prompt.js'), 'utf8')
ok('prompt mentions Academic Harness', /Academic Harness/.test(promptSource))
ok(
  'prompt asks before any paper review and explains deep review',
  /paper or manuscript review, critique, referee report, feedback/i.test(promptSource)
    && /user may not know it exists/i.test(promptSource)
    && /normal session review/i.test(promptSource),
)
{
  const deepLine = promptSource.split('\n').find(
    (line) => line.includes('deep_review') && line.includes('runs a vendored'),
  )
  ok(
    'deep-review prompt omits separate-cost framing',
    Boolean(deepLine) && !/cost|paid|dollar/i.test(deepLine),
  )
  const skill = readFileSync(join(ROOT, 'skills', 'deep-review', 'SKILL.md'), 'utf8')
  ok(
    'deep-review skill asks before every paper review',
    /Route every paper-review request/.test(skill)
      && /do not assume the user knows `deep_review`/i.test(skill)
      && /Do not run `review` before the user has chosen/i.test(skill),
  )
  ok(
    'deep-review skill omits separate-cost framing',
    !/cost|paid|dollar/i.test(skill),
  )
}
try {
  const section = await import('../prompt-section.js')
  ok('prompt-section imports', typeof section.apply === 'function' && section.inject?.includes('systemPrompt'))
} catch (error) {
  ok('prompt-section imports', false, error.message)
}

{
  const { executeAh } = await import('../academic-harness.js')
  const { seed } = await import('../seed.js')
  const dir = mkdtempSync(join(tmpdir(), 'ah-noproj-'))
  const out = await executeAh('ah_check', {}, { agent: { session: { header: { cwd: dir } } } })
  ok('ah_check outside a project errors', /no ah.yaml/.test(out.error || ''))
  const prof = await executeAh('ah_profile', { action: 'list' }, { agent: { session: { header: { cwd: dir } } } })
  ok('ah_profile list works without ah.yaml', !prof.error && /journal-empirical|thesis|grant/.test(prof.text || ''), (prof.error || '').slice(0, 160))
  rmSync(dir, { recursive: true, force: true })

  const fakeHome = mkdtempSync(join(tmpdir(), 'ah-seed-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = fakeHome
  mkdirSync(join(fakeHome, 'skills', 'modal'), { recursive: true })
  writeFileSync(join(fakeHome, 'skills', 'modal', 'SKILL.md'), '---\nname: modal\n---\n\n# modal\n\nOld brief without the current guidance.\n')
  mkdirSync(join(fakeHome, 'skills', 'papermemory'), { recursive: true })
  writeFileSync(join(fakeHome, 'skills', 'papermemory', 'SKILL.md'), '---\nname: papermemory\n---\n\n# PaperMemory\n\nAn older brief with `reference_library` but no export-scope guidance.\n')
  seed()
  const seededPaperMemory = readFileSync(join(fakeHome, 'skills', 'papermemory', 'SKILL.md'), 'utf8')
  ok('seed refreshes the papermemory skill to the reference-library brief', seededPaperMemory.includes('`reference_library`'))
  ok('seed refreshes 0.27.1 papermemory briefs with the export-scope rule', seededPaperMemory.includes('its project scopes exports') && seededPaperMemory.includes('even when `out` is given'))
  ok('seed installs the power-and-sample-size skill', existsSync(join(fakeHome, 'skills', 'power-and-sample-size', 'SKILL.md')))
  ok('seed copies academic-harness skill', existsSync(join(fakeHome, 'skills', 'academic-harness', 'SKILL.md')))
  ok('seed copies ah-write-unit', existsSync(join(fakeHome, 'skills', 'ah-write-unit', 'SKILL.md')))
  ok('seed refreshes an outdated first-party brief', readFileSync(join(fakeHome, 'skills', 'modal', 'SKILL.md'), 'utf8').includes('Troubleshooting `modal_run`'))
  if (prev === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prev
  rmSync(fakeHome, { recursive: true, force: true })
}

// ── live engine smoke ─────────────────────────────────────────────────────

{
  const vendor = vendorDir()
  const py = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[:2])'], { encoding: 'utf8' })
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' })
  if (py.status !== 0) {
    console.warn('SKIP live engine (no python3)')
  } else {
    const work = mkdtempSync(join(tmpdir(), 'ah-engine-'))
    const venv = join(work, '.venv')
    let installed = false
    if (uv.status === 0) {
      const v = spawnSync('uv', ['venv', venv], { encoding: 'utf8', timeout: 60_000 })
      if (v.status === 0) {
        const i = spawnSync('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), vendor], {
          encoding: 'utf8',
          timeout: 180_000,
        })
        installed = i.status === 0
        if (!installed) console.warn('uv pip install failed:', (i.stderr || i.stdout).slice(0, 300))
      }
    }
    if (!installed) {
      const v = spawnSync('python3', ['-m', 'venv', venv], { encoding: 'utf8', timeout: 60_000 })
      if (v.status === 0) {
        const pip = existsSync(join(venv, 'bin', 'pip')) ? join(venv, 'bin', 'pip') : join(venv, 'bin', 'python')
        const args = existsSync(join(venv, 'bin', 'pip')) ? ['install', vendor] : ['-m', 'pip', 'install', vendor]
        const i = spawnSync(pip, args, { encoding: 'utf8', timeout: 180_000 })
        installed = i.status === 0
        if (!installed) console.warn('pip install failed:', (i.stderr || i.stdout).slice(0, 300))
      }
    }
    if (installed) {
      const ah = join(venv, 'bin', 'ah')
      const help = spawnSync(ah, ['--help'], { encoding: 'utf8', timeout: 20_000 })
      ok('ah --help exits 0', help.status === 0, (help.stderr || '').slice(0, 200))
      ok('ah --help lists check', /check/.test(help.stdout) && /audit/.test(help.stdout) && /hook/.test(help.stdout))
      const paper = join(work, 'paper')
      const init = spawnSync(ah, ['init', paper, '--profile', 'paper/journal-empirical'], { encoding: 'utf8', timeout: 20_000 })
      ok('ah init creates ah.yaml', init.status === 0 && existsSync(join(paper, 'ah.yaml')), (init.stderr || init.stdout).slice(0, 200))
      const check = spawnSync(ah, ['check', '--project', paper, '--json', '--brief'], { encoding: 'utf8', timeout: 60_000 })
      ok('ah check runs on a new project', check.status === 0 || check.status === 1, (check.stderr || '').slice(0, 240))
      const hook = spawnSync(ah, ['hook', 'pre'], {
        encoding: 'utf8',
        timeout: 20_000,
        input: JSON.stringify({
          cwd: paper,
          session_id: 't',
          tool_name: 'Write',
          tool_input: { file_path: join(paper, 'sources', 'x.md'), content: 'no' },
        }),
      })
      const parsed = parseHookStdout(hook.stdout)
      ok('ah hook pre denies protected sources/', parsed?.deny === true, hook.stdout.slice(0, 240))
    } else {
      console.warn('SKIP live engine (could not install vendored package)')
    }
    rmSync(work, { recursive: true, force: true })
  }
}

console.log(`${passed} passed, ${failed} failed`)
if (failed) {
  console.error(failures.join('\n'))
  process.exit(1)
}
