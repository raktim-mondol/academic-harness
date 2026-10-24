#!/usr/bin/env node
/**
 * Local RSI control CLI. Reads and writes the same store as the DSH hooks and
 * the `ah_rsi` tool; it does not need DSH to be running.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { currentLessons, defaultStoreDir, effectiveConfig, ensureStore } from './rsi-store.js'
import {
  diagnoseAndAdmit, episodeSummary, formatLessonMessage, recentDecisions, recordExplicitPreference,
  retireSimilarLessons, rsiInjectPreview, rsiLessons, rsiReport, rsiStatus,
} from './rsi-core.js'
import {
  formatBenchmarkReport, runDefectBenchmark, runReplayBenchmark, runSyntheticBenchmark,
  snapshotProject,
} from './rsi-benchmark.js'

const HELP = `Academic Harness RSI (local)

Usage: academic-harness-rsi <command> [options]

Commands:
  status                     Show mode, store, episode and lesson counts
  report                     Human-readable learning report
  lessons [--status S]       List lessons (active|trial|candidate|retired|quarantined|all)
  diagnose                   Run diagnosis and auto-admit lessons
  feedback --text TEXT       Record an explicit user preference as an active lesson
  forget --id ID | --pattern TEXT
                             Retire matching lessons
  rollback --id ID           Explicitly roll back a learned lesson
  inject --task-class CLASS  Preview the lessons injected for a task class
  benchmark synthetic        Fast deterministic test of the RSI pipeline
  benchmark replay           Statistics over captured episodes
  benchmark defects --project PATH
                             Inject known LaTeX defects into a copy and run the real ah audit
  benchmark snapshot --project PATH
                             Record an ah audit snapshot as a longitudinal baseline
  export [--out FILE]        JSON export (lessons, decisions, summary; no raw events)
  config                     Show effective configuration
  purge --yes                Delete the local store (irreversible)

Global options:
  --store PATH               Override AH_RSI_STORE
  --json                     JSON output where supported
  -h, --help                 Show this help

Task classes: literature, hypothesis, experiment, data-analysis, statistics,
manuscript, grant, review-response, reproducibility, data-management,
general-research.
`

function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      out.help = true
      continue
    }
    if (!arg.startsWith('-')) {
      out._.push(arg)
      continue
    }
    const [key, inline] = arg.replace(/^--?/, '').split('=')
    if (inline != null) {
      out[key] = inline
    } else if (argv[index + 1] && !argv[index + 1].startsWith('-')) {
      out[key] = argv[index + 1]
      index += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function printStatus(status) {
  const lines = [
    'Academic Harness RSI',
    `Mode: ${status.mode} (${status.remote_judge ? 'remote judge enabled' : 'local-only judge'})`,
    `Store: ${status.store}`,
    `Plugin: ${status.plugin_version}`,
    `Episodes: ${status.episodes} (${status.substantive_episodes} substantive)`,
    `Lessons: ${status.lessons.active} active, ${status.lessons.trial} trial, ${status.lessons.candidate} candidate, ${status.lessons.retired} retired, ${status.lessons.quarantined} quarantined`,
    ...(status.stale_lessons ? [`Stale (not injected): ${status.stale_lessons}`] : []),
    `Last diagnosis: ${status.last_diagnosis_at || 'never'}`,
  ]
  if (status.task_classes.length) {
    lines.push('Task classes: ' + status.task_classes.map((row) => `${row.name} ${row.count}`).join(', '))
  }
  return lines.join('\n')
}

function printLessons(lessons) {
  if (!lessons.length) return 'No lessons.'
  const lines = ['| ID | Status | Class | Injected | Control | Lesson |', '|---|---|---|---:|---:|---|']
  for (const lesson of lessons) {
    lines.push(`| ${lesson.id} | ${lesson.status} | ${lesson.task_class} | ${lesson.stats?.injected || 0} | ${lesson.stats?.control || 0} | ${String(lesson.text).replace(/\|/g, '\\|')} |`)
  }
  return lines.join('\n')
}

function printSummary(summary) {
  const lines = [
    `Episodes: ${summary.episodes} (${summary.substantive} substantive)`,
    '',
    '| Task class | Episodes | Success rate | Mean quality |',
    '|---|---:|---:|---:|',
  ]
  for (const row of summary.by_class) lines.push(`| ${row.name} | ${row.total} | ${row.success_rate} | ${row.mean_quality} |`)
  if (summary.signals.length) {
    lines.push('', '| Signal | Seen | Failures |', '|---|---:|---:|')
    for (const row of summary.signals) lines.push(`| ${row.signal} | ${row.count} | ${row.failures} |`)
  }
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._.length === 0) {
    process.stdout.write(HELP)
    return
  }
  const dir = args.store ? resolve(String(args.store)) : defaultStoreDir()
  process.env.AH_RSI_STORE = dir
  ensureStore(dir)
  const config = effectiveConfig(dir)
  const command = args._[0]
  const sub = args._[1]

  if (command === 'status') {
    const status = rsiStatus({ dir })
    process.stdout.write(args.json ? `${JSON.stringify(status, null, 2)}\n` : `${printStatus(status)}\n`)
    return
  }
  if (command === 'report') {
    process.stdout.write(args.json ? `${JSON.stringify({ status: rsiStatus({ dir }), summary: episodeSummary(dir), decisions: recentDecisions(dir) }, null, 2)}\n` : `${rsiReport({ dir })}\n`)
    return
  }
  if (command === 'lessons') {
    const lessons = rsiLessons({ dir, status: args.status || 'all' })
    process.stdout.write(args.json ? `${JSON.stringify(lessons, null, 2)}\n` : `${printLessons(lessons)}\n`)
    return
  }
  if (command === 'diagnose') {
    const result = await diagnoseAndAdmit({ dir, config })
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    const lines = [
      `Candidates: ${result.candidates}`,
      `Created: ${result.created.length}`,
      `Revalidated: ${result.updated.length}`,
      `Rejected: ${result.rejected.length}`,
      `Retired: ${result.retired.length}`,
    ]
    if (result.created.length) lines.push('', 'New lessons:', ...result.created.map((lesson) => `- [${lesson.id}] ${lesson.text}`))
    if (result.rejected.length) lines.push('', 'Rejected:', ...result.rejected.map((row) => `- ${row.id}: ${row.reason}`))
    if (result.remote_errors?.length) lines.push('', 'Remote judge unavailable (local decision kept):', ...result.remote_errors.map((row) => `- ${row.id}: ${row.reason}`))
    process.stdout.write(`${lines.join('\n')}\n`)
    return
  }
  if (command === 'feedback') {
    if (!args.text) throw new Error('feedback needs --text')
    const lesson = await recordExplicitPreference({ dir, text: String(args.text), taskClass: args['task-class'] })
    process.stdout.write(`Learned [${lesson.id}] (${lesson.task_class}): ${lesson.text}\n`)
    return
  }
  if (command === 'forget' || command === 'rollback') {
    if (!args.id && !args.pattern) throw new Error(`${command} needs --id or --pattern`)
    const retired = await retireSimilarLessons({ dir, id: args.id || null, text: args.pattern || '', config })
    const verb = command === 'rollback' ? 'Rolled back' : 'Retired'
    process.stdout.write(retired.length ? `${verb}: ${retired.join(', ')}\n` : 'No matching active lesson.\n')
    return
  }
  if (command === 'inject') {
    const preview = rsiInjectPreview({ dir, taskClass: args['task-class'] || 'general-research' })
    process.stdout.write(args.json
      ? `${JSON.stringify({ ...preview, injected: preview.injected.map((lesson) => lesson.id) }, null, 2)}\n`
      : `${formatLessonMessage(preview.injected) || 'No lessons would be injected.'}\n`)
    return
  }
  if (command === 'benchmark') {
    if (sub === 'synthetic') {
      const result = await runSyntheticBenchmark()
      process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : formatBenchmarkReport(result)}\n`)
      if (!result.ok) process.exitCode = 1
      return
    }
    if (sub === 'replay') {
      const result = runReplayBenchmark({ dir })
      process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : formatBenchmarkReport(result)}\n`)
      return
    }
    if (sub === 'snapshot') {
      const projectDir = resolve(String(args.project || process.cwd()))
      const row = await snapshotProject({ dir, projectDir })
      process.stdout.write(`${args.json ? JSON.stringify(row, null, 2) : `Recorded audit snapshot for ${row.project.label}: gate ${row.gate?.passed ? 'PASS' : 'FAIL'}, ${row.findings} findings\n`}`)
      return
    }
    if (sub === 'defects') {
      const projectDir = resolve(String(args.project || process.cwd()))
      const row = await runDefectBenchmark({ dir, projectDir })
      if (args.json) {
        process.stdout.write(`${JSON.stringify(row, null, 2)}\n`)
        return
      }
      const lines = [
        `Defect benchmark: ${row.project.label}`,
        `Injected: ${row.mutations.map((mutation) => mutation.type).join(', ')}`,
        `Findings: ${row.baseline_findings} -> ${row.mutated_findings}`,
        `New checks: ${row.added.length ? row.added.join(', ') : '(none detected)'}`,
        `Lesson coverage: ${row.covered}/${row.coverage.length}`,
      ]
      for (const item of row.coverage) lines.push(`- ${item.check}: ${item.covered ? `covered by ${item.lesson}` : item.reason || 'not covered'}`)
      process.stdout.write(`${lines.join('\n')}\n`)
      return
    }
    throw new Error('benchmark needs synthetic, replay, defects, or snapshot')
  }
  if (command === 'export') {
    const payload = {
      rsi_version: 1,
      exported_at: new Date().toISOString(),
      status: rsiStatus({ dir }),
      lessons: currentLessons(dir),
      decisions: recentDecisions(dir, 200),
      summary: episodeSummary(dir),
    }
    const text = `${JSON.stringify(payload, null, 2)}\n`
    if (args.out) {
      writeFileSync(resolve(String(args.out)), text)
      process.stdout.write(`Wrote ${resolve(String(args.out))}\n`)
    } else process.stdout.write(text)
    return
  }
  if (command === 'config') {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
    return
  }
  if (command === 'purge') {
    if (!args.yes) throw new Error('purge needs --yes; it deletes the local RSI store')
    if (!existsSync(dir)) {
      process.stdout.write('Store does not exist.\n')
      return
    }
    rmSync(dir, { recursive: true, force: true })
    process.stdout.write(`Removed ${dir}\n`)
    return
  }
  throw new Error(`unknown command: ${command}`)
}

main().catch((error) => {
  process.stderr.write(`academic-harness-rsi: ${error?.message || error}\n`)
  process.exitCode = 1
})
