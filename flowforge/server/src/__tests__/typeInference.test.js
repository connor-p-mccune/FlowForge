// Schema inference across a workflow graph.
//
// The output table is a transcription of what the runners in
// services/nodeRunners/ actually return, so the tests that pin those shapes are
// pinning a contract: if a runner grows a field and the table doesn't, the
// checker starts reporting a real reference as a typo. The rest of the file is
// about propagation — how a shape travels an edge, what a branch does to
// certainty, and where the analysis is required to give up.

const T = require('../services/types')
const { inferGraphTypes, describeGraphTypes } = require('../services/typeInference')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

const outputOf = (graph, id) => T.describe(inferGraphTypes(graph).outputs[id])
const inputOf = (graph, id) => T.describe(inferGraphTypes(graph).inputs[id])
const findings = (graph) => inferGraphTypes(graph).diagnostics
const codes = (graph) => findings(graph).map((d) => d.code)
const messages = (graph) => findings(graph).map((d) => d.message).join('\n')

describe('node output shapes match their runners', () => {
  const only = (type, config = {}) => outputOf({ nodes: [node('n', type, config)], edges: [] }, 'n')

  it('a trigger passes its payload through, so its shape is open', () => {
    expect(only('trigger-webhook')).toBe('{ triggered: boolean, … }')
  })

  it('an HTTP node yields status and a dynamic body, plus the dry-run preview', () => {
    expect(only('action-http')).toBe(
      '{ status: number, body: any, dryRun?: boolean, wouldHaveSent?: object }'
    )
  })

  it('a filter reports items, count, and the pre-filter total', () => {
    expect(only('filter')).toBe('{ items: unknown[], count: number, total: number }')
  })

  it('an aggregate has no stats block until a value expression is supplied', () => {
    expect(only('aggregate')).toBe('{ count: number }')
    expect(only('aggregate', { value: 'amount' })).toBe(
      '{ count: number, sum: number, avg: number, min: number | null, max: number | null }'
    )
  })

  it('a grouped aggregate returns groups instead of top-level stats', () => {
    expect(only('aggregate', { groupBy: 'status' })).toBe(
      '{ count: number, groups: { key: unknown, count: number }[] }'
    )
  })

  it('the branching nodes each settle their routing result', () => {
    expect(only('condition')).toBe('{ result: boolean }')
    expect(only('switch')).toBe(
      '{ result: string, matched: boolean, matchedLabel: string, matchedIndex: number }'
    )
    expect(only('validate')).toBe(
      '{ result: string, valid: boolean, errors: { path: string, message: string }[], data: any }'
    )
  })

  it('the AI nodes yield exactly the field their runner constructs', () => {
    expect(only('ai-prompt')).toBe('{ text: string }')
    expect(only('ai-classify')).toBe('{ label: string }')
    expect(only('ai-extract')).toBe('{ data: any }')
  })

  it('for-each reports its tallies, with errors only when there were some', () => {
    expect(only('for-each')).toBe(
      '{ count: number, succeeded: number, failed: number, results: unknown[], errors?: { index: number, error: string }[] }'
    )
  })

  it('a sub-workflow is unknown — inferring another graph is not a guess worth making', () => {
    expect(only('sub-workflow')).toBe('unknown')
  })

  it('a node type with no rule is unknown rather than assumed', () => {
    expect(only('some-future-node')).toBe('unknown')
  })
})

describe('a Transform template is the one place a user writes a schema down', () => {
  const transformOut = (template, upstream = []) =>
    outputOf(
      {
        nodes: [node('h', 'action-http'), node('x', 'transform', { template }), ...upstream],
        edges: [edge('h', 'x')],
      },
      'x'
    )

  it('reads the shape straight off a JSON template', () => {
    expect(transformOut('{"id": 1, "name": "x", "ok": true}')).toBe(
      '{ id: number, name: string, ok: boolean }'
    )
  })

  it('keeps the referenced type when a value is exactly one placeholder', () => {
    // The engine's resolveTemplates preserves the value's type in that case…
    expect(transformOut('{"code": "{{h.status}}"}')).toBe('{ code: number }')
  })

  it('yields a string when a value only interpolates', () => {
    // …and stringifies when the placeholder is embedded in other text.
    expect(transformOut('{"code": "HTTP {{h.status}}"}')).toBe('{ code: string }')
  })

  it('passes the input through when the template is blank', () => {
    expect(transformOut('')).toBe(
      '{ status: number, body: any, dryRun?: boolean, wouldHaveSent?: object }'
    )
  })

  it('models the runner’s fallback for a template that is not JSON', () => {
    expect(transformOut('just some text')).toBe('{ value: string }')
  })
})

describe('propagation', () => {
  it('carries a shape down an edge into the next node’s input', () => {
    const graph = {
      nodes: [node('h', 'action-http'), node('l', 'output-log')],
      edges: [edge('h', 'l')],
    }
    expect(inputOf(graph, 'l')).toBe(
      '{ status: number, body: any, dryRun?: boolean, wouldHaveSent?: object }'
    )
  })

  it('merges two upstreams the way Object.assign does', () => {
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('a', 'ai-prompt'),
        node('b', 'ai-classify'),
        node('j', 'output-log'),
      ],
      edges: [edge('t', 'a'), edge('t', 'b'), edge('a', 'j'), edge('b', 'j')],
    }
    // Both branches are unconditional, so both fields are guaranteed.
    expect(inputOf(graph, 'j')).toBe('{ text: string, label: string }')
  })

  it('marks a branch’s contribution optional — the branch may not fire', () => {
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('c', 'condition'),
        node('a', 'ai-prompt'),
        node('b', 'ai-classify'),
        node('j', 'output-log'),
      ],
      edges: [
        edge('t', 'c'),
        edge('c', 'a', 'true'),
        edge('c', 'b', 'false'),
        edge('a', 'j'),
        edge('b', 'j'),
      ],
    }
    expect(inputOf(graph, 'j')).toBe('{ text?: string, label?: string }')
  })

  it('treats a lone incoming edge as certain even off a branch', () => {
    // If the node ran at all, that edge is how it got there.
    const graph = {
      nodes: [node('c', 'condition'), node('a', 'ai-prompt'), node('l', 'output-log')],
      edges: [edge('c', 'a', 'true'), edge('a', 'l')],
    }
    expect(inputOf(graph, 'l')).toBe('{ text: string }')
  })

  it('opens the input when an upstream is a node we could not type', () => {
    const graph = {
      nodes: [node('s', 'sub-workflow'), node('a', 'ai-prompt'), node('l', 'output-log')],
      edges: [edge('s', 'l'), edge('a', 'l')],
    }
    expect(inputOf(graph, 'l')).toBe('{ text: string, … }')
  })

  it('gives an unwired node an open input rather than an empty one', () => {
    const graph = { nodes: [node('l', 'output-log')], edges: [] }
    expect(inputOf(graph, 'l')).toBe('object')
  })

  it('infers a Filter’s element type from a referenced list, and Map’s from its expression', () => {
    const graph = {
      nodes: [
        node('t', 'transform', { template: '{"rows": [{"sku": "a", "qty": 2}]}' }),
        node('f', 'filter', { source: '{{t.rows}}', predicate: 'qty > 1' }),
        node('m', 'map', { source: '{{f.items}}', mapping: '{ id: sku, doubled: qty * 2 }' }),
      ],
      edges: [edge('t', 'f'), edge('f', 'm')],
    }
    expect(outputOf(graph, 'f')).toBe(
      '{ items: { sku: string, qty: number }[], count: number, total: number }'
    )
    expect(outputOf(graph, 'm')).toBe(
      '{ items: { id: string, doubled: number }[], count: number }'
    )
  })

  it('produces nothing at all for a cyclic graph', () => {
    const graph = {
      nodes: [node('a', 'ai-prompt'), node('b', 'ai-classify')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    expect(inferGraphTypes(graph)).toEqual({ order: [], inputs: {}, outputs: {}, diagnostics: [] })
  })

  it('ignores sticky notes, exactly as the engine does', () => {
    const graph = {
      nodes: [node('h', 'action-http'), node('n', 'note'), node('l', 'output-log')],
      edges: [edge('h', 'l')],
    }
    expect(Object.keys(inferGraphTypes(graph).outputs)).toEqual(['h', 'l'])
  })
})

describe('the on-error policy changes what flows downstream', () => {
  const base = (onError, handle) => ({
    nodes: [
      node('t', 'trigger-manual'),
      node('h', 'action-http', { onError }),
      node('l', 'output-log'),
    ],
    edges: [edge('t', 'h'), edge('h', 'l', handle)],
  })

  it('unions the error object into a catching node’s own output', () => {
    // The engine settles { failed, error } as the node's context value under
    // *either* catching policy, so `{{h.error.message}}` is a real reference on
    // both — the policies differ in which edges activate, not in what the node
    // holds.
    for (const policy of ['continue', 'branch']) {
      expect(outputOf(base(policy), 'h')).toMatch(/failed\?: boolean/)
      expect(outputOf(base(policy), 'h')).toMatch(/status\?: number/)
    }
  })

  it('lets a caught node’s own error be referenced without complaint', () => {
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('h', 'action-http', { onError: 'branch' }),
        node('l', 'output-log', { message: 'failed: {{h.error.message}}' }),
      ],
      edges: [edge('t', 'h'), edge('h', 'l', 'error')],
    }
    expect(codes(graph)).toEqual([])
  })

  it('sends only the error object down a "branch" node’s error handle', () => {
    expect(inputOf(base('branch', 'error'), 'l')).toBe(
      '{ failed: boolean, error: { message: string, nodeId: string, nodeType: string } }'
    )
  })

  it('leaves the normal handle carrying the normal shape, not the union', () => {
    // A normal edge stays dark on a caught failure, so what reaches the next
    // node down it can only be the node's own output.
    expect(inputOf(base('branch', null), 'l')).toBe(
      '{ status: number, body: any, dryRun?: boolean, wouldHaveSent?: object }'
    )
  })

  it('carries the union down a "continue" node’s normal edge — either can arrive', () => {
    expect(inputOf(base('continue', null), 'l')).toMatch(/failed\?: boolean/)
  })

  it('ignores a policy on a node whose failure can never be caught', () => {
    const graph = {
      nodes: [node('t', 'trigger-manual'), node('c', 'condition', { onError: 'continue' })],
      edges: [edge('t', 'c')],
    }
    expect(outputOf(graph, 'c')).toBe('{ result: boolean }')
  })
})

describe('reference checking', () => {
  const withRef = (message) => ({
    nodes: [
      node('t', 'trigger-manual'),
      node('h', 'action-http'),
      node('l', 'output-log', { message }),
    ],
    edges: [edge('t', 'h'), edge('h', 'l')],
  })

  it('accepts a field the upstream really produces', () => {
    expect(codes(withRef('got {{h.status}}'))).toEqual([])
  })

  it('reports a field that cannot exist, with a suggestion', () => {
    const graph = withRef('got {{h.stats}}')
    expect(codes(graph)).toEqual(['unknown-field'])
    expect(messages(graph)).toMatch(/h is \{ status: number.*and has no "stats"; did you mean "status"\?/)
  })

  it('says nothing about anything under a dynamic value', () => {
    // The response body is `any`, so nothing beneath it is checkable — and
    // pretending otherwise is exactly how a checker earns distrust.
    expect(codes(withRef('{{h.body.orders.0.total}}'))).toEqual([])
  })

  it('says nothing about a trigger payload, which nobody typed', () => {
    const graph = {
      nodes: [node('t', 'trigger-webhook'), node('l', 'output-log', { message: '{{t.anything}}' })],
      edges: [edge('t', 'l')],
    }
    expect(codes(graph)).toEqual([])
  })

  it('leaves secrets, variables, and callbacks to the linter’s own name checks', () => {
    const graph = {
      nodes: [node('t', 'trigger-manual'), node('h', 'action-http', {
        url: 'https://x/{{vars.BASE}}',
        headers: '{"a": "{{secrets.KEY}}"}',
      })],
      edges: [edge('t', 'h')],
    }
    expect(codes(graph)).toEqual([])
  })

  it('reports the deepest segment that failed, not the whole path', () => {
    const graph = {
      nodes: [
        node('t', 'transform', { template: '{"user": {"name": "x"}}' }),
        node('l', 'output-log', { message: '{{t.user.nme}}' }),
      ],
      edges: [edge('t', 'l')],
    }
    expect(messages(graph)).toMatch(/t\.user is \{ name: string \} and has no "nme"; did you mean "name"\?/)
  })

  it('reports a repeated bad reference once', () => {
    expect(codes(withRef('{{h.stats}} and {{h.stats}}'))).toEqual(['unknown-field'])
  })

  it('does not check a reference to a node that is not upstream — that is the linter’s job', () => {
    const graph = {
      nodes: [node('a', 'ai-prompt'), node('b', 'output-log', { message: '{{a.text}}' })],
      edges: [],
    }
    expect(codes(graph)).toEqual([])
  })
})

describe('expression checking uses what the graph proves is in scope', () => {
  it('checks a condition against the merged input', () => {
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('h', 'action-http'),
        node('c', 'condition', { operator: 'expression', expression: 'statuss == 200' }),
      ],
      edges: [edge('t', 'h'), edge('h', 'c')],
    }
    expect(codes(graph)).toEqual(['type-error'])
    expect(messages(graph)).toMatch(/the condition expression: "statuss" is not in scope here — did you mean "status"\?/)
  })

  it('accepts `input` as the alias the runner actually provides', () => {
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('h', 'action-http'),
        node('c', 'condition', { operator: 'expression', expression: 'input.status == 200' }),
      ],
      edges: [edge('t', 'h'), edge('h', 'c')],
    }
    expect(codes(graph)).toEqual([])
  })

  it('checks each switch case under its own label', () => {
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('f', 'filter', { source: '[1, 2]', predicate: 'item > 1' }),
        node('s', 'switch', {
          cases: [
            { label: 'empty', expression: 'count == 0' },
            { label: 'big', expression: 'items * 2' },
          ],
        }),
      ],
      edges: [edge('t', 'f'), edge('f', 's')],
    }
    expect(messages(graph)).toMatch(/case "big": "\*" needs numbers/)
  })

  it('checks a filter predicate against the element type it will really see', () => {
    const graph = {
      nodes: [
        node('t', 'transform', { template: '{"rows": [{"sku": "a", "qty": 2}]}' }),
        node('f', 'filter', { source: '{{t.rows}}', predicate: 'qy > 1' }),
      ],
      edges: [edge('t', 'f')],
    }
    expect(messages(graph)).toMatch(/the filter predicate: "qy" is not in scope here — did you mean "qty"\?/)
  })

  it('exposes item, index, and items to a per-item expression', () => {
    const graph = {
      nodes: [
        node('t', 'transform', { template: '{"rows": [{"qty": 2}]}' }),
        node('f', 'filter', { source: '{{t.rows}}', predicate: 'index < 5 && item.qty > 0 && len(items) > 1' }),
      ],
      edges: [edge('t', 'f')],
    }
    expect(codes(graph)).toEqual([])
  })

  it('stays silent when the element type could not be inferred', () => {
    const graph = {
      nodes: [
        node('h', 'action-http'),
        node('f', 'filter', { source: '{{h.body}}', predicate: 'whatever > 1' }),
      ],
      edges: [edge('h', 'f')],
    }
    expect(codes(graph)).toEqual([])
  })

  it('leaves a syntax error to the linter rather than reporting it twice', () => {
    const graph = {
      nodes: [
        node('t', 'trigger-manual'),
        node('c', 'condition', { operator: 'expression', expression: 'a >' }),
      ],
      edges: [edge('t', 'c')],
    }
    expect(codes(graph)).toEqual([])
  })

  it('reports a map expression once, not once per consumer of its type', () => {
    const graph = {
      nodes: [
        node('t', 'transform', { template: '{"rows": [{"qty": 2}]}' }),
        node('m', 'map', { source: '{{t.rows}}', mapping: 'qty * missing' }),
      ],
      edges: [edge('t', 'm')],
    }
    expect(codes(graph)).toEqual(['type-error'])
  })
})

describe('describeGraphTypes', () => {
  const graph = {
    nodes: [node('t', 'trigger-manual'), node('h', 'action-http'), node('l', 'output-log')],
    edges: [edge('t', 'h'), edge('h', 'l')],
  }

  it('renders every node’s input and output for the API and the data picker', () => {
    const described = describeGraphTypes(graph)
    expect(described.order).toEqual(['t', 'h', 'l'])
    expect(described.nodes.h.output.described).toMatch(/^\{ status: number/)
    expect(described.nodes.h.output.type.kind).toBe('object')
  })

  it('flattens pickable paths one level past each object', () => {
    const described = describeGraphTypes(graph)
    const paths = described.nodes.h.output.fields.map((f) => f.path)
    expect(paths).toContain('status')
    expect(paths).toContain('wouldHaveSent')
    const status = described.nodes.h.output.fields.find((f) => f.path === 'status')
    expect(status).toEqual({ path: 'status', type: 'number', optional: false })
  })
})
