/**
 * `ah_rsi` — inspect and steer the local RSI loop from inside a DSH session.
 * The loop itself runs in rsi-hooks.js; this tool is the visible control surface.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defaultStoreDir, effectiveConfig, ensureStore } from './rsi-store.js'
import {
  diagnoseAndAdmit, formatLessonMessage, retireSimilarLessons, rsiInjectPreview, rsiLessons,
  rsiReport, rsiStatus,
} from './rsi-core.js'

export const name = 'academic-harness-rsi'
export const inject = ['tools']

function lessonTable(lessons) {
  if (!lessons.length) return 'No lessons.'
  const lines = [
    '| ID | Status | Class | Injected | Control | Lesson |',
    '|---|---|---|---:|---:|---|',
  ]
  for (const lesson of lessons) {
    lines.push(`| ${lesson.id} | ${lesson.status} | ${lesson.task_class} | ${lesson.stats?.injected || 0} | ${lesson.stats?.control || 0} | ${String(lesson.text).replace(/\|/g, '\\|')} |`)
  }
  return lines.join('\n')
}

async function executeRsi(args) {
  const dir = defaultStoreDir()
  ensureStore(dir)
  const config = effectiveConfig(dir)
  switch (String(args.action || 'status').toLowerCase()) {
    case 'status': {
      const status = rsiStatus({ dir })
      return [
        `RSI mode: ${status.mode} (${status.remote_judge ? 'remote judge enabled' : 'local-only judge'})`,
        `Store: ${status.store}`,
        `Episodes: ${status.episodes} (${status.substantive_episodes} substantive)`,
        `Lessons: ${status.lessons.active} active, ${status.lessons.trial} trial, ${status.lessons.candidate} candidate, ${status.lessons.retired} retired, ${status.lessons.quarantined} quarantined`,
        ...(status.stale_lessons ? [`Stale (not injected): ${status.stale_lessons}`] : []),
        `Last diagnosis: ${status.last_diagnosis_at || 'never'}`,
      ].join('\n')
    }
    case 'report':
      return rsiReport({ dir })
    case 'lessons':
      return lessonTable(rsiLessons({ dir, status: args.status || 'all' }))
    case 'diagnose': {
      const result = await diagnoseAndAdmit({ dir, config })
      const bits = [
        `Candidates: ${result.candidates}`,
        `Created: ${result.created.length}`,
        `Revalidated: ${result.updated.length}`,
        `Rejected: ${result.rejected.length}`,
      ]
      if (result.created.length) bits.push('', 'New lessons:', ...result.created.map((lesson) => `- [${lesson.id}] ${lesson.text}`))
      if (result.rejected.length) bits.push('', 'Rejected:', ...result.rejected.map((row) => `- ${row.id}: ${row.reason}`))
      if (result.remote_errors?.length) bits.push('', 'Remote judge unavailable (local decision kept):', ...result.remote_errors.map((row) => `- ${row.id}: ${row.reason}`))
      return bits.join('\n')
    }
    case 'forget':
    case 'rollback': {
      if (!args.lesson_id && !args.pattern) return { error: `${args.action} needs lesson_id or pattern` }
      const retired = await retireSimilarLessons({
        dir,
        id: args.lesson_id || null,
        text: args.pattern || '',
        config,
      })
      const verb = String(args.action).toLowerCase() === 'rollback' ? 'Rolled back' : 'Retired'
      return retired.length ? `${verb}: ${retired.join(', ')}` : 'No matching active lesson.'
    }
    case 'inject_preview': {
      const preview = rsiInjectPreview({ dir, taskClass: args.task_class || 'general-research' })
      return preview.injected.length
        ? `${preview.injected.length} lesson(s), ~${preview.tokens} tokens:\n\n${formatLessonMessage(preview.injected)}`
        : `No lessons would be injected for task class "${args.task_class || 'general-research'}".`
    }
    case 'config':
      return JSON.stringify(config, null, 2)
    default:
      return { error: 'action must be status, report, lessons, diagnose, forget, rollback, inject_preview, or config' }
  }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'ah_rsi',
    description: 'Inspect and steer the local recursive self-improvement loop. The loop captures tool outcomes, explicit user preferences, and corrections locally; diagnoses recurring research failures; auto-admits short lessons; and injects them into later turns. No approval is required; every lesson is reversible. Use forget when the user explicitly retracts a rule. Preferences are captured from the user message automatically; this tool never invents one. It never edits plugin code, the ah engine, the project, or the audit/evaluation logic.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'report', 'lessons', 'diagnose', 'forget', 'rollback', 'inject_preview', 'config'],
        description: 'Default status.',
      },
      task_class: { type: 'string', description: 'Research task class for inject_preview, e.g. manuscript, statistics, data-analysis.' },
      status: { type: 'string', description: 'Lesson status filter for lessons: active, trial, candidate, retired, quarantined, or all.' },
      lesson_id: { type: 'string', description: 'Lesson id for forget.' },
      pattern: { type: 'string', description: 'Text pattern for forget.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: value?.error || value?.text || String(value ?? '') }]
      },
    },
    async execute(args) {
      try {
        const result = await executeRsi(args)
        if (result && typeof result === 'object' && result.error) return { error: result.error }
        return { text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
      } catch (error) {
        return { error: `ah_rsi failed: ${error?.message || error}` }
      }
    },
  }))
}
