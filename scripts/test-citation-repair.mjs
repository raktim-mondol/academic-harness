/**
 * Phase 8: citation repair writes a NEW .bib, never edits the input, and only
 * accepts a grounded record whose title matches the cited paper — corroborated
 * when the cited DOI is registered, never on a bare substring of a short title,
 * never on titles that cannot be compared; and it reports the citation key the
 * emitter actually wrote, including one suffixed to avoid a duplicate.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { apply, runCitation, titleMatches } from '../citation.js'
import { makeWorkspace, fakeExec } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-citation-repair-')
const cwd = workspace.cwd
const exec = fakeExec(cwd)

const BIB = [
  '@article{wrong2020,',
  '  title = {A Study of Widgets},',
  '  author = {Smith, John},',
  '  year = {2020},',
  '  journal = {J},',
  '  doi = {10.1000/wrong}',
  '}',
  '',
  '@article{hollow2019,',
  '  title = {A Hollow Result},',
  '  author = {Doe, Jane},',
  '  year = {2019},',
  '  journal = {J},',
  '  doi = {10.1000/hollow}',
  '}',
  '',
  '@article{retracted2018,',
  '  title = {A Retracted Paper},',
  '  author = {Roe, Rick},',
  '  year = {2018},',
  '  journal = {J},',
  '  doi = {10.1000/retracted}',
  '}',
  '',
  '@article{cjk2022,',
  '  title = {研究},',
  '  author = {Wang, Wei},',
  '  year = {2022},',
  '  journal = {J},',
  '  doi = {not-a-doi}',
  '}',
  '',
].join('\n')

const GROUNDED = '@article{grounded, title = {A Study of Widgets}, author = {Smith, John}, year = {2019}, journal = {Journal of Widgets}, doi = {10.1000/fixed}}'
const WRONG_GROUNDING = '@article{other, title = {A Completely Different Paper}, author = {Other, Ann}, year = {2001}, journal = {K}, doi = {10.1000/other}}'

function crossref(doi) {
  const titles = {
    '10.1000/wrong': 'A Different Paper',
    '10.1000/hollow': 'Also Different',
    '10.1000/retracted': 'A Retracted Paper',
  }
  return { ok: true, work: { title: [titles[doi] || 'Unknown'], issued: { 'date-parts': [[2019]] }, author: [{ family: 'Doe' }], 'container-title': ['J'] } }
}

function integrity(doi) {
  return doi === '10.1000/retracted'
    ? { verdict: 'retracted', signals: [{ notice_doi: '10.1000/notice' }] }
    : { verdict: 'ok' }
}

async function resolveBibtex(identifier) {
  if (identifier === 'A Study of Widgets') return { bibtex: GROUNDED, source: 'title-lookup' }
  if (identifier === 'A Hollow Result' || identifier === '10.1000/hollow') return { bibtex: WRONG_GROUNDING, source: 'title-lookup' }
  if (identifier === '研究') return { bibtex: '@article{other-cjk, title = {其他}, author = {Li, Li}, year = {2001}, journal = {K}, doi = {10.1000/other-cjk}}', source: 'title-lookup' }
  return { bibtex: null, source: null }
}

let tool
apply({ tools: { register: (registered) => { tool = registered } } })
assert.ok(tool.parameters.properties.action.enum.includes('repair'), 'the repair action is registered')

try {
  workspace.write('refs.bib', BIB)
  const before = readFileSync(join(cwd, 'refs.bib'), 'utf8')
  const deps = { fetchCrossref: async (doi) => crossref(doi), integrity: async (doi) => integrity(doi), resolveBibtex }

  await assert.rejects(() => runCitation({ action: 'repair', path: 'refs.bib' }, exec, deps), /output_path/)
  await assert.rejects(() => runCitation({ action: 'repair', path: 'refs.bib', output_path: 'refs.bib' }, exec, deps), /must differ/)

  let result
  result = await runCitation({ action: 'repair', path: 'refs.bib', output_path: 'refs-repaired.bib' }, exec, deps)
  assert.equal(result.targets, 3, 'three records carry a metadata mismatch')
  assert.equal(result.repaired, 1)
  assert.equal(result.unresolved, 2)
  assert.equal(result.skipped, 1, 'the retracted record is not repairable metadata')
  assert.equal(result.output_path, 'refs-repaired.bib')
  assert.equal(result.sidecar_path, 'refs-repaired.repair.json')

  assert.equal(readFileSync(join(cwd, 'refs.bib'), 'utf8'), before, 'the input bibliography is never edited')

  const repaired = readFileSync(join(cwd, 'refs-repaired.bib'), 'utf8')
  assert.match(repaired, /@article\{wrong2020,/, 'the original citation key is preserved')
  assert.match(repaired, /10\.1000\/fixed/)
  assert.doesNotMatch(repaired, /10\.1000\/wrong/)
  assert.match(repaired, /@article\{hollow2019,/, 'an unresolved record keeps its original entry')
  assert.match(repaired, /@article\{retracted2018,/)

  const sidecar = JSON.parse(readFileSync(join(cwd, 'refs-repaired.repair.json'), 'utf8'))
  const wrong = sidecar.references.find((ref) => ref.key === 'wrong2020')
  assert.equal(wrong.status, 'repaired')
  assert.equal(wrong.source, 'title-lookup')
  assert.equal(wrong.key_preserved, true)
  assert.match(wrong.changes.DOI.to, /10\.1000\/fixed/)

  const hollow = sidecar.references.find((ref) => ref.key === 'hollow2019')
  assert.equal(hollow.status, 'unresolved')
  assert.ok(hollow.rejected.some((entry) => /does not match/.test(entry.reason)), 'a title-mismatched grounding is rejected')

  const retracted = sidecar.references.find((ref) => ref.key === 'retracted2018')
  assert.equal(retracted.status, 'skipped')
  assert.match(retracted.reason, /retracted/)

  const cjk = sidecar.references.find((ref) => ref.key === 'cjk2022')
  assert.equal(cjk.status, 'unresolved', 'an incomparable title cannot accept another paper')
  assert.ok(cjk.rejected.some((entry) => /could not be compared/.test(entry.reason)))
  assert.equal(sidecar.normalized, true)
  assert.match(sidecar.note, /re-serialized/)

  await assert.rejects(() => runCitation({ action: 'repair', path: 'refs.bib', output_path: 'refs-repaired.bib' }, exec, deps), /already exists/)
  result = await runCitation({ action: 'repair', path: 'refs.bib', output_path: 'refs-repaired.bib', overwrite: true }, exec, deps)
  assert.equal(result.repaired, 1)

  // The cap leaves later targets reported, never silently repaired.
  workspace.write('refs-two.bib', BIB)
  result = await runCitation({ action: 'repair', path: 'refs-two.bib', output_path: 'refs-two-repaired.bib', max_repair: 1 }, exec, deps)
  assert.equal(result.targets, 1)
  assert.equal(result.skipped, 3)
  assert.ok(result.references.some((ref) => /repair cap/.test(ref.reason || '')))

  // A key that sanitization would change is reported, not called preserved.
  workspace.write('key.bib', '@article{2020smith, title = {Key Test}, author = {A, B}, year = {2020}, journal = {J}, doi = {not-a-doi}}\n')
  const keyDeps = {
    fetchCrossref: async () => ({ ok: true, work: { title: ['Key Test'], issued: { 'date-parts': [[2020]] }, author: [{ family: 'A' }], 'container-title': ['J'] } }),
    integrity: async () => ({ verdict: 'ok' }),
    resolveBibtex: async () => ({ bibtex: '@article{x, title = {Key Test}, author = {A, B}, year = {2020}, journal = {J}, doi = {10.1000/key}}', source: 'test' }),
  }
  result = await runCitation({ action: 'repair', path: 'key.bib', output_path: 'key-repaired.bib' }, exec, keyDeps)
  const keyRef = JSON.parse(readFileSync(join(cwd, 'key-repaired.repair.json'), 'utf8')).references[0]
  assert.equal(keyRef.status, 'repaired')
  assert.equal(keyRef.key_preserved, false)
  assert.equal(keyRef.grounded_key, 'ref2020smith')
  assert.match(readFileSync(join(cwd, 'key-repaired.bib'), 'utf8'), /@article\{ref2020smith,/)

  // A symlinked output target is refused.
  workspace.write('target-inside.bib', '@article{x, title = {T}}\n')
  symlinkSync(join(cwd, 'target-inside.bib'), join(cwd, 'linked.bib'))
  await assert.rejects(
    () => runCitation({ action: 'repair', path: 'refs.bib', output_path: 'linked.bib', overwrite: true }, exec, deps),
    /symlink|escapes|dangling/i,
  )

  // Sidecar source names the input that actually won precedence.
  workspace.write('precedence.bib', BIB)
  result = await runCitation({
    action: 'repair',
    path: 'precedence.bib',
    records: [{ title: 'A Study of Widgets', author: [{ family: 'Smith', given: 'John' }], issued: { 'date-parts': [[2020]] }, DOI: 'not-a-doi', type: 'article-journal' }],
    output_path: 'precedence-repaired.bib',
  }, exec, deps)
  assert.equal(JSON.parse(readFileSync(join(cwd, 'precedence-repaired.repair.json'), 'utf8')).source, '(records)')

  // (1) A citation key the emitter renames is reported as renamed, not preserved.
  workspace.write('dup.bib', [
    '@article{dup2020, title = {First Duplicate}, author = {Adams, Ann}, year = {2020}, journal = {J}}',
    '@article{dup2020, title = {A Study of Widgets}, author = {Smith, John}, year = {2020}, journal = {J}, doi = {10.1000/wrong}}',
    '',
  ].join('\n'))
  result = await runCitation({ action: 'repair', path: 'dup.bib', output_path: 'dup-repaired.bib' }, exec, deps)
  const dupBib = readFileSync(join(cwd, 'dup-repaired.bib'), 'utf8')
  assert.match(dupBib, /@article\{dup2020,/, 'the first entry keeps the shared key')
  assert.match(dupBib, /@article\{dup2020a,/, 'the emitter suffixes the colliding key')
  const dupRef = JSON.parse(readFileSync(join(cwd, 'dup-repaired.repair.json'), 'utf8')).references.find((ref) => ref.status === 'repaired')
  assert.equal(dupRef.key_preserved, false, 'a key the new .bib renames is never reported as preserved')
  assert.equal(dupRef.grounded_key, 'dup2020a', 'the sidecar reports the key actually emitted')
  assert.equal(dupRef.key_suffixed, true, 'and says the rename was a duplicate-avoidance suffix')
  assert.match(dupRef.key_reason, /duplicate citation key/)
  const dupRender = tool.output.render({}, result).map((part) => part.text).join('\n')
  assert.match(dupRender, /re-check/i, 'the render warns that \cite{dup2020} no longer resolves here')
  assert.match(dupRender, /duplicate citation key/, 'and names the reason instead of a generic key change')

  // (2) A title that normalizes to nothing is incomparable, and incomparable is unverified.
  assert.equal(titleMatches('研究', 'Quantum gravity of ferrets'), false, 'an incomparable pair is never a match')
  assert.equal(titleMatches('', 'A Study of Widgets'), false, 'a missing title is never a match')
  workspace.write('cjk.bib', '@article{cjktitle, title = {研究}, author = {王, 小}, year = {2020}, journal = {期刊}, doi = {10.1000/cjk}}\n')
  const cjkDeps = {
    fetchCrossref: async () => ({
      ok: true,
      work: { title: ['A Totally Different English Paper'], issued: { 'date-parts': [[2020]] }, author: [{ family: 'Smith' }], 'container-title': ['Nature'] },
    }),
    integrity: async () => ({ verdict: 'ok' }),
  }
  const cjkAudit = await runCitation({ action: 'audit', path: 'cjk.bib' }, exec, cjkDeps)
  assert.equal(cjkAudit.references[0].status, 'unverified', 'a non-Latin record is unverified, never clean')
  const cjkCodes = cjkAudit.references[0].findings.map((f) => f.code)
  assert.ok(cjkCodes.includes('title_uncomparable'), 'the title check reports that it could not compare')
  assert.ok(cjkCodes.includes('venue_uncomparable'), 'the venue check does not return a perfect score')
  assert.ok(cjkCodes.includes('first_author_uncomparable'), 'the author check does not silently skip')
  assert.ok(!cjkCodes.includes('title_mismatch'), 'an incomparable title is not invented as a mismatch')

  const cjkValidate = await runCitation({ action: 'validate', path: 'cjk.bib', check_dois: true }, exec, cjkDeps)
  assert.deepEqual(cjkValidate.doi_checks, [], 'the DOI is not counted as a passed title check')
  assert.deepEqual(cjkValidate.doi_unverified, ['10.1000/cjk'], 'it is recorded as unverified instead')
  assert.ok(cjkValidate.warnings.some((warning) => /could not be compared/.test(warning)))
  assert.match(tool.output.render({}, cjkValidate).map((part) => part.text).join('\n'), /DOI checks unverified/)

  // (3) A one-word cited title cannot accept the first record that merely contains it.
  workspace.write('short.bib', '@article{short2015, title = {Housing}, author = {Patel, Rita}, year = {2015}, journal = {Housing Studies}, doi = {10.1000/short}}\n')
  const shortDeps = {
    fetchCrossref: async () => ({ ok: true, work: { title: ['A Different Paper'], issued: { 'date-parts': [[2015]] }, author: [{ family: 'Patel' }], 'container-title': ['Housing Studies'] } }),
    integrity: async () => ({ verdict: 'ok' }),
    resolveBibtex: async () => ({ bibtex: '@article{others, title = {Housing Policy and the Comparative Welfare State}, author = {Notauthor, Ned}, year = {1991}, journal = {Different}, doi = {10.1000/different}}', source: 'title-lookup' }),
  }
  result = await runCitation({ action: 'repair', path: 'short.bib', output_path: 'short-repaired.bib' }, exec, shortDeps)
  const shortRef = JSON.parse(readFileSync(join(cwd, 'short-repaired.repair.json'), 'utf8')).references[0]
  assert.equal(shortRef.status, 'unresolved', 'containment of a one-word title is not a match')
  assert.match(readFileSync(join(cwd, 'short-repaired.bib'), 'utf8'), /title = \{Housing\}/, 'the record is left as cited, never rewritten')

  // (4) A longer title that only resembles the cited one is corroborated or refused.
  const LOOKALIKE_TITLE = 'Long Term Outcomes of Regional Housing Policy in Canada'
  const lookalike = (body) => `@article{near, title = {${LOOKALIKE_TITLE}}, author = {${body.author}}, year = {${body.year}}, journal = {${body.journal}}, doi = {${body.doi}}}`
  const lookalikeDeps = (entry) => ({
    fetchCrossref: async () => ({ ok: true, work: { title: ['A Different Paper'], issued: { 'date-parts': [[2015]] }, author: [{ family: 'Patel' }], 'container-title': ['Housing Studies'] } }),
    integrity: async () => ({ verdict: 'ok' }),
    resolveBibtex: async () => ({ bibtex: lookalike(entry), source: 'title-lookup' }),
  })
  workspace.write('uncorro.bib', '@article{uncor2015, title = {Long Term Outcomes of Regional Housing Policy}, author = {Patel, Rita}, year = {2015}, journal = {Housing Studies}, doi = {10.1000/uncor}}\n')
  result = await runCitation({ action: 'repair', path: 'uncorro.bib', output_path: 'uncorro-repaired.bib' }, exec, lookalikeDeps({ author: 'Notauthor, Ned', year: '1991', journal: 'Different', doi: '10.1000/near' }))
  const uncorroRef = JSON.parse(readFileSync(join(cwd, 'uncorro-repaired.repair.json'), 'utf8')).references[0]
  assert.equal(uncorroRef.status, 'unresolved', 'a title-only acceptance without corroboration is refused')
  assert.ok(uncorroRef.rejected.some((entry) => /corroborat/i.test(entry.reason)), 'and the refusal carries a reason')

  workspace.write('corrobo.bib', '@article{corro2015, title = {Long Term Outcomes of Regional Housing Policy}, author = {Patel, Rita}, year = {2015}, journal = {Housing Studies}, doi = {10.1000/corro}}\n')
  result = await runCitation({ action: 'repair', path: 'corrobo.bib', output_path: 'corrobo-repaired.bib' }, exec, lookalikeDeps({ author: 'Patel, Rita', year: '2015', journal: 'Housing Studies', doi: '10.1000/corro-b' }))
  const corroRef = JSON.parse(readFileSync(join(cwd, 'corrobo-repaired.repair.json'), 'utf8')).references[0]
  assert.equal(corroRef.status, 'repaired', 'the same title is accepted once author, year, and venue agree')
  assert.equal(corroRef.title_basis, 'title_match')
  assert.deepEqual(corroRef.corroborated_by, ['first_author', 'issued', 'container-title'], 'the corroboration is recorded')

  console.log('citation repair OK')
} finally {
  workspace.cleanup()
}
