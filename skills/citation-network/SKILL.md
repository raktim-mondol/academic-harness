---
name: citation-network
description: Build and analyze a citation graph around seed papers with `citation_network` - frozen OpenAlex builds, degree/PageRank/betweenness, bibliographic coupling and co-citation, Louvain clusters, shortest citation paths, and GraphML/CSV/Mermaid export. Use when mapping a field from a few key papers, finding the papers everything else cites, spotting sub-communities, or showing how two papers connect.
allowed-tools: Read Write Edit Bash
license: MIT license
metadata:
  version: "1.0"
  skill-author: Academic Harness
---

# Citation network

> **In Academic Harness:** `citation_network` `build` samples OpenAlex around your seeds
> and freezes the result under `.dsh/network/<slug>/` with source, retrieval time, and a
> hash. `metrics`, `clusters`, `path`, and `export` read that frozen build, so they are
> repeatable and make no requests. If a build file is edited afterwards, analysis refuses it.

## Build a graph you can defend

1. **Pick seeds deliberately.** The graph reflects the seeds; say why each was chosen.
2. **Choose direction.** `cites` is the seeds' reference lists (foundations), `cited_by`
   is later work (impact), `both` is the default.
3. **Keep it small.** Depth 1 with 25 per node is usually enough; depth 2 grows quickly.
   Per-node and total caps are hard limits and a call budget applies.
4. **Check `truncated`.** If the build was cut, say so wherever you report the numbers;
   rankings from a truncated graph describe what was sampled.
5. **Rebuild instead of editing.** A new `build` adds a version; earlier ones remain.

## Reading the numbers

| Output | Means | Does not mean |
|---|---|---|
| In-degree | cited by many papers *in this graph* | important or correct |
| PageRank | cited by papers that are themselves cited | quality |
| Betweenness (undirected) | bridges communities in this sample | a bridging idea |
| Bibliographic coupling | share references — likely related topic | one cites the other |
| Co-citation | cited together by papers in the graph (a lower bound) | agree with each other |
| Louvain clusters | densely linked groups; labels are title words | a topic model |
| Path | one shortest route in the sample | the only or true route |

## Guardrails

- **Citation counts and centrality are not quality.** Old, large-field, and review
  papers rank high for structural reasons; recent work is under-linked.
- **Absence of an edge is not absence of a citation.** OpenAlex coverage and the
  sampling limits both drop edges.
- **No author disambiguation.** Do not report author-level findings from this graph.
- **Name the source and date.** Methods text: "Citation links were retrieved from
  OpenAlex on <retrieved_at> (build <id>)."
- **Seeds must resolve.** An unknown DOI is `not_found` and no graph is built.

## Export

`graphml` for Gephi/Cytoscape/networkx; `csv` writes `-nodes.csv` and `-edges.csv`;
`mermaid` draws the top PageRank nodes (default 60) for a quick figure. Exports refuse to
overwrite unless `overwrite: true`, and stay inside the workspace.
