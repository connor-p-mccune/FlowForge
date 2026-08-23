// Convergence analysis: which converging branches shadow each other, and which
// of those the graph itself resolves.
//
// The precision rule is the design. A collision the graph settles — a deeper
// contributor overriding a shallower one — is reported as settled, because it is
// predictable and needs nobody's attention. A collision between two branches at
// the same depth is the finding: nothing in the graph says which is fresher, so
// the canonical sort breaks the tie alphabetically, which is not an opinion
// about the workflow. And two branches that can never both run are not a
// collision at all — that shape (a condition's `true` and `false` handles wired
// into one join) is on every canvas, and reporting it would bury everything.

const { analyzeConvergence } = require('../services/convergence')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

// Two independent HTTP calls converging on one node. Both produce the http
// runner's shape, so every one of its fields collides.
const DIAMOND = {
  nodes: [
    node('t1', 'trigger-manual'),
    node('alpha', 'action-http', { url: 'https://a.example.com', method: 'GET' }, 'Fetch A'),
    node('beta', 'action-http', { url: 'https://b.example.com', method: 'GET' }, 'Fetch B'),
    node('join', 'output-log', { message: 'x' }, 'Log'),
  ],
  edges: [edge('t1', 'alpha'), edge('t1', 'beta'), edge('alpha', 'join'), edge('beta', 'join')],
}

const joinAt = (report, id) => report.joins.find((j) => j.nodeId === id)
const collision = (report, id, key) =>
  joinAt(report, id)?.collisions.find((c) => c.key === key)

describe('analyzeConvergence', () => {
  it('reports a field two concurrent branches both supply', () => {
    const report = analyzeConvergence(DIAMOND)
    expect(report.available).toBe(true)
    const found = collision(report, 'join', 'status')
    expect(found.contributors.map((c) => c.nodeId)).toEqual(['alpha', 'beta'])
  })

  it('calls a same-depth collision a tie-break, because nothing in the graph decides it', () => {
    expect(collision(analyzeConvergence(DIAMOND), 'join', 'status').resolution).toBe('tie-break')
  })

  it('names the contributor that wins', () => {
    expect(collision(analyzeConvergence(DIAMOND), 'join', 'status').decidedBy).toBe('beta')
  })

  it('reads labels, so the report names what is on the canvas', () => {
    const found = collision(analyzeConvergence(DIAMOND), 'join', 'status')
    expect(found.contributors.map((c) => c.label)).toEqual(['Fetch A', 'Fetch B'])
  })

  it('says nothing about a node with one incoming edge', () => {
    const graph = {
      nodes: [node('t1', 'trigger-manual'), node('a', 'action-http', { url: 'https://x.dev' })],
      edges: [edge('t1', 'a')],
    }
    expect(analyzeConvergence(graph).joins).toEqual([])
  })

  // — the false positive the whole analysis is built to avoid ————————————

  it('ignores branches that can never both run', () => {
    // A condition with both handles wired into one join. Exactly one activates,
    // so `Object.assign` only ever sees one of them. This is the commonest join
    // on any canvas and reporting it would drown every real finding.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('check', 'condition', { expression: 'amount > 100' }, 'Large?'),
        node('big', 'action-http', { url: 'https://a.dev' }, 'Big'),
        node('small', 'action-http', { url: 'https://b.dev' }, 'Small'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [
        edge('t1', 'check'),
        edge('check', 'big', 'true'),
        edge('check', 'small', 'false'),
        edge('big', 'join'),
        edge('small', 'join'),
      ],
    }
    expect(analyzeConvergence(graph).joins).toEqual([])
  })

  it('ignores a decision wired straight into the join from both handles', () => {
    // Same exclusion, one hop shorter — and the case a reach-only test gets
    // wrong, because a decision is not in its own reach set. The edge's handle
    // has to be read directly.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('check', 'condition', { expression: 'ok' }, 'OK?'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [
        edge('t1', 'check'),
        edge('check', 'join', 'true'),
        edge('check', 'join', 'false'),
      ],
    }
    expect(analyzeConvergence(graph).joins).toEqual([])
  })

  it('still reports two branches under a decision that does not separate them', () => {
    // Both contributors sit under the *same* outcome, so the decision rules out
    // neither. It is a gate, not an exclusion, and the collision is real.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('check', 'condition', { expression: 'ok' }, 'OK?'),
        node('alpha', 'action-http', { url: 'https://a.dev' }, 'A'),
        node('beta', 'action-http', { url: 'https://b.dev' }, 'B'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [
        edge('t1', 'check'),
        edge('check', 'alpha', 'true'),
        edge('check', 'beta', 'true'),
        edge('alpha', 'join'),
        edge('beta', 'join'),
      ],
    }
    expect(collision(analyzeConvergence(graph), 'join', 'status').resolution).toBe('tie-break')
  })

  it('does not treat two edges out of one node as contending with themselves', () => {
    // The same output object assigned twice writes the same value.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('a', 'action-http', { url: 'https://a.dev' }, 'A'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [
        edge('t1', 'a'),
        { ...edge('a', 'join'), id: 'one' },
        { ...edge('a', 'join'), id: 'two' },
      ],
    }
    expect(analyzeConvergence(graph).joins).toEqual([])
  })

  // — the collisions the graph settles ————————————————————————————————

  it('marks a collision the graph resolves as settled by dataflow', () => {
    // `early → late → join` and `early → join`: late ran after early and saw its
    // value, so late wins and a reader can predict that from the canvas.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('early', 'action-http', { url: 'https://a.dev' }, 'Early'),
        node('late', 'action-http', { url: 'https://b.dev' }, 'Late'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [
        edge('t1', 'early'),
        edge('early', 'late'),
        edge('early', 'join'),
        edge('late', 'join'),
      ],
    }
    const found = collision(analyzeConvergence(graph), 'join', 'status')
    expect(found.resolution).toBe('dataflow')
    expect(found.decidedBy).toBe('late')
  })

  it('counts the two kinds separately, since only one of them needs a decision', () => {
    const { summary } = analyzeConvergence(DIAMOND)
    expect(summary.tieBroken).toBeGreaterThan(0)
    expect(summary.dataflow).toBe(0)
    expect(summary.collisions).toBe(summary.tieBroken + summary.dataflow)
  })

  // — what an edge actually carries ————————————————————————————————————

  it('does not invent a collision on the error object two nodes merely could produce', () => {
    // Both nodes catch, so `{{node.failed}}` is a legitimate reference on each —
    // but a *normal* edge carries only the node's own shape. Asking `outputs`
    // rather than `normalOutputs` would report `failed` and `error` colliding at
    // every join between two catching nodes, which is a fiction.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('alpha', 'transform', { template: '{"a": 1}', onError: 'branch' }, 'A'),
        node('beta', 'transform', { template: '{"b": 2}', onError: 'branch' }, 'B'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [edge('t1', 'alpha'), edge('t1', 'beta'), edge('alpha', 'join'), edge('beta', 'join')],
    }
    expect(collision(analyzeConvergence(graph), 'join', 'failed')).toBeUndefined()
    expect(collision(analyzeConvergence(graph), 'join', 'error')).toBeUndefined()
  })

  it('does report the error object where an error handle really carries it', () => {
    // One branch is the error handle of a catching node, the other a normal
    // path. Both reach the join, and `failed` genuinely collides.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('risky', 'action-http', { url: 'https://a.dev', onError: 'branch' }, 'Risky'),
        node('other', 'transform', { template: '{"failed": false}' }, 'Other'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [
        edge('t1', 'risky'),
        edge('t1', 'other'),
        edge('risky', 'join', 'error'),
        edge('other', 'join'),
      ],
    }
    expect(collision(analyzeConvergence(graph), 'join', 'failed')).toBeDefined()
  })

  it('flags a collision whose contributors are differently shaped', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('alpha', 'transform', { template: '{"id": "abc"}' }, 'A'),
        node('beta', 'transform', { template: '{"id": 7}' }, 'B'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [edge('t1', 'alpha'), edge('t1', 'beta'), edge('alpha', 'join'), edge('beta', 'join')],
    }
    const found = collision(analyzeConvergence(graph), 'join', 'id')
    expect(found.sameType).toBe(false)
    expect(analyzeConvergence(graph).summary.typeChanging).toBe(1)
  })

  it('says nothing about a shape it cannot see into', () => {
    // A node whose output the inference cannot name contributes no field names,
    // so no collision is claimed. Fewer findings, never invented ones.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('alpha', 'sub-workflow', { workflowId: 'nope' }, 'A'),
        node('beta', 'sub-workflow', { workflowId: 'also-nope' }, 'B'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [edge('t1', 'alpha'), edge('t1', 'beta'), edge('alpha', 'join'), edge('beta', 'join')],
    }
    expect(analyzeConvergence(graph).joins).toEqual([])
  })

  // — the report as a whole ——————————————————————————————————————————

  it('records the merge order, so the report explains its own answer', () => {
    expect(joinAt(analyzeConvergence(DIAMOND), 'join').mergeOrder).toEqual(['alpha', 'beta'])
  })

  it('puts the joins nobody can resolve by reading first', () => {
    const graph = {
      nodes: [
        ...DIAMOND.nodes,
        node('early', 'action-http', { url: 'https://c.dev' }, 'Early'),
        node('late', 'action-http', { url: 'https://d.dev' }, 'Late'),
        node('settled', 'output-log', { message: 'y' }, 'Settled'),
      ],
      edges: [
        ...DIAMOND.edges,
        edge('t1', 'early'),
        edge('early', 'late'),
        edge('early', 'settled'),
        edge('late', 'settled'),
      ],
    }
    expect(analyzeConvergence(graph).joins[0].nodeId).toBe('join')
  })

  it('refuses a cyclic graph rather than describing a merge that never happens', () => {
    const graph = {
      nodes: [node('a', 'transform'), node('b', 'transform')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    expect(analyzeConvergence(graph)).toEqual({ available: false, reason: 'cycle' })
  })

  it('refuses an empty graph', () => {
    expect(analyzeConvergence({ nodes: [], edges: [] })).toEqual({
      available: false,
      reason: 'empty',
    })
  })

  it('ignores sticky notes, like every other analysis over the execution graph', () => {
    const graph = {
      ...DIAMOND,
      nodes: [...DIAMOND.nodes, node('n1', 'note', {}, 'A note')],
    }
    expect(analyzeConvergence(graph).summary.joins).toBe(1)
  })
})
