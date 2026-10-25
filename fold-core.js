/**
 * Reply folding at five levels, adapted for DeepSeek Harness.
 *
 * Ported from TextFold's plugins/textfold/hooks/fold.ts (Apache-2.0,
 * https://github.com/chenxiachan/textfold, commit 2182d9a), with changes:
 * - string level names instead of 1-5;
 * - no Pi "art row" detection (DSH renders diagrams as code fences);
 * - structured blocks returned alongside the Markdown for the client panel;
 * - pure ESM with no Node or React imports, so the host tool and the browser
 *   bundle use the same engine.
 *
 * The fold only deletes prefixes of what was written. It never paraphrases.
 */

export const LEVELS = ['full', 'brief', 'points', 'outline', 'gist']

const LEVEL_ALIASES = new Map([
  ['full', 'full'], ['1', 'full'],
  ['brief', 'brief'], ['2', 'brief'],
  ['points', 'points'], ['3', 'points'],
  ['outline', 'outline'], ['4', 'outline'],
  ['gist', 'gist'], ['5', 'gist'],
])

const FENCE = /^\s*(`{3,}|~{3,})/
const HEADING = /^\s{0,3}(#{1,6})\s+/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|cf|al|approx|Dr|Mr|Ms|Fig|Eq|No)\.$/i
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g
const MORE = ' …'

/** Normalize a numeric or named level; unknown values throw. */
export function normalizeLevel(level = 'brief') {
  const key = String(level).trim().toLowerCase()
  const normalized = LEVEL_ALIASES.get(key)
  if (!normalized) throw new Error(`unknown fold level: ${level}`)
  return normalized
}

const tableAt = (lines, i) =>
  (lines[i] ?? '').includes('|') && (lines[i + 1] ?? '').includes('|') && DELIM.test(lines[i + 1] ?? '')

/**
 * Split Markdown into the blocks a fold can treat independently.
 * A table straight after a paragraph starts its own block; a setext-looking
 * `---` after a paragraph stays part of that paragraph and is not a rule.
 */
export function blocks(md) {
  const out = []
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i += 1
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1] ?? '```'
      const buf = [line]
      i += 1
      while (i < lines.length) {
        const current = lines[i] ?? ''
        buf.push(current)
        i += 1
        if (current.trim().startsWith(mark)) break
      }
      out.push({ kind: 'code', lines: buf })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1].length, lines: [line] })
      i += 1
      continue
    }
    if (RULE.test(line)) {
      out.push({ kind: 'rule', lines: [line] })
      i += 1
      continue
    }
    const kind = tableAt(lines, i) ? 'table' : /^\s*>/.test(line) ? 'quote' : ITEM.test(line) ? 'list' : 'para'
    const buf = [line]
    i += 1
    while (i < lines.length) {
      const current = lines[i] ?? ''
      if (!current.trim() || FENCE.test(current) || HEADING.test(current)) break
      if (kind === 'para' && (ITEM.test(current) || tableAt(lines, i))) break
      buf.push(current)
      i += 1
    }
    out.push({ kind, lines: buf })
  }
  return out
}

function cut(text, at) {
  const rest = text.slice(at).trim()
  return { head: balance(text.slice(0, at).trim()), more: rest.length > 0, rest }
}

/** Close the bold or code span a cut left open. */
function balance(text) {
  let out = text
  if ((out.match(/\*\*/g) ?? []).length % 2) out += '**'
  if ((out.match(/`/g) ?? []).length % 2) out += '`'
  return out
}

/**
 * The text's first sentence, and whether more follows it. Inline code is never
 * cut; Chinese and Japanese stops end a sentence without a following space.
 */
export function firstSentence(text) {
  let inCode = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (char === '`') {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    if ('。！？'.includes(char)) return cut(text, i + 1)
    if (!'.!?'.includes(char)) continue
    const after = /^([*_)"'”’\]]*)(\s+|$)/.exec(text.slice(i + 1))
    if (!after) continue
    if (ABBREV.test(text.slice(0, i + 1))) continue
    return cut(text, i + 1 + (after[1] ?? '').length)
  }
  return { head: text.trim(), more: false, rest: '' }
}

function sentences(text, count) {
  let rest = text.trim()
  const out = []
  let more = false
  for (let k = 0; k < count && rest; k += 1) {
    const next = firstSentence(rest)
    out.push(next.head)
    rest = next.rest
    more = next.more
  }
  return { text: out.join(' '), more }
}

function items(block) {
  const out = []
  for (const line of block.lines) {
    const match = ITEM.exec(line)
    if (match) {
      out.push({ indent: (match[1] ?? '').length, marker: match[2] ?? '-', text: match[3] ?? '' })
    } else if (out.length) {
      const last = out[out.length - 1]
      last.text += ` ${line.trim()}`
    }
  }
  return out
}

function tableRows(lines) {
  const rows = []
  for (const line of lines) {
    if (DELIM.test(line)) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
    if (cells.some(Boolean)) rows.push(cells)
  }
  return rows
}

/** Word count: CJK characters plus Latin tokens; fenced code is ignored. */
export function words(md) {
  const plain = String(md ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ')
  const cjk = (plain.match(CJK) ?? []).length
  const latin = (plain.replace(CJK, ' ').match(/[A-Za-z0-9][\w'’-]*/g) ?? []).length
  return cjk + latin
}

/** Words as reading effort: a CJK character reads as about 1/1.6 of an English word. */
export function reading(md) {
  const plain = String(md ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ')
  const cjk = (plain.match(CJK) ?? []).length
  return words(md) - cjk + cjk / 1.6
}

export const MIN_WORDS = 80
export const MIN_HIDDEN = 0.25

/** Whether a reply is worth showing folded: long enough, and the fold hides enough. */
export function worthFolding(md, folded) {
  const all = reading(md)
  if (all <= 0) return false
  return all >= MIN_WORDS && 1 - reading(folded) / all >= MIN_HIDDEN
}

export function foldStats(before, after) {
  const wordsBefore = words(before)
  const wordsAfter = words(after)
  return {
    words_before: wordsBefore,
    words_after: wordsAfter,
    hidden_ratio: wordsBefore ? Number((1 - wordsAfter / wordsBefore).toFixed(3)) : 0,
  }
}

function blockText(block) {
  switch (block.kind) {
    case 'heading':
    case 'code':
    case 'table':
    case 'rule':
      return block.lines.join('\n')
    case 'list':
      return block.items.map((item) => `${' '.repeat(item.indent)}${item.marker} ${item.text}${item.more ? MORE : ''}`).join('\n')
    case 'quote':
      return `> ${block.text}`
    default:
      return block.text
  }
}

function fullBlock(block) {
  switch (block.kind) {
    case 'heading':
      return { kind: 'heading', level: block.level, lines: block.lines }
    case 'para':
    case 'paragraph':
      return { kind: 'paragraph', text: block.lines.join('\n') }
    case 'quote':
      return { kind: 'quote', text: block.lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n') }
    case 'list': {
      const all = items(block)
      return {
        kind: 'list',
        ordered: /^\d/.test(all[0]?.marker ?? ''),
        items: all.map((item) => ({ ...item, more: false })),
      }
    }
    case 'table':
      return { kind: 'table', lines: block.lines, rows: tableRows(block.lines) }
    case 'code':
      return { kind: 'code', lines: block.lines }
    case 'rule':
      return { kind: 'rule', lines: block.lines }
    default:
      return null
  }
}

/**
 * Fold Markdown to one level. Returns the rendered text, structured blocks for
 * the browser panel, and word counts. `level` is the level actually applied
 * (`outline` becomes `points` when a reply has no headings).
 */
export function foldReply(md, level = 'brief') {
  const source = String(md ?? '')
  const requested = normalizeLevel(level)
  const total = words(source)
  if (!source.trim()) {
    return { requested_level: requested, level: requested, text: '', blocks: [], total: 0, shown: 0, changed: false }
  }
  if (requested === 'full') {
    return {
      requested_level: requested,
      level: 'full',
      text: source,
      blocks: blocks(source).map(fullBlock).filter(Boolean),
      total,
      shown: total,
      changed: false,
    }
  }

  const parsed = blocks(source)
  let applied = requested
  if (applied === 'outline' && !parsed.some((block) => block.kind === 'heading')) applied = 'points'

  const out = []
  let underHeading = true
  let first = true
  for (const block of parsed) {
    if (applied === 'gist' && !first) break
    switch (block.kind) {
      case 'rule':
        break
      case 'heading':
        if (applied !== 'gist') out.push({ kind: 'heading', level: block.level, lines: block.lines })
        underHeading = true
        break
      case 'code':
      case 'table':
        if (applied === 'outline' || applied === 'gist') break
        if (block.kind === 'table') {
          out.push({ kind: 'table', lines: block.lines, rows: tableRows(block.lines) })
        } else if (block.lines.length <= 8) {
          out.push({ kind: 'code', lines: block.lines })
        } else {
          const hidden = Math.max(0, block.lines.length - 2)
          out.push({ kind: 'paragraph', text: `\`⋯ ${hidden} lines of code\`` })
        }
        break
      case 'list': {
        const all = items(block)
        const visible = all.filter((item) => applied === 'brief' || item.indent === 0)
        if (applied === 'brief' || applied === 'points') {
          out.push({
            kind: 'list',
            ordered: /^\d/.test(all[0]?.marker ?? ''),
            items: visible.map((item) => {
              const sentence = firstSentence(item.text)
              return { indent: item.indent, marker: item.marker, text: sentence.head, more: sentence.more }
            }),
          })
        } else if (underHeading || (applied === 'gist' && first)) {
          const item = visible[0]
          if (item) {
            const sentence = firstSentence(item.text)
            out.push({
              kind: 'list',
              ordered: /^\d/.test(item.marker),
              items: [{ indent: 0, marker: item.marker, text: sentence.head, more: sentence.more || visible.length > 1 }],
            })
          }
          underHeading = false
          first = false
        }
        break
      }
      case 'quote':
      case 'para': {
        const raw = block.lines
          .map((line) => (block.kind === 'quote' ? line.replace(/^\s*>\s?/, '') : line).trim())
          .join(' ')
        if (applied !== 'brief' && applied !== 'points' && !underHeading) break
        const sentence = sentences(raw, applied === 'brief' ? 2 : 1)
        out.push({
          kind: block.kind === 'quote' ? 'quote' : 'paragraph',
          text: sentence.text + (sentence.more ? MORE : ''),
        })
        underHeading = false
        first = false
        break
      }
      default:
        break
    }
  }

  const text = out.map(blockText).join('\n\n')
  return {
    requested_level: requested,
    level: applied,
    text,
    blocks: out,
    total,
    shown: words(text),
    changed: text !== source,
  }
}
