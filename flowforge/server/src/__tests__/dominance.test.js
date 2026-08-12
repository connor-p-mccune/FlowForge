// Dominator analysis, tested as an algorithm rather than through the feature
// that uses it. The shapes below are the ones that break a naive
// implementation: a diamond (where the join's dominator is the fork, not
// either branch), nested branches, an early exit that makes a join *not*
// post-dominate, and a node reachable by two routes of different lengths —
// which is where a "walk the shortest path" approximation quietly gives the
// wrong answer.

process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const {
  ENTRY,
  postorder,
  immediateDominators,
  dominatorChain,
  dominates,
  pathAvoiding,
  reachableFrom,
  reverse,
} = require('../services/dominance')

// Build { succ, pred } from 'a>b' edge strings, with ENTRY wired to every node
// that has no incoming edge (what executionGraph does for real graphs).
function graph(...edges) {
  const succ = new Map([[ENTRY, []]])
  const pred = new Map([[ENTRY, []]])
  const touch = (id) => {
    if (!succ.has(id)) succ.set(id, [])
    if (!pred.has(id)) pred.set(id, [])
  }
  const parsed = edges.map((e) => e.split('>'))
  for (const [a, b] of parsed) {
    touch(a)
    touch(b)
  }
  for (const [a, b] of parsed) {
    succ.get(a).push(b)
    pred.get(b).push(a)
  }
  for (const id of [...succ.keys()]) {
    if (id !== ENTRY && pred.get(id).length === 0) {
      succ.get(ENTRY).push(id)
      pred.get(id).push(ENTRY)
    }
  }
  return { succ, pred }
}

const idomsOf = (g) => immediateDominators({ entry: ENTRY, succ: g.succ, pred: g.pred })

describe('postorder', () => {
  it('visits every reachable node once, children before parents', () => {
    const g = graph('a>b', 'b>c')
    const order = postorder(ENTRY, g.succ)
    expect(new Set(order)).toEqual(new Set([ENTRY, 'a', 'b', 'c']))
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'))
  })

  it('terminates on a cycle instead of recursing forever', () => {
    const g = graph('a>b', 'b>c', 'c>b')
    expect(postorder(ENTRY, g.succ).length).toBe(4)
  })
})

describe('immediate dominators', () => {
  it('makes each node its predecessor on a straight line', () => {
    const idom = idomsOf(graph('a>b', 'b>c'))
    expect(idom.get('a')).toBe(ENTRY)
    expect(idom.get('b')).toBe('a')
    expect(idom.get('c')).toBe('b')
  })

  it('gives a diamond’s join the fork as its dominator, not either branch', () => {
    // a → { b, c } → d. Neither b nor c dominates d (each can be avoided via
    // the other), but a dominates it: every path to d goes through the fork.
    const idom = idomsOf(graph('a>b', 'a>c', 'b>d', 'c>d'))
    expect(idom.get('d')).toBe('a')
    expect(dominates(idom, 'a', 'd')).toBe(true)
    expect(dominates(idom, 'b', 'd')).toBe(false)
    expect(dominates(idom, 'c', 'd')).toBe(false)
  })

  it('handles routes of different lengths to the same node', () => {
    // A shortcut edge a→d alongside a→b→c→d. The long route's nodes must not
    // be reported as dominators just because most paths use them.
    const idom = idomsOf(graph('a>b', 'b>c', 'c>d', 'a>d'))
    expect(dominates(idom, 'a', 'd')).toBe(true)
    expect(dominates(idom, 'b', 'd')).toBe(false)
    expect(dominates(idom, 'c', 'd')).toBe(false)
  })

  it('nests: an inner fork’s join is dominated by both forks', () => {
    const idom = idomsOf(graph('a>b', 'a>e', 'b>c', 'b>d', 'c>f', 'd>f', 'f>g', 'e>g'))
    expect(dominates(idom, 'a', 'f')).toBe(true)
    expect(dominates(idom, 'b', 'f')).toBe(true)
    expect(dominates(idom, 'c', 'f')).toBe(false)
    // g joins the outer fork's two sides, so only a dominates it.
    expect(dominates(idom, 'b', 'g')).toBe(false)
    expect(dominates(idom, 'a', 'g')).toBe(true)
  })

  it('treats a node as dominating itself', () => {
    const idom = idomsOf(graph('a>b'))
    expect(dominates(idom, 'b', 'b')).toBe(true)
  })

  it('reports no dominators for a node the entry cannot reach', () => {
    // A two-node cycle with no external entry: nothing reaches it, so it is
    // dominated by nothing — including the entry. Reporting `true` here (the
    // vacuous reading) would let a guarantee "hold" over dead graph.
    const succ = new Map([[ENTRY, ['a']], ['a', []], ['x', ['y']], ['y', ['x']]])
    const pred = new Map([[ENTRY, []], ['a', [ENTRY]], ['x', ['y']], ['y', ['x']]])
    const idom = immediateDominators({ entry: ENTRY, succ, pred })
    expect(dominates(idom, ENTRY, 'x')).toBe(false)
    expect(dominatorChain(idom, 'x')).toEqual([])
  })
})

describe('dominatorChain', () => {
  it('lists dominators nearest first, ending at the entry', () => {
    const idom = idomsOf(graph('a>b', 'b>c'))
    expect(dominatorChain(idom, 'c')).toEqual(['c', 'b', 'a', ENTRY])
  })
})

describe('post-dominators', () => {
  const EXIT = 'exit'

  // Forward graph plus explicit exit edges, then dominators of the reverse
  // graph rooted at the exit — which is the whole of the second analysis.
  const ipdomsOf = (g) => {
    const rev = reverse(g)
    return immediateDominators({ entry: EXIT, succ: rev.succ, pred: rev.pred })
  }

  it('makes a join post-dominate both branches', () => {
    const ipdom = ipdomsOf(graph('a>b', 'a>c', 'b>d', 'c>d', `d>${EXIT}`))
    expect(dominates(ipdom, 'd', 'a')).toBe(true)
    expect(dominates(ipdom, 'd', 'b')).toBe(true)
  })

  it('is broken by a branch that exits early', () => {
    // c ends the run instead of reaching d — so d no longer follows a, which
    // is exactly the dangling-outcome case a wired-branch-only model misses.
    const ipdom = ipdomsOf(graph('a>b', 'a>c', 'b>d', `d>${EXIT}`, `c>${EXIT}`))
    expect(dominates(ipdom, 'd', 'b')).toBe(true)
    expect(dominates(ipdom, 'd', 'a')).toBe(false)
  })
})

describe('pathAvoiding', () => {
  it('finds the route that bypasses the avoided node', () => {
    const g = graph('a>b', 'b>d', 'a>c', 'c>d')
    expect(pathAvoiding(g, ENTRY, 'd', new Set(['b']))).toEqual([ENTRY, 'a', 'c', 'd'])
  })

  it('returns null when every route passes through it', () => {
    const g = graph('a>b', 'b>c')
    expect(pathAvoiding(g, ENTRY, 'c', new Set(['b']))).toBeNull()
  })

  it('returns null when the target itself is avoided', () => {
    const g = graph('a>b')
    expect(pathAvoiding(g, ENTRY, 'b', new Set(['b']))).toBeNull()
  })
})

describe('reachableFrom', () => {
  it('collects the transitive successors, excluding the start', () => {
    const g = graph('a>b', 'b>c', 'a>d')
    expect([...reachableFrom(g, 'a')].sort()).toEqual(['b', 'c', 'd'])
  })
})
