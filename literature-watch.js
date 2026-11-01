/**
 * literature_watch: saved searches that survive the session.
 *
 * A watch is a query, a source list, and filters. `run` sends it through the
 * existing search sources (`runSource` in literature-search.js), drops records
 * the ledger has already seen, and stores the rest as hits. `digest` renders
 * the hits as Markdown. Scheduling is manual: nothing here runs on a timer,
 * emails anyone, or ingests into PaperMemory.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { exportText, mdCell, nowIso, shortHash } from './ledger-kit.js'
import { chooseSources, runSource } from './literature-search.js'
import { mergePapers } from './search-normalize.js'
import { resolveWorkspacePath } from './workspace-path.js'
import {
  WATCH_ACTIONS, WATCH_FREQUENCIES, addWatch, getWatch, isDue, lastDigestAt, lastRuns,
  listWatches, markDigest, readHits, recordKey, recordRun, removeWatch, seenKeys,
} from './literature-watch-store.js'

function workspaceRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

function yearFloor(watch) {
  const sinceYear = watch.since ? Number(String(watch.since).slice(0, 4)) : null
  const floors = [watch.year_min, Number.isFinite(sinceYear) ? sinceYear : null].filter((v) => v != null)
  return floors.length ? Math.max(...floors) : null
}

async function runOne(watch, cwd, exec, deps) {
  const search = deps.runSource || runSource
  const sources = watch.sources || chooseSources(watch.query, undefined)
  const yearMin = yearFloor(watch)
  const settled = await Promise.allSettled(sources.map((source) => search(source, {
    query: watch.query,
    perSource: watch.max_results,
    yearMin,
    yearMax: watch.year_max,
    openAccessOnly: watch.open_access_only,
    signal: exec?.signal,
  })))
  const failures = []
  const papers = []
  settled.forEach((entry, index) => {
    const source = sources[index]
    if (entry.status === 'rejected') return failures.push({ source, error: entry.reason?.message || String(entry.reason) })
    const value = entry.value
    if (!value || value.error) return failures.push({ source, error: value?.error || 'no result', ...(value?.status ? { status: value.status } : {}), ...(value?.detail ? { detail: String(value.detail).slice(0, 200) } : {}) })
    for (const paper of value.results || []) {
      if (yearMin != null && paper.year != null && paper.year < yearMin) continue
      papers.push(paper)
    }
  })
  const merged = mergePapers(papers).filter((paper) => recordKey(paper))
  const seen = seenKeys(cwd, watch.id)
  const fresh = merged.filter((paper) => !seen.has(recordKey(paper)))
  const run = await recordRun({
    cwd,
    watch,
    runId: `run-${shortHash(`${watch.id}|${nowIso()}|${Math.random()}`, 10)}`,
    fresh,
    total: merged.length,
    failures,
    sources,
    ranAt: deps.now || nowIso(),
  })
  return { watch: watch.id, name: watch.name, status: run.status, total: run.total, new: run.new, failures, run_id: run.run_id }
}

export function buildDigest(cwd, { watchRef, all } = {}) {
  const scope = watchRef ? getWatch(cwd, watchRef)?.id || watchRef : '*'
  const since = all ? null : lastDigestAt(cwd, scope)
  const live = new Map(listWatches(cwd).map((watch) => [watch.id, watch]))
  const hits = readHits(cwd).filter((hit) => live.has(hit.watch_id)
    && (scope === '*' || hit.watch_id === scope)
    && (!since || hit.found_at > since))
  const groups = new Map()
  for (const hit of hits) {
    if (!groups.has(hit.watch_id)) groups.set(hit.watch_id, [])
    groups.get(hit.watch_id).push(hit)
  }
  const lines = [`# Literature watch digest`, '', `Generated ${nowIso()} · ${hits.length} new record(s)${since ? ` since ${since}` : ''}.`,
    'New means "not seen by this watch before", not relevant or high quality. Nothing here has been read or verified.', '']
  for (const [watchId, items] of groups) {
    const watch = live.get(watchId)
    lines.push(`## ${watch.name} (${items.length})`, `Query: \`${watch.query}\``, '')
    for (const hit of items) {
      const record = hit.record
      const link = record.url ? ` — ${record.url}` : ''
      lines.push(`- **${mdCell(record.title) || '(untitled)'}** (${record.year ?? 'n.d.'}${record.venue ? `, ${mdCell(record.venue)}` : ''})${link}`)
      lines.push(`  - why matched: query "${hit.query}" via ${hit.sources.join(', ') || 'search'}; ${(record.authors || []).join(', ') || 'authors unknown'}`)
    }
    lines.push('')
  }
  if (!groups.size) lines.push('No new records.')
  const last = lastRuns(cwd)
  const unhealthy = [...live.values()].filter((w) => (scope === '*' || w.id === scope) && (!last.get(w.id) || last.get(w.id).status !== 'ok'))
  if (unhealthy.length) {
    lines.push('', '## Run health', 'A watch that has not run cleanly can hide new records; "no new records" above is not reliable for these:')
    for (const watch of unhealthy) {
      const run = last.get(watch.id)
      lines.push(`- ${watch.name}: ${run ? `${run.status} at ${run.ran_at}${run.failures.length ? ` — ${run.failures.map((f) => `${f.source}: ${f.error}${f.detail ? ` (${f.detail})` : ""}`).join('; ')}` : ''}` : 'never run'}`)
    }
  }
  return { scope, since, count: hits.length, watches: groups.size, unhealthy: unhealthy.length, markdown: lines.join('\n') }
}

export async function runLiteratureWatch(args, exec, deps = {}) {
  const action = args.action || 'list'
  if (!WATCH_ACTIONS.includes(action)) throw new Error(`action must be one of ${WATCH_ACTIONS.join(', ')}`)
  const cwd = workspaceRoot(exec)
  const recordedBy = args.recorded_by
  if (action === 'add') {
    const input = { ...(args.input && typeof args.input === 'object' ? args.input : {}) }
    for (const field of ['name', 'query', 'sources', 'year_min', 'year_max', 'open_access_only', 'since', 'frequency', 'max_results', 'notes']) {
      if (args[field] !== undefined) input[field] = args[field]
    }
    if (typeof input.sources === 'string') input.sources = input.sources.split(',').map((s) => s.trim()).filter(Boolean)
    return { action, watch: await addWatch({ cwd, input, recordedBy }) }
  }
  if (action === 'remove') return { action, removed: await removeWatch({ cwd, ref: args.watch || args.name, recordedBy }) }
  if (action === 'list') return { action, watches: listWatches(cwd) }
  if (action === 'run') {
    let targets
    if (args.watch || args.name) {
      const found = getWatch(cwd, args.watch || args.name)
      if (!found) throw new Error(`no watch "${args.watch || args.name}"`)
      targets = [found]
    } else {
      const last = lastRuns(cwd)
      targets = listWatches(cwd).filter((watch) => args.due_only ? isDue(watch, last.get(watch.id)) : true)
    }
    if (!targets.length) return { action, runs: [], note: 'no watches to run' }
    const runs = []
    for (const watch of targets) runs.push(await runOne(watch, cwd, exec, deps))
    return { action, runs }
  }
  if (action === 'digest') {
    const digest = buildDigest(cwd, { watchRef: args.watch || args.name, all: Boolean(args.all) })
    let written = null
    if (args.out) {
      const target = resolveWorkspacePath(cwd, args.out, { forWrite: true })
      written = exportText(target, digest.markdown, { overwrite: Boolean(args.overwrite) })
    }
    if (!args.preview && !args.all) await markDigest({ cwd, scope: digest.scope, count: digest.count })
    return { action, count: digest.count, watches: digest.watches, since: digest.since, unhealthy: digest.unhealthy, written, markdown: written ? undefined : digest.markdown }
  }
  const last = lastRuns(cwd)
  return {
    action,
    watches: listWatches(cwd).map((watch) => {
      const run = last.get(watch.id)
      return {
        id: watch.id, name: watch.name, frequency: watch.frequency, due: isDue(watch, run),
        last_run: run ? { ran_at: run.ran_at, status: run.status, total: run.total, new: run.new, failures: run.failures } : null,
      }
    }),
  }
}

function render(value) {
  if (value?.error) return [{ type: 'text', text: `Error: ${value.error}` }]
  const out = (text) => [{ type: 'text', text }]
  switch (value.action) {
    case 'add': return out(`Added watch "${value.watch.name}" (${value.watch.id}): ${value.watch.query}`)
    case 'remove': return out(`Removed watch "${value.removed.name}". Its history stays in the ledger.`)
    case 'list': return out(value.watches.length
      ? value.watches.map((w) => `- ${w.id}: "${w.query}" · ${w.frequency} · sources ${(w.sources || ['auto']).join(',')}`).join('\n')
      : 'No watches saved.')
    case 'run': return out(value.runs.length
      ? value.runs.map((r) => `- ${r.name}: ${r.status} · ${r.new} new of ${r.total}${r.failures.length ? ` · failed: ${r.failures.map((f) => `${f.source} (${f.error})`).join('; ')}` : ''}`).join('\n')
      : value.note)
    case 'digest': return out(value.written
      ? `Wrote digest (${value.count} new record(s), ${value.watches} watch(es)) to ${value.written.path}.${value.unhealthy ? ` ${value.unhealthy} watch(es) have not run cleanly; the digest says so.` : ''}`
      : value.markdown)
    case 'status': return out(value.watches.length
      ? value.watches.map((w) => `- ${w.name}: ${w.last_run ? `${w.last_run.status} ${w.last_run.ran_at}, ${w.last_run.new} new` : 'never run'}${w.due ? ' · due' : ''}`).join('\n')
      : 'No watches saved.')
    default: return out(JSON.stringify(value, null, 2))
  }
}

/** The host requires lossless JSON: no `undefined` fields, no non-finite numbers. */
function plain(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)))
}

export const name = 'academic-harness-literature-watch'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'literature_watch',
    description: [
      'Saved literature searches under `.dsh/watch/`: `add` a watch (name, query, sources, filters, since, frequency), `list`/`remove`, `run` one or all (optionally `due_only`), `digest` the new records as Markdown, and `status`.',
      'A run goes through the same sources as literature_search and keeps only records this watch has not seen before. A failed source is reported per watch, never hidden. Scheduling is manual: nothing runs on a timer, sends email, or ingests into PaperMemory. "New" means unseen by the ledger, not relevant or good. Load the `research-monitoring` skill.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: WATCH_ACTIONS, description: 'add, list, remove, run, digest, or status. Default list.' },
      name: { type: 'string', description: 'add: watch name. Other actions: the watch to act on.' },
      watch: { type: 'string', description: 'Watch id or name for remove/run/digest.' },
      query: { type: 'string', description: 'add: search query.' },
      sources: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'add: literature_search sources (default auto).' },
      year_min: { type: 'number', description: 'add: earliest year.' },
      year_max: { type: 'number', description: 'add: latest year.' },
      since: { type: 'string', description: 'add: ignore records published before this date (year precision).' },
      open_access_only: { type: 'boolean', description: 'add: open-access records only.' },
      frequency: { type: 'string', enum: WATCH_FREQUENCIES, description: 'add: how often it is due (advisory; default manual).' },
      max_results: { type: 'number', description: 'add: per-source cap, 1-100. Default 25.' },
      notes: { type: 'string', description: 'add: notes.' },
      due_only: { type: 'boolean', description: 'run: only watches whose frequency says they are due.' },
      all: { type: 'boolean', description: 'digest: include every hit, not only those since the last digest (does not advance the cut).' },
      preview: { type: 'boolean', description: 'digest: do not advance the since-last-digest cut.' },
      out: { type: 'string', description: 'digest: workspace-relative Markdown path to write.' },
      overwrite: { type: 'boolean', description: 'digest: replace an existing out file.' },
      recorded_by: { type: 'string', description: 'Who recorded the event.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      try {
        return plain(await runLiteratureWatch(args, exec))
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `Literature watch: ${args.action || 'list'}`, kind: 'other' }
    },
  }))
}
