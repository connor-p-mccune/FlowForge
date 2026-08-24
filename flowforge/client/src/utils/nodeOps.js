// Small pure helpers for canvas node operations.

// A duplicate of `node`: fresh id, slight offset so it doesn't sit exactly on
// top of the original, and a deep-copied data/config so editing the copy can
// never mutate the original through a shared reference.
export function makeDuplicate(node) {
  return {
    id: crypto.randomUUID(),
    type: node.type,
    position: { x: node.position.x + 40, y: node.position.y + 40 },
    data: JSON.parse(JSON.stringify(node.data || {})),
  }
}

const BRANCH_STYLE = {
  true: { stroke: '#16a34a', label: 'true' },
  false: { stroke: '#dc2626', label: 'false' },
  error: { stroke: '#d97706', label: 'error' },
}

// Render-time decoration for edges leaving a condition node's true/false
// handles — and any node's on-error 'error' handle: a colored branch label so
// the routing reads at a glance. Display only — callers keep persisting/
// broadcasting the undecorated edges. Returns the same array reference when
// nothing needs decorating.
export function decorateConditionEdges(edges) {
  if (!edges.some((e) => BRANCH_STYLE[e.sourceHandle])) return edges
  return edges.map((e) => {
    const branch = BRANCH_STYLE[e.sourceHandle]
    if (!branch) return e
    return {
      ...e,
      label: branch.label,
      labelStyle: { fill: branch.stroke, fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: '#fff', fillOpacity: 0.9 },
      labelBgPadding: [3, 2],
      labelBgBorderRadius: 3,
      style: { ...(e.style || {}), stroke: branch.stroke },
    }
  })
}

// Render-time decoration for the converging edges whose value does *not*
// survive the merge.
//
// A node with several incoming edges gets its input from `Object.assign` over
// the upstream outputs, so when two branches supply the same field one of them
// is silently discarded. Nothing on the canvas has ever shown which — the
// answer was always determined and always invisible. Drawn dashed, faded, and
// labelled with what it loses, so the ordering reads at a glance.
//
// Display only, like the branch labels above, and composed after them: an edge
// that already carries a `true`/`false`/`error` label keeps it and gains the
// field list, because losing a merge and taking a branch are different facts
// about the same line. Returns the same array reference when nothing collides.
export function decorateCollidingEdges(edges, report) {
  const joins = report?.joins
  if (!joins?.length) return edges

  const lost = new Map() // `${source}->${target}` -> Set of field names
  for (const join of joins) {
    for (const found of join.collisions) {
      for (const contributor of found.contributors) {
        // The winner keeps its line plain. When no winner can be named the
        // survivor depends on which branch ran, so every contributor is marked.
        if (found.decidedBy && contributor.nodeId === found.decidedBy) continue
        const key = `${contributor.nodeId}->${join.nodeId}`
        if (!lost.has(key)) lost.set(key, new Set())
        lost.get(key).add(found.key)
      }
    }
  }
  if (lost.size === 0) return edges

  return edges.map((e) => {
    const fields = lost.get(`${e.source}->${e.target}`)
    if (!fields) return e
    const names = [...fields].sort()
    // Two names and a count: an edge label wide enough to list six fields is an
    // edge label nobody can read past.
    const shown =
      names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')
    const text = `${shown} overridden`
    return {
      ...e,
      label: e.label ? `${e.label} · ${text}` : text,
      labelStyle: { fill: '#b45309', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: '#fff', fillOpacity: 0.9 },
      labelBgPadding: [3, 2],
      labelBgBorderRadius: 3,
      style: { ...(e.style || {}), strokeDasharray: '5 3', opacity: 0.6 },
    }
  })
}
