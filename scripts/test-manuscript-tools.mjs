/**
 * Fixtures for manuscript_citations and funder_policy — no network.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply as applyCitations, extractMarkdownCitations, runManuscriptCitations, stripTexComments,
} from '../manuscript-citations.js'
import { apply as applyFunder, normalizeJuliet, runFunderPolicy } from '../funder-policy.js'

/* ------------------------------------------------------- manuscript_citations */

const cwd = mkdtempSync(join(tmpdir(), 'ah-mscite-'))
const exec = { agent: { session: { header: { cwd } } } }

try {
  writeFileSync(join(cwd, 'refs.bib'), `@article{alpha,
  title = {Alpha Work},
  author = {Lovelace, Ada},
  year = {2020},
  journal = {J}
}
@article{beta,
  title = {Beta Work},
  year = {2021}
}
@article{gamma,
  title = {Gamma Work},
  year = {2022}
}
@article{dup,
  title = {Duplicate One},
  year = {2018}
}
@article{dup,
  title = {Duplicate Two},
  year = {2019}
}
@article{unused,
  title = {Never Cited Work},
  year = {2017}
}
`)
  writeFileSync(join(cwd, 'paper.tex'), `\\documentclass{article}
% \\cite{commented} and 100\\% ignored
\\begin{document}
See \\citep[see][p.~3]{alpha,beta} and \\citet{gamma}. 50\\% done.
Missing \\cite{delta}.
\\label{fig:a}\\label{fig:a}\\label{sec:x}
See \\ref{fig:a}, \\ref{fig:missing}, \\cref{sec:x,tab:y}.
\\bibliography{refs}
\\end{document}
`)
  writeFileSync(join(cwd, 'paper.md'), 'See [@alpha; @beta] and @gamma. Missing @delta.\n')

  assert.equal(stripTexComments('a 50\\% b % comment').trim(), 'a 50\\% b')
  assert.equal(stripTexComments('% whole line\nx').trim(), 'x')

  const result = await runManuscriptCitations({ manuscript: 'paper.tex' }, exec)
  assert.equal(result.error, undefined)
  assert.equal(result.manuscript, 'paper.tex')
  assert.deepEqual(result.bibliography, [join('refs.bib')])
  assert.equal(result.statistics.cited_keys, 4, 'commented citation must be ignored')
  assert.equal(result.statistics.citation_uses, 4)
  assert.ok(!result.missing_keys.some((entry) => entry.key === 'commented'), 'commented key must not be reported')
  assert.deepEqual(result.missing_keys, [{ key: 'delta', count: 1 }])
  assert.ok(result.unused_keys.some((entry) => entry.key === 'unused' && entry.title === 'Never Cited Work'))
  assert.deepEqual(result.duplicate_keys, [{ key: 'dup', count: 2 }])
  assert.deepEqual(result.undefined_refs.sort(), ['fig:missing', 'tab:y'])
  assert.deepEqual(result.duplicate_labels, ['fig:a'])
  assert.equal(result.nocite_all, false)

  const nocite = await runManuscriptCitations({ manuscript: 'paper.tex', bib_path: 'refs.bib' }, exec)
  assert.deepEqual(nocite.bibliography, ['refs.bib'])

  writeFileSync(join(cwd, 'nocite.tex'), '\\nocite{*}\n\\cite{alpha}\n\\addbibresource{refs.bib}\n')
  const allCited = await runManuscriptCitations({ manuscript: 'nocite.tex' }, exec)
  assert.equal(allCited.nocite_all, true)
  assert.deepEqual(allCited.unused_keys, [])

  const markdown = await runManuscriptCitations({ manuscript: 'paper.md', bib_path: 'refs.bib' }, exec)
  assert.equal(markdown.statistics.cited_keys, 4)
  assert.deepEqual(markdown.missing_keys, [{ key: 'delta', count: 1 }])
  assert.deepEqual(extractMarkdownCitations('[@a; @b] and @c.').keys.size, 3)

  assert.match((await runManuscriptCitations({ manuscript: 'paper.md' }, exec)).error, /give bib_path/)
  writeFileSync(join(cwd, 'paper.docx'), 'not really a docx')
  assert.match((await runManuscriptCitations({ manuscript: 'paper.docx' }, exec)).error, /\.tex or \.md/)
  assert.match((await runManuscriptCitations({ manuscript: '../outside.tex' }, exec)).error, /escapes the workspace/)
  writeFileSync(join(cwd, 'broken.tex'), '\\cite{alpha}\n\\bibliography{missing}\n')
  assert.match((await runManuscriptCitations({ manuscript: 'broken.tex' }, exec)).error, /bibliography file not found/)

  const registered = []
  applyCitations({ tools: { register: (tool) => registered.push(tool.name) } })
  assert.deepEqual(registered, ['manuscript_citations'])
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

/* ----------------------------------------------------------- funder_policy */

const openalexFunder = {
  id: 'https://openalex.org/F4320332161',
  display_name: 'National Institutes of Health',
  alternate_titles: ['NIH', 'US National Institutes of Health'],
  country_code: 'US',
  homepage_url: 'http://www.nih.gov',
  awards_count: 1200,
  works_count: 2714685,
}

const julietItem = {
  name: 'National Institutes of Health',
  acronym: 'NIH',
  uri: 'https://v2.sherpa.ac.uk/id/funder/1',
  country: { name: 'United States' },
  policies: [{
    preprint: { permitted: true, embargo: { amount: 12, period: 'months' }, license: 'CC BY' },
    postprint: {
      permitted_oa: [{ license: 'CC BY', embargo: { amount: 6, period: 'months' }, conditions: 'Acknowledge the funder' }],
    },
    published: { permitted: false },
  }],
}

function funderHarness({ openalex = { ok: true, status: 200, data: { results: [openalexFunder] } }, juliet, julietStatus = 200, key = null } = {}) {
  return {
    resolveEnv: async (name) => {
      if (name === 'SHERPA_ROMERO_API_KEY') return key
      return null
    },
    fetchJson: async (url, options) => {
      if (url.startsWith('https://api.openalex.org/funders')) {
        return openalex
      }
      if (url.startsWith('https://v2.sherpa.ac.uk/cgi/retrieve')) {
        assert.match(url, /api-key=KEY/)
        assert.equal(options.headers.Authorization, undefined)
        if (julietStatus !== 200) return { ok: false, status: julietStatus, error: `HTTP ${julietStatus}` }
        return { ok: true, status: 200, data: juliet }
      }
      throw new Error(`unexpected url: ${url}`)
    },
  }
}

{
  const data = await runFunderPolicy({ funder: 'National Institutes of Health' }, {}, funderHarness())
  assert.equal(data.error, undefined)
  assert.equal(data.funder.name, 'National Institutes of Health')
  assert.equal(data.funder.openalex_id, 'F4320332161')
  assert.equal(data.funder.works_count, 2714685)
  assert.equal(data.sherpa.skipped, 'key_not_set')
  assert.deepEqual(data.policies, [])
}

{
  const data = await runFunderPolicy({ funder: 'NIH' }, {}, funderHarness({
    key: 'KEY',
    juliet: { total: 1, items: [julietItem] },
  }))
  assert.equal(data.error, undefined)
  assert.equal(data.sherpa.matches, 1)
  assert.equal(data.funder.policy.funder_name, 'National Institutes of Health')
  assert.equal(data.funder.policy.policies.length, 1)
  const policy = data.funder.policy.policies[0]
  assert.equal(policy.preprint.permitted, 'yes')
  assert.equal(policy.preprint.embargo, '12 months')
  assert.equal(policy.postprint.embargo, '6 months')
  assert.match(policy.postprint.conditions, /Acknowledge the funder/)
  assert.equal(policy.published.permitted, 'no')
  assert.ok(!JSON.stringify(data.sources).includes('api-key'), 'the Sherpa key must not leak into sources')
}

{
  const data = await runFunderPolicy({ funder: 'NIH' }, {}, funderHarness({
    key: 'KEY',
    julietStatus: 401,
  }))
  assert.equal(data.error, undefined)
  assert.match(data.sherpa.error, /check SHERPA_ROMERO_API_KEY/)
}

{
  const data = await runFunderPolicy({ funder: 'NIH' }, {}, funderHarness({
    openalex: { ok: false, status: 500, error: 'HTTP 500', detail: 'down' },
  }))
  assert.match(data.error, /OpenAlex API error 500: down/)
}

{
  const data = await runFunderPolicy({}, {}, funderHarness())
  assert.match(data.error, /give a funder name/)
}

assert.equal(normalizeJuliet({ name: 'X', policies: [] }).policies.length, 0)

{
  const registered = []
  applyFunder({ tools: { register: (tool) => registered.push(tool.name) } })
  assert.deepEqual(registered, ['funder_policy'])
}

console.log('manuscript/funder tools OK')
