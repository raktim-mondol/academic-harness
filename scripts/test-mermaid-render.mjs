import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))

assert.ok(pkg.dependencies?.pele, 'pele dependency missing')
assert.ok(pkg.files?.includes('mermaid-render.js'), 'package files missing mermaid-render.js')
assert.ok(existsSync(join(root, 'mermaid-render.js')), 'missing mermaid-render.js')
assert.equal(pkg.exports?.['./mermaid-render'], undefined, 'host-level tool must not be a public export')
assert.match(read('index.js'), /applyMermaidRender\(ctx\)/, 'index.js must register the tool at host level')

const { applyMermaidRender } = await import('../mermaid-render.js')
let tool
applyMermaidRender({ tools: { register: (registered) => { tool = registered } } })
assert.equal(tool.name, 'mermaid_render')
assert.deepEqual(tool.parameters.required, ['mermaid'])
assert.ok(tool.description.includes('diagram-design'), 'must steer publication figures to diagram-design')

const ws = mkdtempSync(join(tmpdir(), 'ah-mermaid-'))
const exec = { agent: { session: { header: { cwd: ws } } } }
const flow = 'flowchart LR\n  A[Search] --> B{Triage}\n  B -->|include| C[Extract]'

try {
  const file = await tool.execute({ mermaid: flow, path: 'figures/pipeline.svg' }, exec)
  assert.equal(file.ok, true)
  assert.equal(file.path, 'figures/pipeline.svg')
  assert.ok(file.width > 0 && file.height > 0, 'dimensions must be reported')
  assert.equal(file.mermaid_type, 'flowchart-v2')
  assert.ok(!('svg' in file), 'file output must not inline the SVG into the transcript')

  const written = readFileSync(join(ws, 'figures/pipeline.svg'), 'utf8')
  assert.match(written, /^<svg/)
  assert.ok(!written.includes('var('), 'written SVG must have CSS variables flattened for rasterizers')
  assert.match(written, /#fff/)

  const inline = await tool.execute({ mermaid: flow }, exec)
  assert.equal(inline.ok, true)
  assert.ok(inline.svg.includes('var(--pele-bg'), 'inline SVG must stay themeable')

  const fenced = await tool.execute({ mermaid: '```mermaid\n' + flow + '\n```' }, exec)
  assert.equal(fenced.ok, true, 'a fenced mermaid block must render')

  const styled = await tool.execute({ mermaid: flow, font_size: 24, padding: 40 }, exec)
  assert.ok(styled.width > inline.width, 'font size must scale the layout')

  const sequence = await tool.execute({ mermaid: 'sequenceDiagram\n  A->>B: ping\n  B-->>A: pong' }, exec)
  assert.equal(sequence.diagram_type, 'sequence')

  const syntax = await tool.execute({ mermaid: 'flowchart LR\n  A -->> B' }, exec)
  assert.equal(syntax.ok, false)
  assert.equal(syntax.error_code, 'syntax')
  assert.equal(syntax.line, 2, 'must report the failing line')
  assert.ok(syntax.snippet, 'must report a snippet')
  const syntaxText = tool.output.render({}, syntax)[0].text
  assert.equal(syntaxText.match(/A -->> B/g).length, 1, 'snippet must not be duplicated')

  const unsupported = await tool.execute({ mermaid: 'not a diagram at all' }, exec)
  assert.equal(unsupported.error_code, 'unsupported-diagram')
  assert.equal(unsupported.line, undefined, 'no bogus location for a detection failure')

  // Breadth: the diagram families a research session actually reaches for.
  for (const [label, src, type] of [
    ['er', 'erDiagram\n  PAPER ||--o{ REVIEW : gets', 'er'],
    ['class', 'classDiagram\n  class Model { +fit() }', 'class'],
    ['pie', 'pie title Split\n  "Train" : 70\n  "Test" : 30', 'pie'],
    ['mindmap', 'mindmap\n  root(Harness)\n    Search\n    Writing', 'mindmap'],
    ['gantt', 'gantt\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2026-01-01, 10d', 'gantt'],
    ['timeline', 'timeline\n  title Eras\n  2020 : Launch', 'timeline'],
  ]) {
    const r = await tool.execute({ mermaid: src }, exec)
    assert.equal(r.diagram_type, type, `${label} must render as ${type}`)
  }

  // Long labels wrap into multiple lines instead of overflowing the node.
  const wrapped = await tool.execute({ mermaid: 'flowchart TD\n  A[' + 'long word '.repeat(12) + ']' }, exec)
  assert.ok((wrapped.svg.match(/<tspan/g) ?? []).length > 2, 'long labels must wrap')

  // Untrusted label text must never reach the SVG as live markup.
  const hostile = await tool.execute({
    mermaid: 'flowchart LR\n  A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(2)>"]\n  click A "javascript:alert(3)" "h"',
  }, exec)
  assert.ok(!/<script|onerror|javascript:/i.test(hostile.svg), 'no raw markup or handlers in output')
  assert.ok(!/<image|href="data:|href="file:/i.test(hostile.svg), 'no external or unsafe image/link embeds')

  await assert.rejects(
    () => tool.execute({ mermaid: flow, path: '../escape.svg' }, exec),
    /escapes the workspace/,
  )
  assert.ok(!existsSync(resolve(ws, '..', 'escape.svg')), 'must not write outside the workspace')
} finally {
  rmSync(ws, { recursive: true, force: true })
}

assert.match(tool.description, /fa:bug/, 'Node-side icon limitation must be documented for the model')

console.log('mermaid_render surface OK')
