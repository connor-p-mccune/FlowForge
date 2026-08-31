// The input that would have caught a surviving mutant.
//
// The test that carries the design is the off-by-one one. A witness for the
// *original* branch is no use — the solver is as likely to return `total =
// 5000`, which both graphs agree about, and a generated test that passes on the
// bug is worse than none. The distinguishing input has to be solved for.

const { mutants } = require('../services/mutation')
const { witnessFor, differingInput, suggestionFor } = require('../services/mutationWitness')
const { analyzePaths } = require('../services/pathConstraints')

const node = (id, type, config = {}, label = id) => ({
  id, type, position: { x: 0, y: 0 }, data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`, source, target, sourceHandle,
})

// webhook → check (total > 100) → (true) tag → out
//
// The condition reads `total`, not `trigger.total`: a condition evaluates
// against the merged input's fields directly. `trigger.total` is what the
// solver names the *variable* it resolves that to, which is why the witness
// comes back keyed that way.
//                                → (false) skip → out
const GRAPH = {
  nodes: [
    node('hook', 'trigger-webhook'),
    node('check', 'condition', { operator: 'expression', expression: 'total > 100' }, 'Large order?'),
    node('tag', 'transform', { template: '{"tier": "large"}' }, 'Tag large'),
    node('skip', 'transform', { template: '{"tier": "small"}' }, 'Tag small'),
    node('out', 'output-log', { message: 'done' }, 'Log'),
  ],
  edges: [
    edge('hook', 'check'),
    edge('check', 'tag', 'true'),
    edge('check', 'skip', 'false'),
    edge('tag', 'out'),
    edge('skip', 'out'),
  ],
}

const paths = () => analyzePaths(GRAPH)
const mutantOf = (operator, nodeId) =>
  mutants(GRAPH).find((m) => m.operator === operator && (!nodeId || m.nodeId === nodeId))

describe('differingInput', () => {
  it('finds the boundary value the two thresholds disagree on', () => {
    // `> 100` against `> 101`: they differ on exactly 101, and nowhere else.
    const witness = differingInput(GRAPH, 'check', 'total > 100', 'total > 101')
    expect(witness).toBeTruthy()
    expect(witness.triggerData.total).toBe(101)
  })

  it('finds it when the shift went the other way', () => {
    // `< 100` against `< 101` are distinguished by the *mutant* holding and the
    // original not, so the reversed conjunction is the satisfiable one.
    const witness = differingInput(GRAPH, 'check', 'total < 100', 'total < 101')
    expect(witness).toBeTruthy()
    expect(witness.triggerData.total).toBe(100)
  })

  it('returns nothing when no input distinguishes them', () => {
    // Two ways of writing the same condition: an equivalent mutation, and there
    // is no witness to find. Saying nothing is the only honest answer.
    expect(differingInput(GRAPH, 'check', 'total > 100', 'total > 100')).toBeNull()
  })

  it('returns nothing for a node that is not in the graph', () => {
    expect(differingInput(GRAPH, 'nope', 'a > 1', 'a > 2')).toBeNull()
  })
})

describe('witnessFor', () => {
  it('gives an off-by-one mutant the boundary input, not just any input', () => {
    // The whole point. A witness for the original branch could be 5000, which
    // both graphs agree about — a generated test that passes on the bug.
    const witness = witnessFor(GRAPH, mutantOf('off-by-one'), paths())
    expect(witness.triggerData.total).toBe(101)
  })

  it('gives a swapped condition any input that reaches it', () => {
    // The two graphs disagree on every such input, so no solver call is needed.
    const witness = witnessFor(GRAPH, mutantOf('swap-branches'), paths())
    expect(witness).toBeTruthy()
    expect(witness.triggerData).toHaveProperty('total')
  })

  it('gives a removed step an input that reaches it', () => {
    const mutant = mutantOf('skip-node', 'tag')
    const witness = witnessFor(GRAPH, mutant, paths())
    expect(witness).toBeTruthy()
  })

  it('says nothing when the path analysis could not run', () => {
    const dead = { analysed: false, branches: [], nodes: [] }
    expect(witnessFor(GRAPH, mutantOf('swap-branches'), dead)).toBeNull()
    expect(witnessFor(GRAPH, mutantOf('skip-node', 'tag'), dead)).toBeNull()
  })

  it('says nothing for an operator it has no idea about', () => {
    expect(witnessFor(GRAPH, { operator: 'something-else', nodeId: 'check' }, paths())).toBeNull()
  })
})

describe('suggestionFor', () => {
  it('says what to assert, not just what to send', () => {
    // A payload alone is half an answer: running it proves nothing unless the
    // assertion is about what the two graphs disagree on.
    expect(suggestionFor({ operator: 'off-by-one', nodeId: 'check' }))
      .toMatch(/assert on which branch "check" takes/)
    expect(suggestionFor({ operator: 'skip-node', nodeId: 'tag' }))
      .toMatch(/assert on what "tag" produced/)
    expect(suggestionFor({ operator: 'remove-gate', nodeId: 'approve' }))
      .toMatch(/did not reach past "approve"/)
  })

  it('has nothing to suggest for an operator it does not know', () => {
    expect(suggestionFor({ operator: 'other' })).toBeNull()
  })
})
