// Semantic diff between two workflow graphs, server-side — the engine behind
// drift detection (POST /api/v1/workflows/:id/diff): is the deployed workflow
// still what the exported document in git says it is?
//
// Same semantics as the canvas's version-history diff (client/src/utils/
// graphDiff.js): nodes match by id and **position is ignored** — dragging a
// node around the canvas is not drift — while edges match by their
// (source, target, sourceHandle) triple rather than id, so a re-created but
// equivalent connection doesn't cry wolf. Config comparison is per key (the
// order of a config object's own keys is irrelevant); values compare by JSON
// serialisation, matching the canvas diff exactly — the two surfaces must
// agree on what "changed" means.

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

// Diff `before` against `after` (both { nodes, edges }). The result reads
// from before's perspective: what was added to / removed from / changed in
// `after`. For drift detection, before = the document (git), after = the
// live workflow — so "addedNodes" are nodes that exist live but not in git.
function diffGraphs(before, after) {
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
// a removed edge can still name its (removed) endpoints.
function describeEdge(edge, before, after) {
  const lookup = new Map(
    [...(before?.nodes || []), ...(after?.nodes || [])].map((n) => [n.id, n])
  )
  const from = nodeLabel(lookup.get(edge.source)) || edge.source
  const to = nodeLabel(lookup.get(edge.target)) || edge.target
  const branch = edge.sourceHandle ? ` (${edge.sourceHandle} branch)` : ''
  return `${from} → ${to}${branch}`
}

// The wire shape for the drift endpoint: compact per-item summaries (id,
// type, label, dotted change paths, edge descriptions) rather than raw graph
// objects — a diff response should say what changed, not re-transmit the
// graphs, and node configs may be large.
function presentDiff(diff, before, after) {
  const presentNode = (n) => ({ id: n.id, type: n.type, label: nodeLabel(n) })
  const presentEdge = (e) => ({
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    description: describeEdge(e, before, after),
  })
  return {
    identical: diff.identical,
    addedNodes: diff.addedNodes.map(presentNode),
    removedNodes: diff.removedNodes.map(presentNode),
    changedNodes: diff.changedNodes.map(({ node, changes }) => ({
      ...presentNode(node),
      changes,
    })),
    addedEdges: diff.addedEdges.map(presentEdge),
    removedEdges: diff.removedEdges.map(presentEdge),
    summary: {
      addedNodes: diff.addedNodes.length,
      removedNodes: diff.removedNodes.length,
      changedNodes: diff.changedNodes.length,
      addedEdges: diff.addedEdges.length,
      removedEdges: diff.removedEdges.length,
    },
  }
}

module.exports = { diffGraphs, describeEdge, presentDiff, nodeLabel }
