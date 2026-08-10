// Data lineage and taint analysis.
//
// The tests weight precision as heavily as detection, because the failure mode
// of a taint checker is not missing a finding — it is reporting so many that
// people stop reading them. So the cases that must stay *silent* get as much
// attention as the ones that must fire: a URL built from a workspace variable,
// a Transform over literals, an HTTP response that is not the request's taint,
// and a node mid-chain whose output is merged rather than referenced.

process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const {
  analyzeLineage,
  describeLineage,
  traceProvenance,
  traceImpact,
} = require('../services/lineage')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const http = (id, config = {}) =>
  node(id, 'action-http', { method: 'GET', url: 'https://api.example.com/x', headers: '{}', ...config })

const codes = (graph) => analyzeLineage(graph).findings.map((f) => f.code)
const originsOf = (graph, id) => [...analyzeLineage(graph).nodes[id].origins].sort()

describe('origins', () => {
  it('marks a webhook payload untrusted and a schedule internal', () => {
    const graph = {
      nodes: [node('hook', 'trigger-webhook'), node('cron', 'trigger-schedule')],
      edges: [],
    }
    expect(originsOf(graph, 'hook')).toEqual(['webhook'])
    expect(originsOf(graph, 'cron')).toEqual(['schedule'])
  })

  it('carries a trigger’s origin through a node that merges its input', () => {
    const graph = {
      nodes: [node('hook', 'trigger-webhook'), node('wait', 'action-delay', { ms: 100 })],
      edges: [edge('hook', 'wait')],
    }
    expect(originsOf(graph, 'wait')).toEqual(['webhook'])
  })

  it('stops taint at an HTTP node — its body is the far side’s answer', () => {
    // The URL is built from the webhook, so the *request* is tainted. The
    // response is not: propagating the request's taint into it would mark most
    // of a typical graph and make the finding worthless.
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        http('fetch', { url: 'https://api.example.com/{{hook.id}}' }),
      ],
      edges: [edge('hook', 'fetch')],
    }
    expect(originsOf(graph, 'fetch')).toEqual(['response'])
  })

  it('treats a Transform as its references and nothing else', () => {
    const literal = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('t', 'transform', { template: '{"kind":"fixed"}' }),
      ],
      edges: [edge('hook', 't')],
    }
    // Transform never merges its input, so a template over literals launders
    // nothing and carries no taint.
    expect(originsOf(literal, 't')).toEqual(['config'])

    const referencing = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('t', 'transform', { template: '{"who":"{{hook.email}}"}' }),
      ],
      edges: [edge('hook', 't')],
    }
    expect(originsOf(referencing, 't')).toEqual(['webhook'])
  })

  it('records secret and variable reads as internal origins', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        http('call', {
          url: '{{vars.BASE_URL}}/charge',
          headers: '{"Authorization":"Bearer {{secrets.STRIPE_KEY}}"}',
        }),
      ],
      edges: [edge('t1', 'call')],
    }
    const lineage = analyzeLineage(graph)
    expect(lineage.nodes.call.scopeReads).toEqual(
      expect.arrayContaining([
        { kind: 'variable', name: 'BASE_URL', where: 'url' },
        { kind: 'secret', name: 'STRIPE_KEY', where: 'headers' },
      ])
    )
    expect(lineage.secrets.STRIPE_KEY).toEqual([
      { nodeId: 'call', label: 'call', where: 'headers' },
    ])
  })

  it('reports a sub-workflow’s return as unknown rather than guessing', () => {
    const graph = {
      nodes: [node('hook', 'trigger-webhook'), node('sub', 'sub-workflow', { workflowId: 'w2' })],
      edges: [edge('hook', 'sub')],
    }
    expect(originsOf(graph, 'sub')).toEqual(['unknown'])
  })
})

describe('taint findings', () => {
  it('flags a request URL built from the webhook body', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Incoming hook'),
        http('fetch', { url: '{{hook.callbackUrl}}' }, 'Fetch'),
      ],
      edges: [edge('hook', 'fetch')],
    }
    const found = analyzeLineage(graph).findings.find((f) => f.code === 'tainted-sink')
    expect(found).toBeTruthy()
    expect(found.nodeId).toBe('fetch')
    expect(found.message).toMatch(/address this request is sent to/)
    expect(found.message).toMatch(/whoever holds the trigger URL/)
    expect(found.message).toMatch(/\{\{hook\.callbackUrl\}\}/)
  })

  it('does not flag a pinned host with a caller-supplied path segment', () => {
    // `https://api.acme.com/orders/{{trigger.id}}` is the normal, correct way
    // to build a request: the author pinned the destination and only a path
    // segment varies. Reporting it would train people to ignore the finding.
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        http('fetch', { url: 'https://api.acme.com/orders/{{hook.id}}' }),
      ],
      edges: [edge('hook', 'fetch')],
    }
    expect(codes(graph)).not.toContain('tainted-sink')
    // It is still recorded as a sink, at the lower band — the lineage knows,
    // it just isn't an alarm.
    const sink = analyzeLineage(graph).sinks.find((s) => s.kind === 'http-url')
    expect(sink.sensitivity).toBe('medium')
  })

  it('flags every shape of caller-chosen destination', () => {
    const cases = {
      whole: '{{hook.url}}',
      host: 'https://{{hook.host}}/v1/orders',
      scheme: '{{hook.scheme}}://api.acme.com/x',
      noScheme: '{{hook.base}}/orders',
    }
    for (const [name, url] of Object.entries(cases)) {
      const graph = {
        nodes: [node('hook', 'trigger-webhook'), http('fetch', { url })],
        edges: [edge('hook', 'fetch')],
      }
      expect(`${name}:${codes(graph).includes('tainted-sink')}`).toBe(`${name}:true`)
    }
  })

  it('follows the taint through an intermediate node', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('shape', 'transform', { template: '{"target":"{{hook.host}}"}' }),
        http('fetch', { url: 'https://{{shape.target}}/v1' }),
      ],
      edges: [edge('hook', 'shape'), edge('shape', 'fetch')],
    }
    expect(codes(graph)).toContain('tainted-sink')
  })

  it('stays silent when the URL comes from a workspace variable', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        http('fetch', { url: '{{vars.BASE_URL}}/orders' }),
      ],
      edges: [edge('hook', 'fetch')],
    }
    expect(codes(graph)).not.toContain('tainted-sink')
  })

  it('stays silent when a webhook field only reaches a low-sensitivity sink', () => {
    // Putting caller-controlled text in a Slack message is not request forgery.
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('say', 'action-slack', {
          webhookUrl: 'https://hooks.slack.com/services/T/B/X',
          text: 'New order from {{hook.customer}}',
        }),
      ],
      edges: [edge('hook', 'say')],
    }
    expect(codes(graph)).not.toContain('tainted-sink')
  })

  it('flags an email recipient and a sub-workflow target chosen by the caller', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('mail', 'action-email', { to: '{{hook.email}}', subject: 'Hi', body: 'x' }),
        node('sub', 'sub-workflow', { workflowId: '{{hook.which}}' }),
      ],
      edges: [edge('hook', 'mail'), edge('hook', 'sub')],
    }
    const found = analyzeLineage(graph).findings.filter((f) => f.code === 'tainted-sink')
    expect(found.map((f) => f.nodeId).sort()).toEqual(['mail', 'sub'])
  })

  it('flags a URL built from a third party’s response, and says so', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        http('lookup'),
        http('follow', { url: '{{lookup.body.next}}' }),
      ],
      edges: [edge('t1', 'lookup'), edge('lookup', 'follow')],
    }
    const found = analyzeLineage(graph).findings.find((f) => f.code === 'tainted-sink')
    expect(found.nodeId).toBe('follow')
    expect(found.message).toMatch(/the service that answered/)
  })

  it('analyses a compensation like any other node', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('charge', 'output-log', { message: 'charged' }),
        http('refund', { compensates: 'charge', url: '{{hook.refundUrl}}' }, 'Refund'),
      ],
      edges: [edge('hook', 'charge')],
    }
    const found = analyzeLineage(graph).findings.find((f) => f.code === 'tainted-sink')
    expect(found).toBeTruthy()
    expect(found.nodeId).toBe('refund')
  })
})

describe('dead computation', () => {
  it('flags a leaf whose output nothing reads', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('score', 'ai-prompt', { prompt: 'Rate this' }, 'Score it'),
      ],
      edges: [edge('t1', 'score')],
    }
    const found = analyzeLineage(graph).findings.find((f) => f.code === 'unread-output')
    expect(found.nodeId).toBe('score')
    expect(found.message).toMatch(/is a bill/)
  })

  it('does not flag a node whose output is referenced', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('score', 'ai-prompt', { prompt: 'Rate this' }),
        node('log', 'output-log', { message: '{{score.text}}' }),
      ],
      edges: [edge('t1', 'score'), edge('score', 'log')],
    }
    expect(codes(graph)).not.toContain('unread-output')
  })

  it('does not flag a node mid-chain — its output is merged downstream', () => {
    // Nothing references the aggregate by name, but the engine merges its
    // output into the next node's input, so calling it unused would be wrong
    // rather than merely noisy.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('roll', 'aggregate', { source: '{{t1.items}}', value: 'amount' }),
        node('log', 'output-log', { message: 'done' }),
      ],
      edges: [edge('t1', 'roll'), edge('roll', 'log')],
    }
    expect(codes(graph)).not.toContain('unread-output')
  })

  it('never flags a side-effecting node — the call is the point', () => {
    const graph = {
      nodes: [node('t1', 'trigger-manual'), http('ping')],
      edges: [edge('t1', 'ping')],
    }
    expect(codes(graph)).not.toContain('unread-output')
  })
})

describe('provenance and impact', () => {
  const graph = {
    nodes: [
      node('hook', 'trigger-webhook', {}, 'Order webhook'),
      node('shape', 'transform', { template: '{"id":"{{hook.orderId}}"}' }, 'Normalise'),
      http('charge', { url: 'https://pay/{{shape.id}}' }, 'Charge'),
      node('mail', 'action-email', { to: 'ops@x.com', subject: 'ok', body: '{{charge.body.receipt}}' }, 'Receipt'),
    ],
    edges: [edge('hook', 'shape'), edge('shape', 'charge'), edge('charge', 'mail')],
  }

  it('traces a value back to where it entered the system', () => {
    const trace = traceProvenance(analyzeLineage(graph), 'charge')
    // What it *reads* came from the webhook; what it *emits* is the payment
    // API's answer. Both are reported, because the difference is the point.
    expect(trace.origins.map((o) => o.kind)).toContain('webhook')
    expect(trace.outputOrigins.map((o) => o.kind)).toEqual(['response'])
    expect(trace.chain.map((c) => `${c.from}→${c.to}`)).toEqual(['shape→charge', 'hook→shape'])
    expect(trace.chain[0].reference).toBe('shape.id')
  })

  it('traces forward to what breaks if a node changes', () => {
    const impact = traceImpact(analyzeLineage(graph), 'hook')
    // Impact crosses the HTTP boundary that taint stops at, and correctly so:
    // changing the webhook changes which URL is called, so the response — and
    // the email built from it — really are downstream of the change.
    expect(impact.affected.map((a) => a.nodeId)).toEqual(['shape', 'charge', 'mail'])
    expect(impact.affected.map((a) => a.distance)).toEqual([1, 2, 3])
    // The sinks downstream are the part that matters: changing the webhook
    // changes what leaves the system.
    expect(impact.sinks.map((s) => s.nodeId)).toContain('charge')
  })

  it('reports the references that make each edge, not just the edge', () => {
    const impact = traceImpact(analyzeLineage(graph), 'charge')
    expect(impact.affected[0]).toMatchObject({ nodeId: 'mail', distance: 1 })
    expect(impact.affected[0].references).toEqual([
      { reference: 'charge.body.receipt', where: 'body' },
    ])
  })
})

describe('describeLineage', () => {
  it('produces a wire shape with expanded origins and both directions', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        node('log', 'output-log', { message: '{{hook.x}}' }, 'Log'),
      ],
      edges: [edge('hook', 'log')],
    }
    const described = describeLineage(graph)
    expect(described.ok).toBe(true)
    const hook = described.nodes.find((n) => n.nodeId === 'hook')
    expect(hook.origins).toEqual([
      { kind: 'webhook', trust: 'untrusted', label: 'the webhook payload' },
    ])
    expect(hook.readBy).toEqual(['log'])
    const log = described.nodes.find((n) => n.nodeId === 'log')
    expect(log.reads).toEqual([{ nodeId: 'hook', reference: 'hook.x', where: 'message' }])
  })

  it('reports a cycle rather than inventing an order', () => {
    const graph = {
      nodes: [node('a', 'output-log', { message: 'a' }), node('b', 'output-log', { message: 'b' })],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    expect(describeLineage(graph)).toMatchObject({ ok: false, reason: 'cycle' })
  })
})
