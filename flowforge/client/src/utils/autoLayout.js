// Auto-layout ("Tidy") for the workflow canvas: a small layered DAG layout,
// hand-rolled so it stays dependency-free and unit-testable.
//
// 1. Rank each node by longest path from a source (Kahn's algorithm), so a
//    node always sits below everything that feeds it. Workflows are DAGs at
//    run time, but the canvas can hold a cycle mid-edit — anything left when
//    the queue drains (cycle members) drops onto one extra rank rather than
//    throwing.
// 2. Order nodes inside a rank by the barycenter (average order) of their
//    parents, so edges tend not to cross.
// 3. Position: ranks flow top→bottom (matching the nodes' top/bottom
//    handles), each rank centered horizontally around x = 0.

const H_SPACING = 230 // between columns in a rank
const V_SPACING = 150 // between ranks

// Returns a new nodes array with fresh { position } objects (all other node
// fields untouched). Edges referencing missing nodes are ignored.
export function layoutGraph(nodes, edges) {
  if (!nodes || nodes.length === 0) return []

  const ids = new Set(nodes.map((n) => n.id))
  const validEdges = (edges || []).filter((e) => ids.has(e.source) && ids.has(e.target))

  const outgoing = new Map(nodes.map((n) => [n.id, []]))
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of validEdges) {
    outgoing.get(e.source).push(e.target)
    inDegree.set(e.target, inDegree.get(e.target) + 1)
  }

  // Longest-path ranks via Kahn's algorithm. Queue order follows the input
  // nodes array, which keeps the result deterministic.
  const rank = new Map()
  const remaining = new Map(inDegree)
  const queue = nodes.filter((n) => remaining.get(n.id) === 0).map((n) => n.id)
  for (const id of queue) rank.set(id, 0)
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    for (const target of outgoing.get(id)) {
      rank.set(target, Math.max(rank.get(target) ?? 0, rank.get(id) + 1))
      remaining.set(target, remaining.get(target) - 1)
      if (remaining.get(target) === 0) queue.push(target)
    }
  }

  // Cycle members never reached in-degree 0 — park them on one extra rank.
  let maxRank = 0
  for (const r of rank.values()) maxRank = Math.max(maxRank, r)
  const leftovers = nodes.filter((n) => !rank.has(n.id))
  for (const n of leftovers) rank.set(n.id, maxRank + 1)

  // Group into ranks, keeping input order as the initial in-rank order.
  const ranks = []
  for (const n of nodes) {
    const r = rank.get(n.id)
    ;(ranks[r] ||= []).push(n.id)
  }

  // Barycenter pass (top→bottom): sort each rank by the average position of
  // its parents in the rank above, so children line up under their parents.
  const parents = new Map(nodes.map((n) => [n.id, []]))
  for (const e of validEdges) parents.get(e.target).push(e.source)
  const orderIndex = new Map()
  ;(ranks[0] || []).forEach((id, i) => orderIndex.set(id, i))
  for (let r = 1; r < ranks.length; r++) {
    if (!ranks[r]) continue
    const scored = ranks[r].map((id, i) => {
      const ps = parents.get(id).filter((p) => orderIndex.has(p))
      const bary = ps.length
        ? ps.reduce((sum, p) => sum + orderIndex.get(p), 0) / ps.length
        : i
      return { id, bary, i }
    })
    scored.sort((a, b) => a.bary - b.bary || a.i - b.i)
    ranks[r] = scored.map((s) => s.id)
    ranks[r].forEach((id, i) => orderIndex.set(id, i))
  }

  // Concrete coordinates: each rank centered around x = 0.
  const position = new Map()
  ranks.forEach((rankIds, r) => {
    if (!rankIds) return
    const offset = (rankIds.length - 1) / 2
    rankIds.forEach((id, i) => {
      position.set(id, { x: Math.round((i - offset) * H_SPACING), y: r * V_SPACING })
    })
  })

  return nodes.map((n) => ({ ...n, position: position.get(n.id) }))
}
