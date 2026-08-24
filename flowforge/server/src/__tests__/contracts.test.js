// A workflow's return type is a promise to the workflows that call it. These
// tests pin the variance rule that decides whether a change keeps it.
//
// The direction is the part worth getting right, and it is the opposite of the
// intuition people carry over from function *arguments*. A return value is
// something the caller **consumes**, so the safe direction is the restrictive
// one: narrowing a type is fine, widening it hands the caller something it was
// never written for. Same flip for optionality — required → optional breaks a
// caller that read the field unconditionally; optional → required cannot.

const T = require('../services/types')
const {
  contractOf,
  compareContracts,
  referencesByNode,
  breaksIn,
  flatten,
} = require('../services/contracts')

const node = (id, type, config = {}, label = id) => ({
  id, type, position: { x: 0, y: 0 }, data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

// A workflow that returns whatever its transform builds.
const returning = (template) => ({
  nodes: [
    node('t1', 'trigger-manual'),
    node('shape', 'transform', { template }),
    node('out', 'output-return', { value: '{{shape}}' }),
  ],
  edges: [edge('t1', 'shape'), edge('shape', 'out')],
})

const objectOf = (fields, open = false) => T.objectOf(fields, { open })

describe('flatten', () => {
  it('goes all the way down, not one level like the field picker', () => {
    // A caller can reference {{sub.customer.address.city}}, so a contract that
    // stopped looking at depth 2 would call removing it compatible.
    const type = objectOf({
      customer: objectOf({ address: objectOf({ city: T.STRING }) }),
    })
    expect([...flatten(type).keys()]).toEqual([
      'customer',
      'customer.address',
      'customer.address.city',
    ])
  })

  it('offers nothing from a non-object', () => {
    expect(flatten(T.STRING).size).toBe(0)
    expect(flatten(T.UNKNOWN).size).toBe(0)
  })
})

describe('compareContracts', () => {
  const contract = (type) => ({ type, describe: T.describe(type), open: false, fields: flatten(type) })

  it('calls an added field additive', () => {
    const change = compareContracts(
      contract(objectOf({ id: T.STRING })),
      contract(objectOf({ id: T.STRING, total: T.NUMBER }))
    )
    expect(change.verdict).toBe('additive')
    expect(change.added).toEqual([{ path: 'total', now: 'number' }])
  })

  it('calls a removed field breaking, and says what it was', () => {
    const change = compareContracts(
      contract(objectOf({ id: T.STRING, total: T.NUMBER })),
      contract(objectOf({ id: T.STRING }))
    )
    expect(change.verdict).toBe('breaking')
    expect(change.removed).toEqual([{ path: 'total', was: 'number' }])
  })

  it('calls a widened type breaking, and says what it grew to', () => {
    // A caller doing arithmetic on `number` is not prepared for `string`. The
    // test is substitutability: `string | number` is not substitutable for
    // `number`, so the promise was broken.
    const wide = T.unionOf([T.STRING, T.NUMBER])
    const change = compareContracts(contract(objectOf({ id: T.NUMBER })), contract(objectOf({ id: wide })))
    expect(change.verdict).toBe('breaking')
    expect(change.widened).toEqual([{ path: 'id', was: 'number', now: T.describe(wide) }])
  })

  it('calls a narrowed type compatible', () => {
    // The other half of covariance, and the one people expect to be a break.
    // A caller that handled `string | number` still handles `number`; at worst
    // a branch of theirs is now dead, which is not a failure.
    const change = compareContracts(
      contract(objectOf({ id: T.unionOf([T.STRING, T.NUMBER]) })),
      contract(objectOf({ id: T.NUMBER }))
    )
    expect(change.verdict).toBe('compatible')
    expect(change.widened).toEqual([])
  })

  it('calls a required field going optional breaking', () => {
    // The direction that surprises people. For a return value, optional is the
    // *restrictive* direction: a caller that read it unconditionally may now
    // get nothing.
    const change = compareContracts(
      contract(objectOf({ id: { type: T.STRING, optional: false } })),
      contract(objectOf({ id: { type: T.STRING, optional: true } }))
    )
    expect(change.verdict).toBe('breaking')
    expect(change.weakened).toEqual([{ path: 'id' }])
  })

  it('calls an optional field becoming required safe', () => {
    const change = compareContracts(
      contract(objectOf({ id: { type: T.STRING, optional: true } })),
      contract(objectOf({ id: { type: T.STRING, optional: false } }))
    )
    expect(change.verdict).toBe('compatible')
  })

  it('calls an unchanged shape compatible', () => {
    const same = objectOf({ id: T.STRING, total: T.NUMBER })
    expect(compareContracts(contract(same), contract(same)).verdict).toBe('compatible')
  })

  it('sees a nested removal, not just a top-level one', () => {
    const change = compareContracts(
      contract(objectOf({ customer: objectOf({ id: T.STRING, email: T.STRING }) })),
      contract(objectOf({ customer: objectOf({ id: T.STRING }) }))
    )
    expect(change.removed).toEqual([{ path: 'customer.email', was: 'string' }])
  })
})

describe('contractOf', () => {
  it('reads the return node, not the last node that happens to run', () => {
    const contract = contractOf(returning('{"orderId": "abc", "total": 10}'))
    expect([...contract.fields.keys()].sort()).toEqual(['orderId', 'total'])
  })

  it('reports an unknowable payload as open rather than as a closed promise', () => {
    const contract = contractOf({
      nodes: [node('t1', 'trigger-webhook'), node('out', 'output-return', { value: '{{t1}}' })],
      edges: [edge('t1', 'out')],
    })
    // A webhook payload nobody typed is open: it names the one field the engine
    // guarantees and promises nothing about the rest. That openness is what
    // stops a reference into it ever being reported as broken.
    expect(contract.open).toBe(true)
    expect([...contract.fields.keys()]).toEqual(['triggered'])
  })
})

describe('referencesByNode', () => {
  it('collects every {{node.path}} a graph makes, grouped by the node read', () => {
    const graph = {
      nodes: [
        node('a', 'action-http', { url: 'https://x.dev/{{sub.orderId}}', body: '{{sub.customer.email}}' }),
        node('b', 'output-log', { message: '{{other.thing}}' }),
      ],
      edges: [],
    }
    const refs = referencesByNode(graph)
    expect([...refs.get('sub')].sort()).toEqual(['customer.email', 'orderId'])
    expect([...refs.get('other')]).toEqual(['thing'])
  })

  it('ignores a bare {{node}} with no path, which reads the whole object', () => {
    const graph = { nodes: [node('a', 'output-log', { message: '{{sub}}' })], edges: [] }
    expect(referencesByNode(graph).has('sub')).toBe(false)
  })

  it('walks nested config, not just top-level strings', () => {
    const graph = {
      nodes: [node('a', 'action-http', { headers: { 'X-Order': '{{sub.orderId}}' } })],
      edges: [],
    }
    expect([...referencesByNode(graph).get('sub')]).toEqual(['orderId'])
  })
})

describe('breaksIn', () => {
  const caller = (config, type = 'sub-workflow') => ({
    nodes: [
      node('t1', 'trigger-manual'),
      node('call', type, { workflowId: 'callee', ...config }, 'Fulfil order'),
      node('ship', 'action-http', config.usage || {}),
    ],
    edges: [edge('t1', 'call'), edge('call', 'ship')],
  })

  const after = (fields) => ({ type: objectOf(fields), fields: flatten(objectOf(fields)) })

  it('names the reference that stops resolving', () => {
    const found = breaksIn(
      caller({ usage: { url: 'https://x.dev/{{call.orderId}}' } }),
      'callee',
      after({ id: T.STRING })
    )
    expect(found.affected).toBe(true)
    expect(found.breaks).toHaveLength(1)
    expect(found.breaks[0]).toMatchObject({ reference: 'call.orderId', missing: 'orderId' })
  })

  it('suggests the field somebody probably meant', () => {
    const found = breaksIn(
      caller({ usage: { url: '{{call.orderId}}' } }),
      'callee',
      after({ orderID: T.STRING })
    )
    expect(found.breaks[0].suggestion).toBe('orderID')
  })

  it('reports nothing when every reference still resolves', () => {
    const found = breaksIn(
      caller({ usage: { url: '{{call.orderId}}' } }),
      'callee',
      after({ orderId: T.STRING })
    )
    expect(found.breaks).toEqual([])
    expect(found.affected).toBe(true)
  })

  it('marks a for-each caller affected without inventing a broken reference', () => {
    // The node's output wraps the contract in `{ count, results: [T] }`, and a
    // template path cannot index an array — so there is no resolvable reference
    // into the contract to break. Naming one would be fiction.
    const found = breaksIn(
      caller({ usage: { message: '{{call.count}}' } }, 'for-each'),
      'callee',
      after({ id: T.STRING })
    )
    expect(found.affected).toBe(true)
    expect(found.breaks).toEqual([])
  })

  it('ignores a node that calls a different workflow', () => {
    const graph = {
      nodes: [
        node('call', 'sub-workflow', { workflowId: 'somebody-else' }),
        node('use', 'output-log', { message: '{{call.orderId}}' }),
      ],
      edges: [],
    }
    expect(breaksIn(graph, 'callee', after({ id: T.STRING }))).toEqual({ affected: false, breaks: [] })
  })

  it('says nothing about a reference into a shape it cannot see', () => {
    // An open return type could still have the field. A break claimed and not
    // real sends somebody to fix a workflow that was fine.
    const open = objectOf({ id: T.STRING }, true)
    const found = breaksIn(
      caller({ usage: { url: '{{call.orderId}}' } }),
      'callee',
      { type: open, fields: flatten(open) }
    )
    expect(found.breaks).toEqual([])
  })
})
