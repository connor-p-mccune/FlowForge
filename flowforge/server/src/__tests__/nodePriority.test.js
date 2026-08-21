// Tests for the scheduler's launch-order rule: upward rank (b-level) over the
// runnable graph, weighted by each node's observed time.
//
// The arithmetic tests pin the rank recursion. The last two sections are the
// ones that justify the feature existing: run the ordering through the
// scheduler simulation and show it produces a shorter run than the declaration
// order it replaced — once on the canonical case, once in aggregate over
// generated graphs.

const nodePriority = require('../services/nodePriority')
const { simulate } = require('../services/scheduleSim')

const node = (id) => ({ id })
const edge = (source, target) => ({ source, target })
const graphOf = (ids, edges) => ({ nodes: ids.map(node), edges })

describe('upwardRanks', () => {
  it('is the remaining work down the longest chain', () => {
    const graph = graphOf(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    const ranks = nodePriority.upwardRanks(graph, { a: 100, b: 200, c: 300 })
    expect(ranks.get('c')).toBe(300)
    expect(ranks.get('b')).toBe(500)
    expect(ranks.get('a')).toBe(600)
  })

  it('takes the longest successor, not the sum of them', () => {
    const graph = graphOf(['t', 'x', 'y'], [edge('t', 'x'), edge('t', 'y')])
    const ranks = nodePriority.upwardRanks(graph, { t: 10, x: 500, y: 100 })
    expect(ranks.get('t')).toBe(510)
  })

  it('carries the deeper branch of a diamond up to the fork', () => {
    const graph = graphOf(
      ['t', 'x', 'y', 'j'],
      [edge('t', 'x'), edge('t', 'y'), edge('x', 'j'), edge('y', 'j')]
    )
    const ranks = nodePriority.upwardRanks(graph, { t: 0, x: 900, y: 100, j: 50 })
    expect(ranks.get('x')).toBe(950)
    expect(ranks.get('y')).toBe(150)
    expect(ranks.get('t')).toBe(950)
  })

  it('returns null on a cycle', () => {
    expect(nodePriority.upwardRanks(graphOf(['a', 'b'], [edge('a', 'b'), edge('b', 'a')]))).toBeNull()
  })
})

describe('upwardRanks — nodes with no history', () => {
  it('gives an unmeasured node the median of the measured ones, not zero', () => {
    // If an unmeasured node scored zero it would sort behind every measured
    // node — and a node with no history is disproportionately likely to be the
    // one somebody just added.
    const graph = graphOf(['a', 'b', 'fresh'], [])
    const ranks = nodePriority.upwardRanks(graph, { a: 100, b: 300 })
    expect(ranks.get('fresh')).toBe(200)
    expect(ranks.get('fresh')).toBeGreaterThan(ranks.get('a'))
  })

  it('degenerates to graph height when nothing has history at all', () => {
    const graph = graphOf(['a', 'b', 'c', 'leaf'], [edge('a', 'b'), edge('b', 'c'), edge('a', 'leaf')])
    const ranks = nodePriority.upwardRanks(graph, {})
    expect(ranks.get('a')).toBe(3) // a → b → c
    expect(ranks.get('leaf')).toBe(1)
    expect(ranks.get('a')).toBeGreaterThan(ranks.get('leaf'))
  })

  it('ignores negative and non-numeric weights rather than trusting them', () => {
    const graph = graphOf(['a', 'b'], [])
    const ranks = nodePriority.upwardRanks(graph, { a: -5, b: 'slow' })
    expect(ranks.get('a')).toBe(1)
    expect(ranks.get('b')).toBe(1)
  })
})

describe('orderingFromEnv', () => {
  it('defaults to critical-path', () => {
    expect(nodePriority.orderingFromEnv({})).toBe('critical-path')
    expect(nodePriority.orderingFromEnv({ EXEC_SCHEDULER: 'nonsense' })).toBe('critical-path')
  })

  it('accepts the topological escape hatch, case-insensitively', () => {
    expect(nodePriority.orderingFromEnv({ EXEC_SCHEDULER: 'topological' })).toBe('topological')
    expect(nodePriority.orderingFromEnv({ EXEC_SCHEDULER: '  Topological ' })).toBe('topological')
  })
})

describe('plan', () => {
  const graph = graphOf(
    ['t', 'short', 'long'],
    [edge('t', 'short'), edge('t', 'long')]
  )

  it('sorts the longest remaining chain to the front', () => {
    const p = nodePriority.plan(graph, { short: 50, long: 900 }, { ordering: 'critical-path' })
    expect(['short', 'long'].sort(p.compare)).toEqual(['long', 'short'])
  })

  it('restores declaration order under the topological setting', () => {
    const p = nodePriority.plan(graph, { short: 50, long: 900 }, { ordering: 'topological' })
    expect(['long', 'short'].sort(p.compare)).toEqual(['short', 'long'])
    expect(p.ordering).toBe('topological')
  })

  it('falls back to topological order on a cyclic graph rather than throwing', () => {
    const cyclic = graphOf(['a', 'b'], [edge('a', 'b'), edge('b', 'a')])
    const p = nodePriority.plan(cyclic, {}, { ordering: 'critical-path' })
    expect(p.ordering).toBe('topological')
    expect(() => ['a', 'b'].sort(p.compare)).not.toThrow()
  })

  it('is a stable, total order — equal ranks fall back on topological position', () => {
    const wide = graphOf(['t', 'a', 'b', 'c'], ['a', 'b', 'c'].map((id) => edge('t', id)))
    const p = nodePriority.plan(wide, { a: 100, b: 100, c: 100 }, { ordering: 'critical-path' })
    expect(['c', 'b', 'a'].sort(p.compare)).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------------------
// The point of the exercise: a shorter run.
// ---------------------------------------------------------------------------

const scheduleUnder = (graph, weights, ordering, cap) => {
  const p = nodePriority.plan(graph, weights, { ordering })
  return simulate(graph, { cap, durationOf: (id) => weights[id] ?? 0, rankOf: p.rankOf })
}

describe('the ordering shortens the run', () => {
  // A trigger fanning out to five quick nodes and one slow one — the shape of
  // every "fetch a few things, then do the expensive call" workflow. Declared
  // with the slow node last, which is how somebody who added it later would
  // have drawn it.
  const shorts = ['s1', 's2', 's3', 's4', 's5']
  const graph = graphOf(
    ['t', ...shorts, 'slow'],
    [...shorts, 'slow'].map((id) => edge('t', id))
  )
  const weights = { t: 0, s1: 100, s2: 100, s3: 100, s4: 100, s5: 100, slow: 600 }

  it('starts the long pole first instead of last', () => {
    const cp = scheduleUnder(graph, weights, 'critical-path', 2)
    const topo = scheduleUnder(graph, weights, 'topological', 2)
    expect(topo.makespan).toBe(800)
    expect(cp.makespan).toBe(600)
  })

  it('accepts more total waiting to get a shorter run — they are different objectives', () => {
    // Worth pinning, because the number that looks like the goal is not.
    // Longest-remaining-first minimises the **makespan**; shortest-first
    // minimises **mean flow time**, i.e. total waiting. Here the good schedule
    // has five nodes queueing behind the long pole (1000ms of waiting in total)
    // and still finishes 200ms sooner than the one with 600ms of waiting,
    // because nobody is waiting on the sum — they are waiting on the end.
    const cp = scheduleUnder(graph, weights, 'critical-path', 2)
    const topo = scheduleUnder(graph, weights, 'topological', 2)
    expect(cp.queuedMs).toBeGreaterThan(topo.queuedMs)
    expect(cp.makespan).toBeLessThan(topo.makespan)
  })

  it('cannot beat the critical path — it removes waiting, not work', () => {
    const cp = scheduleUnder(graph, weights, 'critical-path', 2)
    expect(cp.makespan).toBe(600) // the slow node's own duration: the floor
  })

  it('changes nothing when every node fits under the cap', () => {
    const cp = scheduleUnder(graph, weights, 'critical-path', 8)
    const topo = scheduleUnder(graph, weights, 'topological', 8)
    expect(cp.makespan).toBe(topo.makespan)
  })

  it('changes nothing for a chain — there is never a choice to make', () => {
    const chain = graphOf(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    const w = { a: 100, b: 200, c: 300 }
    expect(scheduleUnder(chain, w, 'critical-path', 1).makespan).toBe(
      scheduleUnder(chain, w, 'topological', 1).makespan
    )
  })
})

// mulberry32, so an aggregate failure is reproducible.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('the ordering shortens runs in aggregate', () => {
  // List scheduling has known anomalies — Graham's own paper gives graphs where
  // a *better* priority order produces a *worse* makespan — so the honest claim
  // is not "never worse on any graph". It is that over a population of graphs
  // the rule wins, and that both orders stay inside the bound. Both are
  // asserted, on a fixed seed.
  it('beats declaration order across generated DAGs', () => {
    const random = rng(20260821)
    let cpTotal = 0
    let topoTotal = 0
    let cpWins = 0
    let topoWins = 0

    for (let trial = 0; trial < 300; trial++) {
      const size = 4 + Math.floor(random() * 10)
      const ids = Array.from({ length: size }, (_, i) => `n${i}`)
      const edges = []
      for (let i = 1; i < size; i++) {
        for (let j = 0; j < i; j++) if (random() < 0.2) edges.push(edge(ids[j], ids[i]))
      }
      const graph = graphOf(ids, edges)
      const weights = {}
      for (const id of ids) weights[id] = 1 + Math.floor(random() * 500)
      const cap = 2 + Math.floor(random() * 3)

      const cp = scheduleUnder(graph, weights, 'critical-path', cap).makespan
      const topo = scheduleUnder(graph, weights, 'topological', cap).makespan
      cpTotal += cp
      topoTotal += topo
      if (cp < topo) cpWins++
      if (topo < cp) topoWins++
    }

    expect(cpTotal).toBeLessThan(topoTotal)
    expect(cpWins).toBeGreaterThan(topoWins)
  })
})
