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
}

// Render-time decoration for edges leaving a condition node's true/false
// handles: a colored branch label so the routing reads at a glance. Display
// only — callers keep persisting/broadcasting the undecorated edges. Returns
// the same array reference when nothing needs decorating.
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
