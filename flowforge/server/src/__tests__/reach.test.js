// What a run can ultimately do, across the sub-workflow boundary.
//
// The test that carries the design is the composition one: an effect inside a
// callee is gated by the callee's decisions *and* by the caller's decision to
// call it at all. Keeping only one half is wrong in a different direction each
// way, and both are easy mistakes to make.

const { reachableEffects } = require('../services/reach')

const node = (id, type, config = {}, label = id) => ({
  id, type, position: { x: 0, y: 0 }, data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`, source, target, sourceHandle,
})

const wf = (id, name, nodes, edges) => ({ id, name, graph: { nodes, edges } })

// Orders → (approved) calls Fulfilment → (in stock) charges a card
const FULFILMENT = wf(
  'fulfil',
  'Fulfilment',
  [
    node('t', 'trigger-manual'),
    node('stock', 'condition', { operator: 'expression', expression: 'inStock' }, 'In stock?'),
    node('charge', 'action-http', { url: 'https://api.acme.com/charges' }, 'Charge card'),
    node('back', 'output-log', { message: 'backorder' }, 'Backorder'),
  ],
  [edge('t', 'stock'), edge('stock', 'charge', 'true'), edge('stock', 'back', 'false')]
)

const ORDERS = wf(
  'orders',
  'Orders',
  [
    node('hook', 'trigger-webhook'),
    node('approve', 'approval', {}, 'Approve order'),
    node('call', 'sub-workflow', { workflowId: 'fulfil' }, 'Fulfil order'),
    node('decline', 'output-log', { message: 'no' }, 'Decline'),
  ],
  [
    edge('hook', 'approve'),
    edge('approve', 'call', 'true'),
    edge('approve', 'decline', 'false'),
  ]
)

const resolverFor = (...workflows) => {
  const byId = new Map(workflows.map((w) => [w.id, w]))
  return (id) => byId.get(id) ?? null
}

const chargeIn = (report) => report.effects.find((e) => e.label === 'Charge card')

describe('reachableEffects', () => {
  it('expands a sub-workflow call into what the callee actually does', () => {
    // The per-graph report says "calls workflow fulfil", which is true and
    // tells a reviewer nothing.
    const report = reachableEffects(ORDERS, resolverFor(FULFILMENT))
    expect(report.available).toBe(true)
    expect(chargeIn(report)).toBeTruthy()
    expect(chargeIn(report).target).toBe('api.acme.com')
  })

  it('says which workflow each effect actually lives in', () => {
    const charge = chargeIn(reachableEffects(ORDERS, resolverFor(FULFILMENT)))
    expect(charge.workflowName).toBe('Fulfilment')
  })

  it('records the call chain that reaches it', () => {
    const charge = chargeIn(reachableEffects(ORDERS, resolverFor(FULFILMENT)))
    expect(charge.via.map((v) => v.name)).toEqual(['Fulfilment'])
    expect(charge.via[0].label).toBe('Fulfil order')
  })

  // — the composition, which is the whole point ————————————————————

  it('conjoins the caller\'s gate with the callee\'s', () => {
    // Keeping only the callee's conditions claims the charge happens whenever
    // the callee decides it should, ignoring that the caller may never invoke
    // it. Keeping only the caller's claims it happens on every call.
    const charge = chargeIn(reachableEffects(ORDERS, resolverFor(FULFILMENT)))
    expect(charge.conditions.map((c) => `${c.label}=${c.outcome}`)).toEqual([
      'Approve order=true',
      'In stock?=true',
    ])
  })

  it('attributes each condition to the workflow it came from', () => {
    const charge = chargeIn(reachableEffects(ORDERS, resolverFor(FULFILMENT)))
    expect(charge.conditions[0].workflowName).toBe('Orders')
    expect(charge.conditions[1].workflowName).toBe('Fulfilment')
  })

  it('reads the conditions in call order, outermost first', () => {
    const charge = chargeIn(reachableEffects(ORDERS, resolverFor(FULFILMENT)))
    expect(charge.conditions[0].label).toBe('Approve order')
  })

  it('does not mark an inherited effect unconditional just because the callee is', () => {
    // Inside Fulfilment on its own, an unconditional effect is unconditional.
    // Reached through a gate, it is not — and reporting it as `always` would be
    // exactly the claim a review must not be given.
    const ungated = wf(
      'fulfil',
      'Fulfilment',
      [node('t', 'trigger-manual'), node('charge', 'action-http', { url: 'https://api.acme.com' }, 'Charge card')],
      [edge('t', 'charge')]
    )
    const charge = chargeIn(reachableEffects(ORDERS, resolverFor(ungated)))
    expect(charge.always).toBe(false)
    expect(charge.conditions).toHaveLength(1)
  })

  // — what stops the walk ————————————————————————————————————————

  it('keeps the unexpanded call when the callee cannot be read', () => {
    // "Calls something I cannot see" is more useful to a reviewer than silence.
    const report = reachableEffects(ORDERS, () => null)
    expect(report.effects.some((e) => e.kind === 'sub-workflow')).toBe(true)
    expect(report.unresolved[0]).toMatchObject({ workflowId: 'fulfil', reason: 'not-visible' })
  })

  it('stops at a cycle and says so rather than not terminating', () => {
    const a = wf(
      'a', 'A',
      [node('t', 'trigger-manual'), node('call', 'sub-workflow', { workflowId: 'b' }, 'Call B')],
      [edge('t', 'call')]
    )
    const b = wf(
      'b', 'B',
      [node('t', 'trigger-manual'), node('call', 'sub-workflow', { workflowId: 'a' }, 'Call A')],
      [edge('t', 'call')]
    )
    const report = reachableEffects(a, resolverFor(a, b))
    expect(report.available).toBe(true)
    expect(report.unresolved.some((u) => u.reason === 'cycle')).toBe(true)
    expect(report.effects.some((e) => e.recursive)).toBe(true)
  })

  it('stops at the depth bound and says so rather than reporting a prefix', () => {
    // Six workflows in a chain against a bound of four.
    const chain = []
    for (let i = 0; i < 6; i += 1) {
      chain.push(
        wf(
          `w${i}`, `W${i}`,
          [
            node('t', 'trigger-manual'),
            i < 5
              ? node('call', 'sub-workflow', { workflowId: `w${i + 1}` }, `Call W${i + 1}`)
              : node('send', 'action-http', { url: 'https://deep.example.com' }, 'Deep call'),
          ],
          [edge('t', i < 5 ? 'call' : 'send')]
        )
      )
    }
    const report = reachableEffects(chain[0], resolverFor(...chain))
    expect(report.unresolved.some((u) => u.reason === 'depth')).toBe(true)
    expect(report.effects.some((e) => e.truncated)).toBe(true)
  })

  it('follows a for-each the same way it follows a sub-workflow', () => {
    const fanOut = wf(
      'orders', 'Orders',
      [
        node('hook', 'trigger-webhook'),
        node('each', 'for-each', { workflowId: 'fulfil' }, 'For each line'),
      ],
      [edge('hook', 'each')]
    )
    expect(chargeIn(reachableEffects(fanOut, resolverFor(FULFILMENT)))).toBeTruthy()
  })

  // — the report as a whole ——————————————————————————————————————

  it('separates what this graph does from what it inherits', () => {
    const withOwn = wf(
      'orders', 'Orders',
      [
        node('hook', 'trigger-webhook'),
        node('notify', 'action-slack', { webhookUrl: 'https://hooks.slack.com/x' }, 'Notify'),
        node('call', 'sub-workflow', { workflowId: 'fulfil' }, 'Fulfil order'),
      ],
      [edge('hook', 'notify'), edge('notify', 'call')]
    )
    const { summary } = reachableEffects(withOwn, resolverFor(FULFILMENT))
    expect(summary.direct).toBeGreaterThan(0)
    expect(summary.inherited).toBeGreaterThan(0)
    expect(summary.direct + summary.inherited).toBe(summary.total)
  })

  it('counts how many workflows a run of this one can reach into', () => {
    const { summary } = reachableEffects(ORDERS, resolverFor(FULFILMENT))
    expect(summary.workflows).toBe(1)
    expect(summary.deepest).toBe(1)
  })

  it('puts the ungated effects first, deepest chain first among them', () => {
    // An effect four calls away that nothing gates is the one a reviewer has
    // least chance of having noticed on their own.
    const ungated = wf(
      'fulfil', 'Fulfilment',
      [node('t', 'trigger-manual'), node('charge', 'action-http', { url: 'https://api.acme.com' }, 'Charge card')],
      [edge('t', 'charge')]
    )
    const open = wf(
      'orders', 'Orders',
      [
        node('hook', 'trigger-webhook'),
        node('call', 'sub-workflow', { workflowId: 'fulfil' }, 'Fulfil'),
        node('notify', 'action-slack', { webhookUrl: 'https://hooks.slack.com/x' }, 'Notify'),
      ],
      [edge('hook', 'call'), edge('call', 'notify')]
    )
    const report = reachableEffects(open, resolverFor(ungated))
    expect(report.effects[0].always).toBe(true)
    expect(report.effects[0].via.length).toBeGreaterThan(0)
  })

  it('refuses a workflow with no graph', () => {
    expect(reachableEffects({ id: 'x' }, () => null)).toEqual({ available: false, reason: 'empty' })
  })

  it('reports a cyclic root rather than describing a run that never happens', () => {
    const cyclic = wf(
      'x', 'X',
      [node('a', 'transform'), node('b', 'transform')],
      [edge('a', 'b'), edge('b', 'a')]
    )
    const report = reachableEffects(cyclic, () => null)
    expect(report.effects).toEqual([])
    expect(report.unresolved[0].reason).toBe('cycle')
  })
})
