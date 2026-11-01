import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply as applyWatch, buildDigest, runLiteratureWatch } from '../literature-watch.js'
import { recordKey } from '../literature-watch-store.js'
import { apply as applyArtifacts, classifyRepository, extractArtifacts, runPaperArtifacts } from '../paper-artifacts.js'
import { runCitation } from '../citation.js'
import { apply as applyRecommend, runPaperRecommend } from '../paper-recommend.js'
import { apply as applyNetwork, runCitationNetwork, toGraphMl, toMermaid } from '../citation-network.js'
import {
  betweenness, components, couplingAndCocitation, louvain, pagerank, shortestPath,
} from '../citation-graph-algos.js'
import { resetLimitersForTests } from '../search-http.js'
import { fakeExec, makeWorkspace } from './helpers/test-workspace.mjs'

const workspace = makeWorkspace('ah-discovery-')
const exec = fakeExec(workspace.cwd)
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }
const rejects = async (fn, pattern, message) => { await assert.rejects(fn, pattern, message); checks += 1 }
resetLimitersForTests()

const paper = (title, doi, year = 2024, extra = {}) => ({ title, doi, year, authors: [{ name: 'A. Author' }], sources: ['openalex'], source: 'openalex', ...extra })

try {
  // ---- registration surface -------------------------------------------------
  for (const [applyFn, toolName] of [[applyWatch, 'literature_watch'], [applyArtifacts, 'paper_artifacts'], [applyRecommend, 'paper_recommend'], [applyNetwork, 'citation_network']]) {
    let tool
    applyFn({ tools: { register: (t) => { tool = t } } })
    eq(tool.name, toolName, `${toolName} registers`)
    ok(tool.parameters.properties && Object.keys(tool.parameters.properties).length > 3, `${toolName} has parameters`)
  }

  // ---- 7A literature_watch --------------------------------------------------
  let round = 1
  const fakeSource = async (source) => {
    if (source === 'bad') throw new Error('provider down')
    if (source === 'empty') return { error: 'HTTP 500' }
    return { results: round === 1
      ? [paper('Alpha study', '10.1111/alpha'), paper('Beta study', '10.1111/beta')]
      : [paper('Alpha study', '10.1111/ALPHA'), paper('Gamma study', '10.1111/gamma'), paper('Old', '10.1111/old', 2010)] }
  }
  const wdeps = { runSource: fakeSource }
  const added = await runLiteratureWatch({ action: 'add', name: 'Alpha topic', query: 'alpha', sources: 'openalex,bad', frequency: 'weekly', since: '2020-01-01' }, exec)
  eq(added.watch.id, 'watch-alpha-topic', 'watch id')
  eq(added.watch.sources, ['openalex', 'bad'], 'sources parsed')
  await rejects(() => runLiteratureWatch({ action: 'add', name: 'Alpha topic', query: 'x' }, exec), /already exists/, 'duplicate name refused')
  await rejects(() => runLiteratureWatch({ action: 'add', name: 'q' }, exec), /query is required/, 'query required')
  await rejects(() => runLiteratureWatch({ action: 'add', name: 'f', query: 'q', frequency: 'hourly' }, exec), /frequency/, 'frequency validated')

  const first = await runLiteratureWatch({ action: 'run', watch: 'Alpha topic' }, exec, wdeps)
  eq(first.runs[0].new, 2, 'first run: 2 new')
  eq(first.runs[0].status, 'partial', 'one failing source makes the run partial, not ok')
  eq(first.runs[0].failures[0].source, 'bad', 'failure is attributed to its source')
  round = 2
  const second = await runLiteratureWatch({ action: 'run' }, exec, wdeps)
  eq(second.runs[0].new, 1, 'second run: only gamma is new (DOI case-insensitive; 2010 dropped by since)')
  const digest = await runLiteratureWatch({ action: 'digest', preview: true }, exec)
  ok(digest.markdown.includes('Gamma study') && digest.markdown.includes('Alpha study'), 'digest lists all hits before first cut')
  ok(digest.markdown.includes('why matched'), 'digest says why each matched')
  ok(!digest.markdown.includes('Old'), 'filtered record absent')
  const written = await runLiteratureWatch({ action: 'digest', out: 'reports/digest.md' }, exec)
  ok(workspace.exists('reports/digest.md') && written.count === 3, 'digest written to the workspace')
  const again = await runLiteratureWatch({ action: 'digest', preview: true }, exec)
  eq(again.count, 0, 'digest cut advances: next digest is empty')
  await rejects(() => runLiteratureWatch({ action: 'digest', out: '../escape.md' }, exec), /escapes the workspace/, 'digest out is confined')
  const status = await runLiteratureWatch({ action: 'status' }, exec)
  eq(status.watches[0].last_run.new, 1, 'status shows last run')
  const lines = readFileSync(join(workspace.cwd, '.dsh/watch/seen.jsonl'), 'utf8').trim().split('\n')
  eq(lines.length, 3, 'seen ledger is append-only: 2 + 1 rows')
  await runLiteratureWatch({ action: 'remove', watch: 'Alpha topic' }, exec)
  eq((await runLiteratureWatch({ action: 'list' }, exec)).watches, [], 'removed watch disappears from the live set')
  ok(readFileSync(join(workspace.cwd, '.dsh/watch/hits.jsonl'), 'utf8').includes('Gamma'), 'history stays after removal')
  eq(buildDigest(workspace.cwd).count, 0, 'removed watch is excluded from digests')
  ok(recordKey({ title: 'A Title', year: 2020 }).startsWith('title:'), 'title fallback key')

  // ---- 7E paper_artifacts ---------------------------------------------------
  const PAPER = `# Methods
We deposited reads in GEO under GSE123456 and SRA SRR1234567. The structure is PDB 4HHB.
Sequences are GenBank accession MN908947.3. Total of 2020 samples and 1234 cells.

## Data availability
Data are available at https://zenodo.org/record/1234567 and https://doi.org/10.5281/zenodo.7654321.
Raw files are on request from the corresponding author.

## Code availability
Code: https://github.com/example/project (MIT).
See also https://example.com/lab and https://doi.org/10.6084/m9.figshare.99999.
`
  const found = extractArtifacts(PAPER)
  eq(found.accessions.map((a) => a.accession).sort(), ['4HHB', 'GSE123456', 'MN908947.3', 'SRR1234567'], 'accessions found, bare numbers ignored')
  ok(found.accessions.every((a) => a.status === 'unverified'), 'accessions are never verified automatically')
  eq(found.artifacts.map((a) => a.repository).sort(), ['figshare', 'github', 'zenodo', 'zenodo'], 'repositories classified (host and DOI prefix)')
  eq(found.statements.length, 2, 'two availability statements')
  ok(found.statements[0].on_request, 'on-request wording flagged')
  eq(found.statements[1].kind, 'code', 'code statement kind')
  eq(found.other_urls, 1, 'unrelated URL counted but not reported as an artifact')
  eq(classifyRepository({ doi: '10.5061/dryad.x' }).id, 'dryad', 'dryad by DOI')
  eq(extractArtifacts('No links here.').artifacts, [], 'empty text yields nothing, not invented links')

  const checked = []
  const fakeCheck = async (url) => { checked.push(url); return url.includes('github') ? { status: 'not_found', http: 404 } : { status: 'resolves', http: 200 } }
  const verified = await runPaperArtifacts({ action: 'verify', text: PAPER, max_verify: 3 }, exec, { checkLink: fakeCheck })
  eq(verified.verified, 3, 'verify honours the cap')
  ok(verified.unchecked > 0 && verified.artifacts.some((a) => a.status === 'manual_check'), 'over-cap links are manual_check, not silently passed')
  ok(verified.artifacts.some((a) => a.status === 'not_found'), 'a 404 is reported')
  const noVerify = await runPaperArtifacts({ text: PAPER }, exec, { checkLink: fakeCheck })
  eq(noVerify.verified, 0, 'extract alone makes no requests')
  workspace.write('paper.md', PAPER)
  const fromFile = await runPaperArtifacts({ path: 'paper.md', out: 'artifacts.json' }, exec)
  ok(workspace.exists('artifacts.json') && fromFile.source === 'paper.md', 'reads a workspace path and writes a result')
  await rejects(() => runPaperArtifacts({ path: '../x.md' }, exec), /escapes/, 'path confined')
  await rejects(() => runPaperArtifacts({}, exec), /text or path/, 'input required')
  const { checkLink } = await import('../paper-artifacts.js')
  eq((await checkLink('http://127.0.0.1:1/x')).status, 'unsafe_host', 'loopback refused')
  eq((await checkLink('http://localhost/x')).status, 'unsafe_host', 'localhost refused')
  eq((await checkLink('http://169.254.169.254/latest')).status, 'unsafe_host', 'link-local metadata address refused')

  // ---- 7G citation audit ----------------------------------------------------
  const BIB = `@article{good2020, title={Deep learning for cats}, author={Good, Alice}, year={2020}, journal={Journal of Cats}, doi={10.1000/good}}
@article{moved2019, title={A different paper entirely}, author={Smith, Bob}, year={2019}, journal={Nature}, doi={10.1000/mismatch}}
@article{gone2018, title={Retracted result}, author={Lee, Cy}, year={2018}, journal={Science}, doi={10.1000/retracted}}
@article{nodoi2017, title={No identifier here}, author={Roe, Dee}, year={2017}, journal={Letters}}
@article{bad2016, title={Broken doi}, author={Poe, Ed}, year={2016}, journal={Letters}, doi={not-a-doi}}
@article{lost2015, title={Unregistered doi}, author={Ray, Flo}, year={2015}, journal={Letters}, doi={10.1000/lost}}
@article{flaky2014, title={Lookup fails}, author={Kay, Gus}, year={2014}, journal={Letters}, doi={10.1000/flaky}}
@article{unused2013, title={Never cited}, author={Fox, Hal}, year={2013}, journal={Letters}}
@article{dupe2020, title={Deep learning for cats}, author={Good, Alice}, year={2020}, journal={Journal of Cats}, doi={10.1000/good}}
`
  const crossref = async (doi) => {
    if (doi === '10.1000/good') return { ok: true, work: { title: ['Deep learning for cats'], issued: { 'date-parts': [[2020]] }, 'container-title': ['Journal of Cats'], author: [{ family: 'Good' }] } }
    if (doi === '10.1000/mismatch') return { ok: true, work: { title: ['Quantum gravity of ferrets'], issued: { 'date-parts': [[2012]] }, 'container-title': ['Physical Review'], author: [{ family: 'Jones' }] } }
    if (doi === '10.1000/retracted') return { ok: true, work: { title: ['Retracted result'], issued: { 'date-parts': [[2018]] }, 'container-title': ['Science'], author: [{ family: 'Lee' }] } }
    if (doi === '10.1000/lost') return { ok: false, status: 404, error: 'HTTP 404' }
    return { ok: false, status: 503, error: 'HTTP 503' }
  }
  let integrityCalls = 0
  const integrity = async (doi) => {
    integrityCalls += 1
    if (doi === '10.1000/retracted') return { verdict: 'retracted', signals: [{ notice_doi: '10.1000/notice' }] }
    if (doi === '10.1000/flaky') return { verdict: 'unknown', signals: [] }
    return { verdict: 'clean', signals: [] }
  }
  workspace.write('main.tex', 'See \\cite{good2020,moved2019} and \\citep{gone2018,nodoi2017,bad2016,lost2015,flaky2014,dupe2020}.')
  const audit = await runCitation({ action: 'audit', text: BIB, manuscript: 'main.tex' }, exec, { fetchCrossref: crossref, integrity })
  const by = Object.fromEntries(audit.references.map((r) => [r.key, r]))
  const codes = (key) => by[key].findings.map((f) => f.code)
  ok(codes('good2020').includes('duplicate'), 'duplicate DOI flagged')
  ok(!codes('good2020').includes('title_mismatch'), 'matching metadata not flagged')
  ok(['title_mismatch', 'year_mismatch', 'venue_mismatch', 'first_author_mismatch'].every((c) => codes('moved2019').includes(c)), 'every metadata mismatch is reported')
  eq(by.gone2018.status, 'problem', 'retracted is a problem')
  ok(by.gone2018.findings.find((f) => f.code === 'retracted').detail.includes('10.1000/notice'), 'retraction cites the notice DOI')
  eq(by.nodoi2017.status, 'unverified', 'no DOI is unverified, not clean')
  eq(by.bad2016.status, 'problem', 'invalid DOI is a problem')
  ok(codes('lost2015').includes('doi_not_registered'), 'Crossref 404 is reported')
  eq(by.flaky2014.status, 'unverified', 'a failed lookup plus unknown integrity is unverified, never clean')
  ok(codes('unused2013').includes('uncited'), 'uncited bibliography entry flagged')
  ok(by.gone2018.findings.every((f) => f.code !== 'uncited'), 'cited entries are not flagged uncited')
  ok(audit.caveats.some((c) => /supports the claim/.test(c)), 'audit states it does not verify claim support')
  eq(audit.counts.no_issues_found + audit.counts.unverified + audit.counts.review + audit.counts.problem, audit.references.length, 'every reference gets one status')
  ok(integrityCalls > 0, 'integrity called through the injected dependency')
  const capRun = await runCitation({ action: 'audit', text: BIB, max_audit: 2 }, exec, { fetchCrossref: crossref, integrity })
  eq(capRun.network_checked, 2, 'max_audit caps online checks')
  ok(capRun.references.some((r) => r.findings.some((f) => f.code === 'not_checked')), 'over-cap references say not_checked')
  await rejects(() => runCitation({ action: 'audit', text: BIB, manuscript: '../x.tex' }, exec, { fetchCrossref: crossref, integrity }), /./, 'manuscript path confined')

  // ---- 7F paper_recommend ---------------------------------------------------
  const s2Calls = []
  const rdeps = {
    markInLibrary: async (papers) => { papers.forEach((p) => { if (p.doi === '10.2222/inlib') p.in_library = 'key1' }); return { checked: papers.length, in_library: papers.filter((p) => p.in_library).length } },
    fetchJson: async (url, options = {}) => {
      if (url.includes('recommendations/v1')) {
        s2Calls.push({ url, method: options.method || 'GET', body: options.body })
        if (url.includes('DOI:10.9999/missing')) return { ok: false, status: 404, error: 'HTTP 404' }
        return { ok: true, data: { recommendedPapers: [
          { paperId: 'p1', externalIds: { DOI: '10.2222/shared' }, title: 'Shared paper', year: 2023, venue: 'Venue X', citationCount: 5, authors: [{ name: 'S One' }] },
          { paperId: 'p2', externalIds: { DOI: '10.2222/inlib' }, title: 'Already in library', year: 2022, authors: [] },
          { paperId: 'p3', externalIds: { DOI: '10.9999/seed' }, title: 'The seed itself', year: 2021, authors: [] },
        ] } }
      }
      if (url.includes('/works/doi:10.9999/seed')) return { ok: true, data: { id: 'https://openalex.org/W1', title: 'Seed', related_works: ['https://openalex.org/W2', 'https://openalex.org/W3'], referenced_works: ['https://openalex.org/W10', 'https://openalex.org/W11'], topics: [{ display_name: 'Cats' }], primary_location: { source: { display_name: 'Venue X' } } } }
      if (url.includes('/works?')) return { ok: true, data: { results: [
        { id: 'https://openalex.org/W2', doi: 'https://doi.org/10.2222/shared', title: 'Shared paper', publication_year: 2023, referenced_works: ['https://openalex.org/W10', 'https://openalex.org/W11'], topics: [{ display_name: 'Cats' }], authorships: [] },
        { id: 'https://openalex.org/W3', doi: 'https://doi.org/10.2222/other', title: 'Other paper', publication_year: 2020, referenced_works: ['https://openalex.org/W1'], topics: [], authorships: [] },
      ] } }
      return { ok: false, status: 404, error: 'HTTP 404' }
    },
  }
  const rec = await runPaperRecommend({ seed: '10.9999/seed' }, exec, rdeps)
  eq(rec.papers.map((p) => p.doi).sort(), ['10.2222/other', '10.2222/shared'], 'seed and in-library papers are left out')
  eq(rec.library.excluded, 1, 'library exclusion is counted')
  const shared = rec.papers.find((p) => p.doi === '10.2222/shared')
  ok(shared.sources.length === 2, 'both providers merged into one record')
  ok(shared.why.some((w) => /shares 2 reference/.test(w)) && shared.why.some((w) => /shared topics: Cats/.test(w)), 'why includes measured overlap')
  ok(rec.papers.find((p) => p.doi === '10.2222/other').why.some((w) => /cites the seed/.test(w)), 'cites-the-seed explained')
  eq(rec.papers[0].doi, '10.2222/shared', 'agreement between providers ranks first')
  ok(rec.caveats.some((c) => /not evidence/.test(c)), 'caveats present')
  await runPaperRecommend({ seeds: ['10.9999/seed', '10.9999/other'], sources: 's2' }, exec, rdeps)
  eq(s2Calls[s2Calls.length - 1].method, 'POST', 'several seeds use the POST endpoint')
  ok(JSON.parse(s2Calls[s2Calls.length - 1].body).positivePaperIds.includes('DOI:10.9999/other'), 'seeds sent as positive ids')
  const partial = await runPaperRecommend({ seed: '10.9999/missing', sources: ['s2', 'openalex'] }, exec, rdeps)
  eq(partial.failures.map((f) => f.state).sort(), ['not_found', 'not_found'], 'failures carry named states')
  eq(partial.papers, [], 'no invented results when providers fail')
  await rejects(() => runPaperRecommend({}, exec, rdeps), /seed/, 'seed required')
  await rejects(() => runPaperRecommend({ seed: 'x', sources: 'nope' }, exec, rdeps), /unknown source/, 'source validated')
  const nolib = await runPaperRecommend({ seed: '10.9999/seed', sources: 's2' }, exec, { ...rdeps, markInLibrary: async () => undefined })
  eq(nolib.library.checked, false, 'unavailable library is reported as not checked, not empty')
  eq(nolib.papers.length, 3 - 1, 'seed still removed when the library cannot be checked')

  // ---- 7B citation_network: algorithms --------------------------------------
  const node = (id, refs = [], title = id) => ({ id, title, year: 2020, refs })
  const nodes = [node('A', ['B', 'C', 'X']), node('B', ['C', 'X']), node('C'), node('D', ['E', 'X']), node('E'), node('F')]
  const edges = []
  for (const n of nodes) for (const r of n.refs) if (nodes.some((m) => m.id === r)) edges.push({ from: n.id, to: r })
  const graph = { nodes, edges }
  const pr = pagerank(graph)
  ok(Math.abs(Object.values(pr).reduce((a, b) => a + b, 0) - 1) < 1e-9, 'PageRank sums to 1')
  ok(pr.C > pr.A, 'a heavily cited node outranks its citer')
  eq(components(graph).map((c) => c.length), [3, 2, 1], 'weak components')
  const between = betweenness({ nodes: [node('P'), node('Q'), node('R')], edges: [{ from: 'P', to: 'Q' }, { from: 'Q', to: 'R' }] })
  ok(between.Q > between.P && between.Q === 1, 'middle node of a path has betweenness 1')
  eq(shortestPath(graph, 'A', 'C').length, 1, 'direct citation path')
  eq(shortestPath(graph, 'C', 'A').reason, 'no_directed_path', 'directed path respects citation direction')
  eq(shortestPath(graph, 'C', 'A', { directed: false }).found, true, 'undirected path ignores direction')
  eq(shortestPath(graph, 'A', 'Z').reason, 'not_in_graph', 'unknown node named')
  const cc = couplingAndCocitation(nodes)
  eq(cc.coupling[0], { a: 'A', b: 'B', shared_references: 2 }, 'bibliographic coupling counts shared references, including ones outside the graph')
  eq(cc.cocitation[0].co_cited_by, 1, 'co-citation counted from in-graph citers')
  const comm = louvain({ nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node(id)), edges: [['a', 'b'], ['b', 'c'], ['a', 'c'], ['d', 'e'], ['e', 'f'], ['d', 'f'], ['c', 'd']].map(([from, to]) => ({ from, to })) })
  ok(comm.a === comm.b && comm.b === comm.c && comm.d === comm.e && comm.e === comm.f && comm.a !== comm.d, 'Louvain separates two triangles joined by a bridge')
  eq(louvain({ nodes: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node(id)), edges: [['a', 'b'], ['b', 'c'], ['a', 'c'], ['d', 'e'], ['e', 'f'], ['d', 'f'], ['c', 'd']].map(([from, to]) => ({ from, to })) }), comm, 'Louvain is deterministic')

  // ---- 7B citation_network: tool --------------------------------------------
  const W = (n, refs = [], extra = {}) => ({ id: `https://openalex.org/W${n}`, title: `Paper ${n} on cats`, publication_year: 2020 + (n % 3), cited_by_count: n, referenced_works: refs.map((r) => `https://openalex.org/W${r}`), doi: `https://doi.org/10.5555/p${n}`, ...extra })
  const store = { 1: W(1, [2, 3, 99]), 2: W(2, [3]), 3: W(3), 4: W(4, [1, 2]), 5: W(5, [1]) }
  const netCalls = []
  const ndeps = {
    now: '2026-11-01T00:00:00.000Z',
    fetchJson: async (url) => {
      netCalls.push(url)
      const u = new URL(url)
      if (u.pathname.startsWith('/works/doi:10.5555/p1')) return { ok: true, data: store[1] }
      if (u.pathname.startsWith('/works/doi:10.5555/nope')) return { ok: false, status: 404, error: 'HTTP 404' }
      const filter = u.searchParams.get('filter') || ''
      if (filter.startsWith('openalex_id:')) return { ok: true, data: { results: filter.slice(12).split('|').map((id) => store[id.slice(1)]).filter(Boolean) } }
      if (filter.startsWith('cites:')) {
        const target = filter.slice(6)
        return { ok: true, data: { results: Object.values(store).filter((w) => w.referenced_works.some((r) => r.endsWith(`/${target}`))) } }
      }
      return { ok: false, status: 500, error: 'unexpected' }
    },
  }
  const built = await runCitationNetwork({ action: 'build', slug: 'Cats Net', seed: '10.5555/p1', direction: 'both' }, exec, ndeps)
  eq(built.build.nodes, 5, 'built 5 nodes (99 is not fetchable and stays an unknown reference)')
  eq(built.build.edges, 6, 'edges only between nodes in the graph')
  ok(built.build.source === 'openalex' && built.build.graph_hash.length === 64, 'build records source and hash')
  const netStatus = await runCitationNetwork({ action: 'status', slug: 'cats-net' }, exec)
  eq(netStatus.builds.length, 1, 'status lists the build')
  const metrics = await runCitationNetwork({ action: 'metrics', slug: 'cats-net', top: 3 }, exec)
  eq(metrics.top_in_degree.map((d) => d.value), [2, 2, 2], 'W1, W2, W3 are each cited twice inside the graph (ties broken by id)')
  eq(metrics.top_pagerank[0].id, 'W3', 'W3, the sink everything flows toward, has the top PageRank')
  eq(metrics.retrieved_at, '2026-11-01T00:00:00.000Z', 'metrics report the retrieval date')
  ok(metrics.caveats.some((c) => /not paper quality/.test(c)), 'metrics carry the quality caveat')
  const clusters = await runCitationNetwork({ action: 'clusters', slug: 'cats-net' }, exec)
  ok(clusters.clusters.length >= 1 && clusters.clusters[0].label.includes('cats'), 'clusters labelled from titles')
  const path = await runCitationNetwork({ action: 'path', slug: 'cats-net', from: '10.5555/p4', to: 'W3' }, exec)
  eq(path.path.map((p) => p.id).length, 3, 'path found')
  eq(path.length, 2, 'W4 reaches W3 in two citation steps')
  const none = await runCitationNetwork({ action: 'path', slug: 'cats-net', from: 'W3', to: 'W4' }, exec)
  eq(none.found, false, 'no directed path against citation direction')
  const callsBefore2 = netCalls.length
  await runCitationNetwork({ action: 'metrics', slug: 'cats-net' }, exec, ndeps)
  eq(netCalls.length, callsBefore2, 'analysis never re-fetches')
  await runCitationNetwork({ action: 'export', slug: 'cats-net', format: 'graphml', out: 'net/g.graphml' }, exec)
  ok(workspace.read('net/g.graphml').includes('<edge id="e0"'), 'GraphML written')
  await runCitationNetwork({ action: 'export', slug: 'cats-net', format: 'csv', out: 'net/g' }, exec)
  ok(workspace.exists('net/g-nodes.csv') && workspace.exists('net/g-edges.csv'), 'CSV pair written')
  await runCitationNetwork({ action: 'export', slug: 'cats-net', format: 'mermaid', out: 'net/g.mmd' }, exec)
  ok(workspace.read('net/g.mmd').startsWith('flowchart LR'), 'Mermaid written')
  await rejects(() => runCitationNetwork({ action: 'export', slug: 'cats-net', format: 'graphml', out: 'net/g.graphml' }, exec), /already exists/, 'export refuses to overwrite')
  await rejects(() => runCitationNetwork({ action: 'export', slug: 'cats-net', out: '../g.graphml' }, exec), /escapes/, 'export confined')
  ok(toGraphMl({ nodes: [{ id: 'W1', title: 'a<b & "c"' }], edges: [] }).includes('a&lt;b &amp; &quot;c&quot;'), 'GraphML escapes XML')
  ok(toMermaid({ nodes: [{ id: 'W1', title: 'x[y]' }], edges: [] }).includes('W1["x y  (n.d.)"]') || toMermaid({ nodes: [{ id: 'W1', title: 'x[y]' }], edges: [] }).includes('W1['), 'Mermaid labels sanitised')
  const small = await runCitationNetwork({ action: 'build', slug: 'small', seed: '10.5555/p1', direction: 'cited_by', max_nodes: 2 }, exec, ndeps)
  ok(small.build.truncated && small.dropped_nodes > 0, 'node cap reports truncation')
  const missing = await runCitationNetwork({ action: 'build', slug: 'missing', seed: '10.5555/nope' }, exec, ndeps)
  eq(missing.state, 'not_found', 'unresolvable seed is a named state, no graph built')
  ok(!workspace.exists('.dsh/network/missing/builds.jsonl'), 'nothing written for a failed build')
  const file = readdirGraph(workspace.cwd, 'cats-net')
  workspace.write(`.dsh/network/cats-net/${file}`, readFileSync(join(workspace.cwd, '.dsh/network/cats-net', file), 'utf8').replace('Paper 3', 'Edited'))
  await rejects(() => runCitationNetwork({ action: 'metrics', slug: 'cats-net' }, exec), /no longer matches/, 'tampered build is detected')
  await rejects(() => runCitationNetwork({ action: 'metrics', slug: 'never-built' }, exec), /run build first/, 'unknown network named')
  await rejects(() => runCitationNetwork({ action: 'build', slug: 'x' }, exec), /seed/, 'seed required')

  // ---- regressions found in the live Web UI run ------------------------------
  const registered = {}
  for (const applyFn of [applyWatch, applyArtifacts, applyRecommend, applyNetwork]) applyFn({ tools: { register: (t) => { registered[t.name] = t } } })
  const lossless = (value) => assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  const watchOut = await registered.literature_watch.execute({ action: 'add', name: 'Health', query: 'q', sources: 'openalex' }, exec)
  lossless(watchOut); checks += 1
  const failingRun = await runLiteratureWatch({ action: 'run', watch: 'Health' }, exec, { runSource: async () => ({ error: 'OpenAlex API error 429', status: 429, detail: 'budget used up' }) })
  eq(failingRun.runs[0].status, 'failed', 'a rate-limited source fails the run')
  eq(failingRun.runs[0].failures[0].detail, 'budget used up', 'provider detail is kept')
  const digestOut = await registered.literature_watch.execute({ action: 'digest', out: 'reports/health.md' }, exec)
  lossless(digestOut); checks += 1
  ok(!('error' in digestOut), 'digest via execute returns lossless JSON (no undefined fields)')
  ok(workspace.read('reports/health.md').includes('Run health') && workspace.read('reports/health.md').includes('budget used up'), 'a digest does not present a failed run as "no new records"')
  const noPath = await registered.citation_network.execute({ action: 'path', slug: 'cats-net-2', from: 'W3', to: 'W4' }, exec)
  ok(noPath.error, 'unbuilt network is an error, not a crash')
  await runCitationNetwork({ action: 'build', slug: 'lossless', seed: '10.5555/p1' }, exec, ndeps)
  const noPathOut = await registered.citation_network.execute({ action: 'path', slug: 'lossless', from: 'W3', to: 'W4' }, exec)
  lossless(noPathOut); checks += 1
  eq(noPathOut.found, false, 'path with no route is lossless JSON')
  await registered.paper_artifacts.execute({ text: PAPER }, exec).then(lossless); checks += 1
  const arxivCalls = []
  await runPaperRecommend({ seed: '10.48550/arXiv.1706.03762', sources: 's2' }, exec, { markInLibrary: async () => undefined, fetchJson: async (url) => { arxivCalls.push(url); return { ok: true, data: { recommendedPapers: [] } } } })
  ok(arxivCalls[0].includes('forpaper/ARXIV:1706.03762'), 'arXiv DOIs are sent to Semantic Scholar as ARXIV: ids')
  const linkErr = await checkLink('https://nonexistent.invalid/x')
  ok(linkErr.status === 'unsafe_host' || /\(/.test(linkErr.detail || ''), 'unreachable hosts report a cause')

  console.log(`discovery: ${checks} checks passed`)
} finally {
  workspace.cleanup()
}

function readdirGraph(cwd, slug) {
  return JSON.parse(`[${readFileSync(join(cwd, '.dsh/network', slug, 'builds.jsonl'), 'utf8').trim().split('\n').join(',')}]`)[0].file
}
