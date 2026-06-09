function buildAdjacency(nodes, edges) {
  const adj = {}
  const inDegree = {}
  for (const node of nodes) {
    adj[node.id] = []
    inDegree[node.id] = 0
  }
  for (const edge of edges) {
    adj[edge.source].push({ target: edge.target, sourceHandle: edge.sourceHandle })
    inDegree[edge.target]++
  }
  return { adj, inDegree }
}

function topoSort(nodes, adj, inDegree) {
  const degrees = { ...inDegree }
  const queue = nodes.filter((n) => degrees[n.id] === 0).map((n) => n.id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const { target } of adj[id]) {
      degrees[target]--
      if (degrees[target] === 0) queue.push(target)
    }
  }
  if (order.length !== nodes.length) {
    throw new Error('Cycle detected in workflow graph')
  }
  return order
}

module.exports = { buildAdjacency, topoSort }
