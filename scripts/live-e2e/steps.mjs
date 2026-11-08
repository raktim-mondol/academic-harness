// The scripted tool-call sequence for the live end-to-end run. Each step is a function
// of the history so far (rendered tool results, exactly as a model would see them).
// No judgment is simulated: claimed overlaps are left "unknown" on purpose.
const IDENTITY = { dataset: { id: 'd', version_or_hash: 'v1' }, split: { id: 'test', version_or_hash: 's1' }, baseline_cohort_id: 'ref', metric_definitions: { acc: { unit: 'fraction', implementation: 'acc-v1', parameters: {} } } }
const STAGED = { action: 'log', slug: 'bench', stage: 'slice', baseline_ref: 'reproduced', comparison_identity: IDENTITY, sampling: { rule: 'first 100 per class', size: 100, seed: 7 } }
const CLAIM = 'Large language models can be used as zero-shot rerankers for scientific literature search.'

const need = (value, what) => { if (!value) throw new Error(`step could not find ${what} in the previous result`); return value }
const scopeOf = (h) => need(/Comparison scope \(user-declared\): (\S+)/.exec(h[2].text)?.[1], 'the comparison scope id')
const analysisRunOf = (h) => need(/run-\d{8}T\d{6}-[0-9a-f]{6}(?:-\d+)?/.exec(h[10].text)?.[0], 'the analysis run id')

function candidatesFrom(text) {
  const blocks = text.split(/^\d+\. \*\*/m).slice(1)
  return blocks.slice(0, 8).map((block) => {
    const title = block.split('**')[0].trim()
    const doi = /doi: (10\.[^\s·]+)/.exec(block)?.[1]
    const body = block.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim()
    const abstractish = body.length > 250
    return { ref: { title, ...(doi ? { doi } : {}) }, provider: 'literature_search', evidence_level: abstractish ? 'abstract' : 'metadata_only', ...(abstractish ? { text: body } : {}), quotes: [], overlap: { claimed: 'unknown' } }
  })
}

export const steps = [
  /* 0 */ () => ({ name: 'research_template', input: { action: 'get', id: 'research-cycle', values: { slug: 'bench', question: 'Does the variant beat the baseline?' } } }),
  /* 1 */ () => ({ name: 'experiment_log', input: { action: 'start', slug: 'bench', question: 'Does the variant beat the baseline?', experiment: { metrics: [{ name: 'acc', direction: 'higher' }], benchmark: { datasets: ['d'], splits: ['test'], baseline_arm: 'base', task_rules: ['fixed'] }, protocol: { eval_script: 'eval.py', metric_params: { k: 1 } } } } }),
  /* 2 */ () => ({ name: 'experiment_log', input: { ...STAGED, role: 'baseline', seed: 1, params: { method: 'base' }, metrics: { acc: 0.6 } } }),
  /* 3 */ () => ({ name: 'experiment_log', input: { ...STAGED, role: 'baseline', seed: 2, params: { method: 'base' }, metrics: { acc: 0.62 } } }),
  /* 4 */ () => ({ name: 'experiment_log', input: { ...STAGED, role: 'variant', seed: 1, params: { method: 'variant' }, baseline_run_id: 'x0001', metrics: { acc: 0.7 } } }),
  /* 5 */ () => ({ name: 'experiment_log', input: { ...STAGED, role: 'variant', seed: 3, params: { method: 'variant' }, baseline_run_id: 'x0001', metrics: { acc: 0.74 } } }),
  /* 6 */ () => ({ name: 'experiment_log', input: { action: 'compare', slug: 'bench' } }),
  /* 7 */ (h) => ({ name: 'experiment_log', input: { action: 'best', slug: 'bench', metric: 'acc', scope_id: scopeOf(h) } }),
  /* 8 */ (h) => ({ name: 'experiment_log', input: { action: 'replicates', slug: 'bench', scope_id: scopeOf(h), metric: 'acc', candidate_field: 'method', candidates: ['base', 'variant'], baseline_candidate: 'base', replicate_unit: 'one training run', expected_seeds: [1, 2, 3] } }),
  /* 9 */ () => ({ name: 'analysis_run', input: { action: 'plan', slug: 'figgen', plan: { question: 'Does make_fig.py produce the figure?', outputs: ['out/fig.png', 'out/metrics.json'] } } }),
  /* 10 */ () => ({ name: 'analysis_run', input: { action: 'run', slug: 'figgen', kind: 'python', command: ['python3', 'make_fig.py'] } }),
  /* 11 */ (h) => ({ name: 'experiment_log', input: { action: 'link', slug: 'bench', run_id: 'x0004', target_kind: 'analysis_run', target_id: `figgen:${analysisRunOf(h)}` } }),
  /* 12 */ () => ({ name: 'experiment_log', input: { action: 'branches', slug: 'bench', format: 'text' } }),
  /* 13 */ (h) => ({ name: 'figure_audit', input: { action: 'handoff', figure: 'out/fig.png', reference: 'Figure 1', caption: 'Figure 1. Accuracy was 0.81 (n = 120).', sources: [{ kind: 'analysis_run', slug: 'figgen', run_id: analysisRunOf(h), path: 'out/metrics.json' }, { kind: 'experiment_run', slug: 'bench', run_id: 'x0004' }], values: [{ path: 'out/metrics.json', format: 'json', field: 'metrics.acc' }, { path: 'out/metrics.json', format: 'json', field: 'metrics.n' }], vision_review: { reviewer: 'scripted-e2e', summary: 'A small blue square; this text stands in for a subagent_vision reading.' } } }),
  /* 14 */ () => ({ name: 'figure_audit', input: { paths: ['out/fig.png'] } }),
  /* 15 */ () => ({ name: 'literature_search', input: { query: 'large language model zero-shot reranking scientific literature search', max_results: 8, include_abstracts: true } }),
  /* 16 */ (h) => {
    const candidates = candidatesFrom(h[15].text)
    return { name: 'prior_art', input: { claim: CLAIM, searches: [{ provider: 'literature_search', query: 'large language model zero-shot reranking scientific literature search', status: candidates.length ? 'ok' : 'failed', accessed_at: new Date().toISOString(), limit: 8, result_count: candidates.length }], candidates } }
  },
  /* 17 */ (h) => ({ name: 'prior_art', input: { claim: CLAIM, write: true, slug: 'e2e live claim', searches: [{ provider: 'literature_search', query: 'large language model zero-shot reranking scientific literature search', status: 'ok', accessed_at: new Date().toISOString(), limit: 8, result_count: 0 }], candidates: [] } }),
  /* 18 */ () => ({ name: 'research_template', input: { action: 'list', category: 'data' } }),
]
export const finalText = 'Live end-to-end script complete: phases 1-5 tools exercised in the real host.'
