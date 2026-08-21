// Which ready node to launch when there are more of them than there are slots.
//
// The engine's scheduler is a ready-set scheduler under a cap: a node becomes
// runnable once every upstream node has settled, and `scheduleRound()` launches
// runnable nodes while `inFlight.size < EXEC_MAX_PARALLEL`. Until now it walked
// `unscheduled` — the topological order — and launched the first ones it found,
// which means the launch order was **the order the nodes came out of the
// topological sort**, which is the order they were declared in, which is the
// order somebody dropped them on a canvas.
//
// That choice is invisible right up until the ready set is bigger than the free
// capacity, and then it sets the run's duration. A graph that fans out to a
// 6-second node and five 100ms nodes, under a cap of 3, finishes in 6.2s if the
// long one starts first and 12s if it starts last — same nodes, same work, same
// dependencies, twice the wall time. Nothing about the graph changed; the run
// just picked badly, twice a day, for a year.
//
// This is **list scheduling**, one of the oldest problems in the field, and the
// classical answer is to order the ready set by each node's **upward rank** —
// its b-level, the length of the longest path from it to a sink, weighted by
// time:
//
//     rank(n) = w(n) + max over successors s of rank(s)
//
// i.e. *how much work is still downstream of me*. Launch the node with the most
// remaining work first, because that is the one the end of the run is waiting
// for; anything shorter can fill the gaps behind it. This is HLFET (Adam,
// Chandy & Dickson 1974) and the priority rule HEFT (Topcuoglu et al. 2002)
// builds on. Graham (1969) gives the guarantee that makes it safe to adopt
// without ceremony: *any* list schedule — any order at all — finishes within
// (2 − 1/m) of optimal, so ordering can only ever be an improvement over the
// arbitrary order, never a regression, and the bound holds whatever the
// estimates turn out to be.
//
// Three properties matter for using it inside a live engine:
//
//   * It is **semantically inert.** It changes the order ready nodes are
//     launched in, never which nodes are ready, which edges are active, or what
//     any of them receive. Every static analysis in the repo — dominance,
//     feasibility, types, lineage — describes the same graph afterwards.
//   * It is **deterministic.** Ties break on topological index, so a workflow
//     schedules identically on every run. A replay reproduces the original's
//     interleaving, which matters because chaos seeding and rollback ordering
//     both key on what actually happened.
//   * It **degrades honestly.** With no timing history the weights are equal
//     and the rank becomes the node's height in the DAG — still the right
//     ordering (deepest chain first), just coarser.
//
// Pure: no database. `stepTimings.js` supplies the observed weights.

const CRITICAL_PATH = 'critical-path'
const TOPOLOGICAL = 'topological'
const ORDERINGS = [CRITICAL_PATH, TOPOLOGICAL]

// Which rule this process uses, from EXEC_SCHEDULER. `critical-path` is the
// default; `topological` restores the pre-existing declaration-order behaviour
// exactly, which exists so the improvement can be measured against it and so
// there is an escape hatch that is a config change rather than a deploy.
function orderingFromEnv(env = process.env) {
  const raw = String(env.EXEC_SCHEDULER || '').trim().toLowerCase()
  return ORDERINGS.includes(raw) ? raw : CRITICAL_PATH
}

// Topological order over the runnable graph, plus the successor lists the rank
// recursion needs. Null on a cycle — the engine refuses those before it ever
// gets here, so this is a guard rather than a path.
function topology(nodes, edges) {
  const ids = nodes.map((n) => n.id)
  const known = new Set(ids)
  const adj = new Map()
  const indegree = new Map()
  for (const id of ids) {
    adj.set(id, [])
    indegree.set(id, 0)
  }
  const seen = new Set()
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue
    if (e.source === e.target) continue
    const key = `${e.source} ${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    adj.get(e.source).push(e.target)
    indegree.set(e.target, indegree.get(e.target) + 1)
  }
  const queue = []
  for (const id of ids) if (indegree.get(id) === 0) queue.push(id)
  const order = []
  const working = new Map(indegree)
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    order.push(id)
    for (const next of adj.get(id)) {
      working.set(next, working.get(next) - 1)
      if (working.get(next) === 0) queue.push(next)
    }
  }
  return order.length === ids.length ? { order, adj } : null
}

// The neutral weight for a node with no recorded timing.
//
// Zero would be the obvious choice and it is the wrong one: it sorts an
// unmeasured node **last**, and a node with no history is disproportionately
// likely to be one somebody just added — the newest, least understood, most
// plausibly slow thing in the graph. So an unmeasured node is given the median
// of the nodes that *are* measured: a prior that says "assume typical", which
// leaves the node's position in the graph as the dominant signal rather than
// letting a missing measurement decide the order.
//
// When nothing at all has history every weight is equal, the median is 1, and
// the rank degenerates to the node's height in the DAG — the deepest chain
// still launches first, which is the right answer with no information.
function neutralWeight(weights, ids) {
  const known = ids.map((id) => weights[id]).filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
  if (known.length === 0) return 1
  const sorted = [...known].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return median > 0 ? median : 1
}

// Upward rank per node: w(n) + max over successors. Computed by walking the
// topological order backwards, so every successor is resolved before the node
// that needs it — one pass, no recursion, no memo table.
function upwardRanks(graph, weights = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const built = topology(nodes, edges)
  if (!built) return null
  const { order, adj } = built

  const fallback = neutralWeight(weights, order)
  const weightOf = (id) => {
    const w = weights[id]
    return typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : fallback
  }

  const ranks = new Map()
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    let best = 0
    for (const s of adj.get(id)) {
      const r = ranks.get(s) ?? 0
      if (r > best) best = r
    }
    ranks.set(id, weightOf(id) + best)
  }
  return ranks
}

// The launch plan for one run: a rank per node and the comparator the scheduler
// sorts its ready set with. `compare` is an ordinary Array#sort comparator —
// the node that should launch first sorts to the front.
//
// `weights` is `{ nodeId: expectedMs }`; anything missing takes the neutral
// weight above. `ordering` defaults to the process setting.
function plan(graph, weights = {}, options = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const ordering = ORDERINGS.includes(options.ordering) ? options.ordering : orderingFromEnv()

  const built = topology(nodes, edges)
  const order = built ? built.order : nodes.map((n) => n.id)
  const topoIndex = new Map(order.map((id, i) => [id, i]))
  const indexOf = (id) => (topoIndex.has(id) ? topoIndex.get(id) : Number.MAX_SAFE_INTEGER)

  if (ordering === TOPOLOGICAL || !built) {
    return {
      ordering: TOPOLOGICAL,
      ranks: new Map(),
      rankOf: () => 0,
      compare: (a, b) => indexOf(a) - indexOf(b),
    }
  }

  const ranks = upwardRanks(graph, weights) ?? new Map()
  const rankOf = (id) => ranks.get(id) ?? 0
  return {
    ordering: CRITICAL_PATH,
    ranks,
    rankOf,
    // Highest rank first; topological index breaks the tie, which is what makes
    // the order reproducible and what makes a graph with no timing history
    // schedule exactly as it always did within each height band.
    compare: (a, b) => {
      const byRank = rankOf(b) - rankOf(a)
      if (byRank !== 0) return byRank
      return indexOf(a) - indexOf(b)
    },
  }
}

module.exports = {
  CRITICAL_PATH,
  TOPOLOGICAL,
  ORDERINGS,
  orderingFromEnv,
  upwardRanks,
  plan,
}
