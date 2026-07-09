// Semantic diff between two workflow graphs (e.g. a deployed version vs the
// live canvas). Nodes are matched by id; position is ignored — moving a node
// around the canvas is not a meaningful change. Edges are matched by their
// (source, target, sourceHandle) triple rather than id, so re-created but
// equivalent connections don't show up as churn.

function nodeLabel(node) {
  return node?.data?.label || node?.id
}

function edgeKey(edge) {
  return `${edge.source}→${edge.target}:${edge.sourceHandle ?? ''}`
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// Which meaningful fields differ between two versions of the same node.
// Returns dotted paths: 'label', 'type', 'config.url', …
function nodeChanges(before, after) {
  const changes = []
  if ((before.data?.label || '') !== (after.data?.label || '')) changes.push('label')
  if (before.type !== after.type) changes.push('type')
  const beforeConfig = before.data?.config || {}
  const afterConfig = after.data?.config || {}
  const keys = new Set([...Object.keys(beforeConfig), ...Object.keys(afterConfig)])
  for (const key of keys) {
    if (!sameValue(beforeConfig[key], afterConfig[key])) changes.push(`config.${key}`)
  }
  return changes
}

// Diff `before` against `after` (both { nodes, edges }). The result reads from
// before's perspective: what was added to / removed from / changed in `after`.
export function diffGraphs(before, after) {
  const beforeNodes = new Map((before?.nodes || []).map((n) => [n.id, n]))
  const afterNodes = new Map((after?.nodes || []).map((n) => [n.id, n]))

  const addedNodes = []
  const removedNodes = []
  const changedNodes = []

  for (const [id, node] of afterNodes) {
    if (!beforeNodes.has(id)) {
      addedNodes.push(node)
    } else {
      const changes = nodeChanges(beforeNodes.get(id), node)
      if (changes.length > 0) changedNodes.push({ node, changes })
    }
  }
  for (const [id, node] of beforeNodes) {
    if (!afterNodes.has(id)) removedNodes.push(node)
  }

  const beforeEdges = new Map((before?.edges || []).map((e) => [edgeKey(e), e]))
  const afterEdges = new Map((after?.edges || []).map((e) => [edgeKey(e), e]))

  const addedEdges = [...afterEdges.entries()]
    .filter(([key]) => !beforeEdges.has(key))
    .map(([, e]) => e)
  const removedEdges = [...beforeEdges.entries()]
    .filter(([key]) => !afterEdges.has(key))
    .map(([, e]) => e)

  return {
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    identical:
      addedNodes.length === 0 &&
      removedNodes.length === 0 &&
      changedNodes.length === 0 &&
      addedEdges.length === 0 &&
      removedEdges.length === 0,
  }
}

// Human-readable endpoint labels for an edge, resolved against both graphs so
// removed edges can still name their (removed) endpoints.
export function describeEdge(edge, before, after) {
  const lookup = new Map(
    [...(before?.nodes || []), ...(after?.nodes || [])].map((n) => [n.id, n])
  )
  const from = nodeLabel(lookup.get(edge.source)) || edge.source
  const to = nodeLabel(lookup.get(edge.target)) || edge.target
  const branch = edge.sourceHandle ? ` (${edge.sourceHandle} branch)` : ''
  return `${from} → ${to}${branch}`
}

export { nodeLabel }
