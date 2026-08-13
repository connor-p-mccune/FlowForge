// The collaboration convergence engine.
//
// The centrepiece is the permutation suite at the bottom. A CRDT's whole claim
// is that replicas which saw the same operations in different orders end up
// identical, and that is a property rather than an example — so it is tested as
// one: generate an operation set, apply every permutation (or many random ones
// for larger sets), and assert one document comes out. A hand-written example
// per ordering would test three of the six orders and miss the one that breaks.
//
// The rest pin the decisions that are *choices* rather than consequences: that
// a concurrent edit does not resurrect a deleted node, that field granularity
// is per config key, and that a hostile field path cannot reach an object
// write.

process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const {
  createDoc,
  applyOp,
  materialize,
  docFromGraph,
  isValidOp,
  newer,
} = require('../services/graphCrdt')

const add = (id, l, s, node = {}) => ({
  t: 'node.add',
  id,
  l,
  s,
  node: { type: 'action-http', position: { x: 0, y: 0 }, data: { label: id }, ...node },
})
const set = (id, l, s, path, value) => ({ t: 'node.set', id, l, s, path, value })
const remove = (id, l, s) => ({ t: 'node.remove', id, l, s })
const edgeAdd = (id, l, s, edge) => ({ t: 'edge.add', id, l, s, edge })

const apply = (ops, doc = createDoc()) => {
  for (const op of ops) applyOp(doc, op)
  return doc
}

// Every ordering of a list — used for small operation sets where exhaustive is
// cheap and therefore strictly better than sampling.
function permutations(items) {
  if (items.length <= 1) return [items]
  const out = []
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const perm of permutations(rest)) out.push([items[i], ...perm])
  }
  return out
}

const shuffle = (items, seed) => {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe('timestamp ordering', () => {
  it('orders by lamport first, then breaks ties on the site id', () => {
    expect(newer({ l: 2, s: 'a' }, { l: 1, s: 'z' })).toBe(true)
    expect(newer({ l: 1, s: 'z' }, { l: 1, s: 'a' })).toBe(true)
    expect(newer({ l: 1, s: 'a' }, { l: 1, s: 'z' })).toBe(false)
    // Idempotence rests on this: an operation is never newer than itself, so
    // re-delivery changes nothing.
    expect(newer({ l: 1, s: 'a' }, { l: 1, s: 'a' })).toBe(false)
  })

  it('accepts anything over an unset register', () => {
    expect(newer({ l: 0, s: '' }, null)).toBe(true)
  })
})

describe('fields', () => {
  it('keeps both edits when two sites change different config keys', () => {
    // The case the old per-element comparison lost: one person edits the URL
    // while another edits the retry count, and one of them silently lost
    // everything they typed.
    const doc = apply([
      add('h1', 1, 'a', { data: { label: 'Fetch', config: { url: 'https://x', retries: 1 } } }),
      set('h1', 2, 'a', 'config.url', 'https://new'),
      set('h1', 2, 'b', 'config.retries', 5),
    ])
    const [node] = materialize(doc).nodes
    expect(node.data.config).toEqual({ url: 'https://new', retries: 5 })
  })

  it('resolves a genuine conflict on the same field deterministically', () => {
    const doc = apply([
      add('h1', 1, 'a'),
      set('h1', 4, 'a', 'config.url', 'https://from-a'),
      set('h1', 4, 'b', 'config.url', 'https://from-b'),
    ])
    // Same lamport, so the site id decides — and every replica decides the same.
    expect(materialize(doc).nodes[0].data.config.url).toBe('https://from-b')
  })

  it('never lets an older write undo a newer one', () => {
    const doc = apply([
      add('h1', 1, 'a'),
      set('h1', 9, 'a', 'data.label', 'Final'),
      set('h1', 3, 'b', 'data.label', 'Stale'),
    ])
    expect(materialize(doc).nodes[0].data.label).toBe('Final')
  })

  it('applies a field write that arrives before the node it belongs to', () => {
    // No causal delivery: the register lands, and the node materialises with it
    // the moment the add catches up.
    const doc = apply([set('h1', 5, 'b', 'data.label', 'Renamed'), add('h1', 2, 'a')])
    expect(materialize(doc).nodes[0].data.label).toBe('Renamed')
  })

  it('holds a field write for a node that does not exist yet', () => {
    const doc = apply([set('ghost', 5, 'b', 'data.label', 'Nobody')])
    expect(materialize(doc).nodes).toEqual([])
  })
})

describe('existence', () => {
  it('does not resurrect a deleted node from a concurrent edit', () => {
    // The deliberate departure from an OR-Set. On a canvas, a node reappearing
    // with half its config merged from an edit made against the version that
    // was deleted is worse than a lost edit.
    const doc = apply([add('h1', 1, 'a'), remove('h1', 5, 'a'), set('h1', 3, 'b', 'data.label', 'Edited')])
    expect(materialize(doc).nodes).toEqual([])
  })

  it('lets a later re-add bring it back, which is what undo does', () => {
    const doc = apply([add('h1', 1, 'a'), remove('h1', 2, 'a'), add('h1', 3, 'a')])
    expect(materialize(doc).nodes).toHaveLength(1)
  })

  it('ignores a delete that lost the race', () => {
    const doc = apply([add('h1', 5, 'a'), remove('h1', 2, 'b')])
    expect(materialize(doc).nodes).toHaveLength(1)
  })
})

describe('edges', () => {
  it('drops an edge whose endpoint is gone rather than persisting it dangling', () => {
    const doc = apply([
      add('a', 1, 'x'),
      add('b', 1, 'x'),
      edgeAdd('e1', 2, 'x', { source: 'a', target: 'b' }),
      remove('b', 3, 'x'),
    ])
    const graph = materialize(doc)
    expect(graph.nodes.map((n) => n.id)).toEqual(['a'])
    expect(graph.edges).toEqual([])
  })

  it('keeps an edge whose endpoints both survive', () => {
    const doc = apply([
      add('a', 1, 'x'),
      add('b', 1, 'x'),
      edgeAdd('e1', 2, 'x', { source: 'a', target: 'b', sourceHandle: 'true' }),
    ])
    expect(materialize(doc).edges).toEqual([
      { id: 'e1', source: 'a', target: 'b', sourceHandle: 'true' },
    ])
  })
})

describe('seeding from a persisted graph', () => {
  it('round-trips a stored graph', () => {
    const graph = {
      nodes: [
        {
          id: 'h1',
          type: 'action-http',
          position: { x: 10, y: 20 },
          data: { label: 'Fetch', config: { url: 'https://x' } },
        },
      ],
      edges: [],
    }
    expect(materialize(docFromGraph(graph))).toEqual(graph)
  })

  it('puts the baseline underneath every real edit', () => {
    // Seeded at (0, ''), the bottom of the total order — so the very first
    // edit from any site wins without a special case for "this came from disk".
    const doc = docFromGraph({
      nodes: [{ id: 'h1', type: 'action-http', position: { x: 0, y: 0 }, data: { label: 'Old' } }],
      edges: [],
    })
    applyOp(doc, set('h1', 1, 'a', 'data.label', 'New'))
    expect(materialize(doc).nodes[0].data.label).toBe('New')
  })
})

describe('serialisation is a function of the operation set', () => {
  it('orders elements by id, not by the order they arrived', () => {
    // Two replicas holding provably identical documents must serialise them
    // identically — this output is persisted and then compared by drift
    // detection, so "the file differs" has to mean the graphs differ.
    const forward = apply([add('zz', 1, 'a'), add('aa', 2, 'a')])
    const backward = apply([add('aa', 2, 'a'), add('zz', 1, 'a')])
    expect(materialize(forward).nodes.map((n) => n.id)).toEqual(['aa', 'zz'])
    expect(JSON.stringify(materialize(backward))).toBe(JSON.stringify(materialize(forward)))
  })
})

describe('the document clock', () => {
  it('tracks the highest timestamp it has seen', () => {
    const doc = apply([add('a', 3, 'x'), add('b', 11, 'y'), add('c', 7, 'z')])
    expect(doc.lamport).toBe(11)
  })
})

describe('convergence', () => {
  // The property the whole module exists to have. Applying the same operations
  // in a different order must produce the same document — otherwise two people
  // on the same canvas see different graphs and neither is wrong.
  const converges = (ops, orderings) => {
    const expected = JSON.stringify(materialize(apply(ops)))
    for (const ordering of orderings) {
      expect(JSON.stringify(materialize(apply(ordering)))).toBe(expected)
    }
  }

  it('converges over every ordering of a small concurrent set', () => {
    const ops = [
      add('h1', 1, 'a'),
      set('h1', 3, 'a', 'config.url', 'https://a'),
      set('h1', 3, 'b', 'config.url', 'https://b'),
      remove('h1', 2, 'b'),
    ]
    converges(ops, permutations(ops))
  })

  it('converges over every ordering of a delete/re-add race', () => {
    const ops = [add('n', 1, 'a'), remove('n', 2, 'b'), add('n', 3, 'a'), remove('n', 3, 'b')]
    converges(ops, permutations(ops))
  })

  it('converges over a large mixed set in many random orders', () => {
    // Each site advances its own clock, so no two operations share a
    // `(lamport, site)` pair. That is not test hygiene — it is the invariant a
    // Lamport clock provides and the one the total order is built on. Without
    // it two different writes compare equal and there is no winner to agree on.
    const ops = []
    const sites = ['alice', 'bob', 'carol']
    const clock = { alice: 0, bob: 0, carol: 0 }
    for (let i = 0; i < 40; i++) {
      const site = sites[i % 3]
      const id = `n${i % 6}`
      // Sites drift apart and catch up, which is what produces the concurrent
      // pairs worth testing rather than a single global sequence.
      const l = (clock[site] += 1 + (i % 3))
      if (i % 7 === 0) ops.push(remove(id, l, site))
      else if (i % 3 === 0) ops.push(add(id, l, site, { data: { label: `${site}-${i}` } }))
      else if (i % 3 === 1) ops.push(set(id, l, site, 'config.url', `https://${site}/${i}`))
      else ops.push(set(id, l, site, 'position', { x: i, y: i * 2 }))
    }
    for (let i = 0; i < 8; i++) {
      const site = sites[i % 3]
      const l = (clock[site] += 1)
      ops.push(edgeAdd(`e${i}`, l, site, { source: `n${i % 6}`, target: `n${(i + 1) % 6}` }))
    }
    converges(ops, Array.from({ length: 30 }, (_, seed) => shuffle(ops, seed + 1)))
  })

  it('is idempotent — redelivering everything changes nothing', () => {
    // An at-least-once transport therefore needs no dedupe layer.
    const ops = [add('h1', 1, 'a'), set('h1', 2, 'b', 'config.url', 'https://x'), remove('h2', 4, 'c')]
    const once = materialize(apply(ops))
    const twice = materialize(apply([...ops, ...ops, ...ops]))
    expect(twice).toEqual(once)
  })

  it('converges when a replica applies a strict subset first, then catches up', () => {
    // The reconnect case: a client missed operations 3 and 4 while offline and
    // receives them after later ones.
    const ops = [
      add('h1', 1, 'a'),
      set('h1', 2, 'a', 'data.label', 'One'),
      set('h1', 5, 'b', 'data.label', 'Two'),
      set('h1', 4, 'c', 'config.url', 'https://c'),
    ]
    const online = materialize(apply(ops))
    const reconnected = materialize(apply([ops[0], ops[2], ops[1], ops[3]]))
    expect(reconnected).toEqual(online)
  })
})

describe('validation at the socket boundary', () => {
  it('accepts the well-formed shapes', () => {
    expect(isValidOp(add('h1', 1, 'a'))).toBe(true)
    expect(isValidOp(remove('h1', 1, 'a'))).toBe(true)
    expect(isValidOp(set('h1', 1, 'a', 'config.url', 'x'))).toBe(true)
    expect(isValidOp(set('h1', 1, 'a', 'position', { x: 1, y: 2 }))).toBe(true)
  })

  it('refuses a field path that would reach an object write', () => {
    // An operation arriving from a browser is untrusted input. The shape
    // allowlist alone is not enough: `__proto__` is a perfectly ordinary-looking
    // word-character key, so it matches `data.[\w-]+` and would be assigned
    // straight onto the object `nodeFromRecord` builds.
    expect(isValidOp(set('h1', 1, 'a', '__proto__', {}))).toBe(false)
    expect(isValidOp(set('h1', 1, 'a', 'constructor.prototype.x', 1))).toBe(false)
    expect(isValidOp(set('h1', 1, 'a', 'data.__proto__', 1))).toBe(false)
    expect(isValidOp(set('h1', 1, 'a', 'config.__proto__', 1))).toBe(false)
    expect(isValidOp(set('h1', 1, 'a', 'data.constructor', 1))).toBe(false)
    expect(isValidOp(set('h1', 1, 'a', 'nonsense', 1))).toBe(false)
  })

  it('does not pollute a prototype even from a graph that never was validated', () => {
    // Defence in depth: `docFromGraph` seeds from a persisted column, which
    // never passed through isValidOp — an older graph could hold anything.
    const doc = docFromGraph({
      nodes: [
        {
          id: 'h1',
          type: 'action-http',
          position: { x: 0, y: 0 },
          data: JSON.parse('{"label":"ok","__proto__":{"polluted":true}}'),
        },
      ],
      edges: [],
    })
    const [node] = materialize(doc).nodes
    expect(node.data.label).toBe('ok')
    expect({}.polluted).toBeUndefined()
    expect(Object.prototype.polluted).toBeUndefined()
  })

  it('refuses malformed timestamps, ids, and unknown kinds', () => {
    expect(isValidOp({ ...add('h1', 1, 'a'), l: -1 })).toBe(false)
    expect(isValidOp({ ...add('h1', 1, 'a'), l: 1.5 })).toBe(false)
    expect(isValidOp({ ...add('h1', 1, 'a'), s: '' })).toBe(false)
    expect(isValidOp({ ...add('h1', 1, 'a'), id: '' })).toBe(false)
    expect(isValidOp({ ...add('h1', 1, 'a'), id: 'x'.repeat(200) })).toBe(false)
    expect(isValidOp({ t: 'node.explode', id: 'h1', l: 1, s: 'a' })).toBe(false)
    expect(isValidOp(null)).toBe(false)
  })

  it('applies nothing for an operation missing its stamp', () => {
    const doc = createDoc()
    expect(applyOp(doc, { t: 'node.add', id: 'h1' }).changed).toBe(false)
    expect(materialize(doc).nodes).toEqual([])
  })
})

describe('applyOp reports the resulting element', () => {
  it('returns the merged element so a losing writer learns the winner', () => {
    const doc = apply([add('h1', 5, 'a', { data: { label: 'Winner' } })])
    const result = applyOp(doc, set('h1', 2, 'b', 'data.label', 'Loser'))
    expect(result.changed).toBe(false)
    expect(result.element.data.label).toBe('Winner')
  })

  it('returns null for an element the operation removed', () => {
    const doc = apply([add('h1', 1, 'a')])
    expect(applyOp(doc, remove('h1', 2, 'a'))).toMatchObject({ changed: true, element: null })
  })
})
