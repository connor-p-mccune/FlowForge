// The `.flow` text format.
//
// Three kinds of claim. The examples pin the grammar. The **round trip** is the
// property that makes the format safe to put in front of a review — parse ∘
// format is the identity on a workflow's semantics, over generated documents
// as well as hand-written ones. And the last section pins the claim that makes
// it safe to put in front of a *signature*: re-formatting a file cannot change
// what it is signed as, because the emit order is the signing canonical order.

const { parseWorkflow, formatWorkflow, DslError } = require('../services/workflowDsl')
const { canonicalPayload } = require('../services/artifactSigning')

const parse = (text) => parseWorkflow(text)

describe('parsing', () => {
  it('reads a workflow, its nodes, and its connections', () => {
    const doc = parse(`
workflow "Order pipeline"
  description: "Handles incoming orders"

node hook: trigger-webhook @ 100,200
  label: "Order webhook"

node charge: action-http @ 480,160
  label: "Charge card"
  method: "POST"
  url: "https://api.acme.com/v1/charges/{{hook.orderId}}"

hook -> charge
`)
    expect(doc.name).toBe('Order pipeline')
    expect(doc.description).toBe('Handles incoming orders')
    expect(doc.graph_data.nodes).toHaveLength(2)
    expect(doc.graph_data.nodes[0]).toEqual({
      id: 'hook',
      type: 'trigger-webhook',
      position: { x: 100, y: 200 },
      data: { label: 'Order webhook', config: {} },
    })
    expect(doc.graph_data.nodes[1].data.config).toEqual({
      method: 'POST',
      url: 'https://api.acme.com/v1/charges/{{hook.orderId}}',
    })
    expect(doc.graph_data.edges).toEqual([
      { id: 'hook-charge', source: 'hook', target: 'charge', sourceHandle: null },
    ])
  })

  it('reads a branch handle off a connection', () => {
    const doc = parse(`
workflow "W"
node c: condition
node yes: output-log
node no: output-log

c -true-> yes
c -false-> no
`)
    expect(doc.graph_data.edges.map((e) => e.sourceHandle)).toEqual(['true', 'false'])
    expect(doc.graph_data.edges[0].id).toBe('c-yes-true')
  })

  it('reads a multi-line JSON value', () => {
    const doc = parse(`
workflow "W"
node v: validate
  schema: {
    "type": "object",
    "required": ["id"]
  }
`)
    expect(doc.graph_data.nodes[0].data.config.schema).toEqual({
      type: 'object',
      required: ['id'],
    })
  })

  it('does not end a JSON value on a brace inside a string', () => {
    // `{"pattern": "}"}` is a real config, and counting braces without honouring
    // strings would truncate it.
    const doc = parse(`
workflow "W"
node v: validate
  schema: {"pattern": "}", "other": 1}
`)
    expect(doc.graph_data.nodes[0].data.config.schema).toEqual({ pattern: '}', other: 1 })
  })

  it('reads guarantees with their notes', () => {
    const doc = parse(`
workflow "W"

guarantee requires charge approve
  note: "PCI review, 2026-01"

guarantee ensures charge receipt
`)
    expect(doc.guarantees).toEqual([
      { kind: 'requires', node: 'charge', other: 'approve', note: 'PCI review, 2026-01' },
      { kind: 'ensures', node: 'charge', other: 'receipt' },
    ])
  })

  it('routes properties to config, data, and the label', () => {
    const doc = parse(`
workflow "W"
node n: action-http
  label: "Call"
  data.colour: "red"
  url: "https://x.test"
`)
    const node = doc.graph_data.nodes[0]
    expect(node.data.label).toBe('Call')
    expect(node.data.colour).toBe('red')
    expect(node.data.config).toEqual({ url: 'https://x.test' })
  })

  it('defaults the position and the label when they are not written', () => {
    const doc = parse('workflow "W"\nnode n: output-log\n')
    expect(doc.graph_data.nodes[0].position).toEqual({ x: 0, y: 0 })
    expect(doc.graph_data.nodes[0].data.label).toBe('n')
  })

  it('ignores blank lines and comments', () => {
    const doc = parse(`
# an order pipeline

workflow "W"

# the trigger
node hook: trigger-manual
`)
    expect(doc.graph_data.nodes).toHaveLength(1)
  })

  it('accepts uuid node ids, which contain hyphens', () => {
    const id = '8f14e45f-ceea-467a-9c53-2f2f6c2f2a11'
    const other = '1c2d3e4f-ceea-467a-9c53-2f2f6c2f2a22'
    const doc = parse(`workflow "W"\nnode ${id}: output-log\nnode ${other}: output-log\n${id} -> ${other}\n`)
    expect(doc.graph_data.edges[0]).toMatchObject({ source: id, target: other })
  })
})

describe('parse errors', () => {
  const failure = (text) => {
    try {
      parse(text)
    } catch (err) {
      return err
    }
    throw new Error('expected a DslError')
  }

  it('points at the line and shows it', () => {
    const err = failure('workflow "W"\nnode broken\n')
    expect(err).toBeInstanceOf(DslError)
    expect(err.line).toBe(2)
    expect(err.frame).toContain('node broken')
    expect(err.frame).toContain('^')
    expect(err.message).toMatch(/`node <id>: <type>`/)
  })

  it('rejects an unquoted string rather than guessing', () => {
    const err = failure('workflow "W"\nnode n: action-http\n  method: POST\n')
    expect(err.line).toBe(3)
    expect(err.message).toMatch(/strings need quotes/)
  })

  it('rejects a duplicate node id', () => {
    expect(failure('workflow "W"\nnode n: output-log\nnode n: output-log\n').message)
      .toMatch(/Duplicate node id "n"/)
  })

  it('rejects an unknown guarantee kind, naming the ones that exist', () => {
    const err = failure('workflow "W"\nguarantee implies a b\n')
    expect(err.message).toMatch(/requires, ensures, exclusive/)
  })

  it('rejects an unknown property rather than dropping it', () => {
    // Silently ignoring a typo'd key is how a declaration stops applying and
    // nobody finds out.
    expect(failure('workflow "W"\n  descriptoin: "x"\n').message).toMatch(/Unknown property/)
    expect(failure('workflow "W"\nguarantee requires a b\n  reason: "x"\n').message)
      .toMatch(/Unknown property/)
  })

  it('rejects a property with nothing above it', () => {
    expect(failure('  label: "orphan"\n').message).toMatch(/nothing above it/)
  })

  it('rejects a malformed position', () => {
    expect(failure('workflow "W"\nnode n: output-log @ over-there\n').message)
      .toMatch(/`@ x,y`/)
  })

  it('rejects a second workflow declaration', () => {
    expect(failure('workflow "A"\nworkflow "B"\n').message).toMatch(/one workflow/)
  })

  it('rejects a line it cannot classify', () => {
    expect(failure('workflow "W"\nnonsense here\n').message).toMatch(/Expected `workflow`/)
  })
})

describe('formatting', () => {
  const doc = {
    name: 'Order pipeline',
    description: 'Handles orders',
    guarantees: [{ kind: 'requires', node: 'charge', other: 'approve' }],
    graph_data: {
      nodes: [
        {
          id: 'charge',
          type: 'action-http',
          position: { x: 480, y: 160 },
          data: { label: 'Charge card', config: { url: 'https://x.test', method: 'POST' } },
        },
        { id: 'approve', type: 'approval', position: { x: 240, y: 160 }, data: { label: 'Approve', config: {} } },
      ],
      edges: [{ id: 'e1', source: 'approve', target: 'charge', sourceHandle: 'true' }],
    },
  }

  it('emits nodes sorted by id and config keys sorted, whatever order they arrived in', () => {
    const text = formatWorkflow(doc)
    expect(text.indexOf('node approve:')).toBeLessThan(text.indexOf('node charge:'))
    expect(text.indexOf('method:')).toBeLessThan(text.indexOf('url:'))
  })

  it('puts the label first, above alphabetically-earlier config keys', () => {
    const text = formatWorkflow(doc)
    const block = text.slice(text.indexOf('node charge:'))
    expect(block.indexOf('label:')).toBeLessThan(block.indexOf('method:'))
  })

  it('gathers the connections into one block at the end', () => {
    const text = formatWorkflow(doc)
    expect(text).toMatch(/approve -true-> charge/)
    expect(text.trimEnd().split('\n').pop()).toBe('approve -true-> charge')
  })

  it('omits exportedAt, which is why a diff of an unchanged export is never empty', () => {
    const text = formatWorkflow({ ...doc, exportedAt: '2026-03-01T00:00:00.000Z' })
    expect(text).not.toContain('2026-03-01')
    expect(text).not.toContain('exportedAt')
  })

  it('is byte-identical for two differently-ordered copies of one workflow', () => {
    const shuffled = {
      ...doc,
      graph_data: {
        nodes: [...doc.graph_data.nodes].reverse(),
        edges: [...doc.graph_data.edges],
      },
    }
    expect(formatWorkflow(shuffled)).toBe(formatWorkflow(doc))
  })

  it('refuses to write an id it could not read back', () => {
    // A formatter that silently produced un-round-trippable output would be
    // worse than none: the damage surfaces at import time somewhere else.
    expect(() =>
      formatWorkflow({ name: 'W', graph_data: { nodes: [{ id: 'has space', type: 'x' }], edges: [] } })
    ).toThrow(/Cannot write node id/)
    expect(() =>
      formatWorkflow({ name: 'W', graph_data: { nodes: [{ id: 'a:b', type: 'x' }], edges: [] } })
    ).toThrow(/Cannot write node id/)
  })

  it('handles an empty workflow', () => {
    expect(formatWorkflow({ name: 'Empty' })).toBe('workflow "Empty"\n')
  })
})

// ---------------------------------------------------------------------------
// The property that makes the format safe: parse ∘ format is the identity on a
// workflow's semantics.
// ---------------------------------------------------------------------------

// mulberry32, so a property failure is reproducible rather than a story about
// a build that went red once.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES = ['trigger-manual', 'action-http', 'condition', 'approval', 'transform', 'output-log']
const HANDLES = [null, 'true', 'false', 'error', 'default']

// Values chosen to be the ones a naive format loses: quotes, braces, newlines,
// templates, unicode, and a nested object.
const VALUES = [
  'plain',
  'has "quotes" and \\backslashes\\',
  'multi\nline\ttabbed',
  '{{trigger.orderId}} — üñïçodé',
  '{"looks": "like json"}',
  42,
  -7.5,
  true,
  false,
  null,
  { nested: { deep: [1, 'two', { three: true }] } },
  ['a', 'b'],
]

function randomDocument(random) {
  const nodeCount = 1 + Math.floor(random() * 6)
  const nodes = []
  for (let i = 0; i < nodeCount; i++) {
    const config = {}
    const keys = Math.floor(random() * 4)
    for (let k = 0; k < keys; k++) {
      config[`k${Math.floor(random() * 6)}`] = VALUES[Math.floor(random() * VALUES.length)]
    }
    nodes.push({
      id: `n${i}`,
      type: TYPES[Math.floor(random() * TYPES.length)],
      position: { x: Math.floor(random() * 900), y: Math.floor(random() * 900) },
      data: {
        label: VALUES[Math.floor(random() * 5)],
        config,
        ...(random() < 0.2 ? { colour: 'red' } : {}),
      },
    })
  }
  const edges = []
  for (let i = 1; i < nodeCount; i++) {
    if (random() < 0.7) {
      const handle = HANDLES[Math.floor(random() * HANDLES.length)]
      edges.push({
        id: `e${i}`,
        source: `n${Math.floor(random() * i)}`,
        target: `n${i}`,
        sourceHandle: handle,
      })
    }
  }
  const guarantees = []
  if (nodeCount > 1 && random() < 0.4) {
    guarantees.push({ kind: 'requires', node: 'n1', other: 'n0', ...(random() < 0.5 ? { note: 'why' } : {}) })
  }
  return {
    name: VALUES[Math.floor(random() * 5)] || 'W',
    description: random() < 0.5 ? 'a description' : null,
    guarantees,
    graph_data: { nodes, edges },
  }
}

// What the format promises to preserve. Edge *ids* are excluded for the same
// reason the signature excludes them: React Flow mints a new one for a redrawn
// connection, so an id is a canvas artefact rather than part of what the
// workflow means.
const semantics = (doc) => ({
  name: doc.name ?? '',
  description: doc.description ?? null,
  guarantees: [...(doc.guarantees || [])].sort((a, b) =>
    `${a.kind}${a.node}${a.other}` < `${b.kind}${b.node}${b.other}` ? -1 : 1
  ),
  nodes: [...doc.graph_data.nodes]
    .map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)),
  edges: [...doc.graph_data.edges]
    .map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null }))
    .sort((a, b) =>
      `${a.source}${a.target}${a.sourceHandle}` < `${b.source}${b.target}${b.sourceHandle}` ? -1 : 1
    ),
})

describe('round trip', () => {
  it('survives values a naive format would lose', () => {
    const doc = {
      name: 'Quotes "and" braces {}',
      description: 'line one\nline two',
      guarantees: [],
      graph_data: {
        nodes: [
          {
            id: 'n',
            type: 'transform',
            position: { x: 0, y: 0 },
            data: {
              label: 'A "label"',
              config: {
                template: '{"total": {{cart.sum}}}',
                pattern: '^\\d+$',
                unicode: 'üñïçodé — ✓',
                empty: '',
              },
            },
          },
        ],
        edges: [],
      },
    }
    expect(semantics(parse(formatWorkflow(doc)))).toEqual(semantics(doc))
  })

  it('is the identity on semantics for every generated document', () => {
    const random = rng(20260822)
    for (let trial = 0; trial < 300; trial++) {
      const doc = randomDocument(random)
      const text = formatWorkflow(doc)
      const back = parse(text)
      expect(semantics(back)).toEqual(semantics(doc))
      // And it is a fixed point: formatting the parse produces the same bytes,
      // so a file cannot churn on every round trip.
      expect(formatWorkflow(back)).toBe(text)
    }
  })
})

describe('the signature is invariant under formatting', () => {
  it('signs a re-formatted document identically', () => {
    // The emit order *is* the signing canonical order, so a reviewer can
    // reformat a file they were sent and verification still passes.
    const random = rng(4242)
    for (let trial = 0; trial < 50; trial++) {
      const doc = randomDocument(random)
      const back = parse(formatWorkflow(doc))
      expect(canonicalPayload(back)).toBe(canonicalPayload(doc))
    }
  })

  it('changes the signature when the graph actually changes', () => {
    const doc = randomDocument(rng(7))
    const back = parse(formatWorkflow(doc))
    back.graph_data.nodes[0].data.config.newKey = 'changed'
    expect(canonicalPayload(back)).not.toBe(canonicalPayload(doc))
  })
})

describe('error positions point at the mistake', () => {
  it('blames the key line, not the last line of its value', () => {
    // The position is the product. Reporting the closing brace of a multi-line
    // value would send the reader three lines past the typo.
    try {
      parse('workflow "W"\n  bogus: {\n    "a": 1\n  }\n')
      throw new Error('expected a DslError')
    } catch (err) {
      expect(err.line).toBe(2)
      expect(err.message).toMatch(/Unknown property "bogus"/)
    }
  })
})
