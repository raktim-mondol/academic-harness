import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { render } from 'pele'
import { flattenColors } from '../mermaid-render.js'

const SOURCE_DIR = 'docs/diagrams'
const OUTPUT_DIR = 'docs/assets/diagrams'

mkdirSync(OUTPUT_DIR, { recursive: true })

const sources = readdirSync(SOURCE_DIR)
  .filter((name) => extname(name) === '.mmd')
  .sort()

if (sources.length === 0) {
  console.error(`no .mmd sources in ${SOURCE_DIR}`)
  process.exit(1)
}

let failed = 0
for (const name of sources) {
  const source = readFileSync(join(SOURCE_DIR, name), 'utf8')
  const target = join(OUTPUT_DIR, `${basename(name, '.mmd')}.svg`)
  try {
    const result = render(source, { fontSize: 14, padding: 18, maxWidth: 1100 })
    const svg = flattenColors(result.svg).replace(
      /(<svg\b[^>]*>)/,
      '$1<rect width="100%" height="100%" fill="#ffffff"/>',
    )
    writeFileSync(target, svg, 'utf8')
    console.log(`${name} -> ${target} (${result.width}x${result.height}, ${result.mermaidType})`)
  } catch (error) {
    failed += 1
    console.error(`${name}: ${error.message}`)
    if (error.line) console.error(`  line ${error.line}, column ${error.column}`)
  }
}

if (failed > 0) {
  console.error(`${failed} diagram(s) failed`)
  process.exit(1)
}
