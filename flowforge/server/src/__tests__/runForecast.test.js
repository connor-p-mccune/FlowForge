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

// A trigger fanning out to eight independent 1s nodes: a one-node critical path
// that takes two seconds at a cap of four. This is the case the longest-path
// estimate is silently wrong about, and it is the common shape.
const fanOut = {
  nodes: [
    { id: 't', type: 'trigger-manual' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, type: 'action-http' })),
  ],
  edges: Array.from({ length: 8 }, (_, i) => ({ source: 't', target: `n${i}` })),
}
const fanOutStats = Object.fromEntries(
  Array.from({ length: 8 }, (_, i) => [
    `n${i}`,
    { p50: 1000, p95: 1500, samples: 10, nodeType: 'action-http' },
  ])
)

describe('computeForecast — contention', () => {
  it('reports a longer makespan than the critical path when the cap binds', () => {
    const f = computeForecast(fanOut, fanOutStats, { cap: 4 })
    expect(f.estimatedMs).toBe(1000) // critical path: one node deep
    expect(f.concurrency.makespanMs).toBe(2000) // two waves of four
    expect(f.concurrency.contention).toBe(2)
    expect(f.concurrency.queuedMs).toBe(4000) // four nodes waiting a second each
  })

  it('agrees with the critical path when the graph is narrower than the cap', () => {
    const f = computeForecast(diamond, diamondStats, { cap: 8 })
    expect(f.concurrency.makespanMs).toBe(f.estimatedMs)
    expect(f.concurrency.contention).toBe(1)
    expect(f.concurrency.queuedMs).toBe(0)
  })

  it('reports the ceiling on any speedup', () => {
    // 8000ms of work over a 1000ms path.
    expect(computeForecast(fanOut, fanOutStats, { cap: 4 }).concurrency.averageParallelism).toBe(8)
    // A diamond is mostly a chain: 650ms of work over a 550ms path.
    expect(computeForecast(diamond, diamondStats, { cap: 4 }).concurrency.averageParallelism).toBeCloseTo(1.18, 2)
  })

  it('finds the cap past which more slots buy nothing', () => {
    const f = computeForecast(fanOut, fanOutStats, { cap: 4 })
    expect(f.concurrency.knee.cap).toBe(8)
    expect(f.concurrency.knee.idealMakespanMs).toBe(1000)
  })

  it('puts the knee at 1 for a workflow that is a chain', () => {
    const chain = {
      nodes: [
        { id: 'a', type: 'action-http' },
        { id: 'b', type: 'action-http' },
        { id: 'c', type: 'action-http' },
      ],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
    }
    const stats = Object.fromEntries(
      ['a', 'b', 'c'].map((id) => [id, { p50: 100, p95: 100, samples: 5, nodeType: 'action-http' }])
    )
    expect(computeForecast(chain, stats, { cap: 4 }).concurrency.knee.cap).toBe(1)
  })

  it('draws a curve that flattens at the knee', () => {
    const curve = computeForecast(fanOut, fanOutStats, { cap: 4 }).concurrency.curve
    expect(curve[0]).toEqual({ cap: 1, makespanMs: 8000 })
    expect(curve[curve.length - 1]).toEqual({ cap: 8, makespanMs: 1000 })
  })

  it('labels each link of the chain as a data or a slot dependency', () => {
    const f = computeForecast(fanOut, fanOutStats, { cap: 4 })
    const kinds = f.concurrency.chain.map((l) => l.waitedFor)
    // The last node to finish waited for a slot, not for its predecessor.
    expect(kinds).toContain('slot')
  })

  it('is null rather than a confident 1.0 when nothing has been measured', () => {
    const f = computeForecast(diamond, {}, { cap: 4 })
    expect(f.concurrency.contention).toBeNull()
    expect(f.concurrency.averageParallelism).toBeNull()
  })
})

describe('computeForecast — the graph the engine would actually run', () => {
  it('ignores sticky notes', () => {
    const withNote = {
      nodes: [...diamond.nodes, { id: 'note-1', type: 'note' }],
      edges: diamond.edges,
    }
    const f = computeForecast(withNote, diamondStats, { cap: 4 })
    expect(f.criticalPath).not.toContain('note-1')
    expect(f.coverage.workNodes).toBe(computeForecast(diamond, diamondStats, { cap: 4 }).coverage.workNodes)
  })

  it('ignores compensations, which only run if the run ends badly', () => {
    const withComp = {
      nodes: [
        ...diamond.nodes,
        { id: 'undo-b', type: 'action-http', data: { config: { compensates: 'b' } } },
      ],
      edges: diamond.edges,
    }
    const f = computeForecast(withComp, { ...diamondStats, 'undo-b': { p50: 9000, p95: 9000, samples: 4 } }, { cap: 4 })
    expect(f.criticalPath).not.toContain('undo-b')
    expect(f.estimatedMs).toBe(550)
  })
})
