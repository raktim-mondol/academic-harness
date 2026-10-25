#!/usr/bin/env node
/**
 * A stand-in TextFold CLI for paper_fold tests. FAKE_DOC is the JSON it prints;
 * FAKE_MODE selects a failure or a generated-level variant.
 */
import { appendFileSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${args.join(' ')}\n`)

if (args[0] === '--version') {
  console.log('TextFold 0.10.31')
  process.exit(0)
}
if (args[0] !== 'get') {
  console.error(`unexpected args: ${args.join(' ')}`)
  process.exit(2)
}

const mode = process.env.FAKE_MODE || ''
if (mode === 'scanned') {
  console.error('This PDF needs the PDF engine: python3 -m textfold engine install')
  process.exit(0)
}
if (mode === 'nohtml') {
  console.error('no-html')
  process.exit(2)
}
if (mode === 'empty') process.exit(0)
if (mode === 'garbage') {
  console.log('not json')
  process.exit(0)
}
if (mode === 'sleep') {
  setTimeout(() => process.exit(0), 5_000)
} else if (mode === 'huge') {
  console.log('x'.repeat(1024))
  process.exit(0)
} else {
  const doc = JSON.parse(readFileSync(process.env.FAKE_DOC, 'utf8'))
  if (mode === 'generated' || mode === 'generated-zh') {
    doc.provenance.local = false
    doc.provenance.ai_generated = true
    doc.provenance.model = 'fake-model'
    for (const section of doc.sections) {
      if (!section.takeaway) section.takeaway = `Section ${section.id} takeaway.`
      if (!section.topic) section.topic = `Topic ${section.id}`
    }
    if (mode === 'generated-zh') doc.lang = 'zh'
  }
  console.log(JSON.stringify(doc))
}
