// Turns a workflow's { nodes, edges } into an execution order using Kahn's
// algorithm (a breadth-first topological sort). The execution engine walks the
// returned order and runs each node once all of its inputs have run.

// Build an adjacency list (source -> [targets]) plus an in-degree count
// (number of incoming edges) for every node. The execution engine also needs
// each edge's sourceHandle so it can tell which branch a condition node took.
function buildAdjacency(nodes, edges) {
  const adj = {}
  const inDegree = {}
  for (const node of nodes) {
    adj[node.id] = []
    inDegree[node.id] = 0
  }
  for (const edge of edges) {
    // edge.source/target are assumed to reference existing nodes (the graph is
    // saved from React Flow, which only creates edges between real nodes).
    adj[edge.source].push({ target: edge.target, sourceHandle: edge.sourceHandle })
    inDegree[edge.target]++
  }
  return { adj, inDegree }
}

// Kahn's algorithm: repeatedly take a node with no remaining unmet
// dependencies (in-degree 0), append it to the order, and "remove" its edges by
// decrementing the in-degree of each neighbour. If a neighbour hits 0 it's now
// ready, so it joins the queue.
function topoSort(nodes, adj, inDegree) {
  const degrees = { ...inDegree } // copy so we don't mutate the caller's counts
  // Seed the queue with every node that has no incoming edges (the triggers).
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
  // If we couldn't order every node, some of them are stuck in a dependency
  // loop — the graph contains a cycle and can't be executed.
  if (order.length !== nodes.length) {
    throw new Error('Cycle detected in workflow graph')
  }
  return order
}

module.exports = { buildAdjacency, topoSort }
