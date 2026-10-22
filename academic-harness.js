/**
 * Native Academic Harness tools on the Academic Harness preset.
 *
 * Thin wrappers over the vendored `ah` engine (Python). Inactive as a
 * no-op error when the workspace has no `ah.yaml`, except `ah_init` /
 * `ah_migrate` which create one. Author-only acts go through `ah_author`
 * and are gated by DSH approval (see academic-harness-hooks.js).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  ahEnv,
  cliArgs,
  ensureAcademicHarnessInstalled,
  findAhRoot,
  LOG,
  run,
} from './academic-harness-cli.js'

export { findAhRoot }

export const name = 'academic-harness-ah'
export const inject = ['tools']

const DEFAULT_TIMEOUT_MS = 120_000
const AUDIT_TIMEOUT_MS = 300_000
const BUILD_TIMEOUT_MS = 600_000

const serialByRoot = new Map()

function workspaceRoot(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

function serial(root, fn) {
  const key = root || '*'
  const next = (serialByRoot.get(key) || Promise.resolve()).then(fn, fn)
  serialByRoot.set(key, next.catch(() => undefined))
  return next
}

export function truncate(s, max = 8000) {
  const text = String(s ?? '')
  return text.length <= max ? text : `${text.slice(0, max)}\n... (${text.length - max} more characters)`
}

function render(value) {
  if (value?.error) return [{ type: 'text', text: value.error }]
  return [{ type: 'text', text: truncate(value?.text ?? '') }]
}

export async function runAh(cwd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, stdin, model } = {}) {
  const launch = await ensureAcademicHarnessInstalled()
  if (!launch) {
    return {
      code: 1,
      out: '',
      err: 'Academic Harness engine venv is not ready inside this plugin (vendor/academic-harness). Set ACADEMIC_HARNESS_CLI or AH_CMD to override.',
    }
  }
  const root = findAhRoot(cwd) || cwd
  return run(launch.command, cliArgs(launch, args), {
    cwd,
    timeoutMs,
    env: ahEnv({}, { root, model }),
    signal,
    silent: true,
    stdin,
  })
}

function needProject(cwd) {
  const root = findAhRoot(cwd)
  if (root) return { root }
  return {
    error: 'This directory is not an Academic Harness project (no ah.yaml). Use ah_init to scaffold one, or ah_migrate to overlay an existing LaTeX tree.',
  }
}

function resultOf(r) {
  const text = (r.out || r.err || '').trim()
  if (r.code === 124) return { error: 'Academic Harness timed out' }
  if (r.code !== 0 && r.code !== 1) {
    return { error: text || `ah exited ${r.code}`, code: r.code }
  }
  return { text: text || '(no output)', code: r.code }
}

function strList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

/** Map a native tool call to `ah` argv (no --project). Exported for tests. */
export function toolArgv(name, args = {}, cwd) {
  switch (name) {
    case 'ah_state':
      return ['state', ...(args.unit ? ['--unit', String(args.unit)] : [])]
    case 'ah_check': {
      const extra = []
      const files = strList(args.files)
      if (files.length) extra.push('--files', files.join(','))
      if (args.evidence) extra.push('--evidence')
      extra.push('--brief', '--json')
      return ['check', ...extra]
    }
    case 'ah_audit': {
      const extra = ['--det-check', '--limit', '30']
      if (args.tiers) extra.push('--tiers', String(args.tiers))
      if (args.evidence) extra.push('--evidence')
      if (args.no_ledger) extra.push('--no-ledger')
      return ['audit', ...extra]
    }
    case 'ah_fact': {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'build') return ['facts', 'build']
      if (action === 'check') return ['facts', 'check']
      return ['facts', 'list', '--json']
    }
    case 'ah_source': {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'search') {
        if (!args.key || !args.query) return { error: 'source search needs key and query' }
        return ['source', 'search', '--id', String(args.key), '--query', String(args.query), '--k', String(args.k ?? 3)]
      }
      if (action === 'add') {
        if (!args.path) return { error: 'source add needs path (markdown or PDF of the source)' }
        const argv = ['source', 'add', String(args.path)]
        if (args.key) argv.push('--id', String(args.key))
        if (args.title) argv.push('--title', String(args.title))
        if (args.year != null) argv.push('--year', String(args.year))
        if (args.doi) argv.push('--doi', String(args.doi))
        if (args.kind) argv.push('--kind', String(args.kind))
        if (args.cls) argv.push('--cls', String(args.cls))
        if (args.tags) argv.push('--tags', strList(args.tags).join(','))
        return argv
      }
      return ['source', 'list']
    }
    case 'ah_source_search':
      return ['source', 'search', '--id', String(args.key), '--query', String(args.query), '--k', String(args.k ?? 3)]
    case 'ah_inventory':
      return ['inventory', '--json']
    case 'ah_units':
      return ['units', 'sync', ...(args.check ? ['--check'] : [])]
    case 'ah_bind':
      return ['bind', '--json']
    case 'ah_config':
      return ['config']
    case 'ah_catalogue':
      return ['catalogue']
    case 'ah_profile': {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'show') {
        if (!args.name) return { error: 'profile show needs a name' }
        return ['profile', 'show', String(args.name)]
      }
      return ['profile', 'list']
    }
    case 'ah_snapshot': {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'save') {
        if (!args.name) return { error: 'snapshot save needs a name' }
        return ['snapshot', 'save', String(args.name), ...(args.force ? ['--force'] : [])]
      }
      if (action === 'diff') {
        if (!args.name) return { error: 'snapshot diff needs a name' }
        return ['snapshot', 'diff', String(args.name)]
      }
      return ['snapshot', 'list']
    }
    case 'ah_provenance': {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'record') {
        const files = strList(args.files)
        if (!files.length) return { error: 'provenance record needs files' }
        const argv = ['provenance', 'record', '--files', files.join(','), '--type', String(args.author_type || 'agent')]
        if (args.model) argv.push('--model', String(args.model))
        if (args.brief_id) argv.push('--brief', String(args.brief_id))
        return argv
      }
      if (action === 'show') return ['provenance', 'show', '--json']
      return ['provenance', 'list', '--json', ...(args.author_type ? ['--type', String(args.author_type)] : [])]
    }
    case 'ah_disclosure':
      return ['disclosure', ...(args.out ? ['--out', String(args.out)] : [])]
    case 'ah_claims':
      return ['claims', '--json']
    case 'ah_sweep':
      if (!args.fact && !args.value) return { error: 'give a value or a fact' }
      return args.fact ? ['sweep', '--fact', String(args.fact)] : ['sweep', '--value', String(args.value)]
    case 'ah_build':
      return ['build', ...(args.view ? ['--view', String(args.view)] : [])]
    case 'ah_findings':
      return ['finding', 'list', '--json', ...(args.state ? ['--state', String(args.state)] : [])]
    case 'ah_decision_request':
      return ['finding', 'decide', String(args.fingerprint), '--reason', String(args.question)]
    case 'ah_pack':
      return ['pack', String(args.target)]
    case 'ah_brief_new': {
      const { length_words, ...rest } = args
      const data = { ...rest, ...(length_words ? { length: { words: length_words } } : {}) }
      delete data.length_words
      return ['brief', 'new', '--data', JSON.stringify(data)]
    }
    case 'ah_claims_sync':
      return ['claims', 'extract']
    case 'ah_claims_bind': {
      const argv = ['claims', 'bind', String(args.claim)]
      if (args.fact) argv.push('--fact', String(args.fact), '--token', String(args.token ?? ''))
      else if (args.auto) argv.push('--auto')
      else argv.push('--lines', String(args.lines ?? ''))
      if (args.source) argv.push('--source', String(args.source))
      return argv
    }
    case 'ah_review': {
      const action = String(args.action || 'list').toLowerCase()
      if (action === 'import') {
        if (!args.file || !args.id) return { error: 'review import needs id and file' }
        return ['review', 'import', String(args.id), '--file', String(args.file)]
      }
      if (action === 'show') {
        if (!args.id) return { error: 'review show needs an id' }
        return ['review', 'show', String(args.id)]
      }
      if (action === 'check') {
        if (!args.id) return { error: 'review check needs an id' }
        return ['review', 'check', String(args.id)]
      }
      return ['review', 'list', ...(args.id ? [String(args.id)] : [])]
    }
    case 'ah_review_set': {
      if (args.status === 'declined') return { error: 'Declining a reviewer\'s point is the author\'s decision. Record the question with ah_decision_request.' }
      const argv = ['review', 'set', String(args.item)]
      if (args.units) argv.push('--units', strList(args.units).join(','))
      if (args.status) argv.push('--status', String(args.status))
      if (args.response !== undefined) argv.push('--response', String(args.response))
      return argv
    }
    case 'ah_review_respond':
      return ['review', 'respond', String(args.id), ...(args.format ? ['--format', String(args.format)] : [])]
    case 'ah_plan': {
      const action = String(args.action || 'show').toLowerCase()
      if (action === 'approve') {
        return { error: 'Approving an outline plan is the author\'s decision. Ask them to confirm ah_author action=plan-approve.' }
      }
      if (action === 'propose') {
        if (!args.id) return { error: 'propose needs an id' }
        const outline = {}
        if (args.thesis !== undefined) outline.thesis = args.thesis
        if (args.sections) outline.sections = args.sections
        if (args.claims) outline.claims = args.claims
        return ['plan', 'propose', '--data', JSON.stringify({ id: args.id, outline })]
      }
      if (action === 'diff') {
        if (!args.id) return { error: 'diff needs a proposal id' }
        return ['plan', 'diff', String(args.id)]
      }
      if (action === 'check') return ['plan', 'check']
      if (action === 'list') return ['plan', 'list']
      return ['plan', 'show']
    }
    case 'ah_fact_propose': {
      const entry = { id: args.id, kind: args.kind, ...(args.spec && typeof args.spec === 'object' ? args.spec : {}) }
      return ['propose', '--data', JSON.stringify(entry), '--why', String(args.why)]
    }
    case 'ah_init':
      return ['init', String(args.dir || cwd || '.'), ...(args.profile ? ['--profile', String(args.profile)] : [])]
    case 'ah_migrate': {
      if (args.apply && !args.confirm) {
        return { error: 'Applying migrate needs confirm=true after the author agrees. Call without apply for a dry plan first.' }
      }
      const argv = ['migrate', String(args.dir || cwd || '.')]
      if (args.profile) argv.push('--profile', String(args.profile))
      if (args.apply) argv.push('--apply')
      if (args.facts) argv.push('--facts')
      if (args.confirm) argv.push('--yes')
      return argv
    }
    case 'ah_author': {
      const action = String(args.action || '').toLowerCase()
      const id = String(args.id || '')
      if (action === 'disclosure-approve') {
        return ['disclosure', 'approve', '--yes', ...(args.file ? ['--file', String(args.file)] : [])]
      }
      if (action === 'provenance-fill') {
        if (!args.author_type || !args.reason) return { error: 'provenance-fill needs author_type and reason (who is filling)' }
        return ['provenance', 'fill', '--type', String(args.author_type), '--by', String(args.reason), '--yes']
      }
      if (!id) return { error: 'ah_author needs an id' }
      if (action === 'waive') return ['finding', 'waive', id, '--reason', String(args.reason || ''), '--yes']
      if (action === 'accept') return ['proposals', 'accept', id, '--yes']
      if (action === 'reject') return ['proposals', 'reject', id, '--yes']
      if (action === 'approve') return ['brief', 'approve', id, '--yes']
      if (action === 'plan-approve') return ['plan', 'approve', id, '--yes']
      if (action === 'verify') return ['claims', 'verify', id, '--yes']
      if (action === 'decline') return ['review', 'set', id, '--status', 'declined', '--yes']
      return { error: 'ah_author action must be waive, accept, reject, approve, plan-approve, verify, decline, disclosure-approve, or provenance-fill' }
    }
    default:
      return { error: `unknown Academic Harness tool: ${name}` }
  }
}

const NO_PROJECT = new Set(['ah_init', 'ah_migrate', 'ah_profile', 'ah_catalogue'])
const SKIP_PROJECT_FLAG = new Set(['ah_init', 'ah_migrate', 'ah_profile', 'ah_catalogue'])

function sessionModel(exec) {
  const h = exec?.agent?.session?.header
  return h?.model || h?.route?.model || exec?.agent?.options?.model
}

export async function executeAh(name, args, exec) {
  const cwd = workspaceRoot(exec)
  const mapped = toolArgv(name, args, cwd)
  if (mapped && mapped.error) return { error: mapped.error }

  let root = findAhRoot(cwd) || cwd
  if (!NO_PROJECT.has(name)) {
    const project = needProject(cwd)
    if (project.error) return { error: project.error }
    root = project.root
  }

  const timeoutMs = name === 'ah_build' ? BUILD_TIMEOUT_MS
    : name === 'ah_audit' ? AUDIT_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS

  const finalArgv = SKIP_PROJECT_FLAG.has(name)
    ? mapped
    : [mapped[0], '--project', root, ...mapped.slice(1)]

  const r = await serial(root, () => runAh(root, finalArgv, {
    timeoutMs,
    signal: exec.signal,
    model: sessionModel(exec),
  }))
  if (name === 'ah_claims' && args.file && r.code === 0) {
    try {
      let cl = JSON.parse(r.out)
      if (Array.isArray(cl)) {
        const needle = String(args.file)
        cl = cl.filter((c) => String(c.file || '').endsWith(needle) || String(c.file || '') === needle)
        return { text: `${cl.length} claims\n${cl.slice(0, 30).map((c) => `- [${c.kind}] ${(c.cites || []).join(',')}: ${String(c.sentence || '').slice(0, 120)}`).join('\n')}`, code: 0 }
      }
    } catch {
      /* fall through */
    }
  }
  if (name === 'ah_fact' && (!args.action || args.action === 'list') && args.id && r.code === 0) {
    try {
      const all = JSON.parse(r.out)
      const ids = [args.id]
      const text = ids.map((i) => all[i]
        ? `${i} [default ${all[i].default}]: ${Object.entries(all[i].variants || {}).map(([k, v]) => `${k}=${v}`).join(', ')}${all[i].superseded?.length ? `  (superseded, do not use: ${all[i].superseded.join(', ')})` : ''}`
        : `${i}: no such fact`).join('\n')
      return { text, code: 0 }
    } catch {
      /* fall through */
    }
  }
  if (name === 'ah_decision_request' && r.code === 0) {
    return { text: `${(r.out || '').trim()}\nNow stop; the author decides.`, code: 0 }
  }
  if (name === 'ah_review_respond') {
    const extra = r.code === 1 ? '\nThe letter was written, but the items above must be fixed before it can be sent.' : ''
    return { text: `${r.out || ''}${extra}`.trim(), code: r.code }
  }
  if (name === 'ah_plan' && String(args.action || '').toLowerCase() === 'propose' && r.code === 0) {
    return { text: `${(r.out || '').trim()}\nLeave new .tex unwritten until the author approves.`, code: 0 }
  }
  if (name === 'ah_fact_propose' && r.code === 0) {
    return { text: `${(r.out || '').trim()}\nStop and let the author decide; do not type the number meanwhile.`, code: 0 }
  }
  return resultOf(r)
}

function jsonOutput() {
  return {
    schema: { type: 'json' },
    render(_args, value) { return render(value) },
  }
}

function register(ctx, spec) {
  ctx.tools.register(defineTool({
    ...spec,
    output: jsonOutput(),
    async execute(args, exec) {
      return executeAh(spec.name, args, exec)
    },
  }))
}

export async function apply(ctx) {
  // Do not await install here (inject: ['tools'] would stall). First call
  // and the hooks row kick the venv off.
  ensureAcademicHarnessInstalled().catch((error) => {
    console.warn(`${LOG}: background install failed: ${error?.message || error}`)
  })

  register(ctx, {
    name: 'ah_state',
    description: 'Paper-state card for an Academic Harness project: conventions, facts, terms, scope, thesis, briefs, open findings. Call when ah.yaml is present and you are about to write or audit.',
    parameters: {
      unit: { type: 'string', description: 'Optional unit id to centre the card on.' },
    },
  })
  register(ctx, {
    name: 'ah_check',
    description: 'Run Academic Harness checks (structure, numbers, bibliography, coherence) and list open findings. Optionally limit to files and add the no-model evidence check.',
    parameters: {
      files: { type: 'array', items: { type: 'string' }, description: 'Files relative to the project or TeX root.' },
      evidence: { type: 'boolean', description: 'Also check numbers in cited clauses against the cited sources.' },
    },
  })
  register(ctx, {
    name: 'ah_audit',
    description: 'Full Academic Harness audit with ledger reconcile. Deterministic; T3 evidence is optional and never a gate.',
    parameters: {
      tiers: { type: 'string', description: 'Comma list, e.g. T0,T1,T2,T4.' },
      evidence: { type: 'boolean' },
      no_ledger: { type: 'boolean' },
    },
  })
  register(ctx, {
    name: 'ah_fact',
    description: 'Facts computed from data. action=list (default) looks up \\fact{id} variants; never type the number. action=build rebuilds macros/facts.tex. action=check verifies facts against inputs.',
    parameters: {
      action: { type: 'string', enum: ['list', 'build', 'check'], description: 'Default list.' },
      id: { type: 'string', description: 'Fact id for list; omit to list all.' },
    },
  })
  register(ctx, {
    name: 'ah_source',
    description: 'Registered sources (the evidence an Academic Harness project may cite). action=list, add (register a markdown/PDF copy), or search. Prefer ah_source_search for a passage lookup. Do not invent a source.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'search'] },
      path: { type: 'string', description: 'Local markdown or PDF to register (add).' },
      key: { type: 'string', description: 'Citation key (add id, or search).' },
      query: { type: 'string', description: 'Search terms and numbers.' },
      k: { type: 'number' },
      title: { type: 'string' },
      year: { type: 'number' },
      doi: { type: 'string' },
      kind: { type: 'string' },
      cls: { type: 'string', description: 'research | context | own' },
      tags: { type: 'array', items: { type: 'string' } },
    },
  })
  register(ctx, {
    name: 'ah_inventory',
    description: 'Coverage inventory: units, numbers, citations, facts, bindings. An audit is finite because this list is finite. Call before claiming a section is done.',
    parameters: {},
  })
  register(ctx, {
    name: 'ah_units',
    description: 'Insert or refresh %% @unit anchors on prose files. New paragraphs need no anchor; the harness adds it. check=true is a dry run.',
    parameters: {
      check: { type: 'boolean', description: 'Dry run; report what would change.' },
    },
  })
  register(ctx, {
    name: 'ah_bind',
    description: 'Suggest bindings: literal numbers in prose that equal a fact variant. Use after an audit that reports NUM-001.',
    parameters: {},
  })
  register(ctx, {
    name: 'ah_config',
    description: 'Effective Academic Harness project configuration: paths, protected globs, gate, views.',
    parameters: {},
  })
  register(ctx, {
    name: 'ah_catalogue',
    description: 'List Academic Harness check ids, tiers and default levels.',
    parameters: {},
  })
  register(ctx, {
    name: 'ah_profile',
    description: 'List document-type profiles, or show one (structure, rules). Use before ah_init.',
    parameters: {
      action: { type: 'string', enum: ['list', 'show'], description: 'Default list.' },
      name: { type: 'string', description: 'Profile id for show, e.g. paper/journal-empirical.' },
    },
  })
  register(ctx, {
    name: 'ah_snapshot',
    description: 'Save, list or diff a snapshot of unit text. Reviews import a snapshot automatically; use this to capture a baseline before a revision round.',
    parameters: {
      action: { type: 'string', required: true, enum: ['save', 'list', 'diff'] },
      name: { type: 'string' },
      force: { type: 'boolean' },
    },
  })
  register(ctx, {
    name: 'ah_provenance',
    description: 'Who wrote each unit (human/agent/mixed). action=list or show a summary; action=record marks the units in the named files as written by the agent. Filling unrecorded units is ah_author provenance-fill.',
    parameters: {
      action: { type: 'string', enum: ['list', 'show', 'record'], description: 'Default list.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Prose files for record.' },
      author_type: { type: 'string', enum: ['human', 'agent', 'mixed', 'unknown'] },
      model: { type: 'string' },
      brief_id: { type: 'string' },
    },
  })
  register(ctx, {
    name: 'ah_disclosure',
    description: 'Draft an AI-use statement from unit provenance. Does not approve it; the author approves with ah_author action=disclosure-approve.',
    parameters: {
      out: { type: 'string', description: 'Write the draft markdown to this path.' },
    },
  })
  register(ctx, {
    name: 'ah_source_search',
    description: 'Find passages in a cited source by key, with line locators. Use before stating what a paper shows. If the key has no text, say you cannot check the claim.',
    parameters: {
      key: { type: 'string', required: true, description: 'Citation key.' },
      query: { type: 'string', required: true, description: 'Terms and numbers to look for.' },
      k: { type: 'number', description: 'Passages to return (default 3).' },
    },
  })
  register(ctx, {
    name: 'ah_claims',
    description: 'List cited claims (clauses split at their citations) with their sources, optionally for one file.',
    parameters: {
      file: { type: 'string' },
    },
  })
  register(ctx, {
    name: 'ah_sweep',
    description: 'List every place a value or a fact appears. Use after changing a number or term so no passage is left behind.',
    parameters: {
      value: { type: 'string' },
      fact: { type: 'string' },
    },
  })
  register(ctx, {
    name: 'ah_build',
    description: 'Compile the Academic Harness document and report LaTeX errors, undefined references and citations, and undefined facts.',
    parameters: {
      view: { type: 'string' },
    },
  })
  register(ctx, {
    name: 'ah_findings',
    description: 'List findings recorded in the ledger by state (open, fixed, waived, decision-needed).',
    parameters: {
      state: { type: 'string', description: 'open, fixed, waived or decision-needed' },
    },
  })
  register(ctx, {
    name: 'ah_decision_request',
    description: 'Hand a finding to the author with a question (use the 8-character id printed in front of each finding). Use this instead of waiving, working around a protected path, or overriding the gate. After calling it, stop and wait.',
    parameters: {
      fingerprint: { type: 'string', required: true, description: 'Finding fingerprint (first 8 characters are enough).' },
      question: { type: 'string', required: true, description: 'What the author must decide, in one sentence.' },
    },
  })
  register(ctx, {
    name: 'ah_pack',
    description: 'Everything needed to write one unit: its brief, neighbours, facts, and the best source passages with locators. Call before drafting.',
    parameters: {
      target: { type: 'string', required: true, description: 'A brief id, or a unit id.' },
    },
  })
  register(ctx, {
    name: 'ah_brief_new',
    description: 'Draft a brief for a unit before writing it. The author approves it via ah_author; you cannot.',
    parameters: {
      id: { type: 'string', required: true },
      file: { type: 'string', description: 'File to be written, relative to the TeX root.' },
      unit: { type: 'string', description: 'Or an existing unit id.' },
      purpose: { type: 'string', required: true },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            text: { type: 'string', required: true },
            facts: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      hedging: { type: 'string', description: 'descriptive, tentative or assertive' },
      must_not: { type: 'array', items: { type: 'string' } },
      length_words: { type: 'array', items: { type: 'number' }, description: '[min, max] words' },
      terms: { type: 'array', items: { type: 'string' } },
      extra_cites: { type: 'array', items: { type: 'string' } },
    },
  })
  register(ctx, {
    name: 'ah_claims_sync',
    description: 'Create or refresh the claim records (sidecars) for every cited clause.',
    parameters: {},
  })
  register(ctx, {
    name: 'ah_claims_bind',
    description: 'Bind a cited claim to the source passage that supports it, or tie a number in it to a fact. Run ah_claims_sync first. Only the author verifies.',
    parameters: {
      claim: { type: 'string', required: true },
      auto: { type: 'boolean' },
      source: { type: 'string' },
      lines: { type: 'string', description: 'START-END lines of the source text.' },
      fact: { type: 'string' },
      token: { type: 'string', description: 'The number as written, for a fact binding.' },
    },
  })
  register(ctx, {
    name: 'ah_review',
    description: 'Reviewer comments. action=list (default), import (parse a comments file and snapshot the text), show, or check. Import before revising. Declining a point is ah_author action=decline.',
    parameters: {
      action: { type: 'string', enum: ['list', 'import', 'show', 'check'], description: 'Default list.' },
      id: { type: 'string', description: 'Review id, e.g. R1. Required for import/show/check.' },
      file: { type: 'string', description: 'Comments file for import.' },
    },
  })
  register(ctx, {
    name: 'ah_review_set',
    description: 'Map a review item to the units that answer it and record your response. Declining a point is the author\'s decision: use ah_decision_request.',
    parameters: {
      item: { type: 'string', required: true, description: 'Item id, e.g. R1.2.' },
      units: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', description: 'open, addressed, rebutted or decision-needed' },
      response: { type: 'string' },
    },
  })
  register(ctx, {
    name: 'ah_review_respond',
    description: 'Build the response letter for a review from the items and the real text changes since the review snapshot.',
    parameters: {
      id: { type: 'string', required: true },
      format: { type: 'string', description: 'md or tex' },
    },
  })
  register(ctx, {
    name: 'ah_plan',
    description: 'Show, check, propose or diff an outline plan. Propose writes plans/<id>.yaml and leaves outline.yaml unchanged. Approving is the author\'s act (ah_author action=plan-approve).',
    parameters: {
      action: { type: 'string', required: true, description: 'show, list, check, propose or diff' },
      id: { type: 'string', description: 'Proposal id; required for propose and diff.' },
      thesis: { type: 'string' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file: { type: 'string', required: true },
            purpose: { type: 'string' },
            planned: { type: 'boolean' },
          },
        },
      },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            text: { type: 'string' },
            units: { type: 'array', items: { type: 'string' } },
            supports: { type: 'array', items: { type: 'string' } },
            facts: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  })
  register(ctx, {
    name: 'ah_fact_propose',
    description: 'Propose a new fact when the text needs a number the project does not define. It is computed from the data first. You cannot add it to the facts file; the author accepts it via ah_author.',
    parameters: {
      id: { type: 'string', required: true, description: 'Letters, digits, underscores.' },
      kind: { type: 'string', required: true, description: 'count, proportion, derived or value' },
      spec: { type: 'json', description: 'The rest of the fact definition.' },
      why: { type: 'string', required: true, description: 'Where the number is needed and why.' },
    },
  })
  register(ctx, {
    name: 'ah_init',
    description: 'Create a new Academic Harness LaTeX project (ah.yaml, outline, facts, sources) in a directory. Does nothing if ah.yaml already exists.',
    parameters: {
      dir: { type: 'string', description: 'Directory to create (default: session workspace).' },
      profile: {
        type: 'string',
        description: 'literature-review/systematic, paper/journal-empirical, paper/conference, grant/proposal, thesis, rebuttal/response.',
      },
    },
  })
  register(ctx, {
    name: 'ah_migrate',
    description: 'Plan (default) or apply an overlay that puts ah.yaml on an existing LaTeX tree. Apply needs confirm=true from the author.',
    parameters: {
      dir: { type: 'string', description: 'LaTeX tree; default is the session workspace.' },
      profile: { type: 'string' },
      apply: { type: 'boolean' },
      confirm: { type: 'boolean', description: 'Required to apply.' },
      facts: { type: 'boolean' },
    },
  })
  register(ctx, {
    name: 'ah_author',
    description: 'Author-only Academic Harness acts. The assistant must not call this unless the human explicitly asked in this message. DSH will ask the human to confirm before it runs.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['waive', 'accept', 'reject', 'approve', 'plan-approve', 'verify', 'decline', 'disclosure-approve', 'provenance-fill'],
      },
      id: { type: 'string', description: 'Finding fingerprint, fact id, brief id, plan id, claim id, or review item id.' },
      reason: { type: 'string', description: 'Required for waive (why) and provenance-fill (who is filling, e.g. the author name).' },
      file: { type: 'string', description: 'Edited disclosure markdown for disclosure-approve.' },
      author_type: { type: 'string', enum: ['human', 'agent', 'mixed', 'unknown'], description: 'For provenance-fill.' },
    },
  })
}
