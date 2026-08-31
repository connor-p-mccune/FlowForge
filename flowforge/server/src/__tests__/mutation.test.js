// The mutation operators.
//
// Every one has to produce a bug somebody would actually make. Random
// perturbation produces mutants nobody would ever write, and a report full of
// those is one people stop reading — so most of these tests are about the
// mutations that are deliberately *not* generated.

const { mutants, swapBranches, offByOne, removeGate, skipNode } = require('../services/mutation')

const node = (id, type, config = {}, label = id) => ({
  id, type, position: { x: 0, y: 0 }, data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`, source, target, sourceHandle,
})

// webhook → check → (true) charge → log
//                 → (false) decline
const GRAPH = {
  nodes: [
    node('hook', 'trigger-webhook', {}, 'Order'),
    node('check', 'condition', { expression: 'total > 100' }, 'Large order?'),
    node('charge', 'action-http', { url: 'https://api.acme.com' }, 'Charge card'),
    node('log', 'output-log', { message: 'done' }, 'Log'),
    node('decline', 'output-log', { message: 'no' }, 'Decline'),
  ],
  edges: [
    edge('hook', 'check'),
    edge('check', 'charge', 'true'),
    edge('check', 'decline', 'false'),
    edge('charge', 'log'),
  ],
}

const has = (list, id) => list.some((n) => n.id === id)

describe('swapBranches', () => {
  it('wires a condition backwards', () => {
    const [mutant] = swapBranches(GRAPH)
    const toCharge = mutant.graph.edges.find((e) => e.target === 'charge')
    const toDecline = mutant.graph.edges.find((e) => e.target === 'decline')
    expect(toCharge.sourceHandle).toBe('false')
    expect(toDecline.sourceHandle).toBe('true')
  })

  it('describes it as the mistake it is', () => {
    expect(swapBranches(GRAPH)[0].describe).toMatch(/"Large order\?" wired backwards/)
  })

  it('leaves the original graph alone', () => {
    swapBranches(GRAPH)
    expect(GRAPH.edges.find((e) => e.target === 'charge').sourceHandle).toBe('true')
  })

  it('skips a condition with only one side wired', () => {
    // Swapping there produces a branch that leads nowhere, which the linter
    // refuses — so the mutant would be killed by a check that noticed the
    // mutation rather than the bug.
    const graph = {
      nodes: GRAPH.nodes,
      edges: [edge('hook', 'check'), edge('check', 'charge', 'true'), edge('charge', 'log')],
    }
    expect(swapBranches(graph)).toEqual([])
  })
})

describe('offByOne', () => {
  it('shifts the threshold by one', () => {
    const [mutant] = offByOne(GRAPH)
    const check = mutant.graph.nodes.find((n) => n.id === 'check')
    expect(check.data.config.expression).toBe('total > 101')
  })

  it('splices at the token, not at the first matching digits', () => {
    // `100` inside a string is not the threshold, and a regex would move it.
    const graph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === 'check'
          ? node('check', 'condition', { expression: 'id == "order-100" and total > 5' }, 'Check')
          : n
      ),
    }
    expect(offByOne(graph)[0].graph.nodes.find((n) => n.id === 'check').data.config.expression)
      .toBe('id == "order-100" and total > 6')
  })

  it('declines an expression with two numbers, where the intent is a guess', () => {
    const graph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === 'check'
          ? node('check', 'condition', { expression: 'total > 100 and items < 5' }, 'Check')
          : n
      ),
    }
    expect(offByOne(graph)).toEqual([])
  })

  it('declines an expression with no numbers', () => {
    const graph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === 'check' ? node('check', 'condition', { expression: 'urgent' }, 'Check') : n
      ),
    }
    expect(offByOne(graph)).toEqual([])
  })

  it('declines an expression that does not lex, which the linter owns', () => {
    const graph = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === 'check' ? node('check', 'condition', { expression: 'total > @@' }, 'Check') : n
      ),
    }
    expect(offByOne(graph)).toEqual([])
  })
})

describe('removeGate', () => {
  const gated = {
    nodes: [
      node('hook', 'trigger-webhook', {}, 'Order'),
      node('approve', 'approval', {}, 'Approve refund'),
      node('charge', 'action-http', {}, 'Charge card'),
      node('decline', 'output-log', {}, 'Decline'),
    ],
    edges: [
      edge('hook', 'approve'),
      edge('approve', 'charge', 'true'),
      edge('approve', 'decline', 'false'),
    ],
  }

  it('removes the gate and joins what was either side of it', () => {
    const [mutant] = removeGate(gated)
    expect(has(mutant.graph.nodes, 'approve')).toBe(false)
    expect(mutant.graph.edges.some((e) => e.source === 'hook' && e.target === 'charge')).toBe(true)
  })

  it('rewires only the pass branch', () => {
    // A rejection leads somewhere by design; reconnecting it to the happy path
    // would model a different bug from the one meant here.
    const [mutant] = removeGate(gated)
    expect(mutant.graph.edges.some((e) => e.target === 'decline')).toBe(false)
  })

  it('names it as running past the gate', () => {
    expect(removeGate(gated)[0].describe).toMatch(/"Approve refund" removed/)
  })

  it('removes a validate gate too', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('check', 'validate', {}, 'Check schema'),
        node('go', 'action-http'),
      ],
      edges: [edge('hook', 'check'), edge('check', 'go', 'valid')],
    }
    expect(removeGate(graph)).toHaveLength(1)
  })

  it('leaves a gate with nothing before it alone', () => {
    const graph = {
      nodes: [node('approve', 'approval'), node('charge', 'action-http')],
      edges: [edge('approve', 'charge', 'true')],
    }
    expect(removeGate(graph)).toEqual([])
  })
})

describe('skipNode', () => {
  it('removes an ordinary step and joins across it', () => {
    const found = skipNode(GRAPH)
    const charge = found.find((m) => m.nodeId === 'charge')
    expect(has(charge.graph.nodes, 'charge')).toBe(false)
    expect(charge.graph.edges.some((e) => e.source === 'check' && e.target === 'log')).toBe(true)
  })

  it('preserves the handle the removed step was reached by', () => {
    // `charge` sat on the condition's true branch; the joined edge has to stay
    // there or the mutant is a different graph from the one intended.
    const charge = skipNode(GRAPH).find((m) => m.nodeId === 'charge')
    const joined = charge.graph.edges.find((e) => e.source === 'check' && e.target === 'log')
    expect(joined.sourceHandle).toBe('true')
  })

  it('never removes a trigger', () => {
    expect(skipNode(GRAPH).some((m) => m.nodeId === 'hook')).toBe(false)
  })

  it('never removes a decision, which is a structural change', () => {
    expect(skipNode(GRAPH).some((m) => m.nodeId === 'check')).toBe(false)
  })

  it('leaves a join alone, where rewiring models the wrong bug', () => {
    const graph = {
      nodes: [
        node('a', 'transform'), node('b', 'transform'),
        node('join', 'output-log'), node('after', 'output-log'),
      ],
      edges: [edge('a', 'join'), edge('b', 'join'), edge('join', 'after')],
    }
    expect(skipNode(graph).some((m) => m.nodeId === 'join')).toBe(false)
  })
})

describe('mutants', () => {
  it('gives every mutant an id', () => {
    const all = mutants(GRAPH)
    expect(all.length).toBeGreaterThan(0)
    expect(new Set(all.map((m) => m.id)).size).toBe(all.length)
  })

  it('interleaves the operators, so a cap still leaves a spread', () => {
    // Twelve off-by-ones and no removed gate would be a worse report than three
    // of each.
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('c1', 'condition', { expression: 'a > 1' }),
        node('c2', 'condition', { expression: 'b > 2' }),
        node('approve', 'approval', {}, 'Gate'),
        node('t1', 'transform'), node('t2', 'transform'),
        node('yes1', 'output-log'), node('no1', 'output-log'),
        node('yes2', 'output-log'), node('no2', 'output-log'),
        node('end', 'output-log'),
      ],
      edges: [
        edge('hook', 'c1'), edge('c1', 'yes1', 'true'), edge('c1', 'no1', 'false'),
        edge('yes1', 'c2'), edge('c2', 'yes2', 'true'), edge('c2', 'no2', 'false'),
        edge('yes2', 'approve'), edge('approve', 't1', 'true'),
        edge('t1', 't2'), edge('t2', 'end'),
      ],
    }
    const capped = mutants(graph, { limit: 4 })
    expect(capped).toHaveLength(4)
    expect(new Set(capped.map((m) => m.operator)).size).toBeGreaterThan(1)
  })

  it('respects the cap', () => {
    expect(mutants(GRAPH, { limit: 2 })).toHaveLength(2)
  })

  it('has nothing to say about an empty or malformed graph', () => {
    expect(mutants({ nodes: [], edges: [] })).toEqual([])
    expect(mutants(null)).toEqual([])
    expect(mutants({ nodes: 'no' })).toEqual([])
  })

  it('is deterministic', () => {
    expect(mutants(GRAPH).map((m) => m.describe)).toEqual(mutants(GRAPH).map((m) => m.describe))
  })
})
