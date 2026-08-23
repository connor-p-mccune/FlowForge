// Where parallel branches collide.
//
// When several edges arrive at one node, the engine builds that node's input by
// assigning the upstream outputs over each other:
//
//     Object.assign(base, ...activeIncomingFor(nodeId).map((e) => context[e.source]))
//
// `Object.assign` is last-writer-wins, so if two upstream nodes both produce a
// `status`, exactly one of them survives — and until this file existed, which
// one was decided by **the order the edges happened to sit in the array**.
//
// Three facts, each unremarkable alone:
//
//   1. The merge is positional. Later contributor wins.
//   2. "Later" meant later in `graph.edges`, which is the order the author drew
//      the connections. Nothing on the canvas shows it, and redrawing a
//      connection moves it to the end.
//   3. Every canonicalisation in the product rewrites that order, differently:
//      a collaborative session persists `materialize()`, which sorts edges by
//      **id**; the `.flow` format and the artifact signature sort by
//      **(source, target, handle)**; a plain save keeps **array order**.
//
// Together: the same graph, saved through the collaborative editor rather than
// a plain PUT, or round-tripped through a signed export, could compute a
// different value — with the linter, the type checker, the guarantees, the
// policies and the signature all still green.
//
// The type checker cannot catch it, and the reason is worth stating because it
// looks like a gap and is not one. `T.mergeAssign` **joins** the colliding field
// types into a union. That is the sound abstraction: the value really could be
// either. It is precisely by being sound that it discards the thing that makes
// this a bug — *which* one you get.
//
// This file does two jobs.
//
// **It fixes it.** `contributionOrder` derives the merge order from the graph's
// structure instead of its storage, so all three storage orders run identically.
// The order is not arbitrary: contributors are ranked by **longest-path depth**,
// so a node downstream of another overrides it. In `A → B → N` and `A → N`, B
// ran after A and saw A's value, so B's `status` supersedes A's — which is what
// a person predicts from the canvas. Depth is a property of the graph, so no
// storage layer can change it, and it always orders an ancestor before its
// descendant (a path of length L from A to B forces depth(B) ≥ depth(A) + L).
//
// **It reports what no order can fix.** When two contenders sit at the *same*
// depth they are genuinely concurrent: the graph does not say which is fresher,
// so something arbitrary has to break the tie, and here that is the canonical
// edge sort. Stable, storage-independent, and still not what the author meant.
// That case is the finding — the value at this node is decided alphabetically —
// and the only real fix is for a human to say which branch wins.

const T = require('./types')
const { executionGraph } = require('./guarantees')
const { ENTRY, EXIT, immediateDominators, dominates } = require('./dominance')
const { inferGraphTypes } = require('./typeInference')

// What travels an edge leaving the dedicated error handle: the engine's caught
// error object, and nothing of the node's own shape.
const CAUGHT_FIELDS = ['failed', 'error']

const labelOf = (node) => node?.data?.label || node?.id || ''

const cmp = (a, b) => {
  const x = String(a ?? '')
  const y = String(b ?? '')
  return x < y ? -1 : x > y ? 1 : 0
}

// Longest-path depth from a root, per node. Structural: it depends on the shape
// of the graph and on nothing about how the graph was stored, which is the whole
// point of using it to order a merge.
//
// A cyclic graph has no such thing. The engine refuses to run one, so rather
// than inventing depths this returns zero for everything and lets the canonical
// tie-break carry the order — deterministic either way.
function depths(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id))
  const live = edges.filter((e) => ids.has(e.source) && ids.has(e.target))

  const outgoing = new Map([...ids].map((id) => [id, []]))
  const inDegree = new Map([...ids].map((id) => [id, 0]))
  for (const e of live) {
    outgoing.get(e.source).push(e.target)
    inDegree.set(e.target, inDegree.get(e.target) + 1)
  }

  const depth = new Map([...ids].map((id) => [id, 0]))
  const queue = [...ids].filter((id) => inDegree.get(id) === 0)
  let settled = 0
  while (queue.length) {
    const id = queue.shift()
    settled += 1
    for (const next of outgoing.get(id)) {
      depth.set(next, Math.max(depth.get(next), depth.get(id) + 1))
      inDegree.set(next, inDegree.get(next) - 1)
      if (inDegree.get(next) === 0) queue.push(next)
    }
  }
  if (settled !== ids.size) for (const id of ids) depth.set(id, 0)
  return depth
}

// The order the engine assigns converging outputs in — later wins.
//
// Depth first, so a contributor downstream of another overrides it. Then the
// canonical edge sort, which is the same key the `.flow` format and the artifact
// signature use: when the graph does not decide, the order a reviewer reads the
// document in is the order the engine applies.
function contributionOrder(nodes, edges) {
  const depth = depths(nodes, edges)
  const rank = (id) => depth.get(id) ?? 0
  return (a, b) =>
    rank(a.source) - rank(b.source) ||
    cmp(a.source, b.source) ||
    cmp(a.sourceHandle, b.sourceHandle) ||
    cmp(a.target, b.target) ||
    cmp(a.id, b.id)
}

// Every node reachable from a set of starting nodes. Excludes the virtual EXIT,
// which is reachable from everywhere.
function reachSet(graph, starts) {
  const seen = new Set()
  const queue = [...starts]
  while (queue.length) {
    const current = queue.shift()
    if (current == null || current === EXIT || seen.has(current)) continue
    seen.add(current)
    for (const next of graph.succ.get(current) || []) queue.push(next)
  }
  return seen
}

function hasCycle(graph) {
  const state = new Map()
  for (const n of graph.nodes) {
    if (state.has(n.id)) continue
    const stack = [[n.id, 0]]
    state.set(n.id, 0)
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const kids = (graph.succ.get(frame[0]) || []).filter((k) => k !== EXIT && k !== ENTRY)
      if (frame[1] < kids.length) {
        const next = kids[frame[1]++]
        if (state.get(next) === 0) return true
        if (!state.has(next)) {
          state.set(next, 0)
          stack.push([next, 0])
        }
      } else {
        state.set(frame[0], 1)
        stack.pop()
      }
    }
  }
  return false
}

// Which of a decision's outcomes an incoming edge belongs to, or null when the
// decision does not determine it.
//
// Two cases, and the second is the one a reach-only test gets wrong. An edge
// leaving the decision *itself* belongs to the group its handle is in — the
// decision does not reach itself, so asking the reach sets about it would answer
// "none". Any other edge belongs to the group that reaches its source, and only
// when exactly one does and the decision **dominates** that source: a source
// also reachable by a path that never touches the decision can run whatever the
// decision chose, which is exactly the hole that makes two branches look
// exclusive when they are not.
function groupIndexOf(edge, decisionId, groups, idom) {
  if (edge.source === decisionId) {
    const index = groups.findIndex((g) => g.edges.some((e) => e === edge))
    return index === -1 ? null : index
  }
  if (!dominates(idom, decisionId, edge.source)) return null
  const leading = []
  groups.forEach((g, index) => {
    if (g.reach.has(edge.source)) leading.push(index)
  })
  return leading.length === 1 ? leading[0] : null
}

// Can both of these edges be active in the same run? Two that cannot never
// collide, and the pair that cannot is the commonest shape on any canvas: a
// condition with its `true` and its `false` handle wired into one join node.
// Reporting that would bury every real finding under the pattern people are
// taught to draw.
function mutuallyExclusive(a, b, decisionReach, idom) {
  for (const [decisionId, groups] of decisionReach) {
    const ga = groupIndexOf(a, decisionId, groups, idom)
    if (ga === null) continue
    const gb = groupIndexOf(b, decisionId, groups, idom)
    if (gb === null) continue
    if (ga !== gb) return true
  }
  return false
}

function analyzeConvergence(rawGraph, { resolveWorkflow = null } = {}) {
  const graph = executionGraph(rawGraph)
  if (graph.nodes.length === 0) return { available: false, reason: 'empty' }
  // A cyclic graph never runs, so there is no merge to describe.
  if (hasCycle(graph)) return { available: false, reason: 'cycle' }

  const { normalOutputs = {}, outputs = {} } = inferGraphTypes(rawGraph, { resolveWorkflow })
  const idom = immediateDominators({ entry: ENTRY, succ: graph.succ, pred: graph.pred })
  const depth = depths(graph.nodes, graph.edges)
  const order = contributionOrder(graph.nodes, graph.edges)

  const decisionReach = new Map()
  for (const [id, groups] of graph.decisions) {
    decisionReach.set(
      id,
      groups.map((group) => ({
        name: group.name,
        edges: group.edges,
        reach: reachSet(graph, group.edges.map((e) => e.target)),
      }))
    )
  }

  // What a given edge puts into the merge. An error handle carries the caught
  // error object; anything else carries what the source's normal edges carry,
  // which on a catching node is narrower than what a `{{ref}}` to it sees.
  const payloadType = (e) =>
    e.sourceHandle === 'error' ? null : normalOutputs[e.source] || outputs[e.source]
  const fieldsOf = (e) =>
    e.sourceHandle === 'error' ? [...CAUGHT_FIELDS] : T.fieldNames(payloadType(e))

  const joins = []
  for (const node of graph.nodes) {
    const incoming = [...(graph.incoming.get(node.id) || [])].sort(order)
    if (incoming.length < 2) continue

    const supplied = incoming.map((edge) => ({
      edge,
      fields: new Set(fieldsOf(edge)),
      type: payloadType(edge),
    }))

    const keys = new Set()
    for (const s of supplied) for (const k of s.fields) keys.add(k)

    const collisions = []
    for (const key of [...keys].sort()) {
      const holders = supplied.filter((s) => s.fields.has(key))
      if (holders.length < 2) continue

      // Two edges out of one node carry the same object, so assigning it twice
      // writes the same value. Not a collision; a shape.
      const distinct = []
      for (const h of holders) {
        if (!distinct.some((d) => d.edge.source === h.edge.source)) distinct.push(h)
      }
      if (distinct.length < 2) continue

      const contending = distinct.filter((h) =>
        distinct.some(
          (other) =>
            other !== h && !mutuallyExclusive(h.edge, other.edge, decisionReach, idom)
        )
      )
      if (contending.length < 2) continue

      const last = contending[contending.length - 1]
      // The last contributor wins every run it takes part in — but if it is
      // exclusive with one of the others, that other one wins the runs it is
      // absent from. Naming a single winner there would be wrong, so it doesn't.
      const settledByLast = contending.every(
        (h) => h === last || !mutuallyExclusive(h.edge, last.edge, decisionReach, idom)
      )

      const ranks = new Set(contending.map((h) => depth.get(h.edge.source) ?? 0))
      const types = contending.map((h) => T.describe(h.type || T.UNKNOWN))

      collisions.push({
        key,
        contributors: contending.map((h) => ({
          nodeId: h.edge.source,
          label: labelOf(graph.byId.get(h.edge.source)),
          handle: h.edge.sourceHandle ?? null,
          depth: depth.get(h.edge.source) ?? 0,
          type: T.describe(h.type || T.UNKNOWN),
        })),
        // Where the graph itself decides, it decides: the deeper contributor ran
        // later and saw the shallower one's value. A tie means the graph is
        // silent and the canonical sort breaks it — alphabetically, which is not
        // an opinion about the workflow.
        resolution: ranks.size > 1 ? 'dataflow' : 'tie-break',
        decidedBy: settledByLast ? last.edge.source : null,
        // Same-shaped contenders still differ in value; differently-shaped ones
        // can change what a downstream expression is even allowed to do.
        sameType: types.every((t) => t === types[0]),
      })
    }

    if (collisions.length === 0) continue
    joins.push({
      nodeId: node.id,
      label: labelOf(node),
      type: node.type,
      arity: incoming.length,
      mergeOrder: incoming.map((e) => e.source),
      collisions,
    })
  }

  // Ties first: those are the ones nobody can resolve by reading the canvas.
  joins.sort(
    (a, b) =>
      b.collisions.filter((c) => c.resolution === 'tie-break').length -
        a.collisions.filter((c) => c.resolution === 'tie-break').length ||
      cmp(a.label, b.label)
  )

  const all = joins.flatMap((j) => j.collisions)
  return {
    available: true,
    joins,
    summary: {
      joins: joins.length,
      collisions: all.length,
      tieBroken: all.filter((c) => c.resolution === 'tie-break').length,
      dataflow: all.filter((c) => c.resolution === 'dataflow').length,
      typeChanging: all.filter((c) => !c.sameType).length,
    },
  }
}

module.exports = { analyzeConvergence, contributionOrder, depths, CAUGHT_FIELDS }
