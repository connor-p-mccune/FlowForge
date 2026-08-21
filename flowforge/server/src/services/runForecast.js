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
//
// A longest path is also an estimate for a machine with **unbounded
// parallelism**, and the engine does not have one: it runs at most
// EXEC_MAX_PARALLEL nodes at a time. For a graph narrower than the cap the two
// agree exactly; for a wide one they do not, and the difference is the whole
// error. Twelve independent 1s nodes have a one-node critical path and take
// three seconds at a cap of four. So the forecast carries a second estimate
// alongside the first — the makespan from simulating the scheduler under the
// real cap, with the real launch order — plus what it would take to close the
// gap. See services/scheduleSim.js.

const compensation = require('./compensation')
const nodePriority = require('./nodePriority')
const scheduleSim = require('./scheduleSim')

const round = (v) => (v == null ? null : Math.round(v))

// How many caps the reported speedup curve covers. Enough to show the shape
// around a default of 4 without turning a read endpoint into a sweep.
const CURVE_MAX_CAP = 8

// The graph the engine would actually run. Sticky notes are canvas annotations
// and a compensation only executes if the run ends badly; the engine strips both
// before it builds a topological order, so a forecast that didn't would be
// describing a different graph — and a note on the longest path would appear on
// it, contributing nothing and explaining nothing.
function runnableGraph(graph) {
  const allNodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const allEdges = Array.isArray(graph?.edges) ? graph.edges : []
  const noteIds = new Set(allNodes.filter((n) => n.type === 'note').map((n) => n.id))
  return compensation.stripCompensations(
    allNodes.filter((n) => !noteIds.has(n.id)),
    allEdges.filter((e) => !noteIds.has(e.source) && !noteIds.has(e.target))
  )
}

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

function computeForecast(graph, statsByNode = {}, options = {}) {
  const { nodes, edges } = runnableGraph(graph)
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
    concurrency: computeContention({ nodes, edges }, statsByNode, {
      p50Of,
      p95Of,
      criticalPathMs: typical.total,
      cap: options.cap,
    }),
  }
}

// What the cap costs this graph, and what would fix it.
//
// `estimatedMs` above is the critical path: the duration with a slot always
// free. This simulates the same graph under the real cap, with the same launch
// order the engine uses, and reports the difference. Every field answers a
// question somebody actually asks at the point they notice a workflow is slow:
//
//   makespanMs        how long it will really take
//   queuedMs          how much of that is nodes waiting for capacity, not work
//   contention        makespanMs ÷ critical path — 1.0 means the cap costs
//                     nothing, 3.0 means the run is three times its own depth
//   averageParallelism  total work ÷ critical path: the ceiling on any speedup.
//                     1.4 means this workflow is mostly a chain and no amount
//                     of capacity will help it, which is the more useful answer
//                     when it is true.
//   knee              the smallest cap within 5% of the unbounded floor — the
//                     point past which more slots buy nothing
//   chain             the makespan-determining back-chain, each link labelled
//                     `data` or `slot`
//
// Reported, never applied. EXEC_MAX_PARALLEL is process-wide and shared by every
// concurrent run, so the right value is an operator's call informed by this
// number rather than something one workflow's forecast may set.
function computeContention(graph, statsByNode, { p50Of, p95Of, criticalPathMs, cap }) {
  const requested = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : scheduleSim.configuredCap()

  // The engine weights its launch order by observed p50s and gives an
  // unmeasured node a neutral prior; using the same plan here is what makes the
  // simulated order the order that will actually happen.
  const weights = {}
  for (const [nodeId, stats] of Object.entries(statsByNode || {})) {
    if (typeof stats?.p50 === 'number' && Number.isFinite(stats.p50)) weights[nodeId] = stats.p50
  }
  const { rankOf } = nodePriority.plan(graph, weights)

  const typical = scheduleSim.simulate(graph, { cap: requested, durationOf: p50Of, rankOf })
  if (!typical) return null
  const slow = scheduleSim.simulate(graph, { cap: requested, durationOf: p95Of, rankOf })
  const knee = scheduleSim.parallelismKnee(graph, { durationOf: p50Of, rankOf })
  const parallelism = scheduleSim.averageParallelism(graph, p50Of)
  const curve = scheduleSim.speedupCurve(graph, {
    durationOf: p50Of,
    rankOf,
    maxCap: Math.min(CURVE_MAX_CAP, Math.max(requested, knee?.cap ?? 1)),
  })

  return {
    cap: requested,
    makespanMs: round(typical.makespan),
    makespanP95Ms: slow ? round(slow.makespan) : null,
    queuedMs: round(typical.queuedMs),
    // Null rather than a confident 1.0 when there is no measured work at all —
    // a ratio computed from zeros is not evidence the cap costs nothing.
    contention: criticalPathMs > 0 ? Number((typical.makespan / criticalPathMs).toFixed(3)) : null,
    averageParallelism: parallelism == null ? null : Number(parallelism.toFixed(2)),
    knee: knee ? { cap: knee.cap, makespanMs: round(knee.makespanMs), idealMakespanMs: round(knee.idealMakespanMs) } : null,
    curve: curve ? curve.map((p) => ({ cap: p.cap, makespanMs: round(p.makespanMs) })) : [],
    chain: typical.chain.map((link) => ({
      nodeId: link.nodeId,
      waitedFor: link.waitedFor,
      queuedMs: round(link.queuedMs),
      durationMs: round(link.durationMs),
    })),
  }
}

module.exports = { computeForecast, longestPath }
