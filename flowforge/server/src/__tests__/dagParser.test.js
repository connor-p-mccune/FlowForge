const { buildAdjacency, topoSort } = require('../services/dagParser')

// Minimal node/edge factories — the parser only reads ids and edge endpoints.
const n = (id) => ({ id })
const e = (source, target, sourceHandle = null) => ({ source, target, sourceHandle })

// Convenience: build the adjacency then sort, the way the engine does.
function order(nodes, edges) {
  const { adj, inDegree } = buildAdjacency(nodes, edges)
  return topoSort(nodes, adj, inDegree)
}

// True when `a` is positioned before `b` in the produced order.
const before = (ord, a, b) => ord.indexOf(a) < ord.indexOf(b)

// Validate that every edge points "forwards" in the order — the defining
// property of a correct topological sort, regardless of which valid order
// Kahn's algorithm happened to pick.
function isValidTopoOrder(ord, nodes, edges) {
  if (ord.length !== nodes.length) return false
  if (new Set(ord).size !== nodes.length) return false
  return edges.every((edge) => before(ord, edge.source, edge.target))
}

describe('buildAdjacency', () => {
  it('seeds every node with an empty adjacency list and zero in-degree', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const { adj, inDegree } = buildAdjacency(nodes, [])
    expect(adj).toEqual({ a: [], b: [], c: [] })
    expect(inDegree).toEqual({ a: 0, b: 0, c: 0 })
  })

  it('records each edge target with its sourceHandle and counts in-degree', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const edges = [e('a', 'b'), e('a', 'c', 'true')]
    const { adj, inDegree } = buildAdjacency(nodes, edges)
    expect(adj.a).toEqual([
      { target: 'b', sourceHandle: null },
      { target: 'c', sourceHandle: 'true' },
    ])
    expect(adj.b).toEqual([])
    expect(inDegree).toEqual({ a: 0, b: 1, c: 1 })
  })

  it('sums multiple incoming edges into a single in-degree count', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const edges = [e('a', 'c'), e('b', 'c')]
    const { inDegree } = buildAdjacency(nodes, edges)
    expect(inDegree.c).toBe(2)
  })
})

describe('topoSort — linear chains', () => {
  it('orders a straight chain in dependency order', () => {
    const nodes = [n('a'), n('b'), n('c'), n('d')]
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'd')]
    expect(order(nodes, edges)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles a single node with no edges', () => {
    expect(order([n('only')], [])).toEqual(['only'])
  })

  it('returns an empty order for an empty graph', () => {
    expect(order([], [])).toEqual([])
  })
})

describe('topoSort — branching graphs', () => {
  it('produces a valid order for a diamond (fan-out then fan-in)', () => {
    const nodes = [n('a'), n('b'), n('c'), n('d')]
    const edges = [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')]
    const ord = order(nodes, edges)

    expect(ord).toHaveLength(4)
    expect(isValidTopoOrder(ord, nodes, edges)).toBe(true)
    expect(ord[0]).toBe('a') // only root runs first
    expect(ord[3]).toBe('d') // only sink runs last
    expect(before(ord, 'b', 'd')).toBe(true)
    expect(before(ord, 'c', 'd')).toBe(true)
  })

  it('orders a wider DAG so every edge points forwards', () => {
    const nodes = ['t', 'h', 'c', 'yes', 'no', 'log'].map(n)
    const edges = [
      e('t', 'h'),
      e('h', 'c'),
      e('c', 'yes', 'true'),
      e('c', 'no', 'false'),
      e('yes', 'log'),
      e('no', 'log'),
    ]
    expect(isValidTopoOrder(order(nodes, edges), nodes, edges)).toBe(true)
  })
})

describe('topoSort — disconnected nodes', () => {
  it('includes isolated nodes that have no edges at all', () => {
    const nodes = [n('a'), n('b'), n('island1'), n('island2')]
    const edges = [e('a', 'b')]
    const ord = order(nodes, edges)
    expect(ord).toHaveLength(4)
    expect(ord).toEqual(expect.arrayContaining(['a', 'b', 'island1', 'island2']))
    expect(before(ord, 'a', 'b')).toBe(true)
  })

  it('orders two independent chains (separate components) correctly', () => {
    const nodes = [n('a'), n('b'), n('c'), n('d')]
    const edges = [e('a', 'b'), e('c', 'd')]
    const ord = order(nodes, edges)
    expect(ord).toHaveLength(4)
    expect(before(ord, 'a', 'b')).toBe(true)
    expect(before(ord, 'c', 'd')).toBe(true)
  })
})

describe('topoSort — cycles throw', () => {
  it('throws on a two-node cycle', () => {
    const nodes = [n('a'), n('b')]
    const edges = [e('a', 'b'), e('b', 'a')]
    expect(() => order(nodes, edges)).toThrow(/cycle detected/i)
  })

  it('throws on a three-node cycle', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const edges = [e('a', 'b'), e('b', 'c'), e('c', 'a')]
    expect(() => order(nodes, edges)).toThrow(/cycle detected/i)
  })

  it('throws on a self-loop', () => {
    const nodes = [n('a')]
    expect(() => order(nodes, [e('a', 'a')])).toThrow(/cycle detected/i)
  })

  it('throws when only part of the graph is a cycle', () => {
    // a -> b is fine, but c <-> d are stuck in a loop, so the whole graph fails.
    const nodes = [n('a'), n('b'), n('c'), n('d')]
    const edges = [e('a', 'b'), e('c', 'd'), e('d', 'c')]
    expect(() => order(nodes, edges)).toThrow(/cycle detected/i)
  })
})

describe('topoSort — purity', () => {
  it('does not mutate the caller’s in-degree map (safe to reuse)', () => {
    const nodes = [n('a'), n('b'), n('c')]
    const edges = [e('a', 'b'), e('b', 'c')]
    const { adj, inDegree } = buildAdjacency(nodes, edges)
    const snapshot = { ...inDegree }

    const first = topoSort(nodes, adj, inDegree)
    expect(inDegree).toEqual(snapshot) // unchanged after sorting

    const second = topoSort(nodes, adj, inDegree)
    expect(second).toEqual(first) // re-runnable with identical result
  })
})
