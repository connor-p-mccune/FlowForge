// Tests for the discrete-event simulation of the engine's ready-set scheduler.
//
// Two kinds of claim are checked here. The first is arithmetic: for a given
// graph, cap and set of durations there is exactly one schedule, and these
// assert it exactly. The second is the guarantee that makes the whole approach
// safe — Graham's (2 − 1/m) bound on any list schedule — asserted as a property
// over generated DAGs rather than as an example.

const {
  simulate,
  unboundedMakespan,
  averageParallelism,
  parallelismKnee,
  speedupCurve,
} = require('../services/scheduleSim')

const node = (id) => ({ id })
const edge = (source, target) => ({ source, target })
const graphOf = (ids, edges) => ({ nodes: ids.map(node), edges })
const durations = (map) => (id) => map[id] ?? 0

describe('simulate — shape and degenerate cases', () => {
  it('is a zero-length schedule for an empty graph', () => {
    const result = simulate({ nodes: [], edges: [] })
    expect(result.makespan).toBe(0)
    expect(result.chain).toEqual([])
  })

  it('returns null on a cycle', () => {
    const graph = graphOf(['a', 'b'], [edge('a', 'b'), edge('b', 'a')])
    expect(simulate(graph, { cap: 2 })).toBeNull()
  })

  it('ignores self-loops and edges to nodes that are not in the graph', () => {
    const graph = {
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'a'), edge('a', 'ghost'), edge('a', 'b')],
    }
    const result = simulate(graph, { cap: 1, durationOf: durations({ a: 100, b: 50 }) })
    expect(result.makespan).toBe(150)
  })

  it('collapses duplicate edges so a two-handle dependency is counted once', () => {
    // A condition wired to the same target from both handles is one dependency;
    // counting it twice would leave the target permanently un-ready.
    const graph = graphOf(['c', 't'], [edge('c', 't'), edge('c', 't')])
    const result = simulate(graph, { cap: 4, durationOf: durations({ c: 10, t: 10 }) })
    expect(result.makespan).toBe(20)
  })

  it('treats a cap of 0 or a nonsense cap as unbounded', () => {
    const graph = graphOf(['a', 'b', 'c'], [])
    const each = durations({ a: 100, b: 100, c: 100 })
    expect(simulate(graph, { cap: 0, durationOf: each }).makespan).toBe(100)
    expect(simulate(graph, { cap: -3, durationOf: each }).makespan).toBe(100)
  })
})

describe('simulate — makespan under a cap', () => {
  it('is the sum of a chain, whatever the cap', () => {
    const graph = graphOf(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    const each = durations({ a: 100, b: 200, c: 300 })
    expect(simulate(graph, { cap: 1, durationOf: each }).makespan).toBe(600)
    expect(simulate(graph, { cap: 8, durationOf: each }).makespan).toBe(600)
  })

  it('is the longest branch of a diamond when capacity allows', () => {
    const graph = graphOf(
      ['t', 'x', 'y', 'j'],
      [edge('t', 'x'), edge('t', 'y'), edge('x', 'j'), edge('y', 'j')]
    )
    const each = durations({ t: 100, x: 1000, y: 200, j: 100 })
    const result = simulate(graph, { cap: 4, durationOf: each })
    expect(result.makespan).toBe(100 + 1000 + 100)
    expect(result.nodes.y.queuedMs).toBe(0)
  })

  it('serialises a fan-out that exceeds the cap, in waves', () => {
    // Five 100ms leaves behind a 0ms trigger, two slots: 100 + 100 + 100.
    const graph = graphOf(
      ['t', 'a', 'b', 'c', 'd', 'e'],
      ['a', 'b', 'c', 'd', 'e'].map((id) => edge('t', id))
    )
    const each = durations({ a: 100, b: 100, c: 100, d: 100, e: 100 })
    const result = simulate(graph, { cap: 2, durationOf: each })
    expect(result.makespan).toBe(300)
    // The unbounded schedule finishes the same work in one wave.
    expect(unboundedMakespan(graph, each)).toBe(100)
  })

  it('reports queueing time as the gap between ready and started', () => {
    const graph = graphOf(['t', 'a', 'b'], [edge('t', 'a'), edge('t', 'b')])
    const each = durations({ a: 500, b: 500 })
    const result = simulate(graph, { cap: 1, durationOf: each })
    // Both are ready at 0; one waits the other out.
    expect(result.queuedMs).toBe(500)
    expect(result.makespan).toBe(1000)
  })

  it('never lets peak concurrency exceed the cap', () => {
    const graph = graphOf(['t', ...'abcdefgh'.split('')], 'abcdefgh'.split('').map((id) => edge('t', id)))
    const result = simulate(graph, { cap: 3, durationOf: () => 50 })
    expect(result.peakConcurrency).toBeLessThanOrEqual(3)
    expect(result.peakConcurrency).toBe(3)
  })
})

describe('simulate — why a node waited', () => {
  it('labels a wait on a predecessor as a data dependency', () => {
    const graph = graphOf(['a', 'b'], [edge('a', 'b')])
    const result = simulate(graph, { cap: 4, durationOf: durations({ a: 100, b: 50 }) })
    expect(result.nodes.b.cause).toEqual({ nodeId: 'a', kind: 'data' })
    expect(result.nodes.b.queuedMs).toBe(0)
  })

  it('labels a wait for capacity as a slot dependency, naming the blocker', () => {
    // a and b are ready at 0 with one slot. b waits for a — and a is not one of
    // b's predecessors, so no analysis over the DAG alone could have named it.
    const graph = graphOf(['a', 'b'], [])
    const result = simulate(graph, {
      cap: 1,
      durationOf: durations({ a: 400, b: 100 }),
      rankOf: (id) => (id === 'a' ? 400 : 100),
    })
    expect(result.nodes.b.cause).toEqual({ nodeId: 'a', kind: 'slot' })
    expect(result.nodes.b.queuedMs).toBe(400)
  })

  it('reconstructs the makespan chain through a resource dependency', () => {
    const graph = graphOf(['a', 'b'], [])
    const result = simulate(graph, {
      cap: 1,
      durationOf: durations({ a: 400, b: 100 }),
      rankOf: (id) => (id === 'a' ? 400 : 100),
    })
    expect(result.chain.map((c) => c.nodeId)).toEqual(['a', 'b'])
    expect(result.chain[1].waitedFor).toBe('slot')
    expect(result.chain[0].waitedFor).toBeNull()
  })

  it('sums to the makespan along the chain', () => {
    const graph = graphOf(['t', 'x', 'y', 'j'], [edge('t', 'x'), edge('t', 'y'), edge('x', 'j'), edge('y', 'j')])
    const result = simulate(graph, {
      cap: 4,
      durationOf: durations({ t: 100, x: 1000, y: 200, j: 100 }),
    })
    const chain = result.chain
    expect(chain[chain.length - 1].finishMs).toBe(result.makespan)
    expect(chain.map((c) => c.nodeId)).toEqual(['t', 'x', 'j'])
  })
})

describe('simulate — determinism', () => {
  it('produces an identical schedule for identical input', () => {
    const graph = graphOf(
      ['t', 'a', 'b', 'c', 'd'],
      ['a', 'b', 'c', 'd'].map((id) => edge('t', id))
    )
    const opts = { cap: 2, durationOf: durations({ a: 30, b: 30, c: 30, d: 30 }) }
    expect(simulate(graph, opts)).toEqual(simulate(graph, opts))
  })

  it('breaks equal ranks on topological position, not on insertion order', () => {
    const graph = graphOf(['t', 'a', 'b'], [edge('t', 'a'), edge('t', 'b')])
    const result = simulate(graph, { cap: 1, durationOf: durations({ a: 10, b: 10 }) })
    expect(result.nodes.a.startMs).toBe(0)
    expect(result.nodes.b.startMs).toBe(10)
  })
})

describe('capacity analysis', () => {
  it('average parallelism is total work over the critical path', () => {
    // Two independent 100ms nodes: 200ms of work over a 100ms path.
    const graph = graphOf(['a', 'b'], [])
    expect(averageParallelism(graph, durations({ a: 100, b: 100 }))).toBe(2)
  })

  it('average parallelism of a chain is 1 — capacity cannot help it', () => {
    const graph = graphOf(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    expect(averageParallelism(graph, durations({ a: 10, b: 10, c: 10 }))).toBe(1)
  })

  it('finds the knee where more slots stop buying anything', () => {
    // Four independent 100ms nodes: cap 4 is the first that hits the floor.
    const graph = graphOf(['a', 'b', 'c', 'd'], [])
    const knee = parallelismKnee(graph, { durationOf: () => 100, tolerance: 0 })
    expect(knee.cap).toBe(4)
    expect(knee.makespanMs).toBe(100)
    expect(knee.idealMakespanMs).toBe(100)
  })

  it('puts the knee at 1 for a chain', () => {
    const graph = graphOf(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    const knee = parallelismKnee(graph, { durationOf: () => 100, tolerance: 0 })
    expect(knee.cap).toBe(1)
  })

  it('draws a monotonically non-increasing speedup curve', () => {
    const leaves = 'abcdef'.split('')
    const graph = graphOf(['t', ...leaves], leaves.map((id) => edge('t', id)))
    const each = durations(Object.fromEntries(leaves.map((id) => [id, 100])))
    const curve = speedupCurve(graph, { durationOf: each, maxCap: 6 })
    expect(curve).toHaveLength(6)
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i].makespanMs).toBeLessThanOrEqual(curve[i - 1].makespanMs)
    }
    expect(curve[0].makespanMs).toBe(600)
    expect(curve[5].makespanMs).toBe(100)
  })

  it('has no knee for a graph with no work', () => {
    expect(parallelismKnee(graphOf(['a'], []), { durationOf: () => 0 })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Graham's bound, as a property.
//
// A list schedule is any schedule that never leaves a slot idle while a ready
// node exists — which is exactly what the engine does, whatever order it picks.
// Graham (1969) proves every such schedule finishes within (2 − 1/m) of the
// optimum. The optimum itself is NP-hard, but two quantities lower-bound it:
// the critical path (no schedule beats it at any capacity) and total work ÷ m
// (no schedule beats perfect packing). The bound is asserted against the larger.
//
// This is the guarantee that makes reordering safe to ship: whatever the
// timing estimates turn out to be, the schedule cannot be pathological.
// ---------------------------------------------------------------------------

// mulberry32 — a small deterministic PRNG so a property failure is reproducible
// rather than a story about a build that went red once.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A random layered DAG: edges only ever point from a lower index to a higher
// one, so it is acyclic by construction.
function randomDag(random, size) {
  const ids = Array.from({ length: size }, (_, i) => `n${i}`)
  const edges = []
  for (let i = 1; i < size; i++) {
    for (let j = 0; j < i; j++) {
      if (random() < 0.25) edges.push(edge(ids[j], ids[i]))
    }
  }
  const weights = {}
  for (const id of ids) weights[id] = Math.floor(random() * 500)
  return { graph: graphOf(ids, edges), weights }
}

describe('Graham bound', () => {
  it('holds for every generated DAG, cap and priority rule', () => {
    const random = rng(20260821)
    for (let trial = 0; trial < 200; trial++) {
      const size = 3 + Math.floor(random() * 12)
      const { graph, weights } = randomDag(random, size)
      const durationOf = (id) => weights[id]
      const cap = 1 + Math.floor(random() * 5)

      // Two rules over the same graph: longest-remaining-work first, and the
      // adversarial reverse of it.
      for (const sign of [1, -1]) {
        const result = simulate(graph, { cap, durationOf, rankOf: (id) => sign * weights[id] })
        const criticalPath = unboundedMakespan(graph, durationOf)
        const totalWork = Object.values(weights).reduce((a, b) => a + b, 0)
        const lowerBound = Math.max(criticalPath, totalWork / cap)
        const bound = (2 - 1 / cap) * lowerBound
        // Floating-point slack on the work/m term only; the comparison is
        // otherwise exact integer milliseconds.
        expect(result.makespan).toBeLessThanOrEqual(bound + 1e-9)
        expect(result.makespan).toBeGreaterThanOrEqual(criticalPath - 1e-9)
      }
    }
  })
})
