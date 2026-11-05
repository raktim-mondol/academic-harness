import { defineTool } from 'ah-dsh-tools'

const KINDS = ['table', 'statistical_test']
const ARTIFACT_ROLES = ['figure', 'table', 'script', 'report', 'data', 'log']
const MAX_COLUMNS = 25
const MAX_ROWS = 100
const MAX_ARTIFACTS = 20

function renderTable(t) {
  const header = t.columns.map((c) => (c.unit ? `${c.name} (${c.unit})` : c.name))
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of t.rows) lines.push(`| ${row.map((v) => String(v)).join(' | ')} |`)
  if (t.truncated) lines.push(`_(truncated to ${MAX_ROWS} rows)_`)
  return lines.join('\n')
}

function renderStatTest(s) {
  const bits = [`**${s.test}**`]
  if (s.estimate !== undefined) bits.push(`estimate: ${s.estimate}`)
  if (s.pValue !== undefined) bits.push(`p-value: ${s.pValue}`)
  if (s.adjustedPValue !== undefined) bits.push(`adjusted p-value: ${s.adjustedPValue}`)
  if (s.effectSize) bits.push(`effect size (${s.effectSize.name}): ${s.effectSize.value}`)
  if (s.confidenceInterval) {
    bits.push(`${s.confidenceInterval.level ?? ''}% CI: [${s.confidenceInterval.low}, ${s.confidenceInterval.high}]`)
  }
  return bits.join('\n')
}

function render(value) {
  const body = value.kind === 'table' ? renderTable(value.table) : renderStatTest(value.statistical_test)
  const artifactLines = value.artifacts?.length
    ? `\n\n${value.artifacts.map((a) => `[${a.role}] ${a.path}`).join('\n')}`
    : ''
  return [{ type: 'text', text: `## ${value.title}\n\n${value.summary}\n\n${body}${artifactLines}` }]
}

/** Register the structured-result-card tool. */
export function applyScientificResult(ctx) {
  ctx.tools.register(defineTool({
    name: 'scientific_result',
    description: [
      'Emit one structured, schema-validated "final finding" card — a results table or a statistical-test summary.',
      'Distinct from the notebook tool: notebook is a running log kept as you work; scientific_result is the terminal',
      'structured answer once you have a concrete finding to report. Link the artifacts (figures, data, scripts) it',
      'is based on or produced.',
    ].join(' '),
    parameters: {
      kind: {
        type: 'string',
        enum: KINDS,
        required: true,
        description: 'Which card shape this result is.',
      },
      title: { type: 'string', required: true, description: 'One-line headline.' },
      summary: { type: 'string', required: true, description: 'Short prose synopsis of the finding.' },
      artifacts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', required: true, description: 'Workspace-relative path.' },
            role: { type: 'string', enum: ARTIFACT_ROLES, required: true },
          },
          additionalProperties: false,
        },
        description: `Up to ${MAX_ARTIFACTS} linked workspace-relative files this result is based on or produced.`,
      },
      table: {
        type: 'object',
        properties: {
          columns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', required: true },
                unit: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          rows: {
            type: 'array',
            items: { type: 'array', items: { type: 'json' } },
          },
        },
        additionalProperties: false,
        description: `Required when kind="table". Caps: ${MAX_COLUMNS} columns, ${MAX_ROWS} rows (extra rows are dropped and flagged truncated).`,
      },
      statistical_test: {
        type: 'object',
        properties: {
          test: { type: 'string', required: true, description: 'Test name/method, e.g. "two-sided Welch t-test".' },
          estimate: { type: 'number' },
          pValue: { type: 'number' },
          adjustedPValue: { type: 'number' },
          effectSize: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'number' } },
            additionalProperties: false,
          },
          confidenceInterval: {
            type: 'object',
            properties: { level: { type: 'number' }, low: { type: 'number' }, high: { type: 'number' } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
        description: 'Required when kind="statistical_test".',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => render(value),
    },
    async execute(args, exec) {
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
      if (!title) throw new Error('scientific_result requires a non-empty title')
      if (!summary) throw new Error('scientific_result requires a non-empty summary')
      const artifacts = (args.artifacts ?? []).slice(0, MAX_ARTIFACTS)

      if (args.kind === 'table') {
        if (!args.table || !Array.isArray(args.table.columns) || args.table.columns.length === 0) {
          throw new Error('kind="table" requires table.columns with at least one column')
        }
        if (args.table.columns.length > MAX_COLUMNS) {
          throw new Error(`table.columns exceeds the ${MAX_COLUMNS}-column cap`)
        }
        const rows = args.table.rows ?? []
        const truncated = rows.length > MAX_ROWS
        return {
          id: exec.callId,
          kind: 'table',
          title,
          summary,
          artifacts,
          table: { columns: args.table.columns, rows: rows.slice(0, MAX_ROWS), truncated },
        }
      }

      if (!args.statistical_test || !args.statistical_test.test?.trim()) {
        throw new Error('kind="statistical_test" requires statistical_test.test')
      }
      return {
        id: exec.callId,
        kind: 'statistical_test',
        title,
        summary,
        artifacts,
        statistical_test: args.statistical_test,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args.title ?? 'Scientific result',
        kind: 'other',
      }
    },
  }))
}
