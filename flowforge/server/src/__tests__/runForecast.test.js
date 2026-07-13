const { computeForecast, longestPath } = require('../services/runForecast')

// A diamond: trigger fans to two parallel branches (a, b) that rejoin at j.
const diamond = {
  nodes: [
    { id: 't', type: 'trigger-manual' },
    { id: 'a', type: 'action-http' },
    { id: 'b', type: 'action-http' },
    { id: 'j', type: 'output-log' },
  ],
  edges: [
    { source: 't', target: 'a' },
    { source: 't', target: 'b' },
    { source: 'a', target: 'j' },
    { source: 'b', target: 'j' },
  ],
}

const diamondStats = {
  a: { p50: 100, p95: 150, samples: 10, nodeType: 'action-http' },
  b: { p50: 500, p95: 800, samples: 10, nodeType: 'action-http' },
  j: { p50: 50, p95: 80, samples: 10, nodeType: 'output-log' },
}

describe('longestPath', () => {
  it('follows the heaviest branch of a diamond', () => {
    const r = longestPath(diamond.nodes, diamond.edges, (id) => diamondStats[id]?.p50 ?? 0)
    expect(r.path).toEqual(['t', 'b', 'j']) // b (500) beats a (100)
    expect(r.total).toBe(550)
  })

  it('returns null on a cycle', () => {
    const nodes = [{ id: 'x' }, { id: 'y' }]
    const edges = [{ source: 'x', target: 'y' }, { source: 'y', target: 'x' }]
    expect(longestPath(nodes, edges, () => 1)).toBeNull()
  })

  it('collapses duplicate edges and ignores self-loops', () => {
    const nodes = [{ id: 'x' }, { id: 'y' }]
    const edges = [
      { source: 'x', target: 'y' },
      { source: 'x', target: 'y' },
      { source: 'y', target: 'y' },
    ]
    const r = longestPath(nodes, edges, (id) => (id === 'x' ? 10 : 5))
    expect(r.path).toEqual(['x', 'y'])
    expect(r.total).toBe(15)
  })
})

describe('computeForecast', () => {
  it('estimates the typical and p95 makespan and names the bottleneck', () => {
    const f = computeForecast(diamond, diamondStats)
    expect(f.available).toBe(true)
    expect(f.criticalPath).toEqual(['t', 'b', 'j'])
    expect(f.estimatedMs).toBe(550) // 0 + 500 + 50
    expect(f.estimatedP95Ms).toBe(880) // 0 + 800 + 80
    expect(f.bottleneck).toMatchObject({ nodeId: 'b', nodeType: 'action-http', p50: 500, p95: 800 })
  })

  it('reports full coverage over work nodes, excluding triggers', () => {
    const f = computeForecast(diamond, diamondStats)
    // a, b, j carry work; the trigger does not count.
    expect(f.coverage).toEqual({ nodesWithHistory: 3, workNodes: 3, ratio: 1 })
  })

  it('drops coverage and still estimates when a node has no history', () => {
    const partial = { a: diamondStats.a, b: diamondStats.b } // j unseen
    const f = computeForecast(diamond, partial)
    expect(f.criticalPath).toEqual(['t', 'b', 'j'])
    expect(f.estimatedMs).toBe(500) // j contributes 0
    expect(f.coverage.nodesWithHistory).toBe(2)
    expect(f.coverage.ratio).toBeCloseTo(2 / 3, 5)
  })

  it('reports no bottleneck when nothing on the path has timing', () => {
    const f = computeForecast(diamond, {})
    expect(f.available).toBe(true)
    expect(f.estimatedMs).toBe(0)
    expect(f.bottleneck).toBeNull()
    expect(f.coverage.nodesWithHistory).toBe(0)
  })

  it('is unavailable for an empty graph', () => {
    expect(computeForecast({ nodes: [], edges: [] })).toEqual({ available: false, reason: 'empty' })
  })

  it('is unavailable for a cyclic graph', () => {
    const cyclic = {
      nodes: [{ id: 'x', type: 'action-http' }, { id: 'y', type: 'action-http' }],
      edges: [{ source: 'x', target: 'y' }, { source: 'y', target: 'x' }],
    }
    expect(computeForecast(cyclic, {})).toEqual({ available: false, reason: 'cycle' })
  })

  it('handles a single-node graph', () => {
    const f = computeForecast(
      { nodes: [{ id: 'solo', type: 'action-http' }], edges: [] },
      { solo: { p50: 42, p95: 90, samples: 3, nodeType: 'action-http' } }
    )
    expect(f.criticalPath).toEqual(['solo'])
    expect(f.estimatedMs).toBe(42)
    expect(f.bottleneck.nodeId).toBe('solo')
  })
})
