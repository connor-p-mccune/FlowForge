// Predictive run forecast: estimate a workflow's duration and its likely
// bottleneck *before* running it, by laying each node's historical step-time onto
// the graph and finding the critical path. This is the same critical path method
// `criticalPath.js` applies to a finished run — a longest-path search over a DAG
// weighted by node time — run *forward* over the static graph with *expected*
// (rather than observed) node times. Where critical-path analysis says where a
// run's time went, the forecast says where it will go.
//
// Pure: `computeForecast(graph, statsByNode)` — no database, no engine.
//   graph        { nodes, edges } from the workflow
//   statsByNode  { [nodeId]: { p50, p95, samples, nodeType } } — expected ms
//
// The estimate is the longest dependency chain by expected node time. It assumes
// any branch might run (it takes the longest path through the *whole* graph), so
// for a workflow with conditional branches it's a worst-case makespan, not an
// average — the honest framing for "how long could this take". Nodes with no
// history contribute zero time and count against `coverage`, the forecast's
// confidence signal: an estimate over a graph the workflow has barely exercised
// is a guess, and the coverage ratio says so.

const round = (v) => (v == null ? null : Math.round(v))

// Longest path through a DAG under a per-node weight function, via Kahn's
// algorithm for a topological order and a single DP pass with back-pointers —
// the same shape as criticalPath.js, generalised to any weight. Returns null on
// a cycle (an invalid graph has no meaningful forecast).
function longestPath(nodes, edges, weightOf) {
  const preds = new Map()
  const adj = new Map()
  const indegree = new Map()
  for (const n of nodes) {
    preds.set(n.id, [])
    adj.set(n.id, [])
    indegree.set(n.id, 0)
  }
  const seen = new Set()
  for (const e of edges) {
    if (!preds.has(e.source) || !preds.has(e.target)) continue
    if (e.source === e.target) continue // self-loop
    const key = `${e.source} ${e.target}`
    if (seen.has(key)) continue // collapse duplicate edges
    seen.add(key)
    adj.get(e.source).push(e.target)
    preds.get(e.target).push(e.source)
    indegree.set(e.target, indegree.get(e.target) + 1)
  }

  const queue = []
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id)
  const order = []
  let head = 0
  const working = new Map(indegree)
  while (head < queue.length) {
    const id = queue[head++]
    order.push(id)
    for (const next of adj.get(id)) {
      working.set(next, working.get(next) - 1)
      if (working.get(next) === 0) queue.push(next)
    }
  }
  if (order.length !== nodes.length) return null // cycle

  const best = new Map()
  const prev = new Map()
  let end = null
  for (const id of order) {
    let bestPred = -Infinity
    let chosen = null
    for (const p of preds.get(id)) {
      if (best.get(p) > bestPred) {
        bestPred = best.get(p)
        chosen = p
      }
    }
    best.set(id, (chosen === null ? 0 : bestPred) + weightOf(id))
    prev.set(id, chosen)
    // `>=` (not `>`) so that among equal-length paths we end at the
    // topologically-later node — i.e. the chain runs through to a sink rather
    // than stopping at the last node that happened to add time. A zero-weight
    // sink (e.g. a log node) then still appears on the reported path.
    if (end === null || best.get(id) >= best.get(end)) end = id
  }

  const path = []
  for (let id = end; id != null; id = prev.get(id)) path.push(id)
  path.reverse()
  return { path, total: end === null ? 0 : best.get(end) }
}

function computeForecast(graph, statsByNode = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  if (nodes.length === 0) return { available: false, reason: 'empty' }

  const p50Of = (id) => statsByNode[id]?.p50 ?? 0
  const p95Of = (id) => statsByNode[id]?.p95 ?? 0

  // The typical critical path is the longest chain by p50; the p95 estimate is
  // computed independently (its longest chain may differ) — a worst-case ceiling.
  const typical = longestPath(nodes, edges, p50Of)
  if (!typical) return { available: false, reason: 'cycle' }
  const slow = longestPath(nodes, edges, p95Of)

  // Coverage over nodes that carry real work: trigger nodes just pass the payload
  // through, so they have no step time to have history for and shouldn't drag the
  // confidence signal down.
  const workNodes = nodes.filter((n) => !String(n.type || '').startsWith('trigger-'))
  const withHistory = workNodes.filter((n) => (statsByNode[n.id]?.samples || 0) > 0).length

  // The bottleneck is the node on the typical critical path contributing the most
  // time — the one to optimise first. Null when nothing on the path has history.
  let bottleneck = null
  for (const id of typical.path) {
    const p50 = p50Of(id)
    if (bottleneck === null || p50 > bottleneck.p50) {
      bottleneck = { nodeId: id, nodeType: statsByNode[id]?.nodeType ?? null, p50, p95: p95Of(id) }
    }
  }
  if (bottleneck && bottleneck.p50 === 0) bottleneck = null

  const perNode = {}
  for (const id of typical.path) {
    perNode[id] = {
      p50: round(p50Of(id)),
      p95: round(p95Of(id)),
      samples: statsByNode[id]?.samples ?? 0,
    }
  }

  return {
    available: true,
    criticalPath: typical.path,
    estimatedMs: round(typical.total),
    estimatedP95Ms: round(slow.total),
    bottleneck: bottleneck
      ? { ...bottleneck, p50: round(bottleneck.p50), p95: round(bottleneck.p95) }
      : null,
    perNode,
    coverage: {
      nodesWithHistory: withHistory,
      workNodes: workNodes.length,
      ratio: workNodes.length ? withHistory / workNodes.length : 0,
    },
  }
}

module.exports = { computeForecast, longestPath }
