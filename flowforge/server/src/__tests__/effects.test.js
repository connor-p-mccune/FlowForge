// Effect reachability: what a run can do to the outside world, and what has to
// be true first.
//
// The rule under test is control dependence, stated as a conjunction:
//
//   N requires outcome `o` of decision D  ⟺  D dominates N, and N is reachable
//   from exactly one of D's outcome groups.
//
// Both halves have their own section below, because dropping either one is how
// a report like this ends up claiming a precondition that is not real — which
// is worse than reporting nothing, since a reviewer acts on it.

const { analyzeEffects, hostOf } = require('../services/effects')

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

const effectFor = (report, nodeId) => report.effects.find((e) => e.nodeId === nodeId)
const conditionsOf = (report, nodeId) =>
  effectFor(report, nodeId).conditions.map((c) => `${c.nodeId}=${c.outcome}`)

// The motivating graph: an order pipeline with a fraud check and an approval
// gate in front of a charge.
const ORDER_PIPELINE = {
  nodes: [
    node('hook', 'trigger-webhook'),
    node('score', 'ai-classify', { model: 'gpt-4o-mini' }, 'Fraud score'),
    node('risky', 'condition', { left: '{{score.label}}', operator: 'equals', right: 'high' }, 'High risk?'),
    node('approve', 'approval', {}, 'Approve'),
    node('charge', 'action-http', { url: 'https://api.acme.com/v1/charges/{{hook.id}}' }, 'Charge card'),
    node('receipt', 'action-email', { to: 'ops@acme.com' }, 'Send receipt'),
    node('reject', 'output-log', { message: 'rejected' }, 'Log rejection'),
  ],
  edges: [
    edge('hook', 'score'),
    edge('score', 'risky'),
    edge('risky', 'reject', 'true'),
    edge('risky', 'approve', 'false'),
    edge('approve', 'charge', 'true'),
    edge('approve', 'reject', 'false'),
    edge('charge', 'receipt'),
  ],
}

describe('what a workflow can do', () => {
  const report = analyzeEffects(ORDER_PIPELINE)

  it('lists only the nodes that reach outside FlowForge or cost money', () => {
    // A log node writes to stdout and a condition rearranges nothing. Listing
    // them would bury the ones a reviewer needs to see.
    expect(report.effects.map((e) => e.nodeId).sort()).toEqual(['charge', 'receipt', 'score'])
  })

  it('names what each one reaches', () => {
    expect(effectFor(report, 'charge')).toMatchObject({ kind: 'http', target: 'api.acme.com' })
    expect(effectFor(report, 'receipt')).toMatchObject({ kind: 'email', target: 'ops@acme.com' })
    expect(effectFor(report, 'score')).toMatchObject({ kind: 'model', target: 'gpt-4o-mini' })
  })

  it('reports the effects that happen on every run', () => {
    // The sentence a reviewer needs first: every run of this pays for a model
    // call, before any decision is taken.
    expect(effectFor(report, 'score').always).toBe(true)
    expect(report.summary.unconditional).toBe(1)
  })

  it('reports what has to be true for the charge', () => {
    expect(conditionsOf(report, 'charge')).toEqual(['risky=false', 'approve=true'])
    expect(effectFor(report, 'charge').always).toBe(false)
  })

  it('carries a condition through to what the charge leads to', () => {
    // The receipt is downstream of the charge, so it inherits both gates.
    expect(conditionsOf(report, 'receipt')).toEqual(['risky=false', 'approve=true'])
  })

  it('orders conditions from the outermost decision inwards', () => {
    // "not high risk, then approved" is how somebody reads the canvas; the
    // reverse would read as a list rather than a chain.
    expect(conditionsOf(report, 'charge')[0]).toBe('risky=false')
  })

  it('answers the inverse question: what a rejection rules out', () => {
    const approve = report.decisions.find((d) => d.nodeId === 'approve')
    const approved = approve.outcomes.find((o) => o.name === 'true')
    const rejected = approve.outcomes.find((o) => o.name === 'false')
    expect(approved.gates.sort()).toEqual(['charge', 'receipt'])
    // Nothing external happens down the rejected branch — the log node is not
    // an effect.
    expect(rejected.gates).toEqual([])
  })

  it('counts the effects whose destination the graph does not determine', () => {
    expect(report.summary).toMatchObject({ total: 3, unconditional: 1, gated: 2, dynamicTargets: 0 })
  })
})

// ---------------------------------------------------------------------------
// The two halves of the rule, each dropped in turn.
// ---------------------------------------------------------------------------

describe('a decision that gates nothing is not a condition', () => {
  it('ignores a decision both of whose outcomes reach the effect', () => {
    // `route` is on every path to `call` — it dominates it — but the effect
    // happens whichever way it goes. Reporting it would tell a reviewer to
    // check a branch that does not matter.
    const report = analyzeEffects({
      nodes: [
        node('t', 'trigger-manual'),
        node('route', 'condition', {}, 'Route'),
        node('a', 'transform', {}, 'A'),
        node('b', 'transform', {}, 'B'),
        node('call', 'action-http', { url: 'https://x.test/' }, 'Call'),
      ],
      edges: [
        edge('t', 'route'),
        edge('route', 'a', 'true'),
        edge('route', 'b', 'false'),
        edge('a', 'call'),
        edge('b', 'call'),
      ],
    })
    expect(conditionsOf(report, 'call')).toEqual([])
    expect(effectFor(report, 'call').always).toBe(true)
  })
})

describe('a decision that can be bypassed is not a condition', () => {
  it('drops the gate when a second trigger reaches the effect around it', () => {
    // This is the hole the guarantees feature exists for: somebody adds a
    // manual trigger to test the charge without posting a webhook and wires it
    // straight at the node they were testing. Every node still lints. The
    // approval is now optional — and this report must say so rather than
    // reassuring a reviewer that a gate they can see is a gate that holds.
    const gated = {
      nodes: [
        node('hook', 'trigger-webhook'),
        node('approve', 'approval', {}, 'Approve'),
        node('charge', 'action-http', { url: 'https://api.acme.com/' }, 'Charge card'),
      ],
      edges: [edge('hook', 'approve'), edge('approve', 'charge', 'true')],
    }
    expect(conditionsOf(analyzeEffects(gated), 'charge')).toEqual(['approve=true'])

    const bypassed = {
      nodes: [...gated.nodes, node('manual', 'trigger-manual', {}, 'Run by hand')],
      edges: [...gated.edges, edge('manual', 'charge')],
    }
    expect(conditionsOf(analyzeEffects(bypassed), 'charge')).toEqual([])
    expect(effectFor(analyzeEffects(bypassed), 'charge').always).toBe(true)
  })
})

describe('every kind of decision', () => {
  // One structural idea carries all of them, which is why this file knows what
  // none of these node types are.
  const gate = (decisionNode, handle) =>
    analyzeEffects({
      nodes: [
        node('t', 'trigger-manual'),
        decisionNode,
        node('call', 'action-http', { url: 'https://x.test/' }, 'Call'),
        node('other', 'output-log', {}, 'Other'),
      ],
      edges: [edge('t', 'd'), edge('d', 'call', handle), edge('d', 'other', null)],
    })

  it('a switch case', () => {
    const report = gate(
      node('d', 'switch', { cases: [{ label: 'refund' }, { label: 'ship' }] }, 'Route'),
      'refund'
    )
    expect(conditionsOf(report, 'call')).toEqual(['d=refund'])
  })

  it('a validate gate', () => {
    expect(conditionsOf(gate(node('d', 'validate', {}, 'Check'), 'valid'), 'call')).toEqual(['d=valid'])
  })

  it('a callback that can time out', () => {
    expect(conditionsOf(gate(node('d', 'wait-callback', {}, 'Wait'), 'received'), 'call'))
      .toEqual(['d=received'])
  })

  it('a per-node error branch, which is the same shape wearing different clothes', () => {
    const report = analyzeEffects({
      nodes: [
        node('t', 'trigger-manual'),
        node('fetch', 'action-http', { url: 'https://a.test/', onError: 'branch' }, 'Fetch'),
        node('fallback', 'action-http', { url: 'https://b.test/' }, 'Fallback'),
        node('normal', 'output-log', {}, 'Normal'),
      ],
      edges: [edge('t', 'fetch'), edge('fetch', 'fallback', 'error'), edge('fetch', 'normal', null)],
    })
    // The fallback only ever runs when the fetch failed — an effect gated on a
    // failure, which is exactly the sort a reviewer would otherwise miss.
    expect(conditionsOf(report, 'fallback')).toEqual(['fetch=error'])
  })
})

describe('hostOf', () => {
  it('reads a fixed authority even when the path is templated', () => {
    // The distinction lineage draws for SSRF: only a dynamic *authority* lets a
    // caller choose the destination. Calling this URL "dynamic" would send a
    // reviewer to investigate a pinned host.
    expect(hostOf('https://api.acme.com/orders/{{trigger.id}}')).toBe('api.acme.com')
    expect(hostOf('https://api.acme.com:8443/x')).toBe('api.acme.com:8443')
  })

  it('is null when the graph does not determine the destination', () => {
    expect(hostOf('{{trigger.url}}')).toBeNull()
    expect(hostOf('https://{{vars.HOST}}/orders')).toBeNull()
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf('')).toBeNull()
    expect(hostOf(undefined)).toBeNull()
  })
})

describe('a dynamic destination is reported as unknown, not guessed', () => {
  it('counts it and leaves the target null', () => {
    const report = analyzeEffects({
      nodes: [
        node('t', 'trigger-webhook'),
        node('call', 'action-http', { url: '{{t.callbackUrl}}' }, 'Call back'),
      ],
      edges: [edge('t', 'call')],
    })
    expect(effectFor(report, 'call').target).toBeNull()
    expect(report.summary.dynamicTargets).toBe(1)
  })
})

describe('graphs with nothing to say', () => {
  it('is unavailable for an empty graph', () => {
    expect(analyzeEffects({ nodes: [], edges: [] })).toEqual({ available: false, reason: 'empty' })
  })

  it('is unavailable for a cyclic graph, which never runs at all', () => {
    const cyclic = {
      nodes: [node('a', 'action-http', { url: 'https://x.test/' }), node('b', 'transform')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    expect(analyzeEffects(cyclic)).toEqual({ available: false, reason: 'cycle' })
  })

  it('reports no effects for a graph that only computes', () => {
    const report = analyzeEffects({
      nodes: [node('t', 'trigger-manual'), node('x', 'transform', {}, 'Shape it')],
      edges: [edge('t', 'x')],
    })
    expect(report.available).toBe(true)
    expect(report.effects).toEqual([])
    expect(report.summary.total).toBe(0)
  })

  it('ignores sticky notes and compensations, exactly as the engine does', () => {
    const report = analyzeEffects({
      nodes: [
        node('t', 'trigger-manual'),
        node('charge', 'action-http', { url: 'https://api.acme.com/' }, 'Charge'),
        node('note-1', 'note', {}, 'A note'),
        node('refund', 'action-http', { url: 'https://api.acme.com/refund', compensates: 'charge' }, 'Refund'),
      ],
      edges: [edge('t', 'charge')],
    })
    // The refund is real and reaches a real host, but it is not something a
    // *run* does — it only happens if the run ends badly, which is the rollback
    // report's subject rather than this one's.
    expect(report.effects.map((e) => e.nodeId)).toEqual(['charge'])
  })
})
