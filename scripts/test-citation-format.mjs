import assert from 'node:assert/strict'
import {
  formatBibliography, formatCitations, normalizeCsl, parseBibtex, parseInput, parseRis,
  toBibtex, toRis, validateRecords,
} from '../citation-format.js'

const bibtex = `@article{lovelace1843,
  author = {Lovelace, Ada and Turing, Alan},
  title = {Notes on the Analytical Engine},
  journal = {Scientific Memoirs},
  year = {1843},
  volume = {3},
  number = {2},
  pages = {666--731},
  doi = {10.1000/xyz}
}

@book{turing1950,
  author = {Turing, Alan},
  title = {Computing Machinery and Intelligence},
  publisher = {Oxford University Press},
  year = {1950}
}`

const parsed = parseBibtex(bibtex)
assert.equal(parsed.length, 2)
assert.equal(parsed[0].title, 'Notes on the Analytical Engine')
assert.equal(parsed[0]['container-title'], 'Scientific Memoirs')
assert.equal(parsed[0].DOI, '10.1000/xyz')
assert.equal(parsed[0].author.length, 2)
assert.equal(parsed[0].author[0].family, 'Lovelace')
assert.equal(parsed[0].author[0].given, 'Ada')

const risText = 'TY  - JOUR\nAU  - Lovelace, Ada\nTI  - Notes on the Analytical Engine\nJO  - Scientific Memoirs\nPY  - 1843\nDO  - 10.1000/xyz\nER  - \n'
const ris = parseRis(risText)
assert.equal(ris.length, 1)
assert.equal(ris[0].type, 'article-journal')
assert.equal(ris[0].DOI, '10.1000/xyz')
assert.equal(parseInput(risText).length, 1, 'auto-detection must find RIS')
assert.equal(parseInput(bibtex).length, 2, 'auto-detection must find BibTeX')
assert.equal(parseInput(JSON.stringify([{ title: 'JSON record', type: 'article' }])).length, 1, 'auto-detection must find CSL-JSON')

const normalized = normalizeCsl([{
  title: 'A <i>Test</i> Paper &amp; More',
  authors: [{ name: 'Ada Lovelace' }, 'Alan Turing'],
  year: 2024,
  venue: 'Journal of Tests',
  doi: 'https://doi.org/10.1000/ABC.1',
  type: 'journal-article',
}])
assert.equal(normalized[0].title, 'A Test Paper & More')
assert.equal(normalized[0].DOI, '10.1000/abc.1')
assert.equal(normalized[0]['container-title'], 'Journal of Tests')
assert.equal(normalized[0].type, 'article-journal')
assert.equal(normalized[0].author[0].family, 'Lovelace')
assert.equal(normalized[0].author[1].family, 'Turing')

const apa = formatBibliography(parsed, { style: 'apa' })
assert.match(apa, /Lovelace, A\., & Turing, A\./)
assert.match(apa, /Notes on the Analytical Engine/)
assert.match(apa, /1843/)
assert.match(apa, /https:\/\/doi\.org\/10\.1000\/xyz/)

const ieee = formatBibliography(parsed, { style: 'ieee' })
assert.match(ieee, /\[1\]/)
assert.match(ieee, /Notes on the Analytical Engine/)
assert.match(ieee, /doi: 10\.1000\/xyz/)

assert.match(formatBibliography(parsed, { style: 'chicago-author-date' }), /Lovelace, Ada, and Alan Turing/)
assert.match(formatBibliography(parsed, { style: 'mla' }), /Lovelace, Ada, and Alan Turing/)
assert.match(formatBibliography(parsed, { style: 'modern-language-association' }), /Notes on the Analytical Engine/)
assert.equal(formatCitations(parsed, { style: 'ieee' }), '[1], [2]')

const bibtexOut = toBibtex(parsed)
assert.match(bibtexOut, /@article\{lovelace1843,/, 'existing BibTeX keys must be preserved')
assert.match(bibtexOut, /@book\{turing1950,/)
assert.match(bibtexOut, /author = \{Lovelace, Ada and Turing, Alan\}/)
assert.match(bibtexOut, /doi = \{10\.1000\/xyz\}/)
assert.equal(parseBibtex(bibtexOut).length, 2, 'BibTeX output must round-trip')

const risOut = toRis(parsed)
assert.match(risOut, /TY  - JOUR/)
assert.match(risOut, /AU  - Lovelace, Ada/)
assert.match(risOut, /DO  - 10\.1000\/xyz/)
assert.match(risOut, /ER  - /)

const validation = validateRecords([
  { id: 'a', title: 'Same DOI', author: [{ family: 'Doe', given: 'Jane' }], year: 2024, DOI: '10.1000/same' },
  { id: 'b', title: 'Same DOI again', author: [{ family: 'Roe', given: 'Richard' }], year: 2023, DOI: '10.1000/SAME' },
])
assert.equal(validation.errors.length, 0)
const doiDuplicate = validation.duplicates.find((entry) => entry.field === 'doi')
assert.ok(doiDuplicate, 'duplicate DOI must be reported')
assert.equal(doiDuplicate.entries.length, 2)

const suppliedKeyDuplicate = validateRecords([
  { id: 'k1', 'citation-key': 'same', title: 'First', author: [{ family: 'Doe', given: 'Jane' }], year: 2024 },
  { id: 'k2', 'citation-key': 'same', title: 'Second', author: [{ family: 'Roe', given: 'Richard' }], year: 2023 },
])
assert.ok(suppliedKeyDuplicate.duplicates.some((entry) => entry.field === 'citation-key'))

const missing = validateRecords([{ id: 'c', type: 'article-journal' }])
assert.ok(missing.errors.some((error) => error.includes('missing title')))
assert.ok(missing.warnings.some((warning) => warning.includes('missing year')))

const keyed = toBibtex([
  { id: '1', title: 'Same Title', author: [{ family: 'Doe', given: 'Jane' }], year: 2024, type: 'book' },
  { id: '2', title: 'Same Title', author: [{ family: 'Doe', given: 'Jane' }], year: 2024, type: 'book' },
])
assert.match(keyed, /@book\{doe2024same,/)
assert.match(keyed, /@book\{doe2024samea,/)

assert.throws(() => formatBibliography(parsed, { style: 'harvard2' }), /unsupported citation style/)

console.log('citation-format OK')
