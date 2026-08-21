// A discrete-event simulation of FlowForge's own ready-set scheduler.
//
// Every timing analysis in the codebase so far shares one assumption, and it is
// wrong in the same way each time. `criticalPath.js` finds the longest chain of
// steps a finished run actually took; `runForecast.js` runs the same longest-path
// search forward over expected node times; the Gantt timeline draws bars inside
// the run's wall-time window. All three describe a machine with **unbounded
// parallelism**, and the engine does not have one: `scheduleRound()` launches
// ready nodes only while `inFlight.size < EXEC_MAX_PARALLEL`.
//
// The gap is not academic. A twelve-node fan-out under a cap of four takes three
// waves; its critical path is one node deep. The forecast reports the depth of
// the graph and the run takes three times that, and nothing anywhere says why —
// the timeline shows twelve bars that plainly did not all start at once, with no
// account of what they were waiting for, because what they were waiting for was
// not in the graph.
//
// So: model the resource. Given a graph, a duration per node, and a cap, this
// replays the engine's scheduling rule as a discrete-event simulation and
// reports the makespan it would actually produce — plus the two things a person
// needs and could not previously get:
//
//   * **queueing delay per node** — how long it sat *ready* and unlaunched,
//     which is time the graph cannot explain, and
//   * **the resource-critical chain** — the back-chain of what each node was
//     waiting for, where a link is labelled `data` (a predecessor had not
//     finished) or `slot` (it had, and the node waited for capacity).
//
// That second output is the interesting one, because under a cap the thing that
// delayed a node is frequently **not one of its predecessors**. It is a sibling
// on an unrelated branch that held the slot, and no analysis over the DAG alone
// can name it — a dependency graph has no edge for "these two competed".
//
// Pure and dependency-free: plain functions over `{ nodes, edges }` and a weight
// function, no database and no engine, so the same routine serves the forecast
// (expected times, current graph), a finished run's post-mortem (observed times,
// recorded steps) and the tests that justify the launch order in
// `nodePriority.js`.

// Kahn's algorithm over a de-duplicated adjacency, in the shape the rest of the
// codebase uses (`criticalPath.js`, `runForecast.js`). Returns null on a cycle:
// an invalid graph has no schedule, and guessing one would be worse than saying
// so.
function buildOrder(nodes, edges) {
  const ids = nodes.map((n) => n.id)
  const known = new Set(ids)
  const adj = new Map()
  const preds = new Map()
  const indegree = new Map()
  for (const id of ids) {
    adj.set(id, [])
    preds.set(id, [])
    indegree.set(id, 0)
  }
  const seen = new Set()
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue
    if (e.source === e.target) continue // self-loop
    const key = `${e.source} ${e.target}`
    if (seen.has(key)) continue // collapse duplicate edges (two handles, one dependency)
    seen.add(key)
    adj.get(e.source).push(e.target)
    preds.get(e.target).push(e.source)
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
  if (order.length !== ids.length) return null // cycle
  return { order, adj, preds, indegree }
}

// Normalise a requested cap to a positive integer or Infinity. A cap of 0 or a
// nonsense value means "no limit" rather than "never launch anything" — the
// engine's own `maxParallel()` clamps to at least 1, and a simulation that
// deadlocked on a bad config would be a worse answer than an optimistic one.
function normalizeCap(cap) {
  if (cap === Infinity) return Infinity
  const n = Math.floor(Number(cap))
  if (!Number.isFinite(n) || n <= 0) return Infinity
  return n
}

// Simulate the engine's scheduler over `graph`.
//
//   durationOf(nodeId) → ms a node occupies a slot (default 0)
//   cap               → concurrent slots (default Infinity)
//   rankOf(nodeId)    → launch priority, **higher goes first** (default 0)
//
// Ties in `rankOf` break on topological index, so the result is deterministic
// for a given graph and set of weights — which is what lets a test assert an
// exact makespan, and what makes two runs of the same workflow schedule the
// same way.
//
// Returns null on a cycle. On an empty graph it returns a zero-length schedule
// rather than null: nothing to run is a valid schedule that takes no time.
function simulate(graph, options = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const cap = normalizeCap(options.cap)
  const durationOf = typeof options.durationOf === 'function' ? options.durationOf : () => 0
  const rankOf = typeof options.rankOf === 'function' ? options.rankOf : () => 0

  const empty = {
    cap,
    makespan: 0,
    totalWorkMs: 0,
    queuedMs: 0,
    utilisation: 0,
    peakConcurrency: 0,
    nodes: {},
    chain: [],
  }
  if (nodes.length === 0) return empty

  const built = buildOrder(nodes, edges)
  if (!built) return null
  const { order, adj, preds, indegree } = built

  const topoIndex = new Map(order.map((id, i) => [id, i]))
  const duration = new Map(order.map((id) => [id, Math.max(0, Number(durationOf(id)) || 0)]))
  const rank = new Map(order.map((id) => [id, Number(rankOf(id)) || 0]))

  // The engine's ordering rule, as a comparator: longest remaining chain first,
  // topological position as the tie-break. See nodePriority.js for why.
  const compare = (a, b) => {
    const byRank = rank.get(b) - rank.get(a)
    if (byRank !== 0) return byRank
    return topoIndex.get(a) - topoIndex.get(b)
  }

  const pending = new Map(indegree) // unsettled predecessors, per node
  const readyAt = new Map() // when a node's data dependencies were satisfied
  const startAt = new Map()
  const finishAt = new Map()
  const cause = new Map() // nodeId → { nodeId, kind: 'data' | 'slot' } | null

  // The predecessor whose completion set this node's ready time — the data
  // dependency that actually gated it. Ties break on topological index so the
  // reported chain is stable.
  const dataCause = (id) => {
    let chosen = null
    let latest = -Infinity
    for (const source of preds.get(id)) {
      const f = finishAt.get(source)
      if (f == null) continue
      if (f > latest || (f === latest && chosen != null && topoIndex.get(source) < topoIndex.get(chosen))) {
        latest = f
        chosen = source
      }
    }
    return chosen == null ? null : { nodeId: chosen, kind: 'data' }
  }

  const ready = []
  for (const id of order) {
    if (pending.get(id) === 0) {
      ready.push(id)
      readyAt.set(id, 0)
    }
  }

  let now = 0
  let running = [] // { id, finishAt }
  let peakConcurrency = 0
  // The node whose completion produced the capacity available at `now`. This is
  // the whole reason a resource dependency can be named at all: a node that
  // waited did not wait for its own predecessors, it waited for whoever was
  // occupying the slot it eventually took.
  let releasedBy = null

  while (ready.length > 0 || running.length > 0) {
    if (ready.length > 0 && running.length < cap) {
      ready.sort(compare)
      while (ready.length > 0 && running.length < cap) {
        const id = ready.shift()
        const waited = now - readyAt.get(id)
        startAt.set(id, now)
        finishAt.set(id, now + duration.get(id))
        cause.set(id, waited > 0 && releasedBy ? { nodeId: releasedBy, kind: 'slot' } : dataCause(id))
        running.push({ id, finishAt: finishAt.get(id) })
      }
      if (running.length > peakConcurrency) peakConcurrency = running.length
      continue
    }
    // Nothing launchable: either the ready set is empty or every slot is taken.
    // Either way the next thing that can happen is a completion.
    if (running.length === 0) break
    let next = Infinity
    for (const r of running) if (r.finishAt < next) next = r.finishAt
    now = next

    const done = running.filter((r) => r.finishAt === next)
    running = running.filter((r) => r.finishAt !== next)
    // Deterministic attribution when several nodes finish at the same instant.
    releasedBy = done.reduce(
      (best, r) => (best === null || topoIndex.get(r.id) < topoIndex.get(best) ? r.id : best),
      null
    )
    for (const r of done) {
      for (const s of adj.get(r.id)) {
        pending.set(s, pending.get(s) - 1)
        if (pending.get(s) === 0) {
          ready.push(s)
          readyAt.set(s, now)
        }
      }
    }
  }

  let makespan = 0
  let totalWorkMs = 0
  let queuedMs = 0
  let last = null
  const nodesOut = {}
  for (const id of order) {
    const f = finishAt.get(id) ?? 0
    const s = startAt.get(id) ?? 0
    const r = readyAt.get(id) ?? 0
    const queued = Math.max(0, s - r)
    totalWorkMs += duration.get(id)
    queuedMs += queued
    nodesOut[id] = {
      startMs: s,
      finishMs: f,
      readyMs: r,
      queuedMs: queued,
      durationMs: duration.get(id),
      cause: cause.get(id) ?? null,
    }
    // `>=` (not `>`) so that among nodes finishing at the same instant the
    // chain ends at the topologically-later one — the run finished at its sink,
    // not at whichever zero-duration node happened to tie with it.
    if (last === null || f >= makespan) {
      makespan = f
      last = id
    }
  }

  // Walk the causes back from whatever finished last. Every link is labelled,
  // so the chain reads as an explanation rather than a list: "charge waited 4s
  // for fetch (data), fetch waited 3s for a slot behind enrich (slot)".
  const chain = []
  const visited = new Set()
  for (let id = last; id != null && !visited.has(id); ) {
    visited.add(id)
    const n = nodesOut[id]
    chain.push({
      nodeId: id,
      startMs: n.startMs,
      finishMs: n.finishMs,
      queuedMs: n.queuedMs,
      durationMs: n.durationMs,
      waitedFor: n.cause ? n.cause.kind : null,
    })
    id = n.cause ? n.cause.nodeId : null
  }
  chain.reverse()

  const slots = Math.min(cap === Infinity ? peakConcurrency : cap, order.length) || 1
  return {
    cap,
    makespan,
    totalWorkMs,
    queuedMs,
    utilisation: makespan > 0 ? totalWorkMs / (makespan * slots) : 0,
    peakConcurrency,
    nodes: nodesOut,
    chain,
  }
}

// The makespan with no cap at all — the graph's critical path under these
// weights, and the floor no amount of capacity can go below.
function unboundedMakespan(graph, durationOf) {
  const result = simulate(graph, { durationOf, cap: Infinity })
  return result === null ? null : result.makespan
}

// How much parallelism this graph can *use*: total work ÷ critical path. The
// classical "average parallelism" of a DAG, and the ceiling on speedup — a
// value of 1.8 says that however many slots you add, this workflow will never
// go more than 1.8× faster, because it is mostly a chain.
function averageParallelism(graph, durationOf) {
  const unbounded = simulate(graph, { durationOf, cap: Infinity })
  if (unbounded === null) return null
  if (unbounded.makespan <= 0) return null
  return unbounded.totalWorkMs / unbounded.makespan
}

// How much capacity is actually worth having. Simulates at every cap from 1 up
// and returns the smallest one whose makespan lands within `tolerance` of the
// unbounded floor — the point past which more slots buy nothing.
//
// Reported rather than applied. `EXEC_MAX_PARALLEL` is a process-wide setting
// shared by every concurrent run, so the right value is an operator's call
// informed by this number, not a per-workflow inference from it.
const DEFAULT_KNEE_TOLERANCE = 0.05
const MAX_KNEE_CAP = 64

function parallelismKnee(graph, options = {}) {
  const durationOf = options.durationOf
  const rankOf = options.rankOf
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : DEFAULT_KNEE_TOLERANCE
  const unbounded = simulate(graph, { durationOf, rankOf, cap: Infinity })
  if (unbounded === null) return null
  if (unbounded.makespan <= 0) return null

  const ceiling = Math.min(
    MAX_KNEE_CAP,
    Math.max(1, unbounded.peakConcurrency || (graph?.nodes?.length ?? 1))
  )
  const budget = unbounded.makespan * (1 + tolerance)
  for (let cap = 1; cap <= ceiling; cap++) {
    const run = simulate(graph, { durationOf, rankOf, cap })
    if (run && run.makespan <= budget) {
      return { cap, makespanMs: run.makespan, idealMakespanMs: unbounded.makespan, tolerance }
    }
  }
  return {
    cap: ceiling,
    makespanMs: unbounded.makespan,
    idealMakespanMs: unbounded.makespan,
    tolerance,
  }
}

// Makespan at each cap from 1 to `maxCap` — the shape behind the knee, for a
// UI that wants to draw it rather than state it.
function speedupCurve(graph, options = {}) {
  const { durationOf, rankOf } = options
  const maxCap = Math.min(MAX_KNEE_CAP, Math.max(1, options.maxCap || 8))
  const points = []
  for (let cap = 1; cap <= maxCap; cap++) {
    const run = simulate(graph, { durationOf, rankOf, cap })
    if (!run) return null
    points.push({ cap, makespanMs: run.makespan })
  }
  return points
}

module.exports = {
  simulate,
  unboundedMakespan,
  averageParallelism,
  parallelismKnee,
  speedupCurve,
  DEFAULT_KNEE_TOLERANCE,
}
